"""System audio capture on macOS: everything the Mac plays, through a Core Audio process tap.

Written against `catap` 0.6.0 (PyPI, MIT, github.com/sbetko/catap tag v0.6.0), which wraps
`AudioHardwareCreateProcessTap` and a private aggregate device. The calls this module uses:

- `catap.record_system_audio(on_buffer=..., mute=False, mono=False, visible=False,
  max_pending_buffers=...)` returns a `RecordingSession` for a global process-output mix.
- `session.start()`, `session.stop()`, `session.close()`, plus the `is_recording`, `needs_cleanup`,
  `capture_failed` and `stream_format` properties.
- The `on_buffer` callback receives a `catap.AudioBuffer`: `data` bytes, `frame_count`, and a
  `format` with `sample_rate`, `num_channels`, `bits_per_sample` and `sample_type`.

`stop()` joins the in-flight callback and delivers every queued buffer first, which is what lets our
`stop()` promise that no callback runs afterwards. catap calls us from its own worker thread, never
from the Core Audio real-time thread, so this module only converts a block and hands it on; it keeps
no queue of its own.

A capture that overflows, loses its tap or changes format fails instead of dropping audio, so the
callback never reports a gap and a failure shows up through `error()`.

The tap is private and unmuted: it records every app, OpenMeet's own playback included, and the user
still hears the audio. The tap normally runs at 48 kHz float32 stereo; another format is converted
here, because the recorder writes at the rate the device advertised through `default_format()`.
Linear resampling keeps its phase and the last input frame across buffers. Output that needs the
next input frame waits for the next buffer, avoiding both boundary extrapolation and length drift.

Only macOS 14.2 and later have process taps. Nothing here imports catap at module level, so the
module loads on Windows and in tests.
"""

from __future__ import annotations

import logging
import sys
import threading
from typing import Any, Optional

import numpy as np

from openmeet_py.audio.audio_backend import AudioCallback, BackendError
from openmeet_py.platform.macos_version import process_audio_supported

log = logging.getLogger("openmeet_py")

# What a stereo mixdown tap produces. recorder.py accepts 1 to 8 channels at 8 to 192 kHz.
TAP_RATE = 48000
TAP_CHANNELS = 2
# catap's own bound, made explicit: past it the capture fails instead of growing without limit.
PENDING_BUFFERS = 256

NOT_MAC = "System audio capture is only available on a Mac."
OLD_MACOS = "System audio capture needs macOS 14.2 or later."
NO_CATAP = "System audio capture is not included in this build."
UNSUPPORTED_FORMAT = "OpenMeet could not capture system audio: the tap format is not supported."
DENIED = (
    "OpenMeet could not capture system audio. Allow it in System Settings, Privacy & Security, "
    "System Audio Recording."
)
STOPPED = "System audio capture stopped."
STREAM_STOPPED = "The stream stopped running."
CLEANUP_FAILED = "OpenMeet could not finish stopping system audio. Try stopping again."

# (numpy dtype, whether the samples are integers that need scaling to the float range)
_DTYPES = {
    ("float", 32): ("<f4", False),
    ("float", 64): ("<f8", False),
    ("signed_integer", 16): ("<i2", True),
    ("signed_integer", 32): ("<i4", True),
}


def _library() -> Any:
    try:
        import catap  # lazy: exists only on a Mac, and only when the wheel was packaged
    except ImportError as error:
        raise BackendError(NO_CATAP) from error
    return catap


def tap_unavailable_reason() -> Optional[str]:
    """A short user-facing reason why system audio cannot be captured here, or None when it can."""
    if sys.platform != "darwin":
        return NOT_MAC
    if not process_audio_supported():
        return OLD_MACOS
    try:
        _library()
    except BackendError:
        return NO_CATAP
    return None


def default_format() -> tuple[int, int]:
    """Rate and channels after conversion, which is what the device advertises to the recorder."""
    return TAP_RATE, TAP_CHANNELS


