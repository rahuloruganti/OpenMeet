"""Automatic call capture, end to end on the backend: the controller driving the real recorder.

FakeBackend supplies synthetic devices (no streams are pumped), the consent store is a list the test
fills in, and the clock is a number the test moves, so the grace and keep-window rules run without
sleeping. The controller thread is never started here except in the lifespan test; tests call pump()
exactly where the thread would.
"""

from __future__ import annotations

import datetime as dt
import json
import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from conftest import TOKEN, invoke, invoke_error
from openmeet_py.api.commands import COMMANDS
from openmeet_py.api.lifecycle import THREAD_NAME
from openmeet_py.api.server import create_app
from openmeet_py.audio.audio_backend import FakeBackend
from openmeet_py.audio.recorder import Session
from openmeet_py.platform.detection import ConsentEntry
from openmeet_py.platform.win32 import FakeWin32

OWN = "openmeet.exe"
ZOOM = "C:#Apps#Zoom.EXE"
MIC, OUT = "fake-mic", "fake-output"
WALL_EPOCH = 1_800_000_000.0
PAYLOAD_KEYS = {
    "state",
    "enabled",
    "session_id",
    "meeting_id",
    "app_name",
    "origin",
    "revision",
    "reason",
    "end_deadline_ms",
    "error",
}


class ListRegistry:
    """A consent store double: the listed entries for one poll, plus this process's own entry."""

    def __init__(self) -> None:
        self.entries_: list[ConsentEntry] = []

    def replace(self, *entries: ConsentEntry) -> None:
        self.entries_ = list(entries) + [ConsentEntry(OWN, 9, 0)]

    def entries(self) -> list[ConsentEntry]:
        return list(self.entries_)


class FakeClock:
    def __init__(self) -> None:
        self.now = 100.0

    def monotonic(self) -> float:
        return self.now

    def wall(self) -> float:
        return WALL_EPOCH + self.now


class Spy:
    """A RecorderListener that only records what it was told."""

    def __init__(self) -> None:
        self.events: list[tuple[Any, ...]] = []

    def recorder_event(self, kind: str, meeting_id: Any, origin: str, reason: Any) -> None:
        self.events.append((kind, origin, reason))


