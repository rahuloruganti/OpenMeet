"""Markdown snapshot export: a port of src-tauri/src/export.rs for notes-only meetings.

Summaries and tasks render as export.rs does. The transcript and tracks stay empty until phases 3-4
write them, so the transcript section is rendered as the Rust app renders an empty meeting.
"""

from __future__ import annotations

import json
import os
import re
import stat
import tempfile
import uuid
from pathlib import Path
from typing import Any

from .errors import AppError

Detail = dict[str, Any]


def _quote(value: str) -> str:
    # JSON-quoted strings are valid YAML double-quoted scalars (as in export.rs).
    return json.dumps(value, ensure_ascii=False)


def render(detail: Detail, options: dict[str, Any]) -> str:
    meeting = detail["meeting"]
    out = (
        "---\n"
        f"title: {_quote(meeting['title'])}\n"
        f"date: {_quote(meeting['started_at'])}\n"
        f"meeting_id: {_quote(meeting['id'])}\n"
        f"source: {_quote(meeting['source'])}\n"
    )
    summary = detail.get("summary")
    if options["summary"] and summary is not None:
        if detail.get("summary_template"):
            out += f"template: {_quote(detail['summary_template'])}\n"
        if detail.get("summary_model"):
            out += f"model: {_quote(detail['summary_model'])}\n"
        if detail.get("summary_edited"):
            out += "summary_edited: true\n"
    user_tags = "".join(f", {_quote(tag)}" for tag in meeting["tags"])
    out += f"tags: [meeting{user_tags}]\n---\n\n> OpenMeet export.\n\n"
    if options["summary"]:
        body = summary if summary is not None else "No summary generated."
        out += f"## Summary\n%%ai-start%%\n{body}\n%%ai-end%%\n\n"
    # User-edited tasks sit outside the AI markers and are exported whenever any exist.
    if detail.get("action_items"):
        out += "## Tasks\n"
        for item in detail["action_items"]:
            check = "x" if item["done"] else " "
            origin = "From summary" if item["source"] == "summary" else "Added manually"
            out += (
                f"- [{check}] {item['text']} — Owner: {item['owner'] or 'Unassigned'} — "
                f"Due: {item['due_date'] or 'not set'} — {origin}\n"
            )
        out += "\n"
    out += f"## My notes\n{detail['user_markdown']}\n"
    if options["transcript"]:
        out += "\n## Transcript\nNo transcript generated.\n"
    return out


def _safe_name(text: str, limit: int) -> str:
    kept = "".join(
        c if (c.isascii() and (c.isalnum() or c in "-_ ")) else "-" for c in text[:limit]
    )
    return kept.strip()


def filename(detail: Detail, options: dict[str, Any]) -> str:
    try:
        meeting_id = uuid.UUID(detail["meeting"]["id"])
    except ValueError as error:
        raise AppError("invalid_id", "The meeting ID is invalid.") from error
    title = _safe_name(detail["meeting"]["title"], 64)
    # A fixed prefix (or leading date) plus the UUID avoids Windows device names and title clashes.
    if options["filename"] == "date_title":
        return f"{_safe_name(detail['meeting']['started_at'], 10)} {title} - {meeting_id}.md"
    return f"Meeting {title} - {meeting_id}.md"


def _publish(folder: Path, original: Path, content: bytes) -> tuple[Path, bool]:
    """Writes without overwriting: an identical file is reused, any other file gets a copy name."""
    try:
        status = os.lstat(original)
        if (
            stat.S_ISREG(status.st_mode)
            and status.st_size == len(content)
            and original.read_bytes() == content
        ):
            return original, False
    except FileNotFoundError:
        pass
    target = original
    for _ in range(3):
        fd, temp_name = tempfile.mkstemp(dir=folder, suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            # link() fails if the target exists, like persist_noclobber in export.rs.
            os.link(temp_name, target)
            return target, target != original
        except FileExistsError:
            target = folder / f"{original.stem} - copy-{uuid.uuid4()}{original.suffix}"
        finally:
            os.unlink(temp_name)
    raise AppError(
        "export_conflict", "Could not reserve an export filename. Try exporting again."
    )


def write_snapshot(detail: Detail, vault: Path, options: dict[str, Any]) -> dict[str, Any]:
    try:
        vault = vault.resolve(strict=True)
    except OSError as error:
        raise AppError("filesystem", f"File operation failed: {error}") from error
    folder = vault / "Meetings"
    folder.mkdir(exist_ok=True)
    folder = folder.resolve(strict=True)
    if not folder.is_relative_to(vault):
        raise AppError("unsafe_path", "The Meetings folder resolves outside the selected folder.")
    content = render(detail, options).encode("utf-8")
    path, created_copy = _publish(folder, folder / filename(detail, options), content)
    return {"path": str(path), "created_copy": created_copy, "transcript_paths": []}
