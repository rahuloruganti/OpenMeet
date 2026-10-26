"""Meeting questions with saved threads, library questions over several meetings, and rewrites.

Covers ask_meeting, ask_library, rewrite_text and the saved thread rows. What
is sent is computed from stored data at send time and rechecked before each request and before saving.
When the content is too long, only keyword-matched excerpts are sent; with no match nothing is sent.
"""

from __future__ import annotations

import dataclasses
import json
import re
import sqlite3
from dataclasses import dataclass
from typing import Any, Optional

from openmeet_py.api import reads
from openmeet_py.api.context import Context, ai_slot, int_arg, list_arg, optional_int_arg, text_arg
from openmeet_py.api.errors import AppError
from openmeet_py.domain import llm, providers
from openmeet_py.domain.connections import plan_changed
from openmeet_py.domain.summaries import require_llm
from openmeet_py.infra.store import transaction
from openmeet_py.local_ai import service as local_ai


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
        local_ai.ensure_ready(ctx, config)
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

SCOPE_KINDS = ("all", "folder", "tag", "meetings")
MAX_TAG_CHARS = 40
FTS_HITS = 200


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


def match_query(text: str) -> Optional[str]:
    """An FTS5 MATCH expression for any word in `text`, each word a quoted literal.

    Only letters and digits survive, so quotes, AND, OR, NEAR, column filters, asterisks and
    parentheses in user text are plain words, never query operators. None when there is no word.
    """
    words = re.findall(r"[^\W_]+", text)
    if not words:
        return None
    return " OR ".join(f'"{word}"*' for word in words)


def search_in(
    db: sqlite3.Connection, meeting_ids: list[str], query: str, limit: int
) -> list[dict[str, Any]]:
    """Index rows of the given meetings that match the query, best first. Deleted meetings have no rows."""
    match = match_query(query)
    if match is None or not meeting_ids:
        return []
    marks = ",".join("?" for _ in meeting_ids)
    rows = db.execute(
        "SELECT meeting_id, kind, rowid, body FROM search WHERE search MATCH ? "
        f"AND meeting_id IN ({marks}) ORDER BY rank LIMIT ?",
        (match, *meeting_ids, limit),
    ).fetchall()
    return [{"meeting_id": row[0], "kind": row[1], "rowid": row[2], "body": row[3]} for row in rows]


def _bad_scope(message: str) -> AppError:
    return AppError("invalid_scope", f"{message} Nothing was sent.")


def resolve_scope(db: sqlite3.Connection, scope: Any) -> tuple[list[str], dict[str, Any]]:
    """The meeting ids a scope covers, newest first, and the record stored with the answer."""
    if not isinstance(scope, dict) or scope.get("kind") not in SCOPE_KINDS:
        raise _bad_scope("Choose all meetings, a folder, a tag or selected meetings.")
    kind = scope["kind"]
    if kind == "meetings":
        chosen = scope.get("meeting_ids")
        if not isinstance(chosen, list):
            raise _bad_scope("Choose meetings to ask about.")
        record = {"kind": "meetings", "id": None, "label": "Selected meetings"}
        return library_ids(chosen), record
    if kind == "all":
        rows = db.execute("SELECT id FROM meetings ORDER BY started_at DESC, id DESC").fetchall()
        record = {"kind": "all", "id": None, "label": "All meetings"}
    elif kind == "folder":
        folder_id = scope.get("id")
        folder = None
        if isinstance(folder_id, str):
            folder = db.execute("SELECT name FROM folders WHERE id = ?1", (folder_id,)).fetchone()
        if folder is None:
            raise _bad_scope("That folder no longer exists.")
        rows = db.execute(
            "SELECT id FROM meetings WHERE folder_id = ?1 ORDER BY started_at DESC, id DESC",
            (folder_id,),
        ).fetchall()
        record = {"kind": "folder", "id": folder_id, "label": f"Folder: {folder[0]}"}
    else:
        tag = scope.get("id")
        if not isinstance(tag, str) or not 1 <= len(tag.strip()) <= MAX_TAG_CHARS:
            raise _bad_scope("Choose a tag.")
        tag = tag.strip()
        rows = db.execute(
            "SELECT m.id FROM meetings m WHERE EXISTS (SELECT 1 FROM meeting_tags t "
            "WHERE t.meeting_id = m.id AND t.tag = ?1) ORDER BY m.started_at DESC, m.id DESC",
            (tag,),
        ).fetchall()
        record = {"kind": "tag", "id": tag, "label": f"Tag: {tag}"}
    ids = [row[0] for row in rows]
    if not ids:
        raise _bad_scope("No meetings are in this scope.")
    if len(ids) > llm.MAX_LIBRARY_MEETINGS:
        raise _bad_scope(
            f"This scope has {len(ids)} meetings; one question covers up to "
            f"{llm.MAX_LIBRARY_MEETINGS}. Narrow the scope."
        )
    return ids, record


