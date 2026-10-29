"""Global shortcuts: the validation table, registration through the fake Win32, WM_HOTKEY actions and settings.

FakeWin32 stands in for RegisterHotKey, so nothing is registered on this desktop. The real NativeWin32 is
blocked in conftest.py.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from conftest import TOKEN, invoke, invoke_error
from openmeet_py.api.errors import AppError
from openmeet_py.api.server import create_app
from openmeet_py.audio.audio_backend import FakeBackend
from openmeet_py.platform import hotkeys
from openmeet_py.platform.hotkeys import PAUSE_ID, STOP_ID, HotkeyService, parse, shortcut_warning, validate
from openmeet_py.platform.win32 import MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, FakeWin32, NativeWin32, Win32

CTRL_SHIFT = MOD_CONTROL | MOD_SHIFT
DEVICES = {"microphoneId": "fake-mic", "outputId": "fake-output"}


def code_of(error: AppError) -> str:
    return error.code


# ---- parsing and validation (the parse_shortcuts table) -------------------------


def test_valid_accelerators_parse_to_modifiers_and_keys() -> None:
    accelerator = parse("CommandOrControl+Shift+F9")
    assert (accelerator.modifiers, accelerator.vk, accelerator.f_key) == (CTRL_SHIFT, 0x78, True)
    assert parse("Ctrl+Shift+F10").vk == 0x79
    assert parse("Alt+Shift+S").modifiers == MOD_ALT | MOD_SHIFT
    assert parse("F9").f_key is True  # an F-key may stand alone
    assert parse("Control+Shift+Space").vk == 0x20
    assert parse("ctrl+alt+5").vk == ord("5")


@pytest.mark.parametrize(
    "text",
    ["", "Ctrl+", "not a shortcut", "Ctrl+Foo", "Ctrl+A+B", "Ctrl", "+A", "A+" * 60, "Ctrl+Shift+F25"],
)
def test_unreadable_shortcuts_are_refused(text: str) -> None:
    with pytest.raises(AppError) as error:
        parse(text)
    assert error.value.code == "invalid_shortcut"


@pytest.mark.parametrize("text", ["Space", "A", "Shift+A", "Win+5", "Shift+Space"])
def test_bare_non_f_keys_need_ctrl_or_alt(text: str) -> None:
    with pytest.raises(AppError) as error:
        validate(text, None)
    assert error.value.code == "invalid_shortcut"
    assert error.value.message == "Add Ctrl or Alt, or use an F-key."


def test_pause_and_stop_must_differ_even_when_spelled_differently() -> None:
    cases = [
        ("CommandOrControl+Shift+Space", "CommandOrControl+Shift+Space"),
        ("Ctrl+Shift+Space", "Shift+Control+Space"),
    ]
    for pause, stop in cases:
        with pytest.raises(AppError) as error:
            validate(pause, stop)
        assert error.value.code == "invalid_shortcut"
        assert error.value.message == "Use different shortcuts for pause and stop."


def test_a_stop_shortcut_is_optional_and_may_differ() -> None:
    pause, stop = validate("CommandOrControl+Shift+Space", None)
    assert stop is None
    pause2, stop2 = validate("CommandOrControl+Shift+Space", "Alt+Shift+S")
    assert pause2 == pause and stop2 is not None and stop2 != pause


def test_invalid_stop_text_is_refused_on_its_own() -> None:
    with pytest.raises(AppError):
        validate("CommandOrControl+Shift+Space", "not a shortcut")


def test_warning_names_each_failed_shortcut() -> None:
    assert shortcut_warning(None, None) is None
    pause = shortcut_warning("Ctrl+Shift+Space", None)
    assert pause.startswith("Shortcut unavailable: Pause (Ctrl+Shift+Space). Another")
    stop = shortcut_warning(None, "Alt+S")
    assert stop.startswith("Shortcut unavailable: Stop (Alt+S). Another")
    both = shortcut_warning("Ctrl+Shift+Space", "Alt+S")
    assert both.startswith("Shortcut unavailable: Pause (Ctrl+Shift+Space) and Stop (Alt+S).")


# ---- registration through the fake ------------------------------------------


class Spy:
    def __init__(self) -> None:
        self.actions: list[str] = []

    def __call__(self, kind: str) -> None:
        self.actions.append(kind)


def test_the_backend_protocol_requires_a_press_consumer() -> None:
    assert callable(Win32.on_message)


def test_a_non_threaded_fake_delivers_presses_to_the_bound_consumer() -> None:
    win32 = FakeWin32()
    spy = Spy()
    service = HotkeyService(win32, spy)
    service.start("Ctrl+Shift+F9", "Ctrl+Shift+F10")
    assert win32._handle is not None
    win32._handle(("hotkey", PAUSE_ID))
    win32._handle(("hotkey", STOP_ID))
    win32._handle(("hotkey", 7))
    assert spy.actions == ["pause", "stop"]
    service.stop()
    win32._handle(("hotkey", PAUSE_ID))
    assert spy.actions == ["pause", "stop"]


def test_the_windows_press_binding_is_a_noop_without_native_calls() -> None:
    # Skip initialization so any attempt to use native state fails without loading a DLL.
    native = object.__new__(NativeWin32)
    assert native.on_message(lambda message: pytest.fail("unexpected press")) is None


def test_registration_uses_modifiers_keys_and_norepeat() -> None:
    win32 = FakeWin32()
    spy = Spy()
    service = HotkeyService(win32, spy)
    assert service.start("Ctrl+Shift+F9", "Ctrl+Shift+F10") is None
    assert win32.registered == {PAUSE_ID: (CTRL_SHIFT, 0x78), STOP_ID: (CTRL_SHIFT, 0x79)}
    assert all(modifiers & MOD_NOREPEAT for _, modifiers, _ in win32.register_calls)
    service.stop()
    assert win32.registered == {}


def test_a_refused_registration_becomes_a_warning_and_the_app_keeps_going() -> None:
    win32 = FakeWin32(fail={(CTRL_SHIFT, 0x78)})
    service = HotkeyService(win32, Spy())
    warning = service.start("Ctrl+Shift+F9", "Alt+Shift+S")
    assert warning == shortcut_warning("Ctrl+Shift+F9", None)
    assert service.warning == warning
    assert STOP_ID in win32.registered and PAUSE_ID not in win32.registered


def test_changing_shortcuts_releases_the_old_ones_first_and_restores_them_on_failure() -> None:
    win32 = FakeWin32(fail={(MOD_ALT, ord("P"))})
    service = HotkeyService(win32, Spy())
    service.start("Ctrl+Shift+F9", "Ctrl+Shift+F10")
    old = dict(win32.registered)
    pause, stop = validate("Alt+P", None)
    with pytest.raises(AppError) as error:
        service.apply(pause, stop, "Alt+P", None)
    assert error.value.code == "shortcut_unavailable"
    assert error.value.message == "This shortcut could not be registered. Choose another combination."
    assert win32.registered == old  # the previous shortcuts are back, and nothing new was kept

    pause, stop = validate("Ctrl+Shift+F11", None)
    service.apply(pause, stop, "Ctrl+Shift+F11", None)
    assert win32.registered == {PAUSE_ID: (CTRL_SHIFT, 0x7A)}
    assert service.current() == (pause, None)


def test_each_hotkey_press_runs_one_action_and_unregistered_ids_do_nothing() -> None:
    spy = Spy()
    service = HotkeyService(FakeWin32(), spy)
    service.start("Ctrl+Shift+F9", "Ctrl+Shift+F10")
    service.dispatch(PAUSE_ID)
    assert spy.actions == ["pause"]
    service.dispatch(STOP_ID)
    assert spy.actions == ["pause", "stop"]
    service.stop()
    service.dispatch(PAUSE_ID)
    assert spy.actions == ["pause", "stop"]


def test_unregister_on_shutdown_is_safe_to_repeat() -> None:
    win32 = FakeWin32()
    service = HotkeyService(win32, Spy())
    service.start("Ctrl+Shift+F9", None)
    service.stop()
    service.stop()
    assert win32.registered == {}


# ---- actions run the same recorder path as the buttons ---------------------------


def test_a_pause_press_pauses_then_resumes_and_stop_finishes(tmp_path: Path) -> None:
    app = create_app(tmp_path / "data", None, token=TOKEN, workers=False, backend=FakeBackend(auto_pump=False))
    client = TestClient(app, base_url="http://127.0.0.1")
    client.__enter__()
    try:
        ctx = app.state.ctx  # type: ignore[attr-defined]
        invoke(client, "start_recording", title="Fictional hotkey check", devices=DEVICES)
        hotkeys.press_action(ctx, "pause")
        assert ctx.recorder.state()["status"] == "paused"
        hotkeys.press_action(ctx, "pause")
        assert ctx.recorder.state()["status"] == "recording"
        hotkeys.press_action(ctx, "stop")
        assert ctx.recorder.state()["status"] == "stopped"
        hotkeys.press_action(ctx, "stop")  # a second stop is harmless
        assert ctx.recorder.state()["status"] == "stopped"
    finally:
        client.__exit__(None, None, None)


def test_a_press_with_nothing_recording_reports_a_backend_error(tmp_path: Path) -> None:
    app = create_app(tmp_path / "data", None, token=TOKEN, workers=False)
    client = TestClient(app, base_url="http://127.0.0.1")
    client.__enter__()
    try:
        ctx = app.state.ctx  # type: ignore[attr-defined]
        seen: list[tuple[str, object]] = []
        ctx.emit = lambda event, payload: seen.append((event, payload))
        hotkeys.press_action(ctx, "pause")
        assert seen == [("backend_error", "Recording is not active.")]
    finally:
        client.__exit__(None, None, None)


# ---- settings commands -------------------------------------------------------


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    win32 = FakeWin32()
    app = create_app(tmp_path / "data", None, token=TOKEN, win32=win32, workers=False)
    client = TestClient(app, base_url="http://127.0.0.1")
    client.__enter__()
    yield client
    client.__exit__(None, None, None)


def test_saved_shortcuts_persist_and_an_empty_stop_is_none(client: TestClient) -> None:
    saved = invoke(client, "save_settings", pauseShortcut="Alt+Shift+P", stopShortcut="  ")
    assert saved["pause_shortcut"] == "Alt+Shift+P"
    assert saved["stop_shortcut"] is None
    again = invoke(client, "get_settings")
    assert again["pause_shortcut"] == "Alt+Shift+P" and again["stop_shortcut"] is None
    win32 = client.app.state.ctx.hotkeys.win32  # type: ignore[attr-defined]
    assert PAUSE_ID in win32.registered and STOP_ID not in win32.registered


def test_an_invalid_shortcut_is_refused_and_nothing_changes(client: TestClient) -> None:
    status, body = invoke_error(client, "save_settings", pauseShortcut="Space", stopShortcut=None)
    assert (status, body["code"]) == (400, "invalid_shortcut")
    assert invoke(client, "get_settings")["pause_shortcut"] == "Control+Shift+F9"
    status, body = invoke_error(client, "save_settings", pauseShortcut="Ctrl+Shift+F9", stopShortcut="Ctrl+Shift+F9")
    assert body["message"] == "Use different shortcuts for pause and stop."


def test_a_shortcut_the_system_refuses_is_reported_and_the_old_one_stays(client: TestClient) -> None:
    win32 = client.app.state.ctx.hotkeys.win32  # type: ignore[attr-defined]
    win32.fail.add((MOD_ALT | MOD_SHIFT, ord("P")))
    status, body = invoke_error(client, "save_settings", pauseShortcut="Alt+Shift+P", stopShortcut=None)
    assert (status, body["code"]) == (400, "shortcut_unavailable")
    assert invoke(client, "get_settings")["pause_shortcut"] == "Control+Shift+F9"
    assert win32.registered[PAUSE_ID] == (CTRL_SHIFT, 0x78)


def test_a_failed_startup_registration_is_reported_and_the_app_still_works(tmp_path: Path) -> None:
    win32 = FakeWin32(fail={(CTRL_SHIFT, 0x78)})
    app = create_app(tmp_path / "data", None, token=TOKEN, win32=win32, workers=False)
    client = TestClient(app, base_url="http://127.0.0.1")
    client.__enter__()
    try:
        warning = invoke(client, "get_startup_warning")
        assert warning == shortcut_warning("Control+Shift+F9", None)
        assert invoke(client, "get_recording_state")["status"] == "idle"
    finally:
        client.__exit__(None, None, None)
