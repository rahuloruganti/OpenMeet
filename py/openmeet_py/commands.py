"""Command handlers for the Python build, keyed by the snake_case names the React UI invokes.

Names and argument shapes follow src/lib/api.ts and src-tauri/src/lib.rs. Phase 1 implements the
notes command set. Every other command is listed in NOT_AVAILABLE and answers HTTP 501.
"""

from __future__ import annotations

import datetime as dt
import inspect
import re
import sqlite3
import threading
import unicodedata
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

from .errors import AppError, not_available
from .exporter import write_snapshot
from .store import Store, transaction

MAX_NOTES_BYTES = 1024 * 1024
MAX_TAGS = 20
MAX_TAG_CHARS = 40
MAX_SEARCH_CHARS = 200
EXPORT_FORMATS = ("txt", "srt", "vtt")


@dataclass
class Context:
    store: Store
    emit: Callable[[str, Any], None]
    # Native hooks, supplied by app.py only when a window exists. None means "not available".
    pick_folder: Optional[Callable[[], Optional[str]]] = None
    close_window: Optional[Callable[[], None]] = None


# ---- helpers ---------------------------------------------------------------


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _text(value: Any, name: str) -> str:
    if not isinstance(value, str):
        raise AppError("invalid_args", f"{name} must be text.")
    return value


def _int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise AppError("invalid_args", f"{name} must be a whole number.")
    return value


