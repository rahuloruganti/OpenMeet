"""Pure lifecycle reducer for OpenMeet's opt-in automatic meeting capture.

Contract: openmeet-contracts/lifecycle-slice-audit.md section 4.3 (PROPOSED OpenMeet design, not a
Granola-derived behaviour). This module has no threads, no I/O, and no clock: every timing decision
uses the `now` carried by an event. The reducer never mints ids; the controller supplies
`session_id` for manual sessions, and automatic sessions use `call_key(app_id, epoch)`. Epochs are
a single monotonic counter, so the controller must seed `Machine.epoch` from the stored maximum.

Signals are duck-typed (`app_id`, `name`, `in_use`); `openmeet_py.platform` is never imported.
Own-exe filtering happens upstream in detection; this reducer trusts the signals it is given.

Placeholder timings (tune only in authorized Windows trials): start_polls=2, end_grace_s=45.0,
keep_window_s=60.0. Call apps and browsers are exe basenames compared in lowercase.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from enum import Enum
from typing import Any, Mapping, Optional, Protocol, Union

DEFAULT_CALL_APPS: frozenset[str] = frozenset(
    {
        "ms-teams.exe",
        "teams.exe",
        "zoom.exe",
        "slack.exe",
        "discord.exe",
        "webex.exe",
        "ciscocollabhost.exe",
        "skype.exe",
    }
)
BROWSER_APPS: frozenset[str] = frozenset(
    {"chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe"}
)


class State(str, Enum):
    DISABLED = "disabled"
    ARMED = "armed"
    CANDIDATE = "candidate"
    RECORDING = "recording"
    PAUSED = "paused"
    END_PENDING = "end_pending"
    FINALIZING = "finalizing"
    COMPLETE = "complete"
    RECOVERABLE_ERROR = "recoverable_error"


@dataclass(frozen=True)
class Policy:
    start_polls: int = 2
    end_grace_s: float = 45.0
    keep_window_s: float = 60.0
    # Exe basenames, lowercase. Anything in use that is not listed here is prompt-only.
    call_apps: frozenset[str] = DEFAULT_CALL_APPS

    def __post_init__(self) -> None:
        if self.start_polls < 1:
            raise ValueError("start_polls must be >= 1")
        if self.end_grace_s < 0:
            raise ValueError("end_grace_s must be >= 0")
        if self.keep_window_s <= 0:
            raise ValueError("keep_window_s must be > 0")
        for app in self.call_apps:
            if not app or app != app.lower() or any(c in app for c in "#\\/"):
                raise ValueError(f"call_apps entries must be lowercase exe basenames: {app!r}")


class SignalLike(Protocol):
    @property
    def app_id(self) -> str: ...

    @property
    def name(self) -> str: ...

    @property
    def in_use(self) -> bool: ...


@dataclass(frozen=True)
class Machine:
    state: State = State.DISABLED
    session_id: Optional[str] = None
    call_key: Optional[str] = None
    app_id: Optional[str] = None
    origin: Optional[str] = None  # "auto" | "manual" for the current or last session
    enabled: bool = False
    revision: int = 1
    reason: str = "disabled"
    epoch: int = 0
    recorder_idle: bool = True
    # Internal bookkeeping, kept on the machine so the reducer stays a pure function.
    streaks: tuple[tuple[str, int], ...] = ()  # consecutive in-use polls per app
    releases: tuple[tuple[str, float], ...] = ()  # time each watched app went quiet
    suppressed_apps: frozenset[str] = frozenset()
    prompted: frozenset[str] = frozenset()  # prompt-only apps already prompted this edge
    end_since: Optional[float] = None

    @property
    def suppressed(self) -> bool:
        return bool(self.suppressed_apps)


# ---------------------------------------------------------------- events


@dataclass(frozen=True)
class SettingChanged:
    enabled: bool


@dataclass(frozen=True)
class SignalsObserved:
    signals: tuple[SignalLike, ...]
    now: float


@dataclass(frozen=True)
class Tick:
    now: float


@dataclass(frozen=True)
class ManualStart:
    session_id: str
    devices_ok: bool = True


@dataclass(frozen=True)
class ManualPause:
    pass


@dataclass(frozen=True)
class ManualResume:
    pass


@dataclass(frozen=True)
class ManualStop:
    pass


@dataclass(frozen=True)
class RecorderStopped:
    session_id: str
    ok: bool


@dataclass(frozen=True)
class RecorderStartFailed:
    session_id: str
    reason: str  # short code, e.g. "devices_missing"; never content


@dataclass(frozen=True)
class ProcessingFinished:
    session_id: str
    ok: bool


@dataclass(frozen=True)
class KeepRecording:
    session_id: str


@dataclass(frozen=True)
class EndNow:
    session_id: str


@dataclass(frozen=True)
class Split:
    session_id: str


Event = Union[
    SettingChanged,
    SignalsObserved,
    Tick,
    ManualStart,
    ManualPause,
    ManualResume,
    ManualStop,
    RecorderStopped,
    RecorderStartFailed,
    ProcessingFinished,
    KeepRecording,
    EndNow,
    Split,
]


# ---------------------------------------------------------------- actions


@dataclass(frozen=True)
class StartAuto:
    session_id: str
    app_id: str
    call_key: str
    reason: str


@dataclass(frozen=True)
class Prompt:
    app_id: str
    name: str
    reason: str  # "browser_app" | "unknown_app"


@dataclass(frozen=True)
class StopAuto:
    session_id: str
    app_id: str
    call_key: str
    reason: str


@dataclass(frozen=True)
class Publish:
    snapshot: dict[str, Any]


Action = Union[StartAuto, Prompt, StopAuto, Publish]


# ---------------------------------------------------------------- helpers

ACTIVE = frozenset({State.RECORDING, State.PAUSED, State.END_PENDING})
STARTABLE = frozenset({State.ARMED, State.CANDIDATE, State.COMPLETE})
MANUAL_STARTABLE = frozenset(
    {State.DISABLED, State.ARMED, State.CANDIDATE, State.COMPLETE, State.RECOVERABLE_ERROR}
)


def call_key(app_id: str, epoch: int) -> str:
    return f"{app_id}#{epoch}"


def exe_basename(app_id: str) -> str:
    """Consent-store keys look like `C:#Users#x#...#chrome.exe`; accept `\\` and `/` too."""
    return re.split(r"[#\\/]", app_id)[-1].lower()


def _is_call_app(app_id: str, p: Policy) -> bool:
    return exe_basename(app_id) in p.call_apps


def _first_call_app(apps: Mapping[str, str], p: Policy) -> Optional[str]:
    candidates = sorted(a for a in apps if _is_call_app(a, p))
    return candidates[0] if candidates else None


def _pairs(d: Mapping[Any, Any]) -> tuple[Any, ...]:
    return tuple(sorted(d.items()))


def _view(m: Machine) -> tuple[Any, ...]:
    """Fields a controller or UI can see. Changes here bump the revision and publish."""
    return (
        m.state,
        m.session_id,
        m.call_key,
        m.app_id,
        m.origin,
        m.reason,
        m.enabled,
        m.suppressed_apps,
        m.recorder_idle,
    )


def snapshot(m: Machine) -> dict[str, Any]:
    return {
        "state": m.state.value,
        "enabled": m.enabled,
        "session_id": m.session_id,
        "call_key": m.call_key,
        "app_id": m.app_id,
        "origin": m.origin,
        "suppressed": m.suppressed,
        "recorder_idle": m.recorder_idle,
        "revision": m.revision,
        "reason": m.reason,
    }


def _close(m: Machine, reason: str, suppress: bool) -> Machine:
    """Session is over (stop requested or stopped). Epoch advances so the next call is a new key."""
    apps = m.suppressed_apps
    if suppress and m.app_id:
        apps = apps | {m.app_id}
    return replace(
        m,
        state=State.FINALIZING,
        epoch=m.epoch + 1,
        recorder_idle=False,
        suppressed_apps=apps,
        end_since=None,
        reason=reason,
    )


def _stop_auto(m: Machine, reason: str, suppress: bool = True) -> tuple[Machine, tuple[Action, ...]]:
    assert m.session_id is not None and m.app_id is not None and m.call_key is not None
    stop = StopAuto(session_id=m.session_id, app_id=m.app_id, call_key=m.call_key, reason=reason)
    return _close(m, reason, suppress), (stop,)


def _sid_match(m: Machine, session_id: str) -> bool:
    return m.session_id is not None and m.session_id == session_id


# ---------------------------------------------------------------- reducer


def reduce(m: Machine, e: Event, p: Policy) -> tuple[Machine, tuple[Action, ...]]:
    """Apply one event. Publish is appended whenever a visible field changes."""
    new, acts = _dispatch(m, e, p)
    if _view(new) != _view(m):
        new = replace(new, revision=m.revision + 1)
        acts = (*acts, Publish(snapshot=snapshot(new)))
    return new, acts


def _dispatch(m: Machine, e: Event, p: Policy) -> tuple[Machine, tuple[Action, ...]]:
    if isinstance(e, SettingChanged):
        return _setting(m, e.enabled, p)
    if isinstance(e, SignalsObserved):
        return _observe(m, e, p)
    if isinstance(e, Tick):
        return _advance(m, e.now, p)
    if isinstance(e, ManualStart):
        return _manual_start(m, e, p), ()
    if isinstance(e, ManualPause):
        return _manual_pause(m), ()
    if isinstance(e, ManualResume):
        return _manual_resume(m), ()
    if isinstance(e, ManualStop):
        return (_close(m, "manual_stop", True) if m.state in ACTIVE else m), ()
    if isinstance(e, RecorderStopped):
        return _recorder_stopped(m, e), ()
    if isinstance(e, RecorderStartFailed):
        return _start_failed(m, e), ()
    if isinstance(e, ProcessingFinished):
        return _processing_finished(m, e), ()
    if isinstance(e, KeepRecording):
        return _keep_recording(m, e), ()
    if isinstance(e, EndNow):
        if _sid_match(m, e.session_id) and m.state is State.END_PENDING:
            return _stop_auto(m, "end_now")
        return m, ()
    if isinstance(e, Split):
        if _sid_match(m, e.session_id) and m.state in (State.RECORDING, State.END_PENDING) and m.origin == "auto":
            return _stop_auto(m, "split", suppress=False)
        return m, ()
    raise TypeError(f"unknown lifecycle event: {e!r}")


def _setting(m: Machine, enabled: bool, p: Policy) -> tuple[Machine, tuple[Action, ...]]:
    if enabled:
        m = replace(m, enabled=True)
        if m.state in (State.DISABLED, State.COMPLETE) or _recovered(m):
            m = replace(m, state=State.ARMED, reason="armed")
        return m, ()
    m = replace(m, enabled=False)
    if m.state in (State.ARMED, State.CANDIDATE, State.COMPLETE) or _recovered(m):
        return replace(m, state=State.DISABLED, reason="auto_capture_off"), ()
    if m.state in ACTIVE and m.origin == "auto":
        return _stop_auto(m, "auto_capture_off")
    return m, ()


def _recovered(m: Machine) -> bool:
    """A recoverable error whose recorder is idle again: a start that failed, or a stuck stop that finally stopped."""
    return m.state is State.RECOVERABLE_ERROR and m.recorder_idle


def _observe(m: Machine, e: SignalsObserved, p: Policy) -> tuple[Machine, tuple[Action, ...]]:
    now = e.now
    in_use: dict[str, str] = {}
    for s in e.signals:
        if s.in_use:
            in_use.setdefault(s.app_id, s.name)

    streaks = {app: dict(m.streaks).get(app, 0) + 1 for app in in_use}
    m = replace(m, streaks=_pairs(streaks), prompted=m.prompted & frozenset(in_use))

    # A manual session with no known app adopts the first allow-listed app seen in use.
    if m.state in ACTIVE and m.origin == "manual" and m.app_id is None:
        attach = _first_call_app(in_use, p)
        if attach is not None:
            m = replace(m, app_id=attach, call_key=call_key(attach, m.epoch))

    if m.state is State.END_PENDING and m.app_id is not None and m.app_id in in_use:
        m = replace(m, state=State.RECORDING, end_since=None, reason="reacquired")

    # Release clocks run for the session app and for suppressed apps; an app in use has none.
    watch = set(m.suppressed_apps) | ({m.app_id} if m.app_id else set())
    old_rel = dict(m.releases)
    rel = {a: old_rel.get(a, now) for a in watch if a not in in_use}
    m = replace(m, releases=_pairs(rel))

    m, acts = _advance(m, now, p)

    if m.enabled and (m.state in STARTABLE or _recovered(m) or (m.state is State.FINALIZING and m.recorder_idle)):
        ready = sorted(
            a
            for a, n in streaks.items()
            if n >= p.start_polls and _is_call_app(a, p) and a not in m.suppressed_apps
        )
        if ready:
            app = ready[0]
            key = call_key(app, m.epoch)
            m = replace(
                m,
                state=State.RECORDING,
                session_id=key,
                call_key=key,
                app_id=app,
                origin="auto",
                recorder_idle=False,
                end_since=None,
                reason="in_use_polls",
            )
            acts = (*acts, StartAuto(session_id=key, app_id=app, call_key=key, reason="in_use_polls"))

    if m.enabled and m.state not in ACTIVE:
        for app in sorted(streaks):
            if (
                streaks[app] >= p.start_polls
                and not _is_call_app(app, p)
                and app not in m.prompted
                and app not in m.suppressed_apps
            ):
                reason = "browser_app" if exe_basename(app) in BROWSER_APPS else "unknown_app"
                acts = (*acts, Prompt(app_id=app, name=in_use[app], reason=reason))
                m = replace(m, prompted=m.prompted | {app})

    if m.state in (State.ARMED, State.CANDIDATE):
        live = any(_is_call_app(a, p) and a not in m.suppressed_apps for a in streaks)
        m = replace(m, state=State.CANDIDATE if live else State.ARMED, reason="candidate" if live else "armed")

    return m, acts


def _advance(m: Machine, now: float, p: Policy) -> tuple[Machine, tuple[Action, ...]]:
    """Time-driven transitions: release grace, keep window, suppression clearing."""
    rel = dict(m.releases)
    cleared = frozenset(a for a in m.suppressed_apps if a in rel and now - rel[a] >= p.end_grace_s)
    if cleared:
        m = replace(m, suppressed_apps=m.suppressed_apps - cleared)

    if m.state is State.RECORDING and m.origin == "auto" and m.app_id is not None:
        since = rel.get(m.app_id)
        if since is not None and now - since >= p.end_grace_s:
            m = replace(m, state=State.END_PENDING, end_since=now, reason="release_grace_elapsed")

    if m.state is State.END_PENDING and m.end_since is not None and now - m.end_since >= p.keep_window_s:
        return _stop_auto(m, "keep_window_expired")
    return m, ()


def _manual_start(m: Machine, e: ManualStart, p: Policy) -> Machine:
    if not e.devices_ok:
        return m
    if not (m.state in MANUAL_STARTABLE or (m.state is State.FINALIZING and m.recorder_idle)):
        return m
    attach = _first_call_app({a: "" for a, _ in m.streaks}, p)
    return replace(
        m,
        state=State.RECORDING,
        session_id=e.session_id,
        call_key=call_key(attach, m.epoch) if attach else None,
        app_id=attach,
        origin="manual",
        recorder_idle=False,
        end_since=None,
        reason="manual_start",
    )


def _manual_pause(m: Machine) -> Machine:
    if m.state not in (State.RECORDING, State.END_PENDING):
        return m
    apps = m.suppressed_apps | ({m.app_id} if m.app_id else set())
    return replace(m, state=State.PAUSED, suppressed_apps=frozenset(apps), end_since=None, reason="manual_pause")


def _manual_resume(m: Machine) -> Machine:
    if m.state is not State.PAUSED:
        return m
    # Resuming gives the call a fresh release grace; a stale release must not end it at once.
    rel = {a: t for a, t in m.releases if a != m.app_id}
    return replace(m, state=State.RECORDING, releases=_pairs(rel), reason="manual_resume")


def _recorder_stopped(m: Machine, e: RecorderStopped) -> Machine:
    if not _sid_match(m, e.session_id):
        return m
    if e.ok:
        if m.state in ACTIVE:
            m = _close(m, "recorder_stopped", True)
        m = replace(m, recorder_idle=True)
        if m.state is State.RECOVERABLE_ERROR:
            # The stuck stop finally went through: the error is over, back to the resting state.
            if m.enabled:
                return replace(m, state=State.ARMED, reason="recovered")
            return replace(m, state=State.DISABLED, reason="recovered")
        return m
    if m.state in ACTIVE:
        m = _close(m, "stop_failed", True)
    if m.state in (State.FINALIZING, State.RECOVERABLE_ERROR):
        return replace(m, state=State.RECOVERABLE_ERROR, recorder_idle=False, reason="stop_failed")
    return m


def _start_failed(m: Machine, e: RecorderStartFailed) -> Machine:
    if not _sid_match(m, e.session_id) or m.state is not State.RECORDING:
        return m
    m = _close(m, e.reason, True)
    return replace(m, state=State.RECOVERABLE_ERROR, recorder_idle=True, reason=e.reason)


def _processing_finished(m: Machine, e: ProcessingFinished) -> Machine:
    if not _sid_match(m, e.session_id) or m.state is not State.FINALIZING or not m.recorder_idle:
        return m
    return replace(m, state=State.COMPLETE, reason="processing_finished" if e.ok else "processing_failed")


def _keep_recording(m: Machine, e: KeepRecording) -> Machine:
    if not _sid_match(m, e.session_id) or m.state is not State.END_PENDING:
        return m
    rel = {a: t for a, t in m.releases if a != m.app_id}
    return replace(m, state=State.RECORDING, end_since=None, releases=_pairs(rel), reason="kept_by_user")
