"""macOS behind the Win32 protocol: Carbon global shortcuts and Dock attention.

NativeMacOS is `threaded = False`. pywebview already runs the Cocoa main loop on the main thread,
which is what delivers Carbon events, and RegisterEventHotKey belongs to the main thread, so every
register and unregister is marshalled onto the main thread with PyObjCTools.AppHelper.callAfter and
the caller waits for the answer. Nothing here loads a framework until a method runs, so importing
this module on Windows and in tests touches no native library. PyObjCTools comes with the pyobjc
packages pywebview already installs; no extra dependency is needed.

Hotkeys are Carbon's RegisterEventHotKey against the application event target, so they need no
Accessibility permission. The modifier masks, four-char codes and key codes below are Apple's
documented Carbon HIToolbox values (Events.h, HIToolbox/Events.h).
"""

from __future__ import annotations

import ctypes
import logging
import sys
import threading
from typing import Callable, Optional

from openmeet_py.platform.win32 import MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN, Message

log = logging.getLogger("openmeet_py")

CARBON_FRAMEWORK = "/System/Library/Frameworks/Carbon.framework/Carbon"

# Carbon modifier masks (Events.h). Our own bits live in win32.py and stay platform neutral.
CMD_KEY = 0x0100
SHIFT_KEY = 0x0200
OPTION_KEY = 0x0800
CONTROL_KEY = 0x1000
CARBON_MODIFIERS = (
    (MOD_WIN, CMD_KEY),  # Command
    (MOD_SHIFT, SHIFT_KEY),
    (MOD_ALT, OPTION_KEY),  # Option
    (MOD_CONTROL, CONTROL_KEY),
)

# Carbon event codes and the hotkey structures (Events.h, CarbonEventsCore.h).
NO_ERR = 0
K_EVENT_CLASS_KEYBOARD = 0x6B657962  # 'keyb'
K_EVENT_HOTKEY_PRESSED = 5
K_EVENT_PARAM_DIRECT_OBJECT = 0x2D2D2D2D  # '----'
TYPE_EVENT_HOTKEY_ID = 0x686B6964  # 'hkid'
HOTKEY_SIGNATURE = 0x686B6579  # 'hkey'
MAIN_THREAD_TIMEOUT = 5.0

NS_INFORMATIONAL_REQUEST = 10


class EventHotKeyID(ctypes.Structure):
    _fields_ = [("signature", ctypes.c_uint32), ("id", ctypes.c_uint32)]


class EventTypeSpec(ctypes.Structure):
    _fields_ = [("eventClass", ctypes.c_uint32), ("eventKind", ctypes.c_uint32)]


HandlerProc = ctypes.CFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)

# Virtual key codes from Carbon's Events.h (kVK_ANSI_*, kVK_Space, the arrows and the F-keys).
# Letters and digits are the unshifted key positions on an ANSI keyboard.
MAC_KEY_CODES: dict[str, int] = {
    "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07,
    "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F,
    "y": 0x10, "t": 0x11, "o": 0x1F, "u": 0x20, "i": 0x22, "p": 0x23, "l": 0x25,
    "j": 0x26, "k": 0x28, "n": 0x2D, "m": 0x2E,
    "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17,
    "9": 0x19, "7": 0x1A, "8": 0x1C, "0": 0x1D,
    "space": 0x31,
    "enter": 0x24, "return": 0x24,
    "tab": 0x30,
    "escape": 0x35, "esc": 0x35,
    "backspace": 0x33,
    "delete": 0x75, "del": 0x75,  # kVK_ForwardDelete: the Windows VK_DELETE equivalent
    "home": 0x73,
    "end": 0x77,
    "pageup": 0x74,
    "pagedown": 0x79,
    "up": 0x7E, "down": 0x7D, "left": 0x7B, "right": 0x7C,
    "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60, "f6": 0x61, "f7": 0x62,
    "f8": 0x64, "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F, "f13": 0x69,
    "f14": 0x6B, "f15": 0x71, "f16": 0x6A, "f17": 0x40, "f18": 0x4F, "f19": 0x50, "f20": 0x5A,
    # No insert key exists on Mac keyboards, and there is no F21 to F24, so those names are refused.
}
F_KEY_TOKENS = frozenset(name for name in MAC_KEY_CODES if name.startswith("f") and name[1:].isdigit())
KNOWN_MAC_KEYS = frozenset(MAC_KEY_CODES.values())


