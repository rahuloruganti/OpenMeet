"""`import_status` and `import_previous` through the command surface.

Synthetic folders only: the old folder is built in a temp directory and resolved through
OPENMEET_OLD_DATA_DIR, so the real %APPDATA%\\dev.openmeet.preview is never read or written.
"""

from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from conftest import invoke, invoke_error
from openmeet_py.api.errors import AppError
from openmeet_py.api.import_commands import (
    REOPEN_FAILED,
    STORE_REOPEN_FAILED,
    import_previous,
)
from openmeet_py.infra.store import Store

MIGRATIONS = Path(__file__).resolve().parents[1] / "openmeet_py" / "migrations"
MEETING = "22222222-2222-2222-2222-222222222222"
THROUGH = 27  # the previous app's schema: importing it has to migrate the copy to LATEST
LATEST = 32
AUDIO_FILES = ("mic.wav", "system.wav", "mic.timing.jsonl")
NO_DATA = "No previous OpenMeet data found."
DESTINATION_USED = "This OpenMeet already has meetings."


def _apply_migrations(db: sqlite3.Connection, through: int = THROUGH) -> None:
    for path in sorted(MIGRATIONS.glob("*.sql"), key=lambda item: int(item.name.split("_")[0])):
        number = int(path.name.split("_")[0])
        if number > through:
            break
        db.execute("PRAGMA foreign_keys = OFF" if number in (2, 6) else "PRAGMA foreign_keys = ON")
        db.executescript(path.read_text(encoding="utf-8"))


def build_old_folder(root: Path) -> Path:
    """The previous app's folder: one meeting, three audio files, a key to blank, a model folder."""
    source = root / "dev.openmeet.preview"
    folder = source / "audio" / MEETING
    folder.mkdir(parents=True)
    (folder / "mic.wav").write_bytes(b"RIFFmic" + bytes(range(64)))
    (folder / "system.wav").write_bytes(b"RIFFsystem" + bytes(range(32)))
    (folder / "mic.timing.jsonl").write_bytes(b'{"t": 0}\n')
    (source / "stt").mkdir()  # a model folder that must not be copied
    db = sqlite3.connect(source / "meetings.db")
    db.execute("PRAGMA journal_mode = WAL")
    _apply_migrations(db)
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
    for kind, name in (("mic", "mic.wav"), ("system", "system.wav")):
        db.execute(
            "INSERT INTO tracks(meeting_id, kind, path, timing_path, device_name, sample_rate, "
            "channels, frames, finalized) VALUES (?1, ?2, ?3, ?4, 'Fictional microphone', "
            "48000, 2, 64, 1)",
            (MEETING, kind, str(folder / name), str(folder / "mic.timing.jsonl")),
        )
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


