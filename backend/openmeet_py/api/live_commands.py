"""Live transcript commands and the service behind them: state, final lines, models and downloads.

One LiveService per app. The recorder asks it for a session when a recording starts, hands the audio
to the session after each successful write, and gives it back on stop, where the final lines are
drained on a background thread so the stop command never waits for a decoder.

Per-meeting state lives in memory: the current partial per lane, the state, the engine label, whether
the audio leaves this device and the one-sentence notice. Final lines are written to live_lines by one
writer thread, so SQLite and nothing else runs on the event loop. A meeting is capped at 20000 lines
and 8 MB of text; past that the writer stops storing and the notice says the final transcript will have
everything. Transcript text is never logged.

Nothing downloads until live_model_install is called with a pinned streaming model. The list is read
from speech.live.listing(), which checks files on disk and never streams anything.
"""

from __future__ import annotations

import io
import json
import logging
import queue
import sqlite3
import threading
import wave
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import httpx
import numpy as np

from openmeet_py.api import reads
from openmeet_py.api.context import Context, text_arg
from openmeet_py.api.errors import AppError
from openmeet_py.domain import providers
from openmeet_py.platform import keys
from openmeet_py.speech import cloud_stt, live, model_library, stt, streaming_models
from openmeet_py.speech.live.session import INCOMPLETE_NOTICE

log = logging.getLogger("openmeet_py")

MAX_LINES = 20_000
MAX_TEXT_BYTES = 8 * 1024 * 1024
INCOMPLETE = INCOMPLETE_NOTICE
FAILED = "Live transcript stopped because the speech engine failed."
STALE_CLOUD = "The saved cloud settings changed, so live cloud transcript stopped. Start a new recording to use them."
MODEL_CHOICE = "Choose a listed live transcript model."
MODEL_BUSY = "A live model download is already running. Cancel it first."
MODEL_UNKNOWN = "That live model is not a download. Choose a streaming model."
STOP_TIMEOUT = 10.0
DRAIN_TIMEOUT = 10.0

LINE_COLUMNS = "id, lane, speaker, start_ms, end_ms, text"

_STOP = object()


@dataclass
class _Meeting:
    """What is known about one meeting's live transcript, for the life of this process."""

    state: str = "off"
    engine: Optional[str] = None
    leaves_device: bool = False
    notice: Optional[str] = None
    session: Any = None
    partials: dict[str, dict[str, Any]] = field(default_factory=dict)
    lines: int = 0  # written by the store thread only
    text_bytes: int = 0
    full: bool = False


