"""Enhanced notes: the user's notes plus the final transcript, every claim cited to transcript segments.

Fake LLM transport only (test_ai.Stub over httpx.MockTransport). Fictional meetings and fixtures.
"""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any, Callable

import httpx
import pytest
from fastapi.testclient import TestClient

from conftest import invoke, invoke_error
from openmeet_py.api.errors import AppError
from openmeet_py.domain import enhancement, exporter
from openmeet_py.infra import store as store_module
from openmeet_py.local_ai import service as local_ai
from test_ai import LOCAL, SUMMARY, Stub, configure, note, reply
from openmeet_py.domain.processing import DONE, WAIT
from test_processing import drive, manual, record, set_default, snap, start  # noqa: F401


def user_message(request: httpx.Request) -> str:
    return json.loads(request.content)["messages"][1]["content"]


def cited(template: str) -> Callable[[httpx.Request], httpx.Response]:
    """A reply that cites the first and second transcript markers the request actually sent."""

    def respond(request: httpx.Request) -> httpx.Response:
        ids = re.findall(r"\[s(\d+)\] ", user_message(request))
        second = ids[1] if len(ids) > 1 else ids[0]
        return reply(template.replace("{first}", ids[0]).replace("{second}", second))

    return respond


def seed(client: TestClient, meeting: str, *lines: tuple[str, int, str]) -> list[int]:
    """Final transcript rows as (speaker, start_ms, text); returns their segment ids in order."""
    db = client.app.state.ctx.store.db  # type: ignore[attr-defined]
    ids = []
    for speaker, start_ms, text in lines:
        cursor = db.execute(
            "INSERT INTO segments(meeting_id, speaker, start_ms, end_ms, text, source, pass) "
            "VALUES (?1, ?2, ?3, ?4, ?5, 'fixture', 'final')",
            (meeting, speaker, start_ms, start_ms + 4000, text),
        )
        ids.append(cursor.lastrowid)
    return ids


# ---- pure: marker validation and the request plan ----------------------------


def test_markers_must_name_a_real_segment_and_become_one_source_each() -> None:
    text, sources, dropped = enhancement.link_sources(
        "Budget [s3] and [s5] but not [s99].", {3: (0, 4000), 5: (None, None)}
    )
    assert text == "Budget [s3] and [s5] but not."
    assert dropped == 1
    assert sources == [
        {"marker": "[s3]", "segment_id": 3, "start_ms": 0, "end_ms": 4000},
        {"marker": "[s5]", "segment_id": 5, "start_ms": None, "end_ms": None},
    ]


def test_repeated_markers_keep_their_text_and_one_source() -> None:
    text, sources, dropped = enhancement.link_sources("Ship [s3] then [s3][s3].", {3: (0, 4000)})
    assert text == "Ship [s3] then [s3][s3]."
    assert [source["segment_id"] for source in sources] == [3]
    assert dropped == 0


def test_nested_markers_are_unwrapped_and_sources_follow_the_text() -> None:
    targets = {2: (1000, 2000), 7: (3000, 4000)}
    text, sources, dropped = enhancement.link_sources("Point [[s7]] then [s2] and [[s7]].", targets)
    assert text == "Point [s7] then [s2] and [s7]."
    assert [source["segment_id"] for source in sources] == [7, 2]
    assert dropped == 0


def test_a_request_keeps_every_marker_and_trims_the_middle_over_the_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(enhancement, "MAX_ENHANCE_INPUT", 6_000)
    items = [
        (index + 1, index * 1000, index * 1000 + 900, f"You: {'x' * 200} {index}")
        for index in range(60)
    ]
    planned = enhancement.plan("Notes for the call.", items, "system")
    assert planned.total == 60 and planned.trimmed > 0
    assert "[s1] " in planned.user and "[s60] " in planned.user
    assert "[s30] " not in planned.user
    assert "left out" in planned.user
    assert len((planned.system + planned.user).encode("utf-8")) <= 6_000
    assert 30 not in planned.targets, "a trimmed line is not a citation target"
    assert planned.targets[1] == (0, 900) and planned.targets[60] == (59000, 59900)


