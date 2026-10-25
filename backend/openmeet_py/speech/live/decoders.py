"""Live decoders: streaming ONNX, VAD plus an offline engine, cloud and a fake.

Every decoder turns one lane's 16 kHz mono samples into Update objects in lane-local sample units.
Finals close an utterance and move the numbering on; partials carry the same utterance number, so
the UI replaces the text in place. Speech is found by a gate (the sherpa-onnx Silero VAD) fed one
Silero window at a time; the 512-sample window matters, because a bigger feed makes the VAD drop
every segment that ends inside it except the last one.
"""

from __future__ import annotations

import threading
from typing import Callable, Optional, Protocol

import numpy as np

from openmeet_py.speech.live.contract import TARGET_RATE, Update
from openmeet_py.speech.transcription.engine import SHERPA_VAD_CHUNK

VAD_BUFFER_SECONDS = 60
PARTIAL_EVERY = 24_000  # 1.5 s of open speech between partial decodes
MAX_UTTERANCE = 240_000  # 15 s: a forced cut, so a partial decode never grows without bound
MIN_FINAL = 16_000  # 1 s: shorter leftovers are not decoded
CLOUD_MAX_UTTERANCE = 480_000  # 30 s per upload
CLOUD_MIN_UTTERANCE = 8_000  # 0.5 s
CLOUD_MAX_REQUESTS = 240
CLOUD_MAX_BYTES = 100 * 1024 * 1024
FAKE_SEGMENT = 2 * TARGET_RATE


def _contiguous(samples) -> np.ndarray:
    return np.ascontiguousarray(samples, dtype=np.float32)


class Gate(Protocol):
    """Speech segments over the audio pushed so far, in lane-local samples."""

    def push(self, samples16k: np.ndarray) -> list[tuple[int, int]]: ...

    def flush(self) -> list[tuple[int, int]]: ...


class SileroGate:
    """sherpa-onnx Silero VAD, fed one 512-sample window at a time.

    The device audio is already at 16 kHz by the time it gets here. Segment starts are positions in
    the lane, cumulative from the first sample.
    """

    def __init__(self, vad_path, window: int = SHERPA_VAD_CHUNK, buffer_seconds: int = VAD_BUFFER_SECONDS):
        import sherpa_onnx  # lazy: no native library until a live transcript really runs

        config = sherpa_onnx.VadModelConfig(
            silero_vad=sherpa_onnx.SileroVadModelConfig(model=str(vad_path)),
            sample_rate=TARGET_RATE,
            num_threads=1,
        )
        self.window = max(1, int(window))
        self._vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=buffer_seconds)

    def push(self, samples16k: np.ndarray) -> list[tuple[int, int]]:
        samples = _contiguous(samples16k)
        segments: list[tuple[int, int]] = []
        for offset in range(0, samples.size, self.window):
            self._vad.accept_waveform(samples[offset:offset + self.window])
            segments.extend(self._drain())
        return segments

    def flush(self) -> list[tuple[int, int]]:
        self._vad.flush()
        return self._drain()

    def _drain(self) -> list[tuple[int, int]]:
        segments: list[tuple[int, int]] = []
        while not self._vad.empty():
            segment = self._vad.front
            start = int(segment.start)
            length = int(np.asarray(segment.samples).size)
            self._vad.pop()
            if length > 0:
                segments.append((start, start + length))
        return segments


class LevelGate:
    """A level gate for the whisper engine, used only when no Silero VAD file is installed.

    Frames of 30 ms; speech opens after three loud frames and closes after 600 ms of quiet. The
    engine still transcribes, so the gate only decides where an utterance starts and ends.
    """

    FRAME = 480
    OPEN_FRAMES = 3
    HOLD_FRAMES = 20
    FLOOR = 0.006
    RATIO = 3.0

    def __init__(self) -> None:
        self._rest = np.zeros(0, dtype=np.float32)
        self._base = 0  # absolute index of self._rest[0]
        self._floor = self.FLOOR
        self._start: Optional[int] = None
        self._loud = 0
        self._quiet = 0
        self._last = 0  # end of the last closed segment

    def push(self, samples16k: np.ndarray) -> list[tuple[int, int]]:
        samples = _contiguous(samples16k)
        buffer = np.concatenate([self._rest, samples]) if self._rest.size else samples
        closed: list[tuple[int, int]] = []
        at = 0
        while buffer.size - at >= self.FRAME:
            frame = buffer[at:at + self.FRAME]
            at += self.FRAME
            level = float(np.sqrt(np.mean(np.square(frame, dtype=np.float64))))
            closed.extend(self._frame(level, self._base + at))
        self._rest = np.array(buffer[at:], dtype=np.float32)
        self._base += at
        return closed

    def flush(self) -> list[tuple[int, int]]:
        end = self._base + int(self._rest.size)
        closed: list[tuple[int, int]] = []
        if self._start is not None and end - self._start >= self.FRAME * self.OPEN_FRAMES:
            closed.append((self._start, end))
        self._start = None
        self._rest = np.zeros(0, dtype=np.float32)
        self._base = end
        return closed

    def _frame(self, level: float, end: int) -> list[tuple[int, int]]:
        threshold = max(self.FLOOR, self._floor * self.RATIO)
        if self._start is None:
            self._floor = 0.95 * self._floor + 0.05 * level
            self._loud = self._loud + 1 if level > threshold else 0
            if self._loud >= self.OPEN_FRAMES:
                self._start = max(self._last, end - self.OPEN_FRAMES * self.FRAME)
                self._quiet = 0
            return []
        if level > threshold:
            self._quiet = 0
            return []
        self._quiet += 1
        if self._quiet < self.HOLD_FRAMES:
            return []
        stop = end - self._quiet * self.FRAME
        start = self._start
        self._start = None
        self._quiet = 0
        self._last = stop
        return [(start, stop)] if stop > start else []


