"""Live transcript wiring: settings, the recorder hand-off, final-line persistence, model install and events.

Fakes only: FakeEngine (OPENMEET_PY_FAKE_STT=1) produces fictional lines, FakeBackend tones feed the
recorder, and httpx.MockTransport serves the streaming-model archive. Nothing is downloaded from a
network, no device is opened, and no transcript text is asserted in logs (the service never logs it).
"""

from __future__ import annotations

import hashlib
import io
import sqlite3
import tarfile
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from conftest import TOKEN, invoke, invoke_error, latest_migration
from openmeet_py.api import live_commands
from openmeet_py.api.errors import AppError
from openmeet_py.api.server import create_app
from openmeet_py.audio.audio_backend import FakeBackend
from openmeet_py.infra.store import DB_FILE, Store
from openmeet_py.speech import live as live_module
from openmeet_py.speech import stt, streaming_models
from openmeet_py.speech.stt_catalog import Artifact, StreamingModel
from test_safe_archive import build as build_tar

DEVICES = {"microphoneId": "fake-mic", "outputId": "fake-output"}
FRAMES = 4000
MIGRATIONS = Path(__file__).resolve().parents[1] / "openmeet_py" / "migrations"
INCOMPLETE = "Live transcript is incomplete. The final transcript will have everything."
FILES = ("encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt")


def build(tmp_path: Path, workers: bool = False) -> TestClient:
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


def ctx_of(client: TestClient) -> Any:
    return client.app.state.ctx  # type: ignore[attr-defined]


def start(client: TestClient, title: str = "Fictional sync") -> dict:
    return invoke(client, "start_recording", title=title, devices=DEVICES)


def deliver(client: TestClient, frames: int = FRAMES, blocks: int = 1) -> None:
    backend = client.app.state.backend  # type: ignore[attr-defined]
    for _ in range(blocks):
        backend.stream_for("fake-mic").deliver(frames)
        backend.stream_for("fake-output").deliver(frames)