@pytest.fixture
def old_folder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Points the one helper at a temp old folder for the duration of a test."""
    source = build_old_folder(tmp_path)
    monkeypatch.setenv("OPENMEET_OLD_DATA_DIR", str(source))
    return source


def test_status_reports_the_counts_of_the_old_folder(client: TestClient, old_folder: Path) -> None:
    status = invoke(client, "import_status")
    expected_bytes = sum((old_folder / "audio" / MEETING / name).stat().st_size for name in AUDIO_FILES)
    assert status == {
        "available": True,
        "path": str(old_folder),
        "meetings": 1,
        "audio_files": 3,
        "bytes": expected_bytes,
        "blocked_reason": None,
    }


def test_status_reports_no_previous_data(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENMEET_OLD_DATA_DIR", str(tmp_path / "missing"))
    status = invoke(client, "import_status")
    assert status["available"] is False
    assert status["path"] is None
    assert (status["meetings"], status["audio_files"], status["bytes"]) == (0, 0, 0)
    assert status["blocked_reason"] == NO_DATA


def test_status_reports_a_folder_whose_database_cannot_be_read(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    broken = tmp_path / "broken"
    broken.mkdir()
    (broken / "meetings.db").write_bytes(b"not a database")
    monkeypatch.setenv("OPENMEET_OLD_DATA_DIR", str(broken))
    status = invoke(client, "import_status")
    assert status["available"] is False
    assert status["blocked_reason"] == "The previous database could not be read."


def test_status_is_unavailable_when_this_folder_already_has_meetings(
    client: TestClient, old_folder: Path
) -> None:
    invoke(client, "create_note", title="Fictional local note")
    status = invoke(client, "import_status")
    assert status["available"] is False
    assert status["blocked_reason"] == DESTINATION_USED
    # The counts are still reported: the step explains what is waiting in the old folder.
    assert status["path"] == str(old_folder)
    assert status["meetings"] == 1


def test_import_previous_brings_the_old_library_into_the_live_folder(
    client: TestClient, old_folder: Path
) -> None:
    result = invoke(client, "import_previous")
    assert result["meetings"] == 1
    assert result["transcript_lines"] == 1
    assert result["audio_files"] == 3
    assert "secrets blanked: 1" in result["notes"]
    assert "models not copied" in result["notes"]
    assert any(note.startswith("previous database kept in pre-import-backup/") for note in result["notes"])

    data = client.app.state.ctx.store.data_dir  # type: ignore[attr-defined]
    assert (data / "pre-import-backup").is_dir()
    assert not (data / "stt").exists()
    assert (data / "audio" / MEETING / "mic.wav").read_bytes() == (
        old_folder / "audio" / MEETING / "mic.wav"
    ).read_bytes()

    # The reopened store is the live one: the normal read path works and the schema is migrated.
    meetings = invoke(client, "list_meetings")
    assert [meeting["title"] for meeting in meetings] == ["Fictional planning call"]
    detail = invoke(client, "get_meeting", id=MEETING)
    assert sorted(track["device_name"] for track in detail["tracks"]) == [
        "Fictional microphone",
        "Fictional microphone",
    ]
    assert client.app.state.ctx.store.db.execute("PRAGMA user_version").fetchone()[0] == LATEST  # type: ignore[attr-defined]

    # The UI's own preferences keep the migration's defaults.
    settings = invoke(client, "get_settings")
    assert (settings["theme"], settings["inspector_open"]) == ("system", True)

    # Nothing is imported twice; the destination now counts as in use.
    status = invoke(client, "import_status")
    assert (status["available"], status["blocked_reason"]) == (False, DESTINATION_USED)
    code, body = invoke_error(client, "import_previous")
    assert (code, body["code"], body["message"]) == (400, "import_refused", DESTINATION_USED)


def test_import_previous_refuses_while_a_recording_is_active(
    client: TestClient, old_folder: Path
) -> None:
    # A fake state, set directly: no device is opened and no audio is written.
    client.app.state.ctx.recorder.status = "recording"  # type: ignore[attr-defined]
    code, body = invoke_error(client, "import_previous")
    assert (code, body["code"]) == (400, "import_busy")
    assert body["message"] == "Stop the recording before importing."
    assert invoke(client, "list_meetings") == []


def test_import_previous_refuses_while_a_transcription_runs(
    client: TestClient, old_folder: Path
) -> None:
    busy = client.app.state.ctx.stt_busy  # type: ignore[attr-defined]
    assert busy.acquire(blocking=False)
    try:
        code, body = invoke_error(client, "import_previous")
    finally:
        busy.release()
    assert (code, body["code"]) == (400, "import_busy")
    assert body["message"] == "Wait for processing to finish."
    assert invoke(client, "list_meetings") == []


def test_import_previous_refuses_a_destination_that_already_has_meetings(
    client: TestClient, old_folder: Path
) -> None:
    invoke(client, "create_note", title="Fictional local note")
    code, body = invoke_error(client, "import_previous")
    assert (code, body["code"], body["message"]) == (400, "import_refused", DESTINATION_USED)
    assert [meeting["title"] for meeting in invoke(client, "list_meetings")] == [
        "Fictional local note"
    ]


def test_the_old_folder_is_untouched_by_status_and_import(
    client: TestClient, old_folder: Path
) -> None:
    before = snapshot(old_folder)
    invoke(client, "import_status")
    invoke(client, "import_previous")
    invoke(client, "import_status")
    # Byte-identical, and no -shm/-wal or any other file was added beside the old database.
    after = snapshot(old_folder)
    assert after == before


def test_a_reopened_store_is_the_one_the_import_replaced(client: TestClient, old_folder: Path) -> None:
    """The import replaces the database file; the live store object must point at the new one."""
    store: Store = client.app.state.ctx.store  # type: ignore[attr-defined]
    invoke(client, "import_previous")
    assert store.db.execute("SELECT COUNT(*) FROM meetings").fetchone()[0] == 1
    # The store still writes: a note lands in the imported database.
    meeting_id = invoke(client, "create_note", title="Fictional follow-up")
    rows = store.db.execute("SELECT title FROM meetings ORDER BY title").fetchall()
    assert [row[0] for row in rows] == ["Fictional follow-up", "Fictional planning call"]
    assert invoke(client, "get_meeting", id=meeting_id)["meeting"]["title"] == "Fictional follow-up"


def test_a_store_that_cannot_reopen_reports_a_restart_message(
    client: TestClient, old_folder: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failed reopen is not a raw sqlite error in the window: it says restart, nothing was lost."""
    ctx = client.app.state.ctx  # type: ignore[attr-defined]

    def refuse(self: Store) -> sqlite3.Connection:
        raise sqlite3.OperationalError("unable to open database file")

    monkeypatch.setattr(Store, "_open", refuse)
    with pytest.raises(AppError) as caught:
        import_previous(ctx)
    assert (caught.value.code, caught.value.message) == (STORE_REOPEN_FAILED, REOPEN_FAILED)
    # The sqlite error stays the cause, so the log still shows why the file would not open.
    assert isinstance(caught.value.__cause__, sqlite3.OperationalError)
    # The imported database is on disk: the message's promise that nothing was deleted holds.
    assert (ctx.store.data_dir / "meetings.db").is_file()
