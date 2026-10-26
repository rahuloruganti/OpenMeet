"""Calendar feeds: migration 034, feed storage in the Credential Manager, sync, commands and reminders.

Fictional fixtures and a MockTransport only. The feed address used here is a made-up token on a test host.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

import httpx
import pytest
from fastapi.testclient import TestClient

from conftest import invoke, invoke_error, latest_migration
from openmeet_py.api import calendar as svc
from openmeet_py.api.commands import COMMANDS
from openmeet_py.api.context import Context
from openmeet_py.api.errors import AppError
from openmeet_py.api.reads import read_settings
from openmeet_py.infra.store import DB_FILE, Store
from test_live_wiring import database_through

FIXTURES = Path(__file__).parent / "fixtures" / "ics"
UTC = dt.timezone.utc
NOW = dt.datetime(2026, 10, 26, 8, 0, tzinfo=UTC)
FEED_URL = "https://calendar.example.test/ical/private-TOKEN-ABC/basic.ics"
SECRET = "private-TOKEN-ABC"


class Harness:
    def __init__(self, ctx: Context, emitted: list[tuple[str, Any]], responses: dict[str, Any]) -> None:
        self.ctx = ctx
        self.emitted = emitted
        self.responses = responses  # url -> bytes | httpx.Response | Exception
        self.requests: list[str] = []

    def db(self) -> sqlite3.Connection:
        return self.ctx.store.db

    def names(self) -> list[str]:
        return [name for name, _ in self.emitted]


@pytest.fixture
def harness(tmp_path: Path) -> Iterator[Harness]:
    responses: dict[str, Any] = {FEED_URL: (FIXTURES / "folded_escaped.ics").read_bytes()}
    emitted: list[tuple[str, Any]] = []
    holder: dict[str, Harness] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        holder["h"].requests.append(url)
        outcome = responses.get(url)
        if outcome is None:
            return httpx.Response(404)
        if isinstance(outcome, Exception):
            raise outcome
        if isinstance(outcome, httpx.Response):
            return outcome
        return httpx.Response(200, content=outcome, headers={"content-type": "text/calendar"})

    store = Store(tmp_path / "data")
    ctx = Context(
        store=store,
        emit=lambda name, payload: emitted.append((name, payload)),
        transport=httpx.MockTransport(handler),
    )
    ctx.calendar = svc.CalendarService(ctx, clock=lambda: NOW)
    item = Harness(ctx, emitted, responses)
    holder["h"] = item
    yield item
    store.close()


def add_feed(h: Harness, label: str = "Fictional calendar", url: str = FEED_URL) -> dict[str, Any]:
    return svc.add_calendar_feed(h.ctx, label, url)


def insert_event(
    db: sqlite3.Connection,
    event_id: str,
    *,
    feed: str = "feed-1",
    uid: str = "uid-1",
    start: str = "2026-10-26T09:00:00.000000Z",
    end: str = "2026-10-26T09:30:00.000000Z",
    all_day: int = 0,
    title: str = "Fictional sync",
    status: str = "confirmed",
    meeting_url: Optional[str] = None,
) -> None:
    db.execute(
        "INSERT OR IGNORE INTO calendar_feeds (id, label, kind, created_at) VALUES (?1, 'Fictional', 'ics', ?2)",
        (feed, start),
    )
    db.execute(
        "INSERT INTO calendar_events (id, feed_id, uid, start_utc, end_utc, all_day, title, status, meeting_url) "
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        (event_id, feed, uid, start, end, all_day, title, status, meeting_url),
    )


def insert_meeting(db: sqlite3.Connection, meeting_id: str, title: str, started_at: str) -> None:
    db.execute(
        "INSERT INTO meetings (id, title, started_at, source, status) VALUES (?1, ?2, ?3, 'note', 'stopped')",
        (meeting_id, title, started_at),
    )
    db.execute("INSERT INTO notes (meeting_id, user_markdown) VALUES (?1, '')", (meeting_id,))


# ---- migration 034 ------------------------------------------------------------------------------


def test_migration_034_adds_calendar_tables_columns_and_defaults(tmp_path: Path) -> None:
    data = database_through(tmp_path, 33)
    db = sqlite3.connect(data / DB_FILE)
    db.execute(
        "INSERT INTO meetings (id, title, started_at, source, status) VALUES "
        "('m-old', 'Fictional upgrade', '2026-01-01T09:00:00.000000Z', 'desktop', 'stopped')"
    )
    db.commit()
    db.close()
    store = Store(data)
    try:
        assert store.db.execute("PRAGMA user_version").fetchone()[0] == latest_migration()
        assert latest_migration() >= 34
        settings = read_settings(store.db)
        assert settings["calendar_reminders"] is True
        assert settings["calendar_reminder_minutes"] == 2
        row = store.db.execute("SELECT title, calendar_event_id FROM meetings WHERE id='m-old'").fetchone()
        assert row == ("Fictional upgrade", None)
        columns = {r[1] for r in store.db.execute("PRAGMA table_info(calendar_events)")}
        assert {"feed_id", "uid", "recurrence_id", "all_day", "attendees_json", "meeting_url"} <= columns
    finally:
        store.close()


def test_deleting_a_feed_cascades_its_events_and_clears_meeting_links(harness: Harness) -> None:
    insert_event(harness.db(), "event-1")
    insert_meeting(harness.db(), "m-1", "Fictional sync", "2026-10-20T09:00:00.000000Z")
    harness.db().execute("UPDATE meetings SET calendar_event_id='event-1' WHERE id='m-1'")
    harness.db().execute("DELETE FROM calendar_feeds WHERE id='feed-1'")
    assert harness.db().execute("SELECT COUNT(*) FROM calendar_events").fetchone()[0] == 0
    assert harness.db().execute("SELECT calendar_event_id FROM meetings WHERE id='m-1'").fetchone()[0] is None


# ---- feeds: storage, validation, secrecy --------------------------------------------------------


def test_add_feed_keeps_the_address_out_of_sqlite_and_responses(harness: Harness, memory_keyring: Any) -> None:
    feed = add_feed(harness)
    assert feed["has_url"] is True and feed["last_status"] == "ok"
    assert set(feed) == {"id", "label", "kind", "last_sync_at", "last_status", "last_error", "has_url"}
    assert memory_keyring.items[("OpenMeetPy", f"calendar:{feed['id']}")] == FEED_URL
    dump = "\n".join(harness.db().iterdump())
    assert SECRET not in dump and "calendar.example.test" not in dump
    assert SECRET not in json.dumps(svc.list_calendar_feeds(harness.ctx))
    assert "calendar_changed" in harness.names()


@pytest.mark.parametrize(
    "url",
    [
        "http://calendar.example.test/ical/x/basic.ics",  # not https
        "https://calendar.example.test/calendar/page",  # not an iCal address
        "https://user:pass@calendar.example.test/ical/x.ics",  # credentials in the URL
        "https:///ical/x.ics",  # no host
        "https://calendar.example.test/ical/x y.ics",  # whitespace
        "   ",
    ],
)
def test_add_feed_refuses_urls_that_are_not_https_ics_addresses(harness: Harness, url: str) -> None:
    with pytest.raises(AppError) as error:
        add_feed(harness, url=url)
    assert error.value.code in {"calendar_url", "invalid_args"}
    assert harness.db().execute("SELECT COUNT(*) FROM calendar_feeds").fetchone()[0] == 0


def test_add_feed_validates_label(harness: Harness) -> None:
    with pytest.raises(AppError) as error:
        add_feed(harness, label="   ")
    assert error.value.code == "calendar_label"


def test_add_feed_without_keyring_stores_no_row(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(*_args: object) -> None:
        raise RuntimeError("store down")

    monkeypatch.setattr(svc.keys, "store_at", broken)
    with pytest.raises(AppError) as error:
        add_feed(harness)
    assert error.value.code == "keychain_unavailable"
    assert harness.db().execute("SELECT COUNT(*) FROM calendar_feeds").fetchone()[0] == 0


def test_remove_feed_deletes_the_credential_and_the_rows(harness: Harness, memory_keyring: Any) -> None:
    feed = add_feed(harness)
    svc.remove_calendar_feed(harness.ctx, feed["id"])
    assert ("OpenMeetPy", f"calendar:{feed['id']}") not in memory_keyring.items
    assert harness.db().execute("SELECT COUNT(*) FROM calendar_feeds").fetchone()[0] == 0
    assert harness.db().execute("SELECT COUNT(*) FROM calendar_events").fetchone()[0] == 0


def test_remove_unknown_feed_is_not_found(harness: Harness) -> None:
    with pytest.raises(AppError) as error:
        svc.remove_calendar_feed(harness.ctx, "missing")
    assert error.value.code == "not_found"


# ---- sync ---------------------------------------------------------------------------------------


def test_sync_replaces_events_and_keeps_meeting_links_when_the_feed_is_unchanged(harness: Harness) -> None:
    feed = add_feed(harness)
    events = svc.list_calendar_events(harness.ctx, "2026-10-21T00:00:00.000000Z", "2026-10-22T00:00:00.000000Z")
    assert [e["title"] for e in events] == ["Fictional roadmap, review"]
    event_id = events[0]["id"]
    insert_meeting(harness.db(), "m-1", "Fictional roadmap, review", "2026-10-20T09:00:00.000000Z")
    svc.link_meeting_event(harness.ctx, "m-1", event_id)
    svc.sync_calendars(harness.ctx)
    assert svc.list_calendar_events(harness.ctx, "2026-10-21T00:00:00.000000Z", "2026-10-22T00:00:00.000000Z")[0][
        "id"
    ] == event_id
    assert harness.db().execute("SELECT calendar_event_id FROM meetings WHERE id='m-1'").fetchone()[0] == event_id
    assert feed["id"] in [f["id"] for f in svc.list_calendar_feeds(harness.ctx)]


def test_sync_drops_an_event_removed_from_the_feed_inside_the_window(harness: Harness) -> None:
    add_feed(harness)
    harness.responses[FEED_URL] = b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n"
    svc.sync_calendars(harness.ctx)
    assert svc.list_calendar_events(harness.ctx, "2026-10-21T00:00:00.000000Z", "2026-10-22T00:00:00.000000Z") == []


@pytest.mark.parametrize(
    ("outcome", "expected"),
    [
        (httpx.Response(404), "The calendar answered with HTTP 404."),
        (httpx.Response(302, headers={"location": "https://elsewhere.example.test/x.ics"}), "redirected"),
        (httpx.ConnectError(f"no route to {FEED_URL}"), "The calendar could not be reached."),
        (httpx.ReadTimeout(f"timed out {FEED_URL}"), "The calendar could not be reached."),
        ("OVERSIZE", "larger than 5 MB"),
        (b"<html>a login page</html>", "not an iCalendar calendar"),
    ],
)
def test_sync_errors_are_user_safe_and_keep_previous_events(
    harness: Harness, outcome: Any, expected: str
) -> None:
    feed = add_feed(harness)
    before = svc.list_calendar_events(harness.ctx, "2026-10-21T00:00:00.000000Z", "2026-10-22T00:00:00.000000Z")
    if outcome == "OVERSIZE":
        outcome = b"x" * (5 * 1024 * 1024 + 1)  # built here, never shown in a test id
    harness.responses[FEED_URL] = outcome
    svc.sync_calendars(harness.ctx)
    row = next(f for f in svc.list_calendar_feeds(harness.ctx) if f["id"] == feed["id"])
    assert row["last_status"] == "error"
    assert expected in row["last_error"]
    assert SECRET not in row["last_error"] and "https://" not in row["last_error"]
    assert svc.list_calendar_events(harness.ctx, "2026-10-21T00:00:00.000000Z", "2026-10-22T00:00:00.000000Z") == before


def test_sync_never_follows_redirects_and_is_https_only(harness: Harness) -> None:
    add_feed(harness)
    seen: list[str] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, content=b"")

    harness.ctx.transport = httpx.MockTransport(record)
    svc.sync_calendars(harness.ctx)
    assert seen == [FEED_URL] and all(url.startswith("https://") for url in seen)


def test_sync_reports_a_missing_credential_without_a_url(harness: Harness, memory_keyring: Any) -> None:
    feed = add_feed(harness)
    memory_keyring.items.clear()
    svc.sync_calendars(harness.ctx)
    row = next(f for f in svc.list_calendar_feeds(harness.ctx) if f["id"] == feed["id"])
    assert row["last_status"] == "error" and row["has_url"] is False
    assert "Credential Manager" in row["last_error"]


# ---- reads and commands -------------------------------------------------------------------------


def test_list_events_returns_attendees_from_the_feed_only_and_a_link_flag(harness: Harness) -> None:
    add_feed(harness)
    (event,) = svc.list_calendar_events(harness.ctx, "2026-10-21T00:00:00.000000Z", "2026-10-22T00:00:00.000000Z")
    assert event["attendees"] == [
        {"name": "Ada Example", "email": "ada@example.test"},
        {"name": None, "email": "unnamed@example.test"},
    ]
    assert event["has_link"] is True
    assert "meeting_url" not in event and "description" not in event
    assert event["status"] == "tentative"


def test_list_events_skips_cancelled_and_returns_only_the_requested_range(harness: Harness) -> None:
    insert_event(harness.db(), "e-ok", start="2026-10-26T09:00:00.000000Z", end="2026-10-26T09:30:00.000000Z")
    insert_event(harness.db(), "e-cancel", uid="u2", status="cancelled")
    insert_event(harness.db(), "e-later", uid="u3", start="2026-11-05T09:00:00.000000Z", end="2026-11-05T09:30:00.000000Z")
    ids = [e["id"] for e in svc.list_calendar_events(harness.ctx, "2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z")]
    assert ids == ["e-ok"]


def test_link_and_unlink_a_meeting_to_an_event(harness: Harness) -> None:
    insert_event(harness.db(), "event-1")
    insert_meeting(harness.db(), "m-1", "Fictional sync", "2026-10-26T09:00:00.000000Z")
    meeting = svc.link_meeting_event(harness.ctx, "m-1", "event-1")
    assert meeting["id"] == "m-1" and meeting["calendar_event_id"] == "event-1"
    assert svc.link_meeting_event(harness.ctx, "m-1", None)["calendar_event_id"] is None
    with pytest.raises(AppError) as missing_event:
        svc.link_meeting_event(harness.ctx, "m-1", "no-such-event")
    assert missing_event.value.code == "not_found"
    with pytest.raises(AppError) as missing_meeting:
        svc.link_meeting_event(harness.ctx, "no-such-meeting", "event-1")
    assert missing_meeting.value.code == "not_found"


def test_meeting_preparation_lists_related_meetings_with_a_short_excerpt(harness: Harness) -> None:
    insert_event(harness.db(), "event-1", uid="series-1", title="Weekly sync", start="2026-10-26T09:00:00.000000Z")
    insert_meeting(harness.db(), "m-old", "Weekly sync 2026-10-19", "2026-10-19T09:00:00.000000Z")
    insert_meeting(harness.db(), "m-new", "Budget", "2026-10-20T09:00:00.000000Z")
    harness.db().execute("UPDATE notes SET user_markdown=?1 WHERE meeting_id='m-old'", ("n" * 400,))
    harness.db().execute(
        "INSERT INTO summaries (meeting_id, provider, model, template_hash, markdown, transcript_hash) "
        "VALUES ('m-old', 'local', 'fake', 'h', ?1, NULL)",
        ("s" * 350,),
    )
    prep = svc.meeting_preparation(harness.ctx, "event-1")
    assert prep["event"]["id"] == "event-1"
    assert [item["meeting_id"] for item in prep["related"]] == ["m-old"]
    excerpt = prep["related"][0]["summary_excerpt"]
    assert excerpt == "s" * 300
    assert set(prep["related"][0]) == {"meeting_id", "title", "started_at", "summary_excerpt"}


def test_meeting_preparation_falls_back_to_notes_and_returns_null_without_text(harness: Harness) -> None:
    insert_event(harness.db(), "event-1", uid="series-1", title="Weekly sync", start="2026-10-26T09:00:00.000000Z")
    insert_meeting(harness.db(), "m-notes", "Weekly sync", "2026-10-19T09:00:00.000000Z")
    insert_meeting(harness.db(), "m-empty", "Weekly sync", "2026-10-12T09:00:00.000000Z")
    harness.db().execute("UPDATE notes SET user_markdown='Fictional notes' WHERE meeting_id='m-notes'")
    related = {item["meeting_id"]: item["summary_excerpt"] for item in svc.meeting_preparation(harness.ctx, "event-1")["related"]}
    assert related == {"m-notes": "Fictional notes", "m-empty": None}


def test_meeting_preparation_of_an_unknown_event_is_not_found(harness: Harness) -> None:
    with pytest.raises(AppError) as error:
        svc.meeting_preparation(harness.ctx, "nope")
    assert error.value.code == "not_found"


def test_save_calendar_reminders_checks_bounds_and_persists(harness: Harness) -> None:
    settings = svc.save_calendar_reminders(harness.ctx, False, 15)
    assert settings["calendar_reminders"] is False and settings["calendar_reminder_minutes"] == 15
    assert svc.save_calendar_reminders(harness.ctx, True, 0)["calendar_reminder_minutes"] == 0
    for minutes in (-1, 31, True):
        with pytest.raises(AppError) as error:
            svc.save_calendar_reminders(harness.ctx, True, minutes)
        assert error.value.code == "invalid_args"


# ---- reminders and current event ----------------------------------------------------------------


def test_reminder_fires_once_per_instance_while_the_switch_is_on(harness: Harness) -> None:
    insert_event(harness.db(), "soon", start="2026-10-26T08:01:00.000000Z", end="2026-10-26T08:31:00.000000Z",
                 meeting_url="https://zoom.us/j/1")
    insert_meeting(harness.db(), "m-1", "Fictional sync", "2026-10-19T08:00:00.000000Z")
    harness.db().execute("UPDATE meetings SET calendar_event_id='soon' WHERE id='m-1'")
    service = harness.ctx.calendar
    service.tick_reminders(NOW)
    service.tick_reminders(NOW)
    reminders = [payload for name, payload in harness.emitted if name == "calendar_reminder"]
    assert len(reminders) == 1
    assert set(reminders[0]) == {"event_id", "title", "start_utc", "has_link", "related_count"}
    assert reminders[0]["event_id"] == "soon" and reminders[0]["has_link"] is True
    assert reminders[0]["related_count"] == 1  # the linked meeting shares the event's title


def test_reminders_skip_all_day_cancelled_far_and_disabled(harness: Harness) -> None:
    db = harness.db()
    insert_event(db, "allday", uid="a", start="2026-10-26T00:00:00.000000Z", end="2026-10-27T00:00:00.000000Z", all_day=1)
    insert_event(db, "cancelled", uid="b", start="2026-10-26T08:05:00.000000Z", end="2026-10-26T08:30:00.000000Z",
                 status="cancelled")
    insert_event(db, "far", uid="c", start="2026-10-26T12:00:00.000000Z", end="2026-10-26T12:30:00.000000Z")
    service = harness.ctx.calendar
    assert service.tick_reminders(NOW) == []
    svc.save_calendar_reminders(harness.ctx, False, 2)
    insert_event(db, "soon", uid="d", start="2026-10-26T08:01:00.000000Z", end="2026-10-26T08:31:00.000000Z")
    assert service.tick_reminders(NOW) == []
    assert "calendar_reminder" not in harness.names()


def test_reminder_counts_related_meetings_capped_at_five(harness: Harness) -> None:
    insert_event(harness.db(), "soon", uid="series", title="Weekly sync",
                 start="2026-10-26T08:01:00.000000Z", end="2026-10-26T08:31:00.000000Z")
    for index in range(7):
        insert_meeting(harness.db(), f"m-{index}", "Weekly sync", f"2026-10-0{index + 1}T09:00:00.000000Z")
    harness.ctx.calendar.tick_reminders(NOW)
    payload = next(p for n, p in harness.emitted if n == "calendar_reminder")
    assert payload["related_count"] == 5


def test_current_event_uses_five_minute_edges_and_the_earliest_start(harness: Harness) -> None:
    db = harness.db()
    insert_event(db, "late", uid="late", start="2026-10-26T07:58:00.000000Z", end="2026-10-26T08:20:00.000000Z")
    insert_event(db, "early", uid="early", start="2026-10-26T07:50:00.000000Z", end="2026-10-26T08:30:00.000000Z")
    insert_event(db, "ended", uid="ended", start="2026-10-26T06:00:00.000000Z", end="2026-10-26T07:54:00.000000Z")
    insert_event(db, "cancelled", uid="cx", start="2026-10-26T07:50:00.000000Z", end="2026-10-26T08:30:00.000000Z",
                 status="cancelled")
    assert svc.current_event(harness.ctx, NOW)["id"] == "early"
    assert svc.current_event(harness.ctx, dt.datetime(2026, 10, 26, 9, 0, tzinfo=UTC)) is None


def test_current_event_ignores_all_day_events(harness: Harness) -> None:
    insert_event(harness.db(), "holiday", start="2026-10-26T00:00:00.000000Z", end="2026-10-27T00:00:00.000000Z",
                 all_day=1)
    assert svc.current_event(harness.ctx, NOW) is None


def test_service_start_and_stop_are_idempotent_and_stop_joins(harness: Harness) -> None:
    service = harness.ctx.calendar
    service.start()
    service.start()
    assert service._thread is not None and service._thread.daemon
    service.stop()
    assert service._thread is None


OTHER_URL = "https://calendar.example.test/ical/private-TOKEN-XYZ/basic.ics"


def feed_row(h: Harness, feed_id: str) -> dict[str, Any]:
    return next(f for f in svc.list_calendar_feeds(h.ctx) if f["id"] == feed_id)


def test_add_feed_with_out_of_range_dates_records_an_error_row_instead_of_failing(
    harness: Harness, memory_keyring: Any, caplog: pytest.LogCaptureFixture
) -> None:
    harness.responses[FEED_URL] = (FIXTURES / "out_of_range.ics").read_bytes()
    with caplog.at_level(logging.WARNING, logger="openmeet_py"):
        feed = add_feed(harness)  # must return normally; the credential and row are already saved
    assert feed["last_status"] == "error" and feed["last_error"] == svc.UNREADABLE
    assert feed["has_url"] is True
    assert SECRET not in caplog.text and "calendar.example.test" not in caplog.text


def test_unreadable_feed_records_an_error_and_other_feeds_still_sync(
    harness: Harness, caplog: pytest.LogCaptureFixture
) -> None:
    good = add_feed(harness)
    assert good["last_status"] == "ok"
    harness.responses[OTHER_URL] = (FIXTURES / "folded_escaped.ics").read_bytes()
    other = add_feed(harness, label="Other", url=OTHER_URL)
    harness.responses[FEED_URL] = (FIXTURES / "out_of_range.ics").read_bytes()  # the earlier feed goes bad
    harness.requests.clear()
    with caplog.at_level(logging.WARNING, logger="openmeet_py"):
        svc.sync_calendars(harness.ctx)  # must not raise
    assert feed_row(harness, good["id"])["last_status"] == "error"  # previously ok: the failure is recorded
    assert feed_row(harness, good["id"])["last_error"] == svc.UNREADABLE
    assert feed_row(harness, other["id"])["last_status"] == "ok"
    assert OTHER_URL in harness.requests
    assert SECRET not in caplog.text and "calendar.example.test" not in caplog.text


def test_a_feed_that_raises_mid_pass_does_not_stop_the_others_and_advances_the_next_sync(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = add_feed(harness)
    add_feed(harness, label="Other", url=OTHER_URL)
    service = harness.ctx.calendar
    real_sync_feed = service.sync_feed

    def flaky(feed_id: str) -> None:
        if feed_id == first["id"]:
            raise RuntimeError("store locked")
        real_sync_feed(feed_id)

    monkeypatch.setattr(service, "sync_feed", flaky)
    harness.requests.clear()
    service._next_sync = 0.0
    service.sync_all()
    assert OTHER_URL in harness.requests
    assert service._next_sync > time.monotonic()  # set before fetching, so a failing pass is not retried every tick


def test_reminders_keep_ticking_when_a_sync_pass_raises(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    ticked = threading.Event()
    service = svc.CalendarService(harness.ctx, clock=lambda: NOW, tick=0.01, sync_every=3600)

    def broken_sync() -> None:
        raise OverflowError("date value out of range")

    monkeypatch.setattr(service, "sync_all", broken_sync)
    monkeypatch.setattr(service, "tick_reminders", lambda moment=None: ticked.set() or [])
    service.start()
    try:
        assert ticked.wait(5)
    finally:
        service.stop()


class SlowDrip(httpx.SyncByteStream):
    """A response body that never finishes: one byte every 20 ms. Capped at 10 s so a regression fails, not hangs."""

    def __init__(self, started: Optional[threading.Event] = None) -> None:
        self.started = started

    def __iter__(self) -> Iterator[bytes]:
        give_up = time.monotonic() + 10
        while time.monotonic() < give_up:
            time.sleep(0.02)
            if self.started is not None:
                self.started.set()
            yield b"x"


def test_a_dripping_body_is_cut_off_by_the_total_deadline(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    feed = add_feed(harness)
    monkeypatch.setattr(svc, "FETCH_DEADLINE_SECONDS", 0.5)
    harness.responses[FEED_URL] = httpx.Response(200, stream=SlowDrip())
    started = time.monotonic()
    svc.sync_calendars(harness.ctx)
    assert time.monotonic() - started < 5
    row = feed_row(harness, feed["id"])
    assert row["last_status"] == "error" and row["last_error"] == svc.UNREACHABLE


def test_stop_waits_for_an_in_flight_download_to_exit(harness: Harness) -> None:
    add_feed(harness)
    seen = threading.Event()
    harness.responses[FEED_URL] = httpx.Response(200, stream=SlowDrip(seen))  # default 30 s deadline
    service = svc.CalendarService(harness.ctx, clock=lambda: NOW, tick=0.01, sync_every=3600)
    service.start()
    thread = service._thread
    assert thread is not None and seen.wait(5)
    service.stop()
    assert not thread.is_alive() and service._thread is None


def test_httpx_and_httpcore_loggers_are_capped_at_warning() -> None:
    # httpx logs full request URLs, which carry the feed address, at INFO.
    for name in ("httpx", "httpcore"):
        assert logging.getLogger(name).getEffectiveLevel() >= logging.WARNING, name


# ---- command registry and HTTP surface ----------------------------------------------------------


def test_calendar_commands_are_registered() -> None:
    for name in (
        "list_calendar_feeds",
        "add_calendar_feed",
        "remove_calendar_feed",
        "sync_calendars",
        "list_calendar_events",
        "link_meeting_event",
        "meeting_preparation",
        "save_calendar_reminders",
    ):
        assert name in COMMANDS, name


def test_calendar_commands_over_http_use_the_ui_argument_names(client: TestClient) -> None:
    assert invoke(client, "list_calendar_feeds") == []
    status, body = invoke_error(client, "add_calendar_feed", label="Fictional", url="http://calendar.example.test/x.ics")
    assert status == 400 and body["code"] == "calendar_url"
    status, body = invoke_error(client, "save_calendar_reminders", enabled=True, minutes=99)
    assert status == 400 and body["code"] == "invalid_args"
    settings = invoke(client, "save_calendar_reminders", enabled=True, minutes=5)
    assert settings["calendar_reminder_minutes"] == 5
    assert "calendar_reminders" in invoke(client, "get_settings")
