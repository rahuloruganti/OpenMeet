"""The window entry point on macOS: the same window, the same close guard, no custom menu.

No Mac here, so the GUI module is faked at the library boundary and pywebview's own Event class
(from `backend/.venv`, 6.2.1) is used unfaked to prove the cancel contract the Cocoa backend reads.
"""

from __future__ import annotations

import sys
import types
from typing import Any

import pytest

from openmeet_py import app as app_module


class FakeClosingEvent:
    def __init__(self) -> None:
        self.handlers: list[Any] = []

    def __iadd__(self, handler: Any) -> "FakeClosingEvent":
        self.handlers.append(handler)
        return self


class FakeWindow:
    def __init__(self) -> None:
        self.events = types.SimpleNamespace(closing=FakeClosingEvent())
        self.destroyed = False

    def create_file_dialog(self, *args: Any, **kwargs: Any) -> None:
        return None

    def destroy(self) -> None:
        self.destroyed = True


def fake_webview(window: FakeWindow, captured: dict[str, Any]) -> types.ModuleType:
    module = types.ModuleType("webview")
    module.FileDialog = types.SimpleNamespace(FOLDER="folder")

    def create_window(title: str, url: str, **kwargs: Any) -> FakeWindow:
        captured["title"] = title
        captured["url"] = url
        captured["kwargs"] = kwargs
        return window

    def start(*args: Any, **kwargs: Any) -> None:
        captured["start"] = (args, kwargs)

    module.create_window = create_window
    module.start = start
    return module


def desktop_fakes(monkeypatch: pytest.MonkeyPatch) -> None:
    # The window builds the real app, so keep the real hotkeys and consent store out of the test.
    monkeypatch.setenv("OPENMEET_PY_FAKE_HOTKEYS", "1")
    monkeypatch.setenv("OPENMEET_PY_FAKE_DETECTION", "1")


def test_run_window_opens_the_app_window_without_an_icon(tmp_path, monkeypatch) -> None:
    window = FakeWindow()
    captured: dict[str, Any] = {}
    monkeypatch.setitem(sys.modules, "webview", fake_webview(window, captured))
    desktop_fakes(monkeypatch)

    assert app_module.run_window(tmp_path / "data") == 0

    assert captured["title"] == app_module.TITLE == "OpenMeet"
    assert captured["kwargs"]["min_size"] == app_module.MIN_SIZE
    # macOS takes the icon from the app bundle, so the window must not be given one.
    assert "icon" not in captured["kwargs"]
    assert "menu" not in captured["kwargs"]
    assert captured["url"].startswith("http://127.0.0.1:")
    assert captured["url"].endswith("/")
    assert captured["start"] == ((), {})


def test_run_window_registers_the_close_guard_on_the_closing_event(tmp_path, monkeypatch) -> None:
    window = FakeWindow()
    monkeypatch.setitem(sys.modules, "webview", fake_webview(window, {}))
    desktop_fakes(monkeypatch)

    app_module.run_window(tmp_path / "data")

    # No page is connected in this fake, so the guard lets the close through immediately.
    assert len(window.events.closing.handlers) == 1
    assert window.events.closing.handlers[0]() is True


def test_pywebview_cancels_a_close_only_for_a_false_return() -> None:
    # Cocoa's should_close() reads events.closing.set(); startup, Cmd+Q and the close button all
    # reach it. The guard must answer with a bool, otherwise the page is never asked to save.
    from webview.event import Event

    class Hub:
        clients = 1

        def __init__(self) -> None:
            self.events: list[str] = []

        def client_count(self) -> int:
            return self.clients

        def emit(self, event: str, payload: Any) -> None:
            self.events.append(event)

    hub = Hub()
    guard = app_module.CloseGuard(hub.client_count, hub.emit)
    event = Event(window=None, should_lock=True)
    event += guard.closing

    assert event.set() is True
    assert hub.events == ["request_close"]

    guard.allow()

    assert event.set() is False


def test_check_audio_import_uses_sounddevice_on_a_mac(monkeypatch, capsys) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setitem(sys.modules, "sounddevice", types.SimpleNamespace(__version__="0.5.6"))

    assert app_module.check_audio_import() == 0

    out = capsys.readouterr().out
    assert "OK: sounddevice 0.5.6" in out
    assert "no audio device was opened" in out


def test_check_audio_import_keeps_pyaudiowpatch_on_windows(monkeypatch, capsys) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setitem(sys.modules, "pyaudiowpatch", types.SimpleNamespace(__version__="0.0.17"))

    assert app_module.check_audio_import() == 0

    assert "OK: pyaudiowpatch 0.0.17" in capsys.readouterr().out


def test_check_audio_import_reports_a_missing_library(monkeypatch, capsys) -> None:
    # A None entry in sys.modules makes the import fail the way a missing wheel does.
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setitem(sys.modules, "sounddevice", None)

    assert app_module.check_audio_import() == 1

    assert "FAILED: ModuleNotFoundError" in capsys.readouterr().err
