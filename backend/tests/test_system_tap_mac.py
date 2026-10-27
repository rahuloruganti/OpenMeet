"""System audio tap: unavailable reasons, format conversion, stop ordering and error reporting.

catap exists only on a Mac, so every test fakes the module in sys.modules. Nothing here opens a
device or touches Core Audio.
"""

from __future__ import annotations

import platform
import sys
from dataclasses import dataclass
from typing import Any, Callable, Optional

import numpy as np
import pytest

from openmeet_py.audio import system_tap_mac
from openmeet_py.audio.audio_backend import BackendError


@dataclass
class FakeFormat:
    sample_rate: float = 48000.0
    num_channels: int = 2
    bits_per_sample: int = 32
    sample_type: str = "float"


@dataclass
class FakeBuffer:
    data: bytes
    frame_count: int
    format: FakeFormat


class FakeSession:
    """Records the call order. start can fail the way a refused tap does."""

    def __init__(
        self,
        on_buffer: Callable[[FakeBuffer], None],
        start_error: Optional[BaseException] = None,
        capture_failed: bool = False,
        stream_format: Optional[FakeFormat] = None,
        during_stop: Optional[FakeBuffer] = None,
    ) -> None:
        self.on_buffer = on_buffer
        self.start_error = start_error
        self.stream_format = stream_format
        self.capture_failed = capture_failed
        self.during_stop = during_stop
        self.is_recording = False
        self.needs_cleanup = False
        self.calls: list[str] = []

    def start(self) -> None:
        self.calls.append("start")
        if self.start_error is not None:
            raise self.start_error
        self.is_recording = True

    def stop(self) -> None:
        self.calls.append("stop")
        if not self.is_recording:
            raise RuntimeError("Not recording")
        self.is_recording = False
        if self.during_stop is not None:
            self.on_buffer(self.during_stop)  # catap still delivers queued buffers during shutdown

    def close(self) -> None:
        self.calls.append("close")
        self.needs_cleanup = False


class FakeCatap:
    """Stands in for the catap module: one session, no Core Audio."""

    def __init__(self, create_error: Optional[BaseException] = None, **session_options: Any) -> None:
        self.create_error = create_error
        self.session_options = session_options
        self.kwargs: dict[str, Any] = {}
        self.session: Optional[FakeSession] = None

    def record_system_audio(self, **kwargs: Any) -> FakeSession:
        self.kwargs = kwargs
        if self.create_error is not None:
            raise self.create_error
        self.session = FakeSession(on_buffer=kwargs["on_buffer"], **self.session_options)
        return self.session


