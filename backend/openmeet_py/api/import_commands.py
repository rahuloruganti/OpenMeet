"""The one-time import from the previous OpenMeet data folder, offered inside the running app.

`import_status` only looks: it counts a temporary copy of the old database (WAL included), so it
never creates or updates a file in that folder. `import_previous` runs the same
importer as `--import-from`, with the same rules: read-only source, a non-empty destination is
refused, the replaced database is kept in pre-import-backup/<UTC timestamp>/, secrets are blanked and
models are not copied. Because Windows will not replace a database file another handle holds, the
live store's connection is closed for the swap and reopened afterwards under the same locks the
recorder and the processing workers take.
"""

from __future__ import annotations

import os
from contextlib import nullcontext
from typing import Any, Optional

from openmeet_py.api.context import Context
from openmeet_py.api.errors import AppError
from openmeet_py.infra import importer
from openmeet_py.infra.importer import import_old_data
from openmeet_py.infra.store import DB_FILE
from openmeet_py.paths import old_data_dir

NO_DATA = "No previous OpenMeet data found."
UNREADABLE = "The previous database could not be read."
DESTINATION_USED = "This OpenMeet already has meetings."
RECORDING_ACTIVE = "Stop the recording before importing."
PROCESSING_ACTIVE = "Wait for processing to finish."
STORE_REOPEN_FAILED = "store_reopen_failed"
REOPEN_FAILED = (
    "OpenMeet could not reopen its database. Restart OpenMeet; no data was deleted."
)

# Stages of a processing run that are doing work right now (see domain/processing.py).
ACTIVE_STAGES = ("live", "finalizing_audio", "transcribing", "awaiting_notes", "summarizing")


def _audio_file_count(ctx: Context) -> int:
    """Files in this data folder's audio tree: any file there means the folder is in use."""
    root = ctx.store.data_dir / importer.AUDIO_DIR
    if not root.is_dir():
        return 0
    count = 0
    for _parent, _dirs, files in os.walk(root, followlinks=False):
        count += len(files)
    return count


def _destination_in_use(ctx: Context) -> bool:
    """True when this data folder already holds a meeting or audio. Reads the live connection."""
    with ctx.store.lock:
        meetings = ctx.store.db.execute("SELECT COUNT(*) FROM meetings").fetchone()[0]
    return meetings > 0 or _audio_file_count(ctx) > 0


def import_status(ctx: Context) -> dict[str, Any]:
    """What the old folder would bring over. Read-only; never writes beside the source."""
    source = old_data_dir()
    status: dict[str, Any] = {
        "available": False,
        "path": None,
        "meetings": 0,
        "audio_files": 0,
        "bytes": 0,
        "blocked_reason": NO_DATA,
    }
    if not source.is_dir() or not (source / DB_FILE).is_file():
        return status
    status["path"] = str(source)
    summary = importer.read_source_summary(source)
    if summary is None:
        status["blocked_reason"] = UNREADABLE
        return status
    status.update(
        meetings=summary.meetings,
        audio_files=summary.audio_files,
        bytes=summary.audio_bytes,
    )
    if _destination_in_use(ctx):
        status["blocked_reason"] = DESTINATION_USED
        return status
    status.update(available=True, blocked_reason=None)
    return status


def _busy_reason(ctx: Context) -> Optional[str]:
    """Why an import must wait: a recording, a transcription, an AI call or a processing run."""
    recorder = ctx.recorder
    if recorder is not None and recorder.state()["status"] in ("recording", "paused"):
        return RECORDING_ACTIVE
    if ctx.stt_busy.locked() or ctx.ai_busy.locked():
        return PROCESSING_ACTIVE
    with ctx.store.lock:
        placeholders = ",".join("?" for _ in ACTIVE_STAGES)
        running = ctx.store.db.execute(
            f"SELECT COUNT(*) FROM processing_runs WHERE stage IN ({placeholders})",
            ACTIVE_STAGES,
        ).fetchone()[0]
    return PROCESSING_ACTIVE if running else None


def import_previous(ctx: Context) -> dict[str, Any]:
    """Imports the old folder into this live data folder and returns counts plus report notes."""
    source = old_data_dir()
    if not source.is_dir() or not (source / DB_FILE).is_file():
        raise AppError("import_unavailable", NO_DATA)
    reason = _busy_reason(ctx)
    if reason is not None:
        raise AppError("import_busy", reason)
    recorder = ctx.recorder
    # Lock order is the recorder's then the store's (see commands.delete_meeting): a recording or a
    # command cannot start while the database is swapped, and stop() waits for us, not the reverse.
    with (recorder.lock if recorder is not None else nullcontext()), ctx.store.lock:
        if recorder is not None and recorder.state()["status"] in ("recording", "paused"):
            raise AppError("import_busy", RECORDING_ACTIVE)
        if _destination_in_use(ctx):
            raise AppError("import_refused", DESTINATION_USED)
        ctx.store.close()
        try:
            report = import_old_data(source, ctx.store.data_dir)
        except importer.ImportProblem as error:
            raise AppError("import_failed", str(error)) from error
        finally:
            # A store that cannot reopen leaves the app unusable, so it gets its own restartable
            # message instead of a raw sqlite error; the import's own failure (if any) stays in the
            # exception's context chain, and the replaced database is kept on disk.
            try:
                ctx.store.reopen()
            except Exception as error:
                raise AppError(STORE_REOPEN_FAILED, REOPEN_FAILED) from error
    ctx.emit("meeting_updated", None)
    return {
        "meetings": report.meetings,
        "transcript_lines": report.transcript_lines,
        "audio_files": report.audio_files,
        "notes": list(report.skipped),
    }
