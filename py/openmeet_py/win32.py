"""Native Windows calls behind one small interface: global hotkeys, taskbar flashing.

NativeWin32 uses ctypes only, and loads user32/kernel32 lazily inside its methods, so importing this
module touches no DLL. FakeWin32 records calls and never touches the desktop; create_app defaults to it,
and the window and OPENMEET_PY_FAKE_HOTKEYS=1 select it, so tests and the browser check never register
a real hotkey or flash a real window.

RegisterHotKey binds to the calling thread, so NativeWin32 is `threaded`: HotkeyService runs every
register and unregister on the thread that calls pump().
"""

from __future__ import annotations

import os
import sys
import threading
from typing import Callable, Optional, Protocol

MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
MOD_WIN = 0x0008
MOD_NOREPEAT = 0x4000
WM_QUIT = 0x0012
WM_HOTKEY = 0x0312
WM_USER = 0x0400
WM_APP = 0x8000
WAKE_MESSAGE = WM_APP + 1
FLASHW_TRAY = 0x0002
FLASHW_TIMERNOFG = 0x000C

FAKE_HOTKEYS_ENV = "OPENMEET_PY_FAKE_HOTKEYS"
FAKE_DETECTION_ENV = "OPENMEET_PY_FAKE_DETECTION"

Message = tuple  # ("hotkey", id) | ("wake",)


class Win32(Protocol):
    threaded: bool

    def register_hotkey(self, hotkey_id: int, modifiers: int, vk: int) -> bool: ...

    def unregister_hotkey(self, hotkey_id: int) -> None: ...

    def pump(self, handle: Callable[[Message], None], ready: threading.Event) -> None: ...

    def wake(self) -> None: ...

    def quit_pump(self) -> None: ...

    def flash_window(self, title: str) -> bool: ...


class FakeWin32:
    """No desktop access. Registrations are recorded; `fail` chords are refused like a taken shortcut."""

    threaded = False

    def __init__(self, windows: tuple[str, ...] = (), fail: frozenset = frozenset()):
        self.windows = set(windows)
        self.fail = set(fail)  # (modifiers, vk) pairs RegisterHotKey refuses
        self.registered: dict[int, tuple[int, int]] = {}
        self.register_calls: list[tuple[int, int, int]] = []
        self.flashes: list[str] = []

    def register_hotkey(self, hotkey_id: int, modifiers: int, vk: int) -> bool:
        self.register_calls.append((hotkey_id, modifiers, vk))
        chord = modifiers & ~MOD_NOREPEAT  # the chord itself; NOREPEAT is recorded in register_calls only
        if (chord, vk) in self.fail:
            return False
        self.registered[hotkey_id] = (chord, vk)
        return True

    def unregister_hotkey(self, hotkey_id: int) -> None:
        self.registered.pop(hotkey_id, None)

    def pump(self, handle: Callable[[Message], None], ready: threading.Event) -> None:
        raise RuntimeError("FakeWin32 has no message loop; HotkeyService runs inline.")

    def wake(self) -> None:
        pass

    def quit_pump(self) -> None:
        pass

    def flash_window(self, title: str) -> bool:
        if title not in self.windows:
            return False
        self.flashes.append(title)
        return True


class NativeWin32:
    """user32 calls through ctypes. Nothing runs until a method is called."""

    threaded = True

    def __init__(self) -> None:
        if sys.platform != "win32":
            raise RuntimeError("NativeWin32 needs Windows.")
        self._thread_id = 0
        self._lib: Optional[tuple] = None

    def _libs(self):
        if self._lib is None:
            import ctypes
            from ctypes import wintypes

            user32 = ctypes.WinDLL("user32", use_last_error=True)
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            user32.RegisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT]
            user32.RegisterHotKey.restype = wintypes.BOOL
            user32.UnregisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int]
            user32.UnregisterHotKey.restype = wintypes.BOOL
            user32.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
            user32.PostThreadMessageW.restype = wintypes.BOOL
            user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
            user32.FindWindowW.restype = wintypes.HWND
            self._lib = (ctypes, wintypes, user32, kernel32)
        return self._lib

    def register_hotkey(self, hotkey_id: int, modifiers: int, vk: int) -> bool:
        _, _, user32, _ = self._libs()
        return bool(user32.RegisterHotKey(None, hotkey_id, modifiers, vk))

    def unregister_hotkey(self, hotkey_id: int) -> None:
        _, _, user32, _ = self._libs()
        user32.UnregisterHotKey(None, hotkey_id)

    def pump(self, handle: Callable[[Message], None], ready: threading.Event) -> None:
        ctypes, wintypes, user32, kernel32 = self._libs()

        class MSG(ctypes.Structure):
            _fields_ = [
                ("hwnd", wintypes.HWND),
                ("message", wintypes.UINT),
                ("wParam", wintypes.WPARAM),
                ("lParam", wintypes.LPARAM),
                ("time", wintypes.DWORD),
                ("pt", ctypes.c_long * 2),
            ]

        msg = MSG()
        user32.PeekMessageW(ctypes.byref(msg), None, WM_USER, WM_USER, 0)  # creates the queue
        self._thread_id = kernel32.GetCurrentThreadId()
        ready.set()
        while True:
            result = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
            if result <= 0:  # 0 is WM_QUIT, -1 is an error: either way the loop is over
                break
            if msg.message == WM_HOTKEY:
                handle(("hotkey", int(msg.wParam)))
            elif msg.message == WAKE_MESSAGE:
                handle(("wake",))

    def wake(self) -> None:
        _, _, user32, _ = self._libs()
        user32.PostThreadMessageW(self._thread_id, WAKE_MESSAGE, 0, 0)

    def quit_pump(self) -> None:
        _, _, user32, _ = self._libs()
        user32.PostThreadMessageW(self._thread_id, WM_QUIT, 0, 0)

    def flash_window(self, title: str) -> bool:
        """Flashes the taskbar button of the top-level window with this title. Never activates it.

        pywebview 6 keeps its WinForms form in `window.native`, but reading its Handle needs the GUI
        thread, so the window is found by title (FindWindowW). That is the fallback the port plan names.
        """
        ctypes, wintypes, user32, _ = self._libs()

        class FLASHWINFO(ctypes.Structure):
            _fields_ = [
                ("cbSize", wintypes.UINT),
                ("hwnd", wintypes.HWND),
                ("dwFlags", wintypes.DWORD),
                ("uCount", wintypes.UINT),
                ("dwTimeout", wintypes.DWORD),
            ]

        hwnd = user32.FindWindowW(None, title)
        if not hwnd:
            return False
        info = FLASHWINFO(ctypes.sizeof(FLASHWINFO), hwnd, FLASHW_TRAY | FLASHW_TIMERNOFG, 0, 0)
        user32.FlashWindowEx(ctypes.byref(info))
        return True


def win32_from_env() -> Win32:
    """The real backend, unless the browser check or tests ask for the fake one."""
    if os.environ.get(FAKE_HOTKEYS_ENV) == "1" or sys.platform != "win32":
        return FakeWin32()
    return NativeWin32()


def fake_detection() -> bool:
    return os.environ.get(FAKE_DETECTION_ENV) == "1"
