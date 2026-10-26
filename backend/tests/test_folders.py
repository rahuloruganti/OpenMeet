"""Folders, scoped Ask across meetings, and FTS retrieval: migration 035 and the commands that use it.

Fictional meetings only. Ask calls go through the Stub provider from test_ai; nothing leaves the test.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from conftest import invoke, invoke_error, latest_migration
from openmeet_py.domain import questions
from openmeet_py.infra.store import DB_FILE, Store
from test_ai import Stub, configure, note, reply
from test_live_wiring import database_through

MEETING = "77777777-7777-7777-7777-777777777777"


def make_folder(client: TestClient, name: str) -> str:
    rows = invoke(client, "create_folder", name=name)
    return next(row["id"] for row in rows if row["name"] == name)


def folder_named(client: TestClient, name: str) -> dict[str, Any]:
    return next(row for row in invoke(client, "list_folders") if row["name"] == name)


def add_segments(db: sqlite3.Connection, meeting: str, texts: list[str]) -> None:
    db.executemany(
        "INSERT INTO segments(meeting_id, speaker, start_ms, end_ms, text, source, pass) "
        "VALUES (?1, 'Others', ?2, ?3, ?4, 'fixture', 'final')",
        [(meeting, index * 1000, index * 1000 + 900, text) for index, text in enumerate(texts)],
    )


# ---- migration 035 -------------------------------------------------------------------------------


def test_migration_035_upgrades_a_populated_database_with_foreign_keys(tmp_path: Path) -> None:
    data = database_through(tmp_path, 33)
    db = sqlite3.connect(data / DB_FILE)
    db.execute("PRAGMA foreign_keys = ON")
    db.execute(
        "INSERT INTO meetings (id, title, started_at, ended_at, source, status) VALUES "
        "(?1, 'Fictional upgrade', '2026-01-01T09:00:00+00:00', '2026-01-01T09:10:00+00:00', "
        "'desktop', 'stopped')",
        (MEETING,),
    )
    db.execute("INSERT INTO notes (meeting_id, user_markdown) VALUES (?1, 'Fictional notes.')", (MEETING,))
    db.execute("INSERT INTO meeting_tags (meeting_id, tag) VALUES (?1, 'sync')", (MEETING,))
    db.execute(
        "INSERT INTO library_answers (id, question, answer, provider, model) "
        "VALUES (1, 'Fictional?', 'Fictional answer [M1].', 'http://127.0.0.1:1234/v1', 'local')"
    )
    db.execute("INSERT INTO library_answer_meetings (answer_id, position, meeting_id) VALUES (1, 0, ?1)", (MEETING,))
    db.commit()
    db.close()

    store = Store(data)
    try:
        assert store.db.execute("PRAGMA user_version").fetchone()[0] == latest_migration()
        assert latest_migration() >= 35
        assert store.db.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert store.db.execute("SELECT folder_id FROM meetings WHERE id = ?1", (MEETING,)).fetchone()[0] is None
        assert store.db.execute("SELECT user_markdown FROM notes WHERE meeting_id = ?1", (MEETING,)).fetchone()[0] == "Fictional notes."
        assert store.db.execute("SELECT COUNT(*) FROM meeting_tags WHERE meeting_id = ?1", (MEETING,)).fetchone()[0] == 1
        assert store.db.execute("SELECT scope_json FROM library_answers WHERE id = 1").fetchone()[0] is None
        assert store.db.execute("SELECT COUNT(*) FROM pragma_foreign_key_check").fetchone()[0] == 0
        # Folder names are unique ignoring case, and a meeting cannot point at a missing folder.
        store.db.execute("INSERT INTO folders (id, name, created_at) VALUES ('f1', 'Client', '2026-01-01T00:00:00Z')")
        with pytest.raises(sqlite3.IntegrityError):
            store.db.execute("INSERT INTO folders (id, name, created_at) VALUES ('f2', 'client', '2026-01-01T00:00:00Z')")
        with pytest.raises(sqlite3.IntegrityError):
            store.db.execute("UPDATE meetings SET folder_id = 'missing' WHERE id = ?1", (MEETING,))
        store.db.execute("UPDATE meetings SET folder_id = 'f1' WHERE id = ?1", (MEETING,))
        # Deleting the folder keeps the meeting and its notes; only the folder link is cleared.
        store.db.execute("DELETE FROM folders WHERE id = 'f1'")
        assert store.db.execute("SELECT folder_id FROM meetings WHERE id = ?1", (MEETING,)).fetchone()[0] is None
        assert store.db.execute("SELECT COUNT(*) FROM meetings").fetchone()[0] == 1
        assert store.db.execute("SELECT COUNT(*) FROM library_answer_meetings").fetchone()[0] == 1
    finally:
        store.close()


# ---- folder rules --------------------------------------------------------------------------------


def test_folder_names_are_trimmed_bounded_and_unique_ignoring_case(client: TestClient) -> None:
    rows = invoke(client, "create_folder", name="  Client work  ")
    assert [row["name"] for row in rows] == ["Client work"]
    assert rows[0]["meeting_count"] == 0 and rows[0]["position"] == 0
    status, body = invoke_error(client, "create_folder", name="client WORK")
    assert body["code"] == "folder_exists"
    for bad in ["   ", "x" * 61]:
        status, body = invoke_error(client, "create_folder", name=bad)
        assert body["code"] == "folder_name"
    status, body = invoke_error(client, "create_folder", name=5)
    assert body["code"] == "invalid_args"
    assert len(invoke(client, "create_folder", name="x" * 60)) == 2


def test_rename_keeps_the_folder_and_rejects_another_folders_name(client: TestClient) -> None:
    invoke(client, "create_folder", name="Alpha")
    beta = make_folder(client, "Beta")
    renamed = invoke(client, "rename_folder", id=folder_named(client, "Alpha")["id"], name="alpha")
    assert [row["name"] for row in renamed] == ["alpha", "Beta"]
    status, body = invoke_error(client, "rename_folder", id=beta, name="ALPHA")
    assert body["code"] == "folder_exists"
    status, body = invoke_error(client, "rename_folder", id="missing", name="Gamma")
    assert body["code"] == "not_found"


def test_reorder_needs_every_folder_exactly_once(client: TestClient) -> None:
    alpha = make_folder(client, "Alpha")
    beta = make_folder(client, "Beta")
    reordered = invoke(client, "reorder_folders", ids=[beta, alpha])
    assert [(row["name"], row["position"]) for row in reordered] == [("Beta", 0), ("Alpha", 1)]
    status, body = invoke_error(client, "reorder_folders", ids=[alpha])
    assert body["code"] == "folder_order"
    status, body = invoke_error(client, "reorder_folders", ids=[alpha, alpha])
    assert body["code"] == "folder_order"
    assert [row["name"] for row in invoke(client, "list_folders")] == ["Beta", "Alpha"]


def test_moving_counts_the_meeting_and_deleting_the_folder_keeps_it(client: TestClient) -> None:
    meeting = note(client, "Fictional", "Notes.")
    folder = make_folder(client, "Client")
    assert invoke(client, "list_meetings")[0]["folder_id"] is None
    moved = invoke(client, "move_meeting_to_folder", meeting_id=meeting, folder_id=folder)
    assert moved["folder_id"] == folder and moved["id"] == meeting
    assert invoke(client, "list_meetings")[0]["folder_id"] == folder
    assert invoke(client, "get_meeting", id=meeting)["meeting"]["folder_id"] == folder
    assert folder_named(client, "Client")["meeting_count"] == 1
    status, body = invoke_error(client, "move_meeting_to_folder", meeting_id=meeting, folder_id="missing")
    assert body["code"] == "not_found"
    status, body = invoke_error(client, "move_meeting_to_folder", meeting_id="missing", folder_id=folder)
    assert body["code"] == "not_found"
    assert invoke(client, "move_meeting_to_folder", meeting_id=meeting, folder_id=None)["folder_id"] is None
    invoke(client, "move_meeting_to_folder", meeting_id=meeting, folder_id=folder)
    assert [row["name"] for row in invoke(client, "delete_folder", id=folder)] == []
    assert invoke(client, "get_meeting", id=meeting)["meeting"]["folder_id"] is None
    assert invoke(client, "list_meetings")[0]["id"] == meeting


def test_a_folder_with_a_recording_meeting_cannot_be_deleted(client: TestClient) -> None:
    meeting = note(client, "Fictional", "Notes.")
    folder = make_folder(client, "Client")
    invoke(client, "move_meeting_to_folder", meeting_id=meeting, folder_id=folder)
    db = client.app.state.ctx.store.db  # type: ignore[attr-defined]
    db.execute("UPDATE meetings SET status = 'recording' WHERE id = ?1", (meeting,))
    status, body = invoke_error(client, "delete_folder", id=folder)
    assert body["code"] == "folder_recording"
    assert folder_named(client, "Client")["meeting_count"] == 1
    db.execute("UPDATE meetings SET status = 'stopped' WHERE id = ?1", (meeting,))
    assert invoke(client, "delete_folder", id=folder) == []


# ---- FTS query safety and search_in --------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("launch budget", '"launch"* OR "budget"*'),
        ('say "launch" now', '"say"* OR "launch"* OR "now"*'),
        ("AND OR NEAR(a b, 2)", '"AND"* OR "OR"* OR "NEAR"* OR "a"* OR "b"* OR "2"*'),
        ("budget*", '"budget"*'),
        ("col:zebra -lantern", '"col"* OR "zebra"* OR "lantern"*'),
        ("*", None),
        ('"""', None),
        ("   ", None),
    ],
)
def test_match_query_quotes_every_token_and_keeps_operators_literal(text: str, expected: str | None) -> None:
    assert questions.match_query(text) == expected


