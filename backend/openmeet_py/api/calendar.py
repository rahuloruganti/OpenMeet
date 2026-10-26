"""Calendar feeds: read-only ICS subscriptions, the sync thread, reminders and the calendar commands.

A feed address is a secret. It is stored only in the Credential Manager under the account 'calendar:<feed id>'.
SQLite, logs, responses and events carry the feed id, a status and a user-safe message, never the address.
OpenMeet only reads feeds; it never writes to a calendar.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import sqlite3
import threading
import time
import uuid
from typing import Any, Callable, Optional
from urllib.parse import urlsplit

import httpx

from openmeet_py.api import reads
from openmeet_py.api.context import Context, bool_arg, has_control, int_arg, now, optional_text_arg, text_arg
from openmeet_py.api.errors import AppError
from openmeet_py.domain import calendar as cal
from openmeet_py.infra.store import transaction
from openmeet_py.platform import keys

log = logging.getLogger("openmeet_py")

SYNC_SECONDS = 15 * 60
TICK_SECONDS = 30.0
FETCH_TIMEOUT_SECONDS = 20.0  # per socket read
FETCH_DEADLINE_SECONDS = 30.0  # total for one download, checked per streamed chunk
MAX_BODY_BYTES = 5 * 1024 * 1024
WINDOW_BEFORE = dt.timedelta(days=30)
WINDOW_AFTER = dt.timedelta(days=60)
EDGE = dt.timedelta(minutes=5)  # auto-capture: how far outside an event's start and end it still counts
REMINDER_GRACE = dt.timedelta(seconds=60)
CREDENTIAL_PREFIX = "calendar:"
MAX_LABEL = 80
MAX_URL = 2048
MAX_EVENTS = 500
EXCERPT_CHARS = 300
UNREACHABLE = "The calendar could not be reached. It will be tried again at the next sync."
UNREADABLE = "The calendar could not be read."
NOT_CALENDAR = "The feed is not an iCalendar calendar. Check the iCal address."
BAD_ADDRESS = "The calendar address must be https."
BAD_URL = (
    "Paste the secret iCal address that ends in .ics: Google 'Secret address in iCal format' "
    "or the Outlook published ICS link."
)
EVENT_COLUMNS = (
    "id, feed_id, title, start_utc, end_utc, all_day, location, status, attendees_json, meeting_url, uid"
)
FEED_COLUMNS = "id, label, kind, last_sync_at, last_status, last_error"

for _noisy in ("httpx", "httpcore"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)  # httpx logs full request URLs, feed addresses included, at INFO


class _Failed(Exception):
    """A sync failure whose message is safe to show the user."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def _keychain() -> AppError:
    return AppError(
        "keychain_unavailable",
        "The OS credential store could not be used. Check Settings and try again.",
    )


