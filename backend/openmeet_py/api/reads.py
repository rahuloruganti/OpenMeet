"""Read-side helpers shared by commands: settings, meeting detail, transcript lines and freshness.

Covers read_settings, get_meeting and transcript_lines. Nothing here returns a credential: provider rows carry an internal account name that only keys.py resolves.
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
from typing import Any, Optional

from openmeet_py.api.errors import AppError
from openmeet_py.domain import transcript_edits

MEETING_COLUMNS = (
    "SELECT id, title, started_at, ended_at, status, source, capture_error FROM meetings"
)
PROVIDER_ROLES = ("llm", "cloud_stt")
EXPORT_FORMATS = ("txt", "srt", "vtt")
Settings = dict[str, Any]


def tags_of(db: sqlite3.Connection, meeting_id: str) -> list[str]:
    rows = db.execute(
        "SELECT tag FROM meeting_tags WHERE meeting_id = ?1 ORDER BY tag", (meeting_id,)
    ).fetchall()
    return [row[0] for row in rows]


def tracks_of(db: sqlite3.Connection, meeting_id: str) -> list[dict[str, Any]]:
    """Track rows in the shape the UI reads. size_bytes is None when the file is missing."""
    rows = db.execute(
        "SELECT kind, path, timing_path, device_name, sample_rate, channels, frames, dropped_frames, "
        "finalized FROM tracks WHERE meeting_id = ?1 ORDER BY kind",
        (meeting_id,),
    ).fetchall()
    tracks = []
    for row in rows:
        try:
            size: Optional[int] = os.stat(row[1]).st_size
        except OSError:
            size = None
        tracks.append(
            {
                "kind": row[0],
                "path": row[1],
                "timing_path": row[2],
                "device_name": row[3],
                "sample_rate": row[4],
                "channels": row[5],
                "frames": row[6],
                "dropped_frames": row[7],
                "finalized": bool(row[8]),
                "size_bytes": size,
            }
        )
    return tracks


def meeting_dict(row: tuple, tags: list[str]) -> dict[str, Any]:
    return {
        "id": row[0],
        "title": row[1],
        "started_at": row[2],
        "ended_at": row[3],
        "status": row[4],
        "source": row[5],
        "capture_error": row[6],
        "tags": tags,
    }


def require_meeting(db: sqlite3.Connection, meeting_id: str) -> None:
    exists = db.execute("SELECT EXISTS(SELECT 1 FROM meetings WHERE id = ?1)", (meeting_id,))
    if not exists.fetchone()[0]:
        raise AppError("not_found", "Meeting not found.")


# ---- settings ---------------------------------------------------------------


def _parse_formats(value: str) -> list[str]:
    tokens = {token.strip() for token in value.split(",")}
    return [fmt for fmt in EXPORT_FORMATS if fmt in tokens]


def provider_config(db: sqlite3.Connection, role: str) -> Optional[dict[str, Any]]:
    """The assigned connection for a role, including its internal account name (never returned)."""
    row = db.execute(
        "SELECT c.base_url, a.model, a.revision, c.credential_account FROM provider_assignments a "
        "JOIN saved_connections c ON c.id = a.connection_id WHERE a.role = ?1",
        (role,),
    ).fetchone()
    if row is None:
        return None
    return {
        "base_url": row[0],
        "model": row[1],
        "revision": row[2],
        "credential_account": row[3],
    }


def saved_connection(db: sqlite3.Connection, connection_id: str) -> Optional[dict[str, Any]]:
    row = db.execute(
        "SELECT id, name, base_url, revision, credential_account FROM saved_connections "
        "WHERE id = ?1",
        (connection_id,),
    ).fetchone()
    if row is None:
        return None
    return {
        "id": row[0],
        "name": row[1],
        "base_url": row[2],
        "revision": row[3],
        "credential_account": row[4],
    }


def read_settings(db: sqlite3.Connection) -> Settings:
    """The Settings shape from src/lib/api.ts, filled from the stored settings rows."""
    saved_connections = [
        {"id": row[0], "name": row[1], "base_url": row[2], "revision": row[3]}
        for row in db.execute(
            "SELECT id,name,base_url,revision FROM saved_connections ORDER BY name,id"
        ).fetchall()
    ]

    def assignment(role: str) -> Optional[dict[str, Any]]:
        row = db.execute(
            "SELECT connection_id,model,revision FROM provider_assignments "
            "WHERE role=?1 AND connection_id IS NOT NULL",
            (role,),
        ).fetchone()
        if row is None:
            return None
        return {"connection_id": row[0], "model": row[1], "revision": row[2]}

    def connection(role: str) -> Optional[dict[str, Any]]:
        config = provider_config(db, role)
        if config is None:
            return None
        return {"base_url": config["base_url"], "model": config["model"], "revision": config["revision"]}

    templates = [
        {"id": row[0], "name": row[1], "instructions": row[2]}
        for row in db.execute(
            "SELECT id,name,instructions FROM summary_templates ORDER BY name,id"
        ).fetchall()
    ]
    recipes = [
        {"id": row[0], "name": row[1], "prompt": row[2]}
        for row in db.execute("SELECT id,name,prompt FROM recipes ORDER BY name,id").fetchall()
    ]
    # ponytail: apps ignored before names were kept get their id as the name; no rows exist in Phase 1.
    ignored = [
        {"id": row[0], "name": row[1] or row[0]}
        for row in db.execute(
            "SELECT app_id, name FROM detection_ignored_apps ORDER BY app_id"
        ).fetchall()
    ]
    row = db.execute(
        "SELECT vault_folder, pause_shortcut, microphone_id, output_id, stt_mode, "
        "export_transcript, export_summary, export_filename, stt_language, stt_prompt, "
        "stt_model, stop_shortcut, summary_instructions, export_transcript_formats, "
        "processing_mode, processing_summary, summary_default, detection_enabled, setup_done, "
        "theme, inspector_open, live_transcript, live_model "
        "FROM settings WHERE id = 1"
    ).fetchone()
    return {
        "vault_folder": row[0],
        "pause_shortcut": row[1],
        "microphone_id": row[2],
        "output_id": row[3],
        "saved_connections": saved_connections,
        "provider_assignments": {"llm": assignment("llm"), "cloud_stt": assignment("cloud_stt")},
        "llm": connection("llm"),
        "cloud_stt": connection("cloud_stt"),
        "stt_mode": "cloud" if row[4] == "cloud" else "local",
        "stt_language": row[8],
        "stt_prompt": row[9],
        "stt_model": row[10],
        "stop_shortcut": row[11],
        "export": {
            "transcript": bool(row[5]),
            "summary": bool(row[6]),
            "filename": "date_title" if row[7] == "date_title" else "title",
            "transcript_formats": _parse_formats(row[13] or ""),
        },
        "summary_instructions": row[12],
        "summary_templates": templates,
        "recipes": recipes,
        "processing_mode": row[14],
        "processing_summary": row[15],
        "summary_default": row[16],
        "detection_enabled": bool(row[17]),
        "detection_ignored": ignored,
        "setup_done": bool(row[18]),
        "theme": row[19] if row[19] in ("dark", "light") else "system",
        "inspector_open": bool(row[20]),
        "live_transcript": bool(row[21]),
        "live_model": row[22] or "",
    }


# ---- transcript --------------------------------------------------------------


def speaker_names(db: sqlite3.Connection, meeting_id: str) -> dict[str, Optional[str]]:
    names: dict[str, Optional[str]] = {"you": None, "others": None}
    for speaker, name in db.execute(
        "SELECT speaker, name FROM speaker_names WHERE meeting_id=?1", (meeting_id,)
    ).fetchall():
        names["you" if speaker == "You" else "others"] = name
    return names


def label(names: dict[str, Optional[str]], speaker: str) -> str:
    """Speaker label: "Name (You)" when the speaker is named, otherwise the stored label."""
    name = {"You": names.get("you"), "Others": names.get("others")}.get(speaker)
    return f"{name} ({speaker})" if name else speaker


def transcript_lines(segments: list[dict[str, Any]], names: dict[str, Optional[str]]) -> list[str]:
    lines = []
    for segment in segments:
        spoken = label(names, segment["speaker"])
        timing = segment["timing"]
        if timing["kind"] == "timed":
            start = timing["start_ms"]
            stamp = f"[{start // 60000}:{(start // 1000) % 60:02d}]"
            lines.append(f"{stamp} {spoken}: {segment['text']}")
        else:
            lines.append(f"{spoken}: {segment['text']}")
    return lines


def transcript_hash(segments: list[dict[str, Any]], names: dict[str, Optional[str]]) -> str:
    return hashlib.sha256("\n".join(transcript_lines(segments, names)).encode("utf-8")).hexdigest()


def segments_of(db: sqlite3.Connection, meeting_id: str) -> tuple[list[dict], list[dict]]:
    rows = db.execute(
        "SELECT speaker, start_ms, end_ms, text, id, original_text FROM segments "
        "WHERE meeting_id = ?1 ORDER BY start_ms IS NULL, start_ms, id",
        (meeting_id,),
    ).fetchall()
    segments = []
    meta = []
    for speaker, start_ms, end_ms, text, segment_id, original in rows:
        timing = (
            {"kind": "untimed"}
            if start_ms is None
            else {"kind": "timed", "start_ms": start_ms, "end_ms": end_ms}
        )
        segments.append({"speaker": speaker, "timing": timing, "text": text})
        meta.append({"id": segment_id, "original_text": original})
    return segments, meta


# ---- meeting records ---------------------------------------------------------


def action_items(db: sqlite3.Connection, meeting_id: str) -> list[dict[str, Any]]:
    return [
        {
            "id": row[0],
            "text": row[1],
            "owner": row[2],
            "due_date": row[3],
            "done": bool(row[4]),
            "source": row[5],
            "summary_id": row[6],
        }
        for row in db.execute(
            "SELECT id,text,owner,due_date,done,source,summary_id FROM action_items "
            "WHERE meeting_id=?1 ORDER BY id",
            (meeting_id,),
        ).fetchall()
    ]


def question_threads(db: sqlite3.Connection, meeting_id: str) -> list[dict[str, Any]]:
    """Newest thread first; each thread's turns oldest first."""
    threads = [
        {"id": row[0], "turns": []}
        for row in db.execute(
            "SELECT id FROM question_threads WHERE meeting_id=?1 ORDER BY id DESC", (meeting_id,)
        ).fetchall()
    ]
    by_id = {thread["id"]: thread for thread in threads}
    for turn_id, thread_id, question, answer, provider, model in db.execute(
        "SELECT u.id, u.thread_id, u.question, u.answer, u.provider, u.model FROM question_turns u "
        "JOIN question_threads t ON t.id = u.thread_id WHERE t.meeting_id=?1 ORDER BY u.id",
        (meeting_id,),
    ).fetchall():
        by_id[thread_id]["turns"].append(
            {"id": turn_id, "question": question, "answer": answer, "provider": provider, "model": model}
        )
    return threads


