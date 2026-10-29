"""Global shortcuts: parsing and validation, registration through the desktop backend, and actions.

Covers parse_shortcuts, shortcut_warning and the register/restore steps of save_settings.
There is deliberately no global start shortcut. A hotkey runs the same recorder pause/resume/stop
functions the on-screen buttons call, on its own thread so a slow stop never blocks the message loop.
Key names are a fixed set (Control, Alt, Shift, Win and the usual keys); unknown names are refused.
"""

from __future__ import annotations

import logging
import queue
import sys
import threading
from dataclasses import dataclass
from typing import Any, Callable, Optional

from openmeet_py.api.context import Context, text_arg
from openmeet_py.api.errors import AppError
from openmeet_py.api.reads import read_settings
from openmeet_py.platform.win32 import MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN, Message, Win32

log = logging.getLogger("openmeet_py")

MAX_SHORTCUT_CHARS = 100
PAUSE_ID = 1
STOP_ID = 2
# CommandOrControl and CmdOrCtrl mean Command on macOS and Control on Windows, so _modifier_bits
# resolves them per platform instead of living in this table.
COMMAND_OR_CONTROL = ("commandorcontrol", "cmdorctrl")
MODIFIERS = {
    "ctrl": MOD_CONTROL,
    "control": MOD_CONTROL,
    "alt": MOD_ALT,
    "option": MOD_ALT,
    "shift": MOD_SHIFT,
    "super": MOD_WIN,
    "win": MOD_WIN,
    "windows": MOD_WIN,
    "meta": MOD_WIN,
    "cmd": MOD_WIN,
    "command": MOD_WIN,
}
NAMED_KEYS = {
    "space": 0x20,
    "enter": 0x0D,
    "return": 0x0D,
    "tab": 0x09,
    "escape": 0x1B,
    "esc": 0x1B,
    "backspace": 0x08,
    "delete": 0x2E,
    "del": 0x2E,
    "insert": 0x2D,
    "home": 0x24,
    "end": 0x23,
    "pageup": 0x21,
    "pagedown": 0x22,
    "up": 0x26,
    "down": 0x28,
    "left": 0x25,
    "right": 0x27,
}
USE_HINT = "Use a shortcut such as Control+Shift+F9."
USE_HINT_MAC = "Use a shortcut such as Command+Shift+F9."
BARE_KEY = "Add Ctrl or Alt, or use an F-key."
BARE_KEY_MAC = "Add Command, Control or Option, or use an F-key."
DIFFERENT = "Use different shortcuts for pause and stop."
UNAVAILABLE = "This shortcut could not be registered. Choose another combination."


@dataclass(frozen=True)
class Accelerator:
    modifiers: int
    vk: int
    f_key: bool
    ctrl_or_alt: bool


def _on_mac() -> bool:
    return sys.platform == "darwin"


def _hint() -> str:
    """The parse hint names the modifier key the platform spells it with."""
    return USE_HINT_MAC if _on_mac() else USE_HINT


def _modifier_bits(token: str) -> Optional[int]:
    """Our platform-neutral bits for one modifier name, or None for a key token."""
    lower = token.lower()
    if lower in COMMAND_OR_CONTROL:
        return MOD_WIN if _on_mac() else MOD_CONTROL
    return MODIFIERS.get(lower)


def _key_code(token: str) -> Optional[tuple[int, bool]]:
    """Virtual-key code and whether it is an F-key, or None for an unknown key name."""
    if _on_mac():
        # macOS key codes sit next to the Carbon table, so only macos.py knows them.
        from openmeet_py.platform.macos import mac_key_code

        return mac_key_code(token)
    lower = token.lower()
    if len(token) == 1 and token.isascii() and token.isalpha():
        return ord(token.upper()), False
    if len(token) == 1 and token.isascii() and token.isdigit():
        return ord(token), False
    if lower.startswith("f") and lower[1:].isdigit() and 1 <= int(lower[1:]) <= 24:
        return 0x6F + int(lower[1:]), True  # VK_F1 is 0x70
    if lower in NAMED_KEYS:
        return NAMED_KEYS[lower], False
    return None


def parse(text: str) -> Accelerator:
    """One accelerator such as CommandOrControl+Shift+F9. Raises AppError on anything it cannot read."""
    if len(text) > MAX_SHORTCUT_CHARS:
        raise AppError("invalid_shortcut", "Shortcut is too long.")
    tokens = [token.strip() for token in text.split("+")]
    if any(not token for token in tokens):
        raise AppError("invalid_shortcut", _hint())
    modifiers = 0
    key: Optional[tuple[int, bool]] = None
    for token in tokens:
        bit = _modifier_bits(token)
        if bit is not None:
            modifiers |= bit
            continue
        code = _key_code(token)
        if code is None or key is not None:
            raise AppError("invalid_shortcut", _hint())
        key = code
    if key is None:
        raise AppError("invalid_shortcut", _hint())
    vk, f_key = key
    # A bare non-F key needs a modifier that a shortcut can safely sit on: Ctrl or Alt on Windows,
    # Command, Control or Option on macOS.
    required = MOD_WIN | MOD_CONTROL | MOD_ALT if _on_mac() else MOD_CONTROL | MOD_ALT
    return Accelerator(
        modifiers=modifiers,
        vk=vk,
        f_key=f_key,
        ctrl_or_alt=bool(modifiers & required),
    )


