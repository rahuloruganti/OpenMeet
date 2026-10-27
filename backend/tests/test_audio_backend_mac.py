"""The macOS capture backend, exercised with a fake sounddevice and a fake tap module.

Nothing here opens a device: sounddevice and `system_tap_mac` are fakes in sys.modules. The tap
module is written by another lane, so these tests pin the interface this backend codes against.
"""

from __future__ import annotations

import sys
import types
from dataclasses import dataclass
from typing import Any, Optional

import pytest

import openmeet_py.audio as package
from openmeet_py.audio import audio_backend, recorder
from openmeet_py.audio.audio_backend import FakeBackend, PortAudioBackend
from openmeet_py.audio.audio_backend_mac import (
    MAX_INPUT_CHANNELS,
    MIC_DENIED,
    SYSTEM_DEVICE_ID,
    SYSTEM_DEVICE_NAME,
    MacBackend,
    _overflowed,
)


# ---- fakes at the OS and library boundary -------------------------------------


class FakePortAudioError(Exception):
    pass


@dataclass
class FakeFlags:
    """Mimics sounddevice.CallbackFlags: falsey when clean, input_overflow when not."""

    input_overflow: bool = False

    def __bool__(self) -> bool:
        return self.input_overflow


class FakeBlock:
    """Mimics the numpy float32 block sounddevice hands the callback; only tobytes() is used."""

    def __init__(self, data: bytes):
        self.data = data

    def tobytes(self) -> bytes:
        return self.data


class FakeStreamHandle:
    def __init__(self) -> None:
        self.started = 0
        self.stop_calls = 0
        self.close_calls = 0
        self.active = True
        self.callback: Any = None
        self.kwargs: dict[str, Any] = {}
        self.start_error: Optional[BaseException] = None

    def start(self) -> None:
        self.started += 1
        if self.start_error is not None:
            raise self.start_error

    def stop(self) -> None:
        self.stop_calls += 1
        self.active = False

    def close(self) -> None:
        self.close_calls += 1


class FakeSoundDevice:
    """Only what the backend uses: query_devices, InputStream, flags, CallbackAbort."""

    PortAudioError = FakePortAudioError
    CallbackAbort = FakePortAudioError

    def __init__(self, devices: Optional[list[dict[str, Any]]] = None):
        self.devices = devices if devices is not None else []
        self.open_error: Optional[BaseException] = None
        self.start_error: Optional[BaseException] = None
        self.list_error: Optional[BaseException] = None
        self.handles: list[FakeStreamHandle] = []

    def query_devices(self, *_args: Any, **_kwargs: Any) -> list[dict[str, Any]]:
        if self.list_error is not None:
            raise self.list_error
        return self.devices

    def InputStream(self, **kwargs: Any) -> FakeStreamHandle:  # noqa: N802 - sounddevice's name
        if self.open_error is not None:
            raise self.open_error
        handle = FakeStreamHandle()
        handle.kwargs = kwargs
        handle.callback = kwargs["callback"]
        handle.start_error = self.start_error
        self.handles.append(handle)
        return handle

    def deliver(self, index: int, frames: int = 480, status: Any = None) -> None:
        handle = self.handles[index]
        handle.callback(FakeBlock(bytes(frames * 2)), frames, None, status or FakeFlags())


class FakeTapStream:
    def __init__(self) -> None:
        self.stop_calls = 0
        self.stopped = False

    def stop(self) -> None:
        self.stop_calls += 1
        self.stopped = True

    def error(self) -> Optional[str]:
        return None


class FakeTap:
    def __init__(self, reason: Optional[str] = None, rate: int = 48000, channels: int = 2):
        self.reason = reason
        self.format = (rate, channels)
        self.opened: list[Any] = []

    def tap_unavailable_reason(self) -> Optional[str]:
        return self.reason

    def default_format(self) -> tuple[int, int]:
        return self.format

    def open_tap(self, on_audio: Any) -> FakeTapStream:
        self.opened.append(on_audio)
        return FakeTapStream()


def _device(name: str, index: int, rate: float = 48000.0, channels: int = 1) -> dict[str, Any]:
    return {
        "name": name,
        "index": index,
        "hostapi": 0,
        "max_input_channels": channels,
        "max_output_channels": 0,
        "default_samplerate": rate,
    }


@pytest.fixture
def sd(monkeypatch: pytest.MonkeyPatch) -> FakeSoundDevice:
    fake = FakeSoundDevice()
    monkeypatch.setitem(sys.modules, "sounddevice", fake)
    return fake


@pytest.fixture
def tap(monkeypatch: pytest.MonkeyPatch) -> FakeTap:
    fake = FakeTap()
    monkeypatch.setitem(sys.modules, "openmeet_py.audio.system_tap_mac", fake)
    return fake


# ---- dispatch ----------------------------------------------------------------


