"""Calendar context: ICS parsing, recurrence expansion, title matching, meeting links, related meetings.

Pure functions over text and the database. Nothing here opens a connection or writes a row; the sync
service in api/calendar.py does that. Floating times are read as this PC's local time. Time zones come
from icalendar, which resolves TZID names through zoneinfo (tzdata); a TZID it cannot resolve is skipped.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import logging
import re
import sqlite3
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import urlsplit

from dateutil.rrule import rrulestr
from icalendar import Calendar

UTC = dt.timezone.utc
TIME_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"
MAX_RELATED = 5
MAX_OCCURRENCES = 2000  # per series, inside the window; a runaway rule cannot grow the table
RULE_STEP_BUDGET = 100_000  # rule steps per series, counted from DTSTART; a series past it is skipped
MAX_ATTENDEES = 50
MAX_TITLE = 200
MAX_LOCATION = 500
MAX_DESCRIPTION = 4000
MEETING_HOSTS = ("teams.microsoft.com", "teams.live.com", "zoom.us", "meet.google.com", "webex.com")
_URL = re.compile(r"https://[^\s<>\"']+", re.IGNORECASE)
_UNTIL = re.compile(r"UNTIL=([0-9]{8}(?:T[0-9]{6})?)Z?")
_COPY = re.compile(r"\((?:copy|kopie)\)", re.IGNORECASE)
_DATE = re.compile(r"\b\d{4}[-./]\d{1,2}[-./]\d{1,2}\b|\b\d{1,2}[-./]\d{1,2}[-./]\d{2,4}\b")
_COUNTER = re.compile(r"[\s\-–—:|#,]*(?:no\.?|nr\.?|week|wk|session|#)?\s*\d+\s*$", re.IGNORECASE)
log = logging.getLogger("openmeet_py")


@dataclass(frozen=True)
class EventInstance:
    """One occurrence (or overridden occurrence) inside a sync window, as the feed describes it."""

    uid: str
    recurrence_id: Optional[str]  # UTC original start of an overridden instance; None otherwise
    start_utc: dt.datetime
    end_utc: dt.datetime
    all_day: bool
    title: str
    location: Optional[str]
    description: Optional[str]
    status: str  # confirmed, tentative or cancelled
    attendees: tuple[dict[str, Optional[str]], ...]
    links_text: str = ""  # X- and URL property values; scanned for meeting links, never returned


@dataclass(frozen=True)
class StoredEvent:
    """An event row as the database holds it, for matching against meetings."""

    id: str
    uid: str
    title: str
    start_utc: str  # TIME_FORMAT text, the same form meetings.started_at uses


class _Skip(Exception):
    """An event the feed describes in a way this build will not guess at (e.g. an unknown TZID)."""


# ---- times ----------------------------------------------------------------------------------------


def iso(value: dt.datetime) -> str:
    return value.astimezone(UTC).strftime(TIME_FORMAT)


def _wall(prop: Any) -> tuple[dt.datetime, bool]:
    """A DTSTART-like property as (wall time, all_day). Dates become local midnight."""
    value = getattr(prop, "dt", prop)
    tzid = prop.params.get("TZID") if hasattr(prop, "params") else None
    if isinstance(value, dt.datetime):
        if tzid and value.tzinfo is None:
            raise _Skip()  # icalendar could not resolve the zone name
        return value, False
    if isinstance(value, dt.date):
        return dt.datetime.combine(value, dt.time()), True
    raise _Skip()


def _utc(value: dt.datetime) -> dt.datetime:
    # Naive values are local wall time (floating); astimezone applies this PC's zone rules, DST included.
    return value.astimezone(UTC)


def _as_list(prop: Any) -> list[Any]:
    if prop is None:
        return []
    return prop if isinstance(prop, list) else [prop]


def _dated_values(component: Any, name: str) -> list[dt.datetime]:
    """Wall times of EXDATE or RDATE values. Periods are skipped; a value that cannot be read is dropped.

    A TZID that icalendar could not resolve skips the whole series, as it does for DTSTART.
    """
    values: list[dt.datetime] = []
    for prop in _as_list(component.get(name)):
        tzid = prop.params.get("TZID") if hasattr(prop, "params") else None
        for item in getattr(prop, "dts", []):
            value = getattr(item, "dt", item)
            if isinstance(value, dt.datetime):
                if tzid and value.tzinfo is None:
                    raise _Skip()  # icalendar could not resolve the zone name
                values.append(value)
            elif isinstance(value, dt.date):
                values.append(dt.datetime.combine(value, dt.time()))
    return values


def _span(component: Any, start: dt.datetime, all_day: bool) -> Any:
    """Duration: a timedelta for timed events, whole days for all-day events."""
    end_prop = component.get("DTEND")
    duration_prop = component.get("DURATION")
    if end_prop is not None:
        end, end_all_day = _wall(end_prop)
        if all_day:
            return max(0, (end.date() - start.date()).days) if end_all_day else 1
        return max(dt.timedelta(0), _utc(end) - _utc(start))
    if duration_prop is not None:
        amount = getattr(duration_prop, "dt", duration_prop)
        if all_day:
            return max(1, amount.days or 1)
        return amount
    return 1 if all_day else dt.timedelta(0)


def _instance_bounds(start: dt.datetime, all_day: bool, span: Any) -> tuple[dt.datetime, dt.datetime]:
    if all_day:
        # Whole days are counted on the wall clock, so a day that crosses a DST change still ends at midnight.
        return _utc(start), _utc(start + dt.timedelta(days=span))
    start_utc = _utc(start)
    return start_utc, start_utc + span


def _rule_text(component: Any, aware: bool) -> Optional[str]:
    rules = _as_list(component.get("RRULE"))
    if not rules:
        return None
    text = rules[0].to_ical().decode("utf-8")

    def normalize(match: re.Match[str]) -> str:
        stamp = match.group(1)
        if "T" not in stamp:
            stamp += "T235959"  # a date-only UNTIL includes that whole day
        return f"UNTIL={stamp}Z" if aware else f"UNTIL={stamp}"

    return _UNTIL.sub(normalize, text)


def _starts(component: Any, start: dt.datetime, span: Any, lower: dt.datetime, upper: dt.datetime) -> list[dt.datetime]:
    """Wall start times of one series inside [lower, upper], minus EXDATEs, plus RDATEs.

    Raises _Skip when the series cannot be read safely (an unresolved zone, or a rule past its step budget).
    """
    aware = start.tzinfo is not None
    walls: set[dt.datetime] = {start}
    text = _rule_text(component, aware)
    if text is not None:
        try:
            rule = rrulestr(text, dtstart=start)
            if aware:
                low, high = lower, upper
            else:
                low = lower.astimezone().replace(tzinfo=None)
                high = upper.astimezone().replace(tzinfo=None)
            walls.update(_rule_walls(rule, low, high))
        except (ValueError, TypeError, OverflowError):
            pass  # an unreadable rule leaves just the DTSTART instance
    walls.update(_dated_values(component, "RDATE"))
    excluded = {iso(_utc(value)) for value in _dated_values(component, "EXDATE") if _safe_utc(value)}
    kept = [wall for wall in walls if iso(_utc(wall)) not in excluded]
    return sorted(kept, key=_utc)


def _rule_walls(rule: Any, low: dt.datetime, high: dt.datetime) -> list[dt.datetime]:
    """Occurrences of a rule inside [low, high]. Stops at high, at MAX_OCCURRENCES, or skips the series.

    Iterating from DTSTART is the only way to reach the window, so the step budget bounds the work a
    runaway rule (e.g. SECONDLY from 1990) can cost while another sync waits on the lock.
    """
    found: list[dt.datetime] = []
    for steps, wall in enumerate(rule, start=1):
        if steps > RULE_STEP_BUDGET:
            log.warning("calendar series skipped: its recurrence rule exceeds the step budget")
            raise _Skip()
        if wall > high:
            break
        if wall >= low:
            found.append(wall)
            if len(found) >= MAX_OCCURRENCES:
                break
    return found


def _safe_utc(value: dt.datetime) -> bool:
    try:
        _utc(value)
    except (OverflowError, OSError, ValueError):
        return False
    return True


# ---- text fields ----------------------------------------------------------------------------------


def _text(prop: Any, limit: int) -> Optional[str]:
    if prop is None:
        return None
    value = str(prop).strip()
    return value[:limit] if value else None


def _status(component: Any) -> str:
    raw = str(component.get("STATUS") or "").strip().upper()
    if raw == "CANCELLED":
        return "cancelled"
    if raw == "TENTATIVE":
        return "tentative"
    return "confirmed"


def _attendees(component: Any) -> tuple[dict[str, Optional[str]], ...]:
    found: list[dict[str, Optional[str]]] = []
    for prop in _as_list(component.get("ATTENDEE")):
        address = str(prop).strip()
        if address.lower().startswith("mailto:"):
            address = address[7:]
        address = address.strip()
        if "@" not in address or len(address) > 320:
            continue
        label = prop.params.get("CN") if hasattr(prop, "params") else None
        name = str(label).strip()[:120] if label else ""
        found.append({"name": name or None, "email": address})
        if len(found) == MAX_ATTENDEES:
            break
    return tuple(found)


def _links_text(component: Any) -> str:
    parts: list[str] = []
    for key in component.keys():
        if str(key).upper().startswith("X-") or str(key).upper() == "URL":
            for prop in _as_list(component.get(key)):
                parts.append(str(prop))
    return " ".join(parts)


def _event(
    component: Any,
    uid: str,
    start: dt.datetime,
    all_day: bool,
    span: Any,
    recurrence_id: Optional[str],
    status: str,
) -> EventInstance:
    start_utc, end_utc = _instance_bounds(start, all_day, span)
    return EventInstance(
        uid=uid,
        recurrence_id=recurrence_id,
        start_utc=start_utc,
        end_utc=end_utc,
        all_day=all_day,
        title=_text(component.get("SUMMARY"), MAX_TITLE) or "Untitled event",
        location=_text(component.get("LOCATION"), MAX_LOCATION),
        description=_text(component.get("DESCRIPTION"), MAX_DESCRIPTION),
        status=status,
        attendees=_attendees(component),
        links_text=_links_text(component),
    )


def _uid(component: Any) -> Optional[str]:
    uid = str(component.get("UID") or "").strip()
    return uid[:255] or None


def _overlaps(event: EventInstance, lower: dt.datetime, upper: dt.datetime) -> bool:
    if event.start_utc == event.end_utc:
        return lower <= event.start_utc < upper
    return event.start_utc < upper and event.end_utc > lower


# ---- parsing --------------------------------------------------------------------------------------


def parse_ics(text: str, window_start: dt.datetime, window_end: dt.datetime) -> list[EventInstance]:
    """Every event instance that overlaps [window_start, window_end), sorted by start.

    Raises ValueError when the text is not a calendar or the window is not timezone-aware and ordered.
    Events the feed describes in a way this build will not guess at are skipped, not raised.
    """
    if window_start.tzinfo is None or window_end.tzinfo is None or window_end <= window_start:
        raise ValueError("The calendar window must be timezone-aware and end after it starts.")
    if "BEGIN:VCALENDAR" not in text[:8192].upper():
        raise ValueError("The feed is not an iCalendar calendar.")
    try:
        calendar = Calendar.from_ical(text.lstrip("\ufeff"))
    except Exception as error:  # icalendar raises several types for malformed text
        raise ValueError("The feed is not an iCalendar calendar.") from error

    components = list(calendar.walk("VEVENT"))
    masters = [c for c in components if c.get("RECURRENCE-ID") is None]
    overrides = [c for c in components if c.get("RECURRENCE-ID") is not None]

    # Instances replaced by an override (moved or cancelled) must not also appear from the series.
    replaced: set[tuple[str, str]] = set()
    for component in overrides:
        uid = _uid(component)
        try:
            original, _ = _wall(component.get("RECURRENCE-ID"))
        except _Skip:
            continue
        if uid:
            replaced.add((uid, iso(original)))

    found: list[EventInstance] = []
    ranges = _ranges(overrides)
    for component in masters:
        uid = _uid(component)
        if uid is None or component.get("DTSTART") is None:
            continue
        try:
            start, all_day = _wall(component.get("DTSTART"))
            span = _span(component, start, all_day)
            lower = window_start - _span_margin(span) - dt.timedelta(days=1)
            upper = window_end + dt.timedelta(days=1)
            walls = _starts(component, start, span, lower, upper)
        except _Skip:
            continue
        status = _status(component)
        for wall in walls:
            original = _utc(wall)
            if (uid, iso(original)) in replaced:
                continue
            shift = _applicable_range(ranges.get(uid, []), original)
            if shift is None:
                instance = _event(component, uid, wall, all_day, span, None, status)
            else:
                instance = _range_event(shift, uid, original)
            if _overlaps(instance, window_start, window_end):
                found.append(instance)

    for component in overrides:
        uid = _uid(component)
        if uid is None or component.get("DTSTART") is None:
            continue
        try:
            original, _ = _wall(component.get("RECURRENCE-ID"))
            start, all_day = _wall(component.get("DTSTART"))
            span = _span(component, start, all_day)
        except _Skip:
            continue
        instance = _event(
            component, uid, start, all_day, span, iso(_utc(original)), _status(component)
        )
        if _overlaps(instance, window_start, window_end):
            found.append(instance)

    found.sort(key=lambda event: (event.start_utc, event.uid, event.recurrence_id or ""))
    return found


def _span_margin(span: Any) -> dt.timedelta:
    if isinstance(span, int):
        return dt.timedelta(days=span)
    return span


@dataclass(frozen=True)
class _Range:
    """A RECURRENCE-ID;RANGE=THISANDFUTURE override: its start shift and new properties apply to later instances."""

    original: dt.datetime  # UTC start of the first instance it replaces
    delta: dt.timedelta  # how far the override moves that instance
    component: Any
    all_day: bool
    span: Any
    status: str


def _ranges(overrides: list[Any]) -> dict[str, list[_Range]]:
    found: dict[str, list[_Range]] = {}
    for component in overrides:
        uid = _uid(component)
        recurrence = component.get("RECURRENCE-ID")
        if uid is None or component.get("DTSTART") is None or recurrence is None:
            continue
        if str(recurrence.params.get("RANGE", "")).upper() != "THISANDFUTURE":
            continue
        try:
            original, _ = _wall(recurrence)
            start, all_day = _wall(component.get("DTSTART"))
            span = _span(component, start, all_day)
            original_utc = _utc(original)
            delta = _utc(start) - original_utc
        except _Skip:
            continue
        found.setdefault(uid, []).append(_Range(original_utc, delta, component, all_day, span, _status(component)))
    for ranges in found.values():
        ranges.sort(key=lambda rng: rng.original)
    return found


def _applicable_range(ranges: list[_Range], original: dt.datetime) -> Optional[_Range]:
    """The latest THISANDFUTURE override that starts before this instance, if any."""
    chosen: Optional[_Range] = None
    for rng in ranges:
        if rng.original >= original:
            break
        chosen = rng
    return chosen


def _range_event(rng: _Range, uid: str, original: dt.datetime) -> EventInstance:
    return _event(rng.component, uid, original + rng.delta, rng.all_day, rng.span, iso(original), rng.status)


def event_key(feed_id: str, event: EventInstance) -> str:
    """A stable row id for one instance. Re-syncing the same instance keeps its id, so links survive."""
    raw = f"{feed_id}\n{event.uid}\n{event.recurrence_id or ''}\n{iso(event.start_utc)}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


# ---- matching -------------------------------------------------------------------------------------


def normalize_title(title: str) -> str:
    """Lowercase title with recurring suffixes removed: dates, counters and '(copy)'."""
    text = _COPY.sub(" ", title.lower())
    text = _DATE.sub(" ", text)
    previous = None
    while previous != text:
        previous = text
        text = _COUNTER.sub("", text)
    return " ".join(text.split()).strip(" -–—:|,.#")


def meeting_url(event: EventInstance) -> Optional[str]:
    """The first https link to a known meeting host, looking at location, then X-/URL properties, then description."""
    for field in (event.location or "", event.links_text, event.description or ""):
        for match in _URL.finditer(field):
            candidate = match.group(0).rstrip(".,;:)]")
            host = urlsplit(candidate).hostname or ""
            if any(host == known or host.endswith("." + known) for known in MEETING_HOSTS):
                return candidate
    return None


def related_meetings(db: sqlite3.Connection, event: StoredEvent) -> list[dict[str, str]]:
    """Meetings that started before this event and are linked to the same series or share its title.

    Newest first, at most MAX_RELATED. Titles are compared after normalize_title.
    """
    event_ids = {
        row[0] for row in db.execute("SELECT id FROM calendar_events WHERE uid = ?1", (event.uid,))
    }
    wanted = normalize_title(event.title)
    rows = db.execute(
        "SELECT id, title, started_at, calendar_event_id FROM meetings WHERE started_at < ?1 "
        "ORDER BY started_at DESC, id DESC",
        (event.start_utc,),
    ).fetchall()
    related: list[dict[str, str]] = []
    for meeting_id, title, started_at, linked in rows:
        same_series = linked is not None and linked in event_ids
        same_title = bool(wanted) and normalize_title(title) == wanted
        if not (same_series or same_title):
            continue
        related.append({"meeting_id": meeting_id, "title": title, "started_at": started_at})
        if len(related) == MAX_RELATED:
            break
    return related
