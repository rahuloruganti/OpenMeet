"""Core Audio capture: microphones through sounddevice, system audio through the process tap.

sounddevice is imported only inside the methods that need it, so this module imports on Windows and
in tests. The tap module (`system_tap_mac`) is imported the same way and is the only source of the
synthetic system device; when it reports itself unavailable there is no system track at all rather
than a silent one-track fallback.

Ids match the Windows scheme: `mic:<name>` for microphones, `loopback:system` for the one system
device. macOS refuses a microphone at the PortAudio layer with an error whose text is the only
signal it gives, so the wording decides whether the user is told to grant microphone access.
"""

from __future__ import annotations

import importlib
import threading
from typing import Optional

from openmeet_py.audio.audio_backend import (
    FRAMES_PER_BUFFER,
    AudioCallback,
    BackendError,
    DeviceInfo,
    Stream,
    _with_stable_ids,
)

SYSTEM_DEVICE_ID = "loopback:system"
SYSTEM_DEVICE_NAME = "System audio (all apps, includes OpenMeet playback)"
# recorder.py accepts 1 to 8 channels at 8 to 192 kHz; a device may offer more input channels.
MAX_INPUT_CHANNELS = 8
MIC_DENIED = (
    "OpenMeet does not have microphone access. Allow it in System Settings, Privacy & Security, "
    "Microphone."
)
_PERMISSION_WORDS = ("permission", "not authorized", "denied", "authoriz", "access")


def _port_audio_errors(library: object) -> tuple[type[BaseException], ...]:
    """The errors sounddevice raises for a refused device, plus OSError, as an except clause."""
    error_type = getattr(library, "PortAudioError", None)
    if isinstance(error_type, type) and issubclass(error_type, BaseException):
        return (error_type, OSError)
    return (OSError,)


def _overflowed(status: object) -> bool:
    """True when PortAudio reported an input overflow for this block. A lost block leaves a gap."""
    flag = getattr(status, "input_overflow", None)
    return bool(flag) if flag is not None else bool(status)


def _open_message(device: DeviceInfo, error: BaseException) -> str:
    text = str(error).strip()
    if any(word in text.lower() for word in _PERMISSION_WORDS):
        return MIC_DENIED
    return f'OpenMeet could not open the microphone "{device.name}". {text or type(error).__name__}'


class _CoreAudioStream:
    """One sounddevice InputStream. stop() runs after the device thread can no longer deliver."""

    def __init__(self, stream: object):
        self._stream = stream
        self._error: Optional[str] = None
        self._stopped = False
        self._lock = threading.Lock()

    def note_error(self, message: str) -> None:
        """Records why the stream failed. Called from the device thread; the first reason wins."""
        if self._error is None:
            self._error = message

    def abandon(self) -> None:
        """Closes a stream that never started. sounddevice refuses stop() on a stopped stream."""
        with self._lock:
            self._stopped = True
        self._stream.close()

    def stop(self) -> None:
        if self._stopped:
            return
        with self._lock:
            if self._stopped:
                return
            self._stopped = True  # a second stop never raises again
        try:
            self._stream.stop()  # returns once the device thread has run its last callback
        finally:
            self._stream.close()

    def error(self) -> Optional[str]:
        if self._stopped:
            return None
        if self._error is not None:
            return self._error
        try:
            return None if self._stream.active else "The stream stopped running."
        except OSError as error:
            return str(error) or "The stream stopped running."


class MacBackend:
    """Real devices through sounddevice plus the Core Audio tap. Libraries are imported lazily."""

    name = "coreaudio"

    def _library(self):
        try:
            import sounddevice  # lazy: tests must never reach this line
        except ImportError as error:
            raise BackendError("The audio library is not installed in this build.") from error
        return sounddevice

    def _tap(self):
        try:
            # import_module, not `from ... import`: it honours sys.modules, so tests can fake the
            # module even after the real one has been imported by another lane's code.
            return importlib.import_module("openmeet_py.audio.system_tap_mac")  # lazy: macOS only
        except ImportError as error:
            raise BackendError("System audio capture is not available in this build.") from error

    def supported(self) -> bool:
        try:
            self._library()
        except BackendError:
            return False
        return True

    def input_devices(self) -> list[DeviceInfo]:
        library = self._library()
        try:
            raw = library.query_devices()
        except _port_audio_errors(library) as error:
            raise BackendError(f"OpenMeet could not list the microphones. {error}") from error
        entries = []
        for info in raw:
            channels = int(info["max_input_channels"])
            if channels < 1:
                continue  # an output-only device
            name = str(info["name"])
            entries.append(
                (
                    name,
                    int(info["index"]),
                    name,
                    int(float(info["default_samplerate"])),
                    min(channels, MAX_INPUT_CHANNELS),
                )
            )
        return _with_stable_ids("mic", entries)

    def output_devices(self) -> list[DeviceInfo]:
        tap = self._tap()
        if tap.tap_unavailable_reason() is not None:
            return []  # the UI shows the reason; nothing is offered instead
        rate, channels = tap.default_format()
        return [DeviceInfo(SYSTEM_DEVICE_ID, SYSTEM_DEVICE_NAME, 0, int(rate), int(channels))]

    def open_stream(self, device: DeviceInfo, on_audio: AudioCallback) -> Stream:
        if device.id == SYSTEM_DEVICE_ID:
            return self._tap().open_tap(on_audio)
        return self._open_microphone(device, on_audio)

    def _open_microphone(self, device: DeviceInfo, on_audio: AudioCallback) -> _CoreAudioStream:
        library = self._library()
        errors = _port_audio_errors(library)
        stream: _CoreAudioStream  # bound before start(), so the device thread always sees it

        def callback(indata: object, frames: int, time_info: object, status: object) -> None:
            try:
                on_audio(indata.tobytes(), frames, _overflowed(status))
            except Exception:  # never let the device thread see a Python exception
                stream.note_error("The microphone stream failed while delivering audio.")
                raise library.CallbackAbort

        try:
            # start=False: no callback can run before the wrapper below exists.
            raw = library.InputStream(
                samplerate=device.rate,
                channels=device.channels,
                dtype="float32",
                device=device.index,
                blocksize=FRAMES_PER_BUFFER,
                callback=callback,
                start=False,
            )
        except errors as error:
            raise BackendError(_open_message(device, error)) from error
        stream = _CoreAudioStream(raw)
        try:
            raw.start()
        except errors as error:
            try:
                stream.abandon()
            except errors:
                pass  # the start error is the one the user needs to see
            raise BackendError(_open_message(device, error)) from error
        return stream
