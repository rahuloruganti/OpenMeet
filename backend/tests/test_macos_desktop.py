"""NativeMacOS through a fake Carbon object: modifier translation, presses, Dock attendance, dispatch.

Nothing here touches Carbon.framework or AppKit: the library object is injected and AppKit is a fake
module in sys.modules. The ctypes marshalling in CarbonLib is written but not exercised by these tests.
"""

from __future__ import annotations

import sys
import threading
import types
from typing import Callable, Optional

import pytest

from openmeet_py.platform.hotkeys import PAUSE_ID, STOP_ID, HotkeyService, shortcut_warning
from openmeet_py.platform.macos import CMD_KEY, CONTROL_KEY, OPTION_KEY, SHIFT_KEY, NativeMacOS, carbon_modifiers
from openmeet_py.platform.win32 import MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN, FakeWin32

CMD_SHIFT = CMD_KEY | SHIFT_KEY


class FakeCarbon:
    """Stands in for CarbonLib: records the calls and can refuse the handler or a registration."""

    def __init__(self, fail: bool = False, install_ok: bool = True) -> None:
        self.fail = fail
        self.install_ok = install_ok
        self.calls: list[tuple] = []
        self.registered: dict[int, tuple[int, int]] = {}  # id -> (vk, modifiers)
        self.on_press: Optional[Callable[[int], None]] = None

    def install(self, on_press: Callable[[int], None]) -> bool:
        self.calls.append(("install",))
        if not self.install_ok:
            return False
        self.on_press = on_press
        return True

    def register(self, vk: int, modifiers: int, hotkey_id: int) -> bool:
        self.calls.append(("register", hotkey_id, vk, modifiers))
        if self.fail:
            return False
        self.registered[hotkey_id] = (vk, modifiers)
        return True

    def unregister(self, hotkey_id: int) -> None:
        self.calls.append(("unregister", hotkey_id))
        self.registered.pop(hotkey_id, None)

    def press(self, hotkey_id: int) -> None:
        assert self.on_press is not None, "a press before the handler was installed"
        self.on_press(hotkey_id)