class CalendarService:
    """Sync thread (every 15 minutes), reminder ticks (every 30 seconds) and on-demand syncs.

    Network I/O never holds the store lock. Syncs are serialized by one lock, so a command and the
    thread never fetch the same feed at once.
    """

    def __init__(
        self,
        ctx: Context,
        clock: Optional[Callable[[], dt.datetime]] = None,
        tick: float = TICK_SECONDS,
        sync_every: float = SYNC_SECONDS,
    ) -> None:
        self.ctx = ctx
        self._clock = clock or (lambda: dt.datetime.now(dt.timezone.utc))
        self._tick = tick
        self._sync_every = sync_every
        self._sync_lock = threading.Lock()
        self._reminder_lock = threading.Lock()
        self._reminded: set[str] = set()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._next_sync = 0.0  # monotonic: the first tick syncs

    def start(self) -> None:
        if self._thread is None:
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name="openmeet-calendar", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            # Every blocking step (the download, the reminder tick, the sync loop) checks the stop flag,
            # so the thread exits promptly; the store must not be closed under a live sync.
            self._thread.join()
            self._thread = None

    def _loop(self) -> None:
        while not self._stop.wait(self._tick):
            if time.monotonic() >= self._next_sync:
                try:
                    self.sync_all()
                except Exception:  # truly unexpected; per-feed failures are recorded in sync_feed
                    log.warning("calendar sync failed unexpectedly")
            try:
                self.tick_reminders()
            except Exception:  # a locked store must not stop the thread
                log.warning("calendar reminder tick failed")

    def sync_all(self) -> None:
        # Set before any fetch: a pass that fails must not be retried on every tick.
        self._next_sync = time.monotonic() + self._sync_every
        for feed_id in self._feed_ids():
            if self._stop.is_set():
                return
            try:
                self.sync_feed(feed_id)
            except Exception:  # one feed must not stop the others
                log.warning("calendar feed sync failed unexpectedly")

    def sync_feed(self, feed_id: str) -> None:
        with self._sync_lock:
            moment = self._clock()
            window = (moment - WINDOW_BEFORE, moment + WINDOW_AFTER)
            events, error = self._fetch(feed_id, window)
            with self.ctx.store.lock:
                db = self.ctx.store.db
                if db.execute("SELECT 1 FROM calendar_feeds WHERE id = ?1", (feed_id,)).fetchone() is None:
                    return  # removed while the feed was being fetched
                with transaction(db):
                    if events is not None:
                        _replace_events(db, feed_id, events, window)
                    db.execute(
                        "UPDATE calendar_feeds SET last_sync_at = ?2, last_status = ?3, last_error = ?4 "
                        "WHERE id = ?1",
                        (feed_id, cal.iso(moment), "ok" if events is not None else "error", error),
                    )
        self.ctx.emit("calendar_changed", None)

    def tick_reminders(self, moment: Optional[dt.datetime] = None) -> list[dict[str, Any]]:
        """Emits calendar_reminder once per event for timed events starting within the saved minutes."""
        moment = moment or self._clock()
        with self.ctx.store.lock:
            db = self.ctx.store.db
            enabled, minutes = db.execute(
                "SELECT calendar_reminders, calendar_reminder_minutes FROM settings WHERE id = 1"
            ).fetchone()
            if not enabled:
                return []
            rows = db.execute(
                f"SELECT {EVENT_COLUMNS} FROM calendar_events WHERE status != 'cancelled' AND all_day = 0 "
                "AND start_utc >= ?1 AND start_utc <= ?2 ORDER BY start_utc, id",
                (cal.iso(moment - REMINDER_GRACE), cal.iso(moment + dt.timedelta(minutes=minutes))),
            ).fetchall()
            payloads: list[dict[str, Any]] = []
            with self._reminder_lock:
                for row in rows:
                    if row[0] in self._reminded:
                        continue
                    self._reminded.add(row[0])
                    related = cal.related_meetings(db, _stored(row))
                    payloads.append(
                        {
                            "event_id": row[0],
                            "title": row[2],
                            "start_utc": row[3],
                            "has_link": row[9] is not None,
                            "related_count": len(related),
                        }
                    )
        for payload in payloads:
            self.ctx.emit("calendar_reminder", payload)
        return payloads

    def current_event(self, moment: dt.datetime) -> Optional[dict[str, Any]]:
        return current_event(self.ctx, moment)

    def _feed_ids(self) -> list[str]:
        with self.ctx.store.lock:
            rows = self.ctx.store.db.execute(
                "SELECT id FROM calendar_feeds ORDER BY created_at, id"
            ).fetchall()
        return [row[0] for row in rows]

    def _fetch(
        self, feed_id: str, window: tuple[dt.datetime, dt.datetime]
    ) -> tuple[Optional[list[cal.EventInstance]], Optional[str]]:
        """Events for the window, or None and a user-safe message. Holds no store lock."""
        try:
            address = self._address(feed_id)
            body = self._download(address)
            return cal.parse_ics(body.decode("utf-8", errors="replace"), window[0], window[1]), None
        except _Failed as failed:
            return None, failed.message
        except ValueError:
            return None, NOT_CALENDAR
        except Exception as error:  # a malformed feed records an error; it must not stop the sync pass
            log.warning("calendar feed could not be read (%s)", type(error).__name__)
            return None, UNREADABLE

    def _address(self, feed_id: str) -> str:
        try:
            address = keys.read_key(CREDENTIAL_PREFIX + feed_id)
        except AppError:
            raise _Failed("The calendar address could not be read from Credential Manager.") from None
        if not address:
            raise _Failed(
                "The calendar address is missing from Credential Manager. Remove the calendar and add it again."
            )
        return address

    def _download(self, address: str) -> bytes:
        if urlsplit(address).scheme != "https":
            raise _Failed(BAD_ADDRESS)
        try:
            with httpx.Client(
                timeout=FETCH_TIMEOUT_SECONDS, follow_redirects=False, transport=self.ctx.transport
            ) as client:
                with client.stream("GET", address, headers={"Accept": "text/calendar"}) as response:
                    if 300 <= response.status_code < 400:
                        raise _Failed("The calendar redirected. Paste the address the calendar app shows.")
                    if response.status_code != 200:
                        raise _Failed(f"The calendar answered with HTTP {response.status_code}.")
                    deadline = time.monotonic() + FETCH_DEADLINE_SECONDS
                    chunks: list[bytes] = []
                    total = 0
                    for chunk in response.iter_bytes():
                        # A per-read timeout alone lets a slow server keep the sync (and the lock) busy forever.
                        if self._stop.is_set() or time.monotonic() > deadline:
                            raise _Failed(UNREACHABLE)
                        total += len(chunk)
                        if total > MAX_BODY_BYTES:
                            raise _Failed("The calendar is larger than 5 MB.")
                        chunks.append(chunk)
                    return b"".join(chunks)
        except _Failed:
            raise
        except (httpx.HTTPError, httpx.InvalidURL, OSError):
            # The exception text can contain the address; only the fixed message leaves this function.
            raise _Failed(UNREACHABLE) from None


