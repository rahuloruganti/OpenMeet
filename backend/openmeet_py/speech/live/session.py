"""One recording's live transcript: the writer hands blocks over, one worker decodes them.

The recorder's writer calls accept() after each successful write. It only copies the bytes and puts
them on a bounded queue; a full queue drops the block and sets `incomplete`, so a slow decoder can
never stall capture. A worker thread per recording owns the decoders and turns them into LiveLine
dicts on the session clock: each block carries the capture start time, so an utterance's start and
end land where the final transcript would put them, and paused time is not invented.

A decoder failure sets state "failed" with one sentence and never propagates into the recorder.
Transcript text is never logged.
"""

from __future__ import annotations

import bisect
import logging
import queue
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

from openmeet_py.api.errors import AppError
from openmeet_py.speech.live.contract import TARGET_RATE, LaneDecoder, Resolved, Update, speaker
from openmeet_py.speech.live.resample import LaneConverter

log = logging.getLogger("openmeet_py")

QUEUE_SECONDS = 8.0  # audio held per lane before blocks are dropped
QUEUE_ITEMS = 4096
PARTIAL_GAP_SECONDS = 0.2  # at most five partials a second per lane; finals are never throttled
IDLE_SECONDS = 0.05
SPEECH_FAILED = "Live transcript stopped because the speech engine failed."


@dataclass(frozen=True)
class _Block:
    index: int
    data: bytes
    frames: int
    start_us: int
    generation: int


