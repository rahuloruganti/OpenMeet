"""Meeting questions with saved threads, library questions over several meetings, and rewrites.

Ports lib.rs ask_meeting, ask_library, rewrite_text and question_threads.rs / library_answers.rs. What
is sent is computed from stored data at send time and rechecked before each request and before saving.
When the content is too long, only keyword-matched excerpts are sent; with no match nothing is sent.
"""

from __future__ import annotations

import dataclasses
import sqlite3
from dataclasses import dataclass
from typing import Any, Optional

from . import llm, providers, reads
from .connections import plan_changed
from .context import Context, ai_slot, int_arg, list_arg, optional_int_arg, text_arg
from .errors import AppError
from .store import transaction
from .summaries import require_llm


def insufficient_evidence() -> AppError:
    return AppError(
        "insufficient_evidence",
        "No passages in the selected content matched your question. Nothing was sent.",
    )


# ---- meeting questions -------------------------------------------------------


@dataclass(frozen=True)
class Content:
    notes: str
    lines: tuple[str, ...]
    excerpts: bool


def question_content(
    notes: str, lines: list[str], question: str, earlier: list[dict[str, Any]]
) -> Content:
    """Everything when it fits one request; otherwise the keyword excerpts, or nothing."""
    llm.check_question(question, earlier)
    if llm.question_fits(notes, lines, question, earlier):
        return Content(notes, tuple(lines), False)
    found = llm.terms(question)
    excerpt_notes = llm.notes_excerpt(notes, found, llm.NOTES_SHARE)
    budget = llm.question_budget(excerpt_notes, question, earlier)
    chosen = llm.select_lines([lines], found, budget)[0]
    if not chosen and not excerpt_notes:
        raise insufficient_evidence()
    return Content(excerpt_notes, tuple(llm.excerpt_lines(lines, chosen)), True)


def earlier_turns(threads: list[dict[str, Any]], thread_id: Optional[int]) -> list[dict[str, Any]]:
    if thread_id is None:
        return []
    for thread in threads:
        if thread["id"] == thread_id:
            return thread["turns"]
    raise AppError("not_found", "This question thread no longer exists.")


def _ask_unchanged(
    db: sqlite3.Connection,
    meeting_id: str,
    config: dict[str, Any],
    revision: int,
    question: str,
    thread_id: Optional[int],
    earlier: list[dict[str, Any]],
    content: Content,
) -> None:
    try:
        current = reads.meeting_detail(db, meeting_id)
        lines = reads.transcript_lines(current["segments"], current["speaker_names"])
        now_earlier = earlier_turns(current["question_threads"], thread_id)
        now = question_content(current["user_markdown"], lines, question, now_earlier)
    except AppError:
        raise plan_changed() from None
    if (
        reads.provider_config(db, "llm") != config
        or current["notes_revision"] != revision
        or now_earlier != earlier
        or now != content
    ):
        raise plan_changed()


def save_question_turn(
    db: sqlite3.Connection,
    meeting_id: str,
    thread_id: Optional[int],
    question: str,
    answer: str,
    provider: str,
    model: str,
) -> dict[str, Any]:
    with transaction(db) as tx:
        if thread_id is not None:
            found = tx.execute(
                "SELECT id FROM question_threads WHERE id=?1 AND meeting_id=?2",
                (thread_id, meeting_id),
            ).fetchone()
            if found is None:
                raise AppError("not_found", "This question thread no longer exists.")
            target = thread_id
        else:
            target = tx.execute(
                "INSERT INTO question_threads(meeting_id) VALUES (?1)", (meeting_id,)
            ).lastrowid
        tx.execute(
            "INSERT INTO question_turns(thread_id, question, answer, provider, model) "
            "VALUES (?1, ?2, ?3, ?4, ?5)",
            (target, question, answer, provider, model),
        )
    for thread in reads.question_threads(db, meeting_id):
        if thread["id"] == target:
            return thread
    raise AppError("not_found", "This question thread no longer exists.")


