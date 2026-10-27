"""macOS meeting detection: Core Audio process objects, read through fakes.

There is no Mac here, so CoreAudio.framework and the Core Foundation string reader are stand-ins
passed to `MacConsentRegistry`. These tests cover the id mapping, the in-use rule, own-app skipping,
the platform gates and the prompt rule `DetectionService` applies to any registry.
"""

from __future__ import annotations

import ctypes
import os
import sys
from typing import Any, Optional

import pytest

from openmeet_py.platform import detection, detection_mac
from openmeet_py.platform.detection import ConsentEntry, Debounce, active_apps, in_use, observed_apps
from openmeet_py.platform.detection_mac import MacConsentRegistry, PropertyAddress

ZOOM = "us.zoom.xos"
SAFARI = "com.apple.Safari"
ZOOM_OBJECT, SAFARI_OBJECT = 11, 12


def _fourcc(text: str) -> int:
    return int.from_bytes(text.encode("ascii"), "big")


def _read_address(address: Any) -> PropertyAddress:
    return ctypes.cast(address, ctypes.POINTER(PropertyAddress)).contents


def _write(out: Any, value_type: Any, value: Any) -> None:
    ctypes.cast(out, ctypes.POINTER(value_type))[0] = value


class FakeLibrary:
    """CoreAudio.framework stand-in: a fixed process list and one dictionary per process object."""

    def __init__(self, processes: list[dict[str, Any]], errors: Optional[dict[int, int]] = None):
        self.processes = processes
        self.by_object = {process["object_id"]: process for process in processes}
        self.errors = errors or {}
        self.reads: list[tuple[int, int, int, int]] = []

    def _record(self, object_id: int, address: Any) -> tuple[int, int]:
        host = _read_address(address)
        self.reads.append((object_id, host.selector, host.scope, host.element))
        return host.selector, self.errors.get(host.selector, 0)

    def AudioObjectGetPropertyDataSize(self, object_id, address, qualifier_size, qualifier, out_size):
        selector, status = self._record(object_id, address)
        if status:
            return status
        assert (object_id, selector) == (1, detection_mac.SELECTOR_PROCESS_LIST)
        _write(out_size, ctypes.c_uint32, 4 * len(self.processes))
        return 0

    def AudioObjectGetPropertyData(self, object_id, address, qualifier_size, qualifier, size, out):
        selector, status = self._record(object_id, address)
        if status:
            return status
        if selector == detection_mac.SELECTOR_PROCESS_LIST:
            assert object_id == 1
            _write(size, ctypes.c_uint32, 4 * len(self.processes))
            target = ctypes.cast(out, ctypes.POINTER(ctypes.c_uint32))
            for index, process in enumerate(self.processes):
                target[index] = process["object_id"]
            return 0
        process = self.by_object[object_id]
        if selector == detection_mac.SELECTOR_PID:
            _write(out, ctypes.c_uint32, process["pid"])
        elif selector == detection_mac.SELECTOR_BUNDLE_ID:
            _write(size, ctypes.c_uint32, 8)
            _write(out, ctypes.c_void_p, process.get("bundle") or 0)
        elif selector == detection_mac.SELECTOR_RUNNING_INPUT:
            _write(out, ctypes.c_uint32, process.get("running_input", 0))
        else:
            raise AssertionError(f"unexpected selector {selector:#x}")
        return 0


class FakeStrings:
    """Core Foundation string reader stand-in: a reference token to bundle id table."""

    def __init__(self, strings: dict[int, str]):
        self.strings = strings
        self.read: list[int] = []

    def __call__(self, reference: Any) -> Optional[str]:
        token = reference.value if isinstance(reference, ctypes.c_void_p) else reference
        value = int(token or 0)
        self.read.append(value)
        return self.strings.get(value)


def capturing() -> dict[str, Any]:
    return {"object_id": ZOOM_OBJECT, "pid": 700, "bundle": 1, "running_input": 1}


def idle() -> dict[str, Any]:
    return {"object_id": SAFARI_OBJECT, "pid": 701, "bundle": 2, "running_input": 0}


class Harness:
    def __init__(self, processes: list[dict[str, Any]], strings: dict[int, str], errors: Optional[dict[int, int]] = None):
        self.library = FakeLibrary(processes, errors)
        self.strings = FakeStrings(strings)
        self.registry = MacConsentRegistry(lib=self.library, read_string=self.strings)


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch) -> Harness:
    monkeypatch.setattr(sys, "platform", "darwin")
    return Harness([capturing(), idle()], {1: ZOOM, 2: SAFARI})


# ---- the documented constants -------------------------------------------------


