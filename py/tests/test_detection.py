"""Meeting detection: the rules, the debounce, the ignored list, re-prompting, and the no-recording guarantee.

The consent store is a list the test fills in (no winreg, no registry). The recorder's start is replaced
with a function that fails the test, so a detection can only ever emit an event.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from conftest import TOKEN, invoke, invoke_error
from openmeet_py import detection
from openmeet_py.detection import ConsentEntry, Debounce, DetectionService, active_apps, display_name, in_use
from openmeet_py.server import create_app
from openmeet_py.win32 import FakeWin32

OWN = "openmeet-py.exe"
ZOOM = "C:#Apps#Zoom.EXE"
CHROME = "C:#Program Files#Google#Chrome#Application#chrome.exe"


class ListRegistry:
    """A consent store double. `active` names are in use; everything else is idle."""

    def __init__(self) -> None:
        self.entries_: list[ConsentEntry] = []

    def set(self, *names: str) -> None:
        self.entries_ = [ConsentEntry(name, 5, 0) for name in names]
        self.entries_ += [ConsentEntry(OWN, 9, 0)]

    def entries(self) -> list[ConsentEntry]:
        return list(self.entries_)


@pytest.fixture
def setup(tmp_path: Path) -> Any:
    registry = ListRegistry()
    app = create_app(tmp_path / "data", None, token=TOKEN, win32=FakeWin32(), consent=registry, workers=False)
    client = TestClient(app, base_url="http://127.0.0.1")
    client.__enter__()
    ctx = app.state.ctx  # type: ignore[attr-defined]
    events: list[tuple[str, Any]] = []
    ctx.emit = lambda event, payload: events.append((event, payload))
    service = DetectionService(ctx, registry, own=OWN, poll=0)
    invoke(client, "save_detection", enabled=True)
    yield client, registry, service, events
    client.__exit__(None, None, None)


def apps_emitted(events: list[tuple[str, Any]]) -> list[list[dict[str, str]]]:
    return [payload for event, payload in events if event == "microphone_apps"]


# ---- the rules ----------------------------------------------------------------


def test_display_names_follow_the_store_keys() -> None:
    assert display_name(CHROME) == "Chrome"
    assert display_name("C:#Apps#Zoom.EXE") == "Zoom"
    assert display_name("5319275A.WhatsAppDesktop_cv1g1gvanyjgm") == "WhatsAppDesktop"
    assert display_name("MSTeams_8wekyb3d8bbwe") == "MSTeams"
    assert display_name("Microsoft.WindowsCamera_8wekyb3d8bbwe") == "WindowsCamera"


def test_an_app_is_in_use_only_while_its_start_is_after_its_stop() -> None:
    assert in_use(5, 0)
    assert in_use(9, 4)
    assert not in_use(4, 9)
    assert not in_use(0, 0)


def test_this_process_is_never_reported() -> None:
    entries = [ConsentEntry("C:#Apps#openmeet-py.exe", 5, 0), ConsentEntry(ZOOM, 5, 0)]
    assert active_apps(entries, OWN) == {ZOOM: "Zoom"}


def test_debounce_reports_after_two_polls_and_only_on_change() -> None:
    debounce = Debounce()
    assert debounce.update({"zoom"}) == []
    assert debounce.update({"zoom"}) == ["zoom"]
    assert debounce.update({"zoom"}) is None
    assert debounce.update({"zoom", "dictation"}) is None  # a single-poll blip is not reported
    assert debounce.update({"zoom"}) is None
    assert debounce.update(set()) == []
    assert debounce.update(set()) is None


# ---- the poll service ---------------------------------------------------------


def test_an_app_is_offered_after_two_polls_and_the_recorder_is_never_touched(setup: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    client, registry, service, events = setup
    ctx = client.app.state.ctx  # type: ignore[attr-defined]

    def must_not_start(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("meeting detection must never start a recording")

    monkeypatch.setattr(ctx.recorder, "start", must_not_start)
    registry.set(ZOOM)
    service.tick()
    assert apps_emitted(events) == [[]]
    service.tick()
    assert apps_emitted(events)[-1] == [{"id": ZOOM, "name": "Zoom"}]
    assert ctx.recorder.state()["status"] == "idle"
    assert invoke(client, "list_meetings") == []


def test_an_app_that_stops_and_starts_again_is_offered_again(setup: Any) -> None:
    client, registry, service, events = setup
    registry.set(ZOOM)
    service.tick()
    service.tick()
    registry.set()  # the app released the microphone
    service.tick()
    assert apps_emitted(events)[-1] == []
    registry.set(ZOOM)
    service.tick()
    service.tick()
    assert apps_emitted(events)[-1] == [{"id": ZOOM, "name": "Zoom"}]


def test_ignored_apps_are_never_offered_and_prompt_again_restores_them(setup: Any) -> None:
    client, registry, service, events = setup
    registry.set(ZOOM)
    service.tick()
    service.tick()
    assert apps_emitted(events)[-1] == [{"id": ZOOM, "name": "Zoom"}]
    settings = invoke(client, "set_detection_ignored", appId=ZOOM, name="Zoom", ignored=True)
    assert settings["detection_ignored"] == [{"id": ZOOM, "name": "Zoom"}]
    service.tick()
    service.tick()
    assert apps_emitted(events)[-1] == []
    invoke(client, "set_detection_ignored", appId=ZOOM, name="Zoom", ignored=False)
    assert invoke(client, "get_settings")["detection_ignored"] == []
    service.tick()
    service.tick()
    assert apps_emitted(events)[-1] == [{"id": ZOOM, "name": "Zoom"}]


def test_nothing_is_offered_while_detection_is_off(setup: Any) -> None:
    client, registry, service, events = setup
    invoke(client, "save_detection", enabled=False)
    registry.set(ZOOM)
    service.tick()
    service.tick()
    assert apps_emitted(events) == [[]] or apps_emitted(events) == []
    assert not any(apps for apps in apps_emitted(events))


def test_setting_commands_validate_their_input(setup: Any) -> None:
    client, _, _, _ = setup
    assert invoke(client, "get_settings")["detection_enabled"] is True
    status, body = invoke_error(client, "set_detection_ignored", appId="", name="x", ignored=True)
    assert (status, body["code"]) == (400, "detection_app")
    status, body = invoke_error(client, "set_detection_ignored", appId="x", name="y" * 201, ignored=True)
    assert body["code"] == "detection_app"
    status, body = invoke_error(client, "save_detection", enabled="yes")
    assert body["code"] == "invalid_args"


def test_detection_support_follows_the_platform_or_the_fake(setup: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    client, _, _, _ = setup
    assert invoke(client, "detection_supported") is detection.supported()
    monkeypatch.setattr(detection.sys, "platform", "linux")
    monkeypatch.delenv("OPENMEET_PY_FAKE_DETECTION", raising=False)
    assert detection.supported() is False
    monkeypatch.setenv("OPENMEET_PY_FAKE_DETECTION", "1")
    assert detection.supported() is True


# ---- taskbar attention -------------------------------------------------------


def test_the_prompt_flashes_the_window_when_there_is_one(tmp_path: Path) -> None:
    win32 = FakeWin32(windows=("OpenMeet",))
    app = create_app(tmp_path / "data", None, token=TOKEN, win32=win32, workers=False)
    client = TestClient(app, base_url="http://127.0.0.1")
    client.__enter__()
    try:
        assert invoke(client, "request_attention") is None
        assert win32.flashes == ["OpenMeet"]
    finally:
        client.__exit__(None, None, None)


def test_attention_is_a_no_op_without_a_window(tmp_path: Path) -> None:
    win32 = FakeWin32()
    app = create_app(tmp_path / "data", None, token=TOKEN, win32=win32, workers=False)
    client = TestClient(app, base_url="http://127.0.0.1")
    client.__enter__()
    try:
        assert invoke(client, "request_attention") is None
        assert win32.flashes == []
    finally:
        client.__exit__(None, None, None)


def test_the_fake_consent_file_drives_detection(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENMEET_PY_FAKE_DETECTION", "1")
    data = tmp_path / "data"
    data.mkdir()
    (data / detection.FAKE_FILE).write_text('[{"name": "C:#Apps#Zoom.EXE", "start": 5, "stop": 0}]', encoding="utf-8")
    registry = detection.consent_from_env(data)
    assert [entry.name for entry in registry.entries()] == [ZOOM]
    (data / detection.FAKE_FILE).write_text("not json", encoding="utf-8")
    assert registry.entries() == []