def ask_meeting(ctx: Context, id: Any, question: Any, thread_id: Any = None) -> dict[str, Any]:
    meeting_id = text_arg(id, "id")
    question = text_arg(question, "question")
    thread_id = optional_int_arg(thread_id, "thread_id")
    with ctx.store.lock:
        db = ctx.store.db
        detail = reads.meeting_detail(db, meeting_id)
        if not detail["user_markdown"].strip() and not detail["segments"]:
            raise AppError("summary_empty", "There are no notes or transcript to send. Nothing was sent.")
        config = require_llm(db)
        earlier = earlier_turns(detail["question_threads"], thread_id)
        lines = reads.transcript_lines(detail["segments"], detail["speaker_names"])
        content = question_content(detail["user_markdown"], lines, question, earlier)
        revision = detail["notes_revision"]
    with ai_slot(ctx):
        connection = providers.load_connection(config, ctx.transport)

        def before(_body: bytes) -> None:
            with ctx.store.lock:
                _ask_unchanged(
                    ctx.store.db, meeting_id, config, revision, question, thread_id, earlier, content
                )

        answer = llm.ask(
            connection,
            content.notes,
            list(content.lines),
            content.excerpts,
            question,
            earlier,
            before,
        )
        with ctx.store.lock:
            db = ctx.store.db
            _ask_unchanged(db, meeting_id, config, revision, question, thread_id, earlier, content)
            thread = save_question_turn(
                db, meeting_id, thread_id, question.strip(), answer, config["base_url"], config["model"]
            )
    ctx.emit("meeting_updated", None)
    return thread


def delete_question_thread(ctx: Context, meeting_id: Any, thread_id: Any) -> list[dict[str, Any]]:
    meeting_id = text_arg(meeting_id, "meeting_id")
    thread_id = int_arg(thread_id, "thread_id")
    with ctx.store.lock:
        db = ctx.store.db
        deleted = db.execute(
            "DELETE FROM question_threads WHERE id=?1 AND meeting_id=?2", (thread_id, meeting_id)
        ).rowcount
        if deleted == 0:
            raise AppError("not_found", "This question thread no longer exists.")
        return reads.question_threads(db, meeting_id)


# ---- library -----------------------------------------------------------------


def library_ids(values: list[Any]) -> list[str]:
    seen: list[str] = []
    for value in values:
        meeting_id = text_arg(value, "meeting_ids")
        if meeting_id not in seen:
            seen.append(meeting_id)
    if not seen or len(seen) > llm.MAX_LIBRARY_MEETINGS:
        raise AppError(
            "invalid_scope",
            f"Choose 1 to {llm.MAX_LIBRARY_MEETINGS} meetings. Nothing was sent.",
        )
    return seen


def library_scope(
    db: sqlite3.Connection, ids: list[str], question: str
) -> tuple[list[llm.LibraryItem], bool]:
    """Each meeting as it would be sent, plus whether those are keyword excerpts."""
    details = []
    for meeting_id in ids:
        try:
            details.append(reads.meeting_detail(db, meeting_id))
        except AppError as error:
            if error.code == "not_found":
                raise AppError(
                    "invalid_scope", "A selected meeting no longer exists. Nothing was sent."
                ) from None
            raise
    full = [
        llm.LibraryItem(
            id=detail["meeting"]["id"],
            title=detail["meeting"]["title"],
            started_at=detail["meeting"]["started_at"],
            notes_revision=detail["notes_revision"],
            notes=detail["user_markdown"],
            lines=tuple(reads.transcript_lines(detail["segments"], detail["speaker_names"])),
        )
        for detail in details
    ]
    llm.check_library(full, question)
    if llm.library_fits(full, question):
        return full, False
    found = llm.terms(question)
    share = llm.NOTES_SHARE // len(full)
    items = [
        dataclasses.replace(item, notes=llm.notes_excerpt(item.notes, found, share), lines=())
        for item in full
    ]
    chosen = llm.select_lines(
        [list(item.lines) for item in full], found, llm.library_budget(items, question)
    )
    if all(not picked for picked in chosen) and all(not item.notes for item in items):
        raise insufficient_evidence()
    items = [
        dataclasses.replace(item, lines=tuple(llm.excerpt_lines(list(item.lines), picked)))
        for item, picked in zip(full, chosen)
    ]
    return items, True