# ---- storage helpers ------------------------------------------------------------------------------


def _replace_events(
    db: sqlite3.Connection, feed_id: str, events: list[cal.EventInstance], window: tuple[dt.datetime, dt.datetime]
) -> None:
    """Replaces this feed's instances that overlap the window. Ids are stable, so meeting links survive."""
    kept = [cal.event_key(feed_id, event) for event in events]
    db.execute(
        "DELETE FROM calendar_events WHERE feed_id = ?1 AND end_utc > ?2 AND start_utc < ?3 "
        "AND id NOT IN (SELECT value FROM json_each(?4))",
        (feed_id, cal.iso(window[0]), cal.iso(window[1]), json.dumps(kept)),
    )
    for event, key in zip(events, kept):
        db.execute(
            "INSERT INTO calendar_events (id, feed_id, uid, recurrence_id, start_utc, end_utc, all_day, title, "
            "location, description, status, attendees_json, meeting_url) "
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) "
            "ON CONFLICT(id) DO UPDATE SET uid = excluded.uid, recurrence_id = excluded.recurrence_id, "
            "start_utc = excluded.start_utc, end_utc = excluded.end_utc, all_day = excluded.all_day, "
            "title = excluded.title, location = excluded.location, description = excluded.description, "
            "status = excluded.status, attendees_json = excluded.attendees_json, meeting_url = excluded.meeting_url",
            (
                key,
                feed_id,
                event.uid,
                event.recurrence_id,
                cal.iso(event.start_utc),
                cal.iso(event.end_utc),
                int(event.all_day),
                event.title,
                event.location,
                event.description,
                event.status,
                json.dumps(list(event.attendees)),
                cal.meeting_url(event),
            ),
        )


def _stored(row: tuple[Any, ...]) -> cal.StoredEvent:
    return cal.StoredEvent(id=row[0], uid=row[10], title=row[2], start_utc=row[3])


def _event_dict(row: tuple[Any, ...]) -> dict[str, Any]:
    """The event as the UI reads it. The meeting address is never returned, only whether one exists."""
    return {
        "id": row[0],
        "feed_id": row[1],
        "title": row[2],
        "start_utc": row[3],
        "end_utc": row[4],
        "all_day": bool(row[5]),
        "location": row[6],
        "status": row[7],
        "attendees": json.loads(row[8] or "[]"),
        "has_link": row[9] is not None,
    }