@dataclass
class Rig:
    client: TestClient
    ctx: Any
    backend: FakeBackend
    registry: ListRegistry
    clock: FakeClock
    events: list[tuple[str, Any]]
    spy: Spy

    @property
    def lifecycle(self) -> Any:
        return self.ctx.lifecycle

    def at(self, now: float) -> None:
        self.clock.now = now

    def observe(self, in_use: bool) -> None:
        """One detection poll: Zoom in use, or idle (its last-used stop is after its start)."""
        self.registry.replace(ConsentEntry(ZOOM, 5, 0) if in_use else ConsentEntry(ZOOM, 5, 9))
        self.ctx.detection.tick()

    def pump(self) -> None:
        self.lifecycle.pump()

    def payloads(self) -> list[dict[str, Any]]:
        return [payload for event, payload in self.events if event == "call_lifecycle_changed"]

    def rows(self, sql: str, args: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
        with self.ctx.store.lock:
            return self.ctx.store.db.execute(sql, args).fetchall()

    def state(self) -> str:
        return self.lifecycle.payload()["state"]


def _app(data: Path, registry: ListRegistry, backend: FakeBackend) -> Any:
    return create_app(
        data,
        None,
        token=TOKEN,
        win32=FakeWin32(),
        consent=registry,
        backend=backend,
        workers=False,
    )


def _shutdown(ctx: Any) -> None:
    try:
        if ctx.recorder.state()["status"] in ("recording", "paused"):
            ctx.recorder.stop(origin="shutdown")
    except Exception:  # teardown only: a test may have left a stalled worker behind on purpose
        pass
    ctx.lifecycle.stop()


@pytest.fixture
def rig(tmp_path: Path) -> Iterator[Rig]:
    registry = ListRegistry()
    backend = FakeBackend(auto_pump=False)
    app = _app(tmp_path / "data", registry, backend)
    # No lifespan: the detection poll and the controller thread are not started, the tests drive them.
    client = TestClient(app, base_url="http://127.0.0.1")
    ctx = app.state.ctx
    ctx.detection.own = OWN
    clock = FakeClock()
    ctx.lifecycle.clock = clock.monotonic
    ctx.lifecycle.wall = clock.wall
    events: list[tuple[str, Any]] = []
    ctx.emit = lambda event, payload: events.append((event, payload))
    spy = Spy()
    ctx.recorder.add_listener(spy)
    invoke(client, "save_default_devices", microphone_id=MIC, output_id=OUT)
    yield Rig(client, ctx, backend, registry, clock, events, spy)
    _shutdown(ctx)


def enable(rig: Rig) -> None:
    invoke(rig.client, "save_auto_capture", enabled=True)


def start_call(rig: Rig) -> None:
    """Two in-use polls, then the step the thread would run."""
    rig.observe(True)
    rig.observe(True)
    rig.pump()


def to_end_pending(rig: Rig) -> None:
    """A started call released at 110 whose grace has run out at 155."""
    rig.at(110)
    rig.observe(False)
    rig.at(155)
    rig.pump()
    assert rig.state() == "end_pending"


# ---- the switch and the start ------------------------------------------------------


def test_disabled_opens_no_stream_even_with_a_call_on_the_microphone(rig: Rig) -> None:
    for _ in range(5):
        rig.observe(True)
        rig.pump()
    assert rig.backend.streams == []
    assert rig.state() == "disabled"
    assert rig.lifecycle.payload()["enabled"] is False


def test_two_in_use_polls_start_an_automatic_recording_with_saved_devices(rig: Rig) -> None:
    enable(rig)
    assert rig.state() == "armed"
    rig.observe(True)
    assert rig.state() == "candidate"
    rig.observe(True)
    # The poll only decides. The recorder is started by the step that runs the queued action.
    assert rig.backend.streams == []
    rig.pump()

    recorder = rig.ctx.recorder.state()
    assert recorder["status"] == "recording"
    assert recorder["origin"] == "auto"
    assert [s.device.id for s in rig.backend.streams] == [MIC, OUT]
    assert rig.spy.events[0] == ("started", "auto", None)
    meeting = recorder["meeting_id"]
    assert rig.rows("SELECT title FROM meetings WHERE id = ?1", (meeting,)) == [("Zoom call",)]
    assert rig.lifecycle.payload()["meeting_id"] == meeting

    payload = rig.lifecycle.payload()
    assert set(payload) == PAYLOAD_KEYS
    assert (payload["state"], payload["origin"], payload["app_name"]) == ("recording", "auto", "Zoom")
    text = json.dumps(payload)
    assert "Apps" not in text and "C:#" not in text and "#" not in text

    rows = rig.rows("SELECT call_key, state, origin, active, meeting_id FROM call_sessions")
    assert rows == [("C:#Apps#Zoom.EXE#0", "recording", "auto", 1, meeting)]


def test_a_missing_saved_device_is_reported_once_and_never_retried(rig: Rig) -> None:
    invoke(rig.client, "save_default_devices", microphone_id="missing-mic", output_id=OUT)
    starts: list[int] = []
    original = rig.ctx.recorder.start

    def counting(*args: Any, **kwargs: Any) -> Any:
        starts.append(1)
        return original(*args, **kwargs)

    rig.ctx.recorder.start = counting
    enable(rig)
    start_call(rig)

    payload = rig.lifecycle.payload()
    assert payload["state"] == "recoverable_error"
    assert "microphone" in payload["error"].lower()
    assert "C:" not in payload["error"] and "Apps" not in payload["error"]
    assert rig.backend.streams == []
    assert rig.ctx.recorder.state()["status"] == "idle"
    assert rig.payloads()[-1]["error"] == payload["error"]

    for _ in range(10):
        rig.at(rig.clock.now + 5)
        rig.observe(True)
        rig.pump()
    assert starts == [1]
    assert rig.state() == "recoverable_error"


def test_no_saved_devices_at_all_is_reported_as_a_device_error(rig: Rig) -> None:
    with rig.ctx.store.lock:
        rig.ctx.store.db.execute("UPDATE settings SET microphone_id = NULL, output_id = NULL WHERE id = 1")
    enable(rig)
    start_call(rig)
    payload = rig.lifecycle.payload()
    assert payload["state"] == "recoverable_error"
    assert payload["error"] and "microphone" in payload["error"].lower()
    assert rig.backend.streams == []


# ---- the end of a call ---------------------------------------------------------------


def test_a_release_shorter_than_the_grace_keeps_recording(rig: Rig) -> None:
    enable(rig)
    start_call(rig)
    rig.at(110)
    rig.observe(False)
    rig.at(150)  # 40 s after release: under the 45 s grace
    rig.pump()
    assert rig.state() == "recording"
    rig.observe(True)
    rig.at(200)
    rig.pump()
    assert rig.state() == "recording"
    assert rig.ctx.recorder.state()["status"] == "recording"


def test_a_release_at_the_grace_moves_to_end_pending_with_a_wall_clock_deadline(rig: Rig) -> None:
    enable(rig)
    start_call(rig)
    to_end_pending(rig)
    payload = rig.lifecycle.payload()
    assert payload["state"] == "end_pending"
    assert payload["end_deadline_ms"] == int((WALL_EPOCH + 155 + 60) * 1000)
    assert rig.ctx.recorder.state()["status"] == "recording"  # end_pending does not stop capture
    assert rig.payloads()[-1]["end_deadline_ms"] == payload["end_deadline_ms"]


def test_keep_recording_extends_the_keep_window(rig: Rig) -> None:
    enable(rig)
    start_call(rig)
    to_end_pending(rig)
    current = rig.lifecycle.payload()
    kept = invoke(
        rig.client,
        "lifecycle_keep_recording",
        sessionId=current["session_id"],
        expectedRevision=current["revision"],
    )
    assert (kept["state"], kept["reason"], kept["end_deadline_ms"]) == ("recording", "kept_by_user", None)

    # The keep clears the release; the next poll starts a fresh grace from 160.
    rig.at(160)
    rig.observe(False)
    rig.at(216)  # past the original deadline of 215
    rig.pump()
    assert rig.state() == "end_pending"
    assert rig.ctx.recorder.state()["status"] == "recording"


def test_end_now_stops_with_origin_lifecycle_and_finishes_without_processing(rig: Rig) -> None:
    enable(rig)
    start_call(rig)
    to_end_pending(rig)
    current = rig.lifecycle.payload()
    ended = invoke(
        rig.client,
        "lifecycle_end_now",
        sessionId=current["session_id"],
        expectedRevision=current["revision"],
    )
    assert ended["state"] == "finalizing"
    rig.pump()

    assert ("stopped", "lifecycle", None) in rig.spy.events
    assert rig.ctx.recorder.state()["status"] == "stopped"
    # No processing plan was attached, so the call completes as soon as the recording has stopped.
    assert (rig.state(), rig.lifecycle.payload()["reason"]) == ("complete", "processing_finished")


def test_the_keep_window_expiring_stops_the_recording(rig: Rig) -> None:
    enable(rig)
    start_call(rig)
    to_end_pending(rig)  # the window runs to 215
    rig.at(214)
    rig.pump()
    assert rig.ctx.recorder.state()["status"] == "recording"
    rig.at(215)
    rig.pump()
    assert ("stopped", "lifecycle", None) in rig.spy.events
    assert rig.ctx.recorder.state()["status"] == "stopped"
    assert rig.state() == "complete"


def test_switching_auto_capture_off_ends_an_automatic_recording(rig: Rig) -> None:
    enable(rig)
    start_call(rig)
    invoke(rig.client, "save_auto_capture", enabled=False)
    rig.pump()
    assert rig.ctx.recorder.state()["status"] == "stopped"
    assert rig.lifecycle.payload()["enabled"] is False
    assert rig.state() == "complete"


# ---- manual control and suppression --------------------------------------------------


def test_a_manual_stop_suppresses_a_restart_for_the_same_call_until_it_releases(rig: Rig) -> None:
    enable(rig)
    start_call(rig)
    invoke(rig.client, "stop_recording")  # manual origin: ManualStop, then RecorderStopped
    assert ("stopped", "manual", None) in rig.spy.events
    rig.pump()
    assert rig.state() == "complete"

    for _ in range(5):
        rig.observe(True)
        rig.pump()
    assert len(rig.backend.streams) == 2  # no new capture while the same call stays on the microphone

    rig.at(200)
    rig.observe(False)  # release starts the grace that clears the suppression
    rig.at(250)
    rig.pump()
    rig.observe(True)
    rig.observe(True)
    rig.pump()
    assert rig.ctx.recorder.state()["status"] == "recording"
    assert len(rig.backend.streams) == 4
    assert rig.rows("SELECT call_key FROM call_sessions WHERE active = 1") == [("C:#Apps#Zoom.EXE#1",)]


def test_a_manual_recording_is_tracked_as_manual_and_not_restarted_for_its_call(rig: Rig) -> None:
    enable(rig)
    invoke(rig.client, "start_recording", title="Planning", devices={"microphoneId": MIC, "outputId": OUT})
    assert rig.spy.events[0] == ("started", "manual", None)
    assert rig.lifecycle.payload()["origin"] == "manual"
    rig.observe(True)
    rig.observe(True)
    rig.pump()
    assert len(rig.backend.streams) == 2  # the manual recording is the only one


def test_a_fault_while_the_recorder_is_still_active_does_not_end_the_call(rig: Rig) -> None:
    enable(rig)
    start_call(rig)
    rig.lifecycle.recorder_event("fault", None, "auto", "audio")
    rig.pump()
    assert rig.state() == "recording"


def test_a_failed_stop_leaves_the_call_recoverable_with_the_recorder_text(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    enable(rig)
    start_call(rig)
    to_end_pending(rig)
    monkeypatch.setattr(Session, "close_writer", lambda self: False)  # a stalled writer: stop times out
    current = rig.lifecycle.payload()
    invoke(rig.client, "lifecycle_end_now", sessionId=current["session_id"], expectedRevision=current["revision"])
    rig.pump()
    payload = rig.lifecycle.payload()
    assert payload["state"] == "recoverable_error"
    assert "did not respond" in (payload["error"] or "")
    assert ("stop_failed", "lifecycle", "audio_worker_busy") in rig.spy.events


# ---- processing and finalization -----------------------------------------------------


class FakeProcessing:
    """Stands in for the processing workflow: the test sets the stage and records acknowledgements."""

    def __init__(self) -> None:
        self.workflow: dict[str, Any] = {}
        self.acks: list[tuple[Any, ...]] = []

    def snapshot(self, meeting_id: str) -> dict[str, Any]:
        return {"workflow": dict(self.workflow)}

    def acknowledge(self, meeting_id: str, run_id: str, barrier: str, revision: int) -> None:
        self.acks.append((meeting_id, run_id, barrier, revision))
        self.workflow["notes_revision"] = revision


@pytest.mark.parametrize(
    ("stage", "reason"),
    [("completed", "processing_finished"), ("failed", "processing_failed")],
)
def test_an_automatic_call_waits_for_processing_then_acknowledges_the_notes_once(
    rig: Rig, stage: str, reason: str
) -> None:
    fake = FakeProcessing()
    rig.ctx.processing = fake
    enable(rig)
    start_call(rig)
    to_end_pending(rig)
    current = rig.lifecycle.payload()
    invoke(rig.client, "lifecycle_end_now", sessionId=current["session_id"], expectedRevision=current["revision"])
    fake.workflow = {"run_id": "run-1", "stage": "finalizing_audio", "notes_barrier": "bar-1", "notes_revision": None}
    rig.pump()
    assert rig.state() == "finalizing"

    fake.workflow["stage"] = "awaiting_notes"
    rig.pump()
    meeting = rig.lifecycle.payload()["meeting_id"]
    (notes_revision,) = rig.rows("SELECT revision FROM notes WHERE meeting_id = ?1", (meeting,))[0]
    assert fake.acks == [(meeting, "run-1", "bar-1", notes_revision)]
    assert rig.state() == "finalizing"

    rig.pump()
    assert len(fake.acks) == 1  # acknowledged once; the worker moves the stage on from here

    fake.workflow["stage"] = stage
    rig.pump()
    assert (rig.state(), rig.lifecycle.payload()["reason"]) == ("complete", reason)


# ---- commands, payload, lifecycle of the thread ------------------------------------


def test_the_lifecycle_commands_are_registered_and_the_payload_has_exactly_the_public_shape(rig: Rig) -> None:
    for name in ("get_call_lifecycle", "lifecycle_keep_recording", "lifecycle_end_now", "save_auto_capture"):
        assert name in COMMANDS
    payload = invoke(rig.client, "get_call_lifecycle")
    assert set(payload) == PAYLOAD_KEYS
    assert payload["state"] == "disabled" and payload["enabled"] is False


def test_a_stale_revision_or_session_is_refused_with_stale_revision(rig: Rig) -> None:
    enable(rig)
    start_call(rig)
    to_end_pending(rig)
    current = rig.lifecycle.payload()
    status, body = invoke_error(
        rig.client,
        "lifecycle_keep_recording",
        sessionId=current["session_id"],
        expectedRevision=current["revision"] - 1,
    )
    assert (status, body["code"]) == (409, "stale_revision")
    status, body = invoke_error(
        rig.client, "lifecycle_end_now", sessionId="not-the-session", expectedRevision=current["revision"]
    )
    assert body["code"] == "stale_revision"
    assert rig.state() == "end_pending"


def test_a_pause_from_a_non_manual_origin_is_not_a_manual_event(rig: Rig) -> None:
    enable(rig)
    start_call(rig)
    rig.lifecycle.recorder_event("paused", None, "lifecycle", None)  # only manual pause and resume count
    rig.pump()
    assert rig.state() == "recording"


def test_restart_seeds_the_epoch_from_stored_calls_and_clears_stale_active_rows(tmp_path: Path) -> None:
    data = tmp_path / "data"
    first_backend = FakeBackend(auto_pump=False)
    first = _app(data, ListRegistry(), first_backend)
    with first.state.ctx.store.lock:
        first.state.ctx.store.db.execute(
            "INSERT INTO call_sessions (id, call_key, app_id, state, origin, reason, active, revision, opened_at, "
            "updated_at) VALUES ('old', 'C:#Apps#Zoom.EXE#7', 'C:#Apps#Zoom.EXE', 'complete', 'auto', "
            "'processing_finished', 1, 3, 1, 1)"
        )
    first.state.ctx.store.close()

    registry = ListRegistry()
    backend = FakeBackend(auto_pump=False)
    app = _app(data, registry, backend)
    ctx = app.state.ctx
    ctx.detection.own = OWN
    events: list[tuple[str, Any]] = []
    ctx.emit = lambda event, payload: events.append((event, payload))
    client = TestClient(app, base_url="http://127.0.0.1")
    try:
        assert ctx.store.db.execute("SELECT COUNT(*) FROM call_sessions WHERE active = 1").fetchone()[0] == 0
        invoke(client, "save_default_devices", microphone_id=MIC, output_id=OUT)
        invoke(client, "save_auto_capture", enabled=True)
        registry.replace(ConsentEntry(ZOOM, 5, 0))
        ctx.detection.tick()
        ctx.detection.tick()
        ctx.lifecycle.pump()
        keys = ctx.store.db.execute("SELECT call_key FROM call_sessions WHERE active = 1").fetchall()
        assert keys == [("C:#Apps#Zoom.EXE#8",)]
    finally:
        _shutdown(ctx)
        ctx.store.close()


def test_the_lifecycle_thread_runs_under_the_lifespan_and_leaves_no_thread_behind(tmp_path: Path) -> None:
    app = _app(tmp_path / "data", ListRegistry(), FakeBackend(auto_pump=False))
    with TestClient(app, base_url="http://127.0.0.1"):
        assert any(thread.name == THREAD_NAME for thread in threading.enumerate())
    assert not any(thread.name == THREAD_NAME for thread in threading.enumerate())
    with pytest.raises(sqlite3.ProgrammingError):
        app.state.ctx.store.db.execute("SELECT 1")  # the store closed during shutdown


def _calendar_event(rig: Rig, title: str, start_offset_s: float, end_offset_s: float) -> str:
    from openmeet_py.domain import calendar as cal

    now = dt.datetime.fromtimestamp(rig.clock.wall(), dt.timezone.utc)
    with rig.ctx.store.lock:
        db = rig.ctx.store.db
        db.execute(
            "INSERT OR IGNORE INTO calendar_feeds (id, label, kind, created_at) VALUES ('feed1', 'Work', 'ics', ?1)",
            (cal.iso(now),),
        )
        db.execute(
            "INSERT INTO calendar_events (id, feed_id, uid, start_utc, end_utc, all_day, title, status) "
            "VALUES (?1, 'feed1', ?1, ?2, ?3, 0, ?4, 'confirmed')",
            (
                f"ev-{title}",
                cal.iso(now + dt.timedelta(seconds=start_offset_s)),
                cal.iso(now + dt.timedelta(seconds=end_offset_s)),
                title,
            ),
        )
        db.commit()
    return f"ev-{title}"


def test_an_automatic_call_during_a_calendar_event_takes_its_title_and_links_the_event(rig: Rig) -> None:
    event_id = _calendar_event(rig, "Weekly sync", -120, 1800)
    enable(rig)
    start_call(rig)
    meeting = rig.ctx.recorder.state()["meeting_id"]
    assert rig.rows("SELECT title, calendar_event_id FROM meetings WHERE id = ?1", (meeting,)) == [
        ("Weekly sync", event_id)
    ]


def test_an_automatic_call_with_no_matching_event_keeps_the_app_title(rig: Rig) -> None:
    _calendar_event(rig, "Later today", 3600, 5400)
    enable(rig)
    start_call(rig)
    meeting = rig.ctx.recorder.state()["meeting_id"]
    assert rig.rows("SELECT title, calendar_event_id FROM meetings WHERE id = ?1", (meeting,)) == [
        ("Zoom call", None)
    ]
