"""Command handlers for the Python build, keyed by the snake_case names the React UI invokes.

Names and argument shapes follow src/lib/api.ts, the UI's own client. Phases 1 to 4a are
implemented here and in the feature modules. Every other command is listed in NOT_AVAILABLE and
answers HTTP 501.
"""

from __future__ import annotations

import inspect
import re
import sqlite3
import threading
import unicodedata
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from openmeet_py.api import auto_capture, import_commands, lifecycle, live_commands, reads, recording
from openmeet_py.api.context import (
    Context,
    bool_arg,
    int_arg,
    now,
    text_arg as _text,
    int_arg as _int,
    bool_arg as _bool,
)
from openmeet_py.api.errors import AppError, not_available
from openmeet_py.api.reads import EXPORT_FORMATS, read_settings
from openmeet_py.domain import connections, processing, questions, summaries, tasks, transcript_edits
from openmeet_py.domain.exporter import write_snapshot
from openmeet_py.infra.store import transaction
from openmeet_py.local_ai import service as local_ai
from openmeet_py.platform import detection, hotkeys
from openmeet_py.speech import model_library, stt
from openmeet_py.speech.transcription import jobs

MAX_NOTES_BYTES = 1024 * 1024
MAX_TAGS = 20
MAX_TAG_CHARS = 40
MAX_SEARCH_CHARS = 200

__all__ = ["Context", "COMMANDS", "NOT_AVAILABLE", "dispatch", "snake_case"]


# ---- helpers ---------------------------------------------------------------


def _validate_title(title: str) -> str:
    title = title.strip()
    if not title or len(title) > 160:
        raise AppError("invalid_title", "Use a meeting title between 1 and 160 characters.")
    return title


def _require_meeting(db: sqlite3.Connection, meeting_id: str) -> None:
    reads.require_meeting(db, meeting_id)


def _tags_of(db: sqlite3.Connection, meeting_id: str) -> list[str]:
    return reads.tags_of(db, meeting_id)


# ---- meetings and notes ------------------------------------------------------


def list_meetings(ctx: Context) -> list[dict[str, Any]]:
    with ctx.store.lock:
        db = ctx.store.db
        rows = db.execute(reads.MEETING_COLUMNS + " ORDER BY started_at DESC, id DESC").fetchall()
        tags: dict[str, list[str]] = {}
        for meeting_id, tag in db.execute(
            "SELECT meeting_id, tag FROM meeting_tags ORDER BY tag"
        ).fetchall():
            tags.setdefault(meeting_id, []).append(tag)
    return [reads.meeting_dict(row, tags.get(row[0], [])) for row in rows]


def get_meeting(ctx: Context, id: str) -> dict[str, Any]:
    _text(id, "id")
    with ctx.store.lock:
        return reads.meeting_detail(ctx.store.db, id)