def validate(pause_text: str, stop_text: Optional[str]) -> tuple[Accelerator, Optional[Accelerator]]:
    """The pause shortcut is required; stop is optional. Non-F keys need Ctrl or Alt; pause and stop differ."""
    pause = parse(pause_text)
    stop = parse(stop_text) if stop_text is not None else None
    for accelerator in (pause, stop):
        if accelerator is not None and not accelerator.f_key and not accelerator.ctrl_or_alt:
            raise AppError("invalid_shortcut", BARE_KEY_MAC if _on_mac() else BARE_KEY)
    if stop is not None and stop == pause:
        raise AppError("invalid_shortcut", DIFFERENT)
    return pause, stop


def shortcut_warning(pause: Optional[str], stop: Optional[str]) -> Optional[str]:
    failed = [f"{name} ({chord})" for name, chord in (("Pause", pause), ("Stop", stop)) if chord]
    if not failed:
        return None
    return (
        f"Shortcut unavailable: {' and '.join(failed)}. Another app may be using it. Use the "
        "on-screen controls and choose another shortcut in Settings."
    )


class HotkeyService:
    """Owns the registrations. On a threaded backend every call runs on the message-loop thread."""

    def __init__(self, win32: Win32, action: Callable[[str], None]):
        self.win32 = win32
        self.action = action  # called with "pause" or "stop"; must return quickly
        self.warning: Optional[str] = None
        self._registered: dict[int, Accelerator] = {}
        self._queue: "queue.Queue[tuple[Callable[[], Any], list, threading.Event]]" = queue.Queue()
        self._ready = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # Calls from any thread --------------------------------------------------

    def _call(self, operation: Callable[[], Any]) -> Any:
        if not self.win32.threaded:
            return operation()
        if self._thread is None:
            raise AppError("shortcut_unavailable", UNAVAILABLE)
        box: list = []
        done = threading.Event()
        self._queue.put((operation, box, done))
        self.win32.wake()
        if not done.wait(10):
            raise AppError("shortcut_unavailable", "Shortcut change timed out. Try again.")
        status, value = box[0]
        if status == "error":
            raise value
        return value

    def start(self, pause_text: str, stop_text: Optional[str]) -> Optional[str]:
        """Registers the saved shortcuts. Failures become a warning; the app keeps working."""
        if self.win32.threaded:
            self._thread = threading.Thread(target=self._loop, name="openmeet-hotkeys", daemon=True)
            self._thread.start()
            if not self._ready.wait(10):
                log.warning("the hotkey thread did not start")
        else:
            self._bind_presses()
        return self._call(lambda: self._register_saved(pause_text, stop_text))

    def _bind_presses(self) -> None:
        """A backend without a loop of its own (Carbon on macOS) gets our consumer for presses."""
        self.win32.on_message(self._on_message)

    def apply(self, pause: Accelerator, stop: Optional[Accelerator], pause_text: str, stop_text: Optional[str]) -> None:
        """Replaces the registrations. On failure the previous ones are registered again and this raises."""
        self._call(lambda: self._replace(pause, stop, pause_text, stop_text))

    def current(self) -> tuple[Optional[Accelerator], Optional[Accelerator]]:
        return self._registered.get(PAUSE_ID), self._registered.get(STOP_ID)

    def stop(self) -> None:
        """Unregisters everything and ends the loop. Safe to call more than once."""
        if self.win32.threaded and self._thread is not None:
            try:
                self._call(self._unregister_all)
            except AppError:
                log.warning("hotkeys could not be unregistered cleanly")
            self.win32.quit_pump()
            self._thread.join(5)
            self._thread = None
        else:
            self._unregister_all()

    # Owner thread -----------------------------------------------------------

    def _loop(self) -> None:
        self.win32.pump(self._on_message, self._ready)

    def _on_message(self, message: Message) -> None:
        if message[0] == "hotkey":
            self.dispatch(message[1])
        elif message[0] == "wake":
            self._drain()

    def _drain(self) -> None:
        while True:
            try:
                operation, box, done = self._queue.get_nowait()
            except queue.Empty:
                return
            try:
                box.append(("ok", operation()))
            except BaseException as error:  # handed back to the caller thread
                box.append(("error", error))
            done.set()

    def dispatch(self, hotkey_id: int) -> None:
        """WM_HOTKEY: one press runs one action, and only for an id that is registered."""
        if hotkey_id == PAUSE_ID and PAUSE_ID in self._registered:
            self.action("pause")
        elif hotkey_id == STOP_ID and STOP_ID in self._registered:
            self.action("stop")

    def _register(self, hotkey_id: int, accelerator: Accelerator) -> bool:
        return bool(self.win32.register_hotkey(hotkey_id, accelerator.modifiers | MOD_NOREPEAT, accelerator.vk))

    def _unregister_all(self) -> bool:
        for hotkey_id in list(self._registered):
            if self.win32.unregister_hotkey(hotkey_id) is not False:
                del self._registered[hotkey_id]
        return not self._registered

    def _register_saved(self, pause_text: str, stop_text: Optional[str]) -> Optional[str]:
        failed: dict[str, Optional[str]] = {"pause": None, "stop": None}
        for name, hotkey_id, text in (("pause", PAUSE_ID, pause_text), ("stop", STOP_ID, stop_text)):
            if not text:
                continue
            try:
                accelerator = parse(text)
            except AppError:
                failed[name] = text
                continue
            if self._register(hotkey_id, accelerator):
                self._registered[hotkey_id] = accelerator
            else:
                failed[name] = text
        self.warning = shortcut_warning(failed["pause"], failed["stop"])
        return self.warning

    def _replace(
        self,
        pause: Accelerator,
        stop: Optional[Accelerator],
        pause_text: str,
        stop_text: Optional[str],
    ) -> None:
        del pause_text, stop_text  # the stored text is written by save_settings, not here
        previous = dict(self._registered)
        if not self._unregister_all():
            for hotkey_id, accelerator in previous.items():
                if hotkey_id not in self._registered and self._register(hotkey_id, accelerator):
                    self._registered[hotkey_id] = accelerator
            raise AppError("shortcut_unavailable", UNAVAILABLE)
        wanted = {PAUSE_ID: pause}
        if stop is not None:
            wanted[STOP_ID] = stop
        done: dict[int, Accelerator] = {}
        ok = True
        for hotkey_id, accelerator in wanted.items():
            if self._register(hotkey_id, accelerator):
                done[hotkey_id] = accelerator
            else:
                ok = False
                break
        if not ok:
            self._registered = done
            self._unregister_all()
            for hotkey_id, accelerator in previous.items():
                if hotkey_id not in self._registered and self._register(hotkey_id, accelerator):
                    self._registered[hotkey_id] = accelerator
            raise AppError("shortcut_unavailable", UNAVAILABLE)
        self._registered = done


