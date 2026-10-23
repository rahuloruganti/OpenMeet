"""A routed stub HTTP server on 127.0.0.1 for download and detection tests. Nothing leaves the machine.

Each route maps a request path to a function that writes the response. Every requested path is recorded
in `hits`. Tests set OPENMEET_PY_TEST_HOSTS=127.0.0.1 when they fetch from it.
"""

from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Iterator, Optional

import pytest

Route = Callable[["_Handler"], None]


def reply(handler: BaseHTTPRequestHandler, status: int, body: bytes = b"", headers: Optional[dict[str, str]] = None) -> None:
    handler.send_response(status)
    for name, value in (headers or {}).items():
        handler.send_header(name, value)
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Connection", "close")
    handler.end_headers()
    handler.wfile.write(body)
    handler.close_connection = True


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:  # keep test output quiet
        pass

    def do_GET(self) -> None:
        server: RoutedServer = self.server  # type: ignore[assignment]
        server.hits.append(self.path)
        route = server.routes.get(self.path.split("?", 1)[0])
        if route is None:
            reply(self, 404)
            return
        route(self)


class RoutedServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, routes: dict[str, Route]) -> None:
        super().__init__(("127.0.0.1", 0), _Handler)
        self.routes = dict(routes)
        self.hits: list[str] = []

    @property
    def port(self) -> int:
        return self.server_address[1]

    def url(self, path: str) -> str:
        return f"http://127.0.0.1:{self.port}{path}"


@pytest.fixture
def serve(monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[[dict[str, Route]], RoutedServer]]:
    """Starts a routed server; returns a factory. Hosts are limited to 127.0.0.1 for the test."""
    from openmeet_py.speech import model_library

    servers: list[RoutedServer] = []
    monkeypatch.setenv(model_library.TEST_HOSTS_ENV, "127.0.0.1")

    def start(routes: dict[str, Route]) -> RoutedServer:
        server = RoutedServer(routes)
        servers.append(server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server

    yield start
    for server in servers:
        server.shutdown()
        server.server_close()
