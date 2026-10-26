"""Lifecycle reducer for opt-in automatic capture: table-driven, one scenario per test.

No threads, no clock, no devices: time is an input on each event, and every action is
asserted by value. Signals are local doubles with the same shape as the detection signal.
"""

from __future__ import annotations

import inspect
import re
from dataclasses import dataclass
from typing import Any

import pytest

from openmeet_py.domain import lifecycle as L
from openmeet_py.domain.lifecycle import (
    BROWSER_APPS,
    DEFAULT_CALL_APPS,
    EndNow,
    KeepRecording,
    ManualPause,
    ManualResume,
    ManualStart,
    ManualStop,
    Policy,
    ProcessingFinished,
    Prompt,
    Publish,
    RecorderStartFailed,
    RecorderStopped,
    SettingChanged,
    SignalsObserved,
    Split,
    StartAuto,
    State,
    StopAuto,
    Tick,
)

TEAMS = "C:#Users#x#AppData#Local#Microsoft#Teams#ms-teams.exe"
ZOOM = "C:#Apps#Zoom#Zoom.EXE"
CHROME = "C:#Program Files#Google#Chrome#Application#chrome.exe"
UNKNOWN = "C:#Tools#Weird#weird.exe"
P = Policy()


@dataclass(frozen=True)
class Sig:
    """Test double with the detection signal shape (app_id, name, in_use, observed_at)."""

    app_id: str
    name: str
    in_use: bool
    observed_at: float = 0.0


def _name(app_id: str) -> str:
    return re.split(r"[#\\/]", app_id)[-1]


def obs(now: float, *in_use: str, idle: tuple[str, ...] = ()) -> SignalsObserved:
    sigs = [Sig(a, _name(a), True) for a in in_use] + [Sig(a, _name(a), False) for a in idle]
    return SignalsObserved(signals=tuple(sigs), now=now)


def drive(events: list[Any], m: L.Machine | None = None, p: Policy = P):
    """Apply events in order; return the final machine and the actions per event."""
    m = m if m is not None else L.Machine()
    per_event: list[tuple[Any, ...]] = []
    for e in events:
        m, acts = L.reduce(m, e, p)
        per_event.append(acts)
    return m, per_event


def flat(per_event: list[tuple[Any, ...]]) -> list[Any]:
    return [a for acts in per_event for a in acts]


def kinds(acts: tuple[Any, ...] | list[Any]) -> list[type]:
    return [type(a) for a in acts]


def auto_recording(p: Policy = P) -> L.Machine:
    """Enabled, Teams in use for two consecutive polls: one automatic session."""
    m, _ = drive([SettingChanged(True), obs(0, TEAMS), obs(3, TEAMS)], p=p)
    assert m.state is State.RECORDING and m.origin == "auto"
    return m


def ending(p: Policy = P) -> L.Machine:
    """Auto session released at t=10, END_PENDING after the grace (t=55)."""
    m = auto_recording(p)
    m, _ = drive([obs(10, idle=(TEAMS,))], m=m, p=p)
    m, _ = drive([Tick(10 + p.end_grace_s)], m=m, p=p)
    assert m.state is State.END_PENDING
    return m


# ---------------------------------------------------------------- helpers and policy


def test_call_key_joins_app_and_epoch() -> None:
    assert L.call_key(TEAMS, 7) == f"{TEAMS}#7"


@pytest.mark.parametrize(
    ("app_id", "exe"),
    [
        (TEAMS, "ms-teams.exe"),
        (CHROME, "chrome.exe"),
        ("C:\\Apps\\Zoom\\Zoom.EXE", "zoom.exe"),
        ("ZOOM.EXE", "zoom.exe"),
        ("C:/Apps/Slack/slack.exe", "slack.exe"),
    ],
)
def test_exe_basename_is_lowercased_and_split_on_all_separators(app_id: str, exe: str) -> None:
    assert L.exe_basename(app_id) == exe


