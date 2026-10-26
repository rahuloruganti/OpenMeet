"""Calendar domain: ICS parsing, recurrence, overrides, time zones, title matching and related meetings.

Fictional fixtures only (tests/fixtures/ics). Nothing here touches the network or the Credential Manager.
"""

from __future__ import annotations

import datetime as dt
import logging
import sqlite3
import time
from pathlib import Path

import pytest

from openmeet_py.domain import calendar as cal
from openmeet_py.infra.store import Store

FIXTURES = Path(__file__).parent / "fixtures" / "ics"
UTC = dt.timezone.utc


def utc(*parts: int) -> dt.datetime:
    return dt.datetime(*parts, tzinfo=UTC)


def load(name: str, start: dt.datetime, end: dt.datetime) -> list[cal.EventInstance]:
    return cal.parse_ics((FIXTURES / name).read_text(encoding="utf-8"), start, end)


def by_title(events: list[cal.EventInstance]) -> dict[str, list[cal.EventInstance]]:
    grouped: dict[str, list[cal.EventInstance]] = {}
    for event in events:
        grouped.setdefault(event.title, []).append(event)
    return grouped


OCTOBER_NOVEMBER = (utc(2026, 10, 1), utc(2026, 11, 30))


# ---- recurrence and time zones ------------------------------------------------------------------


def test_weekly_series_keeps_local_nine_oclock_across_the_berlin_dst_change() -> None:
    events = load("weekly_dst_berlin.ics", *OCTOBER_NOVEMBER)
    # Europe/Berlin is CEST until 25 Oct 2026, then CET: 09:00 local is 07:00Z, then 08:00Z.
    assert [event.start_utc for event in events] == [
        utc(2026, 10, 11, 7),
        utc(2026, 10, 18, 7),
        utc(2026, 10, 25, 8),
        utc(2026, 11, 1, 8),
        utc(2026, 11, 8, 8),
        utc(2026, 11, 15, 8),
    ]
    assert all(event.end_utc - event.start_utc == dt.timedelta(hours=1) for event in events)
    assert all(event.recurrence_id is None and event.status == "confirmed" for event in events)


def test_window_edges_select_only_the_instances_that_overlap_it() -> None:
    events = load("weekly_dst_berlin.ics", utc(2026, 10, 18, 7, 30), utc(2026, 10, 25, 8))
    # 18 Oct 07:00Z ends at 08:00Z (overlaps); 25 Oct 08:00Z starts at the window end (excluded).
    assert [event.start_utc for event in events] == [utc(2026, 10, 18, 7)]


