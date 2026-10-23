"""Automatic processing after a recording: plan, durable stages, budgets, cancel, retry and the live preview.

Covers the whole after-recording lifecycle: plan, attach, snapshot, cancel and retry; the durable
stages with their budgets, notes barrier, publication, failure mapping and restart; the worker loop;
and the cancellation gate that allows one operation at a time. Speech and summaries reuse the phase 4
transcription jobs and the phase 2 summary helpers; this module adds the durable state around them.

The database is the authority. Every publish re-checks the plan (configuration revision, state, stage,
deadline, budgets) under the store lock. Settings and provider changes flip a
prepared session to needs_attention through the triggers in migrations 013 and 029.

`step()` runs one transition synchronously, so tests can drive the whole workflow. The worker thread only
calls it in a loop. Live preview runs on accepted audio that the recorder's writer copies after a successful
write (LiveTap), so it never blocks capture. It is unqualified: no real model has been run.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import logging
import queue
import sqlite3
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from openmeet_py.api import reads
from openmeet_py.api.context import Context, int_arg, text_arg
from openmeet_py.api.errors import AppError
from openmeet_py.api.reads import read_settings
from openmeet_py.audio import audio_wav
from openmeet_py.domain import llm, providers
from openmeet_py.domain.connections import plan_changed
from openmeet_py.domain.transcript_edits import replace_transcript
from openmeet_py.infra.store import transaction
from openmeet_py.speech import stt
from openmeet_py.speech.transcription import jobs

log = logging.getLogger("openmeet_py")

DURATION_SECONDS = 14_400
POST_STOP_SECONDS = 14_400
UPLOAD_BYTES = 256 * 1024 * 1024
REQUESTS = 1000
TEXT_BYTES = 800_000
LIVE_CHUNK_SECONDS = 10
LIVE_QUEUE_CHUNKS = 3
LIVE_MAX_SAMPLES = 1_000_000
LIVE_MAX_TIMING = 4096
LIVE_MAX_ROWS = 200
LIVE_MAX_BYTES = 1_048_576
LIVE_TOLERANCE_US = 30_000
LIVE_INCOMPLETE = "Live preview is incomplete. Final transcription uses the saved audio."
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
    mode = settings["processing_mode"]
    if mode == "live":
        return {"kind": "live_only"}
    if mode == "final":
        return {"kind": "final", "live": False, "summary": summary}
    if mode == "both":
        return {"kind": "final", "live": True, "summary": summary}
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


def build_plan(db: sqlite3.Connection, request: dict[str, Any], revision: int) -> dict[str, Any]:
    """The plan the saved settings describe now. Holds no credentials: only ids, revisions and base URLs."""
    settings = read_settings(db)
    if settings["stt_mode"] == "cloud":
        speech = _api_destination(settings, "cloud_stt")
    else:
        speech = {"kind": "local_whisper", "model": settings["stt_model"]}
    if request["kind"] == "live_only":
        scope: dict[str, Any] = {"kind": "live_only", "speech": speech}
    else:
        summary = None
        if request["summary"] is not None:
            summary = {"destination": _api_destination(settings, "llm"), "template": request["summary"]}
            if settings["summary_instructions"]:
                summary["instructions"] = settings["summary_instructions"]
        scope = {"kind": "final", "live": request["live"], "speech": speech, "summary": summary}
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
    provisional = [
        {"id": item[0], "chunk_id": item[1], "segment": json.loads(item[2])}
        for item in db.execute(
            "SELECT id, chunk_id, segment_json FROM processing_provisional "
            "WHERE meeting_id = ?1 AND run_id = ?2 ORDER BY chunk_id, id LIMIT ?3",
            (meeting_id, row[0], LIVE_MAX_ROWS),
        ).fetchall()
    ]
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


# ---- live preview ------------------------------------------------------------


@dataclass
class LiveChunk:
    kind: str
    chunk_id: int
    sample_rate: int
    channels: int
    data: bytes
    timing: list[audio_wav.Block]


@dataclass
class _Lane:
    kind: str
    rate: int
    channels: int
    data: bytearray = field(default_factory=bytearray)
    frames: int = 0
    timing: list[audio_wav.Block] = field(default_factory=list)
    generation: int = 0
    last_end_us: int = 0


class LiveTap:
    """Copies accepted audio into bounded chunks of about ten seconds. Only the recorder's writer calls accept().

    put_nowait never blocks: a full queue sets `incomplete` (gaps are visible) and the chunk is dropped.
    """

    def __init__(self, lanes: list[tuple[str, int, int]]):
        self.queue: "queue.Queue[LiveChunk]" = queue.Queue(LIVE_QUEUE_CHUNKS)
        self.incomplete = threading.Event()
        self._lanes = [_Lane(kind, rate, channels) for kind, rate, channels in lanes]
        self._ids = itertools.count()

    def accept(self, index: int, data: bytes, frames: int, start_us: int, generation: int) -> None:
        lane = self._lanes[index]
        broken = lane.timing and abs(lane.last_end_us - start_us) > LIVE_TOLERANCE_US
        full = (
            len(lane.timing) >= LIVE_MAX_TIMING
            or lane.generation != generation
            or (len(lane.data) + len(data)) // 4 > LIVE_MAX_SAMPLES
        )
        if broken or (lane.timing and full):
            self._flush(index)
        lane.generation = generation
        if lane.timing and lane.last_end_us == start_us:
            lane.timing[-1].frames += frames
        else:
            lane.timing.append(audio_wav.Block(lane.frames, frames, start_us, generation))
        lane.data += data
        lane.frames += frames
        lane.last_end_us = start_us + frames * 1_000_000 // lane.rate
        target = min(lane.rate * lane.channels * LIVE_CHUNK_SECONDS, LIVE_MAX_SAMPLES)
        if lane.frames * lane.channels >= target:
            self._flush(index)

    def flush_all(self) -> None:
        for index in range(len(self._lanes)):
            self._flush(index)

    def _flush(self, index: int) -> None:
        lane = self._lanes[index]
        if not lane.frames:
            return
        chunk = LiveChunk(lane.kind, next(self._ids), lane.rate, lane.channels, bytes(lane.data), lane.timing)
        lane.data = bytearray()
        lane.frames = 0
        lane.timing = []
        try:
            self.queue.put_nowait(chunk)
        except queue.Full:
            self.incomplete.set()


def _materialize(chunk: LiveChunk) -> tuple[dict[str, Any], tempfile.TemporaryDirectory]:
    """A float WAV and timing index in a scratch folder, in the layout the final pass reads."""
    scratch = tempfile.TemporaryDirectory(prefix="openmeet-live-")
    folder = Path(scratch.name)
    wav_path = folder / "audio.wav"
    timing_path = folder / "audio.timing.jsonl"
    try:
        wav = audio_wav.WavFile(wav_path, chunk.sample_rate, chunk.channels)
        wav.write(chunk.data)
        if not wav.finalize():
            raise AppError("audio", "Could not create live audio copy.")
        with open(timing_path, "wb") as handle:
            for block in chunk.timing:
                line = audio_wav.timing_line(block.frame_offset, block.frames, block.capture_start_us, block.generation or 0)
                handle.write(line.encode("ascii"))
    except BaseException:
        scratch.cleanup()
        raise
    frames = len(chunk.data) // (4 * chunk.channels)
    track = {
        "kind": chunk.kind,
        "path": str(wav_path),
        "timing_path": str(timing_path),
        "sample_rate": chunk.sample_rate,
        "channels": chunk.channels,
        "frames": frames,
    }
    return track, scratch


# ---- the service -------------------------------------------------------------


class Processing:
    """Owns the workflow for every recording. Recorder hooks: prepare, live_tap, attach, started, stopped."""

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

    def live_tap(self, plan: Optional[dict[str, Any]], mic: Any, out: Any) -> Optional[LiveTap]:
        if plan is None:
            return None
        scope = plan["scope"]
        if scope["kind"] == "final" and not scope["live"]:
            return None
        return LiveTap([("mic", mic.rate, mic.channels), ("system", out.rate, out.channels)])

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

    def started(self, meeting_id: str, run_id: str, tap: Optional[LiveTap]) -> None:
        if self.workers:
            self._spawn(meeting_id, run_id, tap)

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
        elif plan["scope"]["kind"] == "live_only":
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

    def cancel_live(self, meeting_id: str) -> None:
        """Stopping cancels an in-flight live chunk."""
        with self.owner.lock:
            active = self.owner.active
            if active is not None and active.meeting_id == meeting_id and active.stage == "live":
                active.cancel.set()

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
                    "A stopped live-only preview cannot restart. Use manual final transcription instead.",
                )
            summary = scope["summary"]["template"] if scope["summary"] is not None else None
            plan = build_plan(db, {"kind": "final", "live": False, "summary": summary}, configuration_revision(db))
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
            self._spawn(meeting_id, plan["id"], None)
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
        if scope["kind"] == "live_only":
            allowed = expected == "live"
        elif expected == "live":
            allowed = scope["live"]
        elif expected == "summarizing":
            allowed = scope["summary"] is not None
        else:
            allowed = expected in ("finalizing_audio", "transcribing", "awaiting_notes")
        if not allowed:
            raise stale()
        if expected == "live" and clock() > snap["started_at"] + snap["plan"]["limits"]["duration_seconds"]:
            raise AppError(
                "processing_budget",
                "The live processing duration limit was reached. Recording continues.",
            )
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

    def _fail(self, meeting_id: str, run_id: str, code: str) -> None:
        if code in PLAN_CHANGED_CODES:
            stage, message = "needs_attention", "Processing settings changed. Retry when ready."
        elif code == "processing_budget":
            stage, message = "failed", "The session processing limit was reached. Retry when ready."
        elif code == "notes_conflict":
            stage, message = "failed", "Notes or transcript changed. Previous output is unchanged; retry when ready."
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

    def _mark_live_incomplete(self, meeting_id: str, run_id: str) -> None:
        with self.ctx.store.lock:
            with transaction(self.ctx.store.db) as db:
                changed = db.execute(
                    "UPDATE processing_runs SET live_incomplete=1, error=?1 WHERE meeting_id=?2 AND run_id=?3 "
                    "AND live_incomplete=0 AND stage='live'",
                    (LIVE_INCOMPLETE, meeting_id, run_id),
                ).rowcount
                if changed:
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
        """Local or cloud speech for these tracks, through the phase 4 jobs. The speech slot is non-blocking."""
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

    def _publish_provisional(
        self, meeting_id: str, run_id: str, kind: str, chunk_id: int, segments: list[dict[str, Any]]
    ) -> None:
        db = self.ctx.store.db
        existing = db.execute(
            "SELECT COALESCE(SUM(length(CAST(segment_json AS BLOB))),0) FROM processing_provisional WHERE meeting_id=?1",
            (meeting_id,),
        ).fetchone()[0]
        encoded = [
            (f"{run_id}:{kind}:{chunk_id}:{index}", json.dumps(segment, ensure_ascii=False))
            for index, segment in enumerate(segments)
        ]
        size = sum(len(text.encode("utf-8")) for _, text in encoded)
        if existing + size > LIVE_MAX_BYTES or len(encoded) > LIVE_MAX_ROWS:
            self._mark_live_incomplete(meeting_id, run_id)
            return
        with transaction(db) as tx:
            for key, text in encoded:
                tx.execute(
                    "INSERT OR IGNORE INTO processing_provisional(id,meeting_id,run_id,chunk_id,segment_json) "
                    "VALUES (?1,?2,?3,?4,?5)",
                    (key, meeting_id, run_id, chunk_id, text),
                )
            tx.execute(
                "DELETE FROM processing_provisional WHERE meeting_id=?1 AND id NOT IN ("
                "SELECT id FROM processing_provisional WHERE meeting_id=?1 ORDER BY chunk_id DESC, id DESC LIMIT ?2)",
                (meeting_id, LIVE_MAX_ROWS),
            )
            _bump(tx, meeting_id)

    def _live_chunk(self, meeting_id: str, run_id: str, chunk: LiveChunk) -> None:
        guard = self._begin(meeting_id, run_id, "live")
        try:
            with self.ctx.store.lock:
                self._check(self.ctx.store.db, meeting_id, run_id, "live")
                settings = read_settings(self.ctx.store.db)
            track, scratch = _materialize(chunk)
            try:
                segments, _, _ = self._speech(meeting_id, run_id, "live", settings, [track], guard)
            finally:
                scratch.cleanup()

            def publish() -> None:
                with self.ctx.store.lock:
                    self._check(self.ctx.store.db, meeting_id, run_id, "live")
                    self._publish_provisional(meeting_id, run_id, chunk.kind, chunk.chunk_id, segments)

            guard.finish(publish)
        finally:
            guard.release()

    def _live_step(self, meeting_id: str, run_id: str, tap: Optional[LiveTap]) -> str:
        if tap is None:
            return WAIT
        if tap.incomplete.is_set():
            self._mark_live_incomplete(meeting_id, run_id)
        try:
            chunk = tap.queue.get_nowait()
        except queue.Empty:
            return WAIT
        try:
            self._live_chunk(meeting_id, run_id, chunk)
        except AppError:  # live failures never stop recording or the final pass
            self._mark_live_incomplete(meeting_id, run_id)
        except Exception as error:
            log.error("live preview chunk failed: %s", type(error).__name__)
            self._mark_live_incomplete(meeting_id, run_id)
        self._notify(meeting_id)
        return CONTINUE

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
        guard = self._begin(meeting_id, run_id, "summarizing")
        try:
            with self.ctx.store.lock:
                snap = self._check(self.ctx.store.db, meeting_id, run_id, "awaiting_notes")
                summary = snap["plan"]["scope"].get("summary")
                if snap["plan"]["scope"]["kind"] != "final" or summary is None:
                    raise stale()
            self._stage(meeting_id, run_id, "awaiting_notes", "summarizing")
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
                raise AppError(
                    "processing_busy", "Another AI request is still running. Wait for it to finish."
                )
            try:
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
                            "UPDATE processing_runs SET stage='completed', error=NULL WHERE meeting_id=?1 AND run_id=?2",
                            (meeting_id, run_id),
                        )
                        _bump(db, meeting_id)

            guard.finish(publish)
            self.ctx.emit("meeting_updated", None)
        finally:
            guard.release()

    def step(self, meeting_id: str, run_id: str, tap: Optional[LiveTap] = None) -> str:
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
                return self._live_step(meeting_id, run_id, tap)
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

    def _spawn(self, meeting_id: str, run_id: str, tap: Optional[LiveTap]) -> None:
        thread = threading.Thread(
            target=self._worker, args=(meeting_id, run_id, tap), name="openmeet-processing", daemon=True
        )
        self._threads = [item for item in self._threads if item.is_alive()] + [thread]
        thread.start()

    def _worker(self, meeting_id: str, run_id: str, tap: Optional[LiveTap]) -> None:
        while not self._stop.is_set():
            try:
                action = self.step(meeting_id, run_id, tap)
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
