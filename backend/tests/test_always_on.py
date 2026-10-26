"""Always-on defaults (owner decision): meeting detection, automatic processing in its fullest mode,
enhanced notes and the live transcript are no longer Settings switches. Auto capture stays opt-in."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from conftest import TOKEN, invoke, invoke_error
from openmeet_py.api import reads
from openmeet_py.api.server import create_app
from openmeet_py.audio.audio_backend import FakeBackend
from openmeet_py.infra import store as store_module
from openmeet_py.platform import detection
from test_live_wiring import build, start, transcript

ALWAYS_ON = {
    "detection_enabled": True,
    "processing_mode": "final",
    "processing_summary": "general-v1",
    "processing_enhance": True,
    "live_transcript": True,
}


def test_a_fresh_database_starts_with_the_always_on_settings(client: TestClient) -> None:
    settings = invoke(client, "get_settings")
    assert {key: settings[key] for key in ALWAYS_ON} == ALWAYS_ON
    assert settings["auto_capture"] is False  # the one opt-in left in Settings


@pytest.mark.parametrize(
    "before, summary_after",
    [
        (("recording", None), "general-v1"),  # the old default: recording only, no summary
        (("final", "standup-v1"), "standup-v1"),  # a summary the user already chose is kept
    ],
)
def test_migration_037_switches_an_upgraded_database_on_and_keeps_a_chosen_summary(
    tmp_path: Path, before: tuple[str, Any], summary_after: str
) -> None:
    files = store_module._migration_files()
    db = sqlite3.connect(tmp_path / "old.db", isolation_level=None)
    db.execute("PRAGMA foreign_keys = ON")
    for number, path in files.items():
        if number > 36:
            break
        store_module._apply(db, number, path, rebuild=number in store_module.REBUILDS)
    mode, summary = before
    db.execute(
        "UPDATE settings SET detection_enabled = 0, processing_mode = ?1, processing_summary = ?2, "
        "processing_enhance = 0, live_transcript = 0 WHERE id = 1",
        (mode, summary),
    )
    store_module.migrate(db)
    settings = reads.read_settings(db)
    assert {key: settings[key] for key in ALWAYS_ON} == {**ALWAYS_ON, "processing_summary": summary_after}
    assert settings["auto_capture"] is False
    assert db.execute("PRAGMA user_version").fetchone()[0] == max(files) == 37
    db.close()


@pytest.mark.parametrize("cmd, args", [("save_detection", {"enabled": False}), ("save_processing_enhance", {"enabled": False})])
def test_the_always_on_switches_are_no_longer_commands(client: TestClient, cmd: str, args: dict[str, Any]) -> None:
    status, body = invoke_error(client, cmd, **args)
    assert (status, body["code"]) == (404, "unknown_command")


def test_a_fresh_install_with_no_speech_model_shows_one_quiet_live_notice_and_still_records(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The live transcript is on by default, so every recording tries it. With nothing installed the
    # meeting gets one quiet sentence (state off, a notice, no engine), and the recording carries on.
    monkeypatch.delenv("OPENMEET_PY_FAKE_STT", raising=False)
    client = build(tmp_path)
    try:
        assert invoke(client, "get_settings")["live_transcript"] is True
        started = start(client)
        assert started["status"] == "recording"
        data = transcript(client, started["meeting_id"])
        assert data["state"] == "off"
        assert data["notice"]
        assert data["engine"] is None
        invoke(client, "stop_recording")
    finally:
        client.__exit__(None, None, None)


def test_the_detection_thread_starts_with_the_app_and_needs_no_setting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(detection, "supported", lambda: True)
    app = create_app(tmp_path / "data", None, token=TOKEN, backend=FakeBackend(auto_pump=False))
    with TestClient(app, base_url="http://127.0.0.1"):
        service = app.state.ctx.detection
        assert service._thread is not None and service._thread.is_alive()