def test_search_in_only_returns_the_given_meetings(client: TestClient) -> None:
    first = note(client, "Fictional first", "Zebra lantern notes.")
    second = note(client, "Fictional second", "Zebra notes too.")
    db = client.app.state.ctx.store.db  # type: ignore[attr-defined]
    meetings = {row["meeting_id"] for row in questions.search_in(db, [first, second], "zebra", 10)}
    assert meetings == {first, second}
    assert {row["meeting_id"] for row in questions.search_in(db, [first], "zebra", 10)} == {first}
    assert questions.search_in(db, [], "zebra", 10) == []
    assert questions.search_in(db, [first], "", 10) == []


@pytest.mark.parametrize(
    "query",
    ['launch" OR "zebra', "NEAR(launch zebra, 1)", "launch*", "AND", '"', "col:zebra", "- + ( )"],
)
def test_user_text_cannot_break_the_match_grammar(client: TestClient, query: str) -> None:
    note(client, "Fictional", "Launch on Friday with zebra and budget.")
    db = client.app.state.ctx.store.db  # type: ignore[attr-defined]
    meeting = invoke(client, "list_meetings")[0]["id"]
    # Any answer is fine; what must not happen is a sqlite error from the query text.
    questions.search_in(db, [meeting], query, 10)


def test_a_deleted_meeting_is_never_retrieved(client: TestClient) -> None:
    stub = Stub(lambda r: reply("Launch is Friday [M1]."))
    configure(client, stub)
    kept = note(client, "Fictional kept", "Launch on Friday.")
    gone = note(client, "Fictional gone", "Codeword zebra lantern.")
    db = client.app.state.ctx.store.db  # type: ignore[attr-defined]
    assert questions.search_in(db, [gone], "zebra lantern", 10)
    invoke(client, "delete_meeting", id=gone)
    assert questions.search_in(db, [kept, gone], "zebra lantern", 10) == []
    invoke(client, "ask_library", scope={"kind": "all"}, question="When is launch?")
    body = stub.bodies()[0]
    assert "zebra" not in body and "Codeword" not in body and "Launch on Friday" in body