def wait_for(predicate: Callable[[], bool], timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("timed out waiting for live transcript state")
        time.sleep(0.05)


def transcript(client: TestClient, meeting: str) -> dict:
    return invoke(client, "live_transcript", meetingId=meeting)


# ---- migration 032 -----------------------------------------------------------


def database_through(tmp_path: Path, number: int) -> Path:
    """Builds a database at exactly `number` migrations, the way Store migrates file by file."""
    data = tmp_path / "upgrade"
    data.mkdir()
    db = sqlite3.connect(data / DB_FILE)
    db.execute("PRAGMA foreign_keys = ON")
    files = sorted(MIGRATIONS.glob("*.sql"), key=lambda item: int(item.name.split("_", 1)[0]))
    for path in files:
        step = int(path.name.split("_", 1)[0])
        if step > number:
            break
        db.executescript("BEGIN;\n" + path.read_text(encoding="utf-8"))
        db.execute(f"PRAGMA user_version = {step}")
        db.execute("COMMIT")
    db.commit()
    return data


def seed_old_meeting(db: sqlite3.Connection, mode: str) -> str:
    db.execute(
        "INSERT INTO meetings (id, title, started_at, ended_at, source, status) "
        "VALUES ('old-meeting', 'Fictional upgrade', '2026-01-01T09:00:00+00:00', "
        "'2026-01-01T09:10:00+00:00', 'fixture', 'stopped')"
    )
    db.execute(
        "INSERT INTO notes (meeting_id, user_markdown) "
        "VALUES ('old-meeting', 'Fictional notes survive the upgrade.')"
    )
    db.execute("INSERT INTO meeting_tags (meeting_id, tag) VALUES ('old-meeting', 'sync')")
    db.execute("UPDATE settings SET processing_mode = ?1 WHERE id = 1", (mode,))
    db.commit()
    return "old-meeting"


@pytest.mark.parametrize("old, new", [("live", "recording"), ("both", "final")])
def test_migration_032_maps_preview_modes_and_adds_the_live_columns(
    tmp_path: Path, old: str, new: str
) -> None:
    data = database_through(tmp_path, 31)
    db = sqlite3.connect(data / DB_FILE)
    db.execute("PRAGMA foreign_keys = ON")
    seed_old_meeting(db, old)
    db.close()

    store = Store(data)
    try:
        assert store.db.execute("PRAGMA user_version").fetchone()[0] == latest_migration()
        settings = store.db.execute(
            "SELECT processing_mode, live_transcript, live_model FROM settings WHERE id = 1"
        ).fetchone()
        assert tuple(settings) == (new, 1, "")
        assert store.db.execute(
            "SELECT user_markdown FROM notes WHERE meeting_id = 'old-meeting'"
        ).fetchone()[0]
        assert store.db.execute(
            "SELECT COUNT(*) FROM meeting_tags WHERE meeting_id = 'old-meeting'"
        ).fetchone()[0] == 1
        assert store.db.execute("SELECT COUNT(*) FROM pragma_foreign_key_check").fetchone()[0] == 0

        store.db.execute(
            "INSERT INTO live_lines (meeting_id, id, lane, speaker, start_ms, end_ms, text) "
            "VALUES ('old-meeting', 'mic:1', 'mic', 'You', 0, 900, 'Fictional line')"
        )
        store.db.execute("DELETE FROM meetings WHERE id = 'old-meeting'")
        assert store.db.execute("SELECT COUNT(*) FROM live_lines").fetchone()[0] == 0
    finally:
        store.close()


# ---- settings ----------------------------------------------------------------


def test_live_settings_round_trip_and_an_unknown_model_is_refused(client: TestClient) -> None:
    settings = invoke(client, "save_live_settings", enabled=True, model="cloud")
    assert (settings["live_transcript"], settings["live_model"]) == (True, "cloud")
    assert invoke(client, "get_settings")["live_model"] == "cloud"

    status, body = invoke_error(client, "save_live_settings", enabled=True, model="nonsense")
    assert (status, body["code"]) == (400, "live_model")
    assert invoke(client, "get_settings")["live_model"] == "cloud"

    stored = invoke(client, "save_live_settings", enabled=False, model="")
    assert (stored["live_transcript"], stored["live_model"]) == (False, "")


def test_a_legacy_processing_mode_is_mapped_not_refused(client: TestClient) -> None:
    assert invoke(client, "save_processing_default", mode="live", summary=None)["processing_mode"] == "recording"
    both = invoke(client, "save_processing_default", mode="both", summary="general-v1")
    assert (both["processing_mode"], both["processing_summary"]) == ("final", "general-v1")
    status, body = invoke_error(client, "save_processing_default", mode="sometimes", summary=None)
    assert (status, body["code"]) == (400, "processing_default")


def test_a_meeting_that_never_recorded_reads_as_off(client: TestClient) -> None:
    note = invoke(client, "create_note", title="Fictional note")
    data = transcript(client, note)
    assert data == {
        "meeting_id": note,
        "lines": [],
        "partials": [],
        "state": "off",
        "engine": None,
        "leaves_device": False,
        "notice": None,
    }
    status, body = invoke_error(client, "live_transcript", meetingId="missing")
    assert (status, body["code"]) == (400, "not_found")


# ---- the recorder hand-off ---------------------------------------------------


def test_recording_with_live_off_creates_no_session(tmp_path: Path) -> None:
    client = build(tmp_path)
    try:
        invoke(client, "save_live_settings", enabled=False, model="")
        started = start(client)
        meeting = started["meeting_id"]
        assert started["status"] == "recording"
        assert ctx_of(client).recorder.session.live is None
        data = transcript(client, meeting)
        assert (data["state"], data["lines"], data["partials"], data["notice"]) == ("off", [], [], None)
        invoke(client, "stop_recording")
    finally:
        client.__exit__(None, None, None)


def test_a_model_that_cannot_run_leaves_live_off_with_a_notice_and_still_records(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("OPENMEET_PY_FAKE_STT", raising=False)
    client = build(tmp_path)
    try:
        saved = invoke(client, "save_live_settings", enabled=True, model="stream:kroko-en")
        assert saved["live_model"] == "stream:kroko-en"
        started = start(client)
        meeting = started["meeting_id"]
        data = transcript(client, meeting)
        assert data["state"] == "off"
        assert data["notice"]
        assert data["engine"] is None and data["leaves_device"] is False
        assert ctx_of(client).recorder.session.live is None
        # The failure to start live never stops the recording itself.
        deliver(client)
        assert invoke(client, "get_recording_state")["status"] == "recording"
        invoke(client, "stop_recording")
    finally:
        client.__exit__(None, None, None)


def test_a_fake_recording_persists_final_lines_in_time_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENMEET_PY_FAKE_STT", "1")
    client = build(tmp_path)
    try:
        events: list[tuple[str, dict]] = []
        ctx = ctx_of(client)
        ctx.emit = lambda event, payload: events.append((event, payload))
        started = start(client)
        meeting = started["meeting_id"]
        wait_for(lambda: transcript(client, meeting)["state"] == "running")

        deliver(client, blocks=10)
        assert invoke(client, "get_recording_state")["status"] == "recording"
        invoke(client, "stop_recording")

        wait_for(lambda: transcript(client, meeting)["state"] == "stopped")
        wait_for(lambda: len(transcript(client, meeting)["lines"]) >= 2)
        ctx.live.drain()
        data = transcript(client, meeting)

        assert [line["speaker"] for line in data["lines"]] == ["You", "Others"]
        assert [line["lane"] for line in data["lines"]] == ["mic", "system"]
        assert all(line["final"] for line in data["lines"])
        assert data["lines"] == sorted(data["lines"], key=lambda line: (line["start_ms"], line["lane"]))
        assert all(line["text"].startswith("Fictional line") for line in data["lines"])
        assert data["partials"] == []
        assert (data["engine"], data["leaves_device"], data["notice"]) == ("Test speech engine", False, None)

        rows = ctx.store.db.execute(
            "SELECT lane, text FROM live_lines WHERE meeting_id = ?1 ORDER BY start_ms, lane",
            (meeting,),
        ).fetchall()
        assert [row[0] for row in rows] == ["mic", "system"]

        kinds = [event for event, _ in events]
        assert "live_transcript" in kinds and "live_state" in kinds
        states = [payload for event, payload in events if event == "live_state"]
        assert states[0]["state"] == "starting"
        assert any(payload["state"] == "running" for payload in states)
        assert states[-1]["state"] == "stopped"
        assert all(payload["meeting_id"] == meeting for payload in states)
        assert all(payload["engine"] == "Test speech engine" for payload in states[1:])
        lines = [payload for event, payload in events if event == "live_transcript"]
        assert lines and all(set(payload) == {"meeting_id", "line"} for payload in lines)
        assert lines[-1]["line"]["final"] is True
    finally:
        client.__exit__(None, None, None)


def test_the_store_stops_at_the_line_cap_and_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = build(tmp_path)
    try:
        meeting = start(client)["meeting_id"]
        invoke(client, "stop_recording")
        ctx = ctx_of(client)
        monkeypatch.setattr(live_commands, "MAX_LINES", 3)
        for index in range(5):
            ctx.live._on_line(
                meeting,
                {
                    "id": f"mic:{index}",
                    "lane": "mic",
                    "speaker": "You",
                    "start_ms": index * 1000,
                    "end_ms": index * 1000 + 900,
                    "text": "Fictional line",
                    "final": True,
                },
            )
        ctx.live.drain()
        data = transcript(client, meeting)
        assert len(data["lines"]) == 3
        assert data["notice"] == INCOMPLETE
    finally:
        client.__exit__(None, None, None)


def test_the_store_stops_at_the_text_cap_and_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = build(tmp_path)
    try:
        meeting = start(client)["meeting_id"]
        invoke(client, "stop_recording")
        ctx = ctx_of(client)
        monkeypatch.setattr(live_commands, "MAX_TEXT_BYTES", 10)
        for index in range(3):
            ctx.live._on_line(
                meeting,
                {
                    "id": f"mic:{index}",
                    "lane": "mic",
                    "speaker": "You",
                    "start_ms": index * 1000,
                    "end_ms": index * 1000 + 900,
                    "text": "12345",
                    "final": True,
                },
            )
        ctx.live.drain()
        data = transcript(client, meeting)
        assert len(data["lines"]) == 2
        assert data["notice"] == INCOMPLETE
    finally:
        client.__exit__(None, None, None)


class SpySession:
    """Stands in for LiveSession so a test can see exactly when audio is handed over."""

    made: list["SpySession"] = []

    def __init__(
        self,
        meeting_id: str,
        lanes: list[Any],
        resolved: Any,
        on_line: Callable[[dict], None],
        on_state: Callable[[dict], None],
    ) -> None:
        self.meeting_id = meeting_id
        self.lanes = lanes
        self.resolved = resolved
        self.on_line = on_line
        self.on_state = on_state
        self.accepts: list[tuple[Optional[str], int, int]] = []
        self.flushes = 0
        self.stops = 0
        self.cancelled = False
        SpySession.made.append(self)

    def start(self) -> None:
        self.on_state({"state": "running", "engine": self.resolved.label, "leaves_device": False})

    def accept(
        self,
        index: Optional[str],
        data: bytes,
        frames: int,
        start_us: int,
        generation: int,
    ) -> None:
        self.accepts.append((index, generation, frames))

    def flush_all(self) -> None:
        self.flushes += 1

    def stop(self, timeout: float = 10.0) -> None:
        self.stops += 1

    def cancel(self) -> None:
        self.cancelled = True


def test_a_paused_recording_never_hands_audio_to_the_live_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENMEET_PY_FAKE_STT", "1")
    SpySession.made.clear()
    monkeypatch.setattr(live_module, "LiveSession", SpySession)
    client = build(tmp_path)
    try:
        meeting = start(client)["meeting_id"]
        session = ctx_of(client).recorder.session.live
        assert isinstance(session, SpySession) and session.meeting_id == meeting
        deliver(client, blocks=2)
        wait_for(lambda: bool(session.accepts))

        invoke(client, "pause_recording")
        accepted = len(session.accepts)
        deliver(client, blocks=3)
        time.sleep(0.2)
        assert len(session.accepts) == accepted

        invoke(client, "resume_recording")
        deliver(client, blocks=2)
        wait_for(lambda: len(session.accepts) > accepted)
        generations = {generation for _, generation, _ in session.accepts}
        assert 0 in generations and any(generation > 0 for generation in generations)

        invoke(client, "stop_recording")
        wait_for(lambda: session.stops == 1)
    finally:
        client.__exit__(None, None, None)


def test_quitting_cancels_a_running_live_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENMEET_PY_FAKE_STT", "1")
    SpySession.made.clear()
    monkeypatch.setattr(live_module, "LiveSession", SpySession)
    client = build(tmp_path)
    try:
        start(client)
        session = SpySession.made[-1]
        ctx_of(client).live.quit()
        assert session.cancelled is True
    finally:
        client.__exit__(None, None, None)


class FlushSession(SpySession):
    """A session whose stop still has one final line to hand over, as a real decoder does."""

    def stop(self, timeout: float = 10.0) -> None:
        self.stops += 1
        self.on_line(
            {
                "id": "mic:flush",
                "lane": "mic",
                "speaker": "You",
                "start_ms": 0,
                "end_ms": 900,
                "text": "Fictional flushed line",
                "final": True,
            }
        )
        self.on_state({"state": "stopped", "engine": self.resolved.label, "leaves_device": False})


def test_quitting_a_recording_keeps_the_lines_the_finish_thread_flushes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Shutdown stops the recording and joins the drain thread; the finals it hands over are stored."""
    monkeypatch.setenv("OPENMEET_PY_FAKE_STT", "1")
    FlushSession.made.clear()
    monkeypatch.setattr(live_module, "LiveSession", FlushSession)
    client = build(tmp_path)
    meeting = start(client)["meeting_id"]
    assert isinstance(ctx_of(client).recorder.session.live, FlushSession)
    client.__exit__(None, None, None)

    store = Store(tmp_path / "data")
    try:
        rows = store.db.execute(
            "SELECT text FROM live_lines WHERE meeting_id = ?1", (meeting,)
        ).fetchall()
    finally:
        store.close()
    assert [row[0] for row in rows] == ["Fictional flushed line"]


class DrainSession(SpySession):
    """A stop that is still draining when quit arrives: it emits its final only if it was not cancelled."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.incomplete = False
        self.entered = threading.Event()
        self.gate = threading.Event()
        self.cancel_calls = 0

    def stop(self, timeout: float = 10.0) -> None:
        self.stops += 1
        self.entered.set()
        self.gate.wait(5.0)
        if self.cancelled:
            return
        self.on_line(
            {
                "id": "mic:drain",
                "lane": "mic",
                "speaker": "You",
                "start_ms": 0,
                "end_ms": 900,
                "text": "Fictional draining line",
                "final": True,
            }
        )
        self.on_state({"state": "stopped", "engine": self.resolved.label, "leaves_device": False})

    def cancel(self) -> None:
        self.cancel_calls += 1
        super().cancel()


def test_quit_keeps_the_finals_of_a_stop_that_is_already_draining(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENMEET_PY_FAKE_STT", "1")
    DrainSession.made.clear()
    monkeypatch.setattr(live_module, "LiveSession", DrainSession)
    client = build(tmp_path)
    ctx = ctx_of(client)
    try:
        meeting = start(client)["meeting_id"]
        session = ctx.recorder.session.live
        assert isinstance(session, DrainSession)
        invoke(client, "stop_recording")
        assert session.entered.wait(5)  # the drain thread is inside stop(), waiting on its decoder
        threading.Timer(0.2, session.gate.set).start()
        ctx.live.quit()  # shutdown while the stop still drains
        assert session.cancel_calls == 0
        rows = ctx.store.db.execute(
            "SELECT text FROM live_lines WHERE meeting_id = ?1", (meeting,)
        ).fetchall()
        assert [row[0] for row in rows] == ["Fictional draining line"]
    finally:
        client.__exit__(None, None, None)


def test_same_as_transcription_with_cloud_transcription_never_uploads_from_a_recording(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("OPENMEET_PY_FAKE_STT", raising=False)
    client = build(tmp_path)
    try:
        ctx = ctx_of(client)
        with ctx.store.lock:
            ctx.store.db.execute("UPDATE settings SET stt_mode = 'cloud' WHERE id = 1")
        invoke(client, "save_live_settings", enabled=True, model="")
        uploads: list[int] = []
        monkeypatch.setattr(
            live_commands.LiveService, "_cloud_upload", lambda self, settings: uploads.append(1) or None
        )
        meeting = start(client)["meeting_id"]
        data = transcript(client, meeting)
        assert (data["state"], data["engine"], data["leaves_device"]) == ("off", None, False)
        assert "explicit Cloud connection" in data["notice"]
        assert uploads == []
        same = next(row for row in invoke(client, "live_models")["models"] if row["id"] == "")
        assert (same["installed"], same["leaves_device"]) == (False, False)
        invoke(client, "stop_recording")
    finally:
        client.__exit__(None, None, None)


def test_a_saved_cloud_change_stops_the_upload_before_any_request(tmp_path: Path) -> None:
    """The upload closure rechecks the saved settings and connection before each send and before publishing."""
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"text": "hello"})

    client = build(tmp_path)
    try:
        ctx = ctx_of(client)
        ctx.transport = httpx.MockTransport(handler)
        saved = invoke(
            client, "save_api_connection", id=None, name="Local", baseUrl="http://127.0.0.1:1234/v1",
            keyChange={"kind": "remove"}, expectedRevision=None,
        )
        connection_id = saved["saved_connections"][0]["id"]
        invoke(
            client, "save_provider_assignment", role="cloud_stt",
            selection={"kind": "assigned", "connection_id": connection_id, "model": "whisper-1"},
            expectedRevision=None,
        )
        invoke(client, "save_live_settings", enabled=True, model="cloud")
        upload = ctx.live._cloud_upload(invoke(client, "get_settings"))
        assert upload is not None
        assert upload(np.zeros(1600, dtype=np.float32)) == "hello"
        assert len(requests) == 1

        invoke(client, "save_live_settings", enabled=True, model="")  # the saved live choice changed
        with pytest.raises(AppError) as info:
            upload(np.zeros(1600, dtype=np.float32))
        assert info.value.code == "live_model"
        assert len(requests) == 1  # nothing was sent after the change
    finally:
        client.__exit__(None, None, None)


def test_disabling_live_transcript_stops_a_cloud_upload_before_any_request(tmp_path: Path) -> None:
    """Turning Live off, with the cloud model still saved, invalidates the recording's captured cloud config."""
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"text": "hello"})

    client = build(tmp_path)
    try:
        ctx = ctx_of(client)
        ctx.transport = httpx.MockTransport(handler)
        saved = invoke(
            client, "save_api_connection", id=None, name="Local", baseUrl="http://127.0.0.1:1234/v1",
            keyChange={"kind": "remove"}, expectedRevision=None,
        )
        connection_id = saved["saved_connections"][0]["id"]
        invoke(
            client, "save_provider_assignment", role="cloud_stt",
            selection={"kind": "assigned", "connection_id": connection_id, "model": "whisper-1"},
            expectedRevision=None,
        )
        invoke(client, "save_live_settings", enabled=True, model="cloud")
        upload = ctx.live._cloud_upload(invoke(client, "get_settings"))
        assert upload is not None
        assert upload(np.zeros(1600, dtype=np.float32)) == "hello"
        assert len(requests) == 1

        invoke(client, "save_live_settings", enabled=False, model="cloud")  # only the on/off switch changed
        with pytest.raises(AppError) as info:
            upload(np.zeros(1600, dtype=np.float32))
        assert info.value.code == "live_model"
        assert len(requests) == 1  # nothing was sent after Live was turned off
    finally:
        client.__exit__(None, None, None)


