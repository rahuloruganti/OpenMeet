"""Folders: each meeting sits in at most one optional folder. Names are unique ignoring case.

Deleting a folder keeps its meetings; only their folder link is cleared. A folder that holds a
meeting being recorded or paused cannot be deleted. Every change emits meeting_updated.
"""

from __future__ import annotations

import sqlite3
import uuid
from typing import Any, Optional

from openmeet_py.api import reads
from openmeet_py.api.context import Context, has_control, list_arg, now, text_arg
from openmeet_py.api.errors import AppError
from openmeet_py.infra.store import transaction

MAX_FOLDER_CHARS = 60
RECORDING_STATUSES = ("recording", "paused")


def clean_name(name: Any) -> str:
    name = text_arg(name, "name").strip()
    if not 1 <= len(name) <= MAX_FOLDER_CHARS or has_control(name):
        raise AppError("folder_name", "Use a folder name of 1 to 60 characters on one line.")
    return name


def folder_exists() -> AppError:
    return AppError("folder_exists", "A folder with this name already exists.")


def _not_found() -> AppError:
    return AppError("not_found", "This folder no longer exists.")


def folder_rows(db: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = db.execute(
        "SELECT f.id, f.name, f.position, COUNT(m.id) FROM folders f "
        "LEFT JOIN meetings m ON m.folder_id = f.id "
        "GROUP BY f.id ORDER BY f.position, f.name COLLATE NOCASE, f.id"
    ).fetchall()
    return [
        {"id": row[0], "name": row[1], "position": row[2], "meeting_count": row[3]} for row in rows
    ]


def list_folders(ctx: Context) -> list[dict[str, Any]]:
    with ctx.store.lock:
        return folder_rows(ctx.store.db)


def create_folder(ctx: Context, name: Any) -> list[dict[str, Any]]:
    name = clean_name(name)
    with ctx.store.lock:
        db = ctx.store.db
        try:
            with transaction(db) as tx:
                tx.execute(
                    "INSERT INTO folders (id, name, created_at, position) VALUES (?1, ?2, ?3, "
                    "(SELECT COALESCE(MAX(position), -1) + 1 FROM folders))",
                    (str(uuid.uuid4()), name, now()),
                )
        except sqlite3.IntegrityError as error:
            raise folder_exists() from error
        rows = folder_rows(db)
    ctx.emit("meeting_updated", None)
    return rows


def rename_folder(ctx: Context, id: Any, name: Any) -> list[dict[str, Any]]:
    folder_id = text_arg(id, "id")
    name = clean_name(name)
    with ctx.store.lock:
        db = ctx.store.db
        try:
            with transaction(db) as tx:
                if tx.execute(
                    "UPDATE folders SET name = ?1 WHERE id = ?2", (name, folder_id)
                ).rowcount != 1:
                    raise _not_found()
        except sqlite3.IntegrityError as error:
            raise folder_exists() from error
        rows = folder_rows(db)
    ctx.emit("meeting_updated", None)
    return rows


def delete_folder(ctx: Context, id: Any) -> list[dict[str, Any]]:
    folder_id = text_arg(id, "id")
    # Lock order: recorder, then store (see recorder.py), as delete_meeting does.
    with ctx.recorder.lock, ctx.store.lock:
        db = ctx.store.db
        with transaction(db) as tx:
            if tx.execute("SELECT EXISTS(SELECT 1 FROM folders WHERE id = ?1)", (folder_id,)).fetchone()[0] == 0:
                raise _not_found()
            busy = tx.execute(
                "SELECT EXISTS(SELECT 1 FROM meetings WHERE folder_id = ?1 AND status IN (?2, ?3))",
                (folder_id, *RECORDING_STATUSES),
            ).fetchone()[0]
            if busy:
                raise AppError(
                    "folder_recording",
                    "A meeting in this folder is recording. Stop it before deleting the folder.",
                )
            # ON DELETE SET NULL clears folder_id on its meetings; they are kept.
            tx.execute("DELETE FROM folders WHERE id = ?1", (folder_id,))
        rows = folder_rows(db)
    ctx.emit("meeting_updated", None)
    return rows


def move_meeting(ctx: Context, meeting_id: Any, folder_id: Any) -> dict[str, Any]:
    meeting_id = text_arg(meeting_id, "meeting_id")
    target: Optional[str] = None if folder_id is None else text_arg(folder_id, "folder_id")
    with ctx.store.lock:
        db = ctx.store.db
        with transaction(db) as tx:
            reads.require_meeting(tx, meeting_id)
            if target is not None and tx.execute(
                "SELECT EXISTS(SELECT 1 FROM folders WHERE id = ?1)", (target,)
            ).fetchone()[0] == 0:
                raise _not_found()
            tx.execute("UPDATE meetings SET folder_id = ?1 WHERE id = ?2", (target, meeting_id))
        row = db.execute(reads.MEETING_COLUMNS + " WHERE id = ?1", (meeting_id,)).fetchone()
        meeting = reads.meeting_dict(row, reads.tags_of(db, meeting_id))
    ctx.emit("meeting_updated", None)
    return meeting


def reorder_folders(ctx: Context, ids: Any) -> list[dict[str, Any]]:
    order = [text_arg(value, "ids") for value in list_arg(ids, "ids")]
    with ctx.store.lock:
        db = ctx.store.db
        with transaction(db) as tx:
            current = {row[0] for row in tx.execute("SELECT id FROM folders").fetchall()}
            if len(order) != len(set(order)) or set(order) != current:
                raise AppError(
                    "folder_order", "The folder list changed elsewhere. Reload and try again."
                )
            for position, folder_id in enumerate(order):
                tx.execute("UPDATE folders SET position = ?1 WHERE id = ?2", (position, folder_id))
        rows = folder_rows(db)
    ctx.emit("meeting_updated", None)
    return rows