class StreamingDecoder:
    """sherpa-onnx OnlineRecognizer: partial on every text change, final on endpoint or at the end."""

    def __init__(self, recognizer, endpoint: bool = True):
        self._recognizer = recognizer
        self._endpoint = endpoint
        self._stream = recognizer.create_stream()
        self._fed = 0
        self._start = 0
        self._utterance = 0
        self._text = ""

    def feed(self, samples16k: np.ndarray) -> list[Update]:
        samples = _contiguous(samples16k)
        if samples.size == 0:
            return []
        self._stream.accept_waveform(TARGET_RATE, samples)
        self._fed += int(samples.size)
        self._decode()
        text = self._result()
        updates: list[Update] = []
        if self._endpoint and bool(self._recognizer.is_endpoint(self._stream)):
            updates.extend(self._close(text))
            return updates
        if text and text != self._text:
            self._text = text
            updates.append(Update(self._utterance, text, self._start, self._fed, False))
        return updates

    def finish(self) -> list[Update]:
        self._stream.input_finished()
        self._decode()
        return self._close(self._result() or self._text)

    def _decode(self) -> None:
        while bool(self._recognizer.is_ready(self._stream)):
            self._recognizer.decode_stream(self._stream)

    def _result(self) -> str:
        """sherpa-onnx 1.13 returns the text as a str from get_result; older builds return an object."""
        result = self._recognizer.get_result(self._stream)
        text = result if isinstance(result, str) else getattr(result, "text", "")
        return str(text or "").strip()

    def _close(self, text: str) -> list[Update]:
        updates: list[Update] = []
        text = (text or self._text or "").strip()
        if text:
            updates.append(Update(self._utterance, text, self._start, self._fed, True))
            self._utterance += 1
        self._stream = self._recognizer.create_stream()  # a fresh stream, so the next utterance is clean
        self._start = self._fed
        self._text = ""
        return updates


