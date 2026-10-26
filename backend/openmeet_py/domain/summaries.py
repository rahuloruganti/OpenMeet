"""Summaries, summary versions and edits, templates, instructions, defaults, recipes and speaker names.

Covers generate_summary and the storage/recipes save functions. A generated summary is saved only
if the notes, transcript, provider and speaker names are unchanged since the request was prepared.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Optional

from openmeet_py.api import reads
from openmeet_py.api.context import (
    Context, ai_slot, bool_arg, byte_len, has_control, optional_int_arg, optional_text_arg, text_arg,
)
from openmeet_py.api.errors import AppError
from openmeet_py.api.reads import transcript_hash
from openmeet_py.domain import enhancement, llm, providers
from openmeet_py.domain.connections import plan_changed
from openmeet_py.infra.store import transaction
from openmeet_py.local_ai import service as local_ai

MAX_SUMMARY_EDIT_BYTES = 2 * 1024 * 1024
EMPTY_EDIT = "Enter summary text. Nothing was saved."
MAX_SUMMARY_INSTRUCTIONS = 2000
MAX_TEMPLATE_INSTRUCTIONS = 4000
MAX_RECIPE_PROMPT = 1000


@dataclass(frozen=True)
class Snapshot:
    """What a text request was prepared from; any difference later means it must not be saved."""

    notes: str
    notes_revision: int
    lines: tuple[str, ...]
    segments: tuple[dict[str, Any], ...]
    names: dict[str, Optional[str]]
    config: Optional[dict[str, Any]]
    items: tuple[enhancement.Item, ...] = ()


def snapshot(db: sqlite3.Connection, meeting_id: str) -> Snapshot:
    detail = reads.meeting_detail(db, meeting_id)
    lines = reads.transcript_lines(detail["segments"], detail["speaker_names"])
    return Snapshot(
        notes=detail["user_markdown"],
        notes_revision=detail["notes_revision"],
        lines=tuple(lines),
        segments=tuple(detail["segments"]),
        names=detail["speaker_names"],
        config=reads.provider_config(db, "llm"),
        items=tuple(enhancement.items_of(detail)),
    )


def assert_unchanged(db: sqlite3.Connection, meeting_id: str, taken: Snapshot) -> None:
    try:
        current = snapshot(db, meeting_id)
    except AppError as error:
        if error.code == "not_found":
            raise plan_changed() from None
        raise
    if (
        current.config != taken.config
        or current.notes_revision != taken.notes_revision
        or current.lines != taken.lines
        or current.items != taken.items
    ):
        raise plan_changed()


def require_llm(db: sqlite3.Connection) -> dict[str, Any]:
    config = reads.provider_config(db, "llm")
    if config is None:
        raise AppError("provider_missing", "Save a provider connection in Settings first.")
    if not config["model"]:
        raise AppError("provider_model", "Choose and save a model in Settings first.")
    return config


def _sendable_text(snap: Snapshot) -> None:
    if not snap.notes.strip() and not snap.lines:
        raise AppError(
            "summary_empty", "There are no notes or transcript to send. Nothing was sent."
        )


def generate_summary(ctx: Context, id: Any, template: Any) -> None:
    meeting_id = text_arg(id, "id")
    template = text_arg(template, "template")
    with ctx.store.lock:
        db = ctx.store.db
        system = llm.resolve_summary(reads.read_settings(db), template)
        taken = snapshot(db, meeting_id)
        _sendable_text(taken)
        config = require_llm(db)
        planned = llm.summary_requests(taken.notes, list(taken.lines))
    with ai_slot(ctx):
        # A local model may have been turned off: bring the managed server back before sending.
        local_ai.ensure_ready(ctx, config)
        connection = providers.load_connection(config, ctx.transport)
        sent = 0

        def before(_body: bytes) -> None:
            nonlocal sent
            with ctx.store.lock:
                assert_unchanged(ctx.store.db, meeting_id, taken)
            sent += 1
            if sent > planned:
                raise plan_changed()

        markdown = llm.summarize(connection, system, taken.notes, list(taken.lines), before)
        with ctx.store.lock:
            db = ctx.store.db
            assert_unchanged(db, meeting_id, taken)
            db.execute(
                "INSERT INTO summaries(meeting_id, template_hash, model, provider, markdown, "
                "transcript_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                (
                    meeting_id,
                    template,
                    config["model"],
                    config["base_url"],
                    markdown,
                    transcript_hash(list(taken.segments), taken.names),
                ),
            )
    ctx.emit("meeting_updated", None)


def enhance_notes(ctx: Context, id: Any, template: Any) -> dict[str, Any]:
    """Enhanced notes from the raw notes plus the final transcript. The raw notes are never changed.

    Returns the saved row (list_summaries shape) plus notice (set when the transcript was trimmed),
    dropped_markers (citations that named no real segment) and trimmed_segments.
    """
    meeting_id = text_arg(id, "id")
    template = optional_text_arg(template, "template")
    with ctx.store.lock:
        db = ctx.store.db
        settings = reads.read_settings(db)
        template = template or settings["summary_default"]
        system = enhancement.system_prompt(llm.task_for(settings, template), settings["summary_instructions"])
        taken = snapshot(db, meeting_id)
        if not taken.items:
            raise AppError("enhance_no_transcript", "Enhanced notes need a transcript. Nothing was sent.")
        if not taken.notes.strip():
            raise AppError("enhance_no_notes", "Write notes first. Nothing was sent.")
        config = require_llm(db)
        planned = enhancement.plan(taken.notes, taken.items, system)
    with ai_slot(ctx):
        # A local model may have been turned off: bring the managed server back before sending.
        local_ai.ensure_ready(ctx, config)
        connection = providers.load_connection(config, ctx.transport)
        sent = 0

        def before(_body: bytes) -> None:
            nonlocal sent
            with ctx.store.lock:
                assert_unchanged(ctx.store.db, meeting_id, taken)
            sent += 1
            if sent > 1:
                raise plan_changed()

        markdown = enhancement.request(connection, planned, before)
    with ctx.store.lock:
        db = ctx.store.db
        assert_unchanged(db, meeting_id, taken)
        text, sources, dropped = enhancement.link_sources(markdown, planned.targets)
        saved = enhancement.store(
            db, meeting_id, template, config, text.strip(), sources,
            taken.notes_revision, transcript_hash(list(taken.segments), taken.names),
        )
        row = next(item for item in reads.list_summaries(db, meeting_id) if item["id"] == saved)
    ctx.emit("meeting_updated", None)
    notice = None
    if planned.trimmed:
        notice = (
            f"Only {planned.total - planned.trimmed} of {planned.total} transcript lines were sent: "
            "the middle of the meeting was left out to fit the size limit."
        )
    return {**row, "notice": notice, "dropped_markers": dropped, "trimmed_segments": planned.trimmed}


def list_summaries(ctx: Context, id: Any) -> list[dict[str, Any]]:
    with ctx.store.lock:
        return reads.list_summaries(ctx.store.db, text_arg(id, "id"))


def save_summary_edit(
    ctx: Context, meeting_id: Any, base_id: Any, expected_latest_id: Any, markdown: Any
) -> None:
    meeting_id = text_arg(meeting_id, "meeting_id")
    base_id = optional_int_arg(base_id, "base_id")
    expected = optional_int_arg(expected_latest_id, "expected_latest_id")
    markdown = text_arg(markdown, "markdown")
    if not markdown.strip():
        raise AppError("summary_edit", EMPTY_EDIT)
    if byte_len(markdown) > MAX_SUMMARY_EDIT_BYTES:
        raise AppError("summary_edit", "Enter summary text of at most 2 MiB.")
    with ctx.store.lock:
        db = ctx.store.db
        with transaction(db) as tx:
            kind_row = tx.execute(
                "SELECT kind FROM summaries WHERE id=?1 AND meeting_id=?2", (base_id, meeting_id)
            ).fetchone()
            kind = kind_row[0] if kind_row else "summary"
            latest = tx.execute(
                "SELECT max(id) FROM summaries WHERE meeting_id=?1 AND kind=?2", (meeting_id, kind)
            ).fetchone()[0]
            if latest != expected:
                raise AppError(
                    "summary_conflict",
                    "A newer summary version arrived while you were editing. Review it in the version "
                    "picker; saving again puts your edit on top of it.",
                )
            base = tx.execute(
                "SELECT markdown, template_hash, model, provider, transcript_hash, notes_revision "
                "FROM summaries WHERE id=?1 AND meeting_id=?2",
                (base_id, meeting_id),
            ).fetchone()
            if base is None:
                raise AppError("not_found", "This summary version is not available.")
            if base[0] == markdown:
                raise AppError("summary_edit", "The summary is unchanged. Nothing was saved.")
            text, sources = markdown, []
            if kind == "enhanced":
                # Citations typed into an edit are checked the same way as generated ones.
                text, sources, _ = enhancement.link_sources(markdown, enhancement.targets_of(tx, meeting_id))
                if not text.strip():
                    raise AppError("summary_edit", EMPTY_EDIT)
            tx.execute(
                "INSERT INTO summaries(meeting_id, template_hash, model, provider, markdown, "
                "edited_from, transcript_hash, kind, notes_revision, sources_json) "
                "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                (
                    meeting_id, base[1], base[2], base[3], text, base_id, base[4], kind, base[5],
                    json.dumps(sources, ensure_ascii=False),
                ),
            )
    ctx.emit("meeting_updated", None)


# ---- settings: instructions, templates, defaults ------------------------------


def save_summary_instructions(ctx: Context, instructions: Any) -> dict[str, Any]:
    text = text_arg(instructions, "instructions").strip()
    llm.validate_instructions(text, MAX_SUMMARY_INSTRUCTIONS)
    with ctx.store.lock:
        ctx.store.db.execute("UPDATE settings SET summary_instructions = ?1 WHERE id = 1", (text,))
        return reads.read_settings(ctx.store.db)


@dataclass(frozen=True)
class Named:
    table: str
    column: str
    prefix: str
    code: str
    noun: str
    cap: int
    missing: Callable[[], AppError]


def _missing_template() -> AppError:
    return AppError(
        "summary_template_missing",
        "This summary template no longer exists. Choose another template.",
    )


def _missing_recipe() -> AppError:
    return AppError("recipe_missing", "This recipe no longer exists.")


TEMPLATES = Named(
    "summary_templates", "instructions", llm.CUSTOM_TEMPLATE_PREFIX, "summary_template",
    "custom template", 50, _missing_template,
)
RECIPES = Named("recipes", "prompt", "recipe-", "recipe", "recipe", 50, _missing_recipe)


def _save_named(db: sqlite3.Connection, kind: Named, id: Optional[str], name: str, body: str) -> None:
    name = name.strip()
    if not name or len(name) > 80 or has_control(name):
        raise AppError(kind.code, f"Enter a {kind.noun} name of 1–80 characters on one line.")
    if id is not None:
        changed = db.execute(
            f"UPDATE {kind.table} SET name=?2, {kind.column}=?3 WHERE id=?1", (id, name, body)
        ).rowcount
    else:
        count = db.execute(f"SELECT COUNT(*) FROM {kind.table}").fetchone()[0]
        if count >= kind.cap:
            raise AppError(kind.code, f"You can save up to {kind.cap} {kind.noun}s.")
        changed = db.execute(
            f"INSERT INTO {kind.table}(id, name, {kind.column}) VALUES (?1, ?2, ?3)",
            (f"{kind.prefix}{uuid.uuid4()}", name, body),
        ).rowcount
    if changed != 1:
        raise kind.missing()


def _delete_named(db: sqlite3.Connection, kind: Named, id: str) -> None:
    if db.execute(f"DELETE FROM {kind.table} WHERE id=?1", (id,)).rowcount != 1:
        raise kind.missing()


def save_summary_template(ctx: Context, id: Any, name: Any, instructions: Any) -> dict[str, Any]:
    id = optional_text_arg(id, "id")
    name = text_arg(name, "name")
    text = text_arg(instructions, "instructions").strip()
    llm.validate_instructions(text, MAX_TEMPLATE_INSTRUCTIONS)
    if not text:
        raise AppError("summary_template", "Describe the summary structure for this template.")
    with ctx.store.lock:
        _save_named(ctx.store.db, TEMPLATES, id, name, text)
        return reads.read_settings(ctx.store.db)


def delete_summary_template(ctx: Context, id: Any) -> dict[str, Any]:
    id = text_arg(id, "id")
    with ctx.store.lock:
        db = ctx.store.db
        _delete_named(db, TEMPLATES, id)
        # A deleted default falls back to General instead of pointing at nothing.
        db.execute(
            "UPDATE settings SET summary_default = 'general-v1' WHERE id = 1 AND summary_default = ?1",
            (id,),
        )
        return reads.read_settings(db)


def save_summary_default(ctx: Context, template: Any) -> dict[str, Any]:
    template = text_arg(template, "template")
    with ctx.store.lock:
        db = ctx.store.db
        known = template in llm.TEMPLATE_IDS or any(
            custom["id"] == template for custom in reads.read_settings(db)["summary_templates"]
        )
        if not known:
            raise _missing_template()
        db.execute("UPDATE settings SET summary_default = ?1 WHERE id = 1", (template,))
        return reads.read_settings(db)


PROCESSING_MODES = ("recording", "final")
# Modes the old live preview used. A saved value is mapped, not refused, so an older database can
# still save its default.
LEGACY_MODES = {"live": "recording", "both": "final"}


def save_processing_default(ctx: Context, mode: Any, summary: Any) -> dict[str, Any]:
    """Only preselects the recording setup; it stores the default and starts nothing."""
    mode = text_arg(mode, "mode")
    mode = LEGACY_MODES.get(mode, mode)
    summary = optional_text_arg(summary, "summary")
    # A summary only applies to the mode that produces one.
    summary = summary if mode == "final" else None
    if mode not in PROCESSING_MODES or (summary is not None and summary not in llm.TEMPLATE_IDS):
        raise AppError(
            "processing_default", "Choose a listed processing mode and built-in summary template."
        )
    with ctx.store.lock:
        db = ctx.store.db
        db.execute(
            "UPDATE settings SET processing_mode = ?1, processing_summary = ?2 WHERE id = 1",
            (mode, summary),
        )
        return reads.read_settings(db)


def save_processing_enhance(ctx: Context, enabled: Any) -> dict[str, Any]:
    """Whether automatic processing also writes enhanced notes after its summary."""
    enabled = bool_arg(enabled, "enabled")
    with ctx.store.lock:
        db = ctx.store.db
        db.execute("UPDATE settings SET processing_enhance = ?1 WHERE id = 1", (int(enabled),))
        return reads.read_settings(db)


# ---- recipes -----------------------------------------------------------------


def save_recipe(ctx: Context, id: Any, name: Any, prompt: Any) -> dict[str, Any]:
    id = optional_text_arg(id, "id")
    name = text_arg(name, "name")
    text = text_arg(prompt, "prompt").strip()
    if not text:
        raise AppError("recipe", "Write the question this recipe asks.")
    try:
        llm.validate_instructions(text, MAX_RECIPE_PROMPT)
    except AppError as error:
        raise AppError("recipe", error.message) from None
    with ctx.store.lock:
        _save_named(ctx.store.db, RECIPES, id, name, text)
        return reads.read_settings(ctx.store.db)


def delete_recipe(ctx: Context, id: Any) -> dict[str, Any]:
    with ctx.store.lock:
        _delete_named(ctx.store.db, RECIPES, text_arg(id, "id"))
        return reads.read_settings(ctx.store.db)


# ---- speaker names -----------------------------------------------------------


def _speaker_name(value: Optional[str]) -> Optional[str]:
    cleaned = (value or "").strip()
    if len(cleaned) > 80 or has_control(cleaned):
        raise AppError("speaker_name", "Keep each speaker name on one line, at most 80 characters.")
    return cleaned or None


def save_speaker_names(ctx: Context, meeting_id: Any, you: Any, others: Any) -> dict[str, Any]:
    meeting_id = text_arg(meeting_id, "meeting_id")
    names = [("You", _speaker_name(optional_text_arg(you, "you"))),
             ("Others", _speaker_name(optional_text_arg(others, "others")))]
    with ctx.store.lock:
        db = ctx.store.db
        reads.require_meeting(db, meeting_id)
        with transaction(db):
            for speaker, name in names:
                if name is None:
                    db.execute(
                        "DELETE FROM speaker_names WHERE meeting_id=?1 AND speaker=?2",
                        (meeting_id, speaker),
                    )
                else:
                    db.execute(
                        "INSERT INTO speaker_names(meeting_id, speaker, name) VALUES (?1, ?2, ?3) "
                        "ON CONFLICT(meeting_id, speaker) DO UPDATE SET name=excluded.name",
                        (meeting_id, speaker, name),
                    )
    ctx.emit("meeting_updated", None)
    with ctx.store.lock:
        return reads.speaker_names(ctx.store.db, meeting_id)
