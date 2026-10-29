"""NativeMacOS through a fake Carbon object: modifier translation, presses, Dock attendance, dispatch.

Nothing here touches Carbon.framework or AppKit: fake library functions exercise the ctypes boundary,
and fake modules in sys.modules stand in for AppKit and the main-thread queue.
"""

from __future__ import annotations

import ctypes
import queue
import sys
import threading
import types
from typing import Callable, Optional

import pytest

from openmeet_py.api.errors import AppError
from openmeet_py.platform.hotkeys import PAUSE_ID, STOP_ID, HotkeyService, shortcut_warning, validate
from openmeet_py.platform.macos import (
    CMD_KEY,
    CONTROL_KEY,
    OPTION_KEY,
    SHIFT_KEY,
    CarbonLib,
    MainThreadUnavailable,
    NativeMacOS,
    carbon_modifiers,
)
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

    def unregister(self, hotkey_id: int) -> bool:
        self.calls.append(("unregister", hotkey_id))
        self.registered.pop(hotkey_id, None)
        return True

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


# ---- main-thread requests ----------------------------------------------------
class FakeAppHelper:
    def __init__(self) -> None:
        self.queued: queue.Queue[Callable[[], None]] = queue.Queue()

    def callAfter(self, operation: Callable[[], None]) -> None:
        self.queued.put(operation)


@pytest.fixture
def main_queue(monkeypatch: pytest.MonkeyPatch) -> FakeAppHelper:
    helper = FakeAppHelper()
    fake = types.ModuleType("PyObjCTools")
    setattr(fake, "AppHelper", helper)
    monkeypatch.setitem(sys.modules, "PyObjCTools", fake)
    from openmeet_py.platform import macos

    monkeypatch.setattr(macos, "MAIN_THREAD_TIMEOUT", 0.2)
    return helper


@pytest.mark.parametrize("release", [False, True])
def test_a_timed_out_request_never_runs_later(
    on_mac: None, main_queue: FakeAppHelper, release: bool
) -> None:
    carbon = FakeCarbon()
    native = NativeMacOS(carbon=carbon)
    if release:
        assert native.register_hotkey(PAUSE_ID, MOD_WIN, 0x65) is True
        operation = lambda: native.unregister_hotkey(PAUSE_ID)
    else:
        operation = lambda: native.register_hotkey(PAUSE_ID, MOD_WIN, 0x65)
    previous = dict(carbon.registered)
    carbon.calls.clear()
    results: list[bool] = []
    worker = threading.Thread(target=lambda: results.append(operation()))
    worker.start()
    queued = main_queue.queued.get(timeout=1)
    worker.join(1)
    assert not worker.is_alive()
    assert results == [False]
    queued()
    assert carbon.calls == []
    assert carbon.registered == previous


@pytest.mark.parametrize("fails", [False, True])
def test_a_started_request_waits_for_its_result(
    on_mac: None, main_queue: FakeAppHelper, fails: bool
) -> None:
    native = NativeMacOS(carbon=FakeCarbon())
    started = threading.Event()
    release = threading.Event()
    results: list[object] = []
    errors: list[Exception] = []
    failure = ValueError("registration failed")

    def operation() -> str:
        started.set()
        assert release.wait(1)
        if fails:
            raise failure
        return "registered"

    def request() -> None:
        try:
            results.append(native._on_main(operation))
        except (MainThreadUnavailable, ValueError) as error:
            errors.append(error)

    worker = threading.Thread(target=request)
    worker.start()
    queued = main_queue.queued.get(timeout=1)

    def finish() -> None:
        assert started.wait(1)
        worker.join(0.3)
        release.set()

    finisher = threading.Thread(target=finish)
    finisher.start()
    try:
        queued()
    finally:
        release.set()
        worker.join(1)
        finisher.join(1)
    assert not worker.is_alive()
    assert errors == ([failure] if fails else [])
    assert results == ([] if fails else ["registered"])


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


