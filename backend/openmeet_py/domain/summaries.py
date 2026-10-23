"""Summaries, summary versions and edits, templates, instructions, defaults, recipes and speaker names.

Covers generate_summary and the storage/recipes save functions. A generated summary is saved only
if the notes, transcript, provider and speaker names are unchanged since the request was prepared.
"""

from __future__ import annotations

import sqlite3
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Optional

from openmeet_py.api import reads
from openmeet_py.api.context import (
    Context, ai_slot, byte_len, has_control, optional_int_arg, optional_text_arg, text_arg,
)
from openmeet_py.api.errors import AppError
from openmeet_py.api.reads import transcript_hash
from openmeet_py.domain import llm, providers
from openmeet_py.domain.connections import plan_changed
from openmeet_py.infra.store import transaction

MAX_SUMMARY_EDIT_BYTES = 2 * 1024 * 1024
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
    if not markdown.strip() or byte_len(markdown) > MAX_SUMMARY_EDIT_BYTES:
        raise AppError("summary_edit", "Enter summary text of at most 2 MiB.")
    with ctx.store.lock:
        db = ctx.store.db
        with transaction(db) as tx:
            latest = tx.execute(
                "SELECT max(id) FROM summaries WHERE meeting_id=?1", (meeting_id,)
            ).fetchone()[0]
            if latest != expected:
                raise AppError(
                    "summary_conflict",
                    "A newer summary version arrived while you were editing. Review it in the version "
                    "picker; saving again puts your edit on top of it.",
                )
            base = tx.execute(
                "SELECT markdown, template_hash, model, provider, transcript_hash FROM summaries "
                "WHERE id=?1 AND meeting_id=?2",
                (base_id, meeting_id),
            ).fetchone()
            if base is None:
                raise AppError("not_found", "This summary version is not available.")
            if base[0] == markdown:
                raise AppError("summary_edit", "The summary is unchanged. Nothing was saved.")
            tx.execute(
                "INSERT INTO summaries(meeting_id, template_hash, model, provider, markdown, "
                "edited_from, transcript_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                (meeting_id, base[1], base[2], base[3], markdown, base_id, base[4]),
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


PROCESSING_MODES = ("recording", "live", "final", "both")


def save_processing_default(ctx: Context, mode: Any, summary: Any) -> dict[str, Any]:
    """Only preselects the recording setup; it stores the default and starts nothing."""
    mode = text_arg(mode, "mode")
    summary = optional_text_arg(summary, "summary")
    # A summary only applies to modes that produce one.
    summary = summary if mode in ("final", "both") else None
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