def press_action(ctx: Context, kind: str) -> None:
    """Runs on its own thread for each hotkey press: the same recorder calls the buttons make."""
    recorder = ctx.recorder
    try:
        if kind == "stop":
            recorder.stop()
        else:
            recorder.toggle_pause()
    except AppError as error:
        ctx.emit("backend_error", error.message)
    except Exception:  # never let a worker thread die silently; the log keeps only the type
        log.error("hotkey action failed: %s", kind)
        ctx.emit("backend_error", "The shortcut action failed. Use the on-screen controls.")


def get_startup_warning(ctx: Context) -> Optional[str]:
    return ctx.hotkeys.warning if ctx.hotkeys is not None else None


def save_settings(ctx: Context, pause_shortcut: Any, stop_shortcut: Any = None) -> dict[str, Any]:
    pause_text = text_arg(pause_shortcut, "pause_shortcut")
    stop_text = None
    if stop_shortcut is not None:
        stop_text = text_arg(stop_shortcut, "stop_shortcut").strip() or None
    pause, stop = validate(pause_text, stop_text)
    service = ctx.hotkeys
    with ctx.store.lock:
        saved = read_settings(ctx.store.db)
    previous = (saved["pause_shortcut"], saved["stop_shortcut"])
    if service is not None and service.current() != (pause, stop):
        service.apply(pause, stop, pause_text, stop_text)
    with ctx.store.lock:
        db = ctx.store.db
        try:
            db.execute(
                "UPDATE settings SET pause_shortcut = ?1, stop_shortcut = ?2 WHERE id = 1",
                (pause_text, stop_text),
            )
        except BaseException:
            if service is not None:
                _restore(service, previous)
            raise
        return read_settings(db)


def _restore(service: HotkeyService, previous: tuple[str, Optional[str]]) -> None:
    try:
        pause, stop = validate(previous[0], previous[1])
        service.apply(pause, stop, previous[0], previous[1])
    except AppError:
        log.warning("the previous shortcuts could not be restored")
