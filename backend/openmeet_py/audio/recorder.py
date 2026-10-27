"""Recording state machine: one session at a time, a writer thread per session, revision ordering.

Owns start, pause, resume, stop and poll_audio for one session at a time, and publishes
recording_state for the UI.

Threads per session:
- Backend callbacks only copy the block into a bounded queue (put_nowait). They never block, write
  files or take a lock. A block carries the generation it was captured in.
- One writer thread owns the files. It writes only blocks whose generation is still current, and
  it finalizes the files when it receives the stop marker.
- One meter thread polls stream errors and sleep gaps, pauses on a fault, and emits audio_health.

Lock order: Recorder.lock, then Store.lock. Callbacks and the writer never take either lock.
"""

from __future__ import annotations

import functools
import logging
import os
import queue
import sqlite3
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Callable, Optional, Protocol

from openmeet_py.api.context import now
from openmeet_py.api.errors import AppError
from openmeet_py.audio.audio_backend import BackendError, CaptureBackend, DeviceInfo
from openmeet_py.audio.audio_wav import WavFile, measure, timing_line
from openmeet_py.infra.store import Store, transaction

log = logging.getLogger("openmeet_py")

QUEUE_BLOCKS = 256
CONTROL_TIMEOUT = 5.0
STOP_TIMEOUT = 20.0
METER_INTERVAL = 0.2
SUSPEND_GAP = 2.0
KINDS = ("mic", "system")

MIC_MISSING = (
    "Selected microphone is unavailable. Enable microphone access or remote microphone "
    "redirection, then refresh devices."
)
MIC_MISSING_MAC = (
    "Selected microphone is unavailable. Allow microphone access in System Settings, Privacy and "
    "Security, Microphone, then refresh devices."
)
OUTPUT_MISSING = "Selected system-output device is unavailable. Refresh devices."
FORMAT_LIMITS = "This preview supports 1–8 channels at 8–192 kHz. Choose another device format."
FORMAT_CHANGED = "Device format changed. Stop and start a new recording."
CAPTURE_ERROR_CODE = "audio"  # the AppError code for capture errors; the reason of a fault or an errored stop
ORIGINS = frozenset({"manual", "auto", "lifecycle", "shutdown"})

# Fault bits. A nonzero fault pauses capture and stops writing.
STREAM_ERROR = 1
OVERFLOW = 2
IO_ERROR = 4
SUSPENDED = 8
WORKER_ERROR = 32


def _mic_missing() -> str:
    """The Windows text mentions remote microphone redirection, a Windows remote-desktop feature."""
    return MIC_MISSING_MAC if sys.platform == "darwin" else MIC_MISSING


def audio_error(message: str) -> AppError:
    return AppError(CAPTURE_ERROR_CODE, f"Audio capture: {message}")


def _checked_origin(origin: str) -> str:
    if origin not in ORIGINS:
        raise AppError("invalid_args", "Unknown recording origin.")
    return origin


class RecorderListener(Protocol):
    """Observer of recording state changes.

    Called after the database commit of each change, on the thread that made it, outside the recorder
    lock. Never called from the audio callback or the writer thread; a fault comes from the meter
    thread. kind is started, paused, resumed, stopped, stop_failed or fault. origin is the origin of the
    call that caused the event; a fault carries the origin the recording started with. reason is None,
    or a short code: audio_worker_busy or database for stop_failed, audio for fault and for a stop that
    ends with an error. Implementations must not block.
    """

    def recorder_event(self, kind: str, meeting_id: str | None, origin: str, reason: str | None) -> None: ...


def _notifies(method: Callable[..., Any]) -> Callable[..., Any]:
    """Delivers the events a Recorder method queued, once the method has released the recorder lock."""

    @functools.wraps(method)
    def wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
        try:
            return method(self, *args, **kwargs)
        finally:
            self._deliver()

    return wrapper


def validate_title(title: str) -> str:
    title = title.strip()
    if not title or len(title) > 160:
        raise AppError("invalid_title", "Use a meeting title between 1 and 160 characters.")
    return title