# ---- streaming model install -------------------------------------------------


def installable(monkeypatch: pytest.MonkeyPatch, body: bytes) -> StreamingModel:
    model = StreamingModel(
        "stream:test-en",
        "test-en",
        "Streaming Test",
        Artifact(
            "stream-test-en",
            "test-en.tar.bz2",
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/test-en.tar.bz2",
            hashlib.sha256(body).hexdigest(),
            len(body),
        ),
        FILES,
        "transducer",
        ("en",),
        "CC-BY-SA",
    )
    monkeypatch.setattr(streaming_models, "STREAMING_MODELS", (model,))
    monkeypatch.setattr(streaming_models, "engine_available", lambda: True)
    monkeypatch.setattr(streaming_models, "unavailable_reason", lambda: None)
    return model


def archive(tmp_path: Path) -> bytes:
    members = [("test-en/", None, tarfile.DIRTYPE)]
    members += [(f"test-en/{name}", b"fictional-weights", tarfile.REGTYPE) for name in FILES]
    return build_tar(tmp_path / "test-en.tar.bz2", members).read_bytes()


def blocking_transport(
    body: bytes, entered: threading.Event, release: threading.Event
) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        entered.set()
        assert release.wait(10)
        return httpx.Response(200, content=body)

    return httpx.MockTransport(handler)