@pytest.fixture
def darwin(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(platform, "mac_ver", lambda: ("14.5.0", ("", "", ""), ""))


@pytest.fixture
def install(monkeypatch: pytest.MonkeyPatch) -> Callable[..., FakeCatap]:
    def build(**options: Any) -> FakeCatap:
        module = FakeCatap(**options)
        monkeypatch.setitem(sys.modules, "catap", module)
        return module

    return build


def _f32(*values: float) -> bytes:
    return np.asarray(values, dtype="<f4").tobytes()


def _open(monkeypatch: pytest.MonkeyPatch, **options: Any) -> tuple[system_tap_mac.TapStream, FakeCatap]:
    module = FakeCatap(**options)
    monkeypatch.setitem(sys.modules, "catap", module)
    return system_tap_mac.open_tap(lambda *_: None), module


def _installed(
    install: Callable[..., FakeCatap], **options: Any
) -> tuple[system_tap_mac.TapStream, FakeCatap]:
    module = install(**options)
    return system_tap_mac.open_tap(lambda *_: None), module


def test_system_audio_is_unavailable_off_a_mac() -> None:
    assert system_tap_mac.tap_unavailable_reason() == system_tap_mac.NOT_MAC
    with pytest.raises(BackendError) as raised:
        system_tap_mac.open_tap(lambda *_: None)
    assert raised.value.message == system_tap_mac.NOT_MAC


def test_system_audio_needs_macos_14_2(
    monkeypatch: pytest.MonkeyPatch, install: Callable[..., FakeCatap]
) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    install()
    monkeypatch.setattr(platform, "mac_ver", lambda: ("14.1.9", ("", "", ""), ""))
    assert system_tap_mac.tap_unavailable_reason() == system_tap_mac.OLD_MACOS
    monkeypatch.setattr(platform, "mac_ver", lambda: ("14.2", ("", "", ""), ""))
    assert system_tap_mac.tap_unavailable_reason() is None


def test_an_unreadable_macos_version_is_not_trusted(
    monkeypatch: pytest.MonkeyPatch, install: Callable[..., FakeCatap]
) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    install()
    monkeypatch.setattr(platform, "mac_ver", lambda: ("", ("", "", ""), ""))
    assert system_tap_mac.tap_unavailable_reason() == system_tap_mac.OLD_MACOS


def test_a_build_without_catap_says_so(darwin: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "catap", None)  # makes `import catap` raise ImportError
    assert system_tap_mac.tap_unavailable_reason() == system_tap_mac.NO_CATAP


def test_a_mac_with_catap_can_capture_system_audio(
    darwin: None, install: Callable[..., FakeCatap]
) -> None:
    install()
    assert system_tap_mac.tap_unavailable_reason() is None


def test_default_format_fits_the_recorder_limits() -> None:
    rate, channels = system_tap_mac.default_format()
    assert (rate, channels) == (48000, 2)
    assert 1 <= channels <= 8 and 8000 <= rate <= 192000


def test_the_tap_is_unmuted_private_and_live(monkeypatch: pytest.MonkeyPatch, darwin: None) -> None:
    stream, module = _open(monkeypatch)
    assert module.kwargs["mute"] is False  # passthrough: the user still hears the audio
    assert module.kwargs["mono"] is False
    assert module.kwargs["visible"] is False
    assert module.kwargs["on_buffer"] == stream.deliver
    assert module.kwargs["max_pending_buffers"] == system_tap_mac.PENDING_BUFFERS
    assert "output_path" not in module.kwargs  # streaming only, no WAV of its own
    assert module.session is not None and module.session.calls == ["start"]


def test_denied_permission_raises_a_short_message_after_teardown(
    monkeypatch: pytest.MonkeyPatch, darwin: None
) -> None:
    module = FakeCatap(start_error=PermissionError("not authorized"))
    monkeypatch.setitem(sys.modules, "catap", module)
    with pytest.raises(BackendError) as raised:
        system_tap_mac.open_tap(lambda *_: None)
    assert raised.value.message == system_tap_mac.DENIED
    assert module.session is not None
    assert "close" in module.session.calls


def test_a_tap_that_cannot_be_created_raises_the_same_message(
    monkeypatch: pytest.MonkeyPatch, darwin: None
) -> None:
    module = FakeCatap(create_error=OSError("kAudioHardwareIllegalOperationError"))
    monkeypatch.setitem(sys.modules, "catap", module)
    with pytest.raises(BackendError) as raised:
        system_tap_mac.open_tap(lambda *_: None)
    assert raised.value.message == system_tap_mac.DENIED


def test_float32_stereo_reaches_the_recorder_unchanged(darwin: None, install: Callable[..., FakeCatap]) -> None:
    install()
    received: list[tuple[bytes, int, bool]] = []
    stream = system_tap_mac.open_tap(lambda data, frames, gap: received.append((data, frames, gap)))
    samples = _f32(0.1, -0.2, 0.3, -0.4)
    stream.deliver(FakeBuffer(samples, 2, FakeFormat()))
    assert received == [(samples, 2, False)]  # gap stays False: catap fails instead of dropping


def test_integer_pcm_is_scaled_to_float32(darwin: None, install: Callable[..., FakeCatap]) -> None:
    install()
    received: list[bytes] = []
    stream = system_tap_mac.open_tap(lambda data, frames, gap: received.append(data))
    fmt = FakeFormat(bits_per_sample=16, sample_type="signed_integer")
    stream.deliver(FakeBuffer(np.asarray([16384, -32768], dtype="<i2").tobytes(), 1, fmt))
    assert np.frombuffer(received[0], dtype="<f4").tolist() == [0.5, -1.0]


def test_float64_pcm_is_narrowed_to_float32(darwin: None, install: Callable[..., FakeCatap]) -> None:
    install()
    received: list[bytes] = []
    stream = system_tap_mac.open_tap(lambda data, frames, gap: received.append(data))
    fmt = FakeFormat(bits_per_sample=64)
    stream.deliver(FakeBuffer(np.asarray([0.25, -0.75], dtype="<f8").tobytes(), 1, fmt))
    assert np.frombuffer(received[0], dtype="<f4").tolist() == [0.25, -0.75]


def test_mono_is_duplicated_into_both_channels(darwin: None, install: Callable[..., FakeCatap]) -> None:
    install()
    received: list[bytes] = []
    stream = system_tap_mac.open_tap(lambda data, frames, gap: received.append(data))
    fmt = FakeFormat(num_channels=1)
    stream.deliver(FakeBuffer(_f32(0.5, -0.5), 2, fmt))
    assert np.frombuffer(received[0], dtype="<f4").tolist() == [0.5, 0.5, -0.5, -0.5]


def test_more_than_two_channels_are_averaged_into_left_and_right(
    darwin: None, install: Callable[..., FakeCatap]
) -> None:
    install()
    received: list[bytes] = []
    stream = system_tap_mac.open_tap(lambda data, frames, gap: received.append(data))
    stream.deliver(FakeBuffer(_f32(0.2, 0.4, 0.6, 0.8), 1, FakeFormat(num_channels=4)))
    assert np.frombuffer(received[0], dtype="<f4").tolist() == pytest.approx([0.4, 0.6])


def test_a_44_1k_tap_is_resampled_to_the_advertised_rate(
    darwin: None, install: Callable[..., FakeCatap]
) -> None:
    install()
    received: list[tuple[bytes, int]] = []
    stream = system_tap_mac.open_tap(lambda data, frames, gap: received.append((data, frames)))
    fmt = FakeFormat(sample_rate=44100.0, num_channels=1)
    stream.deliver(FakeBuffer(_f32(*([0.5] * 441)), 441, fmt))
    assert received[0][1] == 480  # one 10 ms block at 48 kHz
    assert len(np.frombuffer(received[0][0], dtype="<f4")) == 480 * 2


def test_a_partial_trailing_frame_is_dropped(darwin: None, install: Callable[..., FakeCatap]) -> None:
    install()
    received: list[tuple[bytes, int]] = []
    stream = system_tap_mac.open_tap(lambda data, frames, gap: received.append((data, frames)))
    # Ten bytes hold one float32 stereo frame and a stray half frame.
    stream.deliver(FakeBuffer(np.zeros(10, dtype=np.uint8).tobytes(), 2, FakeFormat()))
    assert received[0][1] == 1
    assert len(np.frombuffer(received[0][0], dtype="<f4")) == 2


def test_an_unsupported_format_fails_at_open_and_tears_down(
    monkeypatch: pytest.MonkeyPatch, darwin: None
) -> None:
    fmt = FakeFormat(bits_per_sample=24, sample_type="signed_integer")
    module = FakeCatap(stream_format=fmt)
    monkeypatch.setitem(sys.modules, "catap", module)
    with pytest.raises(BackendError) as raised:
        system_tap_mac.open_tap(lambda *_: None)
    assert raised.value.message == system_tap_mac.UNSUPPORTED_FORMAT
    assert module.session is not None and module.session.calls[-1] == "close"


def test_a_format_that_arrives_late_is_reported_through_error(
    darwin: None, install: Callable[..., FakeCatap]
) -> None:
    install()
    heard: list[bytes] = []
    stream = system_tap_mac.open_tap(lambda data, frames, gap: heard.append(data))
    stream.deliver(FakeBuffer(b"\x00\x01", 1, FakeFormat(bits_per_sample=8, sample_type="signed_integer")))
    assert heard == []
    assert stream.error() == system_tap_mac.UNSUPPORTED_FORMAT


def test_the_reported_format_is_used_before_the_first_buffer(
    darwin: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = FakeCatap(stream_format=FakeFormat(sample_rate=44100.0, num_channels=1))
    monkeypatch.setitem(sys.modules, "catap", module)
    received: list[int] = []
    stream = system_tap_mac.open_tap(lambda data, frames, gap: received.append(frames))
    stream.deliver(FakeBuffer(_f32(*([0.0] * 441)), 441, FakeFormat()))
    assert received == [480]


def test_a_failing_recorder_callback_is_reported_not_raised(
    darwin: None, install: Callable[..., FakeCatap]
) -> None:
    install()

    def on_audio(data: bytes, frames: int, gap: bool) -> None:
        raise RuntimeError("recorder queue is gone")

    stream = system_tap_mac.open_tap(on_audio)
    stream.deliver(FakeBuffer(_f32(0.0, 0.0), 1, FakeFormat()))  # must not propagate
    assert stream.error() == system_tap_mac.STREAM_STOPPED


def test_stop_tears_down_in_order_and_silences_the_tap(
    darwin: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    buffer = FakeBuffer(_f32(0.5, 0.5), 1, FakeFormat())
    module = FakeCatap(during_stop=buffer)
    monkeypatch.setitem(sys.modules, "catap", module)
    heard: list[bytes] = []
    stream = system_tap_mac.open_tap(lambda data, frames, gap: heard.append(data))
    assert module.session is not None
    stream.stop()
    assert module.session.calls == ["start", "stop", "close"]
    assert heard == []  # a buffer delivered while stopping is not handed to the recorder
    assert stream.error() is None
    stream.stop()  # idempotent: no second teardown, nothing raised
    assert module.session.calls == ["start", "stop", "close"]


def test_stop_after_the_tap_died_by_itself_skips_the_recorder_stop(
    darwin: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = FakeCatap()
    monkeypatch.setitem(sys.modules, "catap", module)
    stream = system_tap_mac.open_tap(lambda *_: None)
    assert module.session is not None
    module.session.is_recording = False  # capture failed on its own; stop() would raise Not recording
    stream.stop()
    assert module.session.calls == ["start", "close"]


def test_error_reports_a_capture_that_failed(darwin: None, install: Callable[..., FakeCatap]) -> None:
    stream, module = _installed(install)
    assert stream.error() is None
    assert module.session is not None
    module.session.capture_failed = True  # catap saw the tap or its format go away
    assert stream.error() == system_tap_mac.STOPPED


def test_error_reports_a_stream_that_stopped(darwin: None, install: Callable[..., FakeCatap]) -> None:
    stream, module = _installed(install)
    assert module.session is not None
    module.session.is_recording = False
    assert stream.error() == system_tap_mac.STREAM_STOPPED


def test_the_tap_stays_usable_after_a_few_empty_buffers(
    darwin: None, install: Callable[..., FakeCatap]
) -> None:
    install()
    received: list[int] = []
    stream = system_tap_mac.open_tap(lambda data, frames, gap: received.append(frames))
    stream.deliver(FakeBuffer(b"", 0, FakeFormat()))
    stream.deliver(FakeBuffer(_f32(0.0, 0.0), 1, FakeFormat()))
    assert received == [1]
    assert stream.error() is None