def _feed_dict(row: tuple[Any, ...], has_url: bool) -> dict[str, Any]:
    return {
        "id": row[0],
        "label": row[1],
        "kind": row[2],
        "last_sync_at": row[3],
        "last_status": row[4],
        "last_error": row[5],
        "has_url": has_url,
    }


def current_event(ctx: Context, moment: dt.datetime) -> Optional[dict[str, Any]]:
    """The timed, non-cancelled event whose window (start minus 5 min to end plus 5 min) contains `moment`.

    Earliest start wins. All-day events are not meetings and never match.
    """
    with ctx.store.lock:
        row = ctx.store.db.execute(
            f"SELECT {EVENT_COLUMNS} FROM calendar_events WHERE status != 'cancelled' AND all_day = 0 "
            "AND start_utc <= ?1 AND end_utc >= ?2 ORDER BY start_utc, id LIMIT 1",
            (cal.iso(moment + EDGE), cal.iso(moment - EDGE)),
        ).fetchone()
    return None if row is None else _event_dict(row)


def _excerpt(db: sqlite3.Connection, meeting_id: str) -> Optional[str]:
    latest = reads.latest_summary(db, meeting_id)
    text = latest[0] if latest and latest[0] else None
    if not text:
        notes = db.execute("SELECT user_markdown FROM notes WHERE meeting_id = ?1", (meeting_id,)).fetchone()
        text = notes[0] if notes else None
    text = (text or "").strip()
    return text[:EXCERPT_CHARS] if text else None


# ---- commands -------------------------------------------------------------------------------------


def _label(value: Any) -> str:
    label = text_arg(value, "label").strip()
    if not label or len(label) > MAX_LABEL or has_control(label):
        raise AppError("calendar_label", "Enter a label of 1 to 80 characters.")
    return label


def _feed_url(value: Any) -> str:
    address = text_arg(value, "url").strip()
    if not address or len(address) > MAX_URL or any(not (0x21 <= ord(c) <= 0x7E) for c in address):
        raise AppError("calendar_url", BAD_URL)
    try:
        parts = urlsplit(address)
        port = parts.port  # raises ValueError for a malformed port
    except ValueError:
        raise AppError("calendar_url", BAD_URL) from None
    path = parts.path.lower()
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or port == 0:
        raise AppError("calendar_url", BAD_URL)
    if not (path.endswith(".ics") or "ical" in path):
        raise AppError("calendar_url", BAD_URL)
    return address


def _instant(value: Any, name: str) -> dt.datetime:
    text = text_arg(value, name)
    try:
        moment = dt.datetime.fromisoformat(text)
    except ValueError:
        raise AppError("invalid_args", f"{name} must be a UTC date and time.") from None
    if moment.tzinfo is None:
        raise AppError("invalid_args", f"{name} must include a time zone.")
    return moment


def list_calendar_feeds(ctx: Context) -> list[dict[str, Any]]:
    with ctx.store.lock:
        rows = ctx.store.db.execute(
            f"SELECT {FEED_COLUMNS} FROM calendar_feeds ORDER BY created_at, id"
        ).fetchall()
    return [_feed_dict(row, keys.key_status(CREDENTIAL_PREFIX + row[0]) == "present") for row in rows]


def _feed(ctx: Context, feed_id: str) -> dict[str, Any]:
    for feed in list_calendar_feeds(ctx):
        if feed["id"] == feed_id:
            return feed
    raise AppError("not_found", "Calendar not found.")


def add_calendar_feed(ctx: Context, label: Any, url: Any) -> dict[str, Any]:
    label = _label(label)
    address = _feed_url(url)
    feed_id = str(uuid.uuid4())
    account = CREDENTIAL_PREFIX + feed_id
    try:
        keys.store_at(account, address)  # the address goes to the Credential Manager and nowhere else
    except AppError:
        raise
    except Exception:
        raise _keychain() from None
    try:
        with ctx.store.lock:
            with transaction(ctx.store.db) as db:
                db.execute(
                    "INSERT INTO calendar_feeds (id, label, kind, created_at, last_status) "
                    "VALUES (?1, ?2, 'ics', ?3, 'never')",
                    (feed_id, label, now()),
                )
    except BaseException:
        _forget_credential(account)  # no row was saved, so the address must not outlive the failed save
        raise
    if ctx.calendar is not None:
        ctx.calendar.sync_feed(feed_id)
    ctx.emit("calendar_changed", None)
    return _feed(ctx, feed_id)