@pytest.fixture
def on_mac(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")


class Spy:
    def __init__(self) -> None:
        self.actions: list[str] = []

    def __call__(self, kind: str) -> None:
        self.actions.append(kind)


# ---- modifier and registration translation -----------------------------------
def test_modifier_bits_translate_to_carbon_masks_and_norepeat_is_dropped() -> None:
    assert carbon_modifiers(MOD_WIN) == CMD_KEY == 0x0100
    assert carbon_modifiers(MOD_SHIFT) == SHIFT_KEY == 0x0200
    assert carbon_modifiers(MOD_ALT) == OPTION_KEY == 0x0800
    assert carbon_modifiers(MOD_CONTROL) == CONTROL_KEY == 0x1000
    assert carbon_modifiers(MOD_WIN | MOD_SHIFT | MOD_NOREPEAT) == CMD_KEY | SHIFT_KEY
    assert carbon_modifiers(0) == 0


def test_needs_macos(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    with pytest.raises(RuntimeError):
        NativeMacOS(carbon=FakeCarbon())


def test_registration_installs_one_handler_first_then_registers(on_mac: None) -> None:
    carbon = FakeCarbon()
    native = NativeMacOS(carbon=carbon)
    assert native.threaded is False
    assert native.register_hotkey(PAUSE_ID, MOD_WIN | MOD_SHIFT | MOD_NOREPEAT, 0x65) is True
    assert carbon.calls == [("install",), ("register", PAUSE_ID, 0x65, CMD_SHIFT)]
    assert carbon.registered == {PAUSE_ID: (0x65, CMD_SHIFT)}


def test_an_unknown_key_code_is_refused_without_touching_carbon(on_mac: None) -> None:
    carbon = FakeCarbon()
    native = NativeMacOS(carbon=carbon)
    assert native.register_hotkey(PAUSE_ID, MOD_WIN, 0xFF) is False
    assert carbon.calls == []


def test_a_refused_handler_reports_the_shortcut_as_unavailable(on_mac: None) -> None:
    carbon = FakeCarbon(install_ok=False)
    native = NativeMacOS(carbon=carbon)
    assert native.register_hotkey(PAUSE_ID, MOD_WIN, 0x65) is False
    assert carbon.registered == {}
    assert ("register", PAUSE_ID, 0x65, CMD_KEY) not in carbon.calls


def test_unregister_releases_the_registration(on_mac: None) -> None:
    carbon = FakeCarbon()
    native = NativeMacOS(carbon=carbon)
    native.register_hotkey(PAUSE_ID, MOD_WIN, 0x65)
    native.unregister_hotkey(PAUSE_ID)
    assert carbon.registered == {}
    native.unregister_hotkey(PAUSE_ID)  # a second release is harmless


def test_the_pump_is_refused_because_the_cocoa_loop_delivers_events(on_mac: None) -> None:
    native = NativeMacOS(carbon=FakeCarbon())
    with pytest.raises(RuntimeError):
        native.pump(lambda message: None, threading.Event())
    native.wake()
    native.quit_pump()


# ---- presses reach HotkeyService --------------------------------------------
def test_a_press_runs_the_registered_action_and_ignores_unknown_ids(on_mac: None) -> None:
    carbon = FakeCarbon()
    spy = Spy()
    service = HotkeyService(NativeMacOS(carbon=carbon), spy)
    assert service.start("CommandOrControl+Shift+F9", "CommandOrControl+Shift+F10") is None
    assert carbon.registered == {PAUSE_ID: (0x65, CMD_SHIFT), STOP_ID: (0x6D, CMD_SHIFT)}
    carbon.press(PAUSE_ID)
    carbon.press(STOP_ID)
    carbon.press(PAUSE_ID)
    assert spy.actions == ["pause", "stop", "pause"]
    carbon.press(7)  # not registered
    assert spy.actions == ["pause", "stop", "pause"]
    service.stop()
    assert carbon.registered == {}


def test_a_press_before_the_service_is_bound_is_dropped(on_mac: None) -> None:
    carbon = FakeCarbon()
    native = NativeMacOS(carbon=carbon)
    native.register_hotkey(PAUSE_ID, MOD_WIN, 0x65)  # installs the handler with no consumer yet
    carbon.press(PAUSE_ID)  # logs and returns; it must not raise into the event loop


def test_a_taken_shortcut_becomes_the_usual_warning(on_mac: None) -> None:
    carbon = FakeCarbon(fail=True)
    service = HotkeyService(NativeMacOS(carbon=carbon), Spy())
    assert service.start("CommandOrControl+Shift+F9", None) == shortcut_warning("CommandOrControl+Shift+F9", None)
    assert carbon.registered == {}


def test_stop_releases_every_shortcut(on_mac: None) -> None:
    carbon = FakeCarbon()
    service = HotkeyService(NativeMacOS(carbon=carbon), Spy())
    service.start("CommandOrControl+Shift+F9", None)
    service.stop()
    service.stop()
    assert carbon.registered == {}


# ---- Dock attention ----------------------------------------------------------
class FakeNSApp:
    def __init__(self) -> None:
        self.requests: list[int] = []

    def requestUserAttention_(self, request: int) -> int:
        self.requests.append(request)
        return 1


def test_flash_window_bounces_the_dock_icon(on_mac: None, monkeypatch: pytest.MonkeyPatch) -> None:
    app = FakeNSApp()
    fake = types.ModuleType("AppKit")
    setattr(fake, "NSApp", app)
    monkeypatch.setitem(sys.modules, "AppKit", fake)
    assert NativeMacOS(carbon=FakeCarbon()).flash_window("OpenMeet") is True
    assert app.requests == [10]  # NSInformationalRequest


def test_flash_window_without_appkit_is_false(on_mac: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "AppKit", None)
    assert NativeMacOS(carbon=FakeCarbon()).flash_window("OpenMeet") is False
    app = FakeNSApp()
    fake = types.ModuleType("AppKit")
    setattr(fake, "NSApp", None)
    monkeypatch.setitem(sys.modules, "AppKit", fake)
    assert NativeMacOS(carbon=FakeCarbon()).flash_window("OpenMeet") is False


# ---- dispatch -----------------------------------------------------------------
class Marker:
    pass


def test_win32_from_env_picks_the_native_desktop_for_the_platform(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from openmeet_py.platform import win32 as desktop

    monkeypatch.delenv(desktop.FAKE_HOTKEYS_ENV, raising=False)
    monkeypatch.setattr(sys, "platform", "darwin")
    assert isinstance(desktop.win32_from_env(), NativeMacOS)

    monkeypatch.setattr(sys, "platform", "linux")
    assert isinstance(desktop.win32_from_env(), FakeWin32)

    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setenv(desktop.FAKE_HOTKEYS_ENV, "1")
    assert isinstance(desktop.win32_from_env(), FakeWin32)

    monkeypatch.delenv(desktop.FAKE_HOTKEYS_ENV)
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(desktop, "NativeWin32", Marker)
    assert isinstance(desktop.win32_from_env(), Marker)
