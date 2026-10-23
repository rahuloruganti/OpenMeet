"""TXT/SRT/VTT transcript files written beside the Markdown snapshot."""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any, Callable

import pytest
from fastapi.testclient import TestClient

from conftest import invoke
from openmeet_py.api.errors import AppError
from openmeet_py.domain import exporter, transcript_edits
from openmeet_py.infra.store import transaction
from stt_fixtures import add_meeting

# A long line with a blank line and markup characters, as an edited segment can carry.
SAMPLE = [
    transcript_edits.timed("You", 1200, 2500, " Hello "),
    transcript_edits.timed("Others", 3_605_000, 3_606_500, "World <b> &\n\nagain"),
]


def note_detail(
    segments: list[dict[str, Any]],
    names: dict[str, Any] | None = None,
    title: str = "Fictional transcript export",
) -> dict[str, Any]:
    """A notes-only meeting detail in the shape reads.meeting_detail returns."""
    return {
        "meeting": {
            "id": str(uuid.uuid4()),
            "title": title,
            "started_at": "2026-10-23T09:00:00Z",
            "source": "desktop",
            "tags": [],
        },
        "summary": None,
        "summary_template": None,
        "summary_model": None,
        "summary_edited": False,
        "action_items": [],
        "user_markdown": "Fictional notes.",
        "segments": segments,
        "speaker_names": names or {"you": None, "others": None},
        "segment_meta": [],
        "transcript_provider": "whisper",
        "transcript_model": "small",
        "tracks": [],
    }


def options(*formats: str) -> dict[str, Any]:
    return {
        "transcript": True,
        "summary": False,
        "filename": "title",
        "transcript_formats": list(formats),
    }


def vault(tmp_path: Path) -> Path:
    folder = tmp_path / "vault"
    folder.mkdir()
    return folder


def test_writes_one_file_per_enabled_format_beside_the_snapshot(tmp_path: Path) -> None:
    detail = note_detail(SAMPLE, {"you": "Ana", "others": None})
    # Requested out of order on purpose: the reported paths keep the stored order.
    result = exporter.write_snapshot(detail, vault(tmp_path), options("vtt", "txt", "srt"))

    snapshot = Path(result["path"])
    assert snapshot.parent == (tmp_path / "vault" / "Meetings").resolve()
    assert snapshot.suffix == ".md"
    paths = [Path(path) for path in result["transcript_paths"]]
    assert [path.suffix for path in paths] == [".txt", ".srt", ".vtt"]
    for path in paths:
        # One export is one set of files: same stem as the snapshot, beside it.
        assert path.parent == snapshot.parent
        assert path.stem == snapshot.stem
        assert path.read_text(encoding="utf-8").strip()


def test_plain_text_uses_hour_times_and_single_line_segments(tmp_path: Path) -> None:
    detail = note_detail(
        SAMPLE + [transcript_edits.timed("You", 0, None, "No timing")],
        {"you": "Ana", "others": None},
    )
    result = exporter.write_snapshot(detail, vault(tmp_path), options("txt"))
    text = Path(result["transcript_paths"][0]).read_text(encoding="utf-8")
    assert text == (
        "[00:00:01] Ana (You): Hello\n"
        "[01:00:05] Others: World <b> & again\n"
        "[untimed] Ana (You): No timing\n"
    )


def test_srt_and_vtt_cue_text_is_exact(tmp_path: Path) -> None:
    detail = note_detail(SAMPLE, {"you": "Ana", "others": None})
    result = exporter.write_snapshot(detail, vault(tmp_path), options("txt", "srt", "vtt"))
    txt, srt, vtt = (
        Path(path).read_text(encoding="utf-8") for path in result["transcript_paths"]
    )
    assert txt == "[00:00:01] Ana (You): Hello\n[01:00:05] Others: World <b> & again\n"
    assert srt == (
        "1\n00:00:01,200 --> 00:00:02,500\nAna (You): Hello\n\n"
        "2\n01:00:05,000 --> 01:00:06,500\nOthers: World <b> & again\n\n"
    )
    assert vtt == (
        "WEBVTT\n\n"
        "00:00:01.200 --> 00:00:02.500\n<v Ana (You)>Hello\n\n"
        "01:00:05.000 --> 01:00:06.500\n<v Others>World &lt;b&gt; &amp; again\n\n"
    )


