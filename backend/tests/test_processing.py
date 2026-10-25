"""Automatic processing: plans, stages, the notes barrier, budgets, cancel, retry and restart.

Fakes only: FakeEngine (OPENMEET_PY_FAKE_STT=1), FakeBackend tones, httpx.MockTransport for the summary.
`manual` builds the app with workers=False, so each test drives Processing.step() itself and the order is
deterministic. The threaded test at the end uses the real worker loop.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable, Optional

import httpx
import pytest
from fastapi.testclient import TestClient

from conftest import TOKEN, invoke, invoke_error
from openmeet_py.api.server import create_app
from openmeet_py.audio.audio_backend import FakeBackend
from openmeet_py.domain import processing
from openmeet_py.domain.processing import DONE, WAIT, CONTINUE
from openmeet_py.infra.store import Store
from test_ai import SUMMARY, Stub, configure, reply

DEVICES = {"microphoneId": "fake-mic", "outputId": "fake-output"}
FRAMES = 1024


def build(tmp_path: Path, workers: bool) -> TestClient:
    app = create_app(
        tmp_path / "data",
        None,
        token=TOKEN,
        backend=FakeBackend(auto_pump=False),
        workers=workers,
    )
    client = TestClient(app, base_url="http://127.0.0.1")
    client.__enter__()
    return client


@pytest.fixture
def manual(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setenv("OPENMEET_PY_FAKE_STT", "1")
    client = build(tmp_path, workers=False)
    yield client
    client.__exit__(None, None, None)


def ctx_of(client: TestClient) -> Any:
    return client.app.state.ctx  # type: ignore[attr-defined]


def set_default(client: TestClient, mode: str, summary: Optional[str] = None) -> None:
    invoke(client, "save_processing_default", mode=mode, summary=summary)


def start(client: TestClient, title: str = "Fictional sync") -> dict:
    return invoke(client, "start_recording", title=title, devices=DEVICES)


def record(client: TestClient, frames: int = FRAMES) -> None:
    backend = client.app.state.backend  # type: ignore[attr-defined]
    backend.stream_for("fake-mic").deliver(frames)
    backend.stream_for("fake-output").deliver(frames)


def snap(client: TestClient, meeting: str) -> dict:
    result = invoke(client, "get_session_processing", id=meeting)
    assert result is not None
    return result


def drive(client: TestClient, meeting: str, run: str) -> str:
    """Steps the workflow until it waits for something or ends. Returns the last action."""
    action = CONTINUE
    for _ in range(100):
        action = ctx_of(client).processing.step(meeting, run)
        if action != CONTINUE:
            return action
    raise AssertionError("the workflow did not settle")


def wait_for(predicate: Callable[[], bool], timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("timed out waiting for processing to change")
        time.sleep(0.05)


def llm_stub(client: TestClient) -> Stub:
    stub = Stub(lambda request: reply(SUMMARY))
    configure(client, stub)
    return stub


# ---- plans and the notice ----------------------------------------------------


def test_recording_only_attaches_nothing_and_shows_no_notice(manual: TestClient) -> None:
    started = start(manual)
    assert started["processing_notice"] is None
    assert invoke(manual, "get_session_processing", id=started["meeting_id"]) is None
    invoke(manual, "stop_recording")


def test_summary_without_a_model_skips_processing_but_the_recording_starts(manual: TestClient) -> None:
    set_default(manual, "final", "general-v1")
    started = start(manual)
    assert started["status"] == "recording"
    assert started["processing_notice"].startswith("Automatic processing is off for this recording:")
    assert "Choose and save a model" in started["processing_notice"]
    assert invoke(manual, "get_session_processing", id=started["meeting_id"]) is None
    invoke(manual, "stop_recording")


def test_local_engine_that_is_not_installed_skips_with_a_notice(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("OPENMEET_PY_FAKE_STT", raising=False)
    client = build(tmp_path, workers=False)
    try:
        set_default(client, "final")
        started = start(client)
        assert started["status"] == "recording"
        assert "The speech engine and the selected model are not installed" in started["processing_notice"]
        invoke(client, "stop_recording")
    finally:
        client.__exit__(None, None, None)


@pytest.mark.parametrize("mode, planned", [("recording", False), ("final", True)])
def test_modes_decide_the_plan(manual: TestClient, mode: str, planned: bool) -> None:
    set_default(manual, mode, None)
    started = start(manual)
    meeting = started["meeting_id"]
    if not planned:
        # Recording only: no automatic processing at all. Live transcript is its own setting now.
        assert invoke(manual, "get_session_processing", id=meeting) is None
        invoke(manual, "stop_recording")
        return
    state = snap(manual, meeting)
    assert state["state"] == "prepared"
    assert state["plan"]["scope"]["kind"] == "final"
    assert "live" not in state["plan"]["scope"]
    assert state["plan"]["limits"] == {
        "duration_seconds": 14400,
        "post_stop_seconds": 14400,
        "upload_bytes": 268435456,
        "requests": 1000,
        "text_bytes": 800000,
    }
    invoke(manual, "stop_recording")


def test_the_plan_is_frozen_and_holds_no_credentials(manual: TestClient) -> None:
    stub = llm_stub(manual)
    set_default(manual, "final", "general-v1")
    invoke(manual, "save_summary_instructions", instructions="Use British English.")
    started = start(manual)
    plan = snap(manual, started["meeting_id"])["plan"]
    summary = plan["scope"]["summary"]
    assert summary["template"] == "general-v1"
    assert summary["instructions"] == "Use British English."
    assert summary["destination"]["model"] == "local-model"
    assert "credential" not in str(plan)
    # Later edits do not change the frozen plan.
    invoke(manual, "save_summary_instructions", instructions="Changed later")
    assert snap(manual, started["meeting_id"])["plan"]["scope"]["summary"]["instructions"] == "Use British English."
    assert stub.requests == []
    invoke(manual, "stop_recording")


# ---- the full run ------------------------------------------------------------


def test_final_run_waits_for_the_notes_barrier_then_summarizes(
    manual: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from openmeet_py.local_ai import service as local_ai

    readied: list[str] = []
    monkeypatch.setattr(local_ai, "ensure_ready", lambda _ctx, config: readied.append(config["base_url"]))
    stub = llm_stub(manual)
    set_default(manual, "final", "general-v1")
    started = start(manual)
    meeting = started["meeting_id"]
    run = snap(manual, meeting)["workflow"]["run_id"]
    revisions = [snap(manual, meeting)["revision"]]
    record(manual)

    invoke(manual, "stop_recording")
    assert snap(manual, meeting)["workflow"]["stage"] == "finalizing_audio"
    assert drive(manual, meeting, run) == WAIT
    waiting = snap(manual, meeting)
    assert waiting["workflow"]["stage"] == "awaiting_notes"
    assert waiting["workflow"]["transcript_done"] is True
    revisions.append(waiting["revision"])
    detail = invoke(manual, "get_meeting", id=meeting)
    assert detail["segments"], "the final transcript replaces the saved transcript"
    assert detail["summary"] is None
    assert stub.requests == []  # nothing is sent before the notes are saved and acknowledged

    barrier = waiting["workflow"]["notes_barrier"]
    notes_revision = detail["notes_revision"]
    status, body = invoke_error(
        manual, "acknowledge_processing_notes", id=meeting, runId=run,
        notesBarrier="not-the-barrier", expectedNotesRevision=notes_revision,
    )
    assert (status, body["code"]) == (400, "processing_cancelled")
    status, body = invoke_error(
        manual, "acknowledge_processing_notes", id=meeting, runId=run,
        notesBarrier=barrier, expectedNotesRevision=notes_revision + 5,
    )
    assert body["code"] == "notes_conflict"

    acked = invoke(
        manual, "acknowledge_processing_notes", id=meeting, runId=run,
        notesBarrier=barrier, expectedNotesRevision=notes_revision,
    )
    assert acked["workflow"]["notes_revision"] == notes_revision
    revisions.append(acked["revision"])
    assert drive(manual, meeting, run) == DONE
    done = snap(manual, meeting)
    revisions.append(done["revision"])
    assert done["workflow"]["stage"] == "completed"
    detail = invoke(manual, "get_meeting", id=meeting)
    assert detail["summary"] == SUMMARY.strip()
    assert detail["summary_model"] == "local-model"
    assert detail["summary_template"] == "general-v1"
    assert len(stub.requests) == 1
    assert revisions == sorted(revisions) and len(set(revisions)) == len(revisions)
    # An automatic summary asks Local AI to be ready first, like a manual one.
    assert len(readied) == 1


def test_a_notes_acknowledgement_before_the_stop_is_refused(manual: TestClient) -> None:
    llm_stub(manual)
    set_default(manual, "final", "general-v1")
    started = start(manual)
    meeting = started["meeting_id"]
    current = snap(manual, meeting)
    status, body = invoke_error(
        manual, "acknowledge_processing_notes", id=meeting, runId=current["workflow"]["run_id"],
        notesBarrier="x", expectedNotesRevision=0,
    )
    assert status == 400 and body["code"] in ("processing_cancelled", "notes_conflict")
    invoke(manual, "stop_recording")


def test_changing_the_speech_settings_mid_run_needs_attention(manual: TestClient) -> None:
    set_default(manual, "final")
    started = start(manual)
    meeting = started["meeting_id"]
    run = snap(manual, meeting)["workflow"]["run_id"]
    invoke(manual, "stop_recording")
    invoke(manual, "save_stt_settings", language="de", prompt="", model="base")
    assert snap(manual, meeting)["state"] == "needs_attention"
    assert drive(manual, meeting, run) == DONE
    after = snap(manual, meeting)
    assert after["workflow"]["stage"] == "needs_attention"
    assert "Processing settings changed" in after["workflow"]["error"]


def test_a_summary_over_the_text_budget_sends_nothing(manual: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    stub = llm_stub(manual)
    monkeypatch.setattr(processing, "TEXT_BYTES", 10)
    set_default(manual, "final", "general-v1")
    started = start(manual)
    meeting = started["meeting_id"]
    run = snap(manual, meeting)["workflow"]["run_id"]
    record(manual)
    invoke(manual, "stop_recording")
    drive(manual, meeting, run)
    detail = invoke(manual, "get_meeting", id=meeting)
    invoke(
        manual, "acknowledge_processing_notes", id=meeting, runId=run,
        notesBarrier=snap(manual, meeting)["workflow"]["notes_barrier"],
        expectedNotesRevision=detail["notes_revision"],
    )
    drive(manual, meeting, run)
    failed = snap(manual, meeting)["workflow"]
    assert failed["stage"] == "failed"
    assert "session processing limit was reached" in failed["error"]
    assert stub.requests == []
    assert failed["text_bytes_used"] == 0


# ---- cancel, retry, restart --------------------------------------------------


def test_cancel_keeps_the_transcript_and_retry_continues_with_the_summary(manual: TestClient) -> None:
    stub = llm_stub(manual)
    set_default(manual, "final", "general-v1")
    started = start(manual)
    meeting = started["meeting_id"]
    run = snap(manual, meeting)["workflow"]["run_id"]
    record(manual)
    invoke(manual, "stop_recording")
    drive(manual, meeting, run)
    waiting = snap(manual, meeting)
    cancelled = invoke(
        manual, "cancel_session_processing", id=meeting, expectedRevision=waiting["revision"]
    )
    assert cancelled["state"] == "cancelled" and cancelled["workflow"]["stage"] == "cancelled"
    # Cancelling again returns the cancelled snapshot unchanged: a cancelled session returns early.
    again = invoke(manual, "cancel_session_processing", id=meeting, expectedRevision=cancelled["revision"])
    assert again["revision"] == cancelled["revision"]

    retried = invoke(manual, "retry_session_processing", id=meeting)
    assert retried["workflow"]["attempt"] == 2
    assert retried["workflow"]["stage"] == "awaiting_notes"  # the completed transcript is kept
    assert retried["workflow"]["transcript_done"] is True
    new_run = retried["workflow"]["run_id"]
    detail = invoke(manual, "get_meeting", id=meeting)
    assert detail["segments"]
    invoke(
        manual, "acknowledge_processing_notes", id=meeting, runId=new_run,
        notesBarrier=retried["workflow"]["notes_barrier"],
        expectedNotesRevision=detail["notes_revision"],
    )
    assert drive(manual, meeting, new_run) == DONE
    assert snap(manual, meeting)["workflow"]["stage"] == "completed"
    assert len(stub.requests) == 1


def test_retry_refuses_a_recording_without_automatic_processing(manual: TestClient) -> None:
    set_default(manual, "recording")
    started = start(manual)
    meeting = started["meeting_id"]
    invoke(manual, "stop_recording")
    status, body = invoke_error(manual, "retry_session_processing", id=meeting)
    assert (status, body["code"]) == (400, "processing_cancelled")


def test_a_restart_marks_unfinished_work_interrupted_once_and_replays_nothing(manual: TestClient) -> None:
    set_default(manual, "final")
    started = start(manual)
    meeting = started["meeting_id"]
    record(manual)
    invoke(manual, "stop_recording")
    before = snap(manual, meeting)["revision"]
    data_dir = ctx_of(manual).store.data_dir
    first = Store(data_dir)
    try:
        interrupted = processing.read_snapshot(first.db, meeting)
        assert interrupted["state"] == "interrupted"
        assert interrupted["workflow"]["stage"] == "interrupted"
        assert interrupted["revision"] == before + 1
        assert "Retry when ready" in interrupted["workflow"]["error"]
        assert first.db.execute("SELECT COUNT(*) FROM processing_requests").fetchone()[0] == 0
    finally:
        first.close()
    second = Store(data_dir)
    try:
        again = processing.read_snapshot(second.db, meeting)
        assert (again["state"], again["revision"]) == ("interrupted", before + 1)
    finally:
        second.close()


def test_restart_keeps_the_notes_the_user_saved(manual: TestClient) -> None:
    set_default(manual, "final")
    started = start(manual)
    meeting = started["meeting_id"]
    invoke(manual, "save_notes", id=meeting, markdown="Restart must retain these notes", expectedRevision=0)
    invoke(manual, "stop_recording")
    second = Store(ctx_of(manual).store.data_dir)
    try:
        assert second.db.execute("SELECT user_markdown FROM notes WHERE meeting_id=?", (meeting,)).fetchone()[0] == (
            "Restart must retain these notes"
        )
    finally:
        second.close()


# ---- threads -----------------------------------------------------------------


def test_the_worker_thread_runs_a_final_run_to_the_barrier_without_manual_steps(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENMEET_PY_FAKE_STT", "1")
    client = build(tmp_path, workers=True)
    try:
        stub = llm_stub(client)
        set_default(client, "final", "general-v1")
        started = start(client)
        meeting = started["meeting_id"]
        record(client)
        invoke(client, "stop_recording")
        wait_for(lambda: snap(client, meeting)["workflow"]["stage"] == "awaiting_notes")
        current = snap(client, meeting)
        detail = invoke(client, "get_meeting", id=meeting)
        invoke(
            client, "acknowledge_processing_notes", id=meeting, runId=current["workflow"]["run_id"],
            notesBarrier=current["workflow"]["notes_barrier"], expectedNotesRevision=detail["notes_revision"],
        )
        wait_for(lambda: snap(client, meeting)["workflow"]["stage"] == "completed")
        assert invoke(client, "get_meeting", id=meeting)["summary"] == SUMMARY.strip()
        assert len(stub.requests) == 1
    finally:
        client.__exit__(None, None, None)


# ---- deadlines and recovery ----------------------------------------------------


def test_a_stop_after_the_four_hour_limit_needs_attention(manual: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    set_default(manual, "final")
    started = start(manual)
    meeting = started["meeting_id"]
    begun = snap(manual, meeting)["started_at"]
    monkeypatch.setattr(processing, "clock", lambda: begun + processing.DURATION_SECONDS + 5)
    invoke(manual, "stop_recording")
    workflow = snap(manual, meeting)["workflow"]
    assert workflow["stage"] == "needs_attention"
    assert "longer than automatic processing allows" in workflow["error"]


def test_a_session_past_its_grant_needs_attention_when_read(manual: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    set_default(manual, "final")
    started = start(manual)
    meeting = started["meeting_id"]
    current = snap(manual, meeting)
    monkeypatch.setattr(processing, "clock", lambda: current["authorized_until"] + 1)
    after = snap(manual, meeting)
    assert after["state"] == "needs_attention"
    assert after["revision"] == current["revision"] + 1
    invoke(manual, "stop_recording")


def test_retry_recovers_an_interrupted_run_from_the_start_of_finalization(manual: TestClient) -> None:
    stub = llm_stub(manual)
    set_default(manual, "final", "general-v1")
    started = start(manual)
    meeting = started["meeting_id"]
    record(manual)
    invoke(manual, "stop_recording")
    reopened = Store(ctx_of(manual).store.data_dir)  # a restart: the run is marked interrupted
    reopened.close()
    assert snap(manual, meeting)["workflow"]["stage"] == "interrupted"
    retried = invoke(manual, "retry_session_processing", id=meeting)
    assert retried["workflow"]["attempt"] == 2
    assert retried["workflow"]["stage"] == "finalizing_audio"  # the transcript never finished, so it runs again
    run = retried["workflow"]["run_id"]
    assert drive(manual, meeting, run) == WAIT
    waiting = snap(manual, meeting)
    detail = invoke(manual, "get_meeting", id=meeting)
    invoke(
        manual, "acknowledge_processing_notes", id=meeting, runId=run,
        notesBarrier=waiting["workflow"]["notes_barrier"], expectedNotesRevision=detail["notes_revision"],
    )
    assert drive(manual, meeting, run) == DONE
    assert snap(manual, meeting)["workflow"]["stage"] == "completed"
    assert len(stub.requests) == 1


def test_retry_after_needs_attention_uses_the_current_settings(manual: TestClient) -> None:
    set_default(manual, "final")
    started = start(manual)
    meeting = started["meeting_id"]
    record(manual)
    invoke(manual, "stop_recording")
    run = snap(manual, meeting)["workflow"]["run_id"]
    invoke(manual, "save_stt_settings", language="de", prompt="", model="base")
    assert drive(manual, meeting, run) == DONE  # the worker's next look moves the run to needs_attention
    flagged = snap(manual, meeting)
    assert flagged["state"] == "needs_attention" and flagged["workflow"]["stage"] == "needs_attention"
    retried = invoke(manual, "retry_session_processing", id=meeting)
    assert retried["state"] == "prepared"
    assert retried["plan"]["language"] == "de"
    assert retried["plan"]["configuration_revision"] == flagged["plan"]["configuration_revision"] + 1
    # No summary was chosen, so the retried run transcribes with the new language and completes.
    assert drive(manual, meeting, retried["workflow"]["run_id"]) == DONE
    finished = snap(manual, meeting)["workflow"]
    assert (finished["stage"], finished["transcript_done"]) == ("completed", True)
    assert invoke(manual, "get_meeting", id=meeting)["segments"]
