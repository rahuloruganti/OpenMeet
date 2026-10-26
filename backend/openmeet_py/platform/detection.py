"""Meeting detection (always on): which other apps are using the microphone.

Covers the Windows part of meeting detection and its commands. The poll thread
reads a ConsentRegistry every 3 seconds. It emits `microphone_apps` for the prompt only after two polls in a row,
and emits the stable list when it changes. On every poll it also hands the raw, undebounced signals (in use and
idle) to subscribed listeners. It has no reference to the recorder, so a detection can never start capture, check
consent or pick devices. The user's click on the prompt is what opens New recording setup.

ConsentRegistry readers:
- WindowsConsentRegistry: stdlib winreg, read-only, HKCU microphone consent store (and its NonPackaged
  subkeys). Imported and opened only inside its method.
- FileConsentRegistry: OPENMEET_PY_FAKE_DETECTION=1 only. Reads a JSON file in the data folder so the browser
  check can drive a fake app. Tests use their own fakes.
- EmptyConsentRegistry: the default for create_app, so nothing reads the real store unless app.py asks.
"""

from __future__ import annotations

import json
import logging
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Protocol

from openmeet_py.api.context import Context, bool_arg
from openmeet_py.api.errors import AppError
from openmeet_py.api.reads import read_settings
from openmeet_py.platform.win32 import fake_detection

log = logging.getLogger("openmeet_py")

POLL_SECONDS = 3.0
FAKE_FILE = "fake-microphone-apps.json"
REGISTRY_ROOT = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone"
MAX_APP_ID = 1024
MAX_APP_NAME = 200


@dataclass(frozen=True)
class ConsentEntry:
    """One store key: its name (for example `C:#...#chrome.exe`) and its last-used start and stop times."""

    name: str
    last_used_start: int
    last_used_stop: int


@dataclass(frozen=True)
class Signal:
    """One non-ignored app seen in the consent store on a poll. `app_id` is the store key, not a call id."""

    app_id: str
    name: str
    in_use: bool
    observed_at: float


class ConsentRegistry(Protocol):
    def entries(self) -> list[ConsentEntry]: ...


class EmptyConsentRegistry:
    def entries(self) -> list[ConsentEntry]:
        return []


class WindowsConsentRegistry:
    """Reads the microphone consent store. Only ever called on Windows, from the poll thread."""

    def entries(self) -> list[ConsentEntry]:
        if sys.platform != "win32":
            return []
        import winreg

        found: list[ConsentEntry] = []
        try:
            root = winreg.OpenKey(winreg.HKEY_CURRENT_USER, REGISTRY_ROOT)
        except OSError:
            return found
        with root:
            for name in _subkeys(root):
                if name == "NonPackaged":
                    try:
                        desktop = winreg.OpenKey(root, name)
                    except OSError:
                        continue
                    with desktop:
                        for app in _subkeys(desktop):
                            _read_entry(found, desktop, app)
                else:
                    _read_entry(found, root, name)
        return found


def _subkeys(key: Any) -> list[str]:
    import winreg

    names: list[str] = []
    index = 0
    while True:
        try:
            names.append(winreg.EnumKey(key, index))
        except OSError:
            return names
        index += 1


def _read_entry(found: list[ConsentEntry], parent: Any, name: str) -> None:
    import winreg

    try:
        with winreg.OpenKey(parent, name) as key:
            start = _value(winreg, key, "LastUsedTimeStart")
            stop = _value(winreg, key, "LastUsedTimeStop")
    except OSError:
        return
    found.append(ConsentEntry(name, start, stop))


def _value(winreg: Any, key: Any, name: str) -> int:
    try:
        value = winreg.QueryValueEx(key, name)[0]
    except OSError:
        return 0
    return value if isinstance(value, int) and value >= 0 else 0


class FileConsentRegistry:
    """Fake app list from a JSON file: [{"name": "...", "start": 5, "stop": 0}, ...]. Missing or bad means none."""

    def __init__(self, path: Path):
        self.path = path

    def entries(self) -> list[ConsentEntry]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        found: list[ConsentEntry] = []
        for item in raw if isinstance(raw, list) else []:
            if not isinstance(item, dict) or not isinstance(item.get("name"), str):
                continue
            start, stop = item.get("start", 0), item.get("stop", 0)
            if isinstance(start, int) and isinstance(stop, int):
                found.append(ConsentEntry(item["name"], start, stop))
        return found


def consent_from_env(data_dir: Path) -> ConsentRegistry:
    if fake_detection():
        return FileConsentRegistry(data_dir / FAKE_FILE)
    if sys.platform == "win32":
        return WindowsConsentRegistry()
    return EmptyConsentRegistry()


def supported() -> bool:
    """Windows, or the fake registry for the browser check."""
    return sys.platform == "win32" or fake_detection()


def own_file_name() -> str:
    """The running executable's name, lower case, so the app never reports itself."""
    return Path(sys.executable).name.lower()


def display_name(key: str) -> str:
    """`C:#Program Files#Google#Chrome#Application#chrome.exe` is Chrome; `5319275A.WhatsAppDesktop_cv1g1gvanyjgm` is WhatsAppDesktop."""
    if "#" in key:
        file = key.rsplit("#", 1)[1]
        name = file[:-4] if file.lower().endswith(".exe") else file
    else:
        family = key.rsplit("_", 1)[0] if "_" in key else key
        name = family.rsplit(".", 1)[1] if "." in family else family
    return name[:1].upper() + name[1:] if name else key


