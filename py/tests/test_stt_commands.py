"""Speech commands end to end through the API, with the fake engine and synthetic recordings only.

OPENMEET_PY_FAKE_STT=1 reports the speech files as installed without creating any file, and the engine
is replaced by FakeEngine, so no model is read and nothing is downloaded.
"""

from __future__ import annotations

import threading
from typing import Any

import pytest
from fastapi.testclient import TestClient

from conftest import TOKEN, invoke, invoke_error
from openmeet_py import reads, stt
from openmeet_py.transcription import jobs
from openmeet_py.transcription import engine as engine_module
from openmeet_py.transcription.engine import FakeEngine
from openmeet_py.server import TOKEN_HEADER
from stt_fixtures import add_meeting, recording


@pytest.fixture
def fake_stt(monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setenv("OPENMEET_PY_FAKE_STT", "1")
    return monkeypatch


def use_engine(monkeypatch: pytest.MonkeyPatch, engine: FakeEngine) -> FakeEngine:
    monkeypatch.setattr(engine_module, "make_engine", lambda model_path, vad, fake: engine)
    return engine


def segments_of(client: TestClient, meeting: str) -> list[dict[str, Any]]:
    return invoke(client, "get_meeting", id=meeting)["segments"]


def test_status_lists_the_catalog_and_marks_sherpa_as_unavailable(client: TestClient) -> None:
    speech = invoke(client, "stt_status")
    by_id = {model["id"]: model for model in speech["models"]}
    assert by_id["base.en-q5_1"]["size"] == 59721011
    assert by_id["small"]["size"] == 487601967
    assert by_id["base"]["size"] == 147951465
    for sherpa in ["sherpa:parakeet-v3", "sherpa:moonshine-base-en", "sherpa:sense-voice"]:
        assert by_id[sherpa]["installed"] is False
        assert "phase 4b" in by_id[sherpa]["reason"]
    assert speech["supported"] in (True, False)
    assert "auto" in speech["languages"] and len(speech["languages"]) == 35


def test_stt_settings_validate_and_persist(client: TestClient) -> None:
    status, body = invoke_error(client, "save_stt_settings", language="xx", prompt="", model="small")
    assert (status, body["code"]) == (400, "stt_settings")
    status, body = invoke_error(client, "save_stt_settings", language="en", prompt="bad\x07", model="small")
    assert body["code"] == "stt_settings"
    status, body = invoke_error(client, "save_stt_settings", language="en", prompt="", model="sherpa:parakeet-v3")
    assert body["code"] == "stt_settings"
    settings = invoke(client, "save_stt_settings", language="de", prompt="  Kubernetes, Okta  ", model="base")
    assert (settings["stt_language"], settings["stt_prompt"], settings["stt_model"]) == ("de", "Kubernetes, Okta", "base")
    assert invoke(client, "save_stt_mode", mode="cloud")["stt_mode"] == "cloud"
    status, body = invoke_error(client, "save_stt_mode", mode="remote")
    assert body["code"] == "invalid_args"


def test_transcribe_meeting_writes_labelled_timed_segments(client: TestClient, fake_stt: Any) -> None:
    meeting = recording(client.app.state.ctx)
    invoke(client, "transcribe_meeting", id=meeting)
    detail = invoke(client, "get_meeting", id=meeting)
    assert detail["transcript_provider"] == "whisper"
    assert detail["transcript_model"] == "small"
    speakers = {segment["speaker"] for segment in detail["segments"]}
    assert speakers == {"You", "Others"}
    assert all(segment["timing"]["kind"] == "timed" for segment in detail["segments"])
    assert all("Fictional line" in segment["text"] for segment in detail["segments"])
    # Sorted by start time, as the merge does.
    starts = [segment["timing"]["start_ms"] for segment in detail["segments"]]
    assert starts == sorted(starts)


def test_retranscribing_keeps_the_earlier_transcript_as_a_version(
    client: TestClient, fake_stt: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    meeting = recording(client.app.state.ctx)
    use_engine(monkeypatch, FakeEngine(text="First pass"))
    invoke(client, "transcribe_meeting", id=meeting)
    meta = invoke(client, "get_meeting", id=meeting)["segment_meta"][0]
    invoke(client, "edit_segment", meetingId=meeting, segmentId=meta["id"], baseText="First pass 1", text="First corrected")
    use_engine(monkeypatch, FakeEngine(text="Second pass"))
    invoke(client, "transcribe_meeting", id=meeting)
    detail = invoke(client, "get_meeting", id=meeting)
    assert all(segment["text"].startswith("Second pass") for segment in detail["segments"])
    assert len(detail["transcript_versions"]) == 1
    version = detail["transcript_versions"][0]
    assert version["edited"] is True
    old = invoke(client, "get_transcript_version", meetingId=meeting, versionId=version["id"])
    assert old[0]["text"] == "First corrected"


def test_a_failed_run_keeps_the_previous_transcript(client: TestClient, fake_stt: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    meeting = recording(client.app.state.ctx)
    use_engine(monkeypatch, FakeEngine(text="Kept"))
    invoke(client, "transcribe_meeting", id=meeting)
    before = segments_of(client, meeting)
    use_engine(monkeypatch, FakeEngine(fail_with="engine exploded with fictional words"))
    status, body = invoke_error(client, "transcribe_meeting", id=meeting)
    assert status == 400 and body["code"] == "stt"
    assert "fictional words" not in body["message"]
    assert segments_of(client, meeting) == before
    assert invoke(client, "get_meeting", id=meeting)["transcript_versions"] == []


def test_cancel_during_a_run_keeps_the_previous_transcript(
    client: TestClient, fake_stt: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    ctx = client.app.state.ctx
    meeting = recording(ctx)
    use_engine(monkeypatch, FakeEngine(text="Kept"))
    invoke(client, "transcribe_meeting", id=meeting)
    before = segments_of(client, meeting)
    seen: list[bool] = []

    def cancel_now(index: int) -> None:
        # Called on the job's worker thread, as the engine would call it; the request thread is waiting.
        seen.append(jobs.cancel_transcription(ctx))

    use_engine(monkeypatch, FakeEngine(text="Cancelled", on_window=cancel_now))
    status, body = invoke_error(client, "transcribe_meeting", id=meeting)
    assert body["code"] == "stt_cancelled"
    assert seen == [True]
    assert segments_of(client, meeting) == before
    assert invoke(client, "cancel_transcription") is False


def test_only_one_transcription_runs_at_a_time(client: TestClient, fake_stt: Any) -> None:
    ctx = client.app.state.ctx
    meeting = recording(ctx)
    assert ctx.stt_busy.acquire(blocking=False)
    try:
        status, body = invoke_error(client, "transcribe_meeting", id=meeting)
        assert (status, body["code"]) == (400, "processing_busy")
    finally:
        ctx.stt_busy.release()


def test_a_recording_in_progress_is_not_transcribed(client: TestClient, fake_stt: Any) -> None:
    ctx = client.app.state.ctx
    meeting = add_meeting(ctx, [], status="recording")
    status, body = invoke_error(client, "transcribe_meeting", id=meeting)
    assert body == {"code": "stt", "message": "Stop the recording before transcribing it."}


def test_a_meeting_without_audio_is_refused(client: TestClient, fake_stt: Any) -> None:
    meeting = add_meeting(client.app.state.ctx, [])
    status, body = invoke_error(client, "transcribe_meeting", id=meeting)
    assert body["code"] == "stt"


def test_cloud_mode_without_a_connection_is_refused(client: TestClient, fake_stt: Any) -> None:
    meeting = recording(client.app.state.ctx)
    invoke(client, "save_stt_mode", mode="cloud")
    status, body = invoke_error(client, "transcribe_meeting", id=meeting)
    assert body["code"] == "provider_missing"


def test_local_mode_without_installed_files_is_refused_outside_fake_mode(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENMEET_PY_FAKE_STT", raising=False)
    meeting = recording(client.app.state.ctx)
    status, body = invoke_error(client, "transcribe_meeting", id=meeting)
    assert body["code"] == "stt"
    assert "not installed" in body["message"]


def test_install_in_fake_mode_downloads_nothing(client: TestClient, fake_stt: Any) -> None:
    speech = invoke(client, "stt_install")
    assert speech["installed"] is True


def test_install_refuses_before_any_download_when_the_engine_or_platform_is_missing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from openmeet_py import model_library

    def no_download(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("no download may start in this test")

    monkeypatch.delenv("OPENMEET_PY_FAKE_STT", raising=False)
    monkeypatch.setattr(model_library, "fetch_verified", no_download)
    monkeypatch.setattr(stt, "engine_available", lambda: False)
    status, body = invoke_error(client, "stt_install")
    assert body["code"] == "stt" and "pywhispercpp" in body["message"]
    monkeypatch.setattr(stt, "engine_available", lambda: True)
    monkeypatch.setattr(stt, "supported", lambda: False)
    status, body = invoke_error(client, "stt_install")
    assert body["code"] == "stt"


def test_install_downloads_only_the_vad_and_the_selected_model(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from openmeet_py import model_library

    calls: list[str] = []

    def record(url: str, folder: Any, filename: str, size: int, sha256: str, **kwargs: Any) -> None:
        calls.append(filename)
        assert url.startswith("https://huggingface.co/")
        kwargs["progress"](size)

    monkeypatch.delenv("OPENMEET_PY_FAKE_STT", raising=False)
    monkeypatch.setattr(model_library, "fetch_verified", record)
    monkeypatch.setattr(stt, "engine_available", lambda: True)
    monkeypatch.setattr(stt, "supported", lambda: True)
    invoke(client, "save_stt_settings", language="en", prompt="", model="base.en-q5_1")
    # The fake download writes nothing, so the status stays "not installed" afterwards.
    speech = invoke(client, "stt_install")
    assert calls == ["ggml-silero-v5.1.2.bin", "ggml-base.en-q5_1.bin"]
    assert speech["installed"] is False


def test_transcript_edit_and_versions_are_guarded_by_the_token(client: TestClient) -> None:
    response = client.post("/api/invoke/get_transcript_version", json={"meetingId": "m", "versionId": 1})
    assert response.status_code == 401
    response = client.post(
        "/api/invoke/get_transcript_version",
        json={"meetingId": "m", "versionId": 1},
        headers={TOKEN_HEADER: TOKEN},
    )
    assert response.status_code == 400


def test_choose_model_folder_uses_the_native_picker_hook(make_client: Any, tmp_path: Any) -> None:
    client = make_client(pick_folder=lambda: str(tmp_path))
    assert invoke(client, "choose_model_folder") == str(tmp_path)
    client = make_client()
    status, body = invoke_error(client, "choose_model_folder")
    assert (status, body["code"]) == (501, "not_available")


def test_stt_settings_round_trip_through_read_settings(client: TestClient) -> None:
    invoke(client, "save_stt_settings", language="fr", prompt="Ana", model="tiny")
    settings = invoke(client, "get_settings")
    assert settings["stt_language"] == "fr" and settings["stt_model"] == "tiny"
    assert reads.read_settings(client.app.state.ctx.store.db)["stt_prompt"] == "Ana"