def test_make_backend_returns_the_core_audio_backend_on_darwin(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.delenv("OPENMEET_PY_FAKE_AUDIO", raising=False)
    backend = audio_backend.make_backend()
    assert isinstance(backend, MacBackend)
    assert backend.name == "coreaudio"


def test_make_backend_keeps_windows_and_the_fake_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.delenv("OPENMEET_PY_FAKE_AUDIO", raising=False)
    assert isinstance(audio_backend.make_backend(), PortAudioBackend)
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setenv("OPENMEET_PY_FAKE_AUDIO", "1")
    assert isinstance(audio_backend.make_backend(), FakeBackend)


# ---- microphones -------------------------------------------------------------


def test_input_ids_follow_the_windows_scheme_and_index_only_breaks_ties(
    sd: FakeSoundDevice,
) -> None:
    sd.devices = [
        _device("USB Mic", 0),
        _device("USB Mic", 4),
        _device("MacBook Pro Microphone", 2, 44100.0, 2),
    ]
    devices = MacBackend().input_devices()
    assert [d.id for d in devices] == [
        "mic:USB Mic#0",
        "mic:USB Mic#4",
        "mic:MacBook Pro Microphone",
    ]
    assert devices[2].rate == 44100 and devices[2].channels == 2 and devices[2].index == 2


def test_input_devices_skip_output_only_devices_and_cap_channels(sd: FakeSoundDevice) -> None:
    sd.devices = [
        _device("Speakers", 1, channels=0),
        _device("Wide Interface", 3, 96000.0, channels=32),
    ]
    devices = MacBackend().input_devices()
    assert [d.id for d in devices] == ["mic:Wide Interface"]
    assert devices[0].channels == MAX_INPUT_CHANNELS == 8
    assert devices[0].rate == 96000


def test_supported_follows_the_sounddevice_import(
    monkeypatch: pytest.MonkeyPatch, sd: FakeSoundDevice
) -> None:
    assert MacBackend().supported() is True
    monkeypatch.setitem(sys.modules, "sounddevice", None)
    assert MacBackend().supported() is False


def test_listing_devices_without_the_library_fails_visibly(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "sounddevice", None)
    backend = MacBackend()
    with pytest.raises(audio_backend.BackendError, match="audio library is not installed"):
        backend.input_devices()
    with pytest.raises(audio_backend.BackendError):
        backend.open_stream(_mic_device(), lambda *_: None)


def test_listing_errors_become_backend_errors(sd: FakeSoundDevice) -> None:
    sd.list_error = FakePortAudioError("Error querying device -1")
    with pytest.raises(audio_backend.BackendError, match="could not list the microphones"):
        MacBackend().input_devices()


def _mic_device(name: str = "USB Mic"):
    return audio_backend.DeviceInfo(f"mic:{name}", name, 2, 48000, 1)


def test_microphone_stream_uses_float32_and_delivers_bytes(sd: FakeSoundDevice) -> None:
    backend = MacBackend()
    blocks: list[tuple[bytes, int, bool]] = []
    stream = backend.open_stream(_mic_device(), lambda data, frames, gap: blocks.append((data, frames, gap)))
    handle = sd.handles[0]
    assert handle.kwargs["dtype"] == "float32"
    assert handle.kwargs["samplerate"] == 48000 and handle.kwargs["channels"] == 1
    assert handle.kwargs["device"] == 2 and handle.kwargs["blocksize"] == audio_backend.FRAMES_PER_BUFFER
    assert handle.started == 1  # the callback can only run after the wrapper exists
    sd.deliver(0, frames=480)
    data, frames, gap = blocks[0]
    assert len(data) == 480 * 2 and frames == 480 and gap is False
    assert stream.error() is None


def test_callback_reports_an_overflow_as_a_gap(sd: FakeSoundDevice) -> None:
    gaps: list[bool] = []
    MacBackend().open_stream(_mic_device(), lambda data, frames, gap: gaps.append(gap))
    sd.deliver(0, status=FakeFlags(input_overflow=True))
    assert gaps == [True]
    assert _overflowed(FakeFlags(input_overflow=True)) is True
    assert _overflowed(FakeFlags()) is False


def test_stop_waits_for_the_device_thread_and_never_raises_twice(sd: FakeSoundDevice) -> None:
    stream = MacBackend().open_stream(_mic_device(), lambda *_: None)
    handle = sd.handles[0]
    stream.stop()
    assert (handle.stop_calls, handle.close_calls) == (1, 1)
    stream.stop()
    assert (handle.stop_calls, handle.close_calls) == (1, 1)
    assert stream.error() is None


def test_error_reports_a_stream_that_ended_by_itself(sd: FakeSoundDevice) -> None:
    stream = MacBackend().open_stream(_mic_device(), lambda *_: None)
    sd.handles[0].active = False
    assert stream.error() == "The stream stopped running."
    stream.stop()
    assert stream.error() is None


def test_a_failing_consumer_aborts_the_stream_and_reports_it(sd: FakeSoundDevice) -> None:
    def broken_callback(data: bytes, frames: int, gap: bool) -> None:
        raise ValueError("recorder is gone")

    stream = MacBackend().open_stream(_mic_device(), broken_callback)
    with pytest.raises(FakePortAudioError):
        sd.deliver(0)  # CallbackAbort leaves the device thread
    assert "microphone stream failed" in (stream.error() or "")


def test_a_denied_microphone_maps_to_the_permission_message(sd: FakeSoundDevice) -> None:
    sd.open_error = FakePortAudioError("Error opening InputStream: permission denied")
    with pytest.raises(audio_backend.BackendError) as raised:
        MacBackend().open_stream(_mic_device(), lambda *_: None)
    assert raised.value.message == MIC_DENIED
    assert raised.value.message == (
        "OpenMeet does not have microphone access. Allow it in System Settings, Privacy & "
        "Security, Microphone."
    )


def test_other_open_errors_name_the_device_and_keep_the_text(sd: FakeSoundDevice) -> None:
    sd.open_error = FakePortAudioError("Error opening InputStream: Invalid sample rate")
    with pytest.raises(audio_backend.BackendError) as raised:
        MacBackend().open_stream(_mic_device(), lambda *_: None)
    assert raised.value.message.startswith('OpenMeet could not open the microphone "USB Mic".')
    assert "Invalid sample rate" in raised.value.message


def test_a_stream_that_fails_to_start_is_closed_and_mapped(sd: FakeSoundDevice) -> None:
    sd.start_error = FakePortAudioError("Error starting stream: Device unavailable")
    with pytest.raises(audio_backend.BackendError, match="Device unavailable"):
        MacBackend().open_stream(_mic_device(), lambda *_: None)
    handle = sd.handles[0]
    # sounddevice refuses stop() on a stream that never ran, so a failed start only closes.
    assert (handle.stop_calls, handle.close_calls) == (0, 1)


# ---- system audio ------------------------------------------------------------


def test_output_devices_is_one_synthetic_system_device(tap: FakeTap) -> None:
    tap.format = (48000, 2)
    devices = MacBackend().output_devices()
    assert devices == [
        audio_backend.DeviceInfo(SYSTEM_DEVICE_ID, SYSTEM_DEVICE_NAME, 0, 48000, 2)
    ]
    assert devices[0].id == "loopback:system"
    assert "includes OpenMeet playback" in devices[0].name


def test_the_tap_is_resolved_through_sys_modules(
    monkeypatch: pytest.MonkeyPatch, tap: FakeTap
) -> None:
    # Another lane's import can leave the real module as a package attribute. The backend must still
    # read the module this test injected, otherwise the tap becomes untestable once it exists.
    stub = types.ModuleType("openmeet_py.audio.system_tap_mac")
    stub.tap_unavailable_reason = lambda: "the real module"  # type: ignore[attr-defined]
    monkeypatch.setattr(package, "system_tap_mac", stub, raising=False)
    assert [d.id for d in MacBackend().output_devices()] == [SYSTEM_DEVICE_ID]


def test_output_devices_are_empty_when_the_tap_is_unavailable(tap: FakeTap) -> None:
    tap.reason = "System audio capture needs macOS 14.2 or newer."
    assert MacBackend().output_devices() == []


def test_opening_the_system_device_uses_the_tap(tap: FakeTap) -> None:
    backend = MacBackend()
    device = backend.output_devices()[0]
    seen: list[tuple[bytes, int, bool]] = []
    stream = backend.open_stream(device, lambda data, frames, gap: seen.append((data, frames, gap)))
    assert isinstance(stream, FakeTapStream)
    assert len(tap.opened) == 1
    tap.opened[0](b"\x00\x00\x00\x00", 1, False)
    assert seen == [(b"\x00\x00\x00\x00", 1, False)]


def test_a_missing_tap_module_fails_visibly(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "openmeet_py.audio.system_tap_mac", None)
    backend = MacBackend()
    with pytest.raises(audio_backend.BackendError, match="System audio capture is not available"):
        backend.output_devices()
    with pytest.raises(audio_backend.BackendError):
        backend.open_stream(
            audio_backend.DeviceInfo(SYSTEM_DEVICE_ID, SYSTEM_DEVICE_NAME, 0, 48000, 2), lambda *_: None
        )


# ---- recorder wording --------------------------------------------------------


def test_the_missing_microphone_message_is_platform_aware(monkeypatch: pytest.MonkeyPatch) -> None:
    # The Windows text mentions remote microphone redirection, which is a Windows feature.
    monkeypatch.setattr(sys, "platform", "darwin")
    assert "System Settings" in recorder._mic_missing()
    monkeypatch.setattr(sys, "platform", "win32")
    assert recorder._mic_missing() == recorder.MIC_MISSING
