"""Recording commands against the fake backend: lifecycle, pause privacy, failures and file handling.

Every test uses synthetic samples from FakeBackend. Writes are deterministic: tests call
backend.deliver() and then pause, stop or wait for the writer through public calls.
"""

from __future__ import annotations

import struct
import threading
import time
import uuid
from array import array
from pathlib import Path
from typing import Any, Callable

import pytest
from fastapi.testclient import TestClient

from conftest import invoke, invoke_error
from openmeet_py.audio import recorder as recorder_module
from openmeet_py.audio.audio_wav import WavFile, read_timing, timing_line

DEVICES = {"microphoneId": "fake-mic", "outputId": "fake-output"}
RATE = 16000
FRAMES = 1024


def backend(client: TestClient) -> Any:
    return client.app.state.backend


def recorder(client: TestClient) -> Any:
    return client.app.state.ctx.recorder


def audio_dir(client: TestClient) -> Path:
    return client.app.state.ctx.store.data_dir / "audio"


def start(client: TestClient, title: str = "Weekly sync") -> str:
    return invoke(client, "start_recording", title=title, devices=DEVICES)["meeting_id"]


def deliver(client: TestClient, mic: float | None = None, out: float | None = None) -> None:
    backend(client).stream_for("fake-mic").deliver(FRAMES, mic)
    backend(client).stream_for("fake-output").deliver(FRAMES, out)


