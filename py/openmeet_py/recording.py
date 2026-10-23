"""Command handlers for devices, recording and audio files. Capture itself lives in recorder.py.

Mirrors the recording commands in src-tauri/src/lib.rs and the audio parts of storage.rs
(delete_audio, recoverable_tracks, mark_recovered, audio_usage) and stt.rs (track_file_ms).
"""

from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path
from typing import Any

from . import reads
from .audio_wav import file_ms, read_timing, repair_wav
from .context import Context, int_arg, text_arg
from .errors import AppError
from .reads import read_settings


def audio_root(ctx: Context) -> Path:
    return ctx.store.data_dir / "audio"


# ---- devices and state ---------------------------------------------------------


def get_recording_state(ctx: Context) -> dict[str, Any]:
    return ctx.recorder.state()


def list_audio_devices(ctx: Context) -> dict[str, Any]:
    return ctx.recorder.devices()


def save_default_devices(ctx: Context, microphone_id: str, output_id: str) -> dict[str, Any]:
    microphone_id = text_arg(microphone_id, "microphone_id")
    output_id = text_arg(output_id, "output_id")
    if not microphone_id or not output_id:
        raise AppError("audio_devices", "Select both a microphone and a system-output device.")
    with ctx.store.lock:
        db = ctx.store.db
        db.execute(
            "UPDATE settings SET microphone_id = ?1, output_id = ?2 WHERE id = 1",
            (microphone_id, output_id),
        )
        return read_settings(db)


def _devices_from(devices: Any) -> tuple[str, str]:
    if not isinstance(devices, dict):
        raise AppError("invalid_args", "devices must be an object.")
    mic = devices.get("microphoneId", devices.get("microphone_id"))
    out = devices.get("outputId", devices.get("output_id"))
    if (mic is not None and not isinstance(mic, str)) or (out is not None and not isinstance(out, str)):
        raise AppError("invalid_args", "devices must hold device ids as text.")
    return mic or "", out or ""


def start_recording(ctx: Context, title: str, devices: Any) -> dict[str, Any]:
    title = text_arg(title, "title")
    mic, out = _devices_from(devices)
    return ctx.recorder.start(title, mic, out)


def pause_recording(ctx: Context) -> dict[str, Any]:
    return ctx.recorder.pause()


def resume_recording(ctx: Context) -> dict[str, Any]:
    return ctx.recorder.resume()


def stop_recording(ctx: Context) -> dict[str, Any]:
    state = ctx.recorder.stop()
    ctx.emit("meeting_updated", None)
    return state


def audio_usage(ctx: Context) -> int:
    """Bytes in the per-meeting audio folders, without following links (storage.rs audio_usage)."""
    root = audio_root(ctx)
    if not root.is_dir():
        return 0
    total = 0
    for folder in root.iterdir():
        if folder.is_symlink() or not folder.is_dir():
            continue
        for entry in folder.iterdir():
            if entry.is_file() and not entry.is_symlink():
                total += entry.stat().st_size
    return total


# ---- owned audio files ---------------------------------------------------------


def _owned_files(db: sqlite3.Connection, root: Path, meeting_id: str) -> list[Path]:
    """Files this meeting owns: tracked paths plus regular files in its folder. Raises before deleting."""
    owned_folder = None
    try:
        uuid.UUID(meeting_id)
        folder = (root / meeting_id).resolve(strict=True)
        if folder.parent == root.resolve(strict=True):
            owned_folder = folder
    except (ValueError, OSError):
        owned_folder = None
    stored = db.execute(
        "SELECT path, timing_path FROM tracks WHERE meeting_id = ?1", (meeting_id,)
    ).fetchall()
    files: list[Path] = []
    for path in (item for row in stored for item in row):
        try:
            real = Path(path).resolve(strict=True)
        except FileNotFoundError:
            continue
        except OSError as error:
            raise AppError("filesystem", "File operation failed. Nothing was deleted.") from error
        if owned_folder is None or real.parent != owned_folder or not real.is_file():
            raise AppError(
                "unsafe_audio_path",
                "A stored audio path points outside this meeting's audio folder. Nothing was deleted.",
            )
        if real not in files:
            files.append(real)
    if owned_folder is not None:
        for entry in owned_folder.iterdir():
            if entry.is_file() and not entry.is_symlink() and entry not in files:
                files.append(entry)
    return files


