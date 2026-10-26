"""Meeting detection: the rules, the debounce, the ignored list, re-prompting, and the no-recording guarantee.

The consent store is a list the test fills in (no winreg, no registry). The recorder's start is replaced
with a function that fails the test, so a detection can only ever emit an event.
"""

from __future__ import annotations

import dataclasses
import logging
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from conftest import TOKEN, invoke, invoke_error
from openmeet_py.api.server import create_app
from openmeet_py.platform import detection
from openmeet_py.platform.detection import (
    ConsentEntry, Debounce, DetectionService, Signal, active_apps, display_name, in_use,
)
from openmeet_py.platform.win32 import FakeWin32

OWN = "openmeet.exe"
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

    def replace(self, *entries: ConsentEntry) -> None:
        """Exact store contents for one poll, plus this process's own entry (which must never be reported)."""
        self.entries_ = list(entries) + [ConsentEntry(OWN, 9, 0)]


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
    entries = [ConsentEntry("C:#Apps#openmeet.exe", 5, 0), ConsentEntry(ZOOM, 5, 0)]
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


def stored_flag_off(client: Any) -> None:
    """Simulates an old row that still says off; the Settings switch no longer exists to write it."""
    ctx = client.app.state.ctx  # type: ignore[attr-defined]
    with ctx.store.lock:
        ctx.store.db.execute("UPDATE settings SET detection_enabled = 0 WHERE id = 1")


def test_detection_polls_and_prompts_even_when_a_stored_flag_says_off(setup: Any) -> None:
    client, registry, service, events = setup
    stored_flag_off(client)
    registry.set(ZOOM)
    service.tick()
    service.tick()
    assert apps_emitted(events)[-1] == [{"id": ZOOM, "name": "Zoom"}]


def test_setting_commands_validate_their_input(setup: Any) -> None:
    client, _, _, _ = setup
    assert invoke(client, "get_settings")["detection_enabled"] is True
    status, body = invoke_error(client, "set_detection_ignored", appId="", name="x", ignored=True)
    assert (status, body["code"]) == (400, "detection_app")
    status, body = invoke_error(client, "set_detection_ignored", appId="x", name="y" * 201, ignored=True)
    assert body["code"] == "detection_app"


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


# ---- listeners (raw signals for the lifecycle; the prompt above is unchanged) ----


def signals_of(signals: tuple[Signal, ...]) -> list[tuple[str, str, bool]]:
    return sorted((s.app_id, s.name, s.in_use) for s in signals)


def test_listeners_see_in_use_and_idle_apps_on_the_first_poll(setup: Any) -> None:
    client, registry, service, events = setup
    seen: list[tuple[Signal, ...]] = []
    service.subscribe(seen.append)
    registry.replace(ConsentEntry(ZOOM, 5, 0), ConsentEntry(CHROME, 0, 5))
    service.tick()
    assert signals_of(seen[-1]) == [(ZOOM, "Zoom", True), (CHROME, "Chrome", False)]
    assert apps_emitted(events) == [[]]  # the debounced prompt still waits for a second poll


def test_a_single_in_use_poll_then_release_is_seen_immediately_and_never_prompted(setup: Any) -> None:
    client, registry, service, events = setup
    seen: list[tuple[Signal, ...]] = []
    service.subscribe(seen.append)
    registry.replace(ConsentEntry(ZOOM, 5, 0))
    service.tick()
    registry.replace(ConsentEntry(ZOOM, 0, 5))
    service.tick()
    assert [signals_of(batch) for batch in seen] == [[(ZOOM, "Zoom", True)], [(ZOOM, "Zoom", False)]]
    assert not any(apps for apps in apps_emitted(events))