def mac_key_code(token: str) -> Optional[tuple[int, bool]]:
    """macOS virtual key code for one accelerator token and whether it is an F-key, or None."""
    lower = token.lower()
    code = MAC_KEY_CODES.get(lower)
    if code is None:
        return None
    return code, lower in F_KEY_TOKENS


def carbon_modifiers(modifiers: int) -> int:
    """Carbon's modifier mask for our platform-neutral bits; any other bit (MOD_NOREPEAT) is dropped."""
    mask = 0
    for bit, carbon_bit in CARBON_MODIFIERS:
        if modifiers & bit:
            mask |= carbon_bit
    return mask


class CarbonLib:
    """Carbon's hotkey calls through ctypes. The framework loads on first use.

    `install` keeps the ctypes callback alive for the life of the process: letting it be collected
    while Carbon still holds the handler would crash the event loop on the next key press.
    """

    def __init__(self) -> None:
        self._lib: Optional[ctypes.CDLL] = None
        self._callback: Optional[HandlerProc] = None
        self._handler_ref = ctypes.c_void_p()
        self._refs: dict[int, ctypes.c_void_p] = {}
        self._on_press: Optional[Callable[[int], None]] = None

    def lib(self) -> ctypes.CDLL:
        if self._lib is None:
            lib = ctypes.CDLL(CARBON_FRAMEWORK)
            lib.GetApplicationEventTarget.restype = ctypes.c_void_p
            lib.InstallEventHandler.argtypes = [
                ctypes.c_void_p,
                HandlerProc,
                ctypes.c_uint32,
                ctypes.POINTER(EventTypeSpec),
                ctypes.c_void_p,
                ctypes.POINTER(ctypes.c_void_p),
            ]
            lib.InstallEventHandler.restype = ctypes.c_int32
            lib.GetEventParameter.argtypes = [
                ctypes.c_void_p,
                ctypes.c_uint32,
                ctypes.c_uint32,
                ctypes.c_void_p,
                ctypes.c_uint32,
                ctypes.c_void_p,
                ctypes.c_void_p,
            ]
            lib.GetEventParameter.restype = ctypes.c_int32
            lib.RegisterEventHotKey.argtypes = [
                ctypes.c_uint32,
                ctypes.c_uint32,
                EventHotKeyID,
                ctypes.c_void_p,
                ctypes.c_uint32,
                ctypes.POINTER(ctypes.c_void_p),
            ]
            lib.RegisterEventHotKey.restype = ctypes.c_int32
            lib.UnregisterEventHotKey.argtypes = [ctypes.c_void_p]
            lib.UnregisterEventHotKey.restype = ctypes.c_int32
            self._lib = lib
        return self._lib

    def install(self, on_press: Callable[[int], None]) -> bool:
        """One handler on the application target for every hotkey. False when Carbon refuses."""
        if self._callback is not None:
            return True
        lib = self.lib()
        target = lib.GetApplicationEventTarget()
        if not target:
            return False
        callback = HandlerProc(self._handle)
        spec = EventTypeSpec(K_EVENT_CLASS_KEYBOARD, K_EVENT_HOTKEY_PRESSED)
        handler_ref = ctypes.c_void_p()
        status = lib.InstallEventHandler(
            target, callback, 1, ctypes.byref(spec), None, ctypes.byref(handler_ref)
        )
        if status != NO_ERR:
            return False
        self._on_press = on_press
        self._callback = callback
        self._handler_ref = handler_ref
        return True

    def register(self, vk: int, modifiers: int, hotkey_id: int) -> bool:
        ref = ctypes.c_void_p()
        hotkey = EventHotKeyID(HOTKEY_SIGNATURE, hotkey_id)
        target = self.lib().GetApplicationEventTarget()
        status = self.lib().RegisterEventHotKey(vk, modifiers, hotkey, target, 0, ctypes.byref(ref))
        if status != NO_ERR or not ref.value:
            return False
        self._refs[hotkey_id] = ref
        return True

    def unregister(self, hotkey_id: int) -> None:
        ref = self._refs.pop(hotkey_id, None)
        if ref is not None:
            self.lib().UnregisterEventHotKey(ref)

    def _handle(self, _call_ref: object, event: object, _user_data: object) -> int:
        hotkey = EventHotKeyID()
        status = self.lib().GetEventParameter(
            event,
            K_EVENT_PARAM_DIRECT_OBJECT,
            TYPE_EVENT_HOTKEY_ID,
            None,
            ctypes.sizeof(hotkey),
            None,
            ctypes.byref(hotkey),
        )
        if status == NO_ERR and self._on_press is not None:
            try:
                self._on_press(int(hotkey.id))
            except Exception:  # a ctypes callback must never raise into the event loop
                log.error("the global shortcut handler failed")
        return NO_ERR


