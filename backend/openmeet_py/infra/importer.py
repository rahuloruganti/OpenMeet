"""Read-only import of a data folder written by the previous OpenMeet app.

The source folder is only ever read: the database and its WAL siblings are copied into a staging
folder inside the destination, checked there, and only moved into place after the audio tree has
been copied successfully. A failed import removes the staging folder and the files it created, so
the destination is never left half-imported. A destination database that holds no meeting and no
audio is replaced, not refused: it is moved into pre-import-backup/<UTC timestamp>/ first and kept
there, so settings, saved templates and the vault path are never deleted with the staging folder.
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import stat
import sys
import tempfile
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from openmeet_py.infra.store import DB_FILE, Store, _migration_files

AUDIO_DIR = "audio"
STAGING_PREFIX = ".import-staging-"
BACKUP_DIR = "pre-import-backup"
REPORT_FILE = "import-report.txt"
SECRET_WORDS = ("key", "token", "secret", "password")
CHUNK = 1024 * 1024


class ImportProblem(ImportError):
    """Base class for import refusals and failures. The CLI prints its message and exits 2."""


class ImportRefused(ImportProblem):
    """The source or destination cannot be imported safely; nothing was changed."""


class ImportFailed(ImportProblem):
    """The import was attempted but failed; the destination was rolled back."""


@dataclass
class ImportReport:
    """Counts only. No meeting titles, notes or transcript text is ever copied out."""

    meetings: int = 0
    transcript_lines: int = 0
    audio_files: int = 0
    audio_bytes: int = 0
    db_version_before: int = 0
    migrations_applied: int = 0
    skipped: list[str] = field(default_factory=list)

    def as_text(self) -> str:
        version_after = self.db_version_before + self.migrations_applied
        lines = [
            "Import complete.",
            f"meetings: {self.meetings}",
            f"transcript lines: {self.transcript_lines}",
            f"audio files: {self.audio_files}",
            f"audio bytes: {self.audio_bytes}",
            f"database version: {self.db_version_before} -> {version_after}",
            f"migrations applied: {self.migrations_applied}",
        ]
        if self.skipped:
            lines.append("skipped:")
            lines.extend(f"- {item}" for item in self.skipped)
        return "\n".join(lines)


def _latest_version() -> int:
    return max(_migration_files())


def _connect(path: Path, readonly: bool = False, immutable: bool = False) -> sqlite3.Connection:
    mode = "ro" if readonly else "rw"
    query = f"?mode={mode}" + ("&immutable=1" if immutable else "")
    uri = f"file:{path.as_posix()}{query}"
    return sqlite3.connect(uri, uri=True, timeout=5)


def _table_exists(db: sqlite3.Connection, table: str) -> bool:
    row = db.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", (table,)
    ).fetchone()
    return row is not None


def _count(db: sqlite3.Connection, table: str) -> int:
    if not _table_exists(db, table):
        return 0
    return int(db.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])


@dataclass
class SourceSummary:
    """What the old folder holds. Counts only: no title, note or transcript text is read out."""

    meetings: int = 0
    audio_files: int = 0
    audio_bytes: int = 0


def _audio_totals(folder: Path) -> tuple[int, int]:
    """Files and bytes in an audio tree. Read-only: no file, folder or link is created or followed."""
    if not folder.is_dir():
        return 0, 0
    files = 0
    total = 0
    pending = [folder]
    while pending:
        current = pending.pop()
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue
        for entry in entries:
            if _is_link(entry):
                continue
            if entry.is_dir(follow_symlinks=False):
                pending.append(Path(entry.path))
                continue
            if entry.is_file(follow_symlinks=False):
                files += 1
                try:
                    total += entry.stat(follow_symlinks=False).st_size
                except OSError:
                    pass
    return files, total


def read_source_summary(source: Path) -> Optional[SourceSummary]:
    """Read-only counts for an old data folder, or None when its database cannot be read.

    The database and its `-wal`/`-shm` siblings are copied to a temporary folder and counted
    there, so rows still sitting in a leftover WAL are counted the same way the import brings
    them over, and nothing beside the source is created or changed (even a read-only open of the
    source would write read-marks into its `-shm`).
    """
    source = Path(source)
    if not (source / DB_FILE).is_file():
        return None
    with tempfile.TemporaryDirectory(prefix="openmeet-import-peek-") as scratch:
        try:
            _copy_database(source, Path(scratch))
            db = _connect(Path(scratch) / DB_FILE)
        except (OSError, sqlite3.Error):
            return None
        try:
            if not _table_exists(db, "meetings"):
                return None
            summary = SourceSummary(meetings=_count(db, "meetings"))
        except sqlite3.Error:
            return None
        finally:
            db.close()
    summary.audio_files, summary.audio_bytes = _audio_totals(source / AUDIO_DIR)
    return summary


def _destination_has_data(dest_data_dir: Path) -> bool:
    db_path = dest_data_dir / DB_FILE
    if db_path.is_file():
        try:
            db = _connect(db_path, readonly=True)
        except sqlite3.Error as error:
            raise ImportRefused(
                f"The destination database could not be read: {error}. Import into an empty folder."
            ) from error
        try:
            if _table_exists(db, "meetings") and _count(db, "meetings") > 0:
                return True
        finally:
            db.close()
    audio = dest_data_dir / AUDIO_DIR
    if audio.is_dir():
        for _root, _dirs, files in os.walk(audio, followlinks=False):
            if files:
                return True
    return False


def _backup_folder(dest: Path) -> tuple[Path, str]:
    """Creates pre-import-backup/<UTC timestamp>/ and returns it with its report label.

    A used destination is not refused just because it holds no meeting (settings, a saved template or a
    vault folder live elsewhere in the database), so its database is kept here instead of deleted.
    """
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    base = dest / BACKUP_DIR
    name = stamp
    counter = 2
    while (base / name).exists():
        name = f"{stamp}-{counter}"
        counter += 1
    folder = base / name
    folder.mkdir(parents=True)
    return folder, f"{BACKUP_DIR}/{name}"


def _is_link(entry: os.DirEntry[str]) -> bool:
    if entry.is_symlink():
        return True
    try:
        info = entry.stat(follow_symlinks=False)
    except OSError:
        return False
    attributes = getattr(info, "st_file_attributes", 0)
    return bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _copy_database(source: Path, staging: Path) -> None:
    """Copies the database and whichever WAL siblings exist. The source is only read."""
    for suffix in ("", "-wal", "-shm"):
        original = Path(str(source / DB_FILE) + suffix)
        if original.is_file():
            shutil.copy2(original, Path(str(staging / DB_FILE) + suffix))


def _truncate_wal(db: sqlite3.Connection) -> None:
    """Moves committed WAL rows into the main file; a busy checkpoint would lose them."""
    result = db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
    if result and result[0]:
        raise ImportFailed(
            "The database copy is still in use and its WAL could not be checkpointed. "
            "Close OpenMeet and try the import again."
        )


def _checkpoint_and_check(copy_path: Path) -> None:
    db = sqlite3.connect(str(copy_path), timeout=5)
    try:
        _truncate_wal(db)
        rows = [row[0] for row in db.execute("PRAGMA integrity_check").fetchall()]
    finally:
        db.close()
    if rows != ["ok"]:
        raise ImportRefused(
            "The source database failed its integrity check and was not imported: "
            + ", ".join(str(row) for row in rows)
        )


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _looks_secret(name: str) -> bool:
    lowered = name.lower()
    return any(word in lowered for word in SECRET_WORDS)


def _blank_secrets(db: sqlite3.Connection) -> int:
    """Blanks values in settings columns whose names look like credentials. Returns rows changed."""
    if not _table_exists(db, "settings"):
        return 0
    columns = [row[1] for row in db.execute("PRAGMA table_info(settings)").fetchall()]
    changed = 0
    for column in columns:
        if not _looks_secret(column):
            continue
        changed += db.execute(
            f"UPDATE settings SET {_quote(column)} = '' "
            f"WHERE {_quote(column)} IS NOT NULL AND {_quote(column)} <> ''"
        ).rowcount
    # A key/value settings table from an older layout stores the name in a column, not a header.
    if "key" in columns and "value" in columns:
        for row in db.execute('SELECT "key" FROM settings').fetchall():
            if row[0] and _looks_secret(str(row[0])):
                changed += db.execute(
                    'UPDATE settings SET "value" = \'\' WHERE "key" = ?1 '
                    'AND "value" IS NOT NULL AND "value" <> \'\'',
                    (row[0],),
                ).rowcount
    return changed


def _case_insensitive_paths() -> bool:
    """True where the filesystem compares names without case: Windows, and macOS (APFS by default)."""
    return sys.platform in ("win32", "darwin")


def _relative_to(path: Path, base: Path) -> Optional[Path]:
    """Case-insensitive relative path on Windows and macOS, exact elsewhere."""
    if not _case_insensitive_paths():
        try:
            return path.relative_to(base)
        except ValueError:
            return None
    # Compared as text: normcase only lowercases on Windows, and Path equality ignores case only
    # there, so both platforms need the same lowered comparison. Lowering keeps the string length.
    left = os.path.normpath(str(path))
    right = os.path.normpath(str(base))
    if left.lower() == right.lower():
        return Path()
    prefix = right.lower() + os.sep
    if left.lower().startswith(prefix):
        return Path(left[len(prefix):])
    try:
        return path.relative_to(base)
    except ValueError:
        return None


def _map_audio_path(value: str, source: Path, dest: Path) -> Optional[str]:
    """Maps a stored audio path into the destination folder, or None when it is not ours."""
    text = str(value)
    if not text:
        return None
    audio_root = source / AUDIO_DIR
    dest_audio = dest / AUDIO_DIR
    candidate = Path(text)
    if candidate.is_absolute():
        for base, target in ((audio_root, dest_audio), (source, dest)):
            relative = _relative_to(candidate, base)
            if relative is not None:
                return str(target / relative)
        return None
    # Relative paths are relative to the audio folder when that file exists there, else to the
    # data folder. Only rewrite a relative path we can find in the source tree.
    for base, target in ((audio_root, dest_audio), (source, dest)):
        if (base / candidate).is_file():
            return str(target / candidate)
    return None


def _rewrite_audio_paths(db: sqlite3.Connection, source: Path, dest: Path) -> int:
    if not _table_exists(db, "tracks"):
        return 0
    changed = 0
    for rowid, path, timing in db.execute(
        'SELECT rowid, "path", "timing_path" FROM tracks'
    ).fetchall():
        updates: dict[str, str] = {}
        for column, value in (("path", path), ("timing_path", timing)):
            if value is None:
                continue
            mapped = _map_audio_path(str(value), source, dest)
            if mapped is not None and mapped != str(value):
                updates[column] = mapped
        if updates:
            assignments = ", ".join(f"{_quote(column)} = ?{index + 2}" for index, column in enumerate(updates))
            db.execute(
                f"UPDATE tracks SET {assignments} WHERE rowid = ?1",
                (rowid, *updates.values()),
            )
            changed += 1
    return changed


def _copy_audio(
    source_audio: Path,
    dest_audio: Path,
    report: ImportReport,
    copied: list[Path],
    created_dirs: list[Path],
) -> None:
    """Streams the audio tree into the destination without overwriting or following links."""
    if not source_audio.is_dir():
        return
    if not dest_audio.exists():
        created_dirs.append(dest_audio)
    dest_audio.mkdir(parents=True, exist_ok=True)
    pending: list[tuple[Path, Path]] = [(source_audio, dest_audio)]
    while pending:
        source_dir, dest_dir = pending.pop()
        for entry in os.scandir(source_dir):
            source_path = Path(entry.path)
            target = dest_dir / entry.name
            relative = source_path.relative_to(source_audio).as_posix()
            if _is_link(entry):
                report.skipped.append(f"skipped link: {AUDIO_DIR}/{relative}")
                continue
            if entry.is_dir(follow_symlinks=False):
                if not target.exists():
                    created_dirs.append(target)
                target.mkdir(exist_ok=True)
                pending.append((source_path, target))
                continue
            if not entry.is_file(follow_symlinks=False):
                report.skipped.append(f"skipped special file: {AUDIO_DIR}/{relative}")
                continue
            if target.exists():
                report.skipped.append(f"skipped existing file: {AUDIO_DIR}/{relative}")
                continue
            size = source_path.stat().st_size
            target.parent.mkdir(parents=True, exist_ok=True)
            try:
                with open(source_path, "rb") as source_handle, open(target, "xb") as dest_handle:
                    shutil.copyfileobj(source_handle, dest_handle, length=CHUNK)
                if target.stat().st_size != size:
                    raise ImportFailed(f"Audio file size changed while copying: {AUDIO_DIR}/{relative}")
            except BaseException:
                try:
                    target.unlink()
                except OSError:
                    pass
                raise
            copied.append(target)
            report.audio_files += 1
            report.audio_bytes += size


def _restore_after_failure(
    dest: Path,
    staging: Path,
    backup: Optional[Path],
    db_placed: bool,
    copied: list[Path],
    created_dirs: list[Path],
) -> None:
    for file in reversed(copied):
        try:
            file.unlink()
        except OSError:
            pass
    for folder in reversed(created_dirs):
        try:
            folder.rmdir()
        except OSError:
            pass
    if db_placed:
        for suffix in ("-wal", "-shm"):
            stale = Path(str(dest / DB_FILE) + suffix)
            try:
                stale.unlink()
            except OSError:
                pass
        try:
            (dest / DB_FILE).unlink()
        except OSError:
            pass
    if backup is not None and backup.is_file():
        # Put the replaced database back; the backup folder was only made for this import.
        for suffix in ("-wal", "-shm"):
            stale = Path(str(dest / DB_FILE) + suffix)
            try:
                stale.unlink()
            except OSError:
                pass
        try:
            os.replace(backup, dest / DB_FILE)
        except OSError:
            pass
        for suffix in ("-wal", "-shm"):
            saved = Path(str(backup) + suffix)
            if saved.is_file():
                try:
                    os.replace(saved, Path(str(dest / DB_FILE) + suffix))
                except OSError:
                    pass
        try:
            # Only an emptied folder is removed: anything that could not be moved back is kept.
            folder = backup.parent
            if not any(folder.iterdir()):
                folder.rmdir()
                if not any(folder.parent.iterdir()):
                    folder.parent.rmdir()
        except OSError:
            pass
    shutil.rmtree(staging, ignore_errors=True)


def import_old_data(
    source: Path,
    dest_data_dir: Path,
    _audio_copy: Optional[Callable[..., None]] = None,
) -> ImportReport:
    """Imports an old data folder into an empty destination. The source is never modified."""
    source = Path(source)
    dest = Path(dest_data_dir)
    if not source.is_dir():
        raise ImportRefused(f"The source folder does not exist: {source}")
    if not (source / DB_FILE).is_file():
        raise ImportRefused(f"The source folder has no {DB_FILE}: {source}")
    if source.resolve() == dest.resolve():
        raise ImportRefused("The source and destination are the same folder.")
    latest = _latest_version()
    dest.mkdir(parents=True, exist_ok=True)
    if _destination_has_data(dest):
        raise ImportRefused(
            "The destination already has OpenMeet data. Import into an empty data folder."
        )

    staging = dest / f"{STAGING_PREFIX}{uuid.uuid4().hex[:12]}"
    staging.mkdir()
    report = ImportReport()
    copied: list[Path] = []
    created_dirs: list[Path] = []
    backup: Optional[Path] = None
    db_placed = False
    audio_copy = _audio_copy or _copy_audio_tree
    try:
        _copy_database(source, staging)
        copy_path = staging / DB_FILE
        _checkpoint_and_check(copy_path)
        # Autocommit: every change below is committed to the copied database immediately.
        db = sqlite3.connect(str(copy_path), timeout=5, isolation_level=None)
        try:
            version = int(db.execute("PRAGMA user_version").fetchone()[0])
            if version > latest:
                raise ImportRefused(
                    f"The source database is version {version}, newer than this app supports "
                    f"({latest}). Update OpenMeet before importing."
                )
            report.db_version_before = version
            blanked = _blank_secrets(db)
            if blanked:
                report.skipped.append(f"secrets blanked: {blanked}")
            report.meetings = _count(db, "meetings")
            report.transcript_lines = _count(db, "segments")
            audio_copy(source / AUDIO_DIR, dest / AUDIO_DIR, report, copied, created_dirs)
            _rewrite_audio_paths(db, source, dest)
            # The copy runs in WAL mode: move committed rows into the main file before unlinking it.
            _truncate_wal(db)
        finally:
            db.close()

        # Prove the migrations run on a throwaway copy first: a migration failure must never be
        # able to touch the destination.
        check_dir = staging / "check"
        check_dir.mkdir()
        shutil.copy2(copy_path, check_dir / DB_FILE)
        try:
            check_store = Store(check_dir)
            try:
                after = int(check_store.db.execute("PRAGMA user_version").fetchone()[0])
            finally:
                check_store.close()
        finally:
            shutil.rmtree(check_dir, ignore_errors=True)
        report.migrations_applied = max(0, after - version)
        for suffix in ("-wal", "-shm"):
            leftover = Path(str(copy_path) + suffix)
            if leftover.exists():
                leftover.unlink()
        if (source / "stt").is_dir():
            report.skipped.append("models not copied")

        existing = dest / DB_FILE
        if existing.exists():
            # Keep the replaced database instead of deleting it with the staging folder. Only done
            # after the audio copy and the migration check succeeded, so a failure above changes
            # nothing here.
            backup_dir, backup_label = _backup_folder(dest)
            backup = backup_dir / DB_FILE
            os.replace(existing, backup)
            for suffix in ("-wal", "-shm"):
                stale = Path(str(existing) + suffix)
                if stale.exists():
                    os.replace(stale, Path(str(backup) + suffix))
            report.skipped.append(f"previous database kept in {backup_label}")
        os.replace(copy_path, dest / DB_FILE)
        db_placed = True

        store = Store(dest)
        try:
            report.meetings = _count(store.db, "meetings")
            report.transcript_lines = _count(store.db, "segments")
            final_version = int(store.db.execute("PRAGMA user_version").fetchone()[0])
        finally:
            store.close()
        if final_version != after:
            raise ImportFailed(
                "The imported database did not reach the expected schema version. "
                "Nothing from this import was kept."
            )
        shutil.rmtree(staging, ignore_errors=True)
        return report
    except BaseException:
        _restore_after_failure(dest, staging, backup, db_placed, copied, created_dirs)
        raise


# The default audio copy, named so tests can inject a failure without touching the source tree.
def _copy_audio_tree(*args: Any, **kwargs: Any) -> None:
    _copy_audio(*args, **kwargs)


__all__ = [
    "ImportFailed",
    "ImportProblem",
    "ImportRefused",
    "ImportReport",
    "REPORT_FILE",
    "SourceSummary",
    "import_old_data",
    "read_source_summary",
]