def test_the_selectors_are_the_fourccs_from_the_sdk_header() -> None:
    assert detection_mac.SYSTEM_OBJECT == 1  # kAudioObjectSystemObject
    assert detection_mac.SCOPE_GLOBAL == _fourcc("glob")
    assert detection_mac.ELEMENT_MAIN == 0  # kAudioObjectPropertyElementMain
    assert detection_mac.SELECTOR_PROCESS_LIST == _fourcc("prs#")
    assert detection_mac.SELECTOR_PID == _fourcc("ppid")
    assert detection_mac.SELECTOR_BUNDLE_ID == _fourcc("pbid")
    assert detection_mac.SELECTOR_RUNNING_INPUT == _fourcc("piri")
    assert detection_mac.UTF8 == 0x08000100  # kCFStringEncodingUTF8


def test_the_process_list_is_read_from_the_system_object_in_the_global_scope(harness: Harness) -> None:
    harness.registry.entries()
    assert harness.library.reads[0] == (
        detection_mac.SYSTEM_OBJECT,
        detection_mac.SELECTOR_PROCESS_LIST,
        detection_mac.SCOPE_GLOBAL,
        detection_mac.ELEMENT_MAIN,
    )


# ---- which app holds the microphone -------------------------------------------


def test_one_capturing_and_one_idle_process_become_two_consent_entries(harness: Harness) -> None:
    entries = harness.registry.entries()
    assert [entry.name for entry in entries] == [ZOOM, SAFARI]
    by_name = {entry.name: entry for entry in entries}
    assert in_use(by_name[ZOOM].last_used_start, by_name[ZOOM].last_used_stop)
    assert not in_use(by_name[SAFARI].last_used_start, by_name[SAFARI].last_used_stop)


def test_only_the_capturing_app_is_offered_a_recording_prompt(harness: Harness) -> None:
    entries = harness.registry.entries()
    assert active_apps(entries, detection_mac.OWN_BUNDLE_ID) == {ZOOM: "Zoom"}
    assert observed_apps(entries, detection_mac.OWN_BUNDLE_ID) == {ZOOM: ("Zoom", True), SAFARI: ("Safari", False)}


def test_the_entries_drive_the_same_two_poll_prompt_rule(harness: Harness) -> None:
    entries = harness.registry.entries()
    debounce = Debounce()
    assert debounce.update(set(active_apps(entries, detection_mac.OWN_BUNDLE_ID))) == []
    assert debounce.update(set(active_apps(entries, detection_mac.OWN_BUNDLE_ID))) == [ZOOM]


