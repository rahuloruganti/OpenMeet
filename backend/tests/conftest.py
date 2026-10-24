"""Shared fixtures: each test gets a fresh data folder, token and TestClient on 127.0.0.1."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

import pytest
from fastapi.testclient import TestClient

from keyring.backend import KeyringBackend
from keyring.errors import PasswordDeleteError

from openmeet_py.api.server import TOKEN_HEADER, create_app
from openmeet_py.audio.audio_backend import FakeBackend
from openmeet_py.platform import keys

TOKEN = "test-token"


@pytest.fixture
def make_client(tmp_path: Path) -> Iterator[Callable[..., TestClient]]:
    """Builds a client; `pick_folder` answers the native folder picker for export tests."""
    opened: list[TestClient] = []

    def build(
        pick_folder: Optional[Callable[[], Optional[str]]] = None,
        backend: Optional[FakeBackend] = None,
    ) -> TestClient:
        # Every client gets a fake audio backend unless a test asks for another one.
        app = create_app(
            tmp_path / "data",
            None,
            token=TOKEN,
            pick_folder=pick_folder,
            backend=backend or FakeBackend(auto_pump=False),
        )
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


@pytest.fixture(autouse=True)
def block_real_old_data(monkeypatch: pytest.MonkeyPatch, tmp_path_factory: pytest.TempPathFactory) -> None:
    """No test may read the real %APPDATA%\\dev.openmeet.preview: the helper resolves to a temp path."""
    base = tmp_path_factory.getbasetemp() / "no-previous-openmeet"
    monkeypatch.setenv("OPENMEET_OLD_DATA_DIR", str(base))


@pytest.fixture(autouse=True)
def block_real_whisper(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Outside the opt-in real-model test, `import pywhispercpp` fails: no native model can load or download."""
    if request.node.get_closest_marker("real_model"):
        yield
        return
    monkeypatch.setitem(sys.modules, "pywhispercpp", None)
    monkeypatch.setitem(sys.modules, "pywhispercpp.model", None)
    yield


@pytest.fixture(autouse=True)
def block_real_sherpa(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Outside the opt-in real-model test, `import sherpa_onnx` fails. Tests that need it inject a fake module."""
    if request.node.get_closest_marker("real_model"):
        yield
        return
    for name in ("sherpa_onnx", "sherpa_onnx.lib", "sherpa_onnx.lib._sherpa_onnx"):
        monkeypatch.setitem(sys.modules, name, None)
    yield


@pytest.fixture(autouse=True)
def block_real_desktop(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """No test may reach the real hotkeys, taskbar, or Windows consent store: the real wrappers refuse to exist.

    Tests that need them inject fakes (win32.FakeWin32, a ConsentRegistry double). winreg is hidden too.
    """
    from openmeet_py.platform import detection, win32

    def refuse(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("tests must not construct the real Windows desktop wrappers")

    monkeypatch.setattr(win32, "NativeWin32", refuse)
    monkeypatch.setattr(detection, "WindowsConsentRegistry", refuse)
    monkeypatch.setitem(sys.modules, "winreg", None)
    yield


@pytest.fixture(autouse=True)
def block_real_audio(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Outside hardware tests, `import pyaudiowpatch` fails, so no PortAudio code can open a device."""
    if request.node.get_closest_marker("hardware"):
        yield
        return
    monkeypatch.setitem(sys.modules, "pyaudiowpatch", None)
    yield