class _Layout:
    """Converts one tap buffer format to float32 interleaved at TAP_RATE and TAP_CHANNELS."""

    def __init__(self, fmt: Any):
        known = _DTYPES.get((str(fmt.sample_type), int(fmt.bits_per_sample)))
        if known is None:
            raise BackendError(UNSUPPORTED_FORMAT)
        self._dtype, self._integer = known
        self._item = np.dtype(self._dtype).itemsize
        self._channels = int(fmt.num_channels)
        if self._channels < 1:
            raise BackendError(UNSUPPORTED_FORMAT)
        self._rate = float(fmt.sample_rate)
        if not self._rate > 0:
            raise BackendError(UNSUPPORTED_FORMAT)
        # Integer PCM is scaled to the float range; float PCM is already there.
        self._scale = float(1 << (int(fmt.bits_per_sample) - 1))
        self._resampler = _LinearResampler(self._rate) if self._rate != TAP_RATE else None

    def convert(self, data: bytes, frames: int) -> tuple[bytes, int]:
        """A whole number of frames as float32 interleaved bytes, and their count."""
        # The byte count decides, not the reported frame count: a mismatch must not read past the data.
        usable = min(int(frames), len(data) // (self._item * self._channels))
        if usable < 1:
            return b"", 0
        raw = np.frombuffer(data, dtype=self._dtype, count=usable * self._channels)
        block = raw.astype(np.float32)
        if self._integer:
            block = block / self._scale
        block = block.reshape(usable, self._channels)
        if self._channels != TAP_CHANNELS:
            block = _mix(block)
        if self._resampler is not None:
            block, usable = self._resampler.convert(block)
        return np.ascontiguousarray(block, dtype="<f4").tobytes(), usable


def _mix(block: np.ndarray) -> np.ndarray:
    """One channel is duplicated, more than two are averaged into a left and a right channel."""
    if block.shape[1] == 1:
        return np.repeat(block, TAP_CHANNELS, axis=1)
    left = block[:, 0::2].mean(axis=1, dtype=np.float32)
    right = block[:, 1::2].mean(axis=1, dtype=np.float32)
    return np.stack((left, right), axis=1)


class _LinearResampler:
    """Keeps the next output phase and the boundary frame across tap buffers."""

    def __init__(self, rate: float):
        self._rate = rate
        self._input_frames = 0
        self._output_frames = 0
        self._last: Optional[np.ndarray] = None

    def convert(self, block: np.ndarray) -> tuple[np.ndarray, int]:
        frames = block.shape[0]
        end = self._input_frames + frames - 1
        # Wait for the next input frame instead of extrapolating at each buffer boundary.
        stop = int(np.floor(end * TAP_RATE / self._rate)) + 1
        positions = np.arange(self._output_frames, stop, dtype=np.float64) * self._rate / TAP_RATE
        base = positions.astype(np.int64)
        fraction = (positions - base).astype(np.float32)[:, None]
        start = self._input_frames
        if self._last is not None:
            block = np.concatenate((self._last, block), axis=0)
            start -= 1
        first = block[base - start]
        second = block[np.minimum(base - start + 1, block.shape[0] - 1)]
        self._last = block[-1:].copy()
        self._input_frames += frames
        self._output_frames = stop
        return first + (second - first) * fraction, len(positions)


class TapStream:
    """One global mixdown tap. stop() returns after catap has joined the in-flight callback.

    stop() waits for that callback, so on_audio must never call it.
    """

    def __init__(self, on_audio: AudioCallback):
        self._on_audio = on_audio
        self._session: Optional[Any] = None
        self._layout: Optional[_Layout] = None
        # Set before teardown, so a block that catap still delivers during shutdown is not handed on.
        self._closing = threading.Event()
        self._lock = threading.Lock()
        self._callbacks = threading.Condition()
        self._active_callbacks = 0
        self._stopped = False
        self._cleanup_error: Optional[str] = None
        self._error: Optional[str] = None

    def attach(self, session: Any) -> None:
        self._session = session

    def adopt(self, fmt: Any) -> None:
        """Takes the stream format catap reports after start, so a bad format fails before audio."""
        if fmt is not None:
            with self._callbacks:
                # A worker can deliver during start(); do not reset its interpolation phase.
                if self._layout is None:
                    self._layout = _Layout(fmt)

    def deliver(self, buffer: Any) -> None:
        """Tracks in-flight delivery even when catap cannot join its worker during teardown."""
        with self._callbacks:
            if self._closing.is_set():
                return
            self._active_callbacks += 1
        try:
            self._deliver(buffer)
        finally:
            with self._callbacks:
                self._active_callbacks -= 1
                self._callbacks.notify_all()

    def _deliver(self, buffer: Any) -> None:
        """One catap buffer, on catap's worker thread: convert, then hand the block on."""
        if self._closing.is_set():
            return
        try:
            with self._callbacks:
                layout = self._layout
                if layout is None:
                    layout = self._layout = _Layout(buffer.format)
            data, frames = layout.convert(buffer.data, buffer.frame_count)
        except BackendError as error:
            self._fail(error.message)
            return
        if frames < 1 or self._closing.is_set():
            return
        try:
            # gap is always False: catap fails the capture on overflow instead of dropping audio.
            self._on_audio(data, frames, False)
        except Exception:  # never let the library worker thread see a recorder exception
            self._fail(STREAM_STOPPED)

    def _fail(self, message: str) -> None:
        if self._error is None:
            self._error = message
        self._closing.set()

    def stop(self) -> None:
        # Serialize the whole teardown so another stop cannot return before a callback finishes.
        with self._lock:
            if self._stopped:
                return
            self._closing.set()
            session = self._session
            failed = False
            if session is not None:
                try:
                    if session.is_recording or session.needs_cleanup:
                        session.stop()
                except (OSError, RuntimeError) as error:
                    failed = True
                    log.warning("stopping the system audio tap failed: %s", error)
                try:
                    session.close()  # idempotent; destroys a tap the stop above could not
                except (OSError, RuntimeError) as error:
                    failed = True
                    log.warning("closing the system audio tap failed: %s", error)
            # A failed library teardown might not have joined the worker. Our gate still prevents
            # future delivery, and this wait drains any consumer already inside the gate.
            with self._callbacks:
                self._callbacks.wait_for(lambda: self._active_callbacks == 0)
            self._cleanup_error = CLEANUP_FAILED if failed else None
            self._stopped = not failed

    def error(self) -> Optional[str]:
        if self._cleanup_error is not None:
            return self._cleanup_error
        if self._stopped:
            return None
        if self._error is not None:
            return self._error
        session = self._session
        if session is None:
            return STREAM_STOPPED
        try:
            if session.capture_failed:
                return STOPPED
            return None if session.is_recording else STREAM_STOPPED
        except (OSError, RuntimeError) as error:
            return str(error) or STREAM_STOPPED


def open_tap(on_audio: AudioCallback) -> TapStream:
    """Starts a tap over every process's output and hands float32 interleaved blocks to on_audio."""
    reason = tap_unavailable_reason()
    if reason is not None:
        raise BackendError(reason)
    catap = _library()
    stream = TapStream(on_audio)
    try:
        session = catap.record_system_audio(
            # mute=False: capture is a passthrough, the user keeps hearing the audio.
            mute=False,
            mono=False,
            visible=False,
            on_buffer=stream.deliver,
            max_pending_buffers=PENDING_BUFFERS,
        )
        stream.attach(session)
    except (OSError, RuntimeError) as error:
        raise BackendError(DENIED) from error
    try:
        session.start()
    except (OSError, RuntimeError) as error:
        stream.stop()
        raise BackendError(DENIED) from error
    try:
        stream.adopt(session.stream_format)
    except BackendError:
        stream.stop()
        raise
    return stream