def in_use(start: int, stop: int) -> bool:
    """Windows sets LastUsedTimeStop below LastUsedTimeStart (or to 0) while an app holds the microphone."""
    return start > stop


def active_apps(entries: list[ConsentEntry], own: str) -> dict[str, str]:
    """Apps holding the microphone, except this one, as key to display name."""
    found: dict[str, str] = {}
    for entry in entries:
        file = entry.name.rsplit("#", 1)[-1].lower()
        if in_use(entry.last_used_start, entry.last_used_stop) and file != own:
            found[entry.name] = display_name(entry.name)
    return found


def observed_apps(entries: list[ConsentEntry], own: str) -> dict[str, tuple[str, bool]]:
    """Every app in the store except this one, in use or idle, as key to (display name, in use)."""
    found: dict[str, tuple[str, bool]] = {}
    for entry in entries:
        file = entry.name.rsplit("#", 1)[-1].lower()
        if file != own:
            found[entry.name] = (display_name(entry.name), in_use(entry.last_used_start, entry.last_used_stop))
    return found


class Debounce:
    """Reports an app after two consecutive polls, and reports the list only when it changes."""

    def __init__(self) -> None:
        self.previous: set[str] = set()
        self.reported: Optional[set[str]] = None

    def update(self, now: set[str]) -> Optional[list[str]]:
        stable = now & self.previous
        self.previous = now
        if self.reported == stable:
            return None
        self.reported = set(stable)
        return sorted(stable)


class DetectionService:
    """Poll thread. Emits microphone_apps and feeds listeners; never starts, checks or configures a recording."""

    def __init__(self, ctx: Context, registry: ConsentRegistry, own: Optional[str] = None, poll: float = POLL_SECONDS):
        self.ctx = ctx
        self.registry = registry
        self.own = own if own is not None else own_file_name()
        self.poll = poll
        self.debounce = Debounce()
        self._listeners: list[Callable[[tuple[Signal, ...]], None]] = []
        self._listeners_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def subscribe(self, listener: Callable[[tuple[Signal, ...]], None]) -> None:
        """Calls `listener` with every poll's signals, in use and idle, regardless of the prompt's debounce.

        Listeners run on the poll thread and must not block. A listener that raises is logged and skipped.
        """
        with self._listeners_lock:
            self._listeners.append(listener)

    def start(self) -> None:
        if self._thread is None and supported():
            self._thread = threading.Thread(target=self._loop, name="openmeet-detection", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(5)
            self._thread = None

    def _loop(self) -> None:
        while not self._stop.wait(self.poll):
            try:
                self.tick()
            except Exception:  # an unreadable store means no apps this poll
                log.warning("meeting detection poll failed")

    def _notify(self, signals: tuple[Signal, ...]) -> None:
        with self._listeners_lock:
            listeners = list(self._listeners)
        for listener in listeners:
            try:
                listener(signals)
            except Exception:  # a broken listener must not stop the prompt or the other listeners
                log.warning("meeting detection listener failed", exc_info=True)

    def tick(self) -> Optional[list[dict[str, str]]]:
        """One poll. Returns the emitted list, or None when nothing changed (also used by tests)."""
        with self.ctx.store.lock:
            settings = read_settings(self.ctx.store.db)
        # Always on: no stored flag gates the poll. The ignored list is the only filter.
        ignored = {item["id"] for item in settings["detection_ignored"]}
        entries = self.registry.entries()
        current = {
            key: name
            for key, name in active_apps(entries, self.own).items()
            if key not in ignored
        }
        now = time.monotonic()
        signals = tuple(
            Signal(key, name, active, now)
            for key, (name, active) in observed_apps(entries, self.own).items()
            if key not in ignored
        )
        self._notify(signals)
        stable = self.debounce.update(set(current))
        if stable is None:
            return None
        apps = [{"id": key, "name": current.get(key, key)} for key in stable]
        self.ctx.emit("microphone_apps", apps)
        return apps


def detection_supported(ctx: Context) -> bool:
    return supported()


def set_detection_ignored(ctx: Context, app_id: Any, name: Any, ignored: Any) -> dict[str, Any]:
    if not isinstance(app_id, str) or not isinstance(name, str):
        raise AppError("invalid_args", "app_id and name must be text.")
    ignored = bool_arg(ignored, "ignored")
    if not app_id or len(app_id) > MAX_APP_ID or len(name) > MAX_APP_NAME:
        raise AppError("detection_app", "Unknown app.")
    with ctx.store.lock:
        db = ctx.store.db
        if ignored:
            db.execute(
                "INSERT OR REPLACE INTO detection_ignored_apps(app_id, name) VALUES (?1, ?2)",
                (app_id, name),
            )
        else:
            db.execute("DELETE FROM detection_ignored_apps WHERE app_id = ?1", (app_id,))
        return read_settings(db)


def request_attention(ctx: Context) -> None:
    """Flashes the taskbar entry so a prompt is noticed. Never shows or focuses the window."""
    if ctx.attention is not None:
        ctx.attention()
