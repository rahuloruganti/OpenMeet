"""Transcript replacement, segment edits and read-only transcript versions (transcript_edits.rs).

replace_transcript must run inside the caller's transaction (store.transaction): the previous
transcript is copied into transcript_versions first, so a failed run that never reaches this
function keeps the old rows, and a successful one keeps a recoverable copy of the old edits.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from .context import Context, byte_len, has_control, int_arg, text_arg
from .errors import AppError

MAX_SEGMENT_BYTES = 20_000
REPLACEABLE_SOURCES = ("whisper", "cloud_stt")


def timed(speaker: str, start_ms: int | None, end_ms: int | None, text: str) -> dict[str, Any]:
    """A segment in the shape reads.segments_of returns; untimed when start_ms is None."""
    if start_ms is None or end_ms is None:
        return {"speaker": speaker, "timing": {"kind": "untimed"}, "text": text}
    return {
        "speaker": speaker,
        "timing": {"kind": "timed", "start_ms": start_ms, "end_ms": end_ms},
        "text": text,
    }


def _row_timing(row: tuple) -> tuple[int | None, int | None]:
    return (row[1], row[2])


def snapshot(db: sqlite3.Connection, meeting_id: str) -> None:
    """Copies the replaceable transcript, edits included, into transcript_versions."""
    rows = db.execute(
        "SELECT speaker, start_ms, end_ms, text, original_text IS NOT NULL FROM segments "
        "WHERE meeting_id = ?1 AND source IN ('whisper', 'cloud_stt') "
        "ORDER BY start_ms IS NULL, start_ms, id",
        (meeting_id,),
    ).fetchall()
    if not rows:
        return
    edited = any(bool(row[4]) for row in rows)
    segments = [timed(row[0], *_row_timing(row), row[3]) for row in rows]
    provider, model = (
        db.execute(
            "SELECT provider, model FROM meeting_transcriptions WHERE meeting_id = ?1", (meeting_id,)
        ).fetchone()
        or (None, None)
    )
    db.execute(
        "INSERT INTO transcript_versions(meeting_id, provider, model, edited, segment_count, "
        "segments_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        (meeting_id, provider, model, int(edited), len(segments), json.dumps(segments, ensure_ascii=False)),
    )


def replace_transcript(
    db: sqlite3.Connection,
    meeting_id: str,
    segments: list[dict[str, Any]],
    provider: str,
    model: str,
) -> None:
    """Replaces engine rows with new ones. Caller holds the store lock and an open transaction."""
    snapshot(db, meeting_id)
    db.execute(
        "DELETE FROM segments WHERE meeting_id = ?1 AND source IN ('whisper', 'cloud_stt')",
        (meeting_id,),
    )
    source = "whisper" if provider == "whisper" else "cloud_stt"
    for segment in segments:
        timing = segment["timing"]
        start_ms = timing.get("start_ms") if timing["kind"] == "timed" else None
        end_ms = timing.get("end_ms") if timing["kind"] == "timed" else None
        db.execute(
            "INSERT INTO segments(meeting_id, speaker, start_ms, end_ms, text, source, pass) "
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'final')",
            (meeting_id, segment["speaker"], start_ms, end_ms, segment["text"], source),
        )
    db.execute(
        "INSERT INTO meeting_transcriptions(meeting_id, provider, model) VALUES (?1, ?2, ?3) "
        "ON CONFLICT(meeting_id) DO UPDATE SET provider = excluded.provider, model = excluded.model",
        (meeting_id, provider, model),
    )


def edit_segment(
    db: sqlite3.Connection, meeting_id: str, segment_id: int, base_text: str, text: str
) -> None:
    """Replaces one segment's text, keeping the engine's text for revert.

    base_text is the text the edit started from. SQLite can reuse a replaced segment's id, so a
    mismatch means the edit targets a changed segment and is refused.
    """
    text = text.strip()
    if not text or byte_len(text) > MAX_SEGMENT_BYTES or has_control(text):
        raise AppError(
            "segment_edit", "Enter segment text on one line, at most 20,000 bytes."
        )
    changed = db.execute(
        "UPDATE segments SET "
        "original_text = CASE WHEN coalesce(original_text, text) = ?3 THEN NULL "
        "ELSE coalesce(original_text, text) END, "
        "text = ?3 "
        "WHERE id = ?1 AND meeting_id = ?2 AND text = ?4",
        (segment_id, meeting_id, text, base_text),
    ).rowcount
    if changed != 1:
        raise AppError(
            "segment_conflict",
            "This transcript segment changed or no longer exists, possibly after re-transcription. "
            "Your edit is still open; copy it before discarding.",
        )


def transcript_versions(db: sqlite3.Connection, meeting_id: str) -> list[dict[str, Any]]:
    """Newest first. Metadata only; the segments are read with transcript_version."""
    return [
        {
            "id": row[0],
            "provider": row[1],
            "model": row[2],
            "edited": bool(row[3]),
            "segment_count": row[4],
        }
        for row in db.execute(
            "SELECT id, provider, model, edited, segment_count FROM transcript_versions "
            "WHERE meeting_id = ?1 ORDER BY id DESC",
            (meeting_id,),
        ).fetchall()
    ]


def transcript_version(db: sqlite3.Connection, meeting_id: str, version_id: int) -> list[dict[str, Any]]:
    row = db.execute(
        "SELECT segments_json FROM transcript_versions WHERE id = ?1 AND meeting_id = ?2",
        (version_id, meeting_id),
    ).fetchone()
    if row is None:
        raise AppError("not_found", "This transcript version is not available.")
    try:
        segments = json.loads(row[0])
    except ValueError as error:
        raise AppError("internal", "This transcript version could not be read.") from error
    return segments


def get_transcript_version(ctx: Context, meeting_id: Any, version_id: Any) -> list[dict[str, Any]]:
    meeting_id = text_arg(meeting_id, "meeting_id")
    version_id = int_arg(version_id, "version_id")
    with ctx.store.lock:
        return transcript_version(ctx.store.db, meeting_id, version_id)


def edit_segment_command(
    ctx: Context, meeting_id: Any, segment_id: Any, base_text: Any, text: Any
) -> None:
    meeting_id = text_arg(meeting_id, "meeting_id")
    segment_id = int_arg(segment_id, "segment_id")
    base_text = text_arg(base_text, "base_text")
    text = text_arg(text, "text")
    with ctx.store.lock:
        edit_segment(ctx.store.db, meeting_id, segment_id, base_text, text)
