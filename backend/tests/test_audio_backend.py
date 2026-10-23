"""Backend selection, stable device ids and the no-real-audio guard. No device is touched."""

from __future__ import annotations

import pytest

from openmeet_py.audio.audio_backend import (
    OUTPUT_SUFFIX,
    BackendError,
    FakeBackend,
    PortAudioBackend,
    _label,
    _with_stable_ids,
    make_backend,
)


def test_real_audio_library_cannot_be_imported_outside_hardware_tests() -> None:
    # conftest blocks pyaudiowpatch for every test that is not marked hardware. If this import
    # ever succeeds here, the guard has been removed and tests could open real devices.
    with pytest.raises(ImportError):
        import pyaudiowpatch  # noqa: F401


def test_port_audio_backend_reports_unsupported_and_fails_cleanly_without_the_library() -> None:
    backend = PortAudioBackend()  # construction imports nothing
    assert backend.supported() is False
    with pytest.raises(BackendError):
        backend.input_devices()
    with pytest.raises(BackendError):
        backend.output_devices()


def test_backend_is_fake_only_when_the_environment_asks(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENMEET_PY_FAKE_AUDIO", "1")
    assert isinstance(make_backend(), FakeBackend)
    monkeypatch.delenv("OPENMEET_PY_FAKE_AUDIO")
    assert isinstance(make_backend(), PortAudioBackend)
    monkeypatch.setenv("OPENMEET_PY_FAKE_AUDIO", "yes")
    assert isinstance(make_backend(), PortAudioBackend)


def test_output_labels_say_that_playback_is_included() -> None:
    assert _label("Speakers (Realtek) [Loopback]") == "Speakers (Realtek)" + OUTPUT_SUFFIX
    assert OUTPUT_SUFFIX == " (all audio, includes OpenMeet playback)"


def test_device_ids_come_from_the_name_and_use_the_index_only_for_duplicates() -> None:
    devices = _with_stable_ids(
        "mic",
        [
            ("USB Mic", 0, "USB Mic", 48000, 1),
            ("USB Mic", 4, "USB Mic", 48000, 1),
            ("Built-in", 2, "Built-in", 44100, 2),
        ],
    )
    assert [d.id for d in devices] == ["mic:USB Mic#0", "mic:USB Mic#4", "mic:Built-in"]
    assert devices[2].index == 2 and devices[2].rate == 44100


def test_fake_backend_lists_its_two_synthetic_devices_only() -> None:
    backend = FakeBackend(auto_pump=False)
    assert [d.id for d in backend.input_devices()] == ["fake-mic"]
    assert [d.id for d in backend.output_devices()] == ["fake-output"]
    assert backend.output_devices()[0].name.endswith(OUTPUT_SUFFIX)
    backend.missing.add("fake-mic")
    assert backend.input_devices() == []