def test_notes_alone_over_the_limit_are_refused_before_sending(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(enhancement, "MAX_ENHANCE_INPUT", 1_000)
    with pytest.raises(AppError) as caught:
        enhancement.plan("n" * 2_000, [(1, 0, 1000, "You: hi")], "system")
    assert caught.value.code == "summary_too_long"


def test_a_zero_padded_marker_is_invalid_not_rewritten() -> None:
    text, sources, dropped = enhancement.link_sources("Point [s01] and [s1].", {1: (0, 1000)})
    assert text == "Point and [s1]."
    assert dropped == 1
    assert [source["segment_id"] for source in sources] == [1]


def test_a_cited_trimmed_line_is_dropped_because_only_kept_lines_are_targets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(enhancement, "MAX_ENHANCE_INPUT", 4_000)
    items = [
        (index + 1, index * 1000, index * 1000 + 900, f"You: {'x' * 150} {index}") for index in range(40)
    ]
    planned = enhancement.plan("Notes for the call.", items, "system")
    kept = {int(found) for found in re.findall(r"\[s(\d+)\] ", planned.user)}
    trimmed = sorted(set(range(1, 41)) - kept)
    assert kept and trimmed
    assert set(planned.targets) == kept
    first_kept = min(kept)
    text, sources, dropped = enhancement.link_sources(
        f"Opening [s{first_kept}] and the middle [s{trimmed[0]}].", planned.targets
    )
    assert text == f"Opening [s{first_kept}] and the middle."
    assert dropped == 1
    assert [source["segment_id"] for source in sources] == [first_kept]


# ---- commands ----------------------------------------------------------------


def test_enhanced_notes_cite_real_segments_and_leave_the_raw_notes_alone(client: TestClient) -> None:
    stub = Stub(cited("Budget was agreed [s{first}].\n- Ship on Friday [s{second}][s{second}]\n- Invented [s999]"))
    configure(client, stub)
    meeting = note(client, "Fictional planning", "Budget and launch date.")
    first, second = seed(client, meeting, ("You", 0, "Budget is fine."), ("Others", 5000, "Ship on Friday."))
    before = invoke(client, "get_meeting", id=meeting)
    result = invoke(client, "enhance_notes", id=meeting, template="general-v1")
    after = invoke(client, "get_meeting", id=meeting)
    assert after["user_markdown"] == "Budget and launch date."
    assert after["notes_revision"] == before["notes_revision"]
    assert after["summary"] is None, "enhanced notes never replace the summary"
    assert result["kind"] == "enhanced"
    assert result["notes_revision"] == before["notes_revision"]
    assert result["template"] == "general-v1"
    assert (result["model"], result["provider"]) == ("local-model", LOCAL)
    assert result["sources"] == [
        {"marker": f"[s{first}]", "segment_id": first, "start_ms": 0, "end_ms": 4000},
        {"marker": f"[s{second}]", "segment_id": second, "start_ms": 5000, "end_ms": 9000},
    ]
    assert f"[s{second}][s{second}]" in result["markdown"]
    assert "[s999]" not in result["markdown"]
    assert result["dropped_markers"] == 1
    assert result["trimmed_segments"] == 0 and result["notice"] is None
    assert invoke(client, "list_summaries", id=meeting)[0]["sources"] == result["sources"]
    body = stub.bodies()[0]
    assert "Budget and launch date." in body
    assert f"[s{first}] You: Budget is fine." in body
    assert f"[s{second}] Others: Ship on Friday." in body


def test_speaker_names_reach_the_enhancement_request(client: TestClient) -> None:
    stub = Stub(cited("Ana agreed [s{first}]."))
    configure(client, stub)
    meeting = note(client, "Fictional", "Ana said yes.")
    seed(client, meeting, ("You", 0, "Yes."))
    invoke(client, "save_speaker_names", meeting_id=meeting, you="Ana", others=None)
    invoke(client, "enhance_notes", id=meeting, template="general-v1")
    assert "Ana (You): Yes." in stub.bodies()[0]


def test_enhancement_needs_a_transcript_notes_and_a_model(client: TestClient) -> None:
    meeting = note(client, "Fictional", "Notes only.")
    status, body = invoke_error(client, "enhance_notes", id=meeting, template="general-v1")
    assert (status, body["code"]) == (400, "enhance_no_transcript")
    seed(client, meeting, ("You", 0, "Hello."))
    status, body = invoke_error(client, "enhance_notes", id=meeting, template="general-v1")
    assert body["code"] == "provider_missing"
    stub = Stub(cited("Hi [s{first}]."))
    configure(client, stub)
    empty = note(client, "Fictional empty notes", "")
    seed(client, empty, ("You", 0, "Hello."))
    status, body = invoke_error(client, "enhance_notes", id=empty, template="general-v1")
    assert body["code"] == "enhance_no_notes"
    assert stub.requests == []


def test_enhanced_notes_go_stale_when_the_notes_or_the_transcript_change(client: TestClient) -> None:
    configure(client, Stub(cited("Budget [s{first}]."), cited("Budget again [s{first}].")))
    meeting = note(client, "Fictional", "Budget.")
    seed(client, meeting, ("You", 0, "Budget."))
    invoke(client, "enhance_notes", id=meeting, template="general-v1")
    assert invoke(client, "list_summaries", id=meeting)[0]["stale"] is False
    revision = invoke(client, "get_meeting", id=meeting)["notes_revision"]
    invoke(client, "save_notes", id=meeting, markdown="Budget, and more.", expected_revision=revision)
    assert invoke(client, "list_summaries", id=meeting)[0]["stale"] is True
    invoke(client, "enhance_notes", id=meeting, template="general-v1")
    assert invoke(client, "list_summaries", id=meeting)[0]["stale"] is False
    invoke(client, "save_speaker_names", meeting_id=meeting, you="Ana", others=None)
    assert invoke(client, "list_summaries", id=meeting)[0]["stale"] is True


def test_summary_and_enhanced_versions_are_separate_for_edits_and_conflicts(client: TestClient) -> None:
    configure(client, Stub(cited("Budget [s{first}]."), lambda r: reply(SUMMARY)))
    meeting = note(client, "Fictional", "Budget.")
    (first,) = seed(client, meeting, ("You", 0, "Budget."))
    enhanced = invoke(client, "enhance_notes", id=meeting, template="general-v1")["id"]
    invoke(client, "generate_summary", id=meeting, template="general-v1")
    summary = invoke(client, "list_summaries", id=meeting)[0]["id"]
    assert [row["kind"] for row in invoke(client, "list_summaries", id=meeting)] == ["summary", "enhanced"]
    assert invoke(client, "get_meeting", id=meeting)["summary"] == SUMMARY.strip()
    status, body = invoke_error(
        client, "save_summary_edit", meeting_id=meeting, base_id=enhanced,
        expected_latest_id=summary, markdown="Edited.",
    )
    assert body["code"] == "summary_conflict"
    invoke(
        client, "save_summary_edit", meeting_id=meeting, base_id=enhanced,
        expected_latest_id=enhanced, markdown=f"Edited [s{first}] and [s999].",
    )
    newest = invoke(client, "list_summaries", id=meeting)[0]
    assert (newest["kind"], newest["edited_from"]) == ("enhanced", enhanced)
    assert newest["markdown"] == f"Edited [s{first}] and."
    assert [source["segment_id"] for source in newest["sources"]] == [first]
    status, body = invoke_error(
        client, "save_summary_edit", meeting_id=meeting, base_id=summary,
        expected_latest_id=enhanced, markdown="Not allowed.",
    )
    assert body["code"] == "summary_conflict"
    assert invoke(client, "get_meeting", id=meeting)["summary"] == SUMMARY.strip()


def test_enhancement_asks_local_ai_first_and_never_retries(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    order: list[str] = []
    monkeypatch.setattr(local_ai, "ensure_ready", lambda _ctx, config: order.append("ready"))
    stub = Stub(lambda r: httpx.Response(500, text="nope"))
    configure(client, stub)
    meeting = note(client, "Fictional", "Something to enhance.")
    seed(client, meeting, ("You", 0, "Something."))
    status, body = invoke_error(client, "enhance_notes", id=meeting, template="general-v1")
    assert body["code"] == "provider_response"
    assert order == ["ready"] and len(stub.requests) == 1
    assert invoke(client, "list_summaries", id=meeting) == []


def test_the_model_cannot_cite_a_trimmed_line_through_the_command(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(enhancement, "MAX_ENHANCE_INPUT", 4_000)
    meeting = note(client, "Fictional", "Notes.")
    ids = seed(client, meeting, *[("You", index * 1000, f"word {'x' * 150} {index}") for index in range(40)])

    def respond(request: httpx.Request) -> httpx.Response:
        # The model sees only the kept lines, yet cites a trimmed one it could not have seen.
        sent = {int(found) for found in re.findall(r"\[s(\d+)\] ", user_message(request))}
        trimmed = next(segment for segment in ids if segment not in sent)
        return reply(f"Opening [s{ids[0]}] then [s{trimmed}].")

    configure(client, Stub(respond))
    result = invoke(client, "enhance_notes", id=meeting, template="general-v1")
    assert [source["segment_id"] for source in result["sources"]] == [ids[0]]
    assert result["dropped_markers"] == 1
    assert "[s" + str(ids[-1]) + "]" not in result["markdown"]


def test_a_transcript_over_the_limit_is_trimmed_and_the_result_says_so(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(enhancement, "MAX_ENHANCE_INPUT", 4_000)
    stub = Stub(cited("Opening [s{first}]."))
    configure(client, stub)
    meeting = note(client, "Fictional", "Notes.")
    ids = seed(client, meeting, *[("You", index * 1000, f"word {'x' * 150} {index}") for index in range(40)])
    result = invoke(client, "enhance_notes", id=meeting, template="general-v1")
    sent = re.findall(r"\[s\d+\] ", stub.bodies()[0])
    assert result["trimmed_segments"] == 40 - len(sent) > 0
    assert "left out" in result["notice"]
    assert f"[s{ids[0]}] " in stub.bodies()[0] and f"[s{ids[-1]}] " in stub.bodies()[0]
    assert f"[s{ids[20]}] " not in stub.bodies()[0]


def test_an_empty_enhanced_edit_gets_the_same_message_as_an_empty_summary_edit(client: TestClient) -> None:
    configure(client, Stub(cited("Budget [s{first}]."), lambda r: reply(SUMMARY)))
    meeting = note(client, "Fictional", "Budget.")
    seed(client, meeting, ("You", 0, "Budget."))
    enhanced = invoke(client, "enhance_notes", id=meeting, template="general-v1")["id"]
    invoke(client, "generate_summary", id=meeting, template="general-v1")
    summary = invoke(client, "list_summaries", id=meeting)[0]["id"]
    _, enhanced_empty = invoke_error(
        client, "save_summary_edit", meeting_id=meeting, base_id=enhanced,
        expected_latest_id=enhanced, markdown="[s999]",
    )
    _, summary_empty = invoke_error(
        client, "save_summary_edit", meeting_id=meeting, base_id=summary,
        expected_latest_id=summary, markdown="   ",
    )
    assert enhanced_empty["code"] == summary_empty["code"] == "summary_edit"
    assert enhanced_empty["message"] == summary_empty["message"]
    assert "2 MiB" not in enhanced_empty["message"]


def test_the_export_keeps_the_plain_summary_and_never_shows_enhanced_notes(client: TestClient) -> None:
    configure(client, Stub(lambda r: reply(SUMMARY), cited("Budget was agreed [s{first}].")))
    meeting = note(client, "Fictional", "Budget.")
    seed(client, meeting, ("You", 0, "Budget."))
    invoke(client, "generate_summary", id=meeting, template="general-v1")
    invoke(client, "enhance_notes", id=meeting, template="general-v1")
    detail = invoke(client, "get_meeting", id=meeting)
    assert detail["summary"] == SUMMARY.strip()
    text = exporter.render(detail, {"summary": True, "transcript": False})
    assert SUMMARY.strip() in text
    assert "Budget was agreed" not in text
    assert "enhanced" not in text.lower()


def test_enhanced_notes_are_on_by_default(client: TestClient) -> None:
    assert invoke(client, "get_settings")["processing_enhance"] is True


# ---- automatic processing ----------------------------------------------------


def enhance_stored_off(client: TestClient) -> None:
    """Simulates a stored row with enhancement off; the Settings switch no longer exists to write it."""
    ctx = client.app.state.ctx  # type: ignore[attr-defined]
    with ctx.store.lock:
        ctx.store.db.execute("UPDATE settings SET processing_enhance = 0 WHERE id = 1")


def cited_for_processing(request: httpx.Request) -> httpx.Response:
    ids = re.findall(r"\[s(\d+)\] ", user_message(request))
    return reply(f"Enhanced point [s{ids[0]}].")


def finish_run(client: TestClient, meeting: str, run: str) -> None:
    invoke(client, "stop_recording")
    assert drive(client, meeting, run) == WAIT
    waiting = snap(client, meeting)["workflow"]
    notes_revision = invoke(client, "get_meeting", id=meeting)["notes_revision"]
    invoke(
        client, "acknowledge_processing_notes", id=meeting, runId=run,
        notesBarrier=waiting["notes_barrier"], expectedNotesRevision=notes_revision,
    )
    assert drive(client, meeting, run) == DONE


def test_automatic_run_saves_the_summary_and_an_enhanced_row_by_default(manual: TestClient) -> None:
    stub = Stub(lambda r: reply(SUMMARY), cited_for_processing)
    configure(manual, stub)
    set_default(manual, "final", "general-v1")
    started = start(manual)
    meeting = started["meeting_id"]
    run = snap(manual, meeting)["workflow"]["run_id"]
    revision = invoke(manual, "get_meeting", id=meeting)["notes_revision"]
    invoke(manual, "save_notes", id=meeting, markdown="My rough point.", expected_revision=revision)
    record(manual)
    finish_run(manual, meeting, run)
    kinds = [row["kind"] for row in invoke(manual, "list_summaries", id=meeting)]
    assert kinds == ["enhanced", "summary"]
    assert len(stub.requests) == 2
    assert "My rough point." in stub.bodies()[1]
    enhanced = invoke(manual, "list_summaries", id=meeting)[0]
    assert enhanced["notes_revision"] == invoke(manual, "get_meeting", id=meeting)["notes_revision"]
    assert invoke(manual, "get_meeting", id=meeting)["user_markdown"] == "My rough point."
    assert invoke(manual, "get_meeting", id=meeting)["summary"] == SUMMARY.strip()


def test_automatic_run_skips_the_enhanced_row_when_enhancement_is_stored_off(manual: TestClient) -> None:
    stub = Stub(lambda r: reply(SUMMARY), cited_for_processing)
    configure(manual, stub)
    set_default(manual, "final", "general-v1")
    enhance_stored_off(manual)
    started = start(manual)
    meeting = started["meeting_id"]
    run = snap(manual, meeting)["workflow"]["run_id"]
    invoke(manual, "save_notes", id=meeting, markdown="My rough point.", expected_revision=0)
    record(manual)
    finish_run(manual, meeting, run)
    assert [row["kind"] for row in invoke(manual, "list_summaries", id=meeting)] == ["summary"]
    assert len(stub.requests) == 1


def test_automatic_run_with_empty_notes_skips_the_enhanced_row_without_a_failure(manual: TestClient) -> None:
    stub = Stub(lambda r: reply(SUMMARY), cited_for_processing)
    configure(manual, stub)
    set_default(manual, "final", "general-v1")
    started = start(manual)
    meeting = started["meeting_id"]
    state = snap(manual, meeting)
    assert state["plan"]["scope"]["enhance"] is True  # on by default; only the empty notes skip it
    run = state["workflow"]["run_id"]
    record(manual)
    finish_run(manual, meeting, run)
    assert [row["kind"] for row in invoke(manual, "list_summaries", id=meeting)] == ["summary"]
    assert len(stub.requests) == 1
    done = snap(manual, meeting)["workflow"]
    assert (done["stage"], done["error"]) == ("completed", None)


def system_of(request: httpx.Request) -> str:
    return json.loads(request.content)["messages"][0]["content"]


def is_enhancement(request: httpx.Request) -> bool:
    return system_of(request).startswith("You enhance the user's rough meeting notes")


def test_a_failed_enhancement_keeps_the_saved_summary_and_retry_does_not_resummarize(
    manual: TestClient,
) -> None:
    failing = {"enhance": True}

    def respond(request: httpx.Request) -> httpx.Response:
        if is_enhancement(request):
            if failing["enhance"]:
                return httpx.Response(500, text="provider error")
            return cited_for_processing(request)
        return reply(SUMMARY)

    stub = Stub(*[respond] * 12)
    configure(manual, stub)
    set_default(manual, "final", "general-v1")
    started = start(manual)
    meeting = started["meeting_id"]
    run = snap(manual, meeting)["workflow"]["run_id"]
    revision = invoke(manual, "get_meeting", id=meeting)["notes_revision"]
    invoke(manual, "save_notes", id=meeting, markdown="My rough point.", expected_revision=revision)
    record(manual)
    invoke(manual, "stop_recording")
    assert drive(manual, meeting, run) == WAIT
    waiting = snap(manual, meeting)["workflow"]
    notes_revision = invoke(manual, "get_meeting", id=meeting)["notes_revision"]
    invoke(
        manual, "acknowledge_processing_notes", id=meeting, runId=run,
        notesBarrier=waiting["notes_barrier"], expectedNotesRevision=notes_revision,
    )
    assert drive(manual, meeting, run) == DONE

    # The summary is committed; the enhancement failure is visible on the run and changes nothing saved.
    failed = snap(manual, meeting)["workflow"]
    assert failed["stage"] == "failed"
    assert "summary is saved" in failed["error"]
    assert [row["kind"] for row in invoke(manual, "list_summaries", id=meeting)] == ["summary"]
    assert invoke(manual, "get_meeting", id=meeting)["summary"] == SUMMARY.strip()
    assert len([request for request in stub.requests if not is_enhancement(request)]) == 1
    assert len(stub.requests) == 2

    # Retry resumes at the enhancement: the saved summary is not requested again.
    failing["enhance"] = False
    retried = invoke(manual, "retry_session_processing", id=meeting)
    assert retried["workflow"]["stage"] == "awaiting_notes"
    new_run = retried["workflow"]["run_id"]
    detail = invoke(manual, "get_meeting", id=meeting)
    invoke(
        manual, "acknowledge_processing_notes", id=meeting, runId=new_run,
        notesBarrier=retried["workflow"]["notes_barrier"], expectedNotesRevision=detail["notes_revision"],
    )
    assert drive(manual, meeting, new_run) == DONE
    assert snap(manual, meeting)["workflow"]["stage"] == "completed"
    assert [row["kind"] for row in invoke(manual, "list_summaries", id=meeting)] == ["enhanced", "summary"]
    assert len([request for request in stub.requests if not is_enhancement(request)]) == 1
    assert len(stub.requests) == 3


# ---- migration 036 -----------------------------------------------------------


def test_migration_036_upgrades_populated_summaries_and_foreign_keys(tmp_path: Path) -> None:
    files = store_module._migration_files()
    db = sqlite3.connect(tmp_path / "old.db", isolation_level=None)
    db.execute("PRAGMA foreign_keys = ON")
    for number, path in files.items():
        if number > 33:
            break
        store_module._apply(db, number, path, rebuild=number in store_module.REBUILDS)
    db.execute(
        "INSERT INTO meetings(id, title, started_at, source, status) "
        "VALUES ('m1', 'Fictional', '2026-01-01T00:00:00Z', 'note', 'stopped')"
    )
    db.execute("INSERT INTO notes(meeting_id, user_markdown, revision) VALUES ('m1', 'Raw notes', 2)")
    db.execute(
        "INSERT INTO summaries(meeting_id, template_hash, model, provider, markdown, transcript_hash) "
        "VALUES ('m1', 'general-v1', 'local-model', 'http://127.0.0.1:1234/v1', 'Old summary.', 'abc')"
    )
    store_module.migrate(db)
    row = db.execute(
        "SELECT kind, notes_revision, sources_json, markdown FROM summaries WHERE meeting_id = 'm1'"
    ).fetchone()
    assert row == ("summary", None, "[]", "Old summary.")
    # Migration 037 turns enhanced notes on for every database, including this upgraded one.
    assert db.execute("SELECT processing_enhance FROM settings WHERE id = 1").fetchone() == (1,)
    assert db.execute("SELECT user_markdown FROM notes WHERE meeting_id = 'm1'").fetchone() == ("Raw notes",)
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []
    assert db.execute("PRAGMA user_version").fetchone()[0] == max(files) == 37
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO summaries(meeting_id, template_hash, model, provider, markdown, kind) "
            "VALUES ('m1', 'x', 'm', 'p', 'x', 'bogus')"
        )
    db.close()