def _library_unchanged(
    db: sqlite3.Connection,
    ids: list[str],
    config: dict[str, Any],
    question: str,
    items: list[llm.LibraryItem],
    excerpted: bool,
) -> None:
    try:
        now = library_scope(db, ids, question)
    except AppError:
        raise plan_changed() from None
    if reads.provider_config(db, "llm") != config or now != (items, excerpted):
        raise plan_changed()


def save_library_answer(
    db: sqlite3.Connection, ids: list[str], question: str, answer: str, provider: str, model: str
) -> dict[str, Any]:
    with transaction(db) as tx:
        answer_id = tx.execute(
            "INSERT INTO library_answers(question, answer, provider, model) VALUES (?1, ?2, ?3, ?4)",
            (question, answer, provider, model),
        ).lastrowid
        for position, meeting_id in enumerate(ids):
            tx.execute(
                "INSERT INTO library_answer_meetings(answer_id, position, meeting_id) VALUES (?1, ?2, ?3)",
                (answer_id, position, meeting_id),
            )
    return {
        "id": answer_id,
        "question": question,
        "answer": answer,
        "provider": provider,
        "model": model,
        "meeting_ids": ids,
    }


def ask_library(ctx: Context, meeting_ids: Any, question: Any) -> dict[str, Any]:
    ids = library_ids(list_arg(meeting_ids, "meeting_ids"))
    question = text_arg(question, "question")
    with ctx.store.lock:
        db = ctx.store.db
        items, excerpted = library_scope(db, ids, question)
        config = require_llm(db)
    with ai_slot(ctx):
        connection = providers.load_connection(config, ctx.transport)

        def before(_body: bytes) -> None:
            with ctx.store.lock:
                _library_unchanged(ctx.store.db, ids, config, question, items, excerpted)

        answer = llm.ask_library(connection, items, excerpted, question, before)
        with ctx.store.lock:
            db = ctx.store.db
            _library_unchanged(db, ids, config, question, items, excerpted)
            saved = save_library_answer(
                db, ids, question.strip(), answer, config["base_url"], config["model"]
            )
    return saved


def list_library_answers(ctx: Context) -> list[dict[str, Any]]:
    with ctx.store.lock:
        return reads.library_answers(ctx.store.db)


def delete_library_answer(ctx: Context, id: Any) -> list[dict[str, Any]]:
    answer_id = int_arg(id, "id")
    with ctx.store.lock:
        db = ctx.store.db
        if db.execute("DELETE FROM library_answers WHERE id=?1", (answer_id,)).rowcount == 0:
            raise AppError("not_found", "This saved answer no longer exists.")
        return reads.library_answers(db)


# ---- rewrite -----------------------------------------------------------------


def rewrite_text(ctx: Context, text: Any, request: Any) -> str:
    """Sends only the selected text and the request. The result is returned and never stored."""
    text = text_arg(text, "text")
    request = text_arg(request, "request")
    with ctx.store.lock:
        config = reads.provider_config(ctx.store.db, "llm")
        if config is None:
            raise AppError("provider_missing", "Save a provider connection in Settings first.")
        llm.check_rewrite(text, request)
        if not config["model"]:
            raise AppError("provider_model", "Choose and save a model in Settings first.")
    with ai_slot(ctx):
        connection = providers.load_connection(config, ctx.transport)

        def before(_body: bytes) -> None:
            with ctx.store.lock:
                if reads.provider_config(ctx.store.db, "llm") != config:
                    raise plan_changed()

        answer = llm.rewrite(connection, text, request, before)
        with ctx.store.lock:
            if reads.provider_config(ctx.store.db, "llm") != config:
                raise plan_changed()
    return answer