def _bool(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        raise AppError("invalid_args", f"{name} must be true or false.")
    return value


def _validate_title(title: str) -> str:
    title = title.strip()
    if not title or len(title) > 160:
        raise AppError("invalid_title", "Use a meeting title between 1 and 160 characters.")
    return title


def _require_meeting(db: sqlite3.Connection, meeting_id: str) -> None:
    exists = db.execute(
        "SELECT EXISTS(SELECT 1 FROM meetings WHERE id = ?1)", (meeting_id,)
    ).fetchone()[0]
    if not exists:
        raise AppError("not_found", "Meeting not found.")


def _tags_of(db: sqlite3.Connection, meeting_id: str) -> list[str]:
    rows = db.execute(
        "SELECT tag FROM meeting_tags WHERE meeting_id = ?1 ORDER BY tag", (meeting_id,)
    ).fetchall()
    return [row[0] for row in rows]


MEETING_COLUMNS = (
    "SELECT id, title, started_at, ended_at, status, source, capture_error FROM meetings"
)


def _meeting(row: tuple, tags: list[str]) -> dict[str, Any]:
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


# ---- meetings and notes ------------------------------------------------------


def list_meetings(ctx: Context) -> list[dict[str, Any]]:
    with ctx.store.lock:
        db = ctx.store.db
        rows = db.execute(MEETING_COLUMNS + " ORDER BY started_at DESC, id DESC").fetchall()
        tags: dict[str, list[str]] = {}
        for meeting_id, tag in db.execute(
            "SELECT meeting_id, tag FROM meeting_tags ORDER BY tag"
        ).fetchall():
            tags.setdefault(meeting_id, []).append(tag)
    return [_meeting(row, tags.get(row[0], [])) for row in rows]


def get_meeting(ctx: Context, id: str) -> dict[str, Any]:
    _text(id, "id")
    with ctx.store.lock:
        db = ctx.store.db
        row = db.execute(MEETING_COLUMNS + " WHERE id = ?1", (id,)).fetchone()
        if row is None:
            raise AppError("not_found", "Meeting not found.")
        user_markdown, revision = db.execute(
            "SELECT user_markdown, revision FROM notes WHERE meeting_id = ?1", (id,)
        ).fetchone()
        # ponytail: Phase 1 writes no segments, summaries, tasks, speaker names, tracks, question
        # threads or transcript versions, so their empty defaults are the real state. Phase 2 reads them.
        return {
            "meeting": _meeting(row, _tags_of(db, id)),
            "user_markdown": user_markdown,
            "notes_revision": revision,
            "segments": [],
            "summary": None,
            "summary_provider": None,
            "summary_model": None,
            "transcript_provider": None,
            "transcript_model": None,
            "action_items": [],
            "summary_edited": False,
            "summary_stale": False,
            "speaker_names": {"you": None, "others": None},
            "segment_meta": [],
            "transcript_versions": [],
            "question_threads": [],
            "tracks": [],
            "summary_template": None,
        }


def create_note(ctx: Context, title: str) -> str:
    title = _validate_title(_text(title, "title"))
    meeting_id = str(uuid.uuid4())
    with ctx.store.lock:
        with transaction(ctx.store.db) as db:
            db.execute(
                "INSERT INTO meetings(id, title, started_at, source, status) "
                "VALUES (?1, ?2, ?3, 'note', 'stopped')",
                (meeting_id, title, _now()),
            )
            db.execute("INSERT INTO notes(meeting_id) VALUES (?1)", (meeting_id,))
    ctx.emit("meeting_updated", None)
    return meeting_id


def save_notes(ctx: Context, id: str, markdown: str, expected_revision: int) -> int:
    _text(id, "id")
    markdown = _text(markdown, "markdown")
    expected_revision = _int(expected_revision, "expected_revision")
    if len(markdown.encode("utf-8")) > MAX_NOTES_BYTES or not (
        0 <= expected_revision < 2**63 - 1
    ):
        raise AppError(
            "invalid_notes", "Notes exceed the 1 MiB limit or have an invalid revision."
        )
    with ctx.store.lock:
        cursor = ctx.store.db.execute(
            "UPDATE notes SET user_markdown = ?1, revision = revision + 1 "
            "WHERE meeting_id = ?2 AND revision = ?3",
            (markdown, id, expected_revision),
        )
        if cursor.rowcount != 1:
            raise AppError(
                "notes_conflict",
                "Notes changed elsewhere or the meeting is missing. Copy your edits before "
                "reloading; nothing was overwritten.",
            )
    ctx.emit("meeting_updated", None)
    return expected_revision + 1


def rename_meeting(ctx: Context, id: str, title: str) -> str:
    title = _validate_title(_text(title, "title"))
    with ctx.store.lock:
        cursor = ctx.store.db.execute(
            "UPDATE meetings SET title = ?1 WHERE id = ?2", (title, _text(id, "id"))
        )
        if cursor.rowcount != 1:
            raise AppError("not_found", "Meeting not found.")
    ctx.emit("meeting_updated", None)
    return title


def set_meeting_tags(ctx: Context, meeting_id: str, tags: list[str]) -> list[str]:
    _text(meeting_id, "meeting_id")
    if not isinstance(tags, list):
        raise AppError("invalid_args", "tags must be a list of text.")
    clean: list[str] = []
    for raw in tags:
        tag = _text(raw, "tag").strip()
        if not tag:
            continue
        if len(tag) > MAX_TAG_CHARS or any(unicodedata.category(c) == "Cc" for c in tag):
            raise AppError("meeting_tag", "Use tags of 1 to 40 characters on one line.")
        if not any(existing.lower() == tag.lower() for existing in clean):
            clean.append(tag)
    if len(clean) > MAX_TAGS:
        raise AppError("meeting_tag", "Use at most 20 tags per meeting.")
    with ctx.store.lock:
        db = ctx.store.db
        with transaction(db) as tx:
            _require_meeting(tx, meeting_id)
            tx.execute("DELETE FROM meeting_tags WHERE meeting_id = ?1", (meeting_id,))
            for tag in clean:
                tx.execute(
                    "INSERT INTO meeting_tags (meeting_id, tag) VALUES (?1, ?2)",
                    (meeting_id, tag),
                )
        return _tags_of(db, meeting_id)


def delete_meeting(ctx: Context, id: str) -> None:
    _text(id, "id")
    with ctx.store.lock:
        db = ctx.store.db
        _require_meeting(db, id)
        # ponytail: Phase 1 never writes audio, so there are no track files to remove. Recording
        # (phase 3) must delete owned audio folders here before the rows go.
        db.execute("DELETE FROM meetings WHERE id = ?1", (id,))  # notes, tags, search rows cascade
    ctx.emit("meeting_updated", None)


def search_meetings(ctx: Context, query: str) -> list[dict[str, Any]]:
    query = "".join(c for c in _text(query, "query") if unicodedata.category(c) != "Cc").strip()
    if len(query) > MAX_SEARCH_CHARS:
        raise AppError("invalid_query", "Search for 200 characters or fewer.")
    # FTS5 tokens are letters and digits; a query with none would be an empty phrase.
    if not any(c.isalnum() for c in query):
        return []
    # One quoted phrase with doubled quotes keeps operators literal; the trailing * prefix-matches.
    phrase = '"' + query.replace('"', '""') + '"*'
    with ctx.store.lock:
        rows = ctx.store.db.execute(
            "SELECT meeting_id, kind, snippet(search, 2, '', '', '…', 12) FROM search "
            "WHERE search MATCH ?1 ORDER BY rank LIMIT 200",
            (phrase,),
        ).fetchall()
    hits: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for meeting_id, kind, snippet in rows:
        if (meeting_id, kind) in seen:
            continue
        seen.add((meeting_id, kind))
        hits.append({"meeting_id": meeting_id, "kind": kind, "snippet": snippet})
        if len(hits) == 20:
            break
    return hits


def export_meeting(ctx: Context, id: str) -> dict[str, Any]:
    with ctx.store.lock:
        settings = read_settings(ctx.store.db)
        folder = settings["vault_folder"]
        if not folder:
            raise AppError("no_vault", "Choose an export folder in Settings first.")
        detail = get_meeting(ctx, id)
    return write_snapshot(detail, Path(folder), settings["export"])


def list_summaries(ctx: Context, id: str) -> list[dict[str, Any]]:
    # ponytail: no summary rows can exist in Phase 1, so the list is empty. Phase 2 reads them.
    return []


def list_library_answers(ctx: Context) -> list[dict[str, Any]]:
    # ponytail: no library answers can be created in Phase 1. Phase 2 reads the table.
    return []


def get_session_processing(ctx: Context, id: str) -> None:
    # No session processing runs in Phase 1, so there is no snapshot.
    return None


# ---- recording state and startup (idle, harmless values) -------------------


def get_recording_state(ctx: Context) -> dict[str, Any]:
    return {
        "revision": 0,
        "status": "idle",
        "meeting_id": None,
        "source": None,
        "error": None,
        "recording_offset_ms": None,
        "processing_notice": None,
    }


def get_startup_warning(ctx: Context) -> None:
    return None


def list_audio_devices(ctx: Context) -> dict[str, Any]:
    return {"capture_supported": False, "microphones": [], "outputs": []}


def detection_supported(ctx: Context) -> bool:
    return False


def provider_key_status(ctx: Context, role: str) -> str:
    if role not in ("llm", "cloud_stt"):
        raise AppError("invalid_args", "Unknown provider role.")
    # Credentials live in the Windows keychain, which this build does not use yet.
    return "unavailable"


def stt_status(ctx: Context) -> dict[str, Any]:
    return {
        "engine": False,
        "model": False,
        "vad": False,
        "installed": False,
        "missing_bytes": 0,
        "supported": False,
        "models": [],
        "languages": [],
    }


def audio_usage(ctx: Context) -> int:
    # Phase 1 writes no audio; count any audio folder a future build may have left behind.
    root = ctx.store.data_dir / "audio"
    if not root.is_dir():
        return 0
    total = 0
    for folder in root.iterdir():
        if not folder.is_dir() or folder.is_symlink():
            continue
        for entry in folder.iterdir():
            if entry.is_file() and not entry.is_symlink():
                total += entry.stat().st_size
    return total


# ---- settings ------------------------------------------------------------------


def _formats_value(formats: list[str]) -> str:
    return ",".join(fmt for fmt in EXPORT_FORMATS if fmt in formats)


def _parse_formats(value: str) -> list[str]:
    tokens = {token.strip() for token in value.split(",")}
    return [fmt for fmt in EXPORT_FORMATS if fmt in tokens]


def read_settings(db: sqlite3.Connection) -> dict[str, Any]:
    """The Settings shape from src/lib/api.ts, read the way storage.rs read_settings does."""
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
        row = db.execute(
            "SELECT c.base_url, a.model, a.revision FROM provider_assignments a "
            "JOIN saved_connections c ON c.id = a.connection_id WHERE a.role = ?1",
            (role,),
        ).fetchone()
        if row is None:
            return None
        return {"base_url": row[0], "model": row[1], "revision": row[2]}

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
        "processing_mode, processing_summary, summary_default, detection_enabled, setup_done "
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
    }


