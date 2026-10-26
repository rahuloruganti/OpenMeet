"""Dispatch rules: 501 for unbuilt features, startup values, auth, schema, and full API coverage."""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from conftest import TOKEN, invoke, invoke_error
from openmeet_py import paths
from openmeet_py.api.commands import COMMANDS, NOT_AVAILABLE
from openmeet_py.infra.store import Store
from openmeet_py.platform import detection

REPO = Path(__file__).resolve().parents[2]
API_TS = REPO / "src" / "shared" / "api" / "api.ts"
MIGRATIONS = Path(__file__).resolve().parents[1] / "openmeet_py" / "migrations"


def test_no_command_answers_501_after_phase_five() -> None:
    # Every command the UI invokes is implemented. The tray is deferred and has no command.
    assert NOT_AVAILABLE == {}


def test_a_phase_five_command_with_wrong_arguments_is_invalid_args_not_501(client: TestClient) -> None:
    status, body = invoke_error(client, "save_settings", shortcuts={})
    assert (status, body["code"]) == (400, "invalid_args")
    status, body = invoke_error(client, "request_attention", unexpected=1)
    assert (status, body["code"]) == (400, "invalid_args")


def test_every_command_the_ui_invokes_is_implemented_or_explicitly_unavailable() -> None:
    names = set(re.findall(r'invoke(?:<[^>]*>)?\(\s*"([a-z_]+)"', API_TS.read_text(encoding="utf-8")))
    assert len(names) >= 78, f"expected the UI's full command set, found {len(names)}"
    unrouted = sorted(name for name in names if name not in COMMANDS and name not in NOT_AVAILABLE)
    assert unrouted == []


def test_save_auto_capture_is_registered_and_bound_by_the_ui() -> None:
    assert "save_auto_capture" in COMMANDS
    assert 'invoke<Settings>("save_auto_capture", { enabled })' in API_TS.read_text(encoding="utf-8")


def test_unknown_command_is_404(client: TestClient) -> None:
    status, body = invoke_error(client, "no_such_command")
    assert (status, body["code"]) == (404, "unknown_command")


def test_wrong_arguments_are_invalid_args_not_a_crash(client: TestClient) -> None:
    status, body = invoke_error(client, "create_note")
    assert (status, body["code"]) == (400, "invalid_args")
    status, body = invoke_error(client, "create_note", title=5)
    assert (status, body["code"]) == (400, "invalid_args")


def test_startup_commands_return_harmless_idle_values(client: TestClient) -> None:
    state = invoke(client, "get_recording_state")
    assert state["status"] == "idle" and state["meeting_id"] is None
    assert invoke(client, "get_startup_warning") is None
    # The test client runs the fake backend: synthetic devices only, no hardware.
    devices = invoke(client, "list_audio_devices")
    assert devices["capture_supported"] is True
    assert [d["id"] for d in devices["microphones"]] == ["fake-mic"]
    assert [d["id"] for d in devices["outputs"]] == ["fake-output"]
    assert invoke(client, "provider_key_status", role="llm") == "missing"
    speech = invoke(client, "stt_status")
    # Nothing is downloaded at startup: the catalog is listed, nothing is installed.
    assert speech["installed"] is False and speech["model"] is False and speech["vad"] is False
    assert len(speech["models"]) == 36
    assert not any(model["installed"] for model in speech["models"])
    # Supported on Windows (the consent store) or with the fake for the browser check; never on other platforms.
    assert invoke(client, "detection_supported") is detection.supported()
    status, body = invoke_error(client, "get_session_processing", id="x")
    assert (status, body["code"]) == (400, "not_found")
    assert invoke(client, "list_summaries", id="x") == []
    assert invoke(client, "list_library_answers") == []
    assert invoke(client, "audio_usage") == 0
    settings = invoke(client, "get_settings")
    assert settings["stt_mode"] == "local"
    assert settings["setup_done"] is False
    assert settings["export"]["transcript"] is True
    # UI preferences start at the migration's defaults.
    assert settings["theme"] == "system"
    assert settings["inspector_open"] is True


def test_save_ui_prefs_stores_the_theme_and_the_inspector_state(client: TestClient) -> None:
    settings = invoke(client, "save_ui_prefs", theme="light", inspectorOpen=False)
    assert (settings["theme"], settings["inspector_open"]) == ("light", False)
    # The full settings dict comes back, the same shape as the other save_* commands.
    assert settings["stt_mode"] == "local" and "export" in settings
    again = invoke(client, "get_settings")
    assert (again["theme"], again["inspector_open"]) == ("light", False)
    db = client.app.state.ctx.store.db  # type: ignore[attr-defined]
    row = db.execute("SELECT theme, inspector_open FROM settings WHERE id = 1").fetchone()
    assert row == ("light", 0)

    back = invoke(client, "save_ui_prefs", theme="system", inspectorOpen=True)
    assert (back["theme"], back["inspector_open"]) == ("system", True)