def test_default_allow_list_is_desktop_call_apps_only() -> None:
    assert DEFAULT_CALL_APPS == frozenset(
        {"ms-teams.exe", "teams.exe", "zoom.exe", "slack.exe", "discord.exe",
         "webex.exe", "ciscocollabhost.exe", "skype.exe"}
    )
    assert BROWSER_APPS == frozenset(
        {"chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe"}
    )
    assert not (DEFAULT_CALL_APPS & BROWSER_APPS)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"start_polls": 0},
        {"end_grace_s": -1.0},
        {"keep_window_s": 0.0},
        {"call_apps": frozenset({"Zoom.exe"})},
        {"call_apps": frozenset({"c#zoom.exe"})},
    ],
)
def test_policy_rejects_invalid_values(kwargs: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        Policy(**kwargs)


def test_policy_defaults_are_the_placeholder_timings() -> None:
    assert (P.start_polls, P.end_grace_s, P.keep_window_s) == (2, 45.0, 60.0)


def test_reducer_module_has_no_clock_threads_io_or_platform_imports() -> None:
    src = inspect.getsource(L)
    banned = re.compile(
        r"^\s*(import|from)\s+(time|threading|uuid|random|asyncio|sqlite3|os|subprocess"
        r"|openmeet_py\.(platform|audio|api|infra|speech|local_ai))\b",
        re.MULTILINE,
    )
    assert banned.search(src) is None
    assert "monotonic()" not in src
    assert re.search(r"\btime\.\w+\(", src) is None


# ---------------------------------------------------------------- disabled and enabling


@pytest.mark.parametrize(
    "event",
    [
        obs(0, TEAMS),
        obs(3, TEAMS),
        obs(6, CHROME),
        obs(9, UNKNOWN),
        Tick(100.0),
        EndNow(session_id="x"),
    ],
)
def test_disabled_emits_nothing(event: Any) -> None:
    before = L.Machine()
    m, acts = L.reduce(before, event, P)
    assert acts == ()
    assert m.state is State.DISABLED
    assert m.session_id is None


def test_disabled_emits_nothing_across_many_polls() -> None:
    m, per_event = drive([obs(t, TEAMS, CHROME) for t in (0, 3, 6, 9)])
    assert flat(per_event) == []
    assert m.state is State.DISABLED
    assert m.revision == 1


def test_enable_moves_disabled_to_armed_with_publish() -> None:
    m, per_event = drive([SettingChanged(True)])
    assert m.state is State.ARMED
    assert m.enabled is True
    assert kinds(per_event[0]) == [Publish]
    assert per_event[0][0].snapshot["state"] == "armed"


# ---------------------------------------------------------------- start rules


def test_single_in_use_poll_does_not_start() -> None:
    m, per_event = drive([SettingChanged(True), obs(0, TEAMS)])
    assert m.state is State.CANDIDATE
    assert StartAuto not in kinds(flat(per_event))


def test_second_consecutive_poll_starts_auto_with_session_and_key() -> None:
    m, per_event = drive([SettingChanged(True), obs(0, TEAMS), obs(3, TEAMS)])
    starts = [a for a in flat(per_event) if isinstance(a, StartAuto)]
    assert starts == [StartAuto(session_id=f"{TEAMS}#0", app_id=TEAMS,
                                call_key=f"{TEAMS}#0", reason="in_use_polls")]
    assert m.state is State.RECORDING
    assert m.origin == "auto"
    assert m.session_id == m.call_key == f"{TEAMS}#0"


def test_allow_listed_app_matched_case_insensitively_starts() -> None:
    m, per_event = drive([SettingChanged(True), obs(0, ZOOM), obs(3, ZOOM)])
    assert m.state is State.RECORDING
    assert any(isinstance(a, StartAuto) and a.app_id == ZOOM for a in flat(per_event))


def test_gap_resets_start_count() -> None:
    m, per_event = drive(
        [SettingChanged(True), obs(0, TEAMS), obs(3, idle=(TEAMS,)), obs(6, TEAMS)]
    )
    assert m.state is State.CANDIDATE
    assert StartAuto not in kinds(flat(per_event))
    m, per_event = drive([obs(9, TEAMS)], m=m)
    assert m.state is State.RECORDING
    assert StartAuto in kinds(flat(per_event))


def test_gap_absent_from_snapshot_also_resets_start_count() -> None:
    m, _ = drive([SettingChanged(True), obs(0, TEAMS), obs(3)])
    m, per_event = drive([obs(6, TEAMS)], m=m)
    assert m.state is State.CANDIDATE
    assert StartAuto not in kinds(flat(per_event))


# ---------------------------------------------------------------- prompts for browser and unknown apps


def test_browser_app_prompts_once_and_never_starts() -> None:
    m, per_event = drive([SettingChanged(True), obs(0, CHROME), obs(3, CHROME), obs(6, CHROME)])
    actions = flat(per_event)
    prompts = [a for a in actions if isinstance(a, Prompt)]
    assert prompts == [Prompt(app_id=CHROME, name="chrome.exe", reason="browser_app")]
    assert StartAuto not in kinds(actions)
    assert m.state is State.ARMED


@pytest.mark.parametrize(("app_id", "reason"), [(CHROME, "browser_app"), (UNKNOWN, "unknown_app")])
def test_prompt_reason_is_browser_or_unknown(app_id: str, reason: str) -> None:
    _, per_event = drive([SettingChanged(True), obs(0, app_id), obs(3, app_id)])
    assert [a.reason for a in flat(per_event) if isinstance(a, Prompt)] == [reason]


def test_unknown_app_prompts_once_and_never_starts() -> None:
    m, per_event = drive([SettingChanged(True), obs(0, UNKNOWN), obs(3, UNKNOWN), obs(6, UNKNOWN)])
    actions = flat(per_event)
    assert [a for a in actions if isinstance(a, Prompt)] == [
        Prompt(app_id=UNKNOWN, name="weird.exe", reason="unknown_app")
    ]
    assert StartAuto not in kinds(actions)


def test_browser_prompt_rearms_on_a_new_in_use_edge() -> None:
    m, per_event = drive(
        [
            SettingChanged(True),
            obs(0, CHROME), obs(3, CHROME),          # prompt
            obs(6, idle=(CHROME,)),                  # edge ends
            obs(9, CHROME), obs(12, CHROME),         # new edge: prompt again
        ]
    )
    prompts = [a for a in flat(per_event) if isinstance(a, Prompt)]
    assert len(prompts) == 2


def test_browser_prompt_is_not_emitted_while_disabled() -> None:
    _, per_event = drive([obs(0, CHROME), obs(3, CHROME)])
    assert flat(per_event) == []


# ---------------------------------------------------------------- active call dedupe and grace


def test_duplicate_signals_for_active_call_are_noops() -> None:
    m = auto_recording()
    before_revision = m.revision
    m2, per_event = drive([obs(6, TEAMS), obs(9, TEAMS), obs(12, TEAMS)], m=m)
    assert flat(per_event) == []
    assert m2.state is State.RECORDING
    assert m2.session_id == m.session_id
    assert m2.revision == before_revision


def test_release_shorter_than_grace_keeps_same_session() -> None:
    m = auto_recording()
    m2, per_event = drive(
        [obs(10, idle=(TEAMS,)), Tick(10 + P.end_grace_s - 1), obs(10 + P.end_grace_s - 1, TEAMS)],
        m=m,
    )
    assert flat(per_event) == []
    assert m2.state is State.RECORDING
    assert m2.session_id == m.session_id


def test_release_for_end_grace_enters_end_pending_with_publish() -> None:
    m = auto_recording()
    m2, per_event = drive([obs(10, idle=(TEAMS,)), Tick(10 + P.end_grace_s)], m=m)
    assert m2.state is State.END_PENDING
    assert m2.session_id == m.session_id
    assert kinds(per_event[1]) == [Publish]
    assert per_event[1][0].snapshot["state"] == "end_pending"


def test_end_pending_is_entered_from_an_observation_as_well_as_a_tick() -> None:
    m = auto_recording()
    m2, _ = drive([obs(10, idle=(TEAMS,)), obs(10 + P.end_grace_s, idle=(TEAMS,))], m=m)
    assert m2.state is State.END_PENDING


def test_reacquire_during_end_pending_returns_to_recording_same_session() -> None:
    m = ending()
    m2, per_event = drive([obs(60, TEAMS)], m=m)
    assert m2.state is State.RECORDING
    assert m2.session_id == m.session_id
    assert flat(per_event) and kinds(flat(per_event)) == [Publish]


def test_keep_recording_returns_to_recording_and_extends_grace() -> None:
    m = ending()
    m2, _ = drive([KeepRecording(session_id=m.session_id)], m=m)
    assert m2.state is State.RECORDING
    # The release that caused END_PENDING no longer counts: a fresh grace starts at the next poll.
    m3, per_event = drive([obs(60, idle=(TEAMS,)), Tick(60 + P.end_grace_s - 1)], m=m2)
    assert m3.state is State.RECORDING
    assert StopAuto not in kinds(flat(per_event))
    m4, _ = drive([Tick(60 + P.end_grace_s)], m=m3)
    assert m4.state is State.END_PENDING


def test_end_now_stops_auto_with_the_session_key() -> None:
    m = ending()
    m2, per_event = drive([EndNow(session_id=m.session_id)], m=m)
    stops = [a for a in flat(per_event) if isinstance(a, StopAuto)]
    assert stops == [StopAuto(session_id=m.session_id, app_id=TEAMS,
                              call_key=m.call_key, reason="end_now")]
    assert m2.state is State.FINALIZING


def test_keep_window_timeout_emits_stop_auto() -> None:
    m = ending()
    end_at = m.end_since
    m2, per_event = drive([Tick(end_at + P.keep_window_s - 0.5)], m=m)
    assert m2.state is State.END_PENDING
    assert StopAuto not in kinds(flat(per_event))
    m3, per_event = drive([Tick(end_at + P.keep_window_s)], m=m2)
    assert m3.state is State.FINALIZING
    assert [a.reason for a in flat(per_event) if isinstance(a, StopAuto)] == ["keep_window_expired"]


# ---------------------------------------------------------------- finalization


def test_recorder_stopped_ok_then_processing_finished_completes() -> None:
    m = ending()
    m, _ = drive([EndNow(session_id=m.session_id)], m=m)
    m, _ = drive([RecorderStopped(session_id=m.session_id, ok=True)], m=m)
    assert m.state is State.FINALIZING
    assert m.recorder_idle is True
    m, _ = drive([ProcessingFinished(session_id=m.session_id, ok=True)], m=m)
    assert m.state is State.COMPLETE


def test_recorder_stopped_failed_is_recoverable_error_not_complete() -> None:
    m = ending()
    m, _ = drive([EndNow(session_id=m.session_id)], m=m)
    m, _ = drive([RecorderStopped(session_id=m.session_id, ok=False)], m=m)
    assert m.state is State.RECOVERABLE_ERROR
    assert m.reason == "stop_failed"
    assert m.recorder_idle is False
    m, _ = drive([ProcessingFinished(session_id=m.session_id, ok=True)], m=m)
    assert m.state is State.RECOVERABLE_ERROR


def test_recoverable_error_blocks_automatic_restart() -> None:
    m = ending()
    m, _ = drive([EndNow(session_id=m.session_id)], m=m)
    m, _ = drive([RecorderStopped(session_id=m.session_id, ok=False)], m=m)
    m2, per_event = drive([obs(70, TEAMS), obs(73, TEAMS), obs(76, TEAMS)], m=m)
    assert StartAuto not in kinds(flat(per_event))
    assert m2.state is State.RECOVERABLE_ERROR


def test_recorder_start_failure_is_recoverable_and_suppresses_the_app() -> None:
    m, _ = drive([SettingChanged(True), obs(0, TEAMS), obs(3, TEAMS)])
    m2, _ = drive([RecorderStartFailed(session_id=m.session_id, reason="devices_missing")], m=m)
    assert m2.state is State.RECOVERABLE_ERROR
    assert m2.reason == "devices_missing"
    assert m2.suppressed is True
    assert m2.recorder_idle is True


def test_split_stops_auto_and_restarts_with_a_new_epoch_after_recorder_stops() -> None:
    m = auto_recording()
    m, per_event = drive([Split(session_id=m.session_id)], m=m)
    assert [a for a in flat(per_event) if isinstance(a, StopAuto)][0].reason == "split"
    assert m.state is State.FINALIZING
    assert m.suppressed is False
    m, _ = drive([RecorderStopped(session_id=f"{TEAMS}#0", ok=True)], m=m)
    m, per_event = drive([obs(6, TEAMS)], m=m)
    starts = [a for a in flat(per_event) if isinstance(a, StartAuto)]
    assert [s.call_key for s in starts] == [f"{TEAMS}#1"]
    assert m.state is State.RECORDING


def test_no_start_while_recorder_still_stopping_then_starts_once_stopped() -> None:
    m = auto_recording()
    m, _ = drive([Split(session_id=m.session_id)], m=m)  # no suppression: only recorder_idle blocks
    m2, per_event = drive([obs(6, TEAMS), obs(9, TEAMS)], m=m)
    assert StartAuto not in kinds(flat(per_event))
    assert m2.state is State.FINALIZING
    m3, per_event = drive([RecorderStopped(session_id=m.session_id, ok=True), obs(12, TEAMS)], m=m2)
    assert [a.call_key for a in flat(per_event) if isinstance(a, StartAuto)] == [f"{TEAMS}#1"]
    assert m3.state is State.RECORDING


def test_setting_off_during_auto_recording_emits_stop_auto() -> None:
    m = auto_recording()
    m2, per_event = drive([SettingChanged(False)], m=m)
    stops = [a for a in flat(per_event) if isinstance(a, StopAuto)]
    assert stops == [StopAuto(session_id=m.session_id, app_id=TEAMS,
                              call_key=m.call_key, reason="auto_capture_off")]
    assert m2.enabled is False
    assert m2.state is State.FINALIZING


def test_setting_off_during_manual_recording_emits_no_stop() -> None:
    m, _ = drive([ManualStart(session_id="manual-1")])
    m2, per_event = drive([SettingChanged(False)], m=m)
    assert StopAuto not in kinds(flat(per_event))
    assert m2.state is State.RECORDING
    assert m2.origin == "manual"
    assert m2.enabled is False


# ---------------------------------------------------------------- manual controls and suppression


def test_manual_pause_marks_call_suppressed_and_never_auto_resumes() -> None:
    m = auto_recording()
    m, per_event = drive([ManualPause()], m=m)
    assert m.state is State.PAUSED
    assert m.suppressed is True
    assert flat(per_event) and kinds(flat(per_event)) == [Publish]
    m, per_event = drive([obs(6, TEAMS), obs(9, TEAMS), Tick(200.0)], m=m)
    assert m.state is State.PAUSED
    assert StartAuto not in kinds(flat(per_event))
    assert StopAuto not in kinds(flat(per_event))


def test_manual_resume_returns_to_recording_with_same_session() -> None:
    m = auto_recording()
    m, _ = drive([ManualPause()], m=m)
    m2, _ = drive([ManualResume()], m=m)
    assert m2.state is State.RECORDING
    assert m2.session_id == m.session_id


def test_manual_stop_suppresses_same_call_and_new_epoch_after_sustained_release() -> None:
    m = auto_recording()
    m, per_event = drive([ManualStop()], m=m)
    assert m.state is State.FINALIZING
    assert StopAuto not in kinds(flat(per_event))
    assert m.epoch == 1
    m, _ = drive([RecorderStopped(session_id=m.session_id, ok=True)], m=m)
    m, _ = drive([ProcessingFinished(session_id=m.session_id, ok=True)], m=m)
    assert m.state is State.COMPLETE

    # Same app, still in use: no restart.
    m, per_event = drive([obs(100, TEAMS)], m=m)
    m, per_event2 = drive([obs(101, idle=(TEAMS,)), obs(110, TEAMS), obs(113, TEAMS)], m=m)
    assert StartAuto not in kinds(flat(per_event + per_event2))
    assert m.suppressed is True

    # Sustained release (45 s), then a new in-use edge: new epoch, restart allowed.
    m, _ = drive([obs(120, idle=(TEAMS,)), Tick(120 + P.end_grace_s)], m=m)
    assert m.suppressed is False
    m, per_event = drive([obs(170, TEAMS), obs(173, TEAMS)], m=m)
    starts = [a for a in flat(per_event) if isinstance(a, StartAuto)]
    assert [s.call_key for s in starts] == [f"{TEAMS}#1"]
    assert m.state is State.RECORDING


def test_manual_pause_then_stop_suppresses_restart_without_release() -> None:
    m = auto_recording()
    m, _ = drive([ManualPause(), ManualStop()], m=m)
    m, _ = drive([RecorderStopped(session_id=m.session_id, ok=True)], m=m)
    m, _ = drive([ProcessingFinished(session_id=m.session_id, ok=True)], m=m)
    m2, per_event = drive([obs(20, TEAMS), obs(23, TEAMS), obs(26, TEAMS)], m=m)
    assert StartAuto not in kinds(flat(per_event))
    assert m2.state is State.COMPLETE


def test_manual_start_while_armed_attaches_session_and_auto_never_double_starts() -> None:
    m, _ = drive([SettingChanged(True), obs(0, TEAMS)])
    assert m.state is State.CANDIDATE
    m, _ = drive([ManualStart(session_id="manual-1")], m=m)
    assert m.state is State.RECORDING
    assert m.origin == "manual"
    assert m.app_id == TEAMS
    assert m.call_key == f"{TEAMS}#0"
    m2, per_event = drive([obs(3, TEAMS), obs(6, TEAMS), obs(9, TEAMS)], m=m)
    assert StartAuto not in kinds(flat(per_event))
    assert m2.origin == "manual"
    assert m2.session_id == "manual-1"


def test_manual_session_attaches_app_seen_later_and_auto_stays_blocked() -> None:
    m, _ = drive([SettingChanged(True), ManualStart(session_id="manual-1")])
    assert m.state is State.RECORDING and m.app_id is None
    m2, per_event = drive([obs(3, TEAMS), obs(6, TEAMS)], m=m)
    assert StartAuto not in kinds(flat(per_event))
    assert m2.origin == "manual"
    assert m2.app_id == TEAMS  # attached on first in-use observation, still manual


def test_manual_start_refused_when_devices_are_unavailable_changes_nothing() -> None:
    m, _ = drive([SettingChanged(True)])
    m2, per_event = drive([ManualStart(session_id="manual-1", devices_ok=False)], m=m)
    assert m2 == m
    assert flat(per_event) == []


def test_manual_start_while_recording_is_a_noop() -> None:
    m = auto_recording()
    m2, per_event = drive([ManualStart(session_id="manual-2")], m=m)
    assert m2 == m
    assert flat(per_event) == []


# ---------------------------------------------------------------- guards and bookkeeping


@pytest.mark.parametrize(
    "event_for",
    [
        lambda sid: KeepRecording(session_id=sid),
        lambda sid: EndNow(session_id=sid),
        lambda sid: Split(session_id=sid),
        lambda sid: RecorderStopped(session_id=sid, ok=False),
        lambda sid: ProcessingFinished(session_id=sid, ok=True),
        lambda sid: RecorderStartFailed(session_id=sid, reason="devices_missing"),
    ],
)
def test_events_for_another_session_are_ignored(event_for: Any) -> None:
    m = ending()
    m2, acts = L.reduce(m, event_for("some-other-session"), P)
    assert acts == ()
    assert m2 == m


def test_revision_increments_only_on_visible_change() -> None:
    m, _ = drive([SettingChanged(True)])
    rev = m.revision
    m, per_event = drive([obs(0, CHROME)], m=m)  # streak only, nothing visible
    assert m.revision == rev
    assert flat(per_event) == []
    m, per_event = drive([obs(3, TEAMS)], m=m)  # candidate: visible
    assert m.revision == rev + 1
    assert kinds(flat(per_event)) == [Publish]


def test_stop_auto_and_prompt_carry_only_codes_not_content() -> None:
    m = ending()
    _, per_event = drive([EndNow(session_id=m.session_id)], m=m)
    stop = next(a for a in flat(per_event) if isinstance(a, StopAuto))
    for value in (stop.session_id, stop.app_id, stop.call_key, stop.reason):
        assert isinstance(value, str)
    assert stop.reason == "end_now"


def test_snapshot_is_a_plain_dict_for_the_ui() -> None:
    m = auto_recording()
    snap = L.snapshot(m)
    assert set(snap) == {
        "state", "enabled", "session_id", "call_key", "app_id", "origin",
        "suppressed", "recorder_idle", "revision", "reason",
    }
    assert snap["state"] == "recording"
    assert snap["origin"] == "auto"
    assert snap["enabled"] is True
    assert snap["suppressed"] is False
    assert snap["call_key"] == f"{TEAMS}#0"


def test_session_key_is_fresh_after_epoch_bump_and_never_reused() -> None:
    m = auto_recording()
    m, _ = drive([ManualStop()], m=m)
    m, _ = drive([RecorderStopped(session_id=m.session_id, ok=True)], m=m)
    m, _ = drive([obs(100, idle=(TEAMS,)), Tick(145.0)], m=m)
    m, _ = drive([obs(150, TEAMS)], m=m)
    m, per_event = drive([obs(153, TEAMS)], m=m)
    keys = [a.call_key for a in flat(per_event) if isinstance(a, StartAuto)]
    assert keys == [f"{TEAMS}#1"]
    assert keys[0] != f"{TEAMS}#0"


def test_policy_allow_list_is_a_policy_input_not_a_constant() -> None:
    custom = Policy(call_apps=frozenset({"chrome.exe"}))
    m, per_event = drive(
        [SettingChanged(True), obs(0, CHROME), obs(3, CHROME)], p=custom
    )
    assert m.state is State.RECORDING
    assert any(isinstance(a, StartAuto) for a in flat(per_event))
    m2, per_event2 = drive([SettingChanged(True), obs(0, TEAMS), obs(3, TEAMS)], p=custom)
    assert m2.state is State.ARMED
    assert StartAuto not in kinds(flat(per_event2))


# ---------------------------------------------------------------- recovery from RECOVERABLE_ERROR


def _start_failed() -> L.Machine:
    m, _ = drive([SettingChanged(True), obs(0, TEAMS), obs(3, TEAMS)])
    m, _ = drive([RecorderStartFailed(session_id=m.session_id, reason="devices_missing")], m=m)
    assert m.state is State.RECOVERABLE_ERROR
    return m


def test_toggling_auto_capture_off_and_on_rearms_after_a_start_failure() -> None:
    m = _start_failed()
    m, _ = drive([SettingChanged(False)], m=m)
    assert m.state is State.DISABLED
    m, _ = drive([SettingChanged(True)], m=m)
    assert m.state is State.ARMED


def test_reenabling_rearms_from_a_start_failure_without_toggling_off() -> None:
    m = _start_failed()
    m, _ = drive([SettingChanged(True)], m=m)
    assert m.state is State.ARMED


def test_a_new_call_from_another_app_starts_after_a_start_failure() -> None:
    m = _start_failed()
    m, per_event = drive([obs(10, ZOOM), obs(13, ZOOM)], m=m)
    assert m.state is State.RECORDING
    assert m.app_id == ZOOM
    assert kinds(flat(per_event)).count(StartAuto) == 1


def test_failed_app_stays_suppressed_until_its_release_clears() -> None:
    m = _start_failed()
    m, per_event = drive([obs(10, TEAMS), obs(13, TEAMS)], m=m)
    assert m.state is State.RECOVERABLE_ERROR
    assert StartAuto not in kinds(flat(per_event))
    # released for the grace, then a fresh in-use edge: new epoch, new session
    m, per_event = drive([obs(20, idle=(TEAMS,)), obs(20 + P.end_grace_s), obs(70, TEAMS), obs(73, TEAMS)], m=m)
    assert m.state is State.RECORDING
    assert m.call_key == L.call_key(TEAMS, 1)


def test_stop_failure_rearms_once_the_recorder_finally_stops() -> None:
    m = auto_recording()
    sid = m.session_id
    m, _ = drive([RecorderStopped(session_id=sid, ok=False)], m=m)
    assert m.state is State.RECOVERABLE_ERROR
    assert m.recorder_idle is False
    # a fresh call must not start while the recorder is stuck
    m, per_event = drive([obs(50, ZOOM), obs(53, ZOOM)], m=m)
    assert StartAuto not in kinds(flat(per_event))
    assert m.state is State.RECOVERABLE_ERROR
    # the user's retried Stop succeeds
    m, _ = drive([RecorderStopped(session_id=sid, ok=True)], m=m)
    assert m.recorder_idle is True
    assert m.state is State.ARMED


def test_stop_failure_then_recorder_stops_while_disabled_goes_to_disabled() -> None:
    m = auto_recording()
    sid = m.session_id
    m, _ = drive([RecorderStopped(session_id=sid, ok=False), SettingChanged(False)], m=m)
    assert m.state is State.RECOVERABLE_ERROR  # recorder still stuck: the error stays visible
    m, _ = drive([RecorderStopped(session_id=sid, ok=True)], m=m)
    assert m.state is State.DISABLED