def library_scope(
    db: sqlite3.Connection, ids: list[str], question: str, fts: bool = False
) -> tuple[list[llm.LibraryItem], bool]:
    """Each meeting as it would be sent, plus whether those are excerpts.

    Excerpts come from the search index when `fts` (scoped asks), else from keyword matching
    (explicit ids). Content that fits one request is always sent whole.
    """
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
    budget = llm.library_budget(items, question)
    if fts:
        chosen = _indexed_lines(db, details, full, found, budget)
    else:
        chosen = llm.select_lines([list(item.lines) for item in full], found, budget)
    if all(not picked for picked in chosen) and all(not item.notes for item in items):
        raise insufficient_evidence()
    items = [
        dataclasses.replace(item, lines=tuple(llm.excerpt_lines(list(item.lines), picked)))
        for item, picked in zip(full, chosen)
    ]
    return items, True


def _indexed_lines(
    db: sqlite3.Connection,
    details: list[dict[str, Any]],
    items: list[llm.LibraryItem],
    found: list[str],
    budget: int,
) -> list[set[int]]:
    """Transcript lines whose stored segment the search index matches, best match first."""
    ids = [item.id for item in items]
    position = {meeting_id: index for index, meeting_id in enumerate(ids)}
    # Line n of a meeting is its n-th segment, so a segment id maps to a line index.
    line_of = [
        {meta["id"]: line for line, meta in enumerate(detail["segment_meta"])} for detail in details
    ]
    hits: list[tuple[int, int]] = []
    for row in search_in(db, ids, " ".join(found), FTS_HITS):
        if row["kind"] != "transcript":
            continue
        meeting_index = position[row["meeting_id"]]
        line = line_of[meeting_index].get(row["rowid"])
        if line is not None:
            hits.append((meeting_index, line))
    return llm.window_lines([list(item.lines) for item in items], hits, budget)


def _library_unchanged(
    db: sqlite3.Connection,
    ids: list[str],
    config: dict[str, Any],
    question: str,
    items: list[llm.LibraryItem],
    excerpted: bool,
    fts: bool,
) -> None:
    try:
        now = library_scope(db, ids, question, fts)
    except AppError:
        raise plan_changed() from None
    if reads.provider_config(db, "llm") != config or now != (items, excerpted):
        raise plan_changed()


def save_library_answer(
    db: sqlite3.Connection,
    ids: list[str],
    question: str,
    answer: str,
    provider: str,
    model: str,
    scope: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    scope_json = None if scope is None else json.dumps(scope, sort_keys=True)
    with transaction(db) as tx:
        answer_id = tx.execute(
            "INSERT INTO library_answers(question, answer, provider, model, scope_json) "
            "VALUES (?1, ?2, ?3, ?4, ?5)",
            (question, answer, provider, model, scope_json),
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
        "scope": scope,
    }


def ask_library(
    ctx: Context, meeting_ids: Any = None, question: Any = None, scope: Any = None
) -> dict[str, Any]:
    """One question over 1 to 20 meetings: either explicit meeting_ids, or a scope to resolve."""
    if meeting_ids is not None and scope is not None:
        raise AppError("invalid_args", "Send either meeting_ids or scope, not both.")
    with ctx.store.lock:
        if scope is not None:
            ids, record = resolve_scope(ctx.store.db, scope)
        elif meeting_ids is not None:
            ids, record = library_ids(list_arg(meeting_ids, "meeting_ids")), None
        else:
            raise _bad_scope("Choose meetings or a scope.")
    fts = record is not None
    question = text_arg(question, "question")
    with ctx.store.lock:
        db = ctx.store.db
        items, excerpted = library_scope(db, ids, question, fts)
        config = require_llm(db)
    with ai_slot(ctx):
        local_ai.ensure_ready(ctx, config)
        connection = providers.load_connection(config, ctx.transport)

        def before(_body: bytes) -> None:
            with ctx.store.lock:
                _library_unchanged(ctx.store.db, ids, config, question, items, excerpted, fts)

        answer = llm.ask_library(connection, items, excerpted, question, before)
        with ctx.store.lock:
            db = ctx.store.db
            _library_unchanged(db, ids, config, question, items, excerpted, fts)
            saved = save_library_answer(
                db, ids, question.strip(), answer, config["base_url"], config["model"], record
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
        local_ai.ensure_ready(ctx, config)
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