# ---- scoped Ask ----------------------------------------------------------------------------------


def test_ask_scope_folder_sends_only_that_folder_and_stores_the_scope(client: TestClient) -> None:
    stub = Stub(lambda r: reply("Launch is Friday [M1]."))
    configure(client, stub)
    inside = note(client, "Fictional inside", "Launch on Friday.")
    outside = note(client, "Fictional outside", "Secret outside budget.")
    folder = make_folder(client, "Client")
    invoke(client, "move_meeting_to_folder", meeting_id=inside, folder_id=folder)
    answer = invoke(client, "ask_library", scope={"kind": "folder", "id": folder}, question="When is launch?")
    assert answer["meeting_ids"] == [inside] and outside not in answer["meeting_ids"]
    assert answer["scope"] == {"kind": "folder", "id": folder, "label": "Folder: Client"}
    body = stub.bodies()[0]
    assert "Launch on Friday" in body and "Secret" not in body
    listed = invoke(client, "list_library_answers")
    assert listed[0]["scope"] == answer["scope"] and listed[0]["meeting_ids"] == [inside]


def test_ask_scope_tag_matches_case_insensitively(client: TestClient) -> None:
    configure(client, Stub(lambda r: reply("Budget agreed [M1].")))
    first = note(client, "Fictional first", "Budget notes.")
    second = note(client, "Fictional second", "Budget notes too.")
    other = note(client, "Fictional other", "Budget notes three.")
    invoke(client, "set_meeting_tags", meeting_id=first, tags=["Client"])
    invoke(client, "set_meeting_tags", meeting_id=second, tags=["client", "Q4"])
    answer = invoke(client, "ask_library", scope={"kind": "tag", "id": "CLIENT"}, question="Budget?")
    assert sorted(answer["meeting_ids"]) == sorted([first, second]) and other not in answer["meeting_ids"]
    assert answer["scope"] == {"kind": "tag", "id": "CLIENT", "label": "Tag: CLIENT"}