class LiveService:
    """Live transcript for every recording: sessions, final-line storage, the model list and downloads."""

    def __init__(self, ctx: Context):
        self.ctx = ctx
        self._lock = threading.Lock()
        self._meetings: dict[str, _Meeting] = {}
        self._writes: "queue.SimpleQueue[Any]" = queue.SimpleQueue()
        self._writer: Optional[threading.Thread] = None
        self._finishing: list[tuple[Any, threading.Thread]] = []  # (session, drain thread) of stopped recordings
        self._closing = False
        # One download at a time, with the event live_model_cancel sets.
        self._install_lock = threading.Lock()
        self._install_model: Optional[str] = None
        self._install_cancel: Optional[threading.Event] = None

    # ---- a recording's session -------------------------------------------------------------

    def begin(self, meeting_id: str, lanes: list[tuple[str, int, int]]) -> Any:
        """Starts a live session for this recording, or returns None with the reason in the state.

        A model that cannot run now never blocks capture: the meeting shows one sentence instead.
        """
        entry = _Meeting()
        with self._lock:
            self._meetings[meeting_id] = entry
        with self.ctx.store.lock:
            settings = reads.read_settings(self.ctx.store.db)
        if not settings["live_transcript"]:
            return None
        cloud: Optional[Callable[[np.ndarray], str]] = None
        if _wants_cloud(settings):
            try:
                cloud = self._cloud_upload(settings)
            except AppError as error:
                self._note(meeting_id, "off", notice=error.message)
                return None
        try:
            resolved = live.resolve(stt.stt_root(self.ctx), settings, cloud)
        except AppError as error:
            self._note(meeting_id, "off", notice=error.message)
            return None
        except Exception as error:  # the type only: messages can echo configuration
            log.error("live transcript could not resolve an engine: %s", type(error).__name__)
            self._note(meeting_id, "off", notice=FAILED)
            return None
        entry.engine = resolved.label
        entry.leaves_device = bool(resolved.leaves_device)

        def on_line(line: dict[str, Any]) -> None:
            self._on_line(meeting_id, line)

        def on_state(payload: dict[str, Any]) -> None:
            self._on_state(meeting_id, payload)

        session = live.LiveSession(meeting_id, lanes, resolved, on_line, on_state)
        entry.session = session
        try:
            session.start()
        except Exception as error:
            log.error("live transcript could not start: %s", type(error).__name__)
            entry.session = None
            self._note(meeting_id, "off", notice=FAILED)
            return None
        return session

    def finish(self, session: Any) -> None:
        """Drains a stopped recording's session on its own thread: final lines flush, the caller returns."""
        if session is None:
            return

        def drain() -> None:
            try:
                session.stop(STOP_TIMEOUT)
            except Exception as error:  # a broken decoder must not escape a background thread
                log.error("live transcript could not finish: %s", type(error).__name__)

        thread = threading.Thread(target=drain, name="openmeet-live-finish", daemon=True)
        with self._lock:
            self._finishing = [item for item in self._finishing if item[1].is_alive()] + [(session, thread)]
        thread.start()

    def abandon(self, session: Any) -> None:
        """A recording that never reached the database: close its session without finals."""
        if session is None:
            return
        with self._lock:
            entry = self._meetings.get(session.meeting_id)
            if entry is not None and entry.session is session:
                entry.session = None
                entry.state = "off"
        try:
            session.cancel()
        except Exception as error:
            log.error("live transcript could not be abandoned: %s", type(error).__name__)

    def quit(self) -> None:
        """App closing: finish what was stopped, cancel what still runs, and stop the store thread."""
        with self._lock:
            finishing = [item for item in self._finishing if item[1].is_alive()]
            # A stop that is already draining keeps its session: cancelling it would drop its final lines.
            draining = [session for session, _ in finishing]
            cancel = self._install_cancel
            sessions = [
                entry.session
                for entry in self._meetings.values()
                if entry.session is not None and not any(entry.session is item for item in draining)
            ]
            for entry in self._meetings.values():
                entry.session = None
        if cancel is not None:
            cancel.set()
        for session in sessions:
            try:
                session.cancel()
            except Exception:
                continue
        # A session that was already stopped still has finals to flush; joining it before closing the
        # queue is what keeps those lines. Only then does the store stop accepting new ones.
        for _, thread in finishing:
            thread.join(STOP_TIMEOUT)
        self._closing = True
        self.drain(DRAIN_TIMEOUT)

    # ---- lines -----------------------------------------------------------------------------

    def _on_line(self, meeting_id: str, line: dict[str, Any]) -> None:
        lane = str(line.get("lane"))
        final = bool(line.get("final"))
        with self._lock:
            entry = self._meetings.get(meeting_id)
            if entry is not None:
                if final:
                    entry.partials.pop(lane, None)
                else:
                    entry.partials[lane] = line
        if final:
            self._enqueue((meeting_id, line))
        self.ctx.emit("live_transcript", {"meeting_id": meeting_id, "line": line})

    def _on_state(self, meeting_id: str, payload: dict[str, Any]) -> None:
        with self._lock:
            entry = self._meetings.get(meeting_id)
            if entry is None:
                return
            state = str(payload.get("state") or "off")
            entry.state = state
            entry.engine = payload.get("engine")
            entry.leaves_device = bool(payload.get("leaves_device"))
            if payload.get("notice"):
                entry.notice = str(payload["notice"])
            if state in ("stopped", "failed"):
                entry.session = None  # the session is done; what it left stays readable
            notice, engine, leaves = entry.notice, entry.engine, entry.leaves_device
        self.ctx.emit(
            "live_state",
            {
                "meeting_id": meeting_id,
                "state": state,
                "engine": engine,
                "leaves_device": leaves,
                "notice": notice,
            },
        )

    def _note(self, meeting_id: str, state: str, notice: Optional[str] = None) -> None:
        """Sets the state without a session, then tells the page."""
        with self._lock:
            entry = self._meetings.get(meeting_id)
            if entry is None:
                return
            entry.state = state
            entry.notice = notice
            payload = {
                "meeting_id": meeting_id,
                "state": state,
                "engine": entry.engine,
                "leaves_device": entry.leaves_device,
                "notice": notice,
            }
        self.ctx.emit("live_state", payload)

    def _enqueue(self, item: Any) -> None:
        with self._lock:
            if self._closing:
                return
            if self._writer is None or not self._writer.is_alive():
                self._writer = threading.Thread(
                    target=self._run_writer, name="openmeet-live-store", daemon=True
                )
                self._writer.start()
        self._writes.put(item)

    def drain(self, timeout: float = DRAIN_TIMEOUT) -> None:
        """Waits until every line handed over so far is written. Tests and shutdown use it."""
        marker = threading.Event()
        with self._lock:
            thread = self._writer
        if thread is None:
            return
        self._writes.put(marker)
        marker.wait(timeout)

    def _run_writer(self) -> None:
        while True:
            item = self._writes.get()
            if item is _STOP:
                return
            if isinstance(item, threading.Event):
                item.set()
                continue
            meeting_id, line = item
            try:
                self._store(meeting_id, line)
            except sqlite3.Error:
                log.error("a live transcript line could not be saved")
            except Exception as error:  # the type only: the message can echo transcript text
                log.error("a live transcript line failed: %s", type(error).__name__)

    def _store(self, meeting_id: str, line: dict[str, Any]) -> None:
        text = str(line.get("text") or "")
        size = len(text.encode("utf-8"))
        with self._lock:
            entry = self._meetings.get(meeting_id)
            if entry is None or entry.full:
                return
            if entry.lines >= MAX_LINES or entry.text_bytes + size > MAX_TEXT_BYTES:
                entry.full = True
                entry.notice = INCOMPLETE
                state, engine, leaves, notice = (
                    entry.state,
                    entry.engine,
                    entry.leaves_device,
                    entry.notice,
                )
                full = True
            else:
                entry.lines += 1
                entry.text_bytes += size
                full = False
        if full:
            self.ctx.emit(
                "live_state",
                {
                    "meeting_id": meeting_id,
                    "state": state,
                    "engine": engine,
                    "leaves_device": leaves,
                    "notice": notice,
                },
            )
            return
        with self.ctx.store.lock:
            self.ctx.store.db.execute(
                "INSERT OR REPLACE INTO live_lines(meeting_id, id, lane, speaker, start_ms, end_ms, text) "
                "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                (
                    meeting_id,
                    str(line.get("id") or ""),
                    str(line.get("lane") or ""),
                    str(line.get("speaker") or ""),
                    int(line.get("start_ms") or 0),
                    int(line.get("end_ms") or 0),
                    text,
                ),
            )

    # ---- the transcript as the page reads it -------------------------------------------------

    def transcript(self, meeting_id: str) -> dict[str, Any]:
        with self.ctx.store.lock:
            rows = self.ctx.store.db.execute(
                f"SELECT {LINE_COLUMNS} FROM live_lines WHERE meeting_id = ?1 "
                "ORDER BY start_ms, lane, id",
                (meeting_id,),
            ).fetchall()
        lines = [
            {
                "id": row[0],
                "lane": row[1],
                "speaker": row[2],
                "start_ms": row[3],
                "end_ms": row[4],
                "text": row[5],
                "final": True,
            }
            for row in rows
        ]
        with self._lock:
            entry = self._meetings.get(meeting_id)
            session = entry.session if entry is not None else None
            running = session is not None
            state = entry.state if entry is not None else "off"
            engine = entry.engine if entry is not None else None
            leaves = entry.leaves_device if entry is not None else False
            notice = entry.notice if entry is not None else None
            if running and getattr(session, "incomplete", False) is True and notice is None:
                notice = INCOMPLETE  # a dropped block shows while the recording runs, not only after it stops
            partials = (
                [entry.partials[lane] for lane in ("mic", "system") if lane in entry.partials]
                if entry is not None and running
                else []
            )
        if not running and state in ("off", "starting", "running", "stopped"):
            # Nothing runs now: lines left by an earlier session read as stopped, and no lines reads off.
            state = "stopped" if lines else "off"
        return {
            "meeting_id": meeting_id,
            "lines": lines,
            "partials": partials,
            "state": state,
            "engine": engine,
            "leaves_device": bool(leaves),
            "notice": notice,
        }

    # ---- the model list and its one download -------------------------------------------------

    def models(self) -> dict[str, Any]:
        with self.ctx.store.lock:
            settings = reads.read_settings(self.ctx.store.db)
            config = reads.provider_config(self.ctx.store.db, "cloud_stt")
        cloud_ready = bool(config) and keys.key_status(config["credential_account"]) == "present"
        with self._install_lock:
            installing = self._install_model
        return live.listing(stt.stt_root(self.ctx), settings, cloud_ready, installing)

    def install(self, model_id: str) -> dict[str, Any]:
        """Starts one pinned streaming model download and returns at once. Progress arrives as events."""
        if streaming_models.pinned(model_id) is None:
            raise AppError("live_model", MODEL_UNKNOWN)
        with self._install_lock:
            if self._install_model is not None:
                raise AppError("live_model", MODEL_BUSY)
            cancel = threading.Event()
            self._install_model = model_id
            self._install_cancel = cancel
        thread = threading.Thread(
            target=self._download, args=(model_id, cancel), name="openmeet-live-model", daemon=True
        )
        thread.start()
        return self.models()

    def cancel_install(self) -> dict[str, Any]:
        with self._install_lock:
            cancel = self._install_cancel
        if cancel is not None:
            cancel.set()
        return self.models()

    def _download(self, model_id: str, cancel: threading.Event) -> None:
        model = streaming_models.pinned(model_id)
        total = model.archive.size if model is not None else 0

        def progress(stage: str, done: int, size: int) -> None:
            self._progress(model_id, stage, done, size)

        client = model_library._client(self.ctx.transport)
        stage, error = "done", None
        try:
            streaming_models.install(
                stt.stt_root(self.ctx), model_id, cancel, progress, client
            )
        except AppError as failure:
            if failure.code == "model_cancelled":
                stage = "cancelled"
            else:
                stage, error = "failed", failure.message
        except Exception as failure:  # the type only: a download error can echo a URL
            log.error("a live model download failed: %s", type(failure).__name__)
            stage, error = "failed", "The download failed. Nothing was installed."
        finally:
            client.close()
            self._progress(model_id, stage, total if stage == "done" else 0, total, error)
            with self._install_lock:
                if self._install_model == model_id:
                    self._install_model = None
                    self._install_cancel = None

    def _progress(
        self, model_id: str, stage: str, done: int, total: int, error: Optional[str] = None
    ) -> None:
        self.ctx.emit(
            "live_model_progress",
            {
                "model_id": model_id,
                "done": max(0, int(done)),
                "total": max(0, int(total)),
                "stage": stage,
                "error": error,
            },
        )

    # ---- the cloud upload behind a cloud live transcript -------------------------------------

    def _cloud_upload(self, settings: dict[str, Any]) -> Optional[Callable[[np.ndarray], str]]:
        """One finished utterance per request, through the saved cloud transcription connection.

        It is the same provider connection, key and client the final cloud pass uses. A request is
        never retried and its body is capped; the CloudDecoder keeps the per-recording limits.
        """
        saved = self._cloud_saved()
        config = saved[1]
        if config is None:
            return None
        connection = providers.load_connection(config, self.ctx.transport)
        url = connection.endpoint("audio/transcriptions")
        model = connection.require_model()
        language = str(settings.get("stt_language") or "auto")
        prompt = str(settings.get("stt_prompt") or "").strip()
        unreachable = AppError(
            "cloud_stt",
            "Cannot reach the transcription provider. Check its API base URL and connection.",
        )

        def unchanged() -> None:
            """The saved live choice, speech options and cloud connection are still the ones this recording uses."""
            if self._cloud_saved() != saved:
                raise AppError("live_model", STALE_CLOUD)

        def upload(samples16k: np.ndarray) -> str:
            unchanged()  # before the request: nothing leaves the device once the saved settings changed
            data = {"model": model, "response_format": "json"}
            if language != "auto":
                data["language"] = language
            if prompt:
                data["prompt"] = prompt
            body = _wav_bytes(samples16k)
            with providers.client(cloud_stt.REQUEST_TIMEOUT, connection.transport) as http:
                try:
                    files = {"file": ("audio.wav", body, "audio/wav")}
                    with http.stream(
                        "POST", url, headers=connection.headers(), data=data, files=files
                    ) as response:
                        providers.check_status(response.status_code)
                        payload = bytearray()
                        for block in response.iter_bytes():
                            payload.extend(block)
                            if len(payload) > cloud_stt.MAX_RESPONSE_BYTES:
                                raise _unusable()
                except AppError:
                    raise
                except httpx.HTTPError:
                    raise unreachable from None
            unchanged()  # a reply to a request sent under older settings is never published
            return _text_of(bytes(payload))

        return upload

    def _cloud_saved(self) -> tuple[tuple[Any, ...], Optional[dict[str, Any]]]:
        """The saved values a cloud upload depends on, read together, and the cloud connection row."""
        with self.ctx.store.lock:
            db = self.ctx.store.db
            row = db.execute(
                "SELECT live_transcript, live_model, stt_mode, stt_language, stt_prompt FROM settings WHERE id = 1"
            ).fetchone()
            config = reads.provider_config(db, "cloud_stt")
        return (tuple(row) if row is not None else ()), config


