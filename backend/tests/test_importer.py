"""Importing a folder from the previous OpenMeet app. Synthetic data only, never the real folder."""

from __future__ import annotations

import hashlib
import os
import sqlite3
from pathlib import Path

import pytest

from openmeet_py.app import main
from openmeet_py.infra import importer
from openmeet_py.infra.importer import ImportFailed, ImportRefused, import_old_data
from openmeet_py.infra.store import Store

MIGRATIONS = Path(__file__).resolve().parents[1] / "openmeet_py" / "migrations"
MEETING = "11111111-1111-1111-1111-111111111111"
LATEST = 30
THROUGH = 27


def _apply_migrations(db: sqlite3.Connection, through: int = THROUGH) -> None:
    for path in sorted(MIGRATIONS.glob("*.sql"), key=lambda item: int(item.name.split("_")[0])):
        number = int(path.name.split("_")[0])
        if number > through:
            break
        db.execute("PRAGMA foreign_keys = OFF" if number in (2, 6) else "PRAGMA foreign_keys = ON")
        db.executescript(path.read_text(encoding="utf-8"))


def _fill(db: sqlite3.Connection, source: Path, relative_system: bool) -> None:
    folder = source / "audio" / MEETING
    system_path = (
        f"audio/{MEETING}/system.wav"
        if relative_system
        else str(folder / "system.wav")
    )
    db.execute(
        "INSERT INTO meetings(id, title, started_at, ended_at, source, status) "
        "VALUES (?1, 'Fictional planning call', '2024-01-01T00:00:00Z', "
        "'2024-01-01T00:01:00Z', 'desktop', 'stopped')",
        (MEETING,),
    )
    db.execute("INSERT INTO notes(meeting_id, user_markdown) VALUES (?1, '')", (MEETING,))
    db.execute(
        "INSERT INTO segments(meeting_id, speaker, start_ms, end_ms, text, source, pass) "
        "VALUES (?1, 'You', 0, 1000, 'Fictional words', 'whisper', 'final')",
        (MEETING,),
    )
    db.execute(
        "INSERT INTO tracks(meeting_id, kind, path, timing_path, device_name, sample_rate, "
        "channels, frames, finalized) VALUES (?1, 'mic', ?2, ?3, 'Fictional device', 48000, 2, 64, 1)",
        (MEETING, str(folder / "mic.wav"), str(folder / "mic.timing.jsonl")),
    )
    db.execute(
        "INSERT INTO tracks(meeting_id, kind, path, timing_path, device_name, sample_rate, "
        "channels, frames, finalized) VALUES (?1, 'system', ?2, ?3, 'Fictional device', 48000, 2, 32, 1)",
        (MEETING, system_path, str(folder / "mic.timing.jsonl")),
    )


def build_old_folder(
    tmp_path: Path, *, through: int = THROUGH, relative_system: bool = False
) -> Path:
    source = tmp_path / "old"
    source.mkdir()
    folder = source / "audio" / MEETING
    folder.mkdir(parents=True)
    (folder / "mic.wav").write_bytes(b"RIFFmic" + bytes(range(64)))
    (folder / "system.wav").write_bytes(b"RIFFsystem" + bytes(range(32)))
    (folder / "mic.timing.jsonl").write_bytes(b'{"t": 0}\n')
    (source / "stt").mkdir()  # a large model folder that must not be copied
    db = sqlite3.connect(source / "meetings.db")
    db.execute("PRAGMA journal_mode = WAL")
    _apply_migrations(db, through)
    _fill(db, source, relative_system)
    db.execute("ALTER TABLE settings ADD COLUMN openai_api_key TEXT")
    db.execute("UPDATE settings SET openai_api_key = 'sk-fictional' WHERE id = 1")
    db.commit()
    db.close()
    return source


def snapshot(folder: Path) -> dict[str, tuple[str, int]]:
    return {
        path.relative_to(folder).as_posix(): (
            hashlib.sha256(path.read_bytes()).hexdigest(),
            path.stat().st_mtime_ns,
        )
        for path in folder.rglob("*")
        if path.is_file()
    }


def test_import_copies_meetings_audio_and_applies_migrations(tmp_path: Path) -> None:
    source = build_old_folder(tmp_path)
    dest = tmp_path / "data"
    report = import_old_data(source, dest)

    assert report.meetings == 1
    assert report.transcript_lines == 1
    assert report.audio_files == 3
    assert report.audio_bytes == sum(
        (source / "audio" / MEETING / name).stat().st_size
        for name in ("mic.wav", "system.wav", "mic.timing.jsonl")
    )
    assert report.db_version_before == THROUGH
    assert report.migrations_applied == LATEST - THROUGH
    assert "secrets blanked: 1" in report.skipped
    assert "models not copied" in report.skipped

    for name in ("mic.wav", "system.wav", "mic.timing.jsonl"):
        copied = dest / "audio" / MEETING / name
        original = source / "audio" / MEETING / name
        assert copied.read_bytes() == original.read_bytes()

    store = Store(dest)
    try:
        assert store.db.execute("PRAGMA user_version").fetchone()[0] == LATEST
        assert store.db.execute("SELECT COUNT(*) FROM meetings").fetchone()[0] == 1
        assert store.db.execute("SELECT COUNT(*) FROM segments").fetchone()[0] == 1
        assert store.db.execute("SELECT openai_api_key FROM settings").fetchone()[0] == ""
    finally:
        store.close()
    assert not (dest / "stt").exists()
    assert list(dest.glob(f"{importer.STAGING_PREFIX}*")) == []