def test_install_emits_progress_and_refuses_a_second_download(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = archive(tmp_path)
    installable(monkeypatch, body)
    client = build(tmp_path)
    try:
        ctx = ctx_of(client)
        events: list[tuple[str, dict]] = []
        ctx.emit = lambda event, payload: events.append((event, payload))
        entered, release = threading.Event(), threading.Event()
        ctx.transport = blocking_transport(body, entered, release)

        listing = invoke(client, "live_model_install", modelId="stream:test-en")
        assert listing["installing"] == "stream:test-en"
        assert entered.wait(10)

        status, refusal = invoke_error(client, "live_model_install", modelId="stream:test-en")
        assert (status, refusal["code"]) == (400, "live_model")

        release.set()
        wait_for(lambda: any(payload["stage"] == "done" for _, payload in events))
        progress = [payload for event, payload in events if event == "live_model_progress"]
        assert progress[0]["stage"] == "downloading"
        assert progress[-1] == {"model_id": "stream:test-en", "done": len(body), "total": len(body),
                                "stage": "done", "error": None}
        assert all(payload["total"] == len(body) for payload in progress)

        models = invoke(client, "live_models")
        assert models["installing"] is None
        installed = next(model for model in models["models"] if model["id"] == "stream:test-en")
        assert installed["installed"] is True

        status, unknown = invoke_error(client, "live_model_install", modelId="stream:nope")
        assert (status, unknown["code"]) == (400, "live_model")
        status, custom = invoke_error(client, "live_model_install", modelId="stream-dir:mine")
        assert (status, custom["code"]) == (400, "live_model")
    finally:
        client.__exit__(None, None, None)


def test_cancel_stops_a_download_without_installing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = archive(tmp_path)
    installable(monkeypatch, body)
    client = build(tmp_path)
    try:
        ctx = ctx_of(client)
        events: list[tuple[str, dict]] = []
        ctx.emit = lambda event, payload: events.append((event, payload))
        entered, release = threading.Event(), threading.Event()
        ctx.transport = blocking_transport(body, entered, release)

        invoke(client, "live_model_install", modelId="stream:test-en")
        assert entered.wait(10)
        invoke(client, "live_model_cancel")
        release.set()

        wait_for(lambda: any(payload["stage"] == "cancelled" for _, payload in events))
        wait_for(lambda: invoke(client, "live_models")["installing"] is None)
        models = invoke(client, "live_models")
        installed = next(model for model in models["models"] if model["id"] == "stream:test-en")
        assert installed["installed"] is False
        assert not (streaming_models.folder(stt.stt_root(ctx)) / "test-en").exists()
    finally:
        client.__exit__(None, None, None)
