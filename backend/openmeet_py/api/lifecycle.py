"""Automatic call capture: the controller around the pure reducer in domain/lifecycle.py.

Threads and locks:
- Detection (poll thread) and the recorder (whichever thread changed it) only reduce under `_lock`,
  queue the reducer's actions and wake the controller thread. Nothing is executed on those threads.
- One daemon thread, `openmeet-lifecycle`, ticks every second and runs the queued actions in order.
  Actions run outside `_lock` and outside every recorder lock; only this thread starts or stops
  automatic recordings.

Public payload: built by `payload()` and sent with the `call_lifecycle_changed` event. The reducer's
session id for an automatic call embeds the app's store key (a path), so the UI gets an opaque uuid
per session instead. App names are display names only.

Processing: after an automatic recording stops, the call waits for its processing run. At
`awaiting_notes` the controller acknowledges the notes with the current revision and barrier, the same
two values the user's acknowledge command sends. Any terminal stage ends the wait.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from openmeet_py.api import reads
from openmeet_py.api.context import Context, int_arg, text_arg
from openmeet_py.api.errors import AppError
from openmeet_py.api.reads import read_settings
from openmeet_py.domain import lifecycle as L
from openmeet_py.infra.store import transaction
from openmeet_py.platform.detection import display_name

log = logging.getLogger("openmeet_py")

THREAD_NAME = "openmeet-lifecycle"
TICK_SECONDS = 1.0
STOP_TIMEOUT = 5.0
EVENT = "call_lifecycle_changed"
ACTIVE_STATUSES = ("recording", "paused")
PERSISTED = frozenset({"recording", "paused", "end_pending", "finalizing", "complete", "recoverable_error"})
FAILED_STAGES = frozenset({"failed", "cancelled", "interrupted", "needs_attention"})
STALE = "stale_revision"
INTERNAL_START = "Automatic capture could not start. Check the app log."
INTERNAL_STOP = "Automatic capture could not stop cleanly. Check the app log."

UPSERT = (
    "INSERT INTO call_sessions (id, call_key, app_id, meeting_id, state, origin, reason, suppressed, active, "
    "revision, opened_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10, ?10) "
    "ON CONFLICT(id) DO UPDATE SET call_key = excluded.call_key, app_id = excluded.app_id, "
    "meeting_id = excluded.meeting_id, state = excluded.state, origin = excluded.origin, "
    "reason = excluded.reason, suppressed = excluded.suppressed, active = 1, "
    "revision = excluded.revision, updated_at = excluded.updated_at"
)


def _ms(seconds: float) -> int:
    return int(seconds * 1000)


class LifecycleController:
    """Owns the reducer state, the action queue and the lifecycle thread. Also the RecorderListener."""

    def __init__(self, ctx: Context, policy: Optional[L.Policy] = None) -> None:
        self.ctx = ctx
        self.policy = policy or L.Policy()
        # Injected by tests. `clock` drives the timers; `wall` only converts the keep deadline for the UI.
        self.clock: Callable[[], float] = time.monotonic
        self.wall: Callable[[], float] = time.time
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._closed = False
        self._thread: Optional[threading.Thread] = None
        self._queue: deque[L.Action] = deque()
        self._machine = L.Machine(epoch=self._restore())
        self._error: Optional[str] = None
        self._meeting: Optional[tuple[str, str]] = None  # (reducer session id, meeting id)
        self._starting: Optional[str] = None  # reducer session id of the StartAuto being executed
        self._public: Optional[tuple[str, str]] = None  # (reducer session id, opaque id for the UI)
        if ctx.detection is not None:
            ctx.detection.subscribe(self._on_signals)
        if ctx.recorder is not None:
            ctx.recorder.add_listener(self)
        with ctx.store.lock:
            enabled = read_settings(ctx.store.db)["auto_capture"]
        with self._lock:
            self._feed_locked(L.SettingChanged(enabled=enabled))

    # Startup -----------------------------------------------------------------

    def _restore(self) -> int:
        """Clears rows a previous process left active, and returns the next epoch.

        Automatic call keys end in `#<epoch>`. The next epoch must be above every stored one, so a
        restart never reuses a key the table already holds.
        """
        with self.ctx.store.lock:
            with transaction(self.ctx.store.db) as db:
                db.execute("UPDATE call_sessions SET active = 0 WHERE active = 1")
            keys = [row[0] for row in self.ctx.store.db.execute("SELECT call_key FROM call_sessions")]
        epochs = [int(key.rsplit("#", 1)[1]) for key in keys if "#" in key and key.rsplit("#", 1)[1].isdigit()]
        return max(epochs) + 1 if epochs else 0

    def start(self) -> None:
        with self._lock:
            if self._thread is not None:
                return
            self._closed = False
            self._thread = threading.Thread(target=self._run, name=THREAD_NAME, daemon=True)
            thread = self._thread
        thread.start()

    def stop(self) -> None:
        """Ends the thread and drops queued actions. It never stops a recording; the recorder does that."""
        with self._lock:
            self._closed = True
            self._queue.clear()
            thread, self._thread = self._thread, None
        self._wake.set()
        if thread is not None and thread is not threading.current_thread():
            thread.join(STOP_TIMEOUT)
            if thread.is_alive():
                log.warning("the call lifecycle thread did not stop in time")

    def _run(self) -> None:
        while True:
            self._wake.wait(TICK_SECONDS)
            self._wake.clear()
            with self._lock:
                if self._closed:
                    return
            try:
                self.pump()
            except Exception as error:  # the loop must survive a bad step; the type only, no content
                log.error("call lifecycle step failed: %s", type(error).__name__)

    def pump(self) -> None:
        """One step: a tick, the queued actions, and the processing check. The thread calls this; tests too."""
        with self._lock:
            self._feed_locked(L.Tick(now=self.clock()))
        self._drain()
        self._finalize_check()
        self._drain()

    # Reducer feed ------------------------------------------------------------

    def _feed_locked(self, event: L.Event) -> None:
        machine, actions = L.reduce(self._machine, event, self.policy)
        self._machine = machine
        if actions and not self._closed:
            self._queue.extend(actions)
            self._wake.set()

    def _queue_publish_locked(self) -> None:
        self._queue.append(L.Publish(snapshot={}))
        self._wake.set()

    def _drain(self) -> None:
        while True:
            with self._lock:
                if self._closed or not self._queue:
                    return
                action = self._queue.popleft()
            try:
                self._execute(action)
            except Exception as error:  # one failed action must not wedge the queue
                log.error("call lifecycle action failed: %s", type(error).__name__)

    def _execute(self, action: L.Action) -> None:
        if isinstance(action, L.StartAuto):
            self._start(action)
        elif isinstance(action, L.StopAuto):
            self._stop(action)
        elif isinstance(action, L.Publish):
            self._publish()
        # Prompt: the existing microphone_apps prompt already covers it.

    # Actions -----------------------------------------------------------------

    def _start(self, action: L.StartAuto) -> None:
        with self.ctx.store.lock:
            settings = read_settings(self.ctx.store.db)
        # Devices come from the saved Settings only. A missing or invalid one fails the start; nothing retries.
        title = f"{display_name(action.app_id)} call"
        event = self._current_calendar_event()
        if event is not None:
            title = event["title"]
        self._starting = action.session_id
        try:
            self.ctx.recorder.start(
                title,
                settings["microphone_id"] or "",
                settings["output_id"] or "",
                origin="auto",
            )
        except AppError as error:
            self._start_failed(action, error.code, error.message)
        except Exception as error:
            log.error("automatic capture could not start: %s", type(error).__name__)
            self._start_failed(action, "internal", INTERNAL_START)
        finally:
            self._starting = None
        if event is not None:
            meeting_id = self.ctx.recorder.state()["meeting_id"]
            if meeting_id:
                with self.ctx.store.lock:
                    self.ctx.store.db.execute(
                        "UPDATE meetings SET calendar_event_id = ?2 WHERE id = ?1", (meeting_id, event["id"])
                    )
                    self.ctx.store.db.commit()

    def _current_calendar_event(self) -> Optional[dict[str, Any]]:
        """The calendar event running now, if a feed is configured; the title then names the meeting."""
        calendar = getattr(self.ctx, "calendar", None)
        if calendar is None:
            return None
        moment = datetime.fromtimestamp(self.wall(), timezone.utc)
        return calendar.current_event(moment)

    def _start_failed(self, action: L.StartAuto, code: str, message: str) -> None:
        with self._lock:
            self._error = message
            self._feed_locked(L.RecorderStartFailed(session_id=action.session_id, reason=code))

    def _stop(self, action: L.StopAuto) -> None:
        recorder = self.ctx.recorder
        if recorder.state()["status"] not in ACTIVE_STATUSES:
            with self._lock:
                self._feed_locked(L.RecorderStopped(session_id=action.session_id, ok=True))
            return
        try:
            recorder.stop(origin="lifecycle")
        except AppError as error:
            self._stop_failed(action, error.message)
        except Exception as error:
            log.error("automatic capture could not stop: %s", type(error).__name__)
            self._stop_failed(action, INTERNAL_STOP)

    def _stop_failed(self, action: L.StopAuto, message: str) -> None:
        # The recorder's stop_failed event normally arrives first; this is idempotent and adds the text.
        with self._lock:
            self._error = message
            self._feed_locked(L.RecorderStopped(session_id=action.session_id, ok=False))
            self._queue_publish_locked()

    def _publish(self) -> None:
        with self._lock:
            machine = self._machine
            payload = self._payload_locked(machine)
            meeting_id = self._meeting_locked(machine)
        self._persist(machine, payload["session_id"], meeting_id)
        self.ctx.emit(EVENT, payload)

    def _persist(self, machine: L.Machine, public_id: Optional[str], meeting_id: Optional[str]) -> None:
        if public_id is None or machine.state.value not in PERSISTED or machine.origin not in ("auto", "manual"):
            return
        call_key = machine.call_key or machine.session_id or public_id
        stamp = _ms(self.wall())
        try:
            with self.ctx.store.lock:
                with transaction(self.ctx.store.db) as db:
                    # The partial unique index allows one active row; the upsert below makes this one.
                    db.execute("UPDATE call_sessions SET active = 0 WHERE active = 1 AND id <> ?1", (public_id,))
                    db.execute(
                        UPSERT,
                        (
                            public_id,
                            call_key,
                            machine.app_id or "",
                            meeting_id,
                            machine.state.value,
                            machine.origin,
                            machine.reason,
                            int(machine.suppressed),
                            machine.revision,
                            stamp,
                        ),
                    )
        except sqlite3.Error:
            log.warning("call lifecycle state could not be stored")

    # Processing --------------------------------------------------------------

    def _finalize_check(self) -> None:
        """Once an automatic recording has stopped, moves its call on when the processing run is done."""
        with self._lock:
            machine = self._machine
            if not (
                machine.state is L.State.FINALIZING
                and machine.origin == "auto"
                and machine.recorder_idle
                and machine.session_id is not None
                and self._meeting is not None
                and self._meeting[0] == machine.session_id
            ):
                return
            session_id, meeting_id = machine.session_id, self._meeting[1]
        outcome = self._processing_outcome(meeting_id)
        if outcome is None:
            return
        with self._lock:
            if self._machine.session_id == session_id:
                self._feed_locked(L.ProcessingFinished(session_id=session_id, ok=outcome))

    def _processing_outcome(self, meeting_id: str) -> Optional[bool]:
        """True or False once the run is terminal, None while it is still working. Never blocks."""
        processing = self.ctx.processing
        if processing is None:
            return True
        try:
            snap = processing.snapshot(meeting_id)
        except (AppError, sqlite3.Error):
            return None
        workflow = snap["workflow"] if snap else None
        if workflow is None:
            return True  # this recording was not set up for processing
        stage = workflow["stage"]
        if stage == "awaiting_notes":
            if workflow["notes_revision"] is None:
                self._acknowledge(meeting_id, workflow)
            return None
        if stage == "completed":
            return True
        if stage in FAILED_STAGES:
            return False
        return None

    def _acknowledge(self, meeting_id: str, workflow: dict[str, Any]) -> None:
        try:
            with self.ctx.store.lock:
                revision = reads.meeting_detail(self.ctx.store.db, meeting_id)["notes_revision"]
            self.ctx.processing.acknowledge(meeting_id, workflow["run_id"], workflow["notes_barrier"], revision)
        except (AppError, sqlite3.Error) as error:
            # A notes edit between the read and the acknowledgement; the next tick tries again.
            log.debug("automatic notes acknowledgement waits (%s)", getattr(error, "code", "database"))

    # RecorderListener --------------------------------------------------------

    def recorder_event(self, kind: str, meeting_id: Optional[str], origin: str, reason: Optional[str]) -> None:
        """Runs on the thread that changed the recorder, after its lock is released. Reduces and queues only."""
        if self._closed:
            return
        if kind == "fault":
            # A fault pauses capture and keeps the session; it ends the call only when the recorder is gone.
            if self.ctx.recorder.state()["status"] in ACTIVE_STATUSES:
                return
            with self._lock:
                self._stopped_locked(False)
            return
        with self._lock:
            if kind == "started":
                if origin == "manual":
                    session_id = uuid.uuid4().hex
                    self._meeting = (session_id, meeting_id or "")
                    self._error = None
                    self._feed_locked(L.ManualStart(session_id=session_id))
                elif origin == "auto" and self._starting is not None:
                    self._meeting = (self._starting, meeting_id or "")
                    self._error = None
            elif kind == "paused" and origin == "manual":
                self._feed_locked(L.ManualPause())
            elif kind == "resumed" and origin == "manual":
                self._feed_locked(L.ManualResume())
            elif kind == "stopped":
                if origin == "manual":
                    self._feed_locked(L.ManualStop())
                self._error = None
                self._stopped_locked(True)
            elif kind == "stop_failed":
                self._stopped_locked(False)

    def _stopped_locked(self, ok: bool) -> None:
        session_id = self._machine.session_id
        if session_id is not None:
            self._feed_locked(L.RecorderStopped(session_id=session_id, ok=ok))

    # Settings and UI commands ------------------------------------------------

    def setting_changed(self, enabled: bool) -> None:
        with self._lock:
            self._feed_locked(L.SettingChanged(enabled=bool(enabled)))

    def _on_signals(self, signals: tuple[Any, ...]) -> None:
        """DetectionService listener, on the poll thread. Raw signals in use and idle, no debounce."""
        with self._lock:
            self._feed_locked(L.SignalsObserved(signals=tuple(signals), now=self.clock()))

    def payload(self) -> dict[str, Any]:
        with self._lock:
            return self._payload_locked(self._machine)

    def keep_recording(self, session_id: str, expected_revision: int) -> dict[str, Any]:
        with self._lock:
            self._check_locked(session_id, expected_revision)
            self._feed_locked(L.KeepRecording(session_id=self._machine.session_id or ""))
            return self._payload_locked(self._machine)

    def end_now(self, session_id: str, expected_revision: int) -> dict[str, Any]:
        with self._lock:
            self._check_locked(session_id, expected_revision)
            self._feed_locked(L.EndNow(session_id=self._machine.session_id or ""))
            return self._payload_locked(self._machine)

    def _check_locked(self, session_id: str, expected_revision: int) -> None:
        machine = self._machine
        if expected_revision != machine.revision or session_id != self._public_id_locked(machine):
            raise AppError(STALE, "The call changed. Refresh before choosing again.", status=409)

    def _public_id_locked(self, machine: L.Machine) -> Optional[str]:
        if machine.session_id is None:
            return None
        if self._public is None or self._public[0] != machine.session_id:
            self._public = (machine.session_id, uuid.uuid4().hex)
        return self._public[1]

    def _meeting_locked(self, machine: L.Machine) -> Optional[str]:
        if self._meeting is not None and machine.session_id is not None and self._meeting[0] == machine.session_id:
            return self._meeting[1] or None
        return None

    def _payload_locked(self, machine: L.Machine) -> dict[str, Any]:
        public_id = self._public_id_locked(machine)
        deadline = None
        if machine.state is L.State.END_PENDING and machine.end_since is not None:
            remaining = machine.end_since + self.policy.keep_window_s - self.clock()
            deadline = _ms(self.wall() + max(0.0, remaining))
        return {
            "state": machine.state.value,
            "enabled": machine.enabled,
            "session_id": public_id,
            "meeting_id": self._meeting_locked(machine),
            "app_name": display_name(machine.app_id) if machine.app_id else None,
            "origin": machine.origin if public_id is not None else None,
            "revision": machine.revision,
            "reason": machine.reason,
            "end_deadline_ms": deadline,
            "error": self._error if machine.state is L.State.RECOVERABLE_ERROR else None,
        }


# ---- command handlers (registered in api/commands.py) -------------------------


def get_call_lifecycle(ctx: Context) -> dict[str, Any]:
    return ctx.lifecycle.payload()


def lifecycle_keep_recording(ctx: Context, session_id: Any, expected_revision: Any) -> dict[str, Any]:
    return ctx.lifecycle.keep_recording(text_arg(session_id, "session_id"), int_arg(expected_revision, "expected_revision"))


def lifecycle_end_now(ctx: Context, session_id: Any, expected_revision: Any) -> dict[str, Any]:
    return ctx.lifecycle.end_now(text_arg(session_id, "session_id"), int_arg(expected_revision, "expected_revision"))