def test_a_cue_must_end_after_it_starts(tmp_path: Path) -> None:
    detail = note_detail([transcript_edits.timed("You", 2500, 2500, "Zero length")])
    result = exporter.write_snapshot(detail, vault(tmp_path), options("srt", "vtt"))
    srt, vtt = (Path(path).read_text(encoding="utf-8") for path in result["transcript_paths"])
    assert srt.startswith("1\n00:00:02,500 --> 00:00:02,501\nYou: Zero length\n\n")
    assert vtt.startswith("WEBVTT\n\n00:00:02.500 --> 00:00:02.501\n<v You>Zero length\n\n")


def test_untimed_transcript_refuses_srt_and_vtt_and_writes_nothing(tmp_path: Path) -> None:
    detail = note_detail([transcript_edits.timed("You", None, None, "No timing")])
    folder = vault(tmp_path)
    with pytest.raises(AppError) as failure:
        exporter.write_snapshot(detail, folder, options("txt", "srt"))
    assert failure.value.code == "untimed_transcript"
    assert "no engine timestamps" in failure.value.message
    assert "Nothing was exported." in failure.value.message
    meetings = folder / "Meetings"
    assert list(meetings.iterdir()) == [], "a refused export writes neither snapshot nor transcript"

    # Text alone is still allowed and says which lines carry no timing.
    result = exporter.write_snapshot(detail, folder, options("txt"))
    text = Path(result["transcript_paths"][0]).read_text(encoding="utf-8")
    assert text == "[untimed] You: No timing\n"
    assert Path(result["path"]).exists()


def test_repeated_export_reuses_files_and_copies_an_edited_transcript(tmp_path: Path) -> None:
    detail = note_detail(SAMPLE)
    folder = vault(tmp_path)
    first = exporter.write_snapshot(detail, folder, options("txt", "srt"))

    again = exporter.write_snapshot(detail, folder, options("txt", "srt"))
    assert again["path"] == first["path"] and again["created_copy"] is False
    assert again["transcript_paths"] == first["transcript_paths"]

    # An edited transcript file is never overwritten; the export writes a fresh copy beside it.
    original = Path(first["transcript_paths"][0])
    original.write_text("External edit", encoding="utf-8")
    later = exporter.write_snapshot(detail, folder, options("txt", "srt"))
    assert later["path"] == first["path"]
    copy = Path(later["transcript_paths"][0])
    assert copy != original
    assert copy.suffix == ".txt" and " - copy-" in copy.name
    assert original.read_text(encoding="utf-8") == "External edit"
    assert copy.read_text(encoding="utf-8").startswith("[00:00:01] You: Hello")
    # The untouched SRT is reused, so copies only appear for the file that changed.
    assert later["transcript_paths"][1] == first["transcript_paths"][1]


def test_only_enabled_formats_are_written(tmp_path: Path) -> None:
    detail = note_detail(SAMPLE)
    folder = vault(tmp_path)
    result = exporter.write_snapshot(detail, folder, options("srt"))
    assert [Path(path).suffix for path in result["transcript_paths"]] == [".srt"]
    written = sorted(path.suffix for path in (folder / "Meetings").iterdir())
    assert written == [".md", ".srt"]


def test_meeting_without_a_transcript_gets_no_transcript_files(tmp_path: Path) -> None:
    result = exporter.write_snapshot(note_detail([]), vault(tmp_path), options("txt", "srt", "vtt"))
    assert result["transcript_paths"] == []
    assert Path(result["path"]).exists()


def test_saved_settings_formats_drive_the_export(
    make_client: Callable[..., TestClient], tmp_path: Path
) -> None:
    folder = vault(tmp_path)
    client = make_client(pick_folder=lambda: str(folder))
    invoke(client, "choose_vault_folder")
    ctx = client.app.state.ctx
    meeting = add_meeting(ctx)
    with ctx.store.lock:
        with transaction(ctx.store.db) as tx:
            transcript_edits.replace_transcript(
                tx, meeting, [transcript_edits.timed("You", 1200, 2500, "Hello")], "whisper", "small"
            )

    invoke(
        client,
        "save_export_options",
        options={
            "transcript": True,
            "summary": False,
            "filename": "title",
            "transcript_formats": ["vtt", "txt"],
        },
    )
    result = invoke(client, "export_meeting", id=meeting)
    assert [Path(path).suffix for path in result["transcript_paths"]] == [".txt", ".vtt"]
    for path in result["transcript_paths"]:
        assert Path(path).parent == Path(result["path"]).parent
        assert Path(path).stem == Path(result["path"]).stem