class VadDecoder:
    """Speech gate around an offline decode of the open utterance.

    The engine is loaded once by the caller and passed in as `decode`; this class only decides what
    audio to decode and when. A partial round is skipped while the previous decode is still running,
    because feed() is called on the one worker thread: decoding is never concurrent with feeding.
    """

    partials = True

    def __init__(self, gate: Gate, decode: Callable[[np.ndarray], str],
                 partial_every: int = PARTIAL_EVERY, max_utterance: int = MAX_UTTERANCE,
                 min_final: int = MIN_FINAL):
        self._gate = gate
        self._decode = decode
        self._partial_every = max(1, int(partial_every))
        self._max_utterance = max(1, int(max_utterance))
        self._min_final = max(1, int(min_final))
        self._open = np.zeros(0, dtype=np.float32)
        self._open_start = 0
        self._fed = 0
        self._utterance = 0
        self._partial_at = 0
        self._partial_text = ""

    def feed(self, samples16k: np.ndarray) -> list[Update]:
        samples = _contiguous(samples16k)
        if samples.size == 0:
            return []
        self._fed += int(samples.size)
        self._open = np.concatenate([self._open, samples])
        updates: list[Update] = []
        for start, end in self._gate.push(samples):
            updates.extend(self._close(start, end))
        if self._fed - self._open_start >= self._max_utterance:
            updates.extend(self._close(self._open_start, self._fed))
        if self.partials:
            partial = self._partial()
            if partial is not None:
                updates.append(partial)
        return updates

    def finish(self) -> list[Update]:
        updates: list[Update] = []
        for start, end in self._gate.flush():
            updates.extend(self._close(start, end))
        if self._open.size >= self._min_final:
            text = self._text(self._open)
            if text:
                updates.append(Update(self._utterance, text, self._open_start, self._fed, True))
                self._utterance += 1
        self._drop(self._fed)
        return updates

    def _partial(self) -> Optional[Update]:
        if self._fed - self._open_start < self._partial_every:
            return None
        if self._fed - self._partial_at < self._partial_every:
            return None
        self._partial_at = self._fed
        text = self._text(self._open)
        if not text or text == self._partial_text:
            return None
        self._partial_text = text
        return Update(self._utterance, text, self._open_start, self._fed, False)

    def _text(self, audio: np.ndarray) -> str:
        if audio.size == 0:
            return ""
        return str(self._decode(_contiguous(audio)) or "").strip()

    def _close(self, start: int, end: int) -> list[Update]:
        start = max(int(start), self._open_start)
        end = min(int(end), self._fed)
        updates: list[Update] = []
        if end > start:
            audio = self._open[start - self._open_start:end - self._open_start]
            text = self._text(audio)
            if text:
                updates.append(Update(self._utterance, text, start, end, True))
                self._utterance += 1
        if end > self._open_start:
            self._drop(end)
        return updates

    def _drop(self, position: int) -> None:
        cut = min(max(position - self._open_start, 0), self._open.size)
        if cut > 0:
            self._open = self._open[cut:]
        self._open_start = max(self._open_start, position)
        self._partial_at = max(self._partial_at, self._open_start)
        self._partial_text = ""


class CloudBudget:
    """One recording's cloud requests and upload bytes, shared by every lane.

    Reserved under one lock before each request, so two lanes can never both spend the last request.
    Once a reservation is refused the budget stays blocked: the session reads that and stops visibly.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.max_requests = CLOUD_MAX_REQUESTS
        self.max_bytes = CLOUD_MAX_BYTES
        self.requests = 0
        self.bytes_sent = 0
        self.blocked = False

    def reserve(self, size: int) -> bool:
        with self._lock:
            if self.blocked or self.requests >= self.max_requests or self.bytes_sent + size > self.max_bytes:
                self.blocked = True
                return False
            self.requests += 1
            self.bytes_sent += size
            return True


class CloudDecoder(VadDecoder):
    """VAD utterances sent one at a time, final only. Caps and no retries; the transcript text stays here."""

    partials = False

    def __init__(self, upload: Callable[[np.ndarray], str], gate: Optional[Gate] = None,
                 budget: Optional[CloudBudget] = None):
        super().__init__(gate or LevelGate(), self._send, partial_every=CLOUD_MAX_UTTERANCE,
                         max_utterance=CLOUD_MAX_UTTERANCE, min_final=CLOUD_MIN_UTTERANCE)
        self._upload = upload
        self._budget = budget or CloudBudget()

    @property
    def requests(self) -> int:
        return self._budget.requests

    @property
    def bytes_sent(self) -> int:
        return self._budget.bytes_sent

    @property
    def blocked(self) -> bool:
        return self._budget.blocked

    def _send(self, audio: np.ndarray) -> str:
        if self._budget.blocked:
            return ""
        size = int(audio.size) * 2  # the upload is 16-bit mono
        if not self._budget.reserve(size):
            return ""
        return str(self._upload(_contiguous(audio)) or "").strip()


class FakeDecoder:
    """Deterministic fictional lines for tests and the browser harness. Never presented as real speech."""

    def __init__(self, text: str = "Fictional line", segment: int = FAKE_SEGMENT):
        self.text = text
        self.segment = max(1, int(segment))
        self._open = np.zeros(0, dtype=np.float32)
        self._start = 0
        self._utterance = 0

    def feed(self, samples16k: np.ndarray) -> list[Update]:
        samples = _contiguous(samples16k)
        if samples.size == 0:
            return []
        self._open = np.concatenate([self._open, samples])
        updates: list[Update] = []
        while self._open.size >= self.segment:
            end = self._start + self.segment
            updates.append(Update(self._utterance, f"{self.text} {self._utterance + 1}", self._start, end, True))
            self._utterance += 1
            self._start = end
            self._open = self._open[self.segment:]
        return updates

    def finish(self) -> list[Update]:
        updates: list[Update] = []
        if self._open.size >= self.segment // 2:
            end = self._start + int(self._open.size)
            updates.append(Update(self._utterance, f"{self.text} {self._utterance + 1}", self._start, end, True))
            self._utterance += 1
            self._start = end
        self._open = np.zeros(0, dtype=np.float32)
        return updates
