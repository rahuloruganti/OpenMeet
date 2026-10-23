"""Notes command set: create, save with revisions, rename, tags, delete, search, export."""

from __future__ import annotations

from pathlib import Path
from typing import Callable

from fastapi.testclient import TestClient

from conftest import invoke, invoke_error
from openmeet_py.server import create_app


def _new_note(client: TestClient, title: str = "Weekly sync") -> str:
    return invoke(client, "create_note", title=title)


def test_create_note_appears_in_list_as_a_note(client: TestClient) -> None:
    meeting_id = _new_note(client, "  Weekly sync  ")
    meetings = invoke(client, "list_meetings")
    assert [m["id"] for m in meetings] == [meeting_id]
    assert meetings[0]["title"] == "Weekly sync"
    assert meetings[0]["source"] == "note"
    assert meetings[0]["status"] == "stopped"
    assert meetings[0]["tags"] == []


def test_new_note_opens_with_empty_notes_at_revision_zero(client: TestClient) -> None:
    meeting_id = _new_note(client)
    detail = invoke(client, "get_meeting", id=meeting_id)
    assert detail["user_markdown"] == ""
    assert detail["notes_revision"] == 0
    assert detail["segments"] == []


def test_save_notes_advances_revision_and_persists(client: TestClient) -> None:
    meeting_id = _new_note(client)
    assert invoke(client, "save_notes", id=meeting_id, markdown="# Agenda\n- item", expectedRevision=0) == 1
    detail = invoke(client, "get_meeting", id=meeting_id)
    assert detail["user_markdown"] == "# Agenda\n- item"
    assert detail["notes_revision"] == 1


def test_stale_revision_is_rejected_and_nothing_is_overwritten(client: TestClient) -> None:
    meeting_id = _new_note(client)
    invoke(client, "save_notes", id=meeting_id, markdown="first", expectedRevision=0)
    status, body = invoke_error(
        client, "save_notes", id=meeting_id, markdown="stale edit", expectedRevision=0
    )
    assert status == 400
    assert body["code"] == "notes_conflict"
    detail = invoke(client, "get_meeting", id=meeting_id)
    assert detail["user_markdown"] == "first"
    assert detail["notes_revision"] == 1


def test_save_notes_rejects_oversized_text_and_unknown_meeting(client: TestClient) -> None:
    meeting_id = _new_note(client)
    status, body = invoke_error(
        client, "save_notes", id=meeting_id, markdown="x" * (1024 * 1024 + 1), expectedRevision=0
    )
    assert (status, body["code"]) == (400, "invalid_notes")
    status, body = invoke_error(
        client, "save_notes", id="00000000-0000-0000-0000-000000000000", markdown="x", expectedRevision=0
    )
    assert body["code"] == "notes_conflict"


def test_rename_trims_and_validates_titles(client: TestClient) -> None:
    meeting_id = _new_note(client)
    assert invoke(client, "rename_meeting", id=meeting_id, title="  Board review  ") == "Board review"
    assert invoke(client, "list_meetings")[0]["title"] == "Board review"
    for bad in ["", "   ", "x" * 161]:
        status, body = invoke_error(client, "rename_meeting", id=meeting_id, title=bad)
        assert (status, body["code"]) == (400, "invalid_title")
        assert body["message"] == "Use a meeting title between 1 and 160 characters."
    assert invoke(client, "list_meetings")[0]["title"] == "Board review"
    assert invoke(client, "rename_meeting", id=meeting_id, title="y" * 160) == "y" * 160


def test_rename_unknown_meeting_is_not_found(client: TestClient) -> None:
    status, body = invoke_error(
        client, "rename_meeting", id="00000000-0000-0000-0000-000000000000", title="x"
    )
    assert (status, body["code"]) == (400, "not_found")


def test_tags_are_case_insensitive_sorted_and_limited(client: TestClient) -> None:
    meeting_id = _new_note(client)
    tags = invoke(client, "set_meeting_tags", meetingId=meeting_id, tags=["Client", "client", " ", "Budget"])
    assert tags == ["Budget", "Client"]
    assert invoke(client, "list_meetings")[0]["tags"] == ["Budget", "Client"]

    many = [f"tag{i}" for i in range(21)]
    status, body = invoke_error(client, "set_meeting_tags", meetingId=meeting_id, tags=many)
    assert (status, body["code"]) == (400, "meeting_tag")
    # A refused set changes nothing.
    assert invoke(client, "list_meetings")[0]["tags"] == ["Budget", "Client"]

    status, body = invoke_error(client, "set_meeting_tags", meetingId=meeting_id, tags=["x" * 41])
    assert body["code"] == "meeting_tag"
    status, body = invoke_error(client, "set_meeting_tags", meetingId=meeting_id, tags=["bad\ntag"])
    assert body["code"] == "meeting_tag"


