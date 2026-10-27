"""Folders: migration 035 and the folder commands that use it.

Fictional meetings only.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from conftest import invoke, invoke_error, latest_migration
from openmeet_py.infra.store import DB_FILE, Store
from test_ai import note
from test_live_wiring import database_through

MEETING = "77777777-7777-7777-7777-777777777777"


def make_folder(client: TestClient, name: str) -> str:
    rows = invoke(client, "create_folder", name=name)
    return next(row["id"] for row in rows if row["name"] == name)


def folder_named(client: TestClient, name: str) -> dict[str, Any]:
    return next(row for row in invoke(client, "list_folders") if row["name"] == name)


# ---- migration 035 -------------------------------------------------------------------------------


def test_migration_035_upgrades_a_populated_database_with_foreign_keys(tmp_path: Path) -> None:
    data = database_through(tmp_path, 33)
    db = sqlite3.connect(data / DB_FILE)
    db.execute("PRAGMA foreign_keys = ON")
    db.execute(
        "INSERT INTO meetings (id, title, started_at, ended_at, source, status) VALUES "
        "(?1, 'Fictional upgrade', '2026-01-01T09:00:00+00:00', '2026-01-01T09:10:00+00:00', "
        "'desktop', 'stopped')",
        (MEETING,),
    )
    db.execute("INSERT INTO notes (meeting_id, user_markdown) VALUES (?1, 'Fictional notes.')", (MEETING,))
    db.execute("INSERT INTO meeting_tags (meeting_id, tag) VALUES (?1, 'sync')", (MEETING,))
    db.execute(
        "INSERT INTO library_answers (id, question, answer, provider, model) "
        "VALUES (1, 'Fictional?', 'Fictional answer [M1].', 'http://127.0.0.1:1234/v1', 'local')"
    )
    db.execute("INSERT INTO library_answer_meetings (answer_id, position, meeting_id) VALUES (1, 0, ?1)", (MEETING,))
    db.commit()
    db.close()

    store = Store(data)
    try:
        assert store.db.execute("PRAGMA user_version").fetchone()[0] == latest_migration()
        assert latest_migration() >= 35
        assert store.db.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert store.db.execute("SELECT folder_id FROM meetings WHERE id = ?1", (MEETING,)).fetchone()[0] is None
        assert store.db.execute("SELECT user_markdown FROM notes WHERE meeting_id = ?1", (MEETING,)).fetchone()[0] == "Fictional notes."
        assert store.db.execute("SELECT COUNT(*) FROM meeting_tags WHERE meeting_id = ?1", (MEETING,)).fetchone()[0] == 1
        assert store.db.execute("SELECT scope_json FROM library_answers WHERE id = 1").fetchone()[0] is None
        assert store.db.execute("SELECT COUNT(*) FROM pragma_foreign_key_check").fetchone()[0] == 0
        # Folder names are unique ignoring case, and a meeting cannot point at a missing folder.
        store.db.execute("INSERT INTO folders (id, name, created_at) VALUES ('f1', 'Client', '2026-01-01T00:00:00Z')")
        with pytest.raises(sqlite3.IntegrityError):
            store.db.execute("INSERT INTO folders (id, name, created_at) VALUES ('f2', 'client', '2026-01-01T00:00:00Z')")
        with pytest.raises(sqlite3.IntegrityError):
            store.db.execute("UPDATE meetings SET folder_id = 'missing' WHERE id = ?1", (MEETING,))
        store.db.execute("UPDATE meetings SET folder_id = 'f1' WHERE id = ?1", (MEETING,))
        # Deleting the folder keeps the meeting and its notes; only the folder link is cleared.
        store.db.execute("DELETE FROM folders WHERE id = 'f1'")
        assert store.db.execute("SELECT folder_id FROM meetings WHERE id = ?1", (MEETING,)).fetchone()[0] is None
        assert store.db.execute("SELECT COUNT(*) FROM meetings").fetchone()[0] == 1
        assert store.db.execute("SELECT COUNT(*) FROM library_answer_meetings").fetchone()[0] == 1
    finally:
        store.close()


# ---- folder rules --------------------------------------------------------------------------------


def test_folder_names_are_trimmed_bounded_and_unique_ignoring_case(client: TestClient) -> None:
    rows = invoke(client, "create_folder", name="  Client work  ")
    assert [row["name"] for row in rows] == ["Client work"]
    assert rows[0]["meeting_count"] == 0 and rows[0]["position"] == 0
    status, body = invoke_error(client, "create_folder", name="client WORK")
    assert body["code"] == "folder_exists"
    for bad in ["   ", "x" * 61]:
        status, body = invoke_error(client, "create_folder", name=bad)
        assert body["code"] == "folder_name"
    status, body = invoke_error(client, "create_folder", name=5)
    assert body["code"] == "invalid_args"
    assert len(invoke(client, "create_folder", name="x" * 60)) == 2


def test_rename_keeps_the_folder_and_rejects_another_folders_name(client: TestClient) -> None:
    invoke(client, "create_folder", name="Alpha")
    beta = make_folder(client, "Beta")
    renamed = invoke(client, "rename_folder", id=folder_named(client, "Alpha")["id"], name="alpha")
    assert [row["name"] for row in renamed] == ["alpha", "Beta"]
    status, body = invoke_error(client, "rename_folder", id=beta, name="ALPHA")
    assert body["code"] == "folder_exists"
    status, body = invoke_error(client, "rename_folder", id="missing", name="Gamma")
    assert body["code"] == "not_found"


def test_reorder_needs_every_folder_exactly_once(client: TestClient) -> None:
    alpha = make_folder(client, "Alpha")
    beta = make_folder(client, "Beta")
    reordered = invoke(client, "reorder_folders", ids=[beta, alpha])
    assert [(row["name"], row["position"]) for row in reordered] == [("Beta", 0), ("Alpha", 1)]
    status, body = invoke_error(client, "reorder_folders", ids=[alpha])
    assert body["code"] == "folder_order"
    status, body = invoke_error(client, "reorder_folders", ids=[alpha, alpha])
    assert body["code"] == "folder_order"
    assert [row["name"] for row in invoke(client, "list_folders")] == ["Beta", "Alpha"]


def test_moving_counts_the_meeting_and_deleting_the_folder_keeps_it(client: TestClient) -> None:
    meeting = note(client, "Fictional", "Notes.")
    folder = make_folder(client, "Client")
    assert invoke(client, "list_meetings")[0]["folder_id"] is None
    moved = invoke(client, "move_meeting_to_folder", meeting_id=meeting, folder_id=folder)
    assert moved["folder_id"] == folder and moved["id"] == meeting
    assert invoke(client, "list_meetings")[0]["folder_id"] == folder
    assert invoke(client, "get_meeting", id=meeting)["meeting"]["folder_id"] == folder
    assert folder_named(client, "Client")["meeting_count"] == 1
    status, body = invoke_error(client, "move_meeting_to_folder", meeting_id=meeting, folder_id="missing")
    assert body["code"] == "not_found"
    status, body = invoke_error(client, "move_meeting_to_folder", meeting_id="missing", folder_id=folder)
    assert body["code"] == "not_found"
    assert invoke(client, "move_meeting_to_folder", meeting_id=meeting, folder_id=None)["folder_id"] is None
    invoke(client, "move_meeting_to_folder", meeting_id=meeting, folder_id=folder)
    assert [row["name"] for row in invoke(client, "delete_folder", id=folder)] == []
    assert invoke(client, "get_meeting", id=meeting)["meeting"]["folder_id"] is None
    assert invoke(client, "list_meetings")[0]["id"] == meeting


def test_a_folder_with_a_recording_meeting_cannot_be_deleted(client: TestClient) -> None:
    meeting = note(client, "Fictional", "Notes.")
    folder = make_folder(client, "Client")
    invoke(client, "move_meeting_to_folder", meeting_id=meeting, folder_id=folder)
    db = client.app.state.ctx.store.db  # type: ignore[attr-defined]
    db.execute("UPDATE meetings SET status = 'recording' WHERE id = ?1", (meeting,))
    status, body = invoke_error(client, "delete_folder", id=folder)
    assert body["code"] == "folder_recording"
    assert folder_named(client, "Client")["meeting_count"] == 1
    db.execute("UPDATE meetings SET status = 'stopped' WHERE id = ?1", (meeting,))
    assert invoke(client, "delete_folder", id=folder) == []