def latest_summary(db: sqlite3.Connection, meeting_id: str) -> Optional[tuple]:
    return db.execute(
        "SELECT markdown, provider, model, template_hash, edited_from IS NOT NULL, transcript_hash "
        "FROM summaries WHERE meeting_id = ?1 ORDER BY id DESC LIMIT 1",
        (meeting_id,),
    ).fetchone()


def meeting_detail(db: sqlite3.Connection, meeting_id: str) -> dict[str, Any]:
    row = db.execute(MEETING_COLUMNS + " WHERE id = ?1", (meeting_id,)).fetchone()
    if row is None:
        raise AppError("not_found", "Meeting not found.")
    user_markdown, notes_revision = db.execute(
        "SELECT user_markdown, revision FROM notes WHERE meeting_id = ?1", (meeting_id,)
    ).fetchone()
    segments, meta = segments_of(db, meeting_id)
    names = speaker_names(db, meeting_id)
    provenance = db.execute(
        "SELECT provider, model FROM meeting_transcriptions WHERE meeting_id = ?1", (meeting_id,)
    ).fetchone() or (None, None)
    latest = latest_summary(db, meeting_id)
    current = transcript_hash(segments, names)
    if latest is None:
        summary = {"summary": None, "summary_provider": None, "summary_model": None}
        summary.update(summary_template=None, summary_edited=False, summary_stale=False)
    else:
        summary = {
            "summary": latest[0],
            "summary_provider": latest[1],
            "summary_model": latest[2],
            "summary_template": latest[3],
            "summary_edited": bool(latest[4]),
            "summary_stale": latest[5] is not None and latest[5] != current,
        }
    return {
        "meeting": meeting_dict(row, tags_of(db, meeting_id)),
        "user_markdown": user_markdown,
        "notes_revision": notes_revision,
        "segments": segments,
        **summary,
        "transcript_provider": provenance[0],
        "transcript_model": provenance[1],
        "action_items": action_items(db, meeting_id),
        "speaker_names": names,
        "segment_meta": meta,
        "transcript_versions": transcript_edits.transcript_versions(db, meeting_id),
        "question_threads": question_threads(db, meeting_id),
        "tracks": tracks_of(db, meeting_id),
    }


