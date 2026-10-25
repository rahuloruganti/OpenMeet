"""Phase 2: provider connections, keys, model discovery, summaries, questions, tasks, library, rewrite.

Every provider call goes through httpx.MockTransport. No real network, no real key, no real keychain.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

import httpx
import pytest
from fastapi.testclient import TestClient

from conftest import MemoryKeyring, invoke, invoke_error
from openmeet_py.domain import llm, providers

SECRET = "sk-synthetic-secret-value-123"
LOCAL = "http://127.0.0.1:1234/v1"
SUMMARY = (
    "## Summary\nFictional planning call.\n\n## Key points\n- Budget agreed\n\n"
    "## Decisions\n- Ship on Friday\n\n## Action items\n- Send the draft\n- Book the room\n"
)


class Stub:
    """Scripted provider: each call gets the next response; every request is recorded."""

    def __init__(self, *responses: Callable[[httpx.Request], httpx.Response]) -> None:
        self.responses = list(responses)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if len(self.requests) > len(self.responses):
            return reply(SUMMARY)
        return self.responses[len(self.requests) - 1](request)

    def bodies(self) -> list[str]:
        """The user message of each request, decoded (so quotes and newlines are real characters)."""
        return [json.loads(request.content)["messages"][1]["content"] for request in self.requests]


def reply(text: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": text}}]})


def models(*ids: str) -> httpx.Response:
    return httpx.Response(200, json={"data": [{"id": model_id} for model_id in ids]})


def refused(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("refused")


def connect(client: TestClient, base: str = LOCAL, key: Any = None, name: str = "Local") -> dict:
    change = {"kind": "remove"} if key is None else {"kind": "replace", "key": key}
    return invoke(
        client, "save_api_connection", id=None, name=name, baseUrl=base,
        keyChange=change, expectedRevision=None,
    )


def assign(client: TestClient, connection_id: str, model: str = "local-model") -> dict:
    return invoke(
        client, "save_provider_assignment", role="llm",
        selection={"kind": "assigned", "connection_id": connection_id, "model": model},
        expectedRevision=None,
    )


def configure(client: TestClient, transport: Callable[[httpx.Request], httpx.Response]) -> str:
    """A loopback connection with no key and a model assigned; requests go to the stub."""
    settings = connect(client)
    connection_id = settings["saved_connections"][0]["id"]
    assign(client, connection_id)
    client.app.state.ctx.transport = httpx.MockTransport(transport)  # type: ignore[attr-defined]
    return connection_id


def note(client: TestClient, title: str, markdown: str) -> str:
    meeting_id = invoke(client, "create_note", title=title)
    invoke(client, "save_notes", id=meeting_id, markdown=markdown, expected_revision=0)
    return meeting_id


# ---- URLs, models and connections -------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "http://provider.example/v1",
        "https://user:pw@provider.example/v1",
        "https://provider.example/v1?key=x",
        "https://provider.example/v1#frag",
        "file:///secret",
        "https://provider.example/line\nbreak",
        "https:///missing-host",
        "https://provider.example:notaport/v1",
        "http://192.168.1.2/v1",
    ],
)
def test_unsafe_base_urls_are_refused(url: str) -> None:
    with pytest.raises(Exception) as caught:
        providers.validate_base_url(url)
    assert getattr(caught.value, "code", None) == "provider_url"
    assert "pw" not in str(caught.value) and "key=x" not in str(caught.value)


def test_base_url_normalises_and_loopback_may_use_http() -> None:
    assert providers.validate_base_url(" https://provider.example/custom/v1/ ") == (
        "https://provider.example/custom/v1"
    )
    assert providers.validate_base_url("http://[::1]:11434/v1") == "http://[::1]:11434/v1"
    assert providers.is_local_base("http://localhost:1234/v1")
    assert not providers.is_local_base("http://localhost.example/v1")


def test_model_ids_are_checked_for_length_and_whitespace() -> None:
    for bad in ["", "with space", "line\nbreak", "x" * 257]:
        with pytest.raises(Exception) as caught:
            providers.validate_model(bad)
        assert caught.value.code == "provider_model"  # type: ignore[attr-defined]
    providers.validate_model("unlisted/custom-model")


def test_saved_connection_key_is_stored_only_in_the_keyring(
    client: TestClient, memory_keyring: MemoryKeyring, caplog: pytest.LogCaptureFixture
) -> None:
    settings = connect(client, base="https://provider.example/v1", key=SECRET, name="Cloud")
    connection = settings["saved_connections"][0]
    assert connection == {
        "id": connection["id"],
        "name": "Cloud",
        "base_url": "https://provider.example/v1",
        "revision": 1,
    }
    assert invoke(client, "api_connection_key_status", id=connection["id"]) == "present"
    assert invoke(client, "provider_key_status", role="llm") == "missing"  # not assigned yet
    assert list(memory_keyring.items.values()) == [SECRET]
    assert list(memory_keyring.items)[0][0] == "OpenMeetPy"

    responses = json.dumps([settings, invoke(client, "get_settings")])
    dump = "\n".join(client.app.state.ctx.store.db.iterdump())  # type: ignore[attr-defined]
    assert SECRET not in responses and SECRET not in dump and SECRET not in caplog.text


def test_changing_the_destination_needs_a_new_key_unless_loopback(client: TestClient) -> None:
    saved = connect(client, base="https://one.example/v1", key=SECRET, name="Cloud")
    cid = saved["saved_connections"][0]["id"]
    code = invoke_error(
        client, "save_api_connection", id=cid, name="Cloud", baseUrl="https://two.example/v1",
        keyChange={"kind": "keep"}, expectedRevision=1,
    )
    assert code[1]["code"] == "provider_key"
    code = invoke_error(
        client, "save_api_connection", id=cid, name="Cloud", baseUrl="https://two.example/v1",
        keyChange={"kind": "remove"}, expectedRevision=1,
    )
    assert code[1]["code"] == "provider_key_required"
    moved = invoke(
        client, "save_api_connection", id=cid, name="Cloud", baseUrl="https://two.example/v1",
        keyChange={"kind": "replace", "key": "sk-synthetic-second"}, expectedRevision=1,
    )
    assert moved["saved_connections"][0]["revision"] == 2
    local = invoke(
        client, "save_api_connection", id=cid, name="Cloud", baseUrl=LOCAL,
        keyChange={"kind": "keep"}, expectedRevision=2,
    )
    assert local["saved_connections"][0]["base_url"] == LOCAL


def test_stale_revisions_are_refused_and_nothing_changes(client: TestClient) -> None:
    saved = connect(client)
    cid = saved["saved_connections"][0]["id"]
    status, body = invoke_error(
        client, "save_api_connection", id=cid, name="Renamed", baseUrl=LOCAL,
        keyChange={"kind": "remove"}, expectedRevision=7,
    )
    assert (status, body["code"]) == (400, "processing_plan_changed")
    assert invoke(client, "get_settings")["saved_connections"][0]["name"] == "Local"


def test_assignment_and_delete_rules_use_revisions(client: TestClient) -> None:
    cid = connect(client)["saved_connections"][0]["id"]
    settings = assign(client, cid)
    assert settings["provider_assignments"]["llm"]["revision"] == 1
    assert settings["llm"] == {"base_url": LOCAL, "model": "local-model", "revision": 1}
    assert invoke(client, "provider_key_status", role="llm") == "missing"  # loopback, no key
    status, body = invoke_error(
        client, "delete_api_connection", id=cid, expectedRevision=1
    )
    assert body["code"] == "provider_assigned"
    status, body = invoke_error(
        client, "save_provider_assignment", role="llm",
        selection={"kind": "unassigned"}, expectedRevision=0,
    )
    assert body["code"] == "provider_conflict"
    cleared = invoke(
        client, "save_provider_assignment", role="llm",
        selection={"kind": "unassigned"}, expectedRevision=1,
    )
    assert cleared["llm"] is None
    deleted = invoke(client, "delete_api_connection", id=cid, expectedRevision=1)
    assert deleted["saved_connections"] == []


def test_deleting_a_keyed_connection_removes_its_credential(
    client: TestClient, memory_keyring: MemoryKeyring
) -> None:
    cid = connect(client, base="https://provider.example/v1", key=SECRET)["saved_connections"][0]["id"]
    assert memory_keyring.items
    invoke(client, "delete_api_connection", id=cid, expectedRevision=1)
    assert memory_keyring.items == {}


def test_model_discovery_sends_bearer_key_and_sorts_ids(client: TestClient) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return models("z/model", "a", "a", "bad id")

    cid = connect(client, base="https://provider.example/custom/v1", key=SECRET)["saved_connections"][0]["id"]
    client.app.state.ctx.transport = httpx.MockTransport(handler)  # type: ignore[attr-defined]
    found = invoke(client, "list_api_connection_models", id=cid, expectedRevision=1)
    assert found == [{"id": "a"}, {"id": "z/model"}]
    assert len(seen) == 1
    assert str(seen[0].url) == "https://provider.example/custom/v1/models"
    assert seen[0].headers["authorization"] == f"Bearer {SECRET}"


def test_anthropic_discovery_uses_its_key_header_and_one_large_page(client: TestClient) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200, json={"data": [{"id": "claude-fictional-1", "type": "model"}], "has_more": False}
        )

    cid = connect(client, base="https://api.anthropic.com/v1", key=SECRET, name="Claude")["saved_connections"][0]["id"]
    client.app.state.ctx.transport = httpx.MockTransport(handler)  # type: ignore[attr-defined]
    found = invoke(client, "list_api_connection_models", id=cid, expectedRevision=1)
    assert found == [{"id": "claude-fictional-1"}]
    assert str(seen[0].url) == "https://api.anthropic.com/v1/models?limit=1000"
    assert seen[0].headers["x-api-key"] == SECRET
    assert seen[0].headers["anthropic-version"] == "2023-06-01"
    assert "authorization" not in seen[0].headers


def test_anthropic_chat_keeps_the_bearer_key(client: TestClient) -> None:
    connection = providers.Connection(
        "https://api.anthropic.com/v1", "claude-fictional-1", SECRET,
        httpx.MockTransport(lambda request: reply("ok")),
    )
    assert connection.headers() == {"Authorization": f"Bearer {SECRET}"}
    assert providers.chat_completion(connection, b"{}") == "ok"


def test_gemini_model_ids_drop_the_models_prefix(client: TestClient) -> None:
    cid = connect(
        client, base="https://generativelanguage.googleapis.com/v1beta/openai", key=SECRET, name="Gemini"
    )["saved_connections"][0]["id"]
    client.app.state.ctx.transport = httpx.MockTransport(  # type: ignore[attr-defined]
        lambda request: models("models/gemini-fictional-pro", "models/gemini-fictional-flash")
    )
    found = invoke(client, "list_api_connection_models", id=cid, expectedRevision=1)
    assert found == [{"id": "gemini-fictional-flash"}, {"id": "gemini-fictional-pro"}]


def test_testing_a_typed_key_lists_models_and_stores_nothing(
    client: TestClient, memory_keyring: MemoryKeyring
) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return models("m-2", "m-1")

    client.app.state.ctx.transport = httpx.MockTransport(handler)  # type: ignore[attr-defined]
    found = invoke(client, "test_api_connection", baseUrl="https://provider.example/v1", key=SECRET, id=None)
    assert found == [{"id": "m-1"}, {"id": "m-2"}]
    assert seen[0].headers["authorization"] == f"Bearer {SECRET}"
    assert memory_keyring.items == {}
    assert invoke(client, "get_settings")["saved_connections"] == []


def test_testing_a_saved_connection_uses_its_key_only_for_its_own_url(client: TestClient) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return models("m-1")

    cid = connect(client, base="https://provider.example/v1", key=SECRET)["saved_connections"][0]["id"]
    client.app.state.ctx.transport = httpx.MockTransport(handler)  # type: ignore[attr-defined]
    assert invoke(client, "test_api_connection", baseUrl="https://provider.example/v1", key=None, id=cid) == [
        {"id": "m-1"}
    ]
    assert seen[0].headers["authorization"] == f"Bearer {SECRET}"
    # A changed destination never receives the saved key.
    _, body = invoke_error(client, "test_api_connection", baseUrl="https://other.example/v1", key=None, id=cid)
    assert body["code"] == "provider_key_missing"
    assert len(seen) == 1


def test_testing_a_rejected_key_reports_the_failure(client: TestClient) -> None:
    client.app.state.ctx.transport = httpx.MockTransport(  # type: ignore[attr-defined]
        lambda request: httpx.Response(401, json={"error": {"message": "bad key"}})
    )
    _, body = invoke_error(client, "test_api_connection", baseUrl="https://provider.example/v1", key=SECRET, id=None)
    assert body["code"] != "invalid_args"
    assert SECRET not in json.dumps(body)


def test_testing_a_loopback_server_needs_no_key(client: TestClient) -> None:
    client.app.state.ctx.transport = httpx.MockTransport(lambda request: models("local-model"))  # type: ignore[attr-defined]
    assert invoke(client, "test_api_connection", baseUrl=LOCAL, key=None, id=None) == [{"id": "local-model"}]


def test_loopback_discovery_runs_without_a_key(client: TestClient) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return models("local-model")

    cid = connect(client)["saved_connections"][0]["id"]
    client.app.state.ctx.transport = httpx.MockTransport(handler)  # type: ignore[attr-defined]
    assert invoke(client, "list_api_connection_models", id=cid, expectedRevision=1) == [
        {"id": "local-model"}
    ]
    assert "authorization" not in seen[0].headers


@pytest.mark.parametrize(
    ("handler", "code"),
    [
        (lambda r: httpx.Response(401, text="secret body"), "provider_unauthorized"),
        (lambda r: httpx.Response(429), "provider_rate_limited"),
        (lambda r: httpx.Response(500, text="raw secret body"), "provider_response"),
        (lambda r: httpx.Response(302, headers={"location": "http://127.0.0.1:9/steal"}), "provider_response"),
        (lambda r: httpx.Response(200, text="not json"), "provider_models"),
        (lambda r: httpx.Response(200, json={"data": [{"id": "m"}], "has_more": True}), "provider_models"),
        (lambda r: httpx.Response(200, content=b"x" * (4 * 1024 * 1024 + 1)), "provider_models"),
        (refused, "provider_unreachable"),
    ],
)
def test_discovery_errors_are_coded_and_never_echo_the_body(
    client: TestClient, handler: Callable[[httpx.Request], httpx.Response], code: str
) -> None:
    stub = Stub(handler)
    cid = connect(client, base="https://provider.example/v1", key=SECRET)["saved_connections"][0]["id"]
    client.app.state.ctx.transport = httpx.MockTransport(stub)  # type: ignore[attr-defined]
    status, body = invoke_error(client, "list_api_connection_models", id=cid, expectedRevision=1)
    assert body["code"] == code
    assert "secret body" not in body["message"] and SECRET not in body["message"]
    assert len(stub.requests) == 1, "discovery must not retry"


# ---- summaries ---------------------------------------------------------------


def test_summary_is_saved_with_provider_model_and_template(client: TestClient) -> None:
    stub = Stub(lambda r: reply(SUMMARY))
    configure(client, stub)
    meeting = note(client, "Fictional planning", "Budget and launch date.")
    invoke(client, "generate_summary", id=meeting, template="general-v1")
    detail = invoke(client, "get_meeting", id=meeting)
    assert detail["summary"] == SUMMARY.strip()
    assert detail["summary_provider"] == LOCAL
    assert detail["summary_model"] == "local-model"
    assert detail["summary_template"] == "general-v1"
    assert detail["summary_edited"] is False and detail["summary_stale"] is False
    body = json.loads(stub.requests[0].content)
    assert body["model"] == "local-model"
    assert "Budget and launch date." in body["messages"][1]["content"]
    assert "untrusted data" in body["messages"][0]["content"]


def test_every_ai_request_asks_local_ai_to_be_ready_before_sending(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from openmeet_py.local_ai import service as local_ai

    stub = Stub(lambda r: reply(SUMMARY), lambda r: reply("Shorter."))
    order: list[str] = []
    monkeypatch.setattr(
        local_ai, "ensure_ready", lambda _ctx, config: order.append(f"ready {config['base_url']} {len(stub.requests)}")
    )
    configure(client, stub)
    meeting = note(client, "Fictional planning", "Budget and launch date.")
    invoke(client, "generate_summary", id=meeting, template="general-v1")
    invoke(client, "rewrite_text", text="A long sentence here.", request="Make it shorter")
    # Each call readies the assigned connection before its request goes out.
    assert order == [f"ready {LOCAL} 0", f"ready {LOCAL} 1"]


def test_no_request_is_retried_after_a_provider_error(client: TestClient) -> None:
    stub = Stub(lambda r: httpx.Response(500, text="nope"))
    configure(client, stub)
    meeting = note(client, "Fictional", "Something to summarise.")
    status, body = invoke_error(client, "generate_summary", id=meeting, template="general-v1")
    assert body["code"] == "provider_response"
    assert len(stub.requests) == 1
    assert invoke(client, "list_summaries", id=meeting) == []


def test_refuses_to_save_when_notes_changed_mid_request(client: TestClient) -> None:
    db = client.app.state.ctx.store.db  # type: ignore[attr-defined]

    def change_notes_then_answer(request: httpx.Request) -> httpx.Response:
        db.execute("UPDATE notes SET revision = revision + 1 WHERE meeting_id = ?1", (meeting,))
        return reply(SUMMARY)

    configure(client, change_notes_then_answer)
    meeting = note(client, "Fictional", "First version.")
    status, body = invoke_error(client, "generate_summary", id=meeting, template="general-v1")
    assert body["code"] == "processing_plan_changed"
    assert db.execute("SELECT COUNT(*) FROM summaries").fetchone()[0] == 0


def test_refuses_when_the_provider_changed_mid_request(client: TestClient) -> None:
    db = client.app.state.ctx.store.db  # type: ignore[attr-defined]

    def swap_provider_then_answer(request: httpx.Request) -> httpx.Response:
        db.execute("UPDATE provider_assignments SET revision = revision + 1")
        return reply(SUMMARY)

    configure(client, swap_provider_then_answer)
    meeting = note(client, "Fictional", "Notes.")
    status, body = invoke_error(client, "generate_summary", id=meeting, template="general-v1")
    assert body["code"] == "processing_plan_changed"
    assert db.execute("SELECT COUNT(*) FROM summaries").fetchone()[0] == 0


def test_speaker_name_change_marks_the_summary_stale(client: TestClient) -> None:
    configure(client, Stub(lambda r: reply(SUMMARY)))
    meeting = note(client, "Fictional", "Notes.")
    db = client.app.state.ctx.store.db  # type: ignore[attr-defined]
    # Names only change summary freshness through transcript lines, so a segment must exist.
    db.execute(
        "INSERT INTO segments(meeting_id, speaker, start_ms, end_ms, text, source, pass) "
        "VALUES (?1, 'You', 0, 1000, 'Hello team', 'fixture', 'final')",
        (meeting,),
    )
    invoke(client, "generate_summary", id=meeting, template="general-v1")
    assert invoke(client, "get_meeting", id=meeting)["summary_stale"] is False
    invoke(client, "save_speaker_names", meeting_id=meeting, you="Ana", others=None)
    assert invoke(client, "get_meeting", id=meeting)["summary_stale"] is True
    assert invoke(client, "list_summaries", id=meeting)[0]["stale"] is True


def test_edited_summary_conflicts_and_keeps_history(client: TestClient) -> None:
    configure(client, Stub(lambda r: reply(SUMMARY), lambda r: reply("## Summary\nSecond.")))
    meeting = note(client, "Fictional", "Notes.")
    invoke(client, "generate_summary", id=meeting, template="general-v1")
    first = invoke(client, "list_summaries", id=meeting)[0]["id"]
    invoke(client, "generate_summary", id=meeting, template="general-v1")
    latest = invoke(client, "list_summaries", id=meeting)[0]["id"]
    status, body = invoke_error(
        client, "save_summary_edit", meeting_id=meeting, base_id=first,
        expected_latest_id=first, markdown="Edited",
    )
    assert body["code"] == "summary_conflict"
    invoke(
        client, "save_summary_edit", meeting_id=meeting, base_id=latest,
        expected_latest_id=latest, markdown=SUMMARY + "\n",
    )
    versions = invoke(client, "list_summaries", id=meeting)
    assert versions[0]["edited_from"] == latest and len(versions) == 3
    detail = invoke(client, "get_meeting", id=meeting)
    assert detail["summary_edited"] is True
    status, body = invoke_error(
        client, "save_summary_edit", meeting_id=meeting, base_id=versions[0]["id"],
        expected_latest_id=versions[0]["id"], markdown=versions[0]["markdown"],
    )
    assert body["code"] == "summary_edit"


def test_custom_template_and_personal_instructions_reach_the_prompt(client: TestClient) -> None:
    stub = Stub(lambda r: reply(SUMMARY))
    configure(client, stub)
    invoke(client, "save_summary_instructions", instructions="Use British spelling.")
    template = invoke(
        client, "save_summary_template", id=None, name="Sprint", instructions="## Goals\n## Risks"
    )["summary_templates"][0]["id"]
    meeting = note(client, "Fictional", "Notes.")
    invoke(client, "generate_summary", id=meeting, template=template)
    system = json.loads(stub.requests[0].content)["messages"][0]["content"]
    assert "## Goals" in system and "Use British spelling." in system
    assert system.index("## Goals") < system.index("untrusted data")


def test_long_notes_with_a_long_transcript_are_refused_before_sending() -> None:
    lines = ["[0:00] You: " + "a" * 1000] * 90
    with pytest.raises(Exception) as caught:
        llm.plan_chunks("n" * 50_000, lines)
    assert caught.value.code == "summary_too_long"  # type: ignore[attr-defined]


def test_long_transcripts_are_chunked_with_one_merge_request() -> None:
    stub = Stub(*[lambda r: reply("partial")] * 3, lambda r: reply(SUMMARY))
    connection = providers.Connection("http://127.0.0.1:1/v1", "m", "", httpx.MockTransport(stub))
    lines = [f"[0:0{i}] You: " + "w" * 50_000 for i in range(3)]
    assert llm.summary_requests("", lines) == 4
    text = llm.summarize(connection, "system", "", lines, lambda _body: None)
    assert text == SUMMARY.strip()
    assert len(stub.requests) == 4
    assert "<partial>\npartial\n</partial>" in stub.bodies()[-1]


def test_oversize_chat_response_is_rejected(client: TestClient) -> None:
    configure(client, lambda r: httpx.Response(200, content=b"{" + b" " * (2 * 1024 * 1024 + 8)))
    meeting = note(client, "Fictional", "Notes.")
    status, body = invoke_error(client, "generate_summary", id=meeting, template="general-v1")
    assert body["code"] == "provider_response"


def test_summary_needs_a_saved_connection_and_model(client: TestClient) -> None:
    meeting = note(client, "Fictional", "Notes.")
    status, body = invoke_error(client, "generate_summary", id=meeting, template="general-v1")
    assert body["code"] == "provider_missing"
    cid = connect(client)["saved_connections"][0]["id"]
    assign_settings = invoke(
        client, "save_provider_assignment", role="llm",
        selection={"kind": "assigned", "connection_id": cid, "model": "m"}, expectedRevision=None,
    )
    assert assign_settings["llm"]["model"] == "m"


def test_defaults_and_templates_are_validated(client: TestClient) -> None:
    status, body = invoke_error(client, "save_summary_default", template="custom-missing")
    assert body["code"] == "summary_template_missing"
    status, body = invoke_error(client, "save_processing_default", mode="sometimes", summary=None)
    assert body["code"] == "processing_default"
    settings = invoke(client, "save_processing_default", mode="final", summary="standup-v1")
    assert (settings["processing_mode"], settings["processing_summary"]) == ("final", "standup-v1")
    status, body = invoke_error(client, "save_summary_template", id=None, name="   ", instructions="x")
    assert body["code"] == "summary_template"


# ---- questions ---------------------------------------------------------------


def test_question_thread_sends_earlier_turns_and_is_saved(client: TestClient) -> None:
    stub = Stub(lambda r: reply("Friday."), lambda r: reply("Room B."))
    configure(client, stub)
    meeting = note(client, "Fictional", "We ship on Friday in room B.")
    thread = invoke(client, "ask_meeting", id=meeting, question="When do we ship?", thread_id=None)
    assert len(thread["turns"]) == 1 and thread["turns"][0]["answer"] == "Friday."
    follow = invoke(client, "ask_meeting", id=meeting, question="Where?", thread_id=thread["id"])
    assert [t["answer"] for t in follow["turns"]] == ["Friday.", "Room B."]
    second_body = stub.bodies()[1]
    assert "<previous>" in second_body and "When do we ship?" in second_body
    assert invoke(client, "get_meeting", id=meeting)["question_threads"][0]["id"] == thread["id"]
    remaining = invoke(client, "delete_question_thread", meeting_id=meeting, thread_id=thread["id"])
    assert remaining == []
    status, body = invoke_error(
        client, "delete_question_thread", meeting_id=meeting, thread_id=thread["id"]
    )
    assert body["code"] == "not_found"


def test_question_with_no_matching_passages_sends_nothing(client: TestClient) -> None:
    stub = Stub(lambda r: reply("never"))
    configure(client, stub)
    meeting = note(client, "Fictional", "alpha beta gamma " * 9000)  # over the single-request size
    status, body = invoke_error(
        client, "ask_meeting", id=meeting, question="zebra quantum?", thread_id=None
    )
    assert body["code"] == "insufficient_evidence"
    assert stub.requests == []


def test_question_excerpts_include_matching_notes_when_too_long(client: TestClient) -> None:
    stub = Stub(lambda r: reply("Budget is 5k."))
    configure(client, stub)
    notes = ("filler words " * 9000) + "\n\nThe budget is 5k for the launch.\n\n" + ("more filler " * 4000)
    meeting = note(client, "Fictional", notes)
    thread = invoke(client, "ask_meeting", id=meeting, question="What is the budget?", thread_id=None)
    assert thread["turns"][0]["answer"] == "Budget is 5k."
    assert "The budget is 5k for the launch." in stub.bodies()[0]
    assert len(stub.bodies()[0]) < 130_000


# ---- tasks -------------------------------------------------------------------


def test_action_items_import_once_and_never_duplicate_edited_or_repeated_bullets(
    client: TestClient,
) -> None:
    configure(client, Stub(lambda r: reply(SUMMARY)))
    meeting = note(client, "Fictional", "Notes.")
    invoke(client, "generate_summary", id=meeting, template="general-v1")
    summary_id = invoke(client, "list_summaries", id=meeting)[0]["id"]
    items = invoke(client, "import_action_items", meeting_id=meeting, summary_id=summary_id)
    assert [item["text"] for item in items] == ["Send the draft", "Book the room"]
    assert all(item["source"] == "summary" and item["owner"] is None for item in items)
    status, body = invoke_error(client, "import_action_items", meeting_id=meeting, summary_id=summary_id)
    assert body["code"] == "action_item"

    edited = invoke(
        client, "save_action_item", meeting_id=meeting, item_id=items[0]["id"],
        text="Send the final draft", owner="Ana", due_date="2026-10-31", done=True,
    )
    assert edited[0]["text"] == "Send the final draft" and edited[0]["done"] is True
    status, body = invoke_error(client, "import_action_items", meeting_id=meeting, summary_id=summary_id)
    assert body["code"] == "action_item"

    removed = invoke(client, "delete_action_item", meeting_id=meeting, item_id=items[1]["id"])
    assert len(removed) == 1
    again = invoke(client, "import_action_items", meeting_id=meeting, summary_id=summary_id)
    assert [item["text"] for item in again] == ["Send the final draft", "Book the room"]


def test_manual_task_validation(client: TestClient) -> None:
    meeting = note(client, "Fictional", "")
    status, body = invoke_error(
        client, "save_action_item", meeting_id=meeting, item_id=None, text="  ", owner=None,
        due_date=None, done=False,
    )
    assert body["code"] == "action_item"
    status, body = invoke_error(
        client, "save_action_item", meeting_id=meeting, item_id=None, text="Call", owner=None,
        due_date="2026-02-30", done=False,
    )
    assert body["code"] == "action_item"
    created = invoke(
        client, "save_action_item", meeting_id=meeting, item_id=None, text="Call Ana", owner=None,
        due_date="2026-10-31", done=False,
    )
    assert created[0]["source"] == "manual" and created[0]["due_date"] == "2026-10-31"


def test_summary_bullets_follow_the_action_items_rules() -> None:
    from openmeet_py.domain.tasks import summary_bullets

    markdown = (
        "## Action items\n- [ ] Ship it.\n  - nested\n1. Numbered one\n- None noted\n* Star\n"
        "## Other\n- not this\n"
    )
    assert summary_bullets(markdown) == ["Ship it.", "Numbered one", "Star"]


# ---- library -----------------------------------------------------------------


def test_library_question_cites_meetings_in_order_and_is_saved(client: TestClient) -> None:
    stub = Stub(lambda r: reply("Launch is Friday [M2]."))
    configure(client, stub)
    first = note(client, "Fictional A", "Budget notes.")
    second = note(client, "Fictional B", "Launch on Friday.")
    answer = invoke(client, "ask_library", meeting_ids=[second, first, second], question="When is launch?")
    assert answer["meeting_ids"] == [second, first]
    body = stub.bodies()[0]
    assert '<meeting ref="M1" title="Fictional B"' in body and '<meeting ref="M2" title="Fictional A"' in body
    assert [a["id"] for a in invoke(client, "list_library_answers")] == [answer["id"]]
    invoke(client, "delete_meeting", id=second)
    assert invoke(client, "list_library_answers") == []


def test_library_scope_limits_are_checked_before_sending(client: TestClient) -> None:
    stub = Stub(lambda r: reply("x"))
    configure(client, stub)
    status, body = invoke_error(client, "ask_library", meeting_ids=[], question="q")
    assert body["code"] == "invalid_scope"
    ids = [note(client, f"Fictional {i}", "n") for i in range(21)]
    status, body = invoke_error(client, "ask_library", meeting_ids=ids, question="q")
    assert body["code"] == "invalid_scope"
    assert stub.requests == []


def test_delete_library_answer_returns_the_rest(client: TestClient) -> None:
    configure(client, Stub(lambda r: reply("one"), lambda r: reply("two")))
    meeting = note(client, "Fictional", "Notes.")
    first = invoke(client, "ask_library", meeting_ids=[meeting], question="first?")
    second = invoke(client, "ask_library", meeting_ids=[meeting], question="second?")
    remaining = invoke(client, "delete_library_answer", id=first["id"])
    assert [a["id"] for a in remaining] == [second["id"]]


# ---- rewrite -----------------------------------------------------------------


def test_rewrite_sends_only_the_selection_and_the_request(client: TestClient) -> None:
    stub = Stub(lambda r: reply("Shorter sentence."))
    configure(client, stub)
    note(client, "Fictional", "Private unrelated notes about salaries.")
    result = invoke(client, "rewrite_text", text="A long sentence here.", request="Make it shorter")
    assert result == "Shorter sentence."
    body = stub.bodies()[0]
    assert "A long sentence here." in body and "Make it shorter" in body
    assert "salaries" not in body
    assert invoke(client, "list_library_answers") == []


def test_rewrite_refuses_empty_or_oversize_text_before_sending(client: TestClient) -> None:
    stub = Stub(lambda r: reply("x"))
    configure(client, stub)
    status, body = invoke_error(client, "rewrite_text", text="   ", request="shorter")
    assert body["code"] == "invalid_rewrite"
    status, body = invoke_error(client, "rewrite_text", text="x" * 20_001, request="shorter")
    assert body["code"] == "invalid_rewrite"
    assert stub.requests == []


# ---- speaker names and the registry ------------------------------------------


def test_speaker_names_are_validated_and_shown_in_labels(client: TestClient) -> None:
    meeting = note(client, "Fictional", "")
    names = invoke(client, "save_speaker_names", meeting_id=meeting, you="Ana", others="")
    assert names == {"you": "Ana", "others": None}
    status, body = invoke_error(
        client, "save_speaker_names", meeting_id=meeting, you="x" * 81, others=None
    )
    assert body["code"] == "speaker_name"
    status, body = invoke_error(client, "save_speaker_names", meeting_id="missing", you=None, others=None)
    assert body["code"] == "not_found"


def test_transcript_commands_refuse_unknown_segments_and_versions(client: TestClient) -> None:
    status, body = invoke_error(client, "edit_segment", meetingId="m", segmentId=1, baseText="a", text="b")
    assert (status, body["code"]) == (400, "segment_conflict")
    status, body = invoke_error(client, "get_transcript_version", meetingId="m", versionId=1)
    assert (status, body["code"]) == (400, "not_found")


def test_export_carries_the_real_summary_and_tasks(client: TestClient, tmp_path: Path) -> None:
    from openmeet_py.domain import exporter

    configure(client, Stub(lambda r: reply(SUMMARY)))
    meeting = note(client, "Fictional", "Notes.")
    invoke(client, "generate_summary", id=meeting, template="general-v1")
    summary_id = invoke(client, "list_summaries", id=meeting)[0]["id"]
    invoke(client, "import_action_items", meeting_id=meeting, summary_id=summary_id)
    detail = invoke(client, "get_meeting", id=meeting)
    text = exporter.render(detail, {"summary": True, "transcript": False})
    assert "No summary generated" not in text
    assert "template: \"general-v1\"" in text and "model: \"local-model\"" in text
    assert "- [ ] Send the draft — Owner: Unassigned — Due: not set — From summary" in text
    assert "## My notes" in text