def fault_message(fault: int, details: list[str]) -> Optional[str]:
    """The user-facing text for a fault, most severe fault first."""
    if not fault:
        return None
    if fault & IO_ERROR:
        return (
            "Audio disk write/finalization failed or WAV size limit reached. Stop and check free "
            "space; partial files are retained."
        )
    if fault & OVERFLOW:
        return "Audio queue overflowed. Both tracks paused; stop and start a new recording."
    if fault & SUSPENDED:
        return (
            "Capture was interrupted by sleep or a scheduling gap. Stop and start a new recording."
        )
    if fault & WORKER_ERROR:
        return (
            "The audio capture worker stopped responding. Capture is disabled; partial files are "
            "retained for recovery."
        )
    if details:
        return (
            f"An audio device stopped responding ({details[0]}). Both tracks paused; stop, check "
            "permissions/devices, and start again."
        )
    return (
        "An audio device stopped responding. Both tracks paused; stop, check permissions/devices, "
        "and start again."
    )


@dataclass
class _Track:
    kind: str
    device: DeviceInfo
    path: Path
    timing_path: Path
    wav: WavFile
    timing: BinaryIO
    stream: Any = None
    frames: int = 0  # written by the writer thread only
    dropped: int = 0
    gaps: int = 0
    peak: float = 0.0
    last_callback_us: int = 0
    failed: bool = False
    finalized: bool = False
    stream_error_seen: bool = False
    # Stamps come from counted frames, not callback arrival times: each segment (one stream run)
    # is anchored once, then advances by its frames. Arrival jitter cannot make blocks overlap.
    segment_start_us: Optional[int] = None
    segment_frames: int = 0
    end_us: int = 0  # end of the last enqueued block; no segment may start before it


class _Checkpoint:
    def __init__(self) -> None:
        self.done = threading.Event()


_STOP = object()


