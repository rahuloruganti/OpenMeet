"""System audio tap: unavailable reasons, format conversion, stop ordering and error reporting.

catap exists only on a Mac, so every test fakes the module in sys.modules. Nothing here opens a
device or touches Core Audio.
"""

from __future__ import annotations

import platform
import sys
import threading
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
        stop_errors: Optional[list[Exception]] = None,
        close_errors: Optional[list[Exception]] = None,
    ) -> None:
        self.on_buffer = on_buffer
        self.start_error = start_error
        self.stream_format = stream_format
        self.capture_failed = capture_failed
        self.during_stop = during_stop
        self.stop_errors = list(stop_errors or [])
        self.close_errors = list(close_errors or [])
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
        if self.stop_errors:
            raise self.stop_errors.pop(0)
        if not self.is_recording:
            raise RuntimeError("Not recording")
        self.is_recording = False
        if self.during_stop is not None:
            self.on_buffer(self.during_stop)  # catap still delivers queued buffers during shutdown

    def close(self) -> None:
        self.calls.append("close")
        if self.close_errors:
            raise self.close_errors.pop(0)
        self.is_recording = False
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


def test_system_audio_is_unavailable_off_a_mac(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
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


@pytest.mark.parametrize("version", ["", "14", "unknown", "14.x"])
def test_an_unreadable_macos_version_is_not_trusted(
    monkeypatch: pytest.MonkeyPatch, install: Callable[..., FakeCatap], version: str
) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    install()
    monkeypatch.setattr(platform, "mac_ver", lambda: (version, ("", "", ""), ""))
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
    # One output frame waits for the next buffer rather than inventing a boundary sample.
    assert received[0][1] == 479
    assert len(np.frombuffer(received[0][0], dtype="<f4")) == 479 * 2
    stream.deliver(FakeBuffer(_f32(*([0.5] * 441)), 441, fmt))
    assert [frames for _, frames in received] == [479, 480]


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
    assert received == [479]  # the final interpolation needs the next input frame


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


def test_resampling_many_buffers_has_no_frame_rounding_drift(
    darwin: None, install: Callable[..., FakeCatap]
) -> None:
    install()
    received: list[int] = []
    stream = system_tap_mac.open_tap(lambda data, frames, gap: received.append(frames))
    buffer = FakeBuffer(np.zeros((1024, 2), dtype="<f4").tobytes(), 1024, FakeFormat(sample_rate=44100))
    for _ in range(1000):
        stream.deliver(buffer)
    stream.stop()
    assert abs(sum(received) - 1000 * 1024 * 48000 / 44100) <= 1


@pytest.mark.parametrize("rate", [32000, 44100, 96000])
@pytest.mark.parametrize("chunk_size", [1, 7, 257, 1024])
def test_resampling_is_independent_of_buffer_boundaries(
    darwin: None, install: Callable[..., FakeCatap], rate: int, chunk_size: int
) -> None:
    install()
    positions = np.arange(2051, dtype=np.float32)
    signal = np.stack((np.sin(positions / 11), np.cos(positions / 17)), axis=1).astype("<f4")
    fmt = FakeFormat(sample_rate=rate)

    def capture(size: int) -> np.ndarray:
        received: list[bytes] = []
        stream = system_tap_mac.open_tap(lambda data, frames, gap: received.append(data))
        for start in range(0, len(signal), size):
            block = signal[start:start + size]
            stream.deliver(FakeBuffer(block.tobytes(), len(block), fmt))
            stream.deliver(FakeBuffer(b"", 0, fmt))
        stream.stop()
        return np.frombuffer(b"".join(received), dtype="<f4").reshape(-1, 2)

    whole = capture(len(signal))
    split = capture(chunk_size)
    np.testing.assert_array_equal(split, whole)
    output_positions = np.arange(len(whole)) * rate / 48000
    expected = np.stack(
        [np.interp(output_positions, positions, signal[:, channel]) for channel in range(2)], axis=1
    )
    np.testing.assert_allclose(whole, expected, atol=1e-7, rtol=1e-6)


def test_adopting_the_started_format_keeps_an_active_resampler_phase() -> None:
    received: list[int] = []
    stream = system_tap_mac.TapStream(lambda data, frames, gap: received.append(frames))
    fmt = FakeFormat(sample_rate=44100)
    buffer = FakeBuffer(np.zeros((441, 2), dtype="<f4").tobytes(), 441, fmt)
    # catap's worker can deliver before start returns and open_tap adopts stream_format.
    stream.deliver(buffer)
    stream.adopt(fmt)
    stream.deliver(buffer)
    assert received == [479, 480]


@pytest.mark.parametrize("failed_method", ["stop", "close"])
def test_failed_teardown_is_reported_and_retried(
    darwin: None, install: Callable[..., FakeCatap], failed_method: str
) -> None:
    stream, module = _installed(install, **{f"{failed_method}_errors": [OSError("busy")]})
    assert module.session is not None
    stream.stop()
    assert stream.error() == "OpenMeet could not finish stopping system audio. Try stopping again."
    calls = list(module.session.calls)
    stream.stop()
    assert len(module.session.calls) > len(calls)
    assert module.session.calls[-1] == "close"
    assert stream.error() is None
    calls = list(module.session.calls)
    stream.stop()
    assert module.session.calls == calls


def test_teardown_keeps_retrying_until_both_operations_succeed(
    darwin: None, install: Callable[..., FakeCatap]
) -> None:
    stream, module = _installed(
        install,
        stop_errors=[OSError("busy"), RuntimeError("still busy")],
        close_errors=[RuntimeError("busy"), OSError("still busy")],
    )
    assert module.session is not None
    for _ in range(2):
        stream.stop()
        assert stream.error() == "OpenMeet could not finish stopping system audio. Try stopping again."
    stream.stop()
    assert module.session.calls == ["start", "stop", "close", "stop", "close", "stop", "close"]
    assert stream.error() is None


def test_failed_teardown_still_waits_for_an_inflight_callback(
    darwin: None, install: Callable[..., FakeCatap], monkeypatch: pytest.MonkeyPatch
) -> None:
    module = install(stop_errors=[OSError("busy")])
    callback_entered = threading.Event()
    release_callback = threading.Event()
    close_attempted = threading.Event()
    stopped = threading.Event()

    def on_audio(data: bytes, frames: int, gap: bool) -> None:
        callback_entered.set()
        assert release_callback.wait(5)

    stream = system_tap_mac.open_tap(on_audio)
    assert module.session is not None

    def fail_close() -> None:
        close_attempted.set()
        raise RuntimeError("busy")

    monkeypatch.setattr(module.session, "close", fail_close)
    buffer = FakeBuffer(_f32(0.5, 0.5), 1, FakeFormat())
    producer = threading.Thread(target=stream.deliver, args=(buffer,))

    def stop() -> None:
        stream.stop()
        stopped.set()

    stopper = threading.Thread(target=stop)
    producer.start()
    try:
        assert callback_entered.wait(5)
        stopper.start()
        assert close_attempted.wait(5)
        assert not stopped.wait(0.05)
    finally:
        release_callback.set()
        producer.join(5)
        if stopper.ident is not None:
            stopper.join(5)
    assert not producer.is_alive() and not stopper.is_alive()
    assert stopped.is_set()
    assert stream.error() is not None
    callback_entered.clear()
    stream.deliver(buffer)
    assert not callback_entered.is_set()


def test_concurrent_stop_calls_wait_for_the_same_cleanup(
    darwin: None, install: Callable[..., FakeCatap], monkeypatch: pytest.MonkeyPatch
) -> None:
    stream, module = _installed(install)
    assert module.session is not None
    stop_entered = threading.Event()
    release_stop = threading.Event()
    second_entered = threading.Event()
    second_finished = threading.Event()
    original_stop = module.session.stop

    def blocked_stop() -> None:
        stop_entered.set()
        assert release_stop.wait(5)
        original_stop()

    monkeypatch.setattr(module.session, "stop", blocked_stop)
    first = threading.Thread(target=stream.stop)

    def second_stop() -> None:
        second_entered.set()
        stream.stop()
        second_finished.set()

    second = threading.Thread(target=second_stop)
    first.start()
    try:
        assert stop_entered.wait(5)
        second.start()
        assert second_entered.wait(5)
        assert not second_finished.wait(0.05)
    finally:
        release_stop.set()
        first.join(5)
        if second.ident is not None:
            second.join(5)
    assert not first.is_alive() and not second.is_alive()
    assert second_finished.is_set()
    assert module.session.calls == ["start", "stop", "close"]
