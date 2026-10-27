"""Automatic processing after a recording: plan, durable stages, budgets, cancel and retry.

Covers the whole after-recording lifecycle: plan, attach, snapshot, cancel and retry; the durable
stages with their budgets, notes barrier, publication, failure mapping and restart; the worker loop;
and the cancellation gate that allows one operation at a time. Speech and summaries reuse the
transcription jobs and the summary helpers; this module adds the durable state around them.

The database is the authority. Every publish re-checks the plan (configuration revision, state, stage,
deadline, budgets) under the store lock. Settings and provider changes flip a
prepared session to needs_attention through the triggers in migrations 013 and 029.

`step()` runs one transition synchronously, so tests can drive the whole workflow. The worker thread
only calls it in a loop. Live transcript is no longer part of automatic processing: it runs from its
own settings while the recording is captured (see api/live_commands.py). The durable stage 'live'
still means "the recording is in progress" and waits for the stop.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import threading
import time
import uuid
from typing import Any, Optional

from openmeet_py.api import reads
from openmeet_py.api.context import Context, int_arg, text_arg
from openmeet_py.api.errors import AppError
from openmeet_py.api.reads import read_settings
from openmeet_py.domain import enhancement, llm, providers
from openmeet_py.domain.connections import plan_changed
from openmeet_py.domain.transcript_edits import replace_transcript
from openmeet_py.infra.store import transaction
from openmeet_py.local_ai import service as local_ai
from openmeet_py.speech import stt
from openmeet_py.speech.transcription import jobs

log = logging.getLogger("openmeet_py")

DURATION_SECONDS = 14_400
POST_STOP_SECONDS = 14_400
UPLOAD_BYTES = 256 * 1024 * 1024
REQUESTS = 1000
TEXT_BYTES = 800_000
TERMINAL = ("completed", "failed", "cancelled", "interrupted", "needs_attention")
PLAN_CHANGED_CODES = ("session_plan_changed", "processing_plan_changed", "processing_cancelled")
DONE, WAIT, CONTINUE = "done", "wait", "continue"
TRACKS = ("mic", "system")
TERMINAL_SQL = "('completed','failed','cancelled','interrupted','needs_attention')"


def clock() -> int:
    """Unix seconds. A module function so tests can move time for the deadline rules."""
    return int(time.time())


def stale() -> AppError:
    return AppError(
        "processing_cancelled",
        "Processing changed or was cancelled. Previous saved output is unchanged.",
    )


def _invalid_record() -> AppError:
    return AppError(
        "session_processing",
        "The automatic processing record could not be read. No processing was started.",
    )


def _limits() -> dict[str, int]:
    return {
        "duration_seconds": DURATION_SECONDS,
        "post_stop_seconds": POST_STOP_SECONDS,
        "upload_bytes": UPLOAD_BYTES,
        "requests": REQUESTS,
        "text_bytes": TEXT_BYTES,
    }


# ---- plans -------------------------------------------------------------------


def default_request(settings: dict[str, Any]) -> Optional[dict[str, Any]]:
    """What the saved default asks for after a recording, or None for recording only."""
    summary = settings["processing_summary"] if settings["processing_summary"] in llm.TEMPLATE_IDS else None
    if settings["processing_mode"] == "final":
        return {"kind": "final", "summary": summary}
    return None


def _api_destination(settings: dict[str, Any], role: str) -> dict[str, Any]:
    assignment = settings["provider_assignments"][role]
    if assignment is None or not assignment["model"]:
        raise AppError(
            "provider_model", "Choose and save a model for each selected processing stage first."
        )
    connection = next(
        (item for item in settings["saved_connections"] if item["id"] == assignment["connection_id"]),
        None,
    )
    if connection is None:
        raise AppError(
            "session_plan_changed",
            "Processing settings changed, so automatic processing stopped. Nothing was sent; retry when ready.",
        )
    return {
        "kind": "compatible_api",
        "base_url": connection["base_url"],
        "model": assignment["model"],
        "connection_id": connection["id"],
        "connection_revision": connection["revision"],
        "assignment_revision": assignment["revision"],
    }


def _notes_destination(settings: dict[str, Any]) -> Optional[dict[str, Any]]:
    """The AI notes model, or None while no model is chosen. Without one the transcript still runs and
    the summary is skipped quietly; Settings already says where notes are written."""
    assignment = settings["provider_assignments"]["llm"]
    if assignment is None or not assignment["model"]:
        return None
    return _api_destination(settings, "llm")


def build_plan(db: sqlite3.Connection, request: dict[str, Any], revision: int) -> dict[str, Any]:
    """The plan the saved settings describe now. Holds no credentials: only ids, revisions and base URLs."""
    settings = read_settings(db)
    if settings["stt_mode"] == "cloud":
        speech = _api_destination(settings, "cloud_stt")
    else:
        speech = {"kind": "local_whisper", "model": settings["stt_model"]}
    summary = None
    destination = _notes_destination(settings) if request["summary"] is not None else None
    if destination is not None:
        summary = {"destination": destination, "template": request["summary"]}
        if settings["summary_instructions"]:
            summary["instructions"] = settings["summary_instructions"]
    scope = {
        "kind": "final",
        "speech": speech,
        "summary": summary,
        # Enhanced notes ride on the summary step, so they need a summary; the switch is frozen with the plan.
        "enhance": bool(summary is not None and settings["processing_enhance"]),
    }
    return {
        "id": str(uuid.uuid4()),
        "meeting_id": None,
        "configuration_revision": revision,
        "scope": scope,
        "language": settings["stt_language"],
        "tracks": list(TRACKS),
        "limits": _limits(),
    }


def configuration_revision(db: sqlite3.Connection) -> int:
    return db.execute("SELECT revision FROM processing_configuration WHERE id = 1").fetchone()[0]


def read_workflow(db: sqlite3.Connection, meeting_id: str) -> Optional[dict[str, Any]]:
    row = db.execute(
        "SELECT run_id, attempt, stage, error, live_incomplete, transcript_done, notes_barrier, "
        "notes_revision, requests_used, upload_bytes_used, text_bytes_used "
        "FROM processing_runs WHERE meeting_id = ?1",
        (meeting_id,),
    ).fetchone()
    if row is None:
        return None
    # The live preview that filled processing_provisional is gone. The field and its table stay, so an
    # older row is readable and the UI keeps one shape; nothing writes provisional rows now.
    provisional: list[dict[str, Any]] = []
    return {
        "run_id": row[0],
        "attempt": row[1],
        "stage": row[2],
        "error": row[3],
        "live_incomplete": bool(row[4]),
        "transcript_done": bool(row[5]),
        "notes_barrier": row[6],
        "notes_revision": row[7],
        "requests_used": row[8],
        "upload_bytes_used": row[9],
        "text_bytes_used": row[10],
        "provisional": provisional,
    }


def read_snapshot(db: sqlite3.Connection, meeting_id: str) -> Optional[dict[str, Any]]:
    """The session as the UI sees it. Marks a prepared session whose deadline passed as needs_attention."""
    now = clock()
    db.execute(
        "UPDATE processing_sessions SET state='needs_attention', revision=revision+1 "
        "WHERE meeting_id=?1 AND state='prepared' AND (authorized_until<=?2 OR started_at>?2) "
        "AND meeting_id IN (SELECT meeting_id FROM processing_runs WHERE stage NOT IN " + TERMINAL_SQL + ")",
        (meeting_id, now),
    )
    row = db.execute(
        "SELECT revision, state, plan_json, started_at, authorized_until FROM processing_sessions "
        "WHERE meeting_id = ?1",
        (meeting_id,),
    ).fetchone()
    if row is None:
        return None
    try:
        plan = json.loads(row[2])
    except ValueError:
        raise _invalid_record() from None
    return {
        "meeting_id": meeting_id,
        "revision": row[0],
        "state": row[1],
        "plan": plan,
        "started_at": row[3],
        "authorized_until": row[4],
        "workflow": read_workflow(db, meeting_id),
    }


def check_retry_audio_horizon(db: sqlite3.Connection, meeting_id: str, seconds: int) -> None:
    detail = reads.meeting_detail(db, meeting_id)
    row = db.execute(
        "SELECT (julianday(ended_at)-julianday(started_at))*86400 FROM meetings WHERE id = ?1 AND status = 'stopped'",
        (meeting_id,),
    ).fetchone()
    duration = row[0] if row is not None else None
    too_long = duration is None or duration < 0 or duration > seconds + 0.001
    # The sample-rate test comes first, so the division never sees a zero rate.
    unreadable = any(
        track["sample_rate"] <= 0 or track["frames"] < 0 or track["frames"] / track["sample_rate"] > seconds
        for track in detail["tracks"]
    )
    if detail["meeting"]["source"] != "desktop" or too_long or unreadable:
        raise AppError(
            "processing_retry",
            "This recording is longer than automatic processing allows or is not finalized. "
            "Use Transcribe audio on the Transcript tab instead.",
        )


def _bump(db: sqlite3.Connection, meeting_id: str) -> None:
    db.execute("UPDATE processing_sessions SET revision = revision + 1 WHERE meeting_id = ?1", (meeting_id,))


# ---- one operation at a time -------------------------------------------------


class _Operation:
    def __init__(self, meeting_id: str, run_id: str, stage: str):
        self.meeting_id = meeting_id
        self.run_id = run_id
        self.stage = stage
        self.cancel = threading.Event()


class _Guard:
    """Holds the single processing slot. finish() publishes only if the operation was not cancelled."""

    def __init__(self, owner: "Owner", operation: _Operation):
        self.owner = owner
        self.operation = operation

    @property
    def cancel(self) -> threading.Event:
        return self.operation.cancel

    def finish(self, publish: Any) -> Any:
        with self.owner.lock:
            if self.operation.cancel.is_set() or self.owner.active is not self.operation:
                raise AppError("stt_cancelled", "Processing was cancelled. Previous results were kept.")
            return publish()

    def release(self) -> None:
        with self.owner.lock:
            if self.owner.active is self.operation:
                self.owner.active = None


class Owner:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.active: Optional[_Operation] = None

    def begin(self, meeting_id: str, run_id: str, stage: str) -> _Guard:
        with self.lock:
            if self.active is not None:
                raise AppError("processing_busy", "Another processing operation is running.")
            operation = _Operation(meeting_id, run_id, stage)
            self.active = operation
            return _Guard(self, operation)


# ---- the service -------------------------------------------------------------


class Processing:
    """Owns the workflow for every recording. Recorder hooks: prepare, attach, started, stopped."""

    def __init__(self, ctx: Context, workers: bool = True):
        self.ctx = ctx
        self.workers = workers
        self.owner = Owner()
        self.quitting = False
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    # Recorder hooks ----------------------------------------------------------

    def prepare(self) -> tuple[Optional[dict[str, Any]], Optional[str]]:
        """The plan for a new recording, or (None, notice) when processing is skipped. Never blocks the recording."""
        with self.ctx.store.lock:
            settings = read_settings(self.ctx.store.db)
        request = default_request(settings)
        if request is None:
            return None, None
        try:
            with self.ctx.store.lock:
                db = self.ctx.store.db
                if (
                    settings["stt_mode"] != "cloud"
                    and not stt.fake_engine()
                    and not stt.status(stt.stt_root(self.ctx), settings["stt_model"])["installed"]
                ):
                    raise AppError(
                        "stt",
                        "The speech engine and the selected model are not installed. Download them in Settings first.",
                    )
                return build_plan(db, request, configuration_revision(db)), None
        except AppError as error:
            return None, f"Automatic processing is off for this recording: {error.message}"

    def attach(self, db: sqlite3.Connection, plan: dict[str, Any], meeting_id: str) -> None:
        """Inside the recording's start transaction. The meeting row is inserted in that same transaction."""
        recording = db.execute(
            "SELECT EXISTS(SELECT 1 FROM meetings WHERE id=?1 AND source='desktop' AND status='recording')",
            (meeting_id,),
        ).fetchone()[0]
        if not recording:
            raise AppError(
                "session_processing",
                "Automatic processing can only be attached while preparing its new recording.",
            )
        started = clock()
        db.execute(
            "INSERT INTO processing_sessions(id,meeting_id,state,plan_json,started_at,authorized_until) "
            "VALUES (?1,?2,'prepared',?3,?4,?5)",
            (
                plan["id"],
                meeting_id,
                json.dumps(plan),
                started,
                started + DURATION_SECONDS + POST_STOP_SECONDS,
            ),
        )
        db.execute(
            "INSERT INTO processing_runs(meeting_id,run_id,stage) VALUES (?1,?2,'live')",
            (meeting_id, plan["id"]),
        )

    def started(self, meeting_id: str, run_id: str) -> None:
        if self.workers:
            self._spawn(meeting_id, run_id)

    def stopped(self, db: sqlite3.Connection, meeting_id: str, success: bool) -> None:
        """Inside the stop transaction, after the meeting row is final: the stop moves the session on."""
        row = db.execute(
            "SELECT plan_json, started_at FROM processing_sessions WHERE meeting_id = ?1", (meeting_id,)
        ).fetchone()
        if row is None:
            return
        plan = json.loads(row[0])
        now = clock()
        if self.quitting:
            stage, error = "interrupted", "Processing stopped when the app closed. Retry when ready."
        elif not success:
            stage, error = (
                "failed",
                "Audio finalization failed. Recover complete audio before retrying processing.",
            )
        elif now > row[1] + DURATION_SECONDS:
            stage, error = (
                "needs_attention",
                "The recording is longer than automatic processing allows. Use Transcribe audio on the "
                "Transcript tab instead.",
            )
        elif plan["scope"].get("kind") != "final":
            # A plan from before live transcript had its own setting: it only ever showed a preview.
            stage, error = "completed", None
        else:
            stage, error = "finalizing_audio", None
        moved = db.execute(
            "UPDATE processing_runs SET stage=?1, error=?2, notes_barrier=?3 WHERE meeting_id=?4 AND stage='live'",
            (stage, error, str(uuid.uuid4()), meeting_id),
        ).rowcount
        if moved:
            db.execute(
                "UPDATE processing_sessions SET authorized_until=MIN(authorized_until,?1), revision=revision+1 "
                "WHERE meeting_id=?2",
                (now + POST_STOP_SECONDS, meeting_id),
            )

    def quit(self) -> None:
        """Window or server closing: refuse new work and mark unfinished runs interrupted."""
        self.quitting = True
        self._stop.set()
        with self.owner.lock:
            if self.owner.active is not None:
                self.owner.active.cancel.set()
        try:
            with self.ctx.store.lock:
                with transaction(self.ctx.store.db) as db:
                    db.execute(
                        "UPDATE processing_sessions SET state='interrupted', revision=revision+1 WHERE state='prepared' "
                        "AND meeting_id IN (SELECT meeting_id FROM processing_runs WHERE stage NOT IN " + TERMINAL_SQL + ")"
                    )
                    db.execute(
                        "UPDATE processing_runs SET stage='interrupted', error='Processing stopped when the app closed. "
                        "Retry when ready.' WHERE stage NOT IN " + TERMINAL_SQL
                    )
        except sqlite3.Error:
            log.warning("unfinished processing could not be marked interrupted")

    def join(self, timeout: float = 5.0) -> None:
        for thread in list(self._threads):
            thread.join(timeout)

    # Commands ----------------------------------------------------------------

    def snapshot(self, meeting_id: str) -> Optional[dict[str, Any]]:
        with self.ctx.store.lock:
            return read_snapshot(self.ctx.store.db, meeting_id)

    def acknowledge(self, meeting_id: str, run_id: str, barrier: str, revision: int) -> Optional[dict[str, Any]]:
        with self.ctx.store.lock:
            with transaction(self.ctx.store.db) as db:
                snap = read_snapshot(db, meeting_id)
                workflow = snap["workflow"] if snap else None
                if workflow is None:
                    raise stale()
                self._check(db, meeting_id, run_id, workflow["stage"])
                scope = snap["plan"]["scope"]
                has_summary = scope["kind"] == "final" and scope["summary"] is not None
                if (
                    not has_summary
                    or workflow["run_id"] != run_id
                    or workflow["notes_barrier"] != barrier
                    or workflow["stage"] in TERMINAL
                ):
                    raise stale()
                if workflow["notes_revision"] is not None:
                    if workflow["notes_revision"] != revision:
                        raise AppError(
                            "notes_conflict",
                            "The saved-note acknowledgement changed. Refresh before retrying.",
                        )
                else:
                    detail = reads.meeting_detail(db, meeting_id)
                    if detail["meeting"]["status"] != "stopped" or detail["notes_revision"] != revision:
                        raise AppError("notes_conflict", "Save the meeting notes before acknowledging processing.")
                    db.execute(
                        "UPDATE processing_runs SET notes_revision=?1, notes_snapshot=?2 WHERE meeting_id=?3 AND run_id=?4",
                        (revision, detail["user_markdown"], meeting_id, run_id),
                    )
                    _bump(db, meeting_id)
        self._notify(meeting_id)
        return self.snapshot(meeting_id)

    def retry(self, meeting_id: str) -> Optional[dict[str, Any]]:
        with self.ctx.store.lock:
            db = self.ctx.store.db
            snap = read_snapshot(db, meeting_id)
            if snap is None:
                raise stale()
            scope = snap["plan"]["scope"]
            if scope["kind"] != "final":
                raise AppError(
                    "processing_retry",
                    "This session did not run final processing. Use Transcribe audio on the Transcript tab instead.",
                )
            summary = scope["summary"]["template"] if scope["summary"] is not None else None
            plan = build_plan(db, {"kind": "final", "summary": summary}, configuration_revision(db))
            plan["meeting_id"] = meeting_id
            status = db.execute("SELECT status FROM meetings WHERE id = ?1", (meeting_id,)).fetchone()
            if status is None or status[0] != "stopped":
                raise stale()
            check_retry_audio_horizon(db, meeting_id, plan["limits"]["duration_seconds"])
            previous = snap["workflow"]
            if previous is None or previous["stage"] not in TERMINAL or previous["stage"] == "completed":
                raise stale()
            now = clock()
            barrier = str(uuid.uuid4())
            stage = "awaiting_notes" if previous["transcript_done"] else "finalizing_audio"
            with transaction(db) as tx:
                tx.execute(
                    "UPDATE processing_sessions SET id=?1, plan_json=?2, state='prepared', revision=revision+1, "
                    "started_at=?3, authorized_until=?4 WHERE meeting_id=?5",
                    (plan["id"], json.dumps(plan), now, now + POST_STOP_SECONDS, meeting_id),
                )
                tx.execute(
                    "UPDATE processing_runs SET run_id=?1, attempt=attempt+1, stage=?2, error=NULL, notes_barrier=?3, "
                    "notes_revision=NULL, notes_snapshot=NULL, requests_used=0, upload_bytes_used=0, "
                    "text_bytes_used=0 WHERE meeting_id=?4",
                    (plan["id"], stage, barrier, meeting_id),
                )
                tx.execute("DELETE FROM processing_provisional WHERE meeting_id = ?1", (meeting_id,))
        self._notify(meeting_id)
        if self.workers:
            self._spawn(meeting_id, plan["id"])
        return self.snapshot(meeting_id)

    def cancel(self, meeting_id: str, expected: int) -> Optional[dict[str, Any]]:
        with self.owner.lock, self.ctx.store.lock:
            db = self.ctx.store.db
            snap = read_snapshot(db, meeting_id)
            if snap is None:
                raise AppError("not_found", "This meeting has no automatic processing.")
            if snap["state"] == "cancelled":
                return snap
            conflict = AppError(
                "session_processing_conflict", "Processing state changed. Refresh before cancelling."
            )
            if snap["revision"] != expected:
                raise conflict
            with transaction(db) as tx:
                changed = tx.execute(
                    "UPDATE processing_sessions SET state='cancelled', revision=revision+1 "
                    "WHERE meeting_id=?1 AND revision=?2",
                    (meeting_id, expected),
                ).rowcount
                if changed != 1:
                    raise conflict
                tx.execute(
                    "UPDATE processing_runs SET stage='cancelled', error=NULL "
                    "WHERE meeting_id=?1 AND stage NOT IN ('completed','cancelled')",
                    (meeting_id,),
                )
            run_id = snap["workflow"]["run_id"] if snap["workflow"] else None
            active = self.owner.active
            if active is not None and active.meeting_id == meeting_id and active.run_id == run_id:
                active.cancel.set()
        self._notify(meeting_id)
        return self.snapshot(meeting_id)

    # Workflow ----------------------------------------------------------------

    def _check(self, db: sqlite3.Connection, meeting_id: str, run_id: str, expected: str) -> dict[str, Any]:
        """Refuses anything but the current prepared run in exactly this stage."""
        if self.quitting:
            raise stale()
        snap = read_snapshot(db, meeting_id)
        workflow = snap["workflow"] if snap else None
        if snap is None or workflow is None:
            raise stale()
        if snap["state"] != "prepared" or workflow["run_id"] != run_id or workflow["stage"] != expected:
            raise stale()
        if configuration_revision(db) != snap["plan"]["configuration_revision"] or clock() >= snap["authorized_until"]:
            raise stale()
        scope = snap["plan"]["scope"]
        if expected == "summarizing":
            allowed = scope.get("summary") is not None
        else:
            allowed = expected in ("finalizing_audio", "transcribing", "awaiting_notes")
        if not allowed:
            raise stale()
        return snap

    def _stage(self, meeting_id: str, run_id: str, expected: str, next_stage: str) -> None:
        with self.ctx.store.lock:
            with transaction(self.ctx.store.db) as db:
                self._check(db, meeting_id, run_id, expected)
                moved = db.execute(
                    "UPDATE processing_runs SET stage=?1, error=NULL WHERE meeting_id=?2 AND run_id=?3 AND stage=?4",
                    (next_stage, meeting_id, run_id, expected),
                ).rowcount
                if moved != 1:
                    raise stale()
                _bump(db, meeting_id)

    def _reserve(self, meeting_id: str, run_id: str, expected: str, fingerprint: str, audio: int, text: int) -> None:
        """Counts one billable request before it is sent. Over budget refuses and sends nothing."""
        with self.ctx.store.lock:
            with transaction(self.ctx.store.db) as db:
                snap = self._check(db, meeting_id, run_id, expected)
                workflow = snap["workflow"]
                limits = snap["plan"]["limits"]
                requests = workflow["requests_used"] + 1
                uploaded = workflow["upload_bytes_used"] + audio
                texts = workflow["text_bytes_used"] + text
                if requests > limits["requests"] or uploaded > limits["upload_bytes"] or texts > limits["text_bytes"]:
                    raise AppError(
                        "processing_budget",
                        "The session request, audio, or text budget was exhausted. Retry when ready; recording continues.",
                    )
                db.execute(
                    "INSERT INTO processing_requests(meeting_id,run_id,ordinal,fingerprint,audio_bytes,text_bytes) "
                    "VALUES (?1,?2,?3,?4,?5,?6)",
                    (meeting_id, run_id, requests, fingerprint, audio, text),
                )
                db.execute(
                    "UPDATE processing_runs SET requests_used=?1, upload_bytes_used=?2, text_bytes_used=?3 "
                    "WHERE meeting_id=?4 AND run_id=?5",
                    (requests, uploaded, texts, meeting_id, run_id),
                )
                _bump(db, meeting_id)

    def _fail(self, meeting_id: str, run_id: str, code: str, enhanced: bool = False) -> None:
        if code in PLAN_CHANGED_CODES:
            stage, message = "needs_attention", "Processing settings changed. Retry when ready."
        elif code == "processing_budget":
            stage, message = "failed", "The session processing limit was reached. Retry when ready."
        elif code == "notes_conflict":
            stage, message = "failed", "Notes or transcript changed. Previous output is unchanged; retry when ready."
        elif enhanced:
            stage, message = (
                "failed",
                "Your summary is saved. Enhanced notes did not finish; retry to create them without "
                "generating the summary again.",
            )
        else:
            stage, message = (
                "failed",
                "Processing failed. Original audio, notes, and earlier output are preserved. Retrying is safe; "
                "a previous request may already have been billed.",
            )
        with self.ctx.store.lock:
            with transaction(self.ctx.store.db) as db:
                moved = db.execute(
                    "UPDATE processing_runs SET stage=?1, error=?2 WHERE meeting_id=?3 AND run_id=?4 "
                    "AND stage NOT IN ('completed','cancelled','interrupted')",
                    (stage, message, meeting_id, run_id),
                ).rowcount
                if moved:
                    _bump(db, meeting_id)

    def _notify(self, meeting_id: str) -> None:
        try:
            snap = self.snapshot(meeting_id)
        except (sqlite3.Error, AppError):
            return
        if snap is not None:
            self.ctx.emit("session_processing_changed", snap)

    def _begin(self, meeting_id: str, run_id: str, stage: str) -> _Guard:
        return self.owner.begin(meeting_id, run_id, stage)

    def _speech(
        self,
        meeting_id: str,
        run_id: str,
        expected: str,
        settings: dict[str, Any],
        tracks: list[dict[str, Any]],
        guard: _Guard,
    ) -> tuple[list[dict[str, Any]], str, str]:
        """Local or cloud speech for these tracks, through the transcription jobs. The speech slot is non-blocking."""
        if not self.ctx.stt_busy.acquire(blocking=False):
            raise AppError(
                "processing_busy",
                "Another transcription or AI request is still running. Wait for it to finish.",
            )
        try:

            def report(_track: str, _percent: int) -> None:
                return None

            if settings["stt_mode"] == "cloud":
                with self.ctx.store.lock:
                    config = reads.provider_config(self.ctx.store.db, "cloud_stt")
                if config is None:
                    raise AppError("provider_missing", "Save a cloud transcription connection in Settings first.")

                def reserve(fingerprint: str, nbytes: int) -> None:
                    self._reserve(meeting_id, run_id, expected, fingerprint, nbytes, 0)

                return jobs._cloud(self.ctx, settings, config, tracks, guard.cancel, report, reserve)
            return jobs._local(self.ctx, settings, tracks, guard.cancel, report)
        finally:
            self.ctx.stt_busy.release()

    def _final_transcript(self, meeting_id: str, run_id: str) -> None:
        guard = self._begin(meeting_id, run_id, "finalizing_audio")
        try:
            self._stage(meeting_id, run_id, "finalizing_audio", "transcribing")
            with self.ctx.store.lock:
                db = self.ctx.store.db
                tracks = jobs.finalized_tracks(reads.meeting_detail(db, meeting_id))
                settings = read_settings(db)
            self._notify(meeting_id)
            segments, provider, model = self._speech(meeting_id, run_id, "transcribing", settings, tracks, guard)

            def publish() -> None:
                with self.ctx.store.lock:
                    with transaction(self.ctx.store.db) as db:
                        snap = self._check(db, meeting_id, run_id, "transcribing")
                        replace_transcript(db, meeting_id, segments, provider, model)
                        db.execute("DELETE FROM processing_provisional WHERE meeting_id = ?1", (meeting_id,))
                        scope = snap["plan"]["scope"]
                        summary = scope["kind"] == "final" and scope["summary"] is not None
                        db.execute(
                            "UPDATE processing_runs SET transcript_done=1, stage=?1, error=NULL "
                            "WHERE meeting_id=?2 AND run_id=?3",
                            ("awaiting_notes" if summary else "completed", meeting_id, run_id),
                        )
                        _bump(db, meeting_id)

            guard.finish(publish)
            self.ctx.emit("meeting_updated", None)
        finally:
            guard.release()

    def _summary(self, meeting_id: str, run_id: str) -> None:
        """The summary, committed on its own. Enhanced notes follow as a separate stage.

        A saved summary (summary_saved) is never requested again: a retry after a failed enhancement
        only runs the enhancement.
        """
        with self.ctx.store.lock:
            snap = self._check(self.ctx.store.db, meeting_id, run_id, "awaiting_notes")
            summary = snap["plan"]["scope"].get("summary")
            if snap["plan"]["scope"]["kind"] != "final" or summary is None:
                raise stale()
            saved = self.ctx.store.db.execute(
                "SELECT summary_saved FROM processing_runs WHERE meeting_id=?1 AND run_id=?2",
                (meeting_id, run_id),
            ).fetchone()[0]
        self._stage(meeting_id, run_id, "awaiting_notes", "summarizing")
        if not saved:
            try:
                self._write_summary(meeting_id, run_id, summary)
            except AppError as error:
                if error.code != "local_ai_model":
                    raise
                # The Local AI model was removed or never downloaded: the transcript stands and the
                # summary is skipped quietly, the same as a plan without a notes model.
                self._complete(meeting_id, run_id)
                return
        self._after_summary(meeting_id, run_id)

    def _write_summary(self, meeting_id: str, run_id: str, summary: dict[str, Any]) -> None:
        guard = self._begin(meeting_id, run_id, "summarizing")
        try:
            with self.ctx.store.lock:
                db = self.ctx.store.db
                frozen = db.execute(
                    "SELECT notes_snapshot, notes_revision FROM processing_runs WHERE meeting_id=?1 AND run_id=?2",
                    (meeting_id, run_id),
                ).fetchone()
                if frozen is None or frozen[0] is None or frozen[1] is None:
                    raise stale()
                notes, revision = frozen
                detail = reads.meeting_detail(db, meeting_id)
                config = reads.provider_config(db, "llm")
                if config is None:
                    raise AppError("provider_missing", "Save a provider connection in Settings first.")
                segments = detail["segments"]
                names = detail["speaker_names"]
                lines = reads.transcript_lines(segments, names)
                system = llm.summary_system(llm.TEMPLATE_IDS[summary["template"]], summary.get("instructions", ""))
            self._notify(meeting_id)
            if not self.ctx.ai_busy.acquire(blocking=False):
                raise AppError("processing_busy", "Another AI request is still running. Wait for it to finish.")
            try:
                # Automatic summaries may use Local AI too: start its server first if it is off.
                local_ai.ensure_ready(self.ctx, config)
                connection = providers.load_connection(config, self.ctx.transport)

                def before(body: bytes) -> None:
                    fingerprint = hashlib.sha256(body).hexdigest()
                    self._reserve(meeting_id, run_id, "summarizing", fingerprint, 0, len(body))

                markdown = llm.summarize(connection, system, notes, lines, before)
            finally:
                self.ctx.ai_busy.release()

            def publish() -> None:
                with self.ctx.store.lock:
                    with transaction(self.ctx.store.db) as db:
                        self._check(db, meeting_id, run_id, "summarizing")
                        current = reads.meeting_detail(db, meeting_id)
                        if current["notes_revision"] != revision or current["segments"] != segments:
                            raise AppError(
                                "notes_conflict",
                                "Meeting content changed during summary generation. Previous summary is "
                                "unchanged; retry when ready.",
                            )
                        db.execute(
                            "INSERT INTO summaries(meeting_id, template_hash, model, provider, markdown, transcript_hash) "
                            "VALUES (?1,?2,?3,?4,?5,?6)",
                            (
                                meeting_id,
                                summary["template"],
                                config["model"],
                                config["base_url"],
                                markdown,
                                reads.transcript_hash(segments, names),
                            ),
                        )
                        db.execute(
                            "UPDATE processing_runs SET summary_saved=1 WHERE meeting_id=?1 AND run_id=?2",
                            (meeting_id, run_id),
                        )
                        _bump(db, meeting_id)

            guard.finish(publish)
            self.ctx.emit("meeting_updated", None)
        finally:
            guard.release()

    def _after_summary(self, meeting_id: str, run_id: str) -> None:
        """Enhanced notes when the plan asks for them, otherwise completion. An enhancement error keeps the summary."""
        with self.ctx.store.lock:
            db = self.ctx.store.db
            snap = self._check(db, meeting_id, run_id, "summarizing")
            scope = snap["plan"]["scope"]
            frozen = db.execute(
                "SELECT notes_snapshot FROM processing_runs WHERE meeting_id=?1 AND run_id=?2",
                (meeting_id, run_id),
            ).fetchone()
            due = bool(
                scope.get("enhance")
                and frozen is not None
                and frozen[0]
                and frozen[0].strip()
                and enhancement.items_of(reads.meeting_detail(db, meeting_id))
            )
        if not due:
            self._complete(meeting_id, run_id)
            return
        try:
            self._enhance(meeting_id, run_id)
        except AppError as error:
            self._fail(meeting_id, run_id, error.code, enhanced=True)
        except Exception as error:  # the type only: messages can echo transcript text
            log.error("enhanced notes failed: %s", type(error).__name__)
            self._fail(meeting_id, run_id, "internal", enhanced=True)

    def _complete(self, meeting_id: str, run_id: str) -> None:
        with self.ctx.store.lock:
            with transaction(self.ctx.store.db) as db:
                self._check(db, meeting_id, run_id, "summarizing")
                db.execute(
                    "UPDATE processing_runs SET stage='completed', error=NULL WHERE meeting_id=?1 AND run_id=?2",
                    (meeting_id, run_id),
                )
                _bump(db, meeting_id)
        self.ctx.emit("meeting_updated", None)

    def _enhance(self, meeting_id: str, run_id: str) -> None:
        """Enhanced notes from the notes frozen for this run. Its own request, revision check and publish."""
        guard = self._begin(meeting_id, run_id, "summarizing")
        try:
            with self.ctx.store.lock:
                db = self.ctx.store.db
                snap = self._check(db, meeting_id, run_id, "summarizing")
                summary = snap["plan"]["scope"]["summary"]
                frozen = db.execute(
                    "SELECT notes_snapshot, notes_revision FROM processing_runs WHERE meeting_id=?1 AND run_id=?2",
                    (meeting_id, run_id),
                ).fetchone()
                if frozen is None or frozen[0] is None or frozen[1] is None:
                    raise stale()
                notes, revision = frozen
                detail = reads.meeting_detail(db, meeting_id)
                config = reads.provider_config(db, "llm")
                if config is None:
                    raise AppError("provider_missing", "Save a provider connection in Settings first.")
                segments = detail["segments"]
                names = detail["speaker_names"]
                template = summary["template"]
                system = enhancement.system_prompt(llm.TEMPLATE_IDS[template], summary.get("instructions", ""))
                planned = enhancement.plan(notes, enhancement.items_of(detail), system)
            self._notify(meeting_id)
            if not self.ctx.ai_busy.acquire(blocking=False):
                raise AppError("processing_busy", "Another AI request is still running. Wait for it to finish.")
            try:
                local_ai.ensure_ready(self.ctx, config)
                connection = providers.load_connection(config, self.ctx.transport)

                def before(body: bytes) -> None:
                    fingerprint = hashlib.sha256(body).hexdigest()
                    self._reserve(meeting_id, run_id, "summarizing", fingerprint, 0, len(body))

                markdown = enhancement.request(connection, planned, before)
            finally:
                self.ctx.ai_busy.release()

            def publish() -> None:
                with self.ctx.store.lock:
                    with transaction(self.ctx.store.db) as db:
                        self._check(db, meeting_id, run_id, "summarizing")
                        current = reads.meeting_detail(db, meeting_id)
                        if current["notes_revision"] != revision or current["segments"] != segments:
                            raise AppError(
                                "notes_conflict",
                                "Meeting content changed during enhanced notes generation. The summary is "
                                "kept; retry when ready.",
                            )
                        text, sources, _dropped = enhancement.link_sources(markdown, planned.targets)
                        enhancement.store(
                            db, meeting_id, template, config, text.strip(), sources, revision,
                            reads.transcript_hash(segments, names),
                        )
                        db.execute(
                            "UPDATE processing_runs SET stage='completed', error=NULL WHERE meeting_id=?1 AND run_id=?2",
                            (meeting_id, run_id),
                        )
                        _bump(db, meeting_id)

            guard.finish(publish)
            self.ctx.emit("meeting_updated", None)
        finally:
            guard.release()

    def step(self, meeting_id: str, run_id: str) -> str:
        """One transition. Returns CONTINUE after progress, WAIT when nothing is due yet, DONE when the run ends."""
        if self.quitting:
            return DONE
        snap = self.snapshot(meeting_id)
        workflow = snap["workflow"] if snap else None
        if workflow is None or workflow["run_id"] != run_id:
            return DONE
        stage = workflow["stage"]
        if snap["state"] != "prepared" and stage not in TERMINAL:
            self._fail(meeting_id, run_id, "session_plan_changed")
            self._notify(meeting_id)
            return DONE
        if stage in TERMINAL:
            return DONE
        try:
            if stage == "live":
                return WAIT  # the recording is still being captured; the stop moves the stage on
            if stage == "finalizing_audio":
                self._final_transcript(meeting_id, run_id)
            elif stage == "awaiting_notes":
                if workflow["notes_revision"] is None:
                    return WAIT
                self._summary(meeting_id, run_id)
            else:
                raise stale()
        except AppError as error:
            self._fail(meeting_id, run_id, error.code)
            self._notify(meeting_id)
            return DONE
        except Exception as error:  # the type only: messages can echo transcript text
            log.error("processing step failed: %s", type(error).__name__)
            self._fail(meeting_id, run_id, "internal")
            self._notify(meeting_id)
            return DONE
        self._notify(meeting_id)
        return CONTINUE

    def _spawn(self, meeting_id: str, run_id: str) -> None:
        thread = threading.Thread(
            target=self._worker, args=(meeting_id, run_id), name="openmeet-processing", daemon=True
        )
        self._threads = [item for item in self._threads if item.is_alive()] + [thread]
        thread.start()

    def _worker(self, meeting_id: str, run_id: str) -> None:
        while not self._stop.is_set():
            try:
                action = self.step(meeting_id, run_id)
            except Exception:  # a closed database at shutdown ends the run quietly
                log.error("processing worker stopped")
                return
            if action == DONE:
                return
            if action == WAIT:
                self._stop.wait(0.1)


# ---- commands ----------------------------------------------------------------


def get_session_processing(ctx: Context, id: Any) -> Optional[dict[str, Any]]:
    meeting_id = text_arg(id, "id")
    with ctx.store.lock:
        reads.require_meeting(ctx.store.db, meeting_id)
    return ctx.processing.snapshot(meeting_id)


def acknowledge_processing_notes(
    ctx: Context, id: Any, run_id: Any, notes_barrier: Any, expected_notes_revision: Any
) -> Optional[dict[str, Any]]:
    result = ctx.processing.acknowledge(
        text_arg(id, "id"),
        text_arg(run_id, "run_id"),
        text_arg(notes_barrier, "notes_barrier"),
        int_arg(expected_notes_revision, "expected_notes_revision"),
    )
    ctx.emit("session_processing_changed", result)
    return result


def retry_session_processing(ctx: Context, id: Any) -> Optional[dict[str, Any]]:
    return ctx.processing.retry(text_arg(id, "id"))


def cancel_session_processing(ctx: Context, id: Any, expected_revision: Any) -> Optional[dict[str, Any]]:
    return ctx.processing.cancel(text_arg(id, "id"), int_arg(expected_revision, "expected_revision"))