class Session:
    """One recording's files, queue and writer. The Recorder decides when it starts and stops."""

    def __init__(self, meeting_id: str, folder: Path, tracks: list[_Track], live: Any = None):
        self.meeting_id = meeting_id
        self.folder = folder
        self.tracks = tracks
        self.live = live  # speech.live.LiveSession or None; fed by the writer after each successful write
        self.queue: "queue.Queue[Any]" = queue.Queue(QUEUE_BLOCKS)
        self.generation = 0
        self.accepting = False
        self.fault = 0  # written from several threads; any nonzero value pauses capture
        self.details: list[str] = []
        self.origin = "manual"  # who began this recording; Recorder.start sets it
        self.finished = threading.Event()
        self._started_ns = time.monotonic_ns()
        self._writer = threading.Thread(target=self._run_writer, name="openmeet-audio-writer", daemon=True)
        self._writer.start()

    def now_us(self) -> int:
        return (time.monotonic_ns() - self._started_ns) // 1000

    # Backend callback: runs on the device thread. Keep it to a copy, a peak and a put_nowait.
    def on_audio(self, index: int, data: bytes, frames: int, gap: bool) -> None:
        track = self.tracks[index]
        generation = self.generation
        if not self.accepting or generation != self.generation:
            return  # paused, stopping, or captured before a boundary
        arrival = self.now_us()
        track.last_callback_us = arrival
        if gap:
            track.gaps += 1
        rate = track.device.rate
        if track.segment_start_us is None:
            first_start = max(0, arrival - frames * 1_000_000 // rate, track.end_us)
            track.segment_start_us, track.segment_frames = first_start, 0
        start_us = track.segment_start_us + track.segment_frames * 1_000_000 // rate
        peak, cleaned = measure(data)
        block = (generation, index, frames, start_us, cleaned or data)
        try:
            self.queue.put_nowait(block)
        except queue.Full:
            track.dropped += frames
            track.gaps += 1
            self.fault |= OVERFLOW
            return
        track.peak = peak
        track.segment_frames += frames
        track.end_us = start_us + frames * 1_000_000 // rate

    def stream_error(self, index: int, message: str) -> None:
        track = self.tracks[index]
        if not track.stream_error_seen:
            track.stream_error_seen = True
            label = "microphone" if index == 0 else "system output"
            self.details.append(f"{label}: {message[:200]}")
        self.fault |= STREAM_ERROR

    def fault_text(self) -> Optional[str]:
        return fault_message(self.fault, self.details)

    def health(self, recording: bool) -> dict[str, Any]:
        now_us = self.now_us()
        return {
            "error": self.fault_text(),
            "tracks": [
                {
                    "kind": track.kind,
                    "frames": track.frames,
                    "dropped_frames": track.dropped,
                    "gaps": track.gaps,
                    "peak": track.peak if recording else 0.0,
                    "callback_age_ms": max(0, now_us - track.last_callback_us) // 1000,
                }
                for track in self.tracks
            ],
        }

    def halt_streams(self) -> None:
        """No callback can enqueue after this returns. Blocks already queued stay queued."""
        self.accepting = False
        self.generation += 1
        for track in self.tracks:
            if track.stream is not None:
                try:
                    track.stream.stop()
                except Exception:  # a device that fails to stop still has no more callbacks to route
                    log.warning("stopping an audio stream failed")
            track.segment_start_us = None  # the next stream run starts a new segment

    def checkpoint(self) -> bool:
        """Writes everything queued before this call, then flushes and fsyncs. False if the worker stalled."""
        marker = _Checkpoint()
        try:
            self.queue.put(marker, timeout=CONTROL_TIMEOUT)
        except queue.Full:
            self.fault |= WORKER_ERROR
            return False
        if not marker.done.wait(CONTROL_TIMEOUT):
            self.fault |= WORKER_ERROR
            return False
        return True

    def close_writer(self) -> bool:
        """Asks the writer to drain and finalize. True once it has finished."""
        if not self._writer.is_alive():
            return True
        try:
            self.queue.put(_STOP, timeout=CONTROL_TIMEOUT)
        except queue.Full:
            pass  # the writer is stalled; the join below decides
        self._writer.join(STOP_TIMEOUT)
        return not self._writer.is_alive()

    def discard(self) -> None:
        """Stops a session that never reached the database and removes its files."""
        self.halt_streams()
        self.close_writer()
        for track in self.tracks:
            for path in (track.path, track.timing_path):
                try:
                    path.unlink()
                except OSError:
                    pass
        try:
            self.folder.rmdir()
        except OSError:
            pass

    # Writer thread ---------------------------------------------------------

    def _run_writer(self) -> None:
        try:
            while True:
                try:
                    item = self.queue.get(timeout=1.0)
                except queue.Empty:
                    self._flush(sync=False)  # a crash loses at most about a second of index lines
                    continue
                if item is _STOP:
                    break
                if isinstance(item, _Checkpoint):
                    self._flush(sync=True)
                    item.done.set()
                    continue
                self._write(item)
        except Exception:  # never die silently: the meter pauses on the fault
            self.fault |= IO_ERROR
            log.exception("audio writer failed")
        finally:
            if self.live is not None:
                self.live.flush_all()  # the last block reaches the live session before the files close
            self._finalize()
            self.finished.set()

    def _write(self, block: tuple) -> None:
        generation, index, frames, start_us, data = block
        if generation != self.generation or self.fault:
            return  # captured before a pause, a resume boundary or a fault
        track = self.tracks[index]
        if track.failed:
            return
        try:
            track.wav.write(data)
            track.timing.write(timing_line(track.frames, frames, start_us, generation).encode("ascii"))
        except OSError:
            track.failed = True
            self.fault |= IO_ERROR
            return
        track.frames += frames
        if self.live is not None:
            self.live.accept(index, data, frames, start_us, generation)

    def _flush(self, sync: bool) -> None:
        for track in self.tracks:
            try:
                track.wav.checkpoint(sync=sync)
                track.timing.flush()
                if sync:
                    os.fsync(track.timing.fileno())
            except OSError:
                track.failed = True
                self.fault |= IO_ERROR

    def _finalize(self) -> None:
        for track in self.tracks:
            wav_ok = track.wav.finalize()
            timing_ok = True
            try:
                track.timing.flush()
                os.fsync(track.timing.fileno())
            except OSError:
                timing_ok = False
            try:
                track.timing.close()
            except OSError:
                timing_ok = False
            track.finalized = wav_ok and timing_ok and not track.failed
            if not track.finalized:
                self.fault |= IO_ERROR


class Recorder:
    def __init__(self, store: Store, backend: CaptureBackend, emit: Callable[[str, Any], None], audio_root: Path):
        self.store = store
        self.backend = backend
        self.emit = emit
        self.audio_root = audio_root
        self.lock = threading.RLock()
        self.revision = 0
        self.status = "idle"
        self.meeting_id: Optional[str] = None
        self.source: Optional[str] = None
        self.error: Optional[str] = None
        self.session: Optional[Session] = None
        # Set by server wiring: processing.Processing (prepare, attach, started, stopped).
        self.processing: Any = None
        # Set by server wiring: live_commands.LiveService. It decides whether a live transcript runs.
        self.live: Any = None
        # Why processing was skipped for the last start. Kept until the next start.
        self.processing_notice: Optional[str] = None
        # Observers. Events are queued under self.lock and delivered by _deliver() after the lock is released.
        self.listeners: list[RecorderListener] = []
        self._pending: list[tuple[str, Optional[str], str, Optional[str]]] = []
        self._deliver_lock = threading.RLock()

    # State and events ------------------------------------------------------

    def _state_locked(self) -> dict[str, Any]:
        offset = None
        if self.session is not None:
            mic = self.session.tracks[0]
            offset = mic.frames * 1000 // mic.device.rate
        return {
            "revision": self.revision,
            "status": self.status,
            "meeting_id": self.meeting_id,
            "source": self.source,
            "error": self.error,
            "recording_offset_ms": offset,
            "processing_notice": self.processing_notice,
            "origin": self.origin,
        }

    @property
    def origin(self) -> Optional[str]:
        """Who began the active recording: 'manual' or 'auto'. None when no recording is active."""
        return self.session.origin if self.session is not None else None

    def state(self) -> dict[str, Any]:
        with self.lock:
            return self._state_locked()

    def _publish(self) -> dict[str, Any]:
        self.revision += 1
        state = self._state_locked()
        self.emit("recording_state", state)
        return state

    def add_listener(self, listener: RecorderListener) -> None:
        with self.lock:
            if listener not in self.listeners:
                self.listeners.append(listener)

    def remove_listener(self, listener: RecorderListener) -> None:
        with self.lock:
            if listener in self.listeners:
                self.listeners.remove(listener)

    def _queue(self, kind: str, meeting_id: Optional[str], origin: str, reason: Optional[str]) -> None:
        """Records an event. Called under self.lock, after the change's database commit."""
        self._pending.append((kind, meeting_id, origin, reason))

    def _deliver(self) -> None:
        """Hands queued events to the listeners, in order. Called only when self.lock is not held."""
        with self._deliver_lock:  # keeps delivery in queue order across threads
            with self.lock:
                events, self._pending = self._pending, []
                listeners = list(self.listeners)
            for event in events:
                for listener in listeners:
                    try:
                        listener.recorder_event(*event)
                    except Exception:
                        log.exception("recorder listener failed on %s", event[0])

    def busy_for(self, meeting_id: str) -> bool:
        return self.meeting_id == meeting_id and (
            self.session is not None or self.status in ("recording", "paused")
        )

    # Devices -----------------------------------------------------------------

    def devices(self) -> dict[str, Any]:
        if not self.backend.supported():
            return {"capture_supported": False, "microphones": [], "outputs": []}
        try:
            mics = self.backend.input_devices()
            outputs = self.backend.output_devices()
        except BackendError as error:
            raise audio_error(error.message) from error
        return {
            "capture_supported": True,
            "microphones": [{"id": d.id, "name": d.name} for d in mics],
            "outputs": [{"id": d.id, "name": d.name} for d in outputs],
        }

    def _resolve(self, listing: Callable[[], list[DeviceInfo]], device_id: str, missing: str) -> DeviceInfo:
        try:
            devices = listing()
        except BackendError as error:
            raise audio_error(error.message) from error
        for device in devices:
            if device.id == device_id:
                if not (1 <= device.channels <= 8 and 8000 <= device.rate <= 192000):
                    raise audio_error(FORMAT_LIMITS)
                return device
        raise audio_error(missing)

    # Start, pause, resume, stop --------------------------------------------

    @_notifies
    def start(self, title: str, microphone_id: str, output_id: str, origin: str = "manual") -> dict[str, Any]:
        origin = _checked_origin(origin)
        with self.lock:
            if self.session is not None or self.status in ("recording", "paused"):
                raise AppError("already_recording", "Stop the active recording before starting another.")
            title = validate_title(title)
            if not microphone_id or not output_id:
                raise AppError("audio_devices", "Select both a microphone and a system-output device.")
            mic = self._resolve(self.backend.input_devices, microphone_id, _mic_missing())
            out = self._resolve(self.backend.output_devices, output_id, OUTPUT_MISSING)
            # Automatic processing is decided before any file exists. A skipped plan never blocks the recording.
            plan, notice = self._prepare_processing()
            meeting_id = str(uuid.uuid4())
            live_session = self._open_live(meeting_id, mic, out)
            try:
                session = self._open_session(meeting_id, mic, out, live_session)
            except BaseException:
                self._abandon_live(live_session)
                raise
            session.origin = origin
            try:
                with self.store.lock:
                    with transaction(self.store.db) as db:
                        db.execute(
                            "INSERT INTO meetings(id, title, started_at, source, status) "
                            "VALUES (?1, ?2, ?3, 'desktop', 'recording')",
                            (meeting_id, title, now()),
                        )
                        db.execute("INSERT INTO notes(meeting_id) VALUES (?1)", (meeting_id,))
                        for track in session.tracks:
                            db.execute(
                                "INSERT INTO tracks(meeting_id, kind, path, timing_path, device_name, "
                                "sample_rate, channels) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                                (
                                    meeting_id,
                                    track.kind,
                                    str(track.path),
                                    str(track.timing_path),
                                    track.device.name,
                                    track.device.rate,
                                    track.device.channels,
                                ),
                            )
                        db.execute(
                            "UPDATE settings SET microphone_id = ?1, output_id = ?2 WHERE id = 1",
                            (microphone_id, output_id),
                        )
                        if plan is not None:
                            self.processing.attach(db, plan, meeting_id)
            except BaseException:
                session.discard()
                self._abandon_live(live_session)
                raise
            session.accepting = True
            self.session = session
            self.meeting_id = meeting_id
            self.source = "desktop"
            self.error = None
            self.status = "recording"
            self.processing_notice = notice
            self._start_meter(session)
            if plan is not None:
                self.processing.started(meeting_id, plan["id"])
            self._queue("started", meeting_id, origin, None)
            return self._publish()

    def _open_live(self, meeting_id: str, mic: DeviceInfo, out: DeviceInfo) -> Any:
        """The live session for this recording, or None when live transcript is off or cannot run."""
        if self.live is None:
            return None
        return self.live.begin(
            meeting_id, [("mic", mic.rate, mic.channels), ("system", out.rate, out.channels)]
        )

    def _abandon_live(self, live_session: Any) -> None:
        """A recording that never reached the database gives its live session up."""
        if live_session is not None and self.live is not None:
            self.live.abandon(live_session)

    def _prepare_processing(self) -> tuple[Optional[dict[str, Any]], Optional[str]]:
        if self.processing is None:
            return None, None
        return self.processing.prepare()

    def _open_session(
        self, meeting_id: str, mic: DeviceInfo, out: DeviceInfo, live: Any = None
    ) -> Session:
        folder = self.audio_root / meeting_id
        self.audio_root.mkdir(parents=True, exist_ok=True)
        folder.mkdir()  # exclusive: a UUID folder is never reused or truncated
        tracks: list[_Track] = []
        session: Optional[Session] = None
        try:
            for kind, device in zip(KINDS, (mic, out)):
                wav_path = folder / f"{kind}.wav"
                timing_path = folder / f"{kind}.timing.jsonl"
                wav = WavFile(wav_path, device.rate, device.channels)
                try:
                    timing = open(timing_path, "xb")
                except BaseException:
                    wav.close()
                    raise
                tracks.append(_Track(kind, device, wav_path, timing_path, wav, timing))
            session = Session(meeting_id, folder, tracks, live)
            for index, track in enumerate(tracks):
                track.stream = self.backend.open_stream(track.device, _bind(session, index))
        except BackendError as error:
            self._discard_unstarted(session, folder, tracks)
            raise audio_error(error.message) from error
        except BaseException:
            self._discard_unstarted(session, folder, tracks)
            raise
        return session

    def _discard_unstarted(self, session: Optional[Session], folder: Path, tracks: list[_Track]) -> None:
        if session is not None:
            session.discard()
            return
        for track in tracks:
            track.wav.close()
            track.timing.close()
            for path in (track.path, track.timing_path):
                try:
                    path.unlink()
                except OSError:
                    pass
        try:
            folder.rmdir()
        except OSError:
            pass

    @_notifies
    def pause(self, origin: str = "manual") -> dict[str, Any]:
        origin = _checked_origin(origin)
        with self.lock:
            if self.status != "recording" or self.session is None:
                raise AppError("invalid_state", "Recording is not active.")
            session = self.session
            session.halt_streams()  # no new audio from here on
            self.status = "paused"
            if not session.checkpoint() or session.fault:
                self.error = session.fault_text()
            self._store_status("paused", session)
            self._capture_event("paused", session)
            self._queue("paused", session.meeting_id, origin, None)
            if session.fault:
                self._queue("fault", session.meeting_id, session.origin, CAPTURE_ERROR_CODE)
            return self._publish()

    @_notifies
    def resume(self, origin: str = "manual") -> dict[str, Any]:
        origin = _checked_origin(origin)
        with self.lock:
            session = self.session
            if session is None or self.status != "paused":
                raise AppError("invalid_state", "Recording is not paused.")
            if session.fault:
                raise audio_error(session.fault_text() or "Capture stopped.")
            mic = self._resolve(self.backend.input_devices, session.tracks[0].device.id, _mic_missing())
            out = self._resolve(self.backend.output_devices, session.tracks[1].device.id, OUTPUT_MISSING)
            for device, track in zip((mic, out), session.tracks):
                if (device.rate, device.channels) != (track.device.rate, track.device.channels):
                    raise audio_error(FORMAT_CHANGED)
            opened: list[tuple[_Track, Any]] = []
            try:
                for index, (device, track) in enumerate(zip((mic, out), session.tracks)):
                    opened.append((track, self.backend.open_stream(device, _bind(session, index))))
            except BackendError as error:
                for _, stream in opened:
                    _quiet_stop(stream)
                raise audio_error(error.message) from error
            for (track, stream), device in zip(opened, (mic, out)):
                track.stream = stream
                track.device = device
            session.generation += 1
            session.accepting = True
            try:
                self._store_status("recording", session)
            except BaseException:
                session.halt_streams()
                self.status = "paused"
                raise
            self.status = "recording"
            self.error = None
            self._capture_event("resumed", session)
            self._queue("resumed", session.meeting_id, origin, None)
            return self._publish()

    @_notifies
    def stop(self, origin: str = "manual") -> dict[str, Any]:
        origin = _checked_origin(origin)
        with self.lock:
            session = self.session
            if session is None:
                return self._state_locked()
            session.halt_streams()
            if not session.close_writer():
                session.fault |= WORKER_ERROR
                self.status = "paused"
                self.error = session.fault_text()
                self._store_status("paused", session)
                self._publish()
                self._queue("stop_failed", session.meeting_id, origin, "audio_worker_busy")
                raise AppError(
                    "audio_worker_busy",
                    "Audio capture: Capture worker did not respond (stop timed out; retry Stop after "
                    "the worker responds). Capture is disabled; partial files are retained for recovery.",
                )
            error = session.fault_text()
            try:
                self._finish_db(session, error)
            except sqlite3.Error:
                # The writer has finished, so the session stays and a retried Stop writes the rows.
                self.status = "paused"
                self.error = error
                self._publish()
                self._queue("stop_failed", session.meeting_id, origin, "database")
                raise
            self.session = None
            self._capture_event("stopped" if error is None else "error", session)
            self._finish_live(session)
            self.status = "stopped"
            self.error = error
            self._queue("stopped", session.meeting_id, origin, CAPTURE_ERROR_CODE if error else None)
            return self._publish()

    def _finish_live(self, session: Session) -> None:
        """Drains the live session on its own thread: the stop command never waits for a decoder."""
        if session.live is not None and self.live is not None:
            self.live.finish(session.live)

    def toggle_pause(self, origin: str = "manual") -> dict[str, Any]:
        """The global pause/resume shortcut: the same calls the buttons make."""
        with self.lock:  # read only: pause and resume take the lock themselves and deliver events
            status = self.status
        if status == "recording":
            return self.pause(origin=origin)
        if status == "paused":
            return self.resume(origin=origin)
        raise AppError("invalid_state", "Recording is not active.")

    def shutdown(self) -> None:
        """Window or server closing: finalize an active recording so its files are complete."""
        try:
            self.stop(origin="shutdown")  # a no-op when nothing is recording
        except Exception:
            log.warning("the active recording could not be finalized at shutdown")

    # Meter -------------------------------------------------------------------

    def _start_meter(self, session: Session) -> None:
        threading.Thread(
            target=self._meter_loop, args=(session,), name="openmeet-audio-meter", daemon=True
        ).start()

    def _meter_loop(self, session: Session) -> None:
        last = time.monotonic()
        while not session.finished.is_set():
            time.sleep(METER_INTERVAL)
            tick = time.monotonic()
            with self.lock:
                if self.session is not session:
                    break
                if self.status == "recording":
                    if tick - last > SUSPEND_GAP:
                        session.fault |= SUSPENDED
                    for index, track in enumerate(session.tracks):
                        error = track.stream.error() if track.stream is not None else None
                        if error:
                            session.stream_error(index, error)
                    if session.fault:
                        self._pause_on_fault(session)
                health = session.health(self.status == "recording")
            self._deliver()
            last = tick
            self.emit("audio_health", health)

    def _pause_on_fault(self, session: Session) -> None:
        session.halt_streams()
        self.status = "paused"
        self.error = session.fault_text()
        self._queue("fault", session.meeting_id, session.origin, CAPTURE_ERROR_CODE)
        try:
            self._store_status("paused", session, capture_error=self.error)
            self._capture_event("error", session)
        except sqlite3.Error:
            # The in-memory state is already paused and safe; the next stop writes the row again.
            log.warning("the paused state could not be stored")
        self._publish()

    # Database ----------------------------------------------------------------

    def _store_status(self, status: str, session: Session, capture_error: Optional[str] = None) -> None:
        with self.store.lock:
            if capture_error is None:
                self.store.db.execute(
                    "UPDATE meetings SET status = ?1 WHERE id = ?2", (status, session.meeting_id)
                )
            else:
                self.store.db.execute(
                    "UPDATE meetings SET status = ?1, capture_error = ?2 WHERE id = ?3",
                    (status, capture_error, session.meeting_id),
                )

    def _capture_event(self, kind: str, session: Session) -> None:
        with self.store.lock:
            self.store.db.execute(
                "INSERT INTO capture_events(meeting_id, kind, offset_us) VALUES (?1, ?2, ?3)",
                (session.meeting_id, kind, session.now_us()),
            )

    def _finish_db(self, session: Session, error: Optional[str]) -> None:
        with self.store.lock:
            with transaction(self.store.db) as db:
                for track in session.tracks:
                    db.execute(
                        "UPDATE tracks SET frames = ?1, dropped_frames = ?2, finalized = ?3 "
                        "WHERE meeting_id = ?4 AND kind = ?5",
                        (track.frames, track.dropped, int(track.finalized), session.meeting_id, track.kind),
                    )
                db.execute(
                    "UPDATE meetings SET ended_at = ?1, status = ?2, capture_error = ?3 WHERE id = ?4",
                    (now(), "stopped" if error is None else "interrupted", error, session.meeting_id),
                )
                if self.processing is not None:
                    # Same transaction as the meeting's final state: the stage moves with the recording.
                    self.processing.stopped(
                        db, session.meeting_id, all(track.finalized for track in session.tracks)
                    )


def _bind(session: Session, index: int) -> Callable[[bytes, int, bool], None]:
    def on_audio(data: bytes, frames: int, gap: bool) -> None:
        session.on_audio(index, data, frames, gap)

    return on_audio


def _quiet_stop(stream: Any) -> None:
    try:
        stream.stop()
    except Exception:
        log.warning("stopping an audio stream failed")