class LiveSession:
    """One recording. Thread-safe accept() called by the recorder writer; never blocks."""

    def __init__(
        self,
        meeting_id: str,
        lanes: list[tuple[str, int, int]],
        resolved: Resolved,
        on_line: Callable[[dict], None],
        on_state: Callable[[dict], None],
        clock: Optional[Callable[[], float]] = None,
        queue_seconds: float = QUEUE_SECONDS,
    ):
        self.meeting_id = meeting_id
        self.incomplete = False
        self._lanes = [(str(kind), max(1, int(rate)), max(1, int(channels))) for kind, rate, channels in lanes]
        self._resolved = resolved
        self._on_line = on_line
        self._on_state = on_state
        self._clock = clock or _monotonic
        self._queue: "queue.Queue[_Block]" = queue.Queue(QUEUE_ITEMS)
        self._budget = [int(rate * channels * 4 * max(0.5, float(queue_seconds))) for _, rate, channels in self._lanes]
        self._queued = [0 for _ in self._lanes]
        self._lock = threading.Lock()
        self._stopping = threading.Event()
        self._cancelled = threading.Event()
        self._flush = threading.Event()
        self._started = False
        self._failed = False
        self._thread: Optional[threading.Thread] = None
        # Worker-owned state.
        self._converters: list[Optional[LaneConverter]] = [None for _ in self._lanes]
        self._generation: list[Optional[int]] = [None for _ in self._lanes]
        self._emitted = [0 for _ in self._lanes]
        self._marks: list[list[tuple[int, int]]] = [[] for _ in self._lanes]
        self._mark_at: list[list[int]] = [[] for _ in self._lanes]
        self._last_partial = [float("-inf") for _ in self._lanes]
        self._pending: list[Optional[Update]] = [None for _ in self._lanes]

    # ---- writer side -------------------------------------------------------------------------

    def accept(self, index: int, data: bytes, frames: int, start_us: int, generation: int) -> None:
        """Copies one block onto the queue. Never blocks, never raises into the recorder."""
        try:
            if not 0 <= int(index) < len(self._lanes) or int(frames) <= 0 or not data:
                return
            payload = bytes(data)
            need = len(payload)
            with self._lock:
                if self._queued[index] + need > self._budget[index]:
                    self.incomplete = True
                    return
                self._queued[index] += need
            block = _Block(int(index), payload, int(frames), int(start_us), int(generation))
            try:
                self._queue.put_nowait(block)
            except queue.Full:
                with self._lock:
                    self._queued[index] -= need
                self.incomplete = True
        except Exception:  # the audio writer must never see a live transcript error
            self.incomplete = True

    def flush_all(self) -> None:
        """The recorder is about to close its files: finish open utterances once the queue drains."""
        self._flush.set()

    # ---- control -----------------------------------------------------------------------------

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._state("starting")
        self._thread = threading.Thread(target=self._run, name=f"live-{self.meeting_id}", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 10.0) -> None:
        """Drain the queue, finish every lane and emit its finals, then join the worker."""
        self._stopping.set()
        thread = self._thread
        if thread is None:
            self._state("stopped")
            return
        thread.join(max(0.0, float(timeout)))

    def cancel(self) -> None:
        """Stop without draining and without finals, for an app quit."""
        self._cancelled.set()
        self._stopping.set()
        thread = self._thread
        if thread is not None:
            thread.join(2.0)

    # ---- worker ------------------------------------------------------------------------------

    def _run(self) -> None:
        decoders: list[LaneDecoder] = []
        try:
            decoders = [self._resolved.make_decoder() for _ in self._lanes]
            self._state("running")
            while True:
                block = self._next()
                if block is not None:
                    self._consume(block, decoders)
                    self._emit_due_partials()
                    continue
                if self._cancelled.is_set():
                    break
                if self._flush.is_set():
                    self._finish(decoders)
                    self._flush.clear()
                    continue
                if self._stopping.is_set() and self._queue.empty():
                    break
            if self._stopping.is_set() and not self._cancelled.is_set():
                self._drain(decoders)
                self._finish(decoders)
            if not self._cancelled.is_set():
                self._state("stopped")
        except AppError as error:
            self._fail(str(error.message))
        except Exception as error:  # the engine's own message can echo transcript text: log the type only
            log.error("live transcript decoder failed: %s", type(error).__name__)
            self._fail(SPEECH_FAILED)
        finally:
            if self._failed:
                self._close_quietly(decoders)

    def _next(self) -> Optional[_Block]:
        try:
            return self._queue.get(timeout=IDLE_SECONDS)
        except queue.Empty:
            return None

    def _drain(self, decoders: list[LaneDecoder]) -> None:
        while True:
            try:
                block = self._queue.get_nowait()
            except queue.Empty:
                return
            self._consume(block, decoders)

    def _consume(self, block: _Block, decoders: list[LaneDecoder]) -> None:
        lane = block.index
        if self._generation[lane] is None:
            self._generation[lane] = block.generation
            self._converters[lane] = LaneConverter(self._lanes[lane][1], self._lanes[lane][2])
        elif block.generation != self._generation[lane]:
            # A resume: the audio jumped. Close the open utterance at the pause, then carry on.
            self._generation[lane] = block.generation
            for update in decoders[lane].finish():
                self._publish(lane, update)
        converter = self._converters[lane]
        if converter is None:
            self._release(lane, len(block.data))
            return
        mono = converter.push(block.data, block.frames)
        self._mark_at[lane].append(self._emitted[lane])
        self._marks[lane].append((self._emitted[lane], block.start_us))
        updates = decoders[lane].feed(mono) if mono.size else []
        self._emitted[lane] += int(mono.size)
        for update in updates:
            self._publish(lane, update)
        self._release(lane, len(block.data))

    def _finish(self, decoders: list[LaneDecoder]) -> None:
        """Closes every lane's open utterance: remaining resampler tail, then the decoder's finals."""
        for lane, decoder in enumerate(decoders):
            converter = self._converters[lane]
            if converter is not None:
                tail = converter.finish()
                if tail.size:
                    updates = decoder.feed(tail)
                    self._emitted[lane] += int(tail.size)
                    for update in updates:
                        self._publish(lane, update)
            for update in decoder.finish():
                self._publish(lane, update)
            self._pending[lane] = None

    def _close_quietly(self, decoders: list[LaneDecoder]) -> None:
        for decoder in decoders:
            try:
                decoder.finish()
            except Exception:
                continue

    # ---- lines -------------------------------------------------------------------------------

    def _publish(self, lane: int, update: Update) -> None:
        text = (update.text or "").strip()
        if not text:
            return
        line = self._line(lane, update, text)
        if update.final:
            self._pending[lane] = None
            self._emit(line)
            return
        now = self._clock()
        if now - self._last_partial[lane] >= PARTIAL_GAP_SECONDS:
            self._last_partial[lane] = now
            self._emit(line)
        else:
            self._pending[lane] = update

    def _emit_due_partials(self) -> None:
        now = self._clock()
        for lane, update in enumerate(self._pending):
            if update is None or now - self._last_partial[lane] < PARTIAL_GAP_SECONDS:
                continue
            self._pending[lane] = None
            self._last_partial[lane] = now
            text = (update.text or "").strip()
            if text:
                self._emit(self._line(lane, update, text))

    def _line(self, lane: int, update: Update, text: str) -> dict[str, Any]:
        kind = self._lanes[lane][0]
        start = self._session_ms(lane, update.start)
        end = max(self._session_ms(lane, update.end), start)
        return {
            "id": f"{kind}:{int(update.utterance)}",
            "lane": kind,
            "speaker": speaker(kind),
            "start_ms": start,
            "end_ms": end,
            "text": text,
            "final": bool(update.final),
        }

    def _session_ms(self, lane: int, position: int) -> int:
        """Session milliseconds for a lane-local sample: the capture start of the block holding it."""
        at_list = self._mark_at[lane]
        if not at_list:
            return max(0, int(position)) * 1000 // TARGET_RATE
        at = max(bisect.bisect_right(at_list, max(0, int(position))) - 1, 0)
        index, start_us = self._marks[lane][at]
        within = max(0, int(position) - index) * 1_000_000 // TARGET_RATE
        return max(0, int(start_us) + within) // 1000

    def _release(self, lane: int, size: int) -> None:
        with self._lock:
            self._queued[lane] = max(0, self._queued[lane] - size)

    def _emit(self, line: dict[str, Any]) -> None:
        try:
            self._on_line(line)
        except Exception:  # a broken listener must not stop decoding
            log.error("live transcript listener failed")

    def _fail(self, notice: str) -> None:
        self._failed = True
        self._state("failed", notice)

    def _state(self, state: str, notice: Optional[str] = None) -> None:
        payload = {
            "state": state,
            "engine": self._resolved.label,
            "leaves_device": bool(self._resolved.leaves_device),
            "notice": notice,
        }
        try:
            self._on_state(payload)
        except Exception:
            log.error("live state listener failed")


def _monotonic() -> float:
    return time.monotonic()
