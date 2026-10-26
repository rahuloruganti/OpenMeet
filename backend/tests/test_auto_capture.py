"""Automatic capture opt-in: migration 033, the call_sessions table, and save_auto_capture.

Storage and the switch only. Nothing here starts a capture or opens a device; FakeBackend stays idle.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from conftest import invoke, invoke_error, latest_migration
from openmeet_py.infra.store import DB_FILE, Store
from test_live_wiring import database_through

MEETING = "55555555-5555-5555-5555-555555555555"
OTHER = "66666666-6666-6666-6666-666666666666"
STATES = (
    "candidate",
    "recording",
    "paused",
    "end_pending",
    "finalizing",
    "complete",
    "recoverable_error",
    "prompted",
    "cancelled",
)


def seed_pre_033(db: sqlite3.Connection) -> None:
    db.execute("PRAGMA foreign_keys = ON")
    db.execute(
        "INSERT INTO meetings (id, title, started_at, ended_at, source, status) VALUES "
        "(?1, 'Fictional upgrade', '2026-01-01T09:00:00+00:00', '2026-01-01T09:10:00+00:00', "
        "'desktop', 'stopped')",
        (MEETING,),
    )
    db.execute(
        "INSERT INTO notes (meeting_id, user_markdown) VALUES (?1, 'Fictional notes survive the upgrade.')",
        (MEETING,),
    )
    db.execute("INSERT INTO meeting_tags (meeting_id, tag) VALUES (?1, 'sync')", (MEETING,))
    db.execute(
        "INSERT INTO meetings (id, title, started_at, source, status) VALUES "
        "(?1, 'Fictional second meeting', '2026-01-02T09:00:00+00:00', 'desktop', 'stopped')",
        (OTHER,),
    )
    db.commit()


def upgraded(tmp_path: Path) -> Store:
    """A populated database at migration 032, opened by Store so 033 runs exactly as on a user's PC."""
    data = database_through(tmp_path, 32)
    db = sqlite3.connect(data / DB_FILE)
    seed_pre_033(db)
    db.close()
    return Store(data)


def insert_session(
    db: sqlite3.Connection,
    *,
    id: str = "session-1",
    call_key: str = "zoom.exe#1",
    meeting: Any = None,
    state: str = "candidate",
    origin: str = "auto",
    active: int = 0,
) -> None:
    db.execute(
        "INSERT INTO call_sessions (id, call_key, app_id, meeting_id, state, origin, reason, active, "
        "opened_at, updated_at) VALUES (?1, ?2, 'zoom.exe', ?3, ?4, ?5, 'mic_in_use', ?6, 1, 1)",
        (id, call_key, meeting, state, origin, active),
    )


# ---- migration 033 ------------------------------------------------------------------------------


def test_migration_033_upgrades_a_populated_database_and_keeps_its_rows(tmp_path: Path) -> None:
    store = upgraded(tmp_path)
    try:
        assert store.db.execute("PRAGMA user_version").fetchone()[0] == latest_migration()
        assert store.db.execute("SELECT auto_capture FROM settings WHERE id = 1").fetchone()[0] == 0
        assert store.db.execute(
            "SELECT user_markdown FROM notes WHERE meeting_id = ?1", (MEETING,)
        ).fetchone()[0] == "Fictional notes survive the upgrade."
        assert store.db.execute(
            "SELECT COUNT(*) FROM meeting_tags WHERE meeting_id = ?1", (MEETING,)
        ).fetchone()[0] == 1
        assert store.db.execute("SELECT COUNT(*) FROM meetings").fetchone()[0] == 2
        assert store.db.execute("SELECT COUNT(*) FROM pragma_foreign_key_check").fetchone()[0] == 0
        assert store.db.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    finally:
        store.close()


def test_settings_refuses_an_auto_capture_value_other_than_0_or_1(tmp_path: Path) -> None:
    store = upgraded(tmp_path)
    try:
        with pytest.raises(sqlite3.IntegrityError):
            store.db.execute("UPDATE settings SET auto_capture = 2 WHERE id = 1")
        assert store.db.execute("SELECT auto_capture FROM settings WHERE id = 1").fetchone()[0] == 0
    finally:
        store.close()


