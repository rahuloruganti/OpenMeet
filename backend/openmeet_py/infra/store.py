"""SQLite storage for the Python build.

Applies this package's migration files (openmeet_py/migrations) in order and records the version in
PRAGMA user_version. The build keeps its own database file under its own data folder.
"""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from openmeet_py.api.errors import AppError
from openmeet_py.paths import migrations_dir

DEFAULT_PAUSE_SHORTCUT = "Control+Shift+F9"
DEFAULT_STOP_SHORTCUT = "Control+Shift+F10"
# Migrations that rebuild a table other tables reference. They run with foreign keys off and must
# pass foreign_key_check before commit.
REBUILDS = {2, 6}
DB_FILE = "meetings.db"  # in this build's own data folder


def _migration_files() -> dict[int, Path]:
    files: dict[int, Path] = {}
    for path in migrations_dir().glob("*.sql"):
        files[int(path.name.split("_", 1)[0])] = path
    return dict(sorted(files.items()))


@contextmanager
def transaction(db: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """Explicit transaction; the connection runs in autocommit mode."""
    db.execute("BEGIN IMMEDIATE")
    try:
        yield db
        db.execute("COMMIT")
    except BaseException:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise


def _apply(db: sqlite3.Connection, number: int, path: Path, rebuild: bool) -> None:
    sql = path.read_text(encoding="utf-8")
    if rebuild:
        db.execute("PRAGMA foreign_keys = OFF")
    try:
        # One script, one transaction: BEGIN first so a failing statement rolls the whole file back.
        db.executescript("BEGIN;\n" + sql)
        if rebuild:
            broken = db.execute("SELECT COUNT(*) FROM pragma_foreign_key_check").fetchone()[0]
            if broken:
                raise AppError("migration", f"Migration {number} would break existing references.")
        db.execute("COMMIT")
    except BaseException:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise
    if rebuild:
        db.execute("PRAGMA foreign_keys = ON")


def _columns(db: sqlite3.Connection) -> set[tuple[str, str]]:
    return set(
        db.execute(
            "SELECT m.name, p.name FROM sqlite_master m JOIN pragma_table_info(m.name) p "
            "WHERE m.type = 'table'"
        ).fetchall()
    )


def check_schema(db: sqlite3.Connection, files: dict[int, Path]) -> None:
    """Names every table or column a fully migrated database lacks."""
    expected = sqlite3.connect(":memory:")
    for path in files.values():
        expected.executescript(path.read_text(encoding="utf-8"))
    actual = _columns(db)
    tables = {table for table, _ in actual}
    missing: list[str] = []
    for table, column in sorted(_columns(expected) - actual):
        item = f"column {table}.{column}" if table in tables else f"table {table}"
        if item not in missing:
            missing.append(item)
    expected.close()
    if missing:
        raise AppError(
            "schema_inconsistent",
            "The database schema is inconsistent: missing "
            f"{', '.join(missing)}. Saved data was not deleted.",
        )


def migrate(db: sqlite3.Connection) -> None:
    files = _migration_files()
    latest = max(files)
    version = db.execute("PRAGMA user_version").fetchone()[0]
    if version == 0:
        _apply(db, 1, files[1], rebuild=False)
    elif version > latest:
        raise AppError("schema_version", "This database needs a newer OpenMeet version.")
    for number, path in files.items():
        # 001 ran above when the database was new; every later file runs once per version step.
        if number <= max(version, 1):
            continue
        _apply(db, number, path, rebuild=number in REBUILDS)
    if version == 0:
        db.execute(
            "UPDATE settings SET pause_shortcut = ?1, stop_shortcut = ?2 WHERE id = 1",
            (DEFAULT_PAUSE_SHORTCUT, DEFAULT_STOP_SHORTCUT),
        )
    check_schema(db, files)


class Store:
    """One connection guarded by a lock. sqlite3 connections are not thread-safe by default."""

    def __init__(self, data_dir: Path):
        data_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir = data_dir
        self.lock = threading.RLock()
        self.db = self._open()

    def _open(self) -> sqlite3.Connection:
        """Opens, migrates and clears state a previous process cannot still own."""
        db = sqlite3.connect(
            str(self.data_dir / DB_FILE),
            isolation_level=None,  # autocommit; explicit transactions only
            check_same_thread=False,
            timeout=5,
        )
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("PRAGMA journal_mode = WAL")
        migrate(db)
        # A restarted process cannot still own a recording from the previous process.
        db.execute(
            "UPDATE meetings SET status = 'interrupted' WHERE status IN ('recording', 'paused')"
        )
        db.execute(
            "UPDATE processing_runs SET stage='interrupted', error='Processing was interrupted. "
            "Retry when ready.' WHERE stage IN ('live','finalizing_audio','transcribing',"
            "'awaiting_notes','summarizing')"
        )
        db.execute(
            "UPDATE processing_sessions SET state='interrupted', revision=revision+1 "
            "WHERE state='prepared' AND meeting_id IN "
            "(SELECT meeting_id FROM processing_runs WHERE stage='interrupted')"
        )
        return db

    def close(self) -> None:
        with self.lock:
            self.db.close()

    def reopen(self) -> None:
        """Re-opens the database file after it was replaced on disk (the import swaps it).

        The caller holds the lock, so no command can use the closed connection in between; a WAL
        checkpoint on close is what releases the file handle Windows needs for the swap.
        """
        with self.lock:
            self.db = self._open()

