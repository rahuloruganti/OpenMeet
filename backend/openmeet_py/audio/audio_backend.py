"""Capture backends: the only code that touches audio devices.

FakeBackend makes synthetic tones and produces no real audio. Tests and OPENMEET_PY_FAKE_AUDIO=1
use it. PortAudioBackend wraps PyAudioWPatch, which is imported only inside its methods. Building
the backend never imports or opens the library, and tests block the import (see conftest.py).

Device ids are built from the name and host API, with the PortAudio index only as a tiebreaker for
duplicate names. Indices change when devices are added or removed, so every start and resume
re-resolves ids. A loopback device records everything the output plays, including OpenMeet's own
playback. Loopback capture cannot exclude it, so the device label says so.
"""

from __future__ import annotations

import math
import os
import threading
import time
from array import array
from dataclasses import dataclass, replace
from typing import Callable, Optional, Protocol

OUTPUT_SUFFIX = " (all audio, includes OpenMeet playback)"
LOOPBACK_TAG = " [Loopback]"
FRAMES_PER_BUFFER = 1024

# (samples, frames, gap) where gap means the device reported an overflow or underflow.
AudioCallback = Callable[[bytes, int, bool], None]


@dataclass(frozen=True)
class DeviceInfo:
    id: str
    name: str
    index: int
    rate: int
    channels: int


