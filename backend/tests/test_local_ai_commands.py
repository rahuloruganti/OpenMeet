"""Local AI commands end to end through the API, with fakes only.

The pinned catalog is replaced by a tiny stand-in (a 64-byte model and a 1 KiB engine) so a download
is a few bytes over httpx.MockTransport. The engine is never downloaded, no process is ever started
and the GPU is never probed: the supervisor's spawn, health poll and touch generation are fakes.
"""

from __future__ import annotations

import hashlib
import json
import socket
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

import httpx
import pytest
from fastapi.testclient import TestClient

from conftest import MemoryKeyring, invoke, invoke_error, latest_migration
from openmeet_py.api import reads
from openmeet_py.api.errors import AppError
from openmeet_py.infra.store import Store
from openmeet_py.local_ai import catalog, engine, hardware, server, service
from stt_fixtures import add_meeting

PAYLOAD = b"GGUF" + bytes(range(60))
SUMMARY = "## Summary\nFictional notes.\n\n## Key points\n- Budget agreed"
CPU_ONLY = {
    "gpu_name": None,
    "gpu_vendor": None,
    "vram_bytes": None,
    "ram_bytes": 16 * 1024**3,
    "ram_available_bytes": 8 * 1024**3,
    "backend": "cpu",
}
MIGRATIONS = Path(__file__).resolve().parents[1] / "openmeet_py" / "migrations"


def tiny_catalog(sha256: str = "") -> catalog.Catalog:
    """A one-model catalog: one tiny GGUF from Hugging Face, one tiny engine zip from GitHub."""
    engine_file = catalog.EngineFile(
        url="https://github.com/ggml-org/llama.cpp/releases/download/b11671/"
        "llama-b11671-bin-win-cpu-x64.zip",
        size=1024,
        sha256="c" * 64,
    )
    model = catalog.Model(
        id="tiny-model",
        name="Tiny",
        description="A stand-in model.",
        repo="owner/tiny",
        revision="a" * 40,
        file="tiny.gguf",
        size_bytes=len(PAYLOAD),
        sha256=sha256 or hashlib.sha256(PAYLOAD).hexdigest(),
        license="apache-2.0",
        n_layers=4,
        kv_bytes_per_token=1024,
        quality=50,
    )
    return catalog.Catalog(
        context_tokens=16384,
        engine=catalog.Engine(tag="b11671", backends={"cpu": (engine_file,)}),
        models=(model,),
    )


class FakeProcess:
    def __init__(self) -> None:
        self.alive = True
        self.terminated = False
        self.pid = 4242

    def poll(self) -> Any:
        return None if self.alive else 1

    def terminate(self) -> None:
        self.terminated = True
        self.alive = False

    def wait(self, timeout: Any = None) -> int:
        return 1

    def kill(self) -> None:
        self.alive = False


class FakeJob:
    def __init__(self) -> None:
        self.assigned: list[Any] = []
        self.closed = False

    def assign(self, process: Any) -> None:
        self.assigned.append(process)

    def close(self) -> None:
        self.closed = True


@pytest.fixture
def pinned(monkeypatch: pytest.MonkeyPatch) -> catalog.Catalog:
    """The stand-in catalog and a CPU-only machine. No scan, no network, no GPU."""
    pinned_catalog = tiny_catalog()
    monkeypatch.setattr(catalog, "load", lambda: pinned_catalog)
    monkeypatch.setattr(hardware, "detect", lambda: dict(CPU_ONLY))
    monkeypatch.setattr(service, "_local_files", lambda _ctx: [])
    return pinned_catalog