def test_a_listener_sees_a_release_on_the_poll_it_happens_even_after_a_prompt(setup: Any) -> None:
    client, registry, service, events = setup
    seen: list[tuple[Signal, ...]] = []
    service.subscribe(seen.append)
    registry.replace(ConsentEntry(ZOOM, 5, 0))
    service.tick()
    service.tick()
    assert apps_emitted(events)[-1] == [{"id": ZOOM, "name": "Zoom"}]
    registry.replace(ConsentEntry(ZOOM, 0, 5))
    service.tick()
    assert signals_of(seen[-1]) == [(ZOOM, "Zoom", False)]


def test_listeners_still_hear_signals_when_a_stored_flag_says_off(setup: Any) -> None:
    client, registry, service, events = setup
    seen: list[tuple[Signal, ...]] = []
    service.subscribe(seen.append)
    stored_flag_off(client)
    registry.replace(ConsentEntry(ZOOM, 5, 0))
    service.tick()
    assert signals_of(seen[-1]) == [(ZOOM, "Zoom", True)]


def test_ignored_apps_are_excluded_from_listener_signals(setup: Any) -> None:
    client, registry, service, events = setup
    seen: list[tuple[Signal, ...]] = []
    service.subscribe(seen.append)
    invoke(client, "set_detection_ignored", appId=ZOOM, name="Zoom", ignored=True)
    registry.replace(ConsentEntry(ZOOM, 5, 0), ConsentEntry(CHROME, 5, 0))
    service.tick()
    assert signals_of(seen[-1]) == [(CHROME, "Chrome", True)]


def test_this_process_is_excluded_from_listener_signals(setup: Any) -> None:
    client, registry, service, events = setup
    seen: list[tuple[Signal, ...]] = []
    service.subscribe(seen.append)
    registry.replace(ConsentEntry("C:#Apps#openmeet.exe", 5, 0), ConsentEntry(ZOOM, 0, 5))
    service.tick()
    assert signals_of(seen[-1]) == [(ZOOM, "Zoom", False)]


def test_a_raising_listener_is_logged_and_does_not_stop_the_prompt_or_the_other_listeners(
    setup: Any, caplog: pytest.LogCaptureFixture
) -> None:
    client, registry, service, events = setup
    seen: list[tuple[Signal, ...]] = []

    def broken(_signals: tuple[Signal, ...]) -> None:
        raise RuntimeError("listener bug")

    service.subscribe(broken)
    service.subscribe(seen.append)
    registry.replace(ConsentEntry(ZOOM, 5, 0))
    with caplog.at_level(logging.WARNING, logger="openmeet_py"):
        service.tick()
        service.tick()
    assert apps_emitted(events)[-1] == [{"id": ZOOM, "name": "Zoom"}]
    assert len(seen) == 2
    assert "meeting detection listener failed" in caplog.text


def test_the_prompt_timing_is_unchanged_with_a_listener_subscribed(setup: Any) -> None:
    client, registry, service, events = setup
    service.subscribe(lambda _signals: None)
    in_use_zoom, idle_zoom = ConsentEntry(ZOOM, 5, 0), ConsentEntry(ZOOM, 0, 5)
    for entry in (in_use_zoom, in_use_zoom, idle_zoom, idle_zoom, in_use_zoom, in_use_zoom):
        registry.replace(entry)
        service.tick()
    assert apps_emitted(events) == [[], [{"id": ZOOM, "name": "Zoom"}], [], [{"id": ZOOM, "name": "Zoom"}]]


def test_signals_are_frozen_and_stamped_with_the_monotonic_clock(setup: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    client, registry, service, events = setup
    monkeypatch.setattr(detection, "time", SimpleNamespace(monotonic=lambda: 42.5))
    seen: list[tuple[Signal, ...]] = []
    service.subscribe(seen.append)
    registry.replace(ConsentEntry(ZOOM, 5, 0))
    service.tick()
    signal = seen[-1][0]
    assert signal.observed_at == 42.5
    with pytest.raises(dataclasses.FrozenInstanceError):
        signal.in_use = False  # type: ignore[misc]