def test_delete_removes_meeting_notes_and_search_hits(client: TestClient) -> None:
    meeting_id = _new_note(client, "Gone soon")
    invoke(client, "save_notes", id=meeting_id, markdown="zebra notes", expectedRevision=0)
    assert invoke(client, "search_meetings", query="zebra")
    invoke(client, "delete_meeting", id=meeting_id)
    assert invoke(client, "list_meetings") == []
    assert invoke(client, "search_meetings", query="zebra") == []
    status, body = invoke_error(client, "get_meeting", id=meeting_id)
    assert (status, body["code"]) == (400, "not_found")
    status, body = invoke_error(client, "delete_meeting", id=meeting_id)
    assert body["code"] == "not_found"


def test_search_finds_titles_and_notes_and_ignores_operators(client: TestClient) -> None:
    meeting_id = _new_note(client, "Quarterly roadmap")
    invoke(client, "save_notes", id=meeting_id, markdown="Hiring plan for the platform team", expectedRevision=0)
    hits = invoke(client, "search_meetings", query="roadmap")
    assert {"meeting_id": meeting_id, "kind": "title", "snippet": "Quarterly roadmap"} in hits
    hits = invoke(client, "search_meetings", query="hiring")
    assert [h["kind"] for h in hits] == ["notes"]
    # Quotes, operators and punctuation stay literal text; no error.
    assert invoke(client, "search_meetings", query='NEAR(" OR *') == []
    assert invoke(client, "search_meetings", query="***") == []
    status, body = invoke_error(client, "search_meetings", query="x" * 201)
    assert body["code"] == "invalid_query"


def test_settings_round_trip_through_save_and_read(client: TestClient) -> None:
    saved = invoke(
        client,
        "save_export_options",
        options={
            "transcript": True,
            "summary": False,
            "filename": "date_title",
            "transcript_formats": ["vtt", "txt"],
        },
    )
    assert saved["export"] == {
        "transcript": True,
        "summary": False,
        "filename": "date_title",
        "transcript_formats": ["txt", "vtt"],
    }
    assert invoke(client, "get_settings")["export"] == saved["export"]
    assert invoke(client, "save_setup_done", done=True)["setup_done"] is True
    assert invoke(client, "get_settings")["setup_done"] is True
    status, body = invoke_error(
        client, "save_export_options", options={"transcript": True, "summary": True, "filename": "../x"}
    )
    assert body["code"] == "invalid_args"


def test_export_writes_snapshot_and_never_overwrites(
    make_client: Callable[..., TestClient], tmp_path: Path
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    client = make_client(pick_folder=lambda: str(vault))
    invoke(client, "choose_vault_folder")
    meeting_id = _new_note(client, "Launch: review?")
    invoke(client, "save_notes", id=meeting_id, markdown="first draft", expectedRevision=0)

    first = invoke(client, "export_meeting", id=meeting_id)
    snapshot = Path(first["path"])
    assert snapshot.parent == (vault / "Meetings").resolve()
    assert snapshot.name.startswith("Meeting Launch- review- - ")
    assert first["created_copy"] is False
    text = snapshot.read_text(encoding="utf-8")
    assert 'title: "Launch: review?"' in text
    assert "source: \"note\"" in text
    assert "## My notes\nfirst draft" in text
    assert "No summary generated." in text

    # Same content: the identical file is reused.
    again = invoke(client, "export_meeting", id=meeting_id)
    assert again["path"] == first["path"] and again["created_copy"] is False

    # Changed notes: the earlier snapshot stays as it was and a copy is written beside it.
    invoke(client, "save_notes", id=meeting_id, markdown="second draft", expectedRevision=1)
    later = invoke(client, "export_meeting", id=meeting_id)
    assert later["created_copy"] is True
    assert later["path"] != first["path"]
    assert " - copy-" in later["path"]
    assert snapshot.read_text(encoding="utf-8") == text
    assert "second draft" in Path(later["path"]).read_text(encoding="utf-8")


def test_export_without_folder_is_refused(client: TestClient) -> None:
    meeting_id = _new_note(client)
    status, body = invoke_error(client, "export_meeting", id=meeting_id)
    assert (status, body["code"]) == (400, "no_vault")


def test_data_survives_restart(make_client: Callable[..., TestClient], tmp_path: Path) -> None:
    first = make_client()
    meeting_id = _new_note(first, "Persisted")
    invoke(first, "save_notes", id=meeting_id, markdown="kept", expectedRevision=0)
    # A second app instance on the same folder, as after a restart. The first one is closed by the fixture.
    second = TestClient(
        create_app(tmp_path / "data", None, token="test-token"), base_url="http://127.0.0.1"
    )
    with second:
        detail = invoke(second, "get_meeting", id=meeting_id)
        assert detail["meeting"]["title"] == "Persisted"
        assert detail["user_markdown"] == "kept"
        assert detail["notes_revision"] == 1