def test_data_folder_names_the_folder_this_build_uses(client: TestClient) -> None:
    folder = Path(invoke(client, "data_folder")["path"])
    store = client.app.state.ctx.store  # type: ignore[attr-defined]
    # The real folder, not a guess: it is the open store's own folder.
    assert folder == store.data_dir
    assert folder.is_dir()
    # The test client runs on a temp folder, never the shipped default.
    assert folder != paths.default_data_dir()


def test_save_ui_prefs_rejects_an_unknown_theme_and_a_non_bool(client: TestClient) -> None:
    status, body = invoke_error(client, "save_ui_prefs", theme="purple", inspectorOpen=True)
    assert (status, body["code"]) == (400, "invalid_args")
    assert body["message"] == "Choose System, Dark or Light."
    status, body = invoke_error(client, "save_ui_prefs", theme="dark", inspectorOpen="yes")
    assert (status, body["code"]) == (400, "invalid_args")
    # A refused save changed nothing.
    settings = invoke(client, "get_settings")
    assert (settings["theme"], settings["inspector_open"]) == ("system", True)


def test_requests_without_the_token_or_a_local_host_are_refused(client: TestClient) -> None:
    response = client.post("/api/invoke/list_meetings", json={})
    assert response.status_code == 401
    response = client.post(
        "/api/invoke/list_meetings", json={}, headers={"x-openmeet-token": "wrong"}
    )
    assert response.status_code == 401
    response = client.post(
        "/api/invoke/list_meetings",
        json={},
        headers={"x-openmeet-token": TOKEN, "host": "evil.example:80"},
    )
    assert response.status_code == 400


def test_bad_json_body_is_a_400(client: TestClient) -> None:
    response = client.post(
        "/api/invoke/list_meetings",
        content=b"not json",
        headers={"x-openmeet-token": TOKEN, "content-type": "application/json"},
    )
    assert response.status_code == 400
    assert response.json()["code"] == "invalid_args"


def test_health_needs_no_token(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_schema_matches_the_migration_files(client: TestClient) -> None:
    db = client.app.state.ctx.store.db  # type: ignore[attr-defined]
    assert db.execute("PRAGMA user_version").fetchone()[0] == 33
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"meetings", "notes", "search", "meeting_tags", "settings"} <= tables


def test_a_populated_v29_database_upgrades_and_keeps_its_rows(tmp_path: Path) -> None:
    """Migration 030 only adds two columns: notes, the meeting and its foreign keys must survive."""
    data = tmp_path / "upgrade"
    data.mkdir()
    db = sqlite3.connect(data / "meetings.db")
    for path in sorted(MIGRATIONS.glob("*.sql"), key=lambda item: int(item.name.split("_")[0])):
        number = int(path.name.split("_")[0])
        if number > 29:
            break
        db.execute("PRAGMA foreign_keys = OFF" if number in (2, 6) else "PRAGMA foreign_keys = ON")
        db.executescript(path.read_text(encoding="utf-8"))
    db.execute(
        "INSERT INTO meetings(id, title, started_at, source, status) "
        "VALUES ('33333333-3333-3333-3333-333333333333', 'Fictional old meeting', "
        "'2024-01-01T00:00:00Z', 'desktop', 'stopped')"
    )
    db.execute(
        "INSERT INTO notes(meeting_id, user_markdown) "
        "VALUES ('33333333-3333-3333-3333-333333333333', '- Fictional note')"
    )
    db.commit()
    db.close()

    store = Store(data)
    try:
        assert store.db.execute("PRAGMA user_version").fetchone()[0] == 33
        assert store.db.execute("SELECT user_markdown FROM notes").fetchone()[0] == "- Fictional note"
        assert store.db.execute("SELECT COUNT(*) FROM meetings").fetchone()[0] == 1
        assert store.db.execute("PRAGMA foreign_key_check").fetchall() == []
        assert store.db.execute("SELECT theme, inspector_open FROM settings WHERE id = 1").fetchone() == (
            "system",
            1,
        )
    finally:
        store.close()


def test_files_route_never_serves_the_database(client: TestClient, tmp_path: Path) -> None:
    db_path = client.app.state.ctx.store.data_dir / "meetings.db"  # type: ignore[attr-defined]
    response = client.get(
        "/files", params={"path": str(db_path), "token": TOKEN}, headers={"host": "127.0.0.1"}
    )
    assert response.status_code == 403
    response = client.get("/files", params={"path": str(tmp_path / "missing.wav"), "token": TOKEN})
    assert response.status_code in (403, 404)
    response = client.get("/files", params={"path": str(db_path)})
    assert response.status_code == 401