def delete_owned_audio(ctx: Context, db: sqlite3.Connection, meeting_id: str) -> None:
    """Removes this meeting's audio files and track rows. Caller holds the recorder and store locks.

    Notes, transcripts and summaries stay; delete_meeting removes the rows afterwards.
    """
    if ctx.recorder.busy_for(meeting_id):
        raise AppError("recording_active", "Stop the recording before deleting it or its audio.")
    root = audio_root(ctx)
    for file in _owned_files(db, root, meeting_id):
        try:
            file.unlink()
        except FileNotFoundError:
            pass
    db.execute("DELETE FROM tracks WHERE meeting_id = ?1", (meeting_id,))
    try:
        uuid.UUID(meeting_id)
        (root / meeting_id).rmdir()  # only succeeds when empty; unknown files stay
    except (ValueError, OSError):
        pass


def delete_audio(ctx: Context, id: str) -> None:
    text_arg(id, "id")
    with ctx.recorder.lock:
        with ctx.store.lock:
            db = ctx.store.db
            reads.require_meeting(db, id)
            delete_owned_audio(ctx, db, id)
    ctx.emit("meeting_updated", None)


# ---- recovery and seeking -------------------------------------------------------


def recover_audio(ctx: Context, id: str) -> None:
    text_arg(id, "id")
    root = audio_root(ctx)
    with ctx.store.lock:
        db = ctx.store.db
        meeting = db.execute(
            "SELECT source, status FROM meetings WHERE id = ?1", (id,)
        ).fetchone()
        if meeting is None:
            raise AppError("not_found", "Meeting not found.")
        if meeting[0] != "desktop" or meeting[1] != "interrupted":
            raise AppError("not_recoverable", "Only interrupted recordings can be recovered.")
        unfinished = db.execute(
            "SELECT kind, path FROM tracks WHERE meeting_id = ?1 AND finalized = 0 ORDER BY kind",
            (id,),
        ).fetchall()
    if not unfinished:
        raise AppError("not_recoverable", "This recording has no unfinished audio tracks to recover.")
    plans = []
    for kind, path in unfinished:
        original = Path(path)
        try:
            inside = original.resolve(strict=True).is_relative_to(root.resolve(strict=True))
        except OSError:
            inside = False
        if not inside:
            raise AppError(
                "unsafe_path",
                "A track path is outside the OpenMeet audio folder. Nothing was changed.",
            )
        plans.append((kind, original, original.with_name(f"{kind}.recovered-{uuid.uuid4()}.wav")))
    # Copying can take a while, so it runs without the store lock; the rows are checked again below.
    repaired = [(kind, copy, repair_wav(original, copy)) for kind, original, copy in plans]
    with ctx.store.lock:
        for kind, copy, frames in repaired:
            changed = ctx.store.db.execute(
                "UPDATE tracks SET path = ?1, frames = ?2, finalized = 1 "
                "WHERE meeting_id = ?3 AND kind = ?4 AND finalized = 0",
                (str(copy), frames, id, kind),
            ).rowcount
            if changed != 1:
                raise AppError(
                    "not_recoverable",
                    "The track changed during recovery. The repaired copy was kept on disk.",
                )
    ctx.emit("meeting_updated", None)


def audio_position(ctx: Context, id: str, kind: str, session_ms: int) -> int:
    text_arg(id, "id")
    text_arg(kind, "kind")
    session_ms = int_arg(session_ms, "session_ms")
    with ctx.store.lock:
        row = ctx.store.db.execute(
            "SELECT timing_path, sample_rate, frames FROM tracks WHERE meeting_id = ?1 AND kind = ?2",
            (id, kind),
        ).fetchone()
    if row is None:
        raise AppError("not_found", "That audio track does not exist.")
    timing_path, rate, frames = row
    blocks = read_timing(Path(timing_path), rate, frames)
    return file_ms(blocks, rate, session_ms)


__all__ = [
    "audio_position",
    "audio_usage",
    "delete_audio",
    "delete_owned_audio",
    "get_recording_state",
    "list_audio_devices",
    "pause_recording",
    "recover_audio",
    "resume_recording",
    "save_default_devices",
    "start_recording",
    "stop_recording",
]