def test_call_sessions_refuses_an_unknown_state_or_origin(tmp_path: Path) -> None:
    store = upgraded(tmp_path)
    try:
        with pytest.raises(sqlite3.IntegrityError):
            insert_session(store.db, state="bogus")
        with pytest.raises(sqlite3.IntegrityError):
            insert_session(store.db, origin="bogus")
        assert store.db.execute("SELECT COUNT(*) FROM call_sessions").fetchone()[0] == 0
        for number, state in enumerate(STATES):
            insert_session(store.db, id=f"s{number}", call_key=f"k{number}", state=state)
        assert store.db.execute("SELECT COUNT(*) FROM call_sessions").fetchone()[0] == len(STATES)
    finally:
        store.close()


def test_call_sessions_has_a_unique_call_key(tmp_path: Path) -> None:
    store = upgraded(tmp_path)
    try:
        insert_session(store.db, id="s1", call_key="zoom.exe#1")
        with pytest.raises(sqlite3.IntegrityError):
            insert_session(store.db, id="s2", call_key="zoom.exe#1")
    finally:
        store.close()


def test_call_sessions_allows_exactly_one_active_row(tmp_path: Path) -> None:
    store = upgraded(tmp_path)
    try:
        insert_session(store.db, id="s1", call_key="k1", active=1)
        with pytest.raises(sqlite3.IntegrityError):
            insert_session(store.db, id="s2", call_key="k2", active=1)
        insert_session(store.db, id="s3", call_key="k3", active=0)
        with pytest.raises(sqlite3.IntegrityError):
            insert_session(store.db, id="s4", call_key="k4", active=2)
        assert store.db.execute(
            "SELECT COUNT(*) FROM call_sessions WHERE active = 1"
        ).fetchone()[0] == 1

        store.db.execute("UPDATE call_sessions SET active = 0 WHERE id = 's1'")
        insert_session(store.db, id="s2", call_key="k2", active=1)
        assert store.db.execute(
            "SELECT id FROM call_sessions WHERE active = 1"
        ).fetchall() == [("s2",)]
    finally:
        store.close()


def test_call_sessions_links_one_meeting_and_clears_the_link_when_it_is_deleted(
    tmp_path: Path,
) -> None:
    store = upgraded(tmp_path)
    try:
        with pytest.raises(sqlite3.IntegrityError):
            insert_session(store.db, id="s0", call_key="k0", meeting="no-such-meeting")
        insert_session(store.db, id="s1", call_key="k1", meeting=MEETING)
        with pytest.raises(sqlite3.IntegrityError):
            insert_session(store.db, id="s2", call_key="k2", meeting=MEETING)

        store.db.execute("DELETE FROM meetings WHERE id = ?1", (MEETING,))
        assert store.db.execute(
            "SELECT meeting_id FROM call_sessions WHERE id = 's1'"
        ).fetchone() == (None,)
        assert store.db.execute("SELECT COUNT(*) FROM pragma_foreign_key_check").fetchone()[0] == 0
    finally:
        store.close()


# ---- save_auto_capture and read_settings --------------------------------------------------------


def test_auto_capture_is_off_by_default_and_round_trips(client: TestClient) -> None:
    before = invoke(client, "get_settings")
    assert before["auto_capture"] is False

    saved = invoke(client, "save_auto_capture", enabled=True)
    assert saved["auto_capture"] is True
    assert saved["detection_enabled"] is before["detection_enabled"]
    assert invoke(client, "get_settings")["auto_capture"] is True
    db = client.app.state.ctx.store.db  # type: ignore[attr-defined]
    assert db.execute("SELECT auto_capture FROM settings WHERE id = 1").fetchone()[0] == 1

    off = invoke(client, "save_auto_capture", enabled=False)
    assert off["auto_capture"] is False
    assert invoke(client, "get_settings")["auto_capture"] is False


def test_save_auto_capture_refuses_a_non_bool_and_keeps_the_stored_value(client: TestClient) -> None:
    invoke(client, "save_auto_capture", enabled=True)
    for bad in ("yes", 1, None):
        status, body = invoke_error(client, "save_auto_capture", enabled=bad)
        assert (status, body["code"]) == (400, "invalid_args")
    assert invoke(client, "get_settings")["auto_capture"] is True


def test_a_populated_database_reads_auto_capture_as_off_after_upgrade(tmp_path: Path) -> None:
    store = upgraded(tmp_path)
    try:
        from openmeet_py.api.reads import read_settings

        settings = read_settings(store.db)
        assert settings["auto_capture"] is False
        assert settings["detection_enabled"] is False
    finally:
        store.close()