def test_source_folder_is_never_written(tmp_path: Path) -> None:
    source = build_old_folder(tmp_path)
    before = snapshot(source)
    import_old_data(source, tmp_path / "data")
    assert snapshot(source) == before


def test_refuses_a_destination_that_already_has_a_meeting(tmp_path: Path) -> None:
    source = build_old_folder(tmp_path)
    dest = tmp_path / "data"
    dest.mkdir()
    db = sqlite3.connect(dest / "meetings.db")
    db.execute("CREATE TABLE meetings (id TEXT PRIMARY KEY)")
    db.execute("INSERT INTO meetings(id) VALUES ('existing')")
    db.commit()
    db.close()

    with pytest.raises(ImportRefused, match="already has OpenMeet data"):
        import_old_data(source, dest)


def test_refuses_a_destination_that_already_has_audio(tmp_path: Path) -> None:
    source = build_old_folder(tmp_path)
    dest = tmp_path / "data"
    (dest / "audio").mkdir(parents=True)
    (dest / "audio" / "existing.wav").write_bytes(b"RIFF")

    with pytest.raises(ImportRefused, match="already has OpenMeet data"):
        import_old_data(source, dest)


def test_refuses_a_database_newer_than_this_app(tmp_path: Path) -> None:
    source = build_old_folder(tmp_path)
    db = sqlite3.connect(source / "meetings.db")
    db.execute(f"PRAGMA user_version = {LATEST + 1}")
    db.commit()
    db.close()

    with pytest.raises(ImportRefused, match="newer than this app supports"):
        import_old_data(source, tmp_path / "data")


def test_refuses_a_source_without_a_database(tmp_path: Path) -> None:
    source = tmp_path / "old"
    source.mkdir()
    with pytest.raises(ImportRefused, match="has no meetings.db"):
        import_old_data(source, tmp_path / "data")


def test_audio_copy_failure_leaves_destination_untouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = build_old_folder(tmp_path)
    dest = tmp_path / "data"

    def explode(*_args: object, **_kwargs: object) -> None:
        raise ImportFailed("injected audio copy failure")

    monkeypatch.setattr(importer, "_copy_audio_tree", explode)
    with pytest.raises(ImportFailed, match="injected audio copy failure"):
        import_old_data(source, dest)

    assert not (dest / "meetings.db").exists()
    assert not (dest / "audio").exists()
    assert list(dest.glob(f"{importer.STAGING_PREFIX}*")) == []
    # The source tree is still intact after the failed attempt.
    assert (source / "meetings.db").is_file()
    assert (source / "audio" / MEETING / "mic.wav").is_file()


def test_a_replaced_empty_database_is_kept_in_a_backup_folder(tmp_path: Path) -> None:
    source = build_old_folder(tmp_path)
    dest = tmp_path / "data"
    dest.mkdir()
    # A used destination with no meetings: settings only. It must not vanish with the import.
    previous = sqlite3.connect(dest / "meetings.db")
    previous.execute("CREATE TABLE settings (id INTEGER PRIMARY KEY, vault_folder TEXT)")
    previous.execute("INSERT INTO settings(id, vault_folder) VALUES (1, 'C:/Fictional/Notes')")
    previous.commit()
    previous.close()
    before = (dest / "meetings.db").read_bytes()

    report = import_old_data(source, dest)

    backups = sorted((dest / importer.BACKUP_DIR).iterdir())
    assert len(backups) == 1
    saved = backups[0] / "meetings.db"
    assert saved.is_file()
    assert saved.read_bytes() == before
    assert f"previous database kept in {importer.BACKUP_DIR}/{backups[0].name}" in report.skipped
    # The imported database is the one in place, and the old one is still readable as a database.
    check = sqlite3.connect(dest / "meetings.db")
    try:
        assert check.execute("SELECT COUNT(*) FROM meetings").fetchone()[0] == 1
    finally:
        check.close()
    old = sqlite3.connect(saved)
    try:
        assert old.execute("SELECT vault_folder FROM settings").fetchone()[0] == "C:/Fictional/Notes"
    finally:
        old.close()


