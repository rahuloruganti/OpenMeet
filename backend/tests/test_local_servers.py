"""Local AI server detection against stub servers on 127.0.0.1 at different ports. No other network.

Rules checked: only GET /v1/models, no credentials, no redirects, a 2-second
timeout, a 4 MiB cap, and a server is reported only when it lists models or answers 401/403 (needs key).
"""

from __future__ import annotations

import socket
import time
from typing import Any

import pytest
from fastapi.testclient import TestClient

from conftest import invoke
from openmeet_py.domain import connections
from stub_http import reply, serve  # noqa: F401  (serve is the stub-server fixture)

LISTING = b'{"data":[{"id":"llama3"},{"id":"bad id"},{"id":"whisper-1"},{"id":"llama3"}]}'
SEEN_AUTH: list[Any] = []


def models_route(body: bytes = LISTING, status: int = 200):
    def route(handler) -> None:
        SEEN_AUTH.append(handler.headers.get("Authorization"))
        reply(handler, status, body)

    return route


def free_closed_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def test_the_default_targets_are_the_loopback_ports_and_kinds_in_order() -> None:
    assert connections.LOCAL_SERVERS == (
        ("Ollama", 11434, "chat"),
        ("LM Studio", 1234, "chat"),
        ("Unsloth Studio", 8888, "chat"),
        ("speaches", 8000, "speech"),
        ("LocalAI", 8080, "both"),
    )


def test_answering_servers_are_reported_in_target_order_with_their_listed_models(serve) -> None:
    chat = serve({"/v1/models": models_route()})
    speech = serve({"/v1/models": models_route(b'{"data":[{"id":"whisper-1"}]}')})
    locked = serve({"/v1/models": models_route(b"", 401)})
    forbidden = serve({"/v1/models": models_route(b"", 403)})
    found = connections.probe_local_servers(
        (
            ("Chat", chat.port, "chat"),
            ("Speech", speech.port, "speech"),
            ("Locked", locked.port, "chat"),
            ("Forbidden", forbidden.port, "both"),
        ),
    )
    assert [item["name"] for item in found] == ["Chat", "Speech", "Locked", "Forbidden"]
    assert found[0] == {
        "name": "Chat", "base_url": f"http://127.0.0.1:{chat.port}/v1", "kind": "chat", "needs_key": False,
        "models": [{"id": "llama3"}, {"id": "whisper-1"}],  # sorted, de-duplicated, invalid ids dropped
    }
    assert found[1]["kind"] == "speech" and found[1]["models"] == [{"id": "whisper-1"}]
    assert found[2]["needs_key"] is True and found[2]["models"] == []
    assert found[3]["needs_key"] is True and found[3]["kind"] == "both"


def test_servers_that_do_not_answer_usably_are_skipped(serve) -> None:
    servers = {
        "Rate": serve({"/v1/models": models_route(b"", 429)}),
        "Redirect": serve({
            "/v1/models": lambda h: reply(h, 302, b"", {"Location": "/v1/other"}),
            "/v1/other": models_route(),
        }),
        "NotJson": serve({"/v1/models": models_route(b"not json at all")}),
        "HasMore": serve({"/v1/models": models_route(b'{"data":[],"has_more":true}')}),
        "NoData": serve({"/v1/models": models_route(b'{"items":[]}')}),
        "Error": serve({"/v1/models": models_route(b"{}", 500)}),
    }
    found = connections.probe_local_servers(tuple((name, s.port, "chat") for name, s in servers.items()))
    assert found == []
    assert "/v1/other" not in servers["Redirect"].hits  # the redirect was refused, not followed


def test_a_closed_port_is_skipped_without_an_error(serve) -> None:
    found = connections.probe_local_servers((("Closed", free_closed_port(), "chat"),))
    assert found == []


def test_an_oversize_listing_is_skipped(serve) -> None:
    big = b'{"data":[' + b'{"id":"x"},' * (4 * 1024 * 1024 // 11 + 100) + b'{"id":"x"}]}'
    assert len(big) > 4 * 1024 * 1024
    stub = serve({"/v1/models": models_route(big)})
    assert connections.probe_local_servers((("Big", stub.port, "chat"),)) == []


def test_a_server_that_stalls_is_cut_off_at_the_two_second_timeout(serve) -> None:
    def stall(handler) -> None:
        time.sleep(4)
        reply(handler, 200, LISTING)

    stub = serve({"/v1/models": stall})
    started = time.monotonic()
    found = connections.probe_local_servers((("Stalled", stub.port, "chat"),))
    assert found == []
    assert time.monotonic() - started < 3.5


def test_probes_send_no_credentials(serve) -> None:
    SEEN_AUTH.clear()
    stub = serve({"/v1/models": models_route()})
    connections.probe_local_servers((("Chat", stub.port, "chat"),))
    assert SEEN_AUTH == [None]


def test_the_command_returns_the_local_server_shape_for_the_targets_it_is_given(
    client: TestClient, serve, monkeypatch: pytest.MonkeyPatch
) -> None:
    stub = serve({"/v1/models": models_route(b'{"data":[{"id":"llama3"}]}')})
    monkeypatch.setattr(connections, "LOCAL_SERVERS", (("Chat", stub.port, "chat"),))
    servers = invoke(client, "detect_local_servers")
    assert servers == [{
        "name": "Chat",
        "base_url": f"http://127.0.0.1:{stub.port}/v1",
        "kind": "chat",
        "needs_key": False,
        "models": [{"id": "llama3"}],
    }]