@pytest.fixture
def spawns(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> list[Any]:
    """A fake supervisor: the process exists only in memory and answers health and touch at once."""
    started: list[Any] = []
    executable = tmp_path / "llama-server.exe"
    executable.write_bytes(b"MZ fake engine")

    monkeypatch.setattr(engine, "installed", lambda base, tag, backend: True)
    monkeypatch.setattr(
        engine, "server_executable", lambda base, tag, backend: executable
    )

    def make(_ctx: Any) -> server.Supervisor:
        def spawn(spec: server.Spec) -> FakeProcess:
            process = FakeProcess()
            started.append((spec, process))
            return process

        return server.Supervisor(
            spawn=spawn,
            probe=lambda _spec: True,
            touch=lambda _spec: True,
            job_factory=FakeJob,
            sleep=lambda _seconds: time.sleep(0.01),
            timeout=1.0,
        )

    monkeypatch.setattr(service, "_new_supervisor", make)
    return started


def router(requests: list[httpx.Request]) -> Callable[[httpx.Request], httpx.Response]:
    """Serves the tiny model from Hugging Face and a chat completion from the local server."""

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.host == "huggingface.co":
            return httpx.Response(
                200, content=PAYLOAD, headers={"content-length": str(len(PAYLOAD))}
            )
        if request.url.path.endswith("/chat/completions"):
            return httpx.Response(200, json={"choices": [{"message": {"content": SUMMARY}}]})
        return httpx.Response(404)

    return handle


def use_transport(client: TestClient, requests: list[httpx.Request]) -> None:
    client.app.state.ctx.transport = httpx.MockTransport(router(requests))  # type: ignore[attr-defined]


def record_events(client: TestClient) -> list[tuple[str, Any]]:
    events: list[tuple[str, Any]] = []
    client.app.state.ctx.emit = lambda name, payload: events.append((name, payload))  # type: ignore[attr-defined]
    return events


def models_dir(client: TestClient) -> Path:
    return client.app.state.ctx.store.data_dir / "local-ai" / "models"  # type: ignore[attr-defined]


def download_tiny(client: TestClient) -> str:
    """Downloads the stand-in GGUF through the Hugging Face command; returns the id it is listed under."""
    status = invoke(
        client,
        "local_ai_download_hf",
        repoId="owner/tiny",
        revision="a" * 40,
        filename="tiny.gguf",
        sizeBytes=len(PAYLOAD),
        sha256=hashlib.sha256(PAYLOAD).hexdigest(),
    )
    return str(status["models"][0]["id"])


# ---- status --------------------------------------------------------------------------


def test_status_reports_the_pinned_engine_and_offers_no_catalog_model(
    client: TestClient, pinned: catalog.Catalog
) -> None:
    status = invoke(client, "local_ai_status")
    assert status["hardware"]["backend"] == "cpu"
    assert status["hardware"]["ram_bytes"] == 16 * 1024**3
    assert status["engine_tag"] == "b11671"
    assert status["engine_installed"] is False
    assert status["engine_download_bytes"] == 1024
    assert (status["server"], status["server_error"]) == ("stopped", None)
    assert (status["active_model"], status["in_use"], status["job"]) == (None, False, None)
    assert status["models"] == []


def test_a_gguf_file_on_this_pc_is_listed_and_used_in_place(
    client: TestClient, pinned: catalog.Catalog, spawns: list[Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    local_file = client.app.state.ctx.store.data_dir / "my model.gguf"  # type: ignore[attr-defined]
    local_file.write_bytes(PAYLOAD)
    monkeypatch.setattr(
        service,
        "_local_files",
        lambda _ctx: [{"path": str(local_file), "format": "gguf", "size": len(PAYLOAD)}],
    )
    status = invoke(client, "local_ai_status")
    found = next(item for item in status["models"] if item["source"] == "file")
    assert found["id"] == f"file:{local_file}"
    assert found["name"] == "my model.gguf"
    assert found["license"] is None and found["removable"] is False and found["downloaded"] is True
    assert found["fit"] == "ram" and found["size_bytes"] == len(PAYLOAD)

    settings = invoke(client, "local_ai_use", modelId=found["id"])
    # A provider model id allows no spaces, so a file path is hashed into the alias.
    assert settings["llm"]["model"].startswith("local-file-")
    assert invoke(client, "local_ai_status")["active_model"] == found["id"]
    spec, _process = spawns[-1]
    assert spec.model_path == local_file and spec.model == settings["llm"]["model"]


def test_install_engine_downloads_the_pinned_build(
    client: TestClient, pinned: catalog.Catalog, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[str] = []
    executable = tmp_path / "llama-server.exe"
    executable.write_bytes(b"MZ")
    monkeypatch.setattr(engine, "installed", lambda base, tag, backend: False)

    def install(base: Path, backend: str, pinned_catalog: Any, progress: Any, cancel: Any,
                transport: Any = None, fetch: Any = None) -> Path:
        calls.append(backend)
        progress("download", 1024, 1024)
        progress("verify", 1024, 1024)
        progress("extract", 1024, 1024)
        return executable

    monkeypatch.setattr(engine, "install", install)
    events = record_events(client)

    status = invoke(client, "local_ai_install_engine")

    assert calls == ["cpu"]
    assert status["job"] is None
    assert [payload["phase"] for _, payload in events] == ["download", "verify", "extract"]
    assert {(payload["kind"], payload["target"]) for _, payload in events} == {("engine", "cpu")}


def test_install_engine_does_nothing_when_the_build_is_already_there(
    client: TestClient, pinned: catalog.Catalog, spawns: list[Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        engine,
        "install",
        lambda *args, **kwargs: pytest.fail("an installed engine must not be downloaded again"),
    )
    status = invoke(client, "local_ai_install_engine")
    assert status["engine_installed"] is True
    assert status["engine_download_bytes"] == 0


# ---- downloads -----------------------------------------------------------------------


def test_cancel_sets_the_running_jobs_flag(client: TestClient, pinned: catalog.Catalog) -> None:
    with service._JOB.operation("model", "tiny-model") as cancel:
        assert invoke(client, "local_ai_cancel") is None
        assert cancel.is_set()


# ---- using a model -------------------------------------------------------------------


def test_use_saves_one_connection_assigns_llm_and_starts_the_server(
    client: TestClient, pinned: catalog.Catalog, spawns: list[Any], memory_keyring: MemoryKeyring
) -> None:
    use_transport(client, [])
    model_id = download_tiny(client)

    settings = invoke(client, "local_ai_use", modelId=model_id)

    assert [item["name"] for item in settings["saved_connections"]] == ["Local AI"]
    connection = settings["saved_connections"][0]
    assert connection["base_url"].startswith("http://127.0.0.1:")
    assert connection["base_url"].endswith("/v1")
    assert settings["provider_assignments"]["llm"]["connection_id"] == connection["id"]
    alias = service._alias(model_id)
    assert settings["provider_assignments"]["llm"]["model"] == alias
    assert settings["llm"]["model"] == alias

    status = invoke(client, "local_ai_status")
    assert status["in_use"] is True and status["active_model"] == model_id
    assert status["server"] in ("starting", "running")

    # The key lives in the credential store only; the Settings payload never carries it.
    assert len(memory_keyring.items) == 1
    key = next(iter(memory_keyring.items.values()))
    assert key not in json.dumps(settings)

    spec, _process = spawns[-1]
    assert spec.api_key == key and spec.model == alias
    assert spec.model_path == models_dir(client) / "owner" / "tiny" / "tiny.gguf"
    assert spec.context == 16384 and spec.layers == 0  # no GPU: nothing is offloaded

    again = invoke(client, "local_ai_use", modelId=model_id)
    assert [item["id"] for item in again["saved_connections"]] == [connection["id"]]
    assert len(memory_keyring.items) == 1


def test_a_lost_key_is_stored_again_on_the_next_use(
    client: TestClient, pinned: catalog.Catalog, spawns: list[Any], memory_keyring: MemoryKeyring
) -> None:
    use_transport(client, [])
    model_id = download_tiny(client)
    first = invoke(client, "local_ai_use", modelId=model_id)
    memory_keyring.items.clear()

    second = invoke(client, "local_ai_use", modelId=model_id)

    assert [item["id"] for item in second["saved_connections"]] == [
        item["id"] for item in first["saved_connections"]
    ]
    assert len(memory_keyring.items) == 1
    stored = next(iter(memory_keyring.items.values()))
    assert spawns[-1][0].api_key == stored


def test_use_before_the_model_is_downloaded_is_refused(
    client: TestClient, pinned: catalog.Catalog, spawns: list[Any]
) -> None:
    status, body = invoke_error(client, "local_ai_use", modelId="tiny-model")
    assert (status, body["code"]) == (400, "local_ai_model")
    assert "Download" in body["message"]
    assert spawns == []


def test_start_needs_a_chosen_model(client: TestClient, pinned: catalog.Catalog) -> None:
    status, body = invoke_error(client, "local_ai_start")
    assert (status, body["code"]) == (400, "local_ai_model")


def test_stop_reports_a_stopped_server(client: TestClient, pinned: catalog.Catalog, spawns: list[Any]) -> None:
    use_transport(client, [])
    model_id = download_tiny(client)
    invoke(client, "local_ai_use", modelId=model_id)
    stopped = invoke(client, "local_ai_stop")
    assert stopped["server"] == "stopped"
    assert spawns[-1][1].terminated is True


def test_removing_a_model_is_refused_while_the_server_runs_then_allowed(
    client: TestClient, pinned: catalog.Catalog, spawns: list[Any]
) -> None:
    use_transport(client, [])
    model_id = download_tiny(client)
    invoke(client, "local_ai_use", modelId=model_id)

    status, body = invoke_error(client, "local_ai_remove_model", modelId=model_id)
    assert (status, body["code"]) == (400, "local_ai_active")
    assert body["message"] == "Turn off Local AI first."

    invoke(client, "local_ai_stop")
    after = invoke(client, "local_ai_remove_model", modelId=model_id)
    assert after["models"] == []
    assert after["active_model"] is None
    assert not (models_dir(client) / "owner").exists()


def test_removing_a_local_file_is_refused(client: TestClient, pinned: catalog.Catalog) -> None:
    status, body = invoke_error(client, "local_ai_remove_model", modelId="file:C:/models/a.gguf")
    assert (status, body["code"]) == (400, "local_ai_file")


def test_only_a_gguf_file_can_be_run_by_path(client: TestClient, pinned: catalog.Catalog) -> None:
    notes = client.app.state.ctx.store.data_dir / "notes.txt"  # type: ignore[attr-defined]
    notes.write_bytes(PAYLOAD)
    status, body = invoke_error(client, "local_ai_use", modelId=f"file:{notes}")
    assert (status, body["code"]) == (400, "local_ai_model")


# ---- the local server behind a summary ----------------------------------------------


def prepare_local_model(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> str:
    """Downloads and chooses the model, turns the server off, and leaves a meeting with notes."""
    use_transport(client, [])
    model_id = download_tiny(client)
    invoke(client, "local_ai_use", modelId=model_id)
    invoke(client, "local_ai_stop")
    ctx = client.app.state.ctx  # type: ignore[attr-defined]
    meeting = add_meeting(ctx)
    ctx.store.db.execute(
        "UPDATE notes SET user_markdown = ?1 WHERE meeting_id = ?2",
        ("- Fictional note: the budget is agreed.", meeting),
    )
    return meeting


def test_a_summary_starts_the_local_server_first(
    client: TestClient, pinned: catalog.Catalog, spawns: list[Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    meeting = prepare_local_model(client, monkeypatch)
    requests: list[httpx.Request] = []
    use_transport(client, requests)
    assert invoke(client, "local_ai_status")["server"] == "stopped"

    invoke(client, "generate_summary", id=meeting, template="general-v1")

    assert invoke(client, "local_ai_status")["server"] == "running"
    assert len(spawns) == 2, "the stopped server is started once before the request"
    chat = [request for request in requests if request.url.path.endswith("/chat/completions")]
    assert len(chat) == 1
    assert chat[0].url.path == "/v1/chat/completions"
    assert chat[0].headers["authorization"].startswith("Bearer ")
    detail = invoke(client, "get_meeting", id=meeting)
    assert detail["summary"] == SUMMARY
    assert detail["summary_provider"].startswith("http://127.0.0.1:")


def test_a_local_server_that_cannot_start_fails_with_the_fix(
    client: TestClient,
    pinned: catalog.Catalog,
    spawns: list[Any],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    meeting = prepare_local_model(client, monkeypatch)
    use_transport(client, [])
    executable = tmp_path / "llama-server.exe"
    executable.write_bytes(b"MZ")
    monkeypatch.setattr(engine, "server_executable", lambda base, tag, backend: executable)

    def make(_ctx: Any) -> server.Supervisor:
        def spawn(spec: server.Spec) -> FakeProcess:
            process = FakeProcess()
            process.alive = False
            return process

        return server.Supervisor(
            spawn=spawn,
            probe=lambda _spec: True,
            touch=lambda _spec: True,
            job_factory=FakeJob,
            sleep=lambda _seconds: None,
            timeout=0.0,
        )

    monkeypatch.setattr(service, "_SERVERS", {})  # the run above cached a supervisor; this one is fresh
    monkeypatch.setattr(service, "_new_supervisor", make)
    status, body = invoke_error(client, "generate_summary", id=meeting, template="general-v1")
    assert (status, body["code"]) == (400, "local_ai_server")
    assert "off and on" in body["message"]
    assert invoke(client, "local_ai_status")["server"] == "failed"


# ---- the database row ----------------------------------------------------------------


def test_a_fresh_database_has_one_local_ai_row(client: TestClient) -> None:
    db = client.app.state.ctx.store.db  # type: ignore[attr-defined]
    assert db.execute("PRAGMA user_version").fetchone()[0] == latest_migration()
    assert db.execute(
        "SELECT backend, port, active_model, connection_id FROM local_ai WHERE id = 1"
    ).fetchone() == (None, None, None, None)


def test_a_populated_v30_database_gains_the_row_and_keeps_its_notes(tmp_path: Path) -> None:
    data = tmp_path / "upgrade"
    data.mkdir()
    db = sqlite3.connect(data / "meetings.db")
    for path in sorted(MIGRATIONS.glob("*.sql"), key=lambda item: int(item.name.split("_")[0])):
        number = int(path.name.split("_")[0])
        if number > 30:
            break
        db.execute("PRAGMA foreign_keys = OFF" if number in (2, 6) else "PRAGMA foreign_keys = ON")
        db.executescript(path.read_text(encoding="utf-8"))
    db.execute(
        "INSERT INTO meetings(id, title, started_at, source, status) VALUES ('44444444-4444-4444-4444-444444444444', 'Fictional old meeting', '2024-01-01T00:00:00Z', 'desktop', 'stopped')"
    )
    db.execute(
        "INSERT INTO notes(meeting_id, user_markdown) VALUES ('44444444-4444-4444-4444-444444444444', '- Fictional note')"
    )
    db.commit()
    db.close()

    store = Store(data)
    try:
        assert store.db.execute("PRAGMA user_version").fetchone()[0] == latest_migration()
        assert store.db.execute("SELECT user_markdown FROM notes").fetchone()[0] == "- Fictional note"
        assert store.db.execute("SELECT COUNT(*) FROM local_ai").fetchone()[0] == 1
        assert store.db.execute("SELECT COUNT(*) FROM meetings").fetchone()[0] == 1
        assert store.db.execute("PRAGMA foreign_key_check").fetchall() == []
        # A second Local AI row is refused by the schema itself.
        with pytest.raises(sqlite3.IntegrityError):
            store.db.execute("INSERT INTO local_ai (id) VALUES (2)")
    finally:
        store.close()


# ---- port, destination, key and removed model ----------------------------------------

CLOUD_KEY = "fictional-cloud-key-not-real"
REMOTE = "https://api.example.com/v1"


@contextmanager
def another_program_on(port: int) -> Iterator[None]:
    """Holds a loopback port the way a running llama-server (or any other program) would."""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        listener.bind((server.HOST, port))
        listener.listen()
        yield
    finally:
        listener.close()


def start_local_model(client: TestClient) -> str:
    """Downloads the tiny model and makes it the default; the fake server is running. Returns its id."""
    use_transport(client, [])
    model_id = download_tiny(client)
    invoke(client, "local_ai_use", modelId=model_id)
    return model_id


def saved_port(client: TestClient) -> int:
    db = client.app.state.ctx.store.db  # type: ignore[attr-defined]
    return int(db.execute("SELECT port FROM local_ai WHERE id = 1").fetchone()[0])


def saved_connection(client: TestClient) -> dict[str, Any]:
    db = client.app.state.ctx.store.db  # type: ignore[attr-defined]
    connection_id = db.execute("SELECT connection_id FROM local_ai WHERE id = 1").fetchone()[0]
    found = reads.saved_connection(db, connection_id)
    assert found is not None
    return found


def point_connection_at_remote(client: TestClient, key: str) -> None:
    """The user edits the Local AI connection in Settings to a cloud address with a cloud key."""
    connection = saved_connection(client)
    invoke(
        client,
        "save_api_connection",
        id=connection["id"],
        name="Local AI",
        baseUrl=REMOTE,
        keyChange={"kind": "replace", "key": key},
        expectedRevision=connection["revision"],
    )


def test_start_reuses_the_port_its_own_server_already_holds(
    client: TestClient, pinned: catalog.Catalog, spawns: list[Any]
) -> None:
    start_local_model(client)
    port = saved_port(client)
    spawned = len(spawns)

    with another_program_on(port):  # the running llama-server holds its own port
        status = invoke(client, "local_ai_start")

    assert status["server"] in ("starting", "running")
    assert saved_port(client) == port
    assert saved_connection(client)["base_url"] == server.base_url(port)
    assert len(spawns) == spawned, "a server already on its port is not restarted"


def test_start_on_a_taken_port_moves_the_row_and_the_saved_address_together(
    client: TestClient, pinned: catalog.Catalog, spawns: list[Any], memory_keyring: MemoryKeyring
) -> None:
    start_local_model(client)
    old_port = saved_port(client)
    old_key = spawns[-1][0].api_key
    invoke(client, "local_ai_stop")

    with another_program_on(old_port):  # a different program now owns the saved port
        invoke(client, "local_ai_start")

    port = saved_port(client)
    assert port != old_port
    assert saved_connection(client)["base_url"] == server.base_url(port)
    spec, _process = spawns[-1]
    assert spec.port == port and spec.base_url == saved_connection(client)["base_url"]
    assert spec.api_key != old_key, "a changed destination needs a new key"
    assert spec.api_key == next(iter(memory_keyring.items.values()))


def test_a_local_connection_edited_to_a_remote_address_is_never_started_with_its_key(
    client: TestClient, pinned: catalog.Catalog, spawns: list[Any]
) -> None:
    start_local_model(client)
    invoke(client, "local_ai_stop")
    point_connection_at_remote(client, CLOUD_KEY)
    spawned = len(spawns)

    status, body = invoke_error(client, "local_ai_start")

    assert (status, body["code"]) == (400, "local_ai_connection")
    assert "remote" in body["message"]
    assert len(spawns) == spawned
    assert all(spec.api_key != CLOUD_KEY for spec, _ in spawns)


def test_use_after_a_remote_edit_gives_the_server_a_new_key_not_the_cloud_one(
    client: TestClient, pinned: catalog.Catalog, spawns: list[Any], memory_keyring: MemoryKeyring
) -> None:
    model_id = start_local_model(client)
    point_connection_at_remote(client, CLOUD_KEY)

    invoke(client, "local_ai_use", modelId=model_id)

    spec, _process = spawns[-1]
    assert spec.api_key != CLOUD_KEY
    assert CLOUD_KEY not in memory_keyring.items.values()
    assert spec.api_key == next(iter(memory_keyring.items.values()))
    assert saved_connection(client)["base_url"] == server.base_url(saved_port(client))


def test_a_summary_never_starts_the_server_with_a_remote_connections_key(
    client: TestClient, pinned: catalog.Catalog, spawns: list[Any]
) -> None:
    start_local_model(client)
    invoke(client, "local_ai_stop")
    point_connection_at_remote(client, CLOUD_KEY)
    spawned = len(spawns)

    service.ensure_ready(client.app.state.ctx, {"base_url": REMOTE})  # type: ignore[attr-defined]

    assert len(spawns) == spawned
    assert all(spec.api_key != CLOUD_KEY for spec, _ in spawns)


def test_a_removed_assigned_model_is_reported_before_a_request_reaches_a_dead_server(
    client: TestClient, pinned: catalog.Catalog, spawns: list[Any]
) -> None:
    model_id = start_local_model(client)
    invoke(client, "local_ai_stop")
    invoke(client, "local_ai_remove_model", modelId=model_id)
    spawned = len(spawns)
    config = {"base_url": saved_connection(client)["base_url"]}

    with pytest.raises(AppError) as raised:
        service.ensure_ready(client.app.state.ctx, config)  # type: ignore[attr-defined]

    assert raised.value.code == "local_ai_model"
    assert "removed" in raised.value.message and "Local AI" in raised.value.message
    assert len(spawns) == spawned


def test_an_earlier_catalog_model_is_listed_once_and_becomes_the_active_file(
    client: TestClient, pinned: catalog.Catalog
) -> None:
    folder = models_dir(client)
    folder.mkdir(parents=True)
    (folder / "tiny.gguf").write_bytes(PAYLOAD)
    client.app.state.ctx.store.db.execute(  # type: ignore[attr-defined]
        "UPDATE local_ai SET active_model = 'tiny-model'"
    )
    status = invoke(client, "local_ai_status")
    assert len(status["models"]) == 1
    listed = status["models"][0]
    assert listed["id"] == f"file:{folder / 'tiny.gguf'}"
    assert status["active_model"] == listed["id"]


def test_removing_an_earlier_catalog_model_is_refused_while_the_server_runs(
    client: TestClient, pinned: catalog.Catalog, spawns: list[Any]
) -> None:
    use_transport(client, [])
    folder = models_dir(client)
    folder.mkdir(parents=True)
    (folder / "tiny.gguf").write_bytes(PAYLOAD)

    invoke(client, "local_ai_use", modelId="tiny-model")
    status = invoke(client, "local_ai_status")
    listed_id = status["models"][0]["id"]

    result_status, body = invoke_error(client, "local_ai_remove_model", modelId=listed_id)
    assert (result_status, body["code"]) == (400, "local_ai_active")
    assert body["message"] == "Turn off Local AI first."