def get_settings(ctx: Context) -> dict[str, Any]:
    with ctx.store.lock:
        return read_settings(ctx.store.db)


def save_export_options(ctx: Context, options: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(options, dict):
        raise AppError("invalid_args", "Export options must be an object.")
    transcript = _bool(options.get("transcript"), "transcript")
    summary = _bool(options.get("summary"), "summary")
    filename = options.get("filename")
    if filename not in ("title", "date_title"):
        raise AppError("invalid_args", "Choose a listed filename pattern.")
    formats = options.get("transcript_formats", [])
    if not isinstance(formats, list) or any(f not in EXPORT_FORMATS for f in formats):
        raise AppError("invalid_args", "Choose listed transcript formats.")
    with ctx.store.lock:
        db = ctx.store.db
        db.execute(
            "UPDATE settings SET export_transcript = ?1, export_summary = ?2, "
            "export_filename = ?3, export_transcript_formats = ?4 WHERE id = 1",
            (transcript, summary, filename, _formats_value(formats)),
        )
        return read_settings(db)


def save_setup_done(ctx: Context, done: bool) -> dict[str, Any]:
    done = _bool(done, "done")
    with ctx.store.lock:
        db = ctx.store.db
        db.execute("UPDATE settings SET setup_done = ?1 WHERE id = 1", (done,))
        return read_settings(db)


def choose_vault_folder(ctx: Context) -> dict[str, Any]:
    if ctx.pick_folder is None:
        raise not_available("Choosing a folder")
    picked = ctx.pick_folder()
    with ctx.store.lock:
        if picked is None:
            return read_settings(ctx.store.db)
        try:
            path = Path(picked).resolve(strict=True)
        except OSError as error:
            raise AppError("invalid_folder", "Select an existing folder.") from error
        if not path.is_dir():
            raise AppError("invalid_folder", "Select an existing folder.")
        ctx.store.db.execute("UPDATE settings SET vault_folder = ?1 WHERE id = 1", (str(path),))
        return read_settings(ctx.store.db)


def close_application(ctx: Context) -> None:
    if ctx.close_window is None:
        raise not_available("Closing from the app")
    # Closing destroys the window that is answering this request, so close just after the reply.
    threading.Timer(0.2, ctx.close_window).start()


# ---- registry ------------------------------------------------------------------

COMMANDS: dict[str, Callable[..., Any]] = {
    "list_meetings": list_meetings,
    "get_meeting": get_meeting,
    "create_note": create_note,
    "save_notes": save_notes,
    "rename_meeting": rename_meeting,
    "set_meeting_tags": set_meeting_tags,
    "delete_meeting": delete_meeting,
    "search_meetings": search_meetings,
    "export_meeting": export_meeting,
    "list_summaries": list_summaries,
    "list_library_answers": list_library_answers,
    "get_session_processing": get_session_processing,
    "get_recording_state": get_recording_state,
    "get_startup_warning": get_startup_warning,
    "list_audio_devices": list_audio_devices,
    "detection_supported": detection_supported,
    "provider_key_status": provider_key_status,
    "stt_status": stt_status,
    "audio_usage": audio_usage,
    "get_settings": get_settings,
    "save_export_options": save_export_options,
    "save_setup_done": save_setup_done,
    "choose_vault_folder": choose_vault_folder,
    "close_application": close_application,
}

# Command -> feature name for the 501 message. Each is planned for a later phase (docs/python-port-plan.md).
NOT_AVAILABLE: dict[str, str] = {
    # Phase 2: summaries, questions, tasks, library, providers
    "save_api_connection": "AI provider connections",
    "delete_api_connection": "AI provider connections",
    "api_connection_key_status": "AI provider connections",
    "save_provider_assignment": "AI provider assignments",
    "list_api_connection_models": "AI provider models",
    "generate_summary": "Summaries",
    "save_summary_edit": "Summary editing",
    "save_summary_instructions": "Summary instructions",
    "save_summary_template": "Summary templates",
    "delete_summary_template": "Summary templates",
    "save_summary_default": "Summary defaults",
    "ask_meeting": "Questions",
    "ask_library": "Library questions",
    "delete_question_thread": "Questions",
    "delete_library_answer": "Library answers",
    "rewrite_text": "Rewrite with AI",
    "save_recipe": "Question recipes",
    "delete_recipe": "Question recipes",
    "save_action_item": "Tasks",
    "delete_action_item": "Tasks",
    "import_action_items": "Tasks",
    "save_speaker_names": "Speaker names",
    "edit_segment": "Transcript editing",
    "get_transcript_version": "Transcript history",
    "save_processing_default": "Processing defaults",
    "acknowledge_processing_notes": "Session processing",
    "retry_session_processing": "Session processing",
    "cancel_session_processing": "Session processing",
    # Phase 3: capture and audio files
    "start_recording": "Recording",
    "pause_recording": "Recording",
    "resume_recording": "Recording",
    "stop_recording": "Recording",
    "save_default_devices": "Audio devices",
    "delete_audio": "Audio deletion",
    "recover_audio": "Audio recovery",
    "audio_position": "Audio playback",
    # Phase 4: local and cloud speech
    "save_stt_mode": "Speech settings",
    "save_stt_settings": "Speech settings",
    "stt_install": "Speech model installation",
    "transcribe_meeting": "Transcription",
    "cancel_transcription": "Transcription",
    "choose_model_folder": "Local models",
    "scan_local_models": "Local models",
    "import_local_model": "Local models",
    "search_hf_models": "Model downloads",
    "list_hf_files": "Model downloads",
    "download_hf_model": "Model downloads",
    "download_hf_folder": "Model downloads",
    "cancel_model_download": "Model downloads",
    "detect_local_servers": "Local AI server detection",
    # Phase 5: shortcuts, detection, attention
    "save_settings": "Keyboard shortcuts",
    "save_detection": "Meeting detection",
    "set_detection_ignored": "Meeting detection",
    "request_attention": "Taskbar attention",
}

_CAMEL_BOUNDARY = re.compile(r"(?<!^)(?=[A-Z])")


def snake_case(key: str) -> str:
    return _CAMEL_BOUNDARY.sub("_", key).lower()


def dispatch(ctx: Context, cmd: str, args: dict[str, Any]) -> Any:
    if cmd in NOT_AVAILABLE:
        raise not_available(NOT_AVAILABLE[cmd])
    handler = COMMANDS.get(cmd)
    if handler is None:
        raise AppError("unknown_command", f"Unknown command: {cmd}", status=404)
    kwargs = {snake_case(key): value for key, value in args.items()}
    try:
        inspect.signature(handler).bind(ctx, **kwargs)
    except TypeError as error:
        raise AppError("invalid_args", f"Invalid arguments for {cmd}.") from error
    try:
        return handler(ctx, **kwargs)
    except sqlite3.Error as error:
        raise AppError(
            "database",
            "The local database operation failed. Your previous saved data was not replaced.",
        ) from error
    except OSError as error:
        raise AppError("filesystem", f"File operation failed: {error.strerror or error}") from error