def test_rdate_and_exdate_add_and_remove_instances() -> None:
    text = (
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:rd@example.test\r\n"
        "DTSTART;TZID=Europe/Berlin:20261011T090000\r\nDTEND;TZID=Europe/Berlin:20261011T100000\r\n"
        "RRULE:FREQ=WEEKLY;COUNT=3\r\n"
        "EXDATE;TZID=Europe/Berlin:20261018T090000\r\n"
        "RDATE;TZID=Europe/Berlin:20261103T150000\r\n"
        "SUMMARY:Fictional extra\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    )
    events = cal.parse_ics(text, *OCTOBER_NOVEMBER)
    assert [event.start_utc for event in events] == [
        utc(2026, 10, 11, 7),
        utc(2026, 10, 25, 8),
        utc(2026, 11, 3, 14),
    ]


def test_override_moves_one_instance_and_hides_the_original() -> None:
    events = load("exception_moved.ics", *OCTOBER_NOVEMBER)
    assert [event.start_utc for event in events] == [
        utc(2026, 10, 11, 7),
        utc(2026, 10, 19, 12),
        utc(2026, 10, 25, 8),
    ]
    moved = [event for event in events if event.recurrence_id is not None]
    assert len(moved) == 1
    assert moved[0].title == "Fictional planning (moved)"
    assert moved[0].recurrence_id == "2026-10-18T07:00:00.000000Z"


def test_cancelled_single_event_and_cancelled_instance_are_kept_with_status() -> None:
    grouped = by_title(load("cancelled.ics", *OCTOBER_NOVEMBER))
    assert [e.status for e in grouped["Fictional cancelled call"]] == ["cancelled"]
    series = grouped["Fictional series"]
    # COUNT=3: the 18 Oct original is replaced by its cancelled override, which keeps its recurrence id.
    assert [(e.start_utc, e.status) for e in series] == [
        (utc(2026, 10, 11, 7), "confirmed"),
        (utc(2026, 10, 18, 7), "cancelled"),
        (utc(2026, 10, 25, 8), "confirmed"),
    ]
    assert series[1].recurrence_id == "2026-10-18T07:00:00.000000Z"


def test_all_day_event_starts_at_local_midnight_and_is_flagged() -> None:
    (event,) = load("all_day.ics", *OCTOBER_NOVEMBER)
    assert event.all_day is True
    assert event.start_utc == dt.datetime(2026, 10, 30).astimezone(UTC)
    assert event.end_utc == dt.datetime(2026, 10, 31).astimezone(UTC)


def test_floating_time_is_read_as_local_time() -> None:
    (event,) = load("floating.ics", *OCTOBER_NOVEMBER)
    assert event.all_day is False
    assert event.start_utc == dt.datetime(2026, 10, 27, 10, 30).astimezone(UTC)
    assert event.end_utc == dt.datetime(2026, 10, 27, 11, 15).astimezone(UTC)


def test_bom_and_crlf_feed_parses() -> None:
    raw = (FIXTURES / "bom_crlf.ics").read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf") and b"\r\n" in raw
    events = cal.parse_ics(raw.decode("utf-8"), *OCTOBER_NOVEMBER)
    assert [event.title for event in events] == ["Fictional floating call"]


def test_outlook_windows_zone_with_duration_and_teams_link() -> None:
    (event,) = load("outlook_tzid.ics", *OCTOBER_NOVEMBER)
    assert event.start_utc == utc(2026, 10, 26, 9)
    assert event.end_utc == utc(2026, 10, 26, 9, 45)
    assert cal.meeting_url(event) == "https://teams.microsoft.com/l/meetup-join/fictional"


def test_event_without_end_or_duration_is_zero_length() -> None:
    text = (
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:point@example.test\r\n"
        "DTSTART:20261021T120000Z\r\nSUMMARY:Fictional reminder point\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    )
    (event,) = cal.parse_ics(text, *OCTOBER_NOVEMBER)
    assert event.start_utc == event.end_utc == utc(2026, 10, 21, 12)


def test_unknown_time_zone_is_skipped_not_guessed() -> None:
    text = (
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:nozone@example.test\r\n"
        "DTSTART;TZID=Nowhere/Fictional:20261021T120000\r\nDTEND;TZID=Nowhere/Fictional:20261021T130000\r\n"
        "SUMMARY:Fictional unknown zone\r\nEND:VEVENT\r\n"
        "BEGIN:VEVENT\r\nUID:known@example.test\r\n"
        "DTSTART;TZID=Europe/Berlin:20261021T120000\r\nDTEND;TZID=Europe/Berlin:20261021T130000\r\n"
        "SUMMARY:Fictional known zone\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    )
    events = cal.parse_ics(text, *OCTOBER_NOVEMBER)
    assert [event.title for event in events] == ["Fictional known zone"]


def test_text_that_is_not_a_calendar_raises_value_error() -> None:
    with pytest.raises(ValueError):
        cal.parse_ics("<html>not a calendar</html>", *OCTOBER_NOVEMBER)


def test_window_must_be_timezone_aware_and_ordered() -> None:
    with pytest.raises(ValueError):
        cal.parse_ics("", dt.datetime(2026, 10, 1), utc(2026, 10, 2))
    with pytest.raises(ValueError):
        cal.parse_ics("", utc(2026, 10, 2), utc(2026, 10, 1))


# ---- overlap, text fields, attendees ------------------------------------------------------------


def test_overlapping_events_are_returned_in_start_order_with_edges_excluded() -> None:
    window = (utc(2026, 10, 20), utc(2026, 10, 21))
    titles = [event.title for event in load("overlap.ics", *window)]
    assert titles == [
        "Fictional overlap C",
        "Fictional overlap A",
        "Fictional overlap B",
        "Fictional overlap D",
    ]


def test_text_escapes_folding_and_attendees_come_from_the_feed_only() -> None:
    (event,) = load("folded_escaped.ics", *OCTOBER_NOVEMBER)
    assert event.title == "Fictional roadmap, review"
    assert event.description == "Agenda: budget\nnotes and a long folded line that continues here on the next line."
    assert event.location == "Fictional room 4"
    assert event.status == "tentative"
    assert event.attendees == (
        {"name": "Ada Example", "email": "ada@example.test"},
        {"name": None, "email": "unnamed@example.test"},
    )
    assert cal.meeting_url(event) == "https://meet.google.com/fic-tion-al"


def test_missing_summary_gets_a_placeholder_title() -> None:
    text = (
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:untitled@example.test\r\n"
        "DTSTART:20261021T120000Z\r\nDTEND:20261021T121000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    )
    (event,) = cal.parse_ics(text, *OCTOBER_NOVEMBER)
    assert event.title == "Untitled event"


# ---- title normalization ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("title", "expected"),
    [
        ("Weekly sync", "weekly sync"),
        ("  Weekly   Sync  ", "weekly sync"),
        ("Weekly sync 2026-10-25", "weekly sync"),
        ("Weekly sync 25.10.2026", "weekly sync"),
        ("Weekly sync #12", "weekly sync"),
        ("Weekly sync - 3", "weekly sync"),
        ("Weekly sync (copy)", "weekly sync"),
        ("Weekly sync (Copy) 4", "weekly sync"),
        ("Q3 2026 planning", "q3 2026 planning"),
        ("   ", ""),
    ],
)
def test_normalize_title_strips_recurring_suffixes(title: str, expected: str) -> None:
    assert cal.normalize_title(title) == expected


# ---- meeting links ------------------------------------------------------------------------------


def event_with(location: str | None = None, description: str | None = None, extra: str = "") -> cal.EventInstance:
    return cal.EventInstance(
        uid="link@example.test",
        recurrence_id=None,
        start_utc=utc(2026, 10, 21, 12),
        end_utc=utc(2026, 10, 21, 13),
        all_day=False,
        title="Fictional link check",
        location=location,
        description=description,
        status="confirmed",
        attendees=(),
        links_text=extra,
    )


@pytest.mark.parametrize(
    ("location", "description", "extra", "expected"),
    [
        ("https://zoom.us/j/1234567890", None, "", "https://zoom.us/j/1234567890"),
        (None, "Join: https://meet.google.com/abc-defg-hij.", "", "https://meet.google.com/abc-defg-hij"),
        (None, None, "https://acme.webex.com/acme/j.php?MTID=x", "https://acme.webex.com/acme/j.php?MTID=x"),
        ("Room 4", "https://teams.microsoft.com/l/meetup-join/x", "", "https://teams.microsoft.com/l/meetup-join/x"),
        ("http://zoom.us/j/1", None, "", None),  # not https
        ("https://example.test/meeting", None, "", None),  # not a known meeting host
        (None, None, "", None),
    ],
)
def test_meeting_url_finds_known_https_meeting_links_only(
    location: str | None, description: str | None, extra: str, expected: str | None
) -> None:
    assert cal.meeting_url(event_with(location, description, extra)) == expected


# ---- related meetings ---------------------------------------------------------------------------


def seed_meeting(db: sqlite3.Connection, meeting_id: str, title: str, started_at: str, event: str | None = None) -> None:
    db.execute(
        "INSERT INTO meetings (id, title, started_at, source, status, calendar_event_id) "
        "VALUES (?1, ?2, ?3, 'note', 'stopped', ?4)",
        (meeting_id, title, started_at, event),
    )


def seed_event(db: sqlite3.Connection, event_id: str, uid: str, start: str) -> None:
    db.execute(
        "INSERT OR IGNORE INTO calendar_feeds (id, label, kind, created_at) VALUES ('feed-1', 'Fictional', 'ics', ?1)",
        (start,),
    )
    db.execute(
        "INSERT INTO calendar_events (id, feed_id, uid, start_utc, end_utc, title, status) "
        "VALUES (?1, 'feed-1', ?2, ?3, ?3, 'Fictional event', 'confirmed')",
        (event_id, uid, start),
    )


def test_related_meetings_match_by_uid_or_title_newest_first_and_cap_at_five(tmp_path: Path) -> None:
    store = Store(tmp_path / "data")
    db = store.db
    start = "2026-10-26T09:00:00.000000Z"
    seed_event(db, "event-1", "series@example.test", start)
    seed_meeting(db, "m-linked", "Fictional kickoff", "2026-10-01T09:00:00.000000Z", "event-1")
    seed_meeting(db, "m-title", "Weekly sync 2026-10-19", "2026-10-19T09:00:00.000000Z")
    seed_meeting(db, "m-other", "Budget review", "2026-10-18T09:00:00.000000Z")
    seed_meeting(db, "m-after", "Weekly sync", "2026-10-30T09:00:00.000000Z")
    for index in range(5):
        seed_meeting(db, f"m-old-{index}", "Weekly sync", f"2026-09-0{index + 1}T09:00:00.000000Z")
    event = cal.StoredEvent(id="event-1", uid="series@example.test", title="Weekly sync", start_utc=start)
    related = cal.related_meetings(db, event)
    assert [item["meeting_id"] for item in related] == [
        "m-title",
        "m-linked",
        "m-old-4",
        "m-old-3",
        "m-old-2",
    ]
    assert len(related) == cal.MAX_RELATED
    assert related[0] == {
        "meeting_id": "m-title",
        "title": "Weekly sync 2026-10-19",
        "started_at": "2026-10-19T09:00:00.000000Z",
    }
    store.close()


def test_related_meetings_with_no_title_or_uid_match_is_empty(tmp_path: Path) -> None:
    store = Store(tmp_path / "data")
    seed_meeting(store.db, "m-1", "Budget review", "2026-10-01T09:00:00.000000Z")
    event = cal.StoredEvent(id="e", uid="none@example.test", title="Planning", start_utc="2026-10-26T09:00:00.000000Z")
    assert cal.related_meetings(store.db, event) == []
    store.close()


def test_stored_event_start_is_formatted_like_meeting_times() -> None:
    event = cal.parse_ics((FIXTURES / "floating.ics").read_text(encoding="utf-8"), *OCTOBER_NOVEMBER)[0]
    assert cal.iso(event.start_utc) == dt.datetime(2026, 10, 27, 10, 30).astimezone(UTC).strftime(
        "%Y-%m-%dT%H:%M:%S.%fZ"
    )


def test_event_key_is_stable_for_the_same_instance() -> None:
    event = load("weekly_dst_berlin.ics", *OCTOBER_NOVEMBER)[0]
    first = cal.event_key("feed-1", event)
    assert first == cal.event_key("feed-1", event)
    assert first != cal.event_key("feed-2", event)
    assert len(first) == 32


# ---- recurrence budget, unresolved zones, THISANDFUTURE overrides -------------------------------


@pytest.mark.parametrize("prop", ["EXDATE", "RDATE"])
def test_unresolved_zone_on_an_exdate_or_rdate_skips_the_series(prop: str) -> None:
    # The zone name cannot be resolved, so the series is skipped, never read as the PC's local time.
    # The outcome is the same in every PC time zone.
    text = (
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:unresolved@example.test\r\n"
        "DTSTART;TZID=Europe/Berlin:20261011T090000\r\nDTEND;TZID=Europe/Berlin:20261011T100000\r\n"
        "RRULE:FREQ=WEEKLY;COUNT=3\r\n"
        f"{prop};TZID=Unknown/Zone:20261018T090000\r\n"
        "SUMMARY:Fictional unresolved series\r\nEND:VEVENT\r\n"
        "BEGIN:VEVENT\r\nUID:known@example.test\r\nDTSTART:20261021T120000Z\r\nDTEND:20261021T130000Z\r\n"
        "SUMMARY:Fictional known event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    )
    assert [event.title for event in cal.parse_ics(text, *OCTOBER_NOVEMBER)] == ["Fictional known event"]


def test_this_and_future_override_shifts_that_instance_and_every_later_one() -> None:
    events = load("this_and_future.ics", *OCTOBER_NOVEMBER)
    assert [(e.start_utc, e.end_utc, e.title, e.recurrence_id) for e in events] == [
        (utc(2026, 10, 11, 7), utc(2026, 10, 11, 8), "Fictional standup", None),
        (utc(2026, 10, 18, 9), utc(2026, 10, 18, 9, 30), "Fictional standup (later)", "2026-10-18T07:00:00.000000Z"),
        (utc(2026, 10, 25, 10), utc(2026, 10, 25, 10, 30), "Fictional standup (later)", "2026-10-25T08:00:00.000000Z"),
        (utc(2026, 11, 1, 10), utc(2026, 11, 1, 10, 30), "Fictional standup (later)", "2026-11-01T08:00:00.000000Z"),
    ]


def test_runaway_rule_from_long_ago_is_skipped_within_the_step_budget(caplog: pytest.LogCaptureFixture) -> None:
    started = time.monotonic()
    with caplog.at_level(logging.WARNING, logger="openmeet_py"):
        titles = [event.title for event in load("runaway_rule.ics", *OCTOBER_NOVEMBER)]
    assert time.monotonic() - started < 2.0
    assert titles == ["Fictional plain event"]
    assert "step budget" in caplog.text


def test_occurrences_are_capped_at_max_while_expanding_inside_the_window() -> None:
    text = (
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:minutely@example.test\r\n"
        "DTSTART:20261001T000000Z\r\nDTEND:20261001T000100Z\r\nRRULE:FREQ=MINUTELY\r\n"
        "SUMMARY:Fictional minutely\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    )
    started = time.monotonic()
    events = cal.parse_ics(text, *OCTOBER_NOVEMBER)
    assert len(events) == cal.MAX_OCCURRENCES
    assert time.monotonic() - started < 2.0