def list_summaries(db: sqlite3.Connection, meeting_id: str) -> list[dict[str, Any]]:
    """Every summary version, newest first. Stale means the transcript changed after it was made."""
    if not db.execute("SELECT EXISTS(SELECT 1 FROM meetings WHERE id=?1)", (meeting_id,)).fetchone()[0]:
        return []
    segments, _ = segments_of(db, meeting_id)
    current = transcript_hash(segments, speaker_names(db, meeting_id))
    rows = db.execute(
        "SELECT id, provider, model, template_hash, markdown, edited_from, transcript_hash "
        "FROM summaries WHERE meeting_id = ?1 ORDER BY id DESC",
        (meeting_id,),
    ).fetchall()
    return [
        {
            "id": row[0],
            "provider": row[1],
            "model": row[2],
            "template": row[3],
            "markdown": row[4],
            "edited_from": row[5],
            "stale": row[6] is not None and row[6] != current,
        }
        for row in rows
    ]


def library_answers(db: sqlite3.Connection) -> list[dict[str, Any]]:
    """Newest first; meeting_ids in the order they were sent (M1 first)."""
    answers = [
        {
            "id": row[0],
            "question": row[1],
            "answer": row[2],
            "provider": row[3],
            "model": row[4],
            "meeting_ids": [],
        }
        for row in db.execute(
            "SELECT id, question, answer, provider, model FROM library_answers ORDER BY id DESC"
        ).fetchall()
    ]
    by_id = {answer["id"]: answer for answer in answers}
    for answer_id, meeting_id in db.execute(
        "SELECT answer_id, meeting_id FROM library_answer_meetings ORDER BY answer_id, position"
    ).fetchall():
        if answer_id in by_id:
            by_id[answer_id]["meeting_ids"].append(meeting_id)
    return answers
