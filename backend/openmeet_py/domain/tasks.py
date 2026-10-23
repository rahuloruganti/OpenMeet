"""Meeting tasks: manual entries, edits, and explicit imports from a summary's Action items section.

Imports never guess owners or dates, and a task that came from a summary bullet
is never imported twice, even after it was edited or re-ordered.
"""

from __future__ import annotations

import datetime as dt
import re
import sqlite3
from typing import Any, Optional

from openmeet_py.api import reads
from openmeet_py.api.context import (
    Context, bool_arg, has_control, int_arg, optional_int_arg, optional_text_arg, text_arg,
)
from openmeet_py.api.errors import AppError
from openmeet_py.infra.store import transaction

MAX_ITEMS = 200
MAX_TEXT = 500
MAX_OWNER = 80
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


def _invalid(message: str) -> AppError:
    return AppError("action_item", message)


def _missing() -> AppError:
    return AppError("not_found", "This task no longer exists.")


def _line(value: str, maximum: int, what: str) -> str:
    value = value.strip()
    if len(value) > maximum or has_control(value):
        raise _invalid(f"Keep the {what} on one line, at most {maximum} characters.")
    return value


def _due_date(value: Optional[str]) -> Optional[str]:
    value = (value or "").strip()
    if not value:
        return None
    if not _DATE.fullmatch(value):
        raise _invalid("Use a due date such as 2026-10-31, or leave it empty.")
    try:
        dt.date(int(value[0:4]), int(value[5:7]), int(value[8:10]))
    except ValueError:
        raise _invalid("Use a due date such as 2026-10-31, or leave it empty.") from None
    return value


_ITEM_MARKERS = ("- ", "* ", "+ ")
_NUMBERED = re.compile(r"[0-9]+\. ")
_BOXES = ("[ ] ", "[x] ", "[X] ")


def summary_bullets(markdown: str) -> list[str]:
    """Top-level bullets under the Action items heading. Nested bullets, "None noted" and empty items are dropped."""
    level: Optional[int] = None
    items: list[str] = []
    # Split on \n and drop one trailing \r.
    for raw in (line[:-1] if line.endswith("\r") else line for line in markdown.split("\n")):
        hashes = len(raw) - len(raw.lstrip("#"))
        heading = 1 <= hashes <= 6 and raw[hashes:hashes + 1] == " "
        if level is None:
            if heading and raw[hashes:].strip().lower() == "action items":
                level = hashes
            continue
        if heading and hashes <= level:
            break
        rest = None
        for marker in _ITEM_MARKERS:
            if raw.startswith(marker):
                rest = raw[len(marker):]
                break
        if rest is None:
            numbered = _NUMBERED.match(raw)
            if numbered is None:
                continue
            rest = raw[numbered.end():]
        for box in _BOXES:
            if rest.startswith(box):
                rest = rest[len(box):]
                break
        rest = rest.strip()
        lowered = rest.rstrip(".").lower()
        if rest and lowered not in ("none noted", "none"):
            items.append(rest)
    return items


def _meeting_check(db: sqlite3.Connection, meeting_id: str) -> None:
    reads.require_meeting(db, meeting_id)


def save_action_item(
    ctx: Context,
    meeting_id: Any,
    item_id: Any,
    text: Any,
    owner: Any,
    due_date: Any,
    done: Any,
) -> list[dict[str, Any]]:
    meeting_id = text_arg(meeting_id, "meeting_id")
    item_id = optional_int_arg(item_id, "item_id")
    title = _line(text_arg(text, "text"), MAX_TEXT, "task")
    if not title:
        raise _invalid("Describe the task.")
    owner_text = _line(optional_text_arg(owner, "owner") or "", MAX_OWNER, "owner") or None
    due = _due_date(optional_text_arg(due_date, "due_date"))
    done_flag = bool_arg(done, "done")
    with ctx.store.lock:
        db = ctx.store.db
        with transaction(db) as tx:
            if item_id is not None:
                changed = tx.execute(
                    "UPDATE action_items SET text=?3, owner=?4, due_date=?5, done=?6 "
                    "WHERE id=?1 AND meeting_id=?2",
                    (item_id, meeting_id, title, owner_text, due, done_flag),
                ).rowcount
            else:
                _meeting_check(tx, meeting_id)
                count = tx.execute(
                    "SELECT COUNT(*) FROM action_items WHERE meeting_id=?1", (meeting_id,)
                ).fetchone()[0]
                if count >= MAX_ITEMS:
                    raise _invalid(f"A meeting can have at most {MAX_ITEMS} tasks.")
                changed = tx.execute(
                    "INSERT INTO action_items(meeting_id, text, owner, due_date, done, source) "
                    "VALUES (?1, ?2, ?3, ?4, ?5, 'manual')",
                    (meeting_id, title, owner_text, due, done_flag),
                ).rowcount
            if changed != 1:
                raise _missing()
        return reads.action_items(db, meeting_id)


def delete_action_item(ctx: Context, meeting_id: Any, item_id: Any) -> list[dict[str, Any]]:
    meeting_id = text_arg(meeting_id, "meeting_id")
    item_id = int_arg(item_id, "item_id")
    with ctx.store.lock:
        db = ctx.store.db
        deleted = db.execute(
            "DELETE FROM action_items WHERE id=?1 AND meeting_id=?2", (item_id, meeting_id)
        ).rowcount
        if deleted != 1:
            raise _missing()
        return reads.action_items(db, meeting_id)


def import_action_items(ctx: Context, meeting_id: Any, summary_id: Any) -> list[dict[str, Any]]:
    """Adds the summary's action items that no task of this meeting came from, ever (even if edited)."""
    meeting_id = text_arg(meeting_id, "meeting_id")
    summary_id = int_arg(summary_id, "summary_id")
    with ctx.store.lock:
        db = ctx.store.db
        with transaction(db) as tx:
            row = tx.execute(
                "SELECT markdown FROM summaries WHERE id=?1 AND meeting_id=?2",
                (summary_id, meeting_id),
            ).fetchone()
            if row is None:
                raise AppError("not_found", "This summary version is not available.")
            seen = {
                origin
                for (origin,) in tx.execute(
                    "SELECT origin_text FROM action_items WHERE meeting_id=?1 AND origin_text IS NOT NULL",
                    (meeting_id,),
                ).fetchall()
            }
            try:
                bullets = [_line(bullet, MAX_TEXT, "task") for bullet in summary_bullets(row[0])]
            except AppError:
                raise _invalid(
                    f"An action item in this summary is longer than {MAX_TEXT} characters. "
                    "Nothing was added; add it manually instead."
                ) from None
            fresh: list[str] = []
            for bullet in bullets:
                if bullet not in seen:
                    seen.add(bullet)
                    fresh.append(bullet)
            if not fresh:
                raise _invalid(
                    "No new action items were found in this summary's Action items section."
                )
            count = tx.execute(
                "SELECT COUNT(*) FROM action_items WHERE meeting_id=?1", (meeting_id,)
            ).fetchone()[0]
            if count + len(fresh) > MAX_ITEMS:
                raise _invalid(
                    f"Importing would exceed {MAX_ITEMS} tasks for this meeting. Nothing was added."
                )
            for text in fresh:
                tx.execute(
                    "INSERT INTO action_items(meeting_id, text, source, summary_id, origin_text) "
                    "VALUES (?1, ?2, 'summary', ?3, ?2)",
                    (meeting_id, text, summary_id),
                )
        return reads.action_items(db, meeting_id)
