"""Markdown snapshot export for notes-only meetings.

Summaries and tasks render from the stored rows. The transcript and tracks stay empty until phases 3-4
write them, so an empty meeting renders empty sections rather than dropping them.
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

from openmeet_py.api.errors import AppError

Detail = dict[str, Any]

# Transcript files are stored and listed in this fixed order, which is also the reporting order.
TRANSCRIPT_FORMATS = ("txt", "srt", "vtt")

UNTIMED_TRANSCRIPT_MESSAGE = (
    "This transcript has no engine timestamps, so it cannot be written as SRT or VTT. "
    "Nothing was exported. Turn off SRT and VTT in Settings → General → Transcript files "
    "to export this meeting, or re-transcribe with an engine that reports timings."
)


def _quote(value: str) -> str:
    # JSON-quoted strings are valid YAML double-quoted scalars.
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


def _label(names: dict[str, Any], speaker: str) -> str:
    """Speaker label: "Name (You)" when the speaker is named, otherwise the stored label."""
    name = {"You": names.get("you"), "Others": names.get("others")}.get(speaker)
    return f"{name} ({speaker})" if name else speaker


def _cue_time(ms: int, separator: str) -> str:
    """`HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (VTT) from a session time."""
    ms = max(ms, 0)
    return (
        f"{ms // 3_600_000:02}:{ms // 60_000 % 60:02}:{ms // 1000 % 60:02}"
        f"{separator}{ms % 1000:03}"
    )


def _plain_time(ms: int) -> str:
    """`HH:MM:SS` for the plain-text transcript."""
    seconds = max(ms, 0) // 1000
    return f"{seconds // 3600:02}:{seconds // 60 % 60:02}:{seconds % 60:02}"


def _one_line(text: str) -> str:
    """Collapses line breaks and runs of whitespace.

    A blank line inside an edited segment would otherwise end an SRT/VTT cue early or split one
    text line in two.
    """
    return " ".join(text.split())


def _vtt_escape(text: str) -> str:
    """VTT cue text is markup, so `&`, `<` and `>` (which also rules out `-->`) are escaped."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def render_transcript(detail: Detail, fmt: str) -> str:
    """One transcript file written beside the Markdown snapshot.

    SRT and VTT need a timestamp on every segment, so an untimed transcript is refused instead
    of being given invented times.
    """
    if fmt not in TRANSCRIPT_FORMATS:
        raise AppError("invalid_format", "Unknown transcript file format.")
    segments = detail.get("segments") or []
    names = detail.get("speaker_names") or {}

    def speaker(segment: dict[str, Any]) -> str:
        return _one_line(_label(names, segment["speaker"]))

    if fmt == "txt":
        lines = []
        for segment in segments:
            timing = segment["timing"]
            when = _plain_time(timing["start_ms"]) if timing["kind"] == "timed" else "untimed"
            lines.append(f"[{when}] {speaker(segment)}: {_one_line(segment['text'])}\n")
        return "".join(lines)

    srt = fmt == "srt"
    output = "" if srt else "WEBVTT\n\n"
    for index, segment in enumerate(segments):
        timing = segment["timing"]
        if timing["kind"] != "timed":
            raise AppError("untimed_transcript", UNTIMED_TRANSCRIPT_MESSAGE)
        separator = "," if srt else "."
        # A cue must end after it starts, so a zero-length segment still gets one millisecond.
        times = (
            f"{_cue_time(timing['start_ms'], separator)} --> "
            f"{_cue_time(max(timing['end_ms'], timing['start_ms'] + 1), separator)}"
        )
        who, text = speaker(segment), _one_line(segment["text"])
        if srt:
            output += f"{index + 1}\n{times}\n{who}: {text}\n\n"
        else:
            output += f"{times}\n<v {_vtt_escape(who)}>{_vtt_escape(text)}\n\n"
    return output


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
            # link() fails if the target exists, so an export never overwrites another file.
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
    # Render every requested transcript before publishing anything, so an untimed transcript
    # refuses the export instead of leaving a partial set of files behind. A meeting with no
    # transcript gets no empty transcript files.
    enabled = options.get("transcript_formats") or []
    transcripts = [
        (fmt, render_transcript(detail, fmt))
        for fmt in TRANSCRIPT_FORMATS
        if fmt in enabled and detail.get("segments")
    ]
    path, created_copy = _publish(folder, folder / filename(detail, options), content)
    transcript_paths = []
    for fmt, text in transcripts:
        # The stem is the Markdown snapshot's, so one export shares a name.
        try:
            written, _ = _publish(folder, path.with_suffix(f".{fmt}"), text.encode("utf-8"))
        except OSError as error:
            raise AppError(
                "filesystem",
                f"File operation failed: {error}. The Markdown snapshot was already written.",
            ) from error
        transcript_paths.append(str(written))
    return {"path": str(path), "created_copy": created_copy, "transcript_paths": transcript_paths}