class BackendError(Exception):
    """A device or stream operation failed. The message is shown to the user."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class Stream(Protocol):
    def stop(self) -> None:
        """Returns only after no callback can run again."""

    def error(self) -> Optional[str]:
        """Why the stream died on its own, or None. Always None after stop()."""


class CaptureBackend(Protocol):
    name: str

    def supported(self) -> bool: ...

    def input_devices(self) -> list[DeviceInfo]: ...

    def output_devices(self) -> list[DeviceInfo]: ...

    def open_stream(self, device: DeviceInfo, on_audio: AudioCallback) -> Stream: ...


def make_backend() -> "CaptureBackend":
    if os.environ.get("OPENMEET_PY_FAKE_AUDIO") == "1":
        return FakeBackend()
    return PortAudioBackend()


# ---- fake backend ------------------------------------------------------------


class FakeStream:
    """Produces synthetic audio. With auto_pump it runs a thread at real-time pace; tests call deliver."""

    def __init__(self, device: DeviceInfo, on_audio: AudioCallback, auto_pump: bool, tone: float):
        self.device = device
        self._on_audio = on_audio
        self._tone = tone
        self._phase = 0
        self._error: Optional[str] = None
        self._stopped = False
        self._thread: Optional[threading.Thread] = None
        if auto_pump:
            self._thread = threading.Thread(target=self._pump, name="fake-audio", daemon=True)
            self._thread.start()

    def _pump(self) -> None:
        while not self._stopped:
            time.sleep(FRAMES_PER_BUFFER / self.device.rate)
            if self._stopped:
                break
            self.deliver(FRAMES_PER_BUFFER)

    def deliver(self, frames: int, value: Optional[float] = None) -> None:
        """Hands one block to the recorder, as a device callback would. Tests may call it after stop()."""
        if self._error is not None:
            return
        count = frames * self.device.channels
        if value is None:
            step = 2 * math.pi * self._tone / self.device.rate
            samples = [0.25 * math.sin(self._phase + step * i) for i in range(frames)]
            self._phase = (self._phase + step * frames) % (2 * math.pi)
            samples = [s for s in samples for _ in range(self.device.channels)]
        else:
            samples = [value] * count
        self._on_audio(array("f", samples).tobytes(), frames, False)

    def fail(self, message: str) -> None:
        self._error = message
        self._stopped = True

    def stop(self) -> None:
        self._stopped = True
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=5)

    def error(self) -> Optional[str]:
        return self._error


class FakeBackend:
    """Two synthetic devices: a mono "microphone" and a stereo "output" loopback. Failure hooks for tests."""

    name = "fake"

    def __init__(self, auto_pump: bool = True):
        self.auto_pump = auto_pump
        self._devices = {
            "fake-mic": DeviceInfo("fake-mic", "Synthetic microphone", 0, 16000, 1),
            "fake-output": DeviceInfo("fake-output", "Synthetic output" + OUTPUT_SUFFIX, 1, 16000, 2),
        }
        self._tones = {"fake-mic": 440.0, "fake-output": 660.0}
        self.missing: set[str] = set()
        self.open_failures: dict[str, str] = {}
        self.streams: list[FakeStream] = []

    def supported(self) -> bool:
        return True

    def input_devices(self) -> list[DeviceInfo]:
        return [self._devices["fake-mic"]] if "fake-mic" not in self.missing else []

    def output_devices(self) -> list[DeviceInfo]:
        return [self._devices["fake-output"]] if "fake-output" not in self.missing else []

    def set_format(self, device_id: str, rate: int, channels: int) -> None:
        self._devices[device_id] = replace(self._devices[device_id], rate=rate, channels=channels)

    def open_stream(self, device: DeviceInfo, on_audio: AudioCallback) -> FakeStream:
        if device.id in self.open_failures:
            raise BackendError(self.open_failures[device.id])
        stream = FakeStream(device, on_audio, self.auto_pump, self._tones[device.id])
        self.streams.append(stream)
        return stream

    def stream_for(self, device_id: str) -> FakeStream:
        return [s for s in self.streams if s.device.id == device_id][-1]


# ---- PyAudioWPatch backend -----------------------------------------------------


def _label(name: str) -> str:
    base = name[: -len(LOOPBACK_TAG)] if name.endswith(LOOPBACK_TAG) else name
    return base + OUTPUT_SUFFIX


def _with_stable_ids(prefix: str, entries: list[tuple[str, int, str, int, int]]) -> list[DeviceInfo]:
    """entries: (raw name, PortAudio index, display name, rate, channels). Ids come from the raw name."""
    counts: dict[str, int] = {}
    for raw, *_ in entries:
        counts[raw] = counts.get(raw, 0) + 1
    devices = []
    for raw, index, display, rate, channels in entries:
        device_id = f"{prefix}:{raw}" if counts[raw] == 1 else f"{prefix}:{raw}#{index}"
        devices.append(DeviceInfo(device_id, display, index, rate, channels))
    return devices


class _PortAudioStream:
    def __init__(self, pa: object, stream: object):
        self._pa = pa
        self._stream = stream
        self._stopped = False

    def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        try:
            self._stream.stop_stream()  # waits for any running callback
            self._stream.close()
        finally:
            self._pa.terminate()

    def error(self) -> Optional[str]:
        if self._stopped:
            return None
        try:
            return None if self._stream.is_active() else "The stream stopped running."
        except OSError as error:
            return str(error) or "The stream stopped running."


class PortAudioBackend:
    """Real devices through PyAudioWPatch. Imported lazily; never constructed by tests."""

    name = "portaudio"

    def _library(self):
        try:
            import pyaudiowpatch  # lazy: tests must never reach this line
        except ImportError as error:
            raise BackendError("The audio library is not installed in this build.") from error
        return pyaudiowpatch

    def supported(self) -> bool:
        try:
            self._library()
        except BackendError:
            return False
        return True

    def _enumerate(self, want_loopback: bool) -> list[DeviceInfo]:
        library = self._library()
        pa = library.PyAudio()
        try:
            if want_loopback:
                raw = list(pa.get_loopback_device_info_generator())
            else:
                raw = [
                    info
                    for info in pa.get_device_info_generator_by_host_api(host_api_type=library.paWASAPI)
                    if info["maxInputChannels"] > 0 and not info.get("isLoopbackDevice", False)
                ]
            entries = []
            for info in raw:
                name = info["name"]
                display = _label(name) if want_loopback else name
                entries.append(
                    (
                        name,
                        int(info["index"]),
                        display,
                        int(info["defaultSampleRate"]),
                        int(info["maxInputChannels"]),
                    )
                )
            return _with_stable_ids("loopback" if want_loopback else "mic", entries)
        finally:
            pa.terminate()

    def input_devices(self) -> list[DeviceInfo]:
        try:
            return self._enumerate(want_loopback=False)
        except OSError as error:
            raise BackendError(str(error)) from error

    def output_devices(self) -> list[DeviceInfo]:
        try:
            return self._enumerate(want_loopback=True)
        except OSError as error:
            raise BackendError(str(error)) from error

    def open_stream(self, device: DeviceInfo, on_audio: AudioCallback) -> _PortAudioStream:
        library = self._library()
        pa = library.PyAudio()

        def callback(in_data, frame_count, time_info, status):
            try:
                on_audio(in_data, frame_count, bool(status))
            except Exception:  # never let the device thread see a Python exception
                return None, library.paAbort
            return None, library.paContinue

        try:
            stream = pa.open(
                format=library.paFloat32,
                channels=device.channels,
                rate=device.rate,
                input=True,
                input_device_index=device.index,
                frames_per_buffer=FRAMES_PER_BUFFER,
                stream_callback=callback,
            )
        except BaseException as error:
            pa.terminate()
            raise BackendError(str(error) or type(error).__name__) from error
        return _PortAudioStream(pa, stream)