def wait_for(predicate: Callable[[], bool], timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("timed out waiting for the recording to change")
        time.sleep(0.02)


def read_samples(path: Path) -> array:
    samples = array("f")
    samples.frombytes(path.read_bytes()[58:])
    return samples


def track_files(client: TestClient, meeting_id: str, kind: str) -> tuple[Path, Path]:
    folder = audio_dir(client) / meeting_id
    return folder / f"{kind}.wav", folder / f"{kind}.timing.jsonl"


def gate_writes(monkeypatch: pytest.MonkeyPatch) -> tuple[threading.Event, threading.Event]:
    """Holds every WAV write until the test releases it. `entered` fires when the first write starts."""
    gate, entered = threading.Event(), threading.Event()
    real_write = WavFile.write

    def gated(self: WavFile, data: bytes) -> None:
        entered.set()
        gate.wait(10)
        real_write(self, data)

    monkeypatch.setattr(WavFile, "write", gated)
    return gate, entered


# ---- lifecycle ----------------------------------------------------------------------


def test_full_cycle_writes_two_finalized_tracks_and_lists_the_meeting(client: TestClient) -> None:
    meeting_id = start(client)
    deliver(client, mic=0.3, out=0.6)
    paused = invoke(client, "pause_recording")
    assert paused["status"] == "paused" and paused["meeting_id"] == meeting_id
    resumed = invoke(client, "resume_recording")
    assert resumed["status"] == "recording"
    deliver(client, mic=0.3, out=0.6)
    stopped = invoke(client, "stop_recording")
    assert stopped["status"] == "stopped" and stopped["error"] is None

    detail = invoke(client, "get_meeting", id=meeting_id)
    assert detail["meeting"]["source"] == "desktop"
    assert detail["meeting"]["status"] == "stopped"
    tracks = {track["kind"]: track for track in detail["tracks"]}
    assert set(tracks) == {"mic", "system"}
    assert tracks["mic"]["sample_rate"] == RATE and tracks["mic"]["channels"] == 1
    assert tracks["system"]["channels"] == 2
    for track in tracks.values():
        assert track["finalized"] is True
        assert track["frames"] == 2 * FRAMES
        assert track["size_bytes"] == 58 + 2 * FRAMES * track["channels"] * 4
    mic_wav, mic_timing = track_files(client, meeting_id, "mic")
    assert read_samples(mic_wav).tolist() == pytest.approx([0.3] * 2 * FRAMES, rel=1e-6)
    blocks = read_timing(mic_timing, RATE, 2 * FRAMES)
    assert [b.frame_offset for b in blocks] == [0, FRAMES]
    listed = invoke(client, "list_meetings")
    assert [m["source"] for m in listed] == ["desktop"]


def test_second_start_while_active_is_refused_and_stopping_twice_is_harmless(client: TestClient) -> None:
    start(client)
    status, body = invoke_error(client, "start_recording", title="Other", devices=DEVICES)
    assert (status, body["code"]) == (400, "already_recording")
    first = invoke(client, "stop_recording")
    second = invoke(client, "stop_recording")
    assert first["status"] == second["status"] == "stopped"
    assert second["error"] is None


def test_pause_and_resume_refuse_the_wrong_state(client: TestClient) -> None:
    status, body = invoke_error(client, "pause_recording")
    assert (status, body["code"]) == (400, "invalid_state")
    start(client)
    status, body = invoke_error(client, "resume_recording")
    assert (status, body["code"]) == (400, "invalid_state")
    assert body["message"] == "Recording is not paused."


def test_recording_state_events_have_increasing_revisions(client: TestClient) -> None:
    events: list[dict[str, Any]] = []
    rec = recorder(client)
    original_emit = rec.emit

    def capture(name: str, payload: Any) -> None:
        if name == "recording_state":
            events.append(payload)
        original_emit(name, payload)

    rec.emit = capture
    start(client)
    invoke(client, "pause_recording")
    invoke(client, "resume_recording")
    invoke(client, "stop_recording")
    revisions = [event["revision"] for event in events]
    assert len(revisions) == 4
    assert revisions == sorted(set(revisions))
    assert events[-1] == invoke(client, "get_recording_state")


def test_recording_state_shape_when_idle(client: TestClient) -> None:
    state = invoke(client, "get_recording_state")
    assert set(state) == {
        "revision",
        "status",
        "meeting_id",
        "source",
        "error",
        "recording_offset_ms",
        "processing_notice",
    }
    assert state["status"] == "idle" and state["recording_offset_ms"] is None


# ---- pause privacy at the boundaries ---------------------------------------------------


def test_pause_drops_queued_and_in_flight_audio_and_resume_starts_clean(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    gate, entered = gate_writes(monkeypatch)
    meeting_id = start(client)
    session = recorder(client).session
    backend(client).stream_for("fake-mic").deliver(FRAMES, 0.1)  # the writer takes this one and blocks
    assert entered.wait(3)
    # Queued behind the blocked write: these must never reach the file.
    backend(client).stream_for("fake-mic").deliver(FRAMES, 0.2)
    backend(client).stream_for("fake-output").deliver(FRAMES, 0.3)
    backend(client).stream_for("fake-mic").deliver(FRAMES, 0.4)

    generation = session.generation
    pauser = threading.Thread(target=recorder(client).pause)
    pauser.start()
    wait_for(lambda: session.generation != generation)  # pause has taken effect before the writer runs
    gate.set()
    pauser.join(10)

    # In-flight after the boundary (stream stopped, callback still arriving) and while paused.
    backend(client).stream_for("fake-mic").deliver(FRAMES, 0.7)
    backend(client).stream_for("fake-output").deliver(FRAMES, 0.7)
    invoke(client, "resume_recording")
    deliver(client, mic=0.9, out=0.9)
    invoke(client, "stop_recording")

    mic_wav, mic_timing = track_files(client, meeting_id, "mic")
    mic = read_samples(mic_wav).tolist()
    # Only the block the writer had already started before the pause is kept.
    assert mic[:FRAMES] == pytest.approx([0.1] * FRAMES, rel=1e-6)
    assert mic[FRAMES:] == pytest.approx([0.9] * FRAMES, rel=1e-6)
    assert not any(abs(v - 0.2) < 1e-6 or abs(v - 0.4) < 1e-6 or abs(v - 0.7) < 1e-6 for v in mic)
    assert not any(abs(v - 0.8) < 1e-6 for v in mic)
    out_wav, _ = track_files(client, meeting_id, "system")
    out = read_samples(out_wav).tolist()
    assert out == pytest.approx([0.9] * 2 * FRAMES, rel=1e-6)  # the queued 0.3 and in-flight 0.7 are gone

    blocks = read_timing(mic_timing, RATE, 2 * FRAMES)
    assert [b.frame_offset for b in blocks] == [0, FRAMES]
    assert blocks[1].generation > blocks[0].generation


def test_callbacks_after_stop_are_dropped(client: TestClient) -> None:
    meeting_id = start(client)
    deliver(client, mic=0.5, out=0.5)
    stream = backend(client).stream_for("fake-mic")
    invoke(client, "stop_recording")
    stream.deliver(FRAMES, 0.99)  # a callback that was already in flight when stop began
    mic_wav, _ = track_files(client, meeting_id, "mic")
    assert read_samples(mic_wav).tolist() == pytest.approx([0.5] * FRAMES, rel=1e-6)


def test_audio_position_maps_session_time_across_a_pause(client: TestClient) -> None:
    meeting_id = start(client)
    deliver(client, mic=0.1, out=0.1)
    invoke(client, "pause_recording")
    time.sleep(0.05)
    invoke(client, "resume_recording")
    deliver(client, mic=0.2, out=0.2)
    invoke(client, "stop_recording")
    _, mic_timing = track_files(client, meeting_id, "mic")
    second_start_us = read_timing(mic_timing, RATE, 2 * FRAMES)[1].capture_start_us
    assert invoke(client, "audio_position", id=meeting_id, kind="mic", session_ms=0) == 0
    position = invoke(
        client,
        "audio_position",
        id=meeting_id,
        kind="mic",
        session_ms=(second_start_us + 999) // 1000,
    )
    assert position == FRAMES * 1000 // RATE


# ---- failures ----------------------------------------------------------------------


def test_queue_overflow_counts_dropped_frames_and_pauses_visibly(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(recorder_module, "QUEUE_BLOCKS", 2)
    gate, entered = gate_writes(monkeypatch)
    meeting_id = start(client)
    backend(client).stream_for("fake-mic").deliver(FRAMES, 0.1)
    assert entered.wait(3)
    for _ in range(4):  # two fit in the queue, two are dropped
        backend(client).stream_for("fake-mic").deliver(FRAMES, 0.1)
    wait_for(lambda: invoke(client, "get_recording_state")["status"] == "paused")
    state = invoke(client, "get_recording_state")
    assert state["error"] == "Audio queue overflowed. Both tracks paused; stop and start a new recording."
    gate.set()
    invoke(client, "stop_recording")
    tracks = {t["kind"]: t for t in invoke(client, "get_meeting", id=meeting_id)["tracks"]}
    assert tracks["mic"]["dropped_frames"] == 2 * FRAMES
    assert tracks["system"]["dropped_frames"] == 0


def test_device_lost_mid_recording_pauses_and_stop_keeps_the_files(client: TestClient) -> None:
    meeting_id = start(client)
    deliver(client, mic=0.4, out=0.4)
    backend(client).stream_for("fake-mic").fail("device removed")
    wait_for(lambda: invoke(client, "get_recording_state")["status"] == "paused")
    error = invoke(client, "get_recording_state")["error"]
    assert error == (
        "An audio device stopped responding (microphone: device removed). Both tracks paused; "
        "stop, check permissions/devices, and start again."
    )
    stopped = invoke(client, "stop_recording")
    assert stopped["status"] == "stopped" and stopped["error"] == error
    detail = invoke(client, "get_meeting", id=meeting_id)
    assert detail["meeting"]["status"] == "interrupted"
    assert detail["meeting"]["capture_error"] == error
    assert all(track["size_bytes"] for track in detail["tracks"])


def test_disk_full_in_the_writer_pauses_and_keeps_partial_files(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def full(self: WavFile, data: bytes) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(WavFile, "write", full)
    meeting_id = start(client)
    deliver(client, mic=0.4, out=0.4)
    wait_for(lambda: invoke(client, "get_recording_state")["status"] == "paused")
    assert invoke(client, "get_recording_state")["error"].startswith(
        "Audio disk write/finalization failed"
    )
    invoke(client, "stop_recording")
    detail = invoke(client, "get_meeting", id=meeting_id)
    assert detail["meeting"]["status"] == "interrupted"
    # Only the track whose write failed is unfinalized; the meeting is marked interrupted.
    tracks = {t["kind"]: t for t in detail["tracks"]}
    assert tracks["mic"]["finalized"] is False
    for kind in ("mic", "system"):
        wav, timing = track_files(client, meeting_id, kind)
        assert wav.exists() and timing.exists()  # partial files stay, recognisable as unfinished


def test_format_change_on_resume_is_refused_and_stays_paused(client: TestClient) -> None:
    start(client)
    invoke(client, "pause_recording")
    backend(client).set_format("fake-mic", 48000, 1)
    status, body = invoke_error(client, "resume_recording")
    assert (status, body["code"]) == (400, "audio")
    assert body["message"] == "Audio capture: Device format changed. Stop and start a new recording."
    assert invoke(client, "get_recording_state")["status"] == "paused"
    invoke(client, "stop_recording")


def test_missing_selected_microphone_fails_visibly_and_writes_nothing(client: TestClient) -> None:
    backend(client).missing.add("fake-mic")
    status, body = invoke_error(client, "start_recording", title="x", devices=DEVICES)
    assert (status, body["code"]) == (400, "audio")
    assert body["message"] == (
        "Audio capture: Selected microphone is unavailable. Enable microphone access or remote "
        "microphone redirection, then refresh devices."
    )
    assert not audio_dir(client).exists() or not any(audio_dir(client).iterdir())
    assert invoke(client, "list_meetings") == []
    assert invoke(client, "get_recording_state")["status"] == "idle"


def test_missing_output_device_fails_even_with_the_microphone_available(client: TestClient) -> None:
    backend(client).missing.add("fake-output")
    status, body = invoke_error(client, "start_recording", title="x", devices=DEVICES)
    assert (status, body["code"]) == (400, "audio")
    assert body["message"] == "Audio capture: Selected system-output device is unavailable. Refresh devices."
    assert not audio_dir(client).exists() or not any(audio_dir(client).iterdir())
    assert invoke(client, "list_meetings") == []


def test_system_track_failure_after_the_microphone_opened_is_not_a_one_track_fallback(
    client: TestClient,
) -> None:
    backend(client).open_failures["fake-output"] = "Loopback refused"
    status, body = invoke_error(client, "start_recording", title="x", devices=DEVICES)
    assert (status, body["code"]) == (400, "audio")
    assert body["message"] == "Audio capture: Loopback refused"
    assert backend(client).streams[0]._stopped is True  # the microphone that did open was stopped
    assert not audio_dir(client).exists() or not any(audio_dir(client).iterdir())
    assert invoke(client, "list_meetings") == []
    assert invoke(client, "get_recording_state")["status"] == "idle"


def test_save_default_devices_and_empty_selection(client: TestClient) -> None:
    settings = invoke(client, "save_default_devices", microphoneId="fake-mic", outputId="fake-output")
    assert settings["microphone_id"] == "fake-mic" and settings["output_id"] == "fake-output"
    status, body = invoke_error(client, "save_default_devices", microphoneId="", outputId="x")
    assert (status, body["code"]) == (400, "audio_devices")


# ---- files: delete, recover, usage ---------------------------------------------------------


def record(client: TestClient) -> str:
    meeting_id = start(client)
    deliver(client, mic=0.2, out=0.2)
    invoke(client, "stop_recording")
    return meeting_id


def test_delete_meeting_removes_only_its_own_audio_folder(client: TestClient) -> None:
    first = record(client)
    second = record(client)
    stray = audio_dir(client) / str(uuid.uuid4())
    stray.mkdir(parents=True)
    (stray / "stray.wav").write_bytes(b"not ours to delete")

    invoke(client, "delete_meeting", id=first)

    assert not (audio_dir(client) / first).exists()
    assert (audio_dir(client) / second / "mic.wav").exists()
    assert (stray / "stray.wav").read_bytes() == b"not ours to delete"
    assert [m["id"] for m in invoke(client, "list_meetings")] == [second]


def test_delete_audio_is_refused_while_the_meeting_records(client: TestClient) -> None:
    meeting_id = start(client)
    status, body = invoke_error(client, "delete_audio", id=meeting_id)
    assert (status, body["code"]) == (400, "recording_active")
    invoke(client, "stop_recording")
    invoke(client, "delete_audio", id=meeting_id)
    detail = invoke(client, "get_meeting", id=meeting_id)
    assert detail["tracks"] == []
    assert not (audio_dir(client) / meeting_id).exists()


def test_interrupted_recording_is_recovered_into_a_copy_and_the_original_stays(client: TestClient) -> None:
    store = client.app.state.ctx.store
    meeting_id = str(uuid.uuid4())
    folder = audio_dir(client) / meeting_id
    folder.mkdir(parents=True)
    wav = WavFile(folder / "mic.wav", RATE, 1)
    wav.write(array("f", [0.5] * (2 * FRAMES)).tobytes())
    wav.checkpoint(sync=True)
    wav.close()  # a crash: the header is never finalized
    (folder / "mic.timing.jsonl").write_text(timing_line(0, 2 * FRAMES, 0, 1), encoding="ascii")
    original = (folder / "mic.wav").read_bytes()
    with store.lock:
        store.db.execute(
            "INSERT INTO meetings(id, title, started_at, source, status) "
            "VALUES (?1, 'Crashed', '2026-01-01T00:00:00.000000Z', 'desktop', 'interrupted')",
            (meeting_id,),
        )
        store.db.execute("INSERT INTO notes(meeting_id) VALUES (?1)", (meeting_id,))
        store.db.execute(
            "INSERT INTO tracks(meeting_id, kind, path, timing_path, device_name, sample_rate, channels) "
            "VALUES (?1, 'mic', ?2, ?3, 'Synthetic microphone', ?4, 1)",
            (meeting_id, str(folder / "mic.wav"), str(folder / "mic.timing.jsonl"), RATE),
        )

    invoke(client, "recover_audio", id=meeting_id)

    track = invoke(client, "get_meeting", id=meeting_id)["tracks"][0]
    assert track["finalized"] is True and track["frames"] == 2 * FRAMES
    copy = Path(track["path"])
    assert copy.name.startswith("mic.recovered-") and copy.exists()
    assert (folder / "mic.wav").read_bytes() == original
    repaired = copy.read_bytes()
    assert struct.unpack_from("<I", repaired, 54)[0] == 2 * FRAMES * 4
    status, body = invoke_error(client, "recover_audio", id=meeting_id)
    assert (status, body["code"]) == (400, "not_recoverable")


def test_audio_usage_counts_recorded_files(client: TestClient) -> None:
    assert invoke(client, "audio_usage") == 0
    record(client)
    assert invoke(client, "audio_usage") > 0


def test_stale_recording_is_interrupted_at_startup(tmp_path: Path) -> None:
    from openmeet_py.infra.store import Store

    data = tmp_path / "data"
    store = Store(data)
    store.db.execute(
        "INSERT INTO meetings(id, title, started_at, source, status) "
        "VALUES ('crashed', 'Crashed', '2026-01-01T00:00:00.000000Z', 'desktop', 'recording')"
    )
    store.close()
    reopened = Store(data)
    try:
        status = reopened.db.execute("SELECT status FROM meetings WHERE id = 'crashed'").fetchone()[0]
    finally:
        reopened.close()
    assert status == "interrupted"
