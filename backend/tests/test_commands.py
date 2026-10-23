"""Dispatch rules: 501 for unbuilt features, startup values, auth, schema, and full API coverage."""

from __future__ import annotations

import re
from pathlib import Path

from fastapi.testclient import TestClient

from conftest import TOKEN, invoke, invoke_error
from openmeet_py.api.commands import COMMANDS, NOT_AVAILABLE
from openmeet_py.platform import detection

REPO = Path(__file__).resolve().parents[2]
API_TS = REPO / "src" / "shared" / "api" / "api.ts"


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
    assert db.execute("PRAGMA user_version").fetchone()[0] == 29
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"meetings", "notes", "search", "meeting_tags", "settings"} <= tables


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
