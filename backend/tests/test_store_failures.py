"""Failure paths of the SQLite store: a failing rebuild migration restores foreign keys and open never leaks."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest

from openmeet_py.api.errors import AppError
from openmeet_py.infra import store


def _foreign_keys(db: sqlite3.Connection) -> int:
    return db.execute("PRAGMA foreign_keys").fetchone()[0]


def test_a_failing_rebuild_migration_rolls_back_and_restores_foreign_keys(tmp_path: Path) -> None:
    db = sqlite3.connect(":memory:", isolation_level=None)
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
    bad = tmp_path / "002_bad.sql"
    bad.write_text("CREATE TABLE child (id INTEGER);\nTHIS IS NOT SQL;\n", encoding="utf-8")

    with pytest.raises(sqlite3.Error):
        store._apply(db, 2, bad, rebuild=True)

    assert _foreign_keys(db) == 1
    assert not db.in_transaction
    assert db.execute("SELECT name FROM sqlite_master WHERE name = 'child'").fetchall() == []
    db.close()


def test_a_rebuild_that_breaks_references_restores_foreign_keys(tmp_path: Path) -> None:
    db = sqlite3.connect(":memory:", isolation_level=None)
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
    db.execute("CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))")
    db.execute("PRAGMA foreign_keys = OFF")
    db.execute("INSERT INTO child (id, parent_id) VALUES (1, 99)")  # already dangling
    db.execute("PRAGMA foreign_keys = ON")
    fine = tmp_path / "002_fine.sql"
    fine.write_text("CREATE TABLE extra (id INTEGER);\n", encoding="utf-8")

    with pytest.raises(AppError):
        store._apply(db, 2, fine, rebuild=True)

    assert _foreign_keys(db) == 1
    db.close()


def test_a_failed_open_closes_the_connection(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[sqlite3.Connection] = []
    real_connect = sqlite3.connect

    def recording_connect(*args: Any, **kwargs: Any) -> sqlite3.Connection:
        connection = real_connect(*args, **kwargs)
        opened.append(connection)
        return connection

    def failing_migrate(db: sqlite3.Connection) -> None:
        raise AppError("migration", "forced migration failure")

    monkeypatch.setattr(store.sqlite3, "connect", recording_connect)
    monkeypatch.setattr(store, "migrate", failing_migrate)
    with pytest.raises(AppError):
        store.Store(tmp_path)

    assert len(opened) == 1
    with pytest.raises(sqlite3.ProgrammingError):
        opened[0].execute("SELECT 1")
