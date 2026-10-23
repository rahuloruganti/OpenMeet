"""The window close guard: close now, ask the page, or never trap the user.

A real pywebview window cannot be opened here, so these tests drive the handler that
`run_window` registers on `window.events.closing` with fake window/hub objects.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from conftest import TOKEN
from openmeet_py.api.server import create_app
from openmeet_py.app import CLOSE_ANSWER_TIMEOUT, CloseGuard


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class Recorder:
    def __init__(self) -> None:
        self.events: list[tuple[str, Any]] = []
        self.clients = 1

    def client_count(self) -> int:
        return self.clients

    def emit(self, event: str, payload: Any) -> None:
        self.events.append((event, payload))


def build(clock: FakeClock | None = None, clients: int = 1) -> tuple[CloseGuard, Recorder, FakeClock]:
    recorder = Recorder()
    recorder.clients = clients
    clock = clock or FakeClock()
    return CloseGuard(recorder.client_count, recorder.emit, clock), recorder, clock


def test_no_page_connected_closes_without_asking() -> None:
    guard, recorder, _clock = build(clients=0)

    assert guard.closing() is True
    assert recorder.events == []


def test_a_connected_page_is_asked_before_the_window_closes() -> None:
    guard, recorder, _clock = build()

    assert guard.closing() is False
    assert recorder.events == [("request_close", None)]


def test_the_ui_driven_close_is_not_asked_again() -> None:
    # close_application reaches the window through ctx.close_window, which sets this flag first.
    guard, recorder, _clock = build()
    assert guard.closing() is False
    recorder.events.clear()

    guard.allow()

    assert guard.closing() is True
    assert recorder.events == []


def test_a_second_close_before_the_timeout_asks_again() -> None:
    guard, recorder, clock = build()
    assert guard.closing() is False

    clock.now += CLOSE_ANSWER_TIMEOUT - 1.0
    assert guard.closing() is False
    assert len(recorder.events) == 2


def test_a_second_close_after_the_timeout_goes_through() -> None:
    guard, recorder, clock = build()
    assert guard.closing() is False

    clock.now += CLOSE_ANSWER_TIMEOUT
    assert guard.closing() is True
    assert len(recorder.events) == 1


def test_the_hub_counts_the_page_connection(tmp_path) -> None:
    # The guard's first rule depends on this count: no connected page, no question.
    app = create_app(tmp_path / "data", None, token=TOKEN)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        assert app.state.hub.client_count() == 0
        with client.websocket_connect(f"/ws?token={TOKEN}", headers={"host": "127.0.0.1"}):
            assert app.state.hub.client_count() == 1
        assert app.state.hub.client_count() == 0

    guard = CloseGuard(app.state.hub.client_count, app.state.hub.emit)
    assert guard.closing() is True