class FakeCarbonFramework:
    """Carbon's ctypes boundary, including a retryable UnregisterEventHotKey failure."""

    def __init__(self) -> None:
        self.release_status = 0
        self.release_failures: set[int] = {101, 102}
        self.releases: list[int] = []
        self.registrations: list[tuple[int, int]] = []
        self.GetApplicationEventTarget = lambda: 42
        self.InstallEventHandler = lambda *args: 0
        self.GetEventParameter = lambda *args: 0
        self.RegisterEventHotKey = lambda *args: self.register(*args)
        self.UnregisterEventHotKey = lambda ref: self.unregister(ref)

    def register(self, vk, modifiers, hotkey, target, options, ref) -> int:
        self.registrations.append((hotkey.id, vk))
        ctypes.cast(ref, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.c_void_p(100 + hotkey.id)
        return 0

    def unregister(self, ref: ctypes.c_void_p) -> int:
        assert ref.value is not None
        self.releases.append(ref.value)
        return self.release_status if ref.value in self.release_failures else 0


def test_a_failed_carbon_release_keeps_the_handle_for_retry(
    on_mac: None, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    framework = FakeCarbonFramework()
    monkeypatch.setattr(ctypes, "CDLL", lambda path: framework)
    carbon = CarbonLib()
    native = NativeMacOS(carbon=carbon)
    assert native.register_hotkey(PAUSE_ID, MOD_WIN, 0x65) is True
    framework.release_status = -50
    assert native.unregister_hotkey(PAUSE_ID) is False
    assert PAUSE_ID in carbon._refs
    assert "Carbon" in caplog.text and "-50" in caplog.text
    framework.release_status = 0
    assert native.unregister_hotkey(PAUSE_ID) is True
    assert PAUSE_ID not in carbon._refs
    assert native.unregister_hotkey(PAUSE_ID) is True
    assert framework.releases == [101, 101]


@pytest.mark.parametrize("failed_refs", [{101}, {102}, {101, 102}])
def test_a_failed_release_prevents_shortcut_replacement(
    on_mac: None, monkeypatch: pytest.MonkeyPatch, failed_refs: set[int]
) -> None:
    framework = FakeCarbonFramework()
    framework.release_failures = failed_refs
    monkeypatch.setattr(ctypes, "CDLL", lambda path: framework)
    carbon = CarbonLib()
    service = HotkeyService(NativeMacOS(carbon=carbon), Spy())
    service.start("Command+F9", "Command+F10")
    previous = service.current()
    refs = {hotkey_id: ref.value for hotkey_id, ref in carbon._refs.items()}
    framework.release_status = -50
    pause, stop = validate("Command+F11", None)
    with pytest.raises(AppError, match="could not be registered"):
        service.apply(pause, stop, "Command+F11", None)
    assert service.current() == previous
    assert {hotkey_id: ref.value for hotkey_id, ref in carbon._refs.items()} == refs
    framework.release_status = 0
    service.stop()
    assert carbon._refs == {}


def test_a_failed_rollback_release_does_not_overwrite_the_live_handle(
    on_mac: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    framework = FakeCarbonFramework()
    monkeypatch.setattr(ctypes, "CDLL", lambda path: framework)
    carbon = CarbonLib()
    service = HotkeyService(NativeMacOS(carbon=carbon), Spy())
    service.start("Command+F9", "Command+F10")
    previous_stop = service.current()[1]

    def refuse_stop(vk, modifiers, hotkey, target, options, ref) -> int:
        if vk == 0x6F:
            framework.release_status = -50
            return -50
        return framework.register(vk, modifiers, hotkey, target, options, ref)

    monkeypatch.setattr(framework, "RegisterEventHotKey", refuse_stop)
    pause, stop = validate("Command+F11", "Command+F12")
    with pytest.raises(AppError, match="could not be registered"):
        service.apply(pause, stop, "Command+F11", "Command+F12")
    assert framework.registrations == [(PAUSE_ID, 0x65), (STOP_ID, 0x6D), (PAUSE_ID, 0x67), (STOP_ID, 0x6D)]
    assert service.current() == (pause, previous_stop)
    framework.release_status = 0
    service.stop()
    assert carbon._refs == {}


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
