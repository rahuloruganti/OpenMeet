"""Shared fixtures: each test gets a fresh data folder, token and TestClient on 127.0.0.1."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Iterator, Optional

import pytest
from fastapi.testclient import TestClient

from keyring.backend import KeyringBackend
from keyring.errors import PasswordDeleteError

from openmeet_py import keys
from openmeet_py.server import TOKEN_HEADER, create_app

TOKEN = "test-token"


@pytest.fixture
def make_client(tmp_path: Path) -> Iterator[Callable[..., TestClient]]:
    """Builds a client; `pick_folder` answers the native folder picker for export tests."""
    opened: list[TestClient] = []

    def build(pick_folder: Optional[Callable[[], Optional[str]]] = None) -> TestClient:
        app = create_app(tmp_path / "data", None, token=TOKEN, pick_folder=pick_folder)
        client = TestClient(app, base_url="http://127.0.0.1")
        client.__enter__()
        opened.append(client)
        return client

    yield build
    for client in opened:
        client.__exit__(None, None, None)


@pytest.fixture
def client(make_client: Callable[..., TestClient]) -> TestClient:
    return make_client()


def invoke(client: TestClient, cmd: str, **args: Any) -> Any:
    """Calls a command the way the UI does and returns the parsed JSON or raises AssertionError."""
    response = client.post(
        f"/api/invoke/{cmd}", json=args, headers={TOKEN_HEADER: TOKEN}
    )
    assert response.status_code == 200, response.text
    return response.json()


def invoke_error(client: TestClient, cmd: str, **args: Any) -> tuple[int, dict[str, Any]]:
    response = client.post(
        f"/api/invoke/{cmd}", json=args, headers={TOKEN_HEADER: TOKEN}
    )
    assert response.status_code >= 400, response.text
    return response.status_code, response.json()


class MemoryKeyring(KeyringBackend):
    """In-memory credential store. Tests never reach the Windows Credential Manager."""

    priority = 1

    def __init__(self) -> None:
        self.items: dict[tuple[str, str], str] = {}

    def set_password(self, service: str, username: str, password: str) -> None:
        self.items[(service, username)] = password

    def get_password(self, service: str, username: str) -> Optional[str]:
        return self.items.get((service, username))

    def delete_password(self, service: str, username: str) -> None:
        if (service, username) not in self.items:
            raise PasswordDeleteError("no such credential")
        del self.items[(service, username)]


@pytest.fixture(autouse=True)
def memory_keyring() -> Iterator[MemoryKeyring]:
    backend = MemoryKeyring()
    keys.use_backend(backend)
    yield backend
    keys.use_backend(None)