def _unusable() -> AppError:
    return AppError(
        "cloud_stt",
        "The provider returned an unreadable transcription response. The previous transcript is unchanged.",
    )


def _text_of(body: bytes) -> str:
    try:
        payload = json.loads(body)
    except ValueError:
        raise _unusable() from None
    if not isinstance(payload, dict) or not isinstance(payload.get("text"), str):
        raise _unusable()
    return payload["text"].strip()


def _wav_bytes(samples16k: np.ndarray) -> bytes:
    """A 16-bit mono 16 kHz WAV of one utterance, in memory, never on disk."""
    mono = np.ascontiguousarray(samples16k, dtype=np.float32).reshape(-1)
    pcm = np.round(np.clip(mono, -1.0, 1.0) * 32767.0).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(live.TARGET_RATE)
        out.writeframes(pcm.tobytes())
    return buffer.getvalue()


def _wants_cloud(settings: dict[str, Any]) -> bool:
    """Only an explicit Cloud connection choice uploads audio; Same as Transcription never does."""
    return settings.get("live_model") == "cloud"


def _valid_model(ctx: Context, model: str) -> bool:
    """A saved id must be a listed choice, or a streaming id of a known shape."""
    if model == "" or model == "cloud":
        return True
    if any(row["id"] == model for row in ctx.live.models()["models"]):
        return True
    if streaming_models.custom_name(model) is not None:
        return True
    return model.startswith(streaming_models.STREAM_PREFIX) and len(model) > len(streaming_models.STREAM_PREFIX)


# ---- command handlers ----------------------------------------------------------------


def live_transcript(ctx: Context, meeting_id: Any) -> dict[str, Any]:
    meeting_id = text_arg(meeting_id, "meeting_id")
    with ctx.store.lock:
        reads.require_meeting(ctx.store.db, meeting_id)
    return ctx.live.transcript(meeting_id)


def save_live_settings(ctx: Context, model: Any) -> dict[str, Any]:
    """The live engine choice. The live transcript itself is always on (migration 037); only the model is saved."""
    model = text_arg(model, "model")
    if not _valid_model(ctx, model):
        raise AppError("live_model", MODEL_CHOICE)
    with ctx.store.lock:
        db = ctx.store.db
        db.execute("UPDATE settings SET live_model = ?1 WHERE id = 1", (model,))
        return reads.read_settings(db)


def live_models(ctx: Context) -> dict[str, Any]:
    return ctx.live.models()


def live_model_install(ctx: Context, model_id: Any) -> dict[str, Any]:
    return ctx.live.install(text_arg(model_id, "model_id"))


def live_model_cancel(ctx: Context) -> dict[str, Any]:
    return ctx.live.cancel_install()