def test_a_failure_after_the_backup_restores_the_old_database(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = build_old_folder(tmp_path)
    dest = tmp_path / "data"
    dest.mkdir()
    previous = sqlite3.connect(dest / "meetings.db")
    previous.execute("CREATE TABLE settings (id INTEGER PRIMARY KEY, vault_folder TEXT)")
    previous.execute("INSERT INTO settings(id, vault_folder) VALUES (1, 'C:/Fictional/Notes')")
    previous.commit()
    previous.close()
    before = (dest / "meetings.db").read_bytes()

    real_store = importer.Store

    def fail_on_the_destination(path: Path, *args: object, **kwargs: object) -> object:
        # The pre-swap migration check uses a staging copy; only the final destination open fails.
        if Path(path) == dest:
            raise ImportFailed("injected failure after the backup")
        return real_store(path, *args, **kwargs)

    monkeypatch.setattr(importer, "Store", fail_on_the_destination)
    with pytest.raises(ImportFailed, match="injected failure after the backup"):
        import_old_data(source, dest)

    assert (dest / "meetings.db").read_bytes() == before
    assert not (dest / importer.BACKUP_DIR).exists()
    assert not (dest / "audio").exists()
    assert list(dest.glob(f"{importer.STAGING_PREFIX}*")) == []


def test_wal_contents_are_included(tmp_path: Path) -> None:
    source = tmp_path / "old"
    source.mkdir()
    (source / "audio").mkdir()
    db = sqlite3.connect(source / "meetings.db")
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("PRAGMA wal_autocheckpoint = 0")
    _apply_migrations(db)
    _fill(db, source, relative_system=False)
    db.execute(
        "INSERT INTO meetings(id, title, started_at, source, status) "
        "VALUES ('22222222-2222-2222-2222-222222222222', 'Fictional second call', "
        "'2024-01-02T00:00:00Z', 'desktop', 'stopped')"
    )
    db.commit()
    # The connection stays open, so the second row lives only in the WAL when the copy starts.
    try:
        assert Path(str(source / "meetings.db") + "-wal").stat().st_size > 0
        dest = tmp_path / "data"
        report = import_old_data(source, dest)
        assert report.meetings == 2
        check = sqlite3.connect(dest / "meetings.db")
        try:
            assert check.execute("SELECT COUNT(*) FROM meetings").fetchone()[0] == 2
        finally:
            check.close()
    finally:
        db.close()


def test_absolute_and_relative_audio_paths_are_rewritten(tmp_path: Path) -> None:
    source = build_old_folder(tmp_path, relative_system=True)
    dest = tmp_path / "data"
    import_old_data(source, dest)

    check = sqlite3.connect(dest / "meetings.db")
    try:
        rows = check.execute("SELECT kind, path, timing_path FROM tracks ORDER BY kind").fetchall()
    finally:
        check.close()
    paths = {kind: path for kind, path, _timing in rows}
    for kind in ("mic", "system"):
        assert paths[kind].startswith(str(dest / "audio"))
        assert Path(paths[kind]).is_file()
    for _kind, _path, timing in rows:
        assert timing.startswith(str(dest / "audio"))
        assert Path(timing).is_file()


def test_secret_settings_are_blanked_and_reported(tmp_path: Path) -> None:
    source = build_old_folder(tmp_path)
    dest = tmp_path / "data"
    report = import_old_data(source, dest)

    assert "secrets blanked: 1" in report.skipped
    check = sqlite3.connect(dest / "meetings.db")
    try:
        assert check.execute("SELECT openai_api_key FROM settings").fetchone()[0] == ""
    finally:
        check.close()


def test_cli_import_succeeds_and_writes_a_report(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    source = build_old_folder(tmp_path)
    dest = tmp_path / "data"

    assert main(["--import-from", str(source), "--data-dir", str(dest)]) == 0

    captured = capsys.readouterr()
    assert "Import complete." in captured.out
    assert "meetings: 1" in captured.out
    report_file = dest / "import-report.txt"
    assert report_file.is_file()
    text = report_file.read_text(encoding="utf-8")
    assert "meetings: 1" in text and "skipped:" in text


def test_cli_refusal_exits_two_with_a_message(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    source = build_old_folder(tmp_path)
    dest = tmp_path / "data"
    dest.mkdir()
    db = sqlite3.connect(dest / "meetings.db")
    db.execute("CREATE TABLE meetings (id TEXT PRIMARY KEY)")
    db.execute("INSERT INTO meetings(id) VALUES ('existing')")
    db.commit()
    db.close()

    assert main(["--import-from", str(source), "--data-dir", str(dest)]) == 2

    captured = capsys.readouterr()
    assert "Import failed:" in captured.err
    assert "already has OpenMeet data" in captured.err


def test_source_summary_counts_rows_still_in_the_wal_and_leaves_the_source_alone(tmp_path: Path) -> None:
    source = tmp_path / "old"
    source.mkdir()
    db_path = source / "meetings.db"
    writer = sqlite3.connect(db_path)
    try:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("CREATE TABLE meetings (id INTEGER PRIMARY KEY, title TEXT)")
        writer.executemany(
            "INSERT INTO meetings (title) VALUES (?)", [("Fictional A",), ("Fictional B",), ("Fictional C",)]
        )
        writer.commit()
        assert Path(str(db_path) + "-wal").stat().st_size > 0
        before = {p.name: p.read_bytes() for p in source.iterdir() if p.is_file()}

        summary = importer.read_source_summary(source)

        assert summary is not None and summary.meetings == 3
        after = {p.name: p.read_bytes() for p in source.iterdir() if p.is_file()}
        assert after == before
    finally:
        writer.close()