def test_ask_scope_all_and_selected_meetings(client: TestClient) -> None:
    configure(client, Stub(lambda r: reply("Yes [M1].")))
    first = note(client, "Fictional first", "Budget notes.")
    second = note(client, "Fictional second", "Budget notes too.")
    everything = invoke(client, "ask_library", scope={"kind": "all"}, question="Budget?")
    assert sorted(everything["meeting_ids"]) == sorted([first, second])
    assert everything["scope"] == {"kind": "all", "id": None, "label": "All meetings"}
    picked = invoke(client, "ask_library", scope={"kind": "meetings", "meeting_ids": [second]}, question="Budget?")
    assert picked["meeting_ids"] == [second]
    assert picked["scope"] == {"kind": "meetings", "id": None, "label": "Selected meetings"}


def test_explicit_ids_still_work_and_store_no_scope(client: TestClient) -> None:
    configure(client, Stub(lambda r: reply("Yes [M1].")))
    meeting = note(client, "Fictional", "Budget notes.")
    answer = invoke(client, "ask_library", meeting_ids=[meeting], question="Budget?")
    assert answer["meeting_ids"] == [meeting] and answer["scope"] is None
    assert invoke(client, "list_library_answers")[0]["scope"] is None


def test_scope_refusals_send_nothing(client: TestClient) -> None:
    stub = Stub(lambda r: reply("x"))
    configure(client, stub)
    cases: list[tuple[dict[str, Any], str]] = [
        ({"scope": {"kind": "nope"}}, "invalid_scope"),
        ({"scope": {"kind": "folder", "id": "missing"}}, "invalid_scope"),
        ({"scope": {"kind": "folder"}}, "invalid_scope"),
        ({"scope": {"kind": "tag", "id": "nothing-here"}}, "invalid_scope"),
        ({"scope": {"kind": "all"}}, "invalid_scope"),
        ({"scope": {"kind": "meetings"}}, "invalid_scope"),
        ({"scope": {"kind": "meetings", "meeting_ids": []}}, "invalid_scope"),
        ({}, "invalid_scope"),
        ({"meeting_ids": ["a"], "scope": {"kind": "all"}}, "invalid_args"),
    ]
    for args, code in cases:
        status, body = invoke_error(client, "ask_library", question="Budget?", **args)
        assert body["code"] == code, args
    for index in range(21):
        note(client, f"Fictional {index}", "Budget.")
    status, body = invoke_error(client, "ask_library", scope={"kind": "all"}, question="Budget?")
    assert body["code"] == "invalid_scope"
    assert stub.requests == []


def test_scoped_excerpts_come_from_the_search_index_for_the_scope_only(client: TestClient) -> None:
    stub = Stub(lambda r: reply("The budget is 500 euros [M1]."))
    configure(client, stub)
    inside = note(client, "Fictional inside", "")
    outside = note(client, "Fictional outside", "")
    db = client.app.state.ctx.store.db  # type: ignore[attr-defined]
    texts = [f"Filler line {index} about routine planning details." for index in range(4000)]
    texts[2000] = "The launch budget is 500 euros."
    add_segments(db, inside, texts)
    add_segments(db, outside, ["The launch budget is 900 dollars."])
    folder = make_folder(client, "Client")
    invoke(client, "move_meeting_to_folder", meeting_id=inside, folder_id=folder)
    answer = invoke(client, "ask_library", scope={"kind": "folder", "id": folder}, question="What is the launch budget?")
    assert answer["meeting_ids"] == [inside]
    body = stub.bodies()[0]
    assert "500 euros" in body and "900 dollars" not in body
    assert "Filler line 1 " not in body


def test_scoped_question_with_no_indexed_match_sends_nothing(client: TestClient) -> None:
    stub = Stub(lambda r: reply("x"))
    configure(client, stub)
    meeting = note(client, "Fictional", "")
    db = client.app.state.ctx.store.db  # type: ignore[attr-defined]
    add_segments(db, meeting, [f"Filler line {index} about routine planning." for index in range(4000)])
    status, body = invoke_error(client, "ask_library", scope={"kind": "all"}, question="Zebra?")
    assert body["code"] == "insufficient_evidence"
    assert stub.requests == []