class MainThreadUnavailable(RuntimeError):
    """The Cocoa main loop never ran our call; the caller reports the shortcut as unavailable."""


class NativeMacOS:
    """The Win32 protocol on macOS: Carbon hotkeys and a Dock bounce for attention.

    Register and unregister run on the main thread and the caller waits, because Carbon wants that
    thread and because register_hotkey has to report whether the shortcut was taken.
    """

    threaded = False

    def __init__(self, carbon: Optional[object] = None) -> None:
        if sys.platform != "darwin":
            raise RuntimeError("NativeMacOS needs macOS.")
        self._carbon = carbon  # injectable for tests; CarbonLib is created on first use
        self._handle: Optional[Callable[[Message], None]] = None

    def _lib(self):
        if self._carbon is None:
            self._carbon = CarbonLib()
        return self._carbon

    def on_message(self, handle: Callable[[Message], None]) -> None:
        """Hands the backend the consumer for presses. HotkeyService binds this when not threaded."""
        self._handle = handle

    def _press(self, hotkey_id: int) -> None:
        if self._handle is None:
            log.warning("a global shortcut fired before the hotkey service was bound")
            return
        self._handle(("hotkey", hotkey_id))

    def register_hotkey(self, hotkey_id: int, modifiers: int, vk: int) -> bool:
        if vk not in KNOWN_MAC_KEYS:
            return False
        mask = carbon_modifiers(modifiers)
        try:
            return bool(self._on_main(lambda: self._register_now(hotkey_id, mask, vk)))
        except MainThreadUnavailable:
            log.warning("the main thread did not answer a shortcut registration")
            return False

    def _register_now(self, hotkey_id: int, mask: int, vk: int) -> bool:
        lib = self._lib()
        if not lib.install(self._press):
            log.warning("Carbon refused the key event handler")
            return False
        return bool(lib.register(vk, mask, hotkey_id))

    def unregister_hotkey(self, hotkey_id: int) -> None:
        try:
            self._on_main(lambda: self._lib().unregister(hotkey_id))
        except MainThreadUnavailable:
            log.warning("the main thread did not answer a shortcut release")

    def pump(self, handle: Callable[[Message], None], ready: threading.Event) -> None:
        raise RuntimeError("NativeMacOS has no message loop; the Cocoa loop delivers Carbon events.")

    def wake(self) -> None:
        # Nothing is queued: HotkeyService calls the backend inline when it is not threaded.
        pass

    def quit_pump(self) -> None:
        pass

    def flash_window(self, title: str) -> bool:
        """Bounces the Dock icon once, informationally. Never activates the app or a window."""
        del title  # a Dock bounce identifies the app; window titles do not apply

        def bounce() -> bool:
            try:
                from AppKit import NSApp
            except ImportError:
                return False
            if NSApp is None:
                return False
            return bool(NSApp.requestUserAttention_(NS_INFORMATIONAL_REQUEST))

        try:
            return bool(self._on_main(bounce))
        except MainThreadUnavailable:
            return False

    def _on_main(self, operation: Callable[[], object]) -> object:
        """Runs on the main thread and returns its answer; raises MainThreadUnavailable on timeout."""
        if threading.current_thread() is threading.main_thread():
            return operation()
        box: dict[str, object] = {}
        done = threading.Event()

        def run() -> None:
            try:
                box["value"] = operation()
            except BaseException as error:  # handed back to the waiting thread below
                box["error"] = error
            finally:
                done.set()

        try:
            from PyObjCTools import AppHelper
        except ImportError as error:
            raise MainThreadUnavailable("PyObjCTools is not importable") from error
        AppHelper.callAfter(run)
        if not done.wait(MAIN_THREAD_TIMEOUT):
            raise MainThreadUnavailable("the main thread stayed busy")
        if "error" in box:
            raise box["error"]  # type: ignore[misc]
        return box.get("value")
