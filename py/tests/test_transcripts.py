"""Transcript replacement, edits, versions and summary freshness (ported from transcript_edits.rs tests)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from conftest import invoke, invoke_error
from openmeet_py import reads, transcript_edits
from openmeet_py.store import transaction
from stt_fixtures import add_meeting


def line(text: str, start_ms: int, speaker: str = "You") -> dict[str, Any]:
    return transcript_edits.timed(speaker, start_ms, start_ms + 100, text)


def replace(ctx: Any, meeting_id: str, segments: list[dict[str, Any]], provider: str, model: str) -> None:
    with ctx.store.lock:
        with transaction(ctx.store.db) as tx:
            transcript_edits.replace_transcript(tx, meeting_id, segments, provider, model)


def detail(ctx: Any, meeting_id: str) -> dict[str, Any]:
    with ctx.store.lock:
        return reads.meeting_detail(ctx.store.db, meeting_id)


def test_replacing_keeps_the_edited_transcript_as_a_read_only_version(client: TestClient) -> None:
    ctx = client.app.state.ctx
    meeting = add_meeting(ctx)
    replace(ctx, meeting, [line("First pass", 0)], "whisper", "small")
    assert detail(ctx, meeting)["transcript_versions"] == []
    assert detail(ctx, meeting)["transcript_provider"] == "whisper"
    first = detail(ctx, meeting)["segment_meta"][0]["id"]
    invoke(client, "edit_segment", meetingId=meeting, segmentId=first, baseText="First pass", text="First pass, corrected")

    replace(ctx, meeting, [line("Second pass", 0)], "https://speech.example/v1", "m")
    versions = detail(ctx, meeting)["transcript_versions"]
    assert len(versions) == 1
    assert (versions[0]["provider"], versions[0]["model"], versions[0]["edited"], versions[0]["segment_count"]) == (
        "whisper",
        "small",
        True,
        1,
    )
    old = invoke(client, "get_transcript_version", meetingId=meeting, versionId=versions[0]["id"])
    assert [segment["text"] for segment in old] == ["First pass, corrected"]
    assert detail(ctx, meeting)["transcript_model"] == "m"


def test_edits_refuse_stale_bases_and_revert_to_the_engine_text(client: TestClient) -> None:
    ctx = client.app.state.ctx
    meeting = add_meeting(ctx)
    other = add_meeting(ctx)
    replace(ctx, meeting, [line("Persimon budget", 0), line("Second", 500)], "whisper", "small")
    first = detail(ctx, meeting)["segment_meta"][0]["id"]
    assert detail(ctx, meeting)["segment_meta"][0]["original_text"] is None
    for bad in ["", "   ", "Two\nlines", "x" * 20001]:
        status, body = invoke_error(
            client, "edit_segment", meetingId=meeting, segmentId=first, baseText="Persimon budget", text=bad
        )
        assert (status, body["code"]) == (400, "segment_edit")
    status, body = invoke_error(
        client, "edit_segment", meetingId=other, segmentId=first, baseText="Persimon budget", text="Moved"
    )
    assert body["code"] == "segment_conflict"
    status, body = invoke_error(
        client, "edit_segment", meetingId=meeting, segmentId=first, baseText="Not the text", text="Persimmon budget"
    )
    assert body["code"] == "segment_conflict"

    invoke(client, "edit_segment", meetingId=meeting, segmentId=first, baseText="Persimon budget", text="Persimmon budget")
    edited = detail(ctx, meeting)
    assert edited["segments"][0]["text"] == "Persimmon budget"
    assert edited["segment_meta"][0]["original_text"] == "Persimon budget"
    assert invoke(client, "search_meetings", query="Persimmon")[0]["meeting_id"] == meeting

    invoke(client, "edit_segment", meetingId=meeting, segmentId=first, baseText="Persimmon budget", text="Persimmon budget, final")
    assert detail(ctx, meeting)["segment_meta"][0]["original_text"] == "Persimon budget"
    invoke(client, "edit_segment", meetingId=meeting, segmentId=first, baseText="Persimmon budget, final", text="Persimon budget")
    reverted = detail(ctx, meeting)
    assert reverted["segment_meta"][0]["original_text"] is None
    assert reverted["segments"][0]["text"] == "Persimon budget"


def test_summaries_go_stale_when_the_transcript_is_replaced(client: TestClient) -> None:
    ctx = client.app.state.ctx
    meeting = add_meeting(ctx)
    replace(ctx, meeting, [line("Budget is 40k", 0)], "whisper", "small")
    current_hash = reads.transcript_hash(detail(ctx, meeting)["segments"], detail(ctx, meeting)["speaker_names"])
    ctx.store.db.execute(
        "INSERT INTO summaries(meeting_id, template_hash, model, provider, markdown, transcript_hash) "
        "VALUES (?1, 'general-v1', 'm', 'p', '## Summary', ?2)",
        (meeting, current_hash),
    )
    assert detail(ctx, meeting)["summary_stale"] is False
    replace(ctx, meeting, [line("Budget is 45k", 0)], "whisper", "small")
    assert detail(ctx, meeting)["summary_stale"] is True
    assert invoke(client, "list_summaries", id=meeting)[0]["stale"] is True


def test_deleting_a_meeting_removes_its_versions(client: TestClient) -> None:
    ctx = client.app.state.ctx
    meeting = add_meeting(ctx)
    replace(ctx, meeting, [line("One", 0)], "whisper", "small")
    replace(ctx, meeting, [line("Two", 0)], "whisper", "small")
    assert len(detail(ctx, meeting)["transcript_versions"]) == 1
    invoke(client, "delete_meeting", id=meeting)
    left = ctx.store.db.execute("SELECT COUNT(*) FROM transcript_versions").fetchone()[0]
    assert left == 0