def test_a_released_microphone_reads_as_idle(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    released = capturing()
    released["running_input"] = 0
    harness = Harness([released], {1: ZOOM})
    assert active_apps(harness.registry.entries(), detection_mac.OWN_BUNDLE_ID) == {}


# ---- this app ------------------------------------------------------------------


def test_this_app_is_never_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    ours = {"object_id": 21, "pid": 800, "bundle": 3, "running_input": 1}
    harness = Harness([ours, capturing()], {1: ZOOM, 3: detection_mac.OWN_BUNDLE_ID})
    entries = harness.registry.entries()
    assert [entry.name for entry in entries] == [detection_mac.OWN_BUNDLE_ID, ZOOM]
    assert active_apps(entries, detection_mac.OWN_BUNDLE_ID) == {ZOOM: "Zoom"}
    assert detection_mac.OWN_BUNDLE_ID not in observed_apps(entries, detection_mac.OWN_BUNDLE_ID)


def test_this_process_is_skipped_by_pid_even_without_a_bundle_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    ours = {"object_id": 22, "pid": os.getpid(), "bundle": 0, "running_input": 1}
    harness = Harness([ours, capturing()], {1: ZOOM})
    assert [entry.name for entry in harness.registry.entries()] == [ZOOM]


# ---- unreadable and missing properties ----------------------------------------


def test_a_process_without_a_bundle_id_is_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    bare = {"object_id": 31, "pid": 900, "bundle": 0, "running_input": 1}
    unknown = {"object_id": 32, "pid": 901, "bundle": 9, "running_input": 1}
    harness = Harness([bare, unknown, capturing()], {1: ZOOM})
    assert [entry.name for entry in harness.registry.entries()] == [ZOOM]


def test_a_process_whose_bundle_id_read_fails_is_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    harness = Harness([capturing(), idle()], {1: ZOOM, 2: SAFARI}, {detection_mac.SELECTOR_BUNDLE_ID: 1852797029})
    assert harness.registry.entries() == []


def test_an_unreadable_input_state_counts_as_in_use(monkeypatch: pytest.MonkeyPatch) -> None:
    """A read error must not look like a hang-up, or an automatic capture would stop mid-meeting."""
    monkeypatch.setattr(sys, "platform", "darwin")
    harness = Harness([idle()], {2: SAFARI}, {detection_mac.SELECTOR_RUNNING_INPUT: 1852797029})
    entries = harness.registry.entries()
    assert [entry.name for entry in entries] == [SAFARI]
    assert in_use(entries[0].last_used_start, entries[0].last_used_stop)


def test_a_process_whose_pid_cannot_be_read_is_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    harness = Harness([capturing()], {1: ZOOM}, {detection_mac.SELECTOR_PID: 1852797029})
    assert harness.registry.entries() == []


def test_a_failed_process_list_is_raised_rather_than_read_as_no_apps(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    harness = Harness([capturing()], {1: ZOOM}, {detection_mac.SELECTOR_PROCESS_LIST: 1970171760})
    with pytest.raises(RuntimeError):
        harness.registry.entries()


def test_other_platforms_never_load_the_framework(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    assert MacConsentRegistry().entries() == []


# ---- names ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("bundle_id", "expected"),
    [
        (ZOOM, "Zoom"),
        (SAFARI, "Safari"),
        ("com.google.Chrome.helper", "Chrome"),
        ("com.apple.WebKit.GPU", "WebKit"),
        ("com.microsoft.teams2", "Teams2"),
        (detection_mac.OWN_BUNDLE_ID, "Openmeet"),
        ("Solo", "Solo"),
    ],
)
def test_bundle_ids_become_short_names(bundle_id: str, expected: str) -> None:
    assert detection_mac.display_name(bundle_id) == expected


# ---- Core Foundation strings ---------------------------------------------------


class FakeFoundation:
    def __init__(self, text: str):
        self.text = text
        self.encodings: list[int] = []
        self.released: list[Any] = []

    def CFStringGetLength(self, reference: Any) -> int:
        return len(self.text)

    def CFStringGetMaximumSizeForEncoding(self, length: int, encoding: int) -> int:
        self.encodings.append(encoding)
        return length * 4 + 8

    def CFStringGetCString(self, reference: Any, buffer: Any, capacity: int, encoding: int) -> bool:
        encoded = self.text.encode("utf-8")
        if capacity < len(encoded) + 1:
            return False
        buffer.value = encoded
        return True

    def CFRelease(self, reference: Any) -> None:
        self.released.append(reference)


def test_the_core_foundation_reader_copies_the_string_in_utf8_and_releases_it() -> None:
    foundation = FakeFoundation(ZOOM)
    reference = ctypes.c_void_p(0xABCD)
    assert detection_mac._core_foundation_reader(foundation)(reference) == ZOOM
    assert foundation.encodings == [detection_mac.UTF8]
    assert foundation.released == [reference]


def test_the_core_foundation_reader_releases_even_when_the_copy_fails() -> None:
    foundation = FakeFoundation(ZOOM)
    reference = ctypes.c_void_p(0x1)
    foundation.CFStringGetMaximumSizeForEncoding = lambda length, encoding: 0  # type: ignore[method-assign]
    assert detection_mac._core_foundation_reader(foundation)(reference) is None
    assert foundation.released == [reference]


# ---- platform gates and the dispatcher in detection.py -------------------------


def _mac_ver(version: str) -> Any:
    return lambda: (version, ("", "", ""), "arm64")


def test_detection_needs_macos_14_2(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(detection_mac.platform, "mac_ver", _mac_ver("14.1.2"))
    assert detection_mac.supported() is False
    monkeypatch.setattr(detection_mac.platform, "mac_ver", _mac_ver("14.2"))
    assert detection_mac.supported() is True
    monkeypatch.setattr(detection_mac.platform, "mac_ver", _mac_ver("15.0.1"))
    assert detection_mac.supported() is True


def test_detection_is_not_supported_off_macos(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(detection_mac.platform, "mac_ver", _mac_ver("15.0.1"))
    assert detection_mac.supported() is False


def test_the_macos_registry_is_chosen_on_darwin(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    monkeypatch.delenv("OPENMEET_PY_FAKE_DETECTION", raising=False)
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(detection_mac.platform, "mac_ver", _mac_ver("14.2"))
    assert isinstance(detection.consent_from_env(tmp_path), MacConsentRegistry)
    assert detection.supported() is True


def test_the_own_key_is_the_bundle_id_on_macos_and_the_file_name_on_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    assert detection.own_app_id() == detection_mac.OWN_BUNDLE_ID
    monkeypatch.setattr(sys, "platform", "win32")
    assert detection.own_app_id() == detection.own_file_name()


def test_windows_display_names_are_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    assert detection.display_name("C:#Program Files#Google#Chrome#Application#chrome.exe") == "Chrome"
    monkeypatch.setattr(sys, "platform", "darwin")
    assert detection.display_name(ZOOM) == "Zoom"


def test_a_mac_registry_entry_is_a_consent_entry(harness: Harness) -> None:
    entries = harness.registry.entries()
    assert all(isinstance(entry, ConsentEntry) for entry in entries)