def _forget_credential(account: str) -> None:
    try:
        keys.delete_key(account)
    except AppError:
        log.warning("could not remove a calendar credential after a failed save")


def remove_calendar_feed(ctx: Context, id: Any) -> None:
    feed_id = text_arg(id, "id")
    with ctx.store.lock:
        exists = ctx.store.db.execute("SELECT 1 FROM calendar_feeds WHERE id = ?1", (feed_id,)).fetchone()
    if exists is None:
        raise AppError("not_found", "Calendar not found.")
    keys.delete_key(CREDENTIAL_PREFIX + feed_id)  # if this fails, nothing else is removed
    with ctx.store.lock:
        ctx.store.db.execute("DELETE FROM calendar_feeds WHERE id = ?1", (feed_id,))  # events cascade
    ctx.emit("calendar_changed", None)


def sync_calendars(ctx: Context) -> list[dict[str, Any]]:
    if ctx.calendar is not None:
        ctx.calendar.sync_all()
    return list_calendar_feeds(ctx)


def list_calendar_events(ctx: Context, from_utc: Any, to_utc: Any) -> list[dict[str, Any]]:
    start = _instant(from_utc, "from_utc")
    end = _instant(to_utc, "to_utc")
    if end <= start:
        raise AppError("invalid_args", "to_utc must be after from_utc.")
    with ctx.store.lock:
        rows = ctx.store.db.execute(
            f"SELECT {EVENT_COLUMNS} FROM calendar_events WHERE status != 'cancelled' "
            "AND end_utc > ?1 AND start_utc < ?2 ORDER BY start_utc, id LIMIT ?3",
            (cal.iso(start), cal.iso(end), MAX_EVENTS),
        ).fetchall()
    return [_event_dict(row) for row in rows]


def link_meeting_event(ctx: Context, meeting_id: Any, event_id: Any) -> dict[str, Any]:
    meeting_id = text_arg(meeting_id, "meeting_id")
    event_id = optional_text_arg(event_id, "event_id")
    with ctx.store.lock:
        db = ctx.store.db
        with transaction(db) as tx:
            reads.require_meeting(tx, meeting_id)
            if event_id is not None and tx.execute(
                "SELECT 1 FROM calendar_events WHERE id = ?1", (event_id,)
            ).fetchone() is None:
                raise AppError("not_found", "Calendar event not found.")
            tx.execute("UPDATE meetings SET calendar_event_id = ?2 WHERE id = ?1", (meeting_id, event_id))
        row = db.execute(reads.MEETING_COLUMNS + " WHERE id = ?1", (meeting_id,)).fetchone()
        meeting = reads.meeting_dict(row, reads.tags_of(db, meeting_id))
    ctx.emit("meeting_updated", None)
    return meeting


def meeting_preparation(ctx: Context, event_id: Any) -> dict[str, Any]:
    event_id = text_arg(event_id, "event_id")
    with ctx.store.lock:
        db = ctx.store.db
        row = db.execute(f"SELECT {EVENT_COLUMNS} FROM calendar_events WHERE id = ?1", (event_id,)).fetchone()
        if row is None:
            raise AppError("not_found", "Calendar event not found.")
        related = [
            {**item, "summary_excerpt": _excerpt(db, item["meeting_id"])}
            for item in cal.related_meetings(db, _stored(row))
        ]
        return {"event": _event_dict(row), "related": related}


def save_calendar_reminders(ctx: Context, enabled: Any, minutes: Any) -> dict[str, Any]:
    enabled = bool_arg(enabled, "enabled")
    minutes = int_arg(minutes, "minutes")
    if not 0 <= minutes <= 30:
        raise AppError("invalid_args", "Choose 0 to 30 minutes.")
    with ctx.store.lock:
        db = ctx.store.db
        db.execute(
            "UPDATE settings SET calendar_reminders = ?1, calendar_reminder_minutes = ?2 WHERE id = 1",
            (int(enabled), minutes),
        )
        return reads.read_settings(db)
