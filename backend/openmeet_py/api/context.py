"""Shared command context and argument checks. Feature modules import from here, not commands.py."""

from __future__ import annotations

import datetime as dt
import threading
import unicodedata
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Iterator, Optional

import httpx

from openmeet_py.api.errors import AppError
from openmeet_py.infra.store import Store

if TYPE_CHECKING:
    from openmeet_py.audio.recorder import Recorder


@dataclass
class Context:
    store: Store
    emit: Callable[[str, Any], None]
    # Native hooks, supplied by app.py only when a window exists. None means "not available".
    pick_folder: Optional[Callable[[], Optional[str]]] = None
    close_window: Optional[Callable[[], None]] = None
    # Tests inject httpx.MockTransport here; None uses the real network stack.
    transport: Optional[httpx.BaseTransport] = None
    recorder: Optional["Recorder"] = None
    # One provider request at a time: a model call holds this lock for its whole turn.
    ai_busy: threading.Lock = field(default_factory=threading.Lock)
    # One transcription at a time. stt_cancel is set only while a transcription job runs.
    stt_busy: threading.Lock = field(default_factory=threading.Lock)
    stt_cancel: Optional[threading.Event] = None
    # Services set by server.create_app. Typed loosely to keep this module import-light.
    processing: Any = None  # processing.Processing
    live: Any = None  # live_commands.LiveService
    hotkeys: Any = None  # hotkeys.HotkeyService
    detection: Any = None  # detection.DetectionService
    lifecycle: Any = None  # lifecycle.LifecycleController (automatic capture)
    calendar: Any = None  # calendar.CalendarService (read-only ICS feeds, reminders)
    # Taskbar flash for the detection prompt; None when there is no window (tests, browser).
    attention: Optional[Callable[[], None]] = None


@contextmanager
def ai_slot(ctx: Context) -> Iterator[None]:
    if not ctx.ai_busy.acquire(blocking=False):
        raise AppError(
            "processing_busy", "Another AI request is still running. Wait for it to finish."
        )
    try:
        yield
    finally:
        ctx.ai_busy.release()


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def text_arg(value: Any, name: str) -> str:
    if not isinstance(value, str):
        raise AppError("invalid_args", f"{name} must be text.")
    return value


def optional_text_arg(value: Any, name: str) -> Optional[str]:
    return None if value is None else text_arg(value, name)


def int_arg(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise AppError("invalid_args", f"{name} must be a whole number.")
    return value


def optional_int_arg(value: Any, name: str) -> Optional[int]:
    return None if value is None else int_arg(value, name)


def bool_arg(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        raise AppError("invalid_args", f"{name} must be true or false.")
    return value


def list_arg(value: Any, name: str) -> list[Any]:
    if not isinstance(value, list):
        raise AppError("invalid_args", f"{name} must be a list.")
    return value


def dict_arg(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AppError("invalid_args", f"{name} must be an object.")
    return value


def byte_len(value: str) -> int:
    """Length in UTF-8 bytes, the unit every size limit in this package is expressed in."""
    return len(value.encode("utf-8"))


def has_control(value: str) -> bool:
    return any(unicodedata.category(c) == "Cc" for c in value)