def create_note(ctx: Context, title: str) -> str:
    title = _validate_title(_text(title, "title"))
    meeting_id = str(uuid.uuid4())
    with ctx.store.lock:
        with transaction(ctx.store.db) as db:
            db.execute(
                "INSERT INTO meetings(id, title, started_at, source, status) "
                "VALUES (?1, ?2, ?3, 'note', 'stopped')",
                (meeting_id, title, now()),
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
    # Lock order: recorder, then store (see recorder.py).
    with ctx.recorder.lock, ctx.store.lock:
        db = ctx.store.db
        _require_meeting(db, id)
        # Track files first: a refused or failed delete leaves the meeting and its notes in place.
        recording.delete_owned_audio(ctx, db, id)
        db.execute("DELETE FROM meetings WHERE id = ?1", (id,))  # notes, tags, search, answers cascade
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
    return summaries.list_summaries(ctx, id)


def list_library_answers(ctx: Context) -> list[dict[str, Any]]:
    return questions.list_library_answers(ctx)


def provider_key_status(ctx: Context, role: str) -> str:
    return connections.provider_key_status(ctx, role)


# ---- settings ------------------------------------------------------------------


def _formats_value(formats: list[str]) -> str:
    return ",".join(fmt for fmt in EXPORT_FORMATS if fmt in formats)


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


THEMES = ("system", "dark", "light")


def save_ui_prefs(ctx: Context, theme: str, inspector_open: bool) -> dict[str, Any]:
    """The window's own preferences: the colour theme and the meeting inspector's open state."""
    theme = _text(theme, "theme")
    if theme not in THEMES:
        raise AppError("invalid_args", "Choose System, Dark or Light.")
    inspector_open = _bool(inspector_open, "inspector_open")
    with ctx.store.lock:
        db = ctx.store.db
        db.execute(
            "UPDATE settings SET theme = ?1, inspector_open = ?2 WHERE id = 1",
            (theme, int(inspector_open)),
        )
        return read_settings(db)


def data_folder(ctx: Context) -> dict[str, Any]:
    """This build's own data folder, shown read-only in Export & storage.

    It comes from the open Store, so a test or a preview that runs on another folder reports
    that folder and never the shipped default.
    """
    return {"path": str(ctx.store.data_dir)}


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
    # Phase 3: devices, recording and audio files
    "get_recording_state": recording.get_recording_state,
    "list_audio_devices": recording.list_audio_devices,
    "save_default_devices": recording.save_default_devices,
    "start_recording": recording.start_recording,
    "pause_recording": recording.pause_recording,
    "resume_recording": recording.resume_recording,
    "stop_recording": recording.stop_recording,
    "delete_audio": recording.delete_audio,
    "recover_audio": recording.recover_audio,
    "audio_position": recording.audio_position,
    "audio_usage": recording.audio_usage,
    # Phase 5: global shortcuts, meeting detection, taskbar attention, session processing
    "get_startup_warning": hotkeys.get_startup_warning,
    "save_settings": hotkeys.save_settings,
    "detection_supported": detection.detection_supported,
    "save_detection": detection.save_detection,
    "set_detection_ignored": detection.set_detection_ignored,
    "save_auto_capture": auto_capture.save_auto_capture,
    "get_call_lifecycle": lifecycle.get_call_lifecycle,
    "lifecycle_keep_recording": lifecycle.lifecycle_keep_recording,
    "lifecycle_end_now": lifecycle.lifecycle_end_now,
    "request_attention": detection.request_attention,
    "get_session_processing": processing.get_session_processing,
    "acknowledge_processing_notes": processing.acknowledge_processing_notes,
    "retry_session_processing": processing.retry_session_processing,
    "cancel_session_processing": processing.cancel_session_processing,
    "provider_key_status": provider_key_status,
    # Phase 4a: local and cloud speech, model library, transcripts
    "save_stt_mode": stt.save_stt_mode,
    "save_stt_settings": stt.save_stt_settings,
    "stt_install": stt.stt_install,
    "transcribe_meeting": jobs.transcribe_meeting,
    "cancel_transcription": jobs.cancel_transcription,
    "edit_segment": transcript_edits.edit_segment_command,
    "get_transcript_version": transcript_edits.get_transcript_version,
    "choose_model_folder": model_library.choose_model_folder,
    "scan_local_models": model_library.scan_local_models,
    "import_local_model": model_library.import_local_model,
    "search_hf_models": model_library.search_hf_models,
    "list_hf_files": model_library.list_hf_files,
    "download_hf_model": model_library.download_hf_model_command,
    "download_hf_folder": model_library.download_hf_folder_command,
    "cancel_model_download": model_library.cancel_model_download,
    "detect_local_servers": connections.detect_local_servers,
    "stt_status": stt.stt_status,
    # Local AI: the managed llama.cpp server running a downloaded model on this PC
    "local_ai_status": local_ai.local_ai_status,
    "local_ai_install_engine": local_ai.local_ai_install_engine,
    "local_ai_download_model": local_ai.local_ai_download_model,
    "local_ai_remove_model": local_ai.local_ai_remove_model,
    "local_ai_cancel": local_ai.local_ai_cancel,
    "local_ai_use": local_ai.local_ai_use,
    "local_ai_quickstart": local_ai.local_ai_quickstart,
    "local_ai_start": local_ai.local_ai_start,
    "local_ai_stop": local_ai.local_ai_stop,
    "get_settings": get_settings,
    "save_export_options": save_export_options,
    "save_setup_done": save_setup_done,
    "save_ui_prefs": save_ui_prefs,
    "data_folder": data_folder,
    "choose_vault_folder": choose_vault_folder,
    "close_application": close_application,
    # The one-time import from the previous OpenMeet data folder, run while the app is open
    "import_status": import_commands.import_status,
    "import_previous": import_commands.import_previous,
    # Phase 2: providers, summaries, questions, tasks, library, rewrite, templates, recipes
    "save_api_connection": connections.save_api_connection,
    "delete_api_connection": connections.delete_api_connection,
    "api_connection_key_status": connections.api_connection_key_status,
    "save_provider_assignment": connections.save_provider_assignment,
    "list_api_connection_models": connections.list_api_connection_models,
    "test_api_connection": connections.test_api_connection,
    "generate_summary": summaries.generate_summary,
    "save_summary_edit": summaries.save_summary_edit,
    "save_summary_instructions": summaries.save_summary_instructions,
    "save_summary_template": summaries.save_summary_template,
    "delete_summary_template": summaries.delete_summary_template,
    "save_summary_default": summaries.save_summary_default,
    "save_processing_default": summaries.save_processing_default,
    # Live transcript: its switch, its engine and its one explicit streaming model download
    "live_transcript": live_commands.live_transcript,
    "save_live_settings": live_commands.save_live_settings,
    "live_models": live_commands.live_models,
    "live_model_install": live_commands.live_model_install,
    "live_model_cancel": live_commands.live_model_cancel,
    "save_recipe": summaries.save_recipe,
    "delete_recipe": summaries.delete_recipe,
    "save_speaker_names": summaries.save_speaker_names,
    "ask_meeting": questions.ask_meeting,
    "ask_library": questions.ask_library,
    "delete_question_thread": questions.delete_question_thread,
    "delete_library_answer": questions.delete_library_answer,
    "rewrite_text": questions.rewrite_text,
    "save_action_item": tasks.save_action_item,
    "delete_action_item": tasks.delete_action_item,
    "import_action_items": tasks.import_action_items,
}

# Commands that answer HTTP 501, mapped to the feature name. Empty after phase 5: every command the UI
# invokes is implemented. Tray controls are deferred, but they have no command.
NOT_AVAILABLE: dict[str, str] = {}

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
