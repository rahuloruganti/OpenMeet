"""Cloud transcription: chunking, bounded uploads, response validation and cancel. httpx.MockTransport only."""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any

import httpx
import pytest

from openmeet_py.api.errors import AppError
from openmeet_py.audio.audio_wav import Block
from openmeet_py.domain import providers
from openmeet_py.speech import cloud_stt
from openmeet_py.speech.transcription.audio_read import open_track
from stt_fixtures import write_track

KEY = "fictional-key-never-logged"
BASE = "https://speech.example/v1"


def connection(transport: httpx.BaseTransport) -> providers.Connection:
    return providers.Connection(BASE, "fictional-stt-model", KEY, transport)


def prepared_track(track: dict[str, Any]) -> cloud_stt.PreparedTrack:
    from openmeet_py.audio import audio_wav

    index = audio_wav.read_timing(Path(track["timing_path"]), track["sample_rate"], track["frames"])
    return cloud_stt.PreparedTrack(track["kind"], track["sample_rate"], index, [])


def test_chunks_split_at_pauses_and_generation_changes_and_repeat(tmp_path: Path) -> None:
    track = write_track(tmp_path, "mic", blocks=[(16000, 1_000_000, 1), (16000, 6_000_000, 2)])
    tracks = [track]
    first = cloud_stt.plan(tracks, threading.Event(), cap=16044)
    second = cloud_stt.plan(tracks, threading.Event(), cap=16044)
    try:
        assert first.requests() == 4
        chunks = first.prepared[0].chunks
        assert all(chunk.size <= 16044 for chunk in chunks)
        assert [chunk.digest for chunk in chunks] == [chunk.digest for chunk in second.prepared[0].chunks]
    finally:
        first.close()
        second.close()


def test_chunk_length_is_capped_at_five_minutes() -> None:
    index = [Block(0, 16000 * 700, 0, 0)]
    ranges = cloud_stt.chunk_ranges(index, 16000, 1, cloud_stt.MAX_CHUNK_BYTES)
    assert all(length <= 16000 * 300 for _, length in ranges)
    assert sum(length for _, length in ranges) == 16000 * 700


def test_more_than_two_hundred_requests_is_refused_before_anything_is_sent(tmp_path: Path) -> None:
    blocks = [(1, 1000 * n, n) for n in range(250)]  # every block its own generation: one request each
    track = write_track(tmp_path, "mic", blocks=blocks)
    with pytest.raises(AppError) as info:
        cloud_stt.plan([track], threading.Event())
    assert info.value.code == "cloud_stt"
    assert "more than 200" in info.value.message


def test_a_damaged_timing_index_refuses_the_plan(tmp_path: Path) -> None:
    track = write_track(tmp_path, "mic")
    Path(track["timing_path"]).write_text("{broken", encoding="ascii")
    with pytest.raises(AppError) as info:
        cloud_stt.plan([track], threading.Event())
    assert info.value.code == "audio_timing"


def test_the_plan_is_refused_for_a_mismatched_track_on_transcribe(tmp_path: Path) -> None:
    track = write_track(tmp_path, "mic")
    plan = cloud_stt.plan([track], threading.Event())
    try:
        changed = dict(track, frames=track["frames"] - 1)
        with pytest.raises(AppError) as info:
            cloud_stt.transcribe(
                connection(httpx.MockTransport(lambda r: httpx.Response(500))),
                [changed],
                "auto",
                "",
                plan,
                threading.Event(),
                lambda k, p: None,
                lambda f, b: None,
            )
        assert info.value.code == "cloud_stt"
    finally:
        plan.close()


def test_response_timing_is_validated_and_mapped_across_a_pause() -> None:
    track = cloud_stt.PreparedTrack("mic", 16000, [Block(0, 16000, 1_000_000, 1), Block(16000, 16000, 6_000_000, 2)], [])
    chunk = cloud_stt.Chunk(Path("unused.wav"), 16000, 16000, 100, "d")
    body = json.dumps(
        {"text": "resumed", "segments": [{"text": "resumed", "start": 0.0, "end": 0.5}]}
    ).encode()
    entries = cloud_stt.parse_response(body, track, chunk)
    assert entries == [{"speaker": "You", "timing": {"kind": "timed", "start_ms": 6000, "end_ms": 6500}, "text": "resumed"}]
    bad_responses = [
        {"text": "x", "segments": [{"text": "x", "start": -1, "end": 0.1}]},
        {"text": "x", "segments": [{"text": "x", "start": 0.2, "end": 0.1}]},
        {"text": "x", "segments": [{"text": "x", "start": 0.0, "end": 9.0}]},
        {"text": "x", "segments": [{"text": "x", "start": "0", "end": 0.1}]},
        {"text": "x", "segments": [{"text": "x", "start": True, "end": 0.1}]},
        {"text": "x", "segments": "not a list"},
        {"segments": []},
        {"text": "x", "segments": [{"text": "x"}]},
    ]
    for response in bad_responses:
        with pytest.raises(AppError) as info:
            cloud_stt.parse_response(json.dumps(response).encode(), track, chunk)
        assert info.value.code == "cloud_stt", response
    with pytest.raises(AppError):
        cloud_stt.parse_response(b"not json", track, chunk)
    with pytest.raises(AppError):
        cloud_stt.parse_response(
            b'{"text":"x","segments":[{"text":"x","start":1e999,"end":1e999}]}', track, chunk
        )
    assert cloud_stt.parse_response(b'{"text":""}', track, chunk) == []
    assert cloud_stt.parse_response(b'{"text":"  plain  "}', track, chunk) == [
        {"speaker": "You", "timing": {"kind": "untimed"}, "text": "plain"}
    ]
    empty_segment = {"text": "", "segments": [{"text": "  ", "start": 0.0, "end": 0.1}]}
    assert cloud_stt.parse_response(json.dumps(empty_segment).encode(), track, chunk) == []


def test_separate_tracks_send_multipart_with_settings_and_plain_json_is_untimed(tmp_path: Path) -> None:
    mic = write_track(tmp_path, "mic", blocks=[(1600, 0, 1)])
    system = write_track(tmp_path, "system", blocks=[(1600, 0, 1)], freq=660.0)
    plan = cloud_stt.plan([mic, system], threading.Event())
    seen: list[httpx.Request] = []
    replies = [{"text": "You said hello"}, {"text": "They said hello"}]

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=replies[len(seen) - 1])

    try:
        entries = cloud_stt.transcribe(
            connection(httpx.MockTransport(handler)),
            [mic, system],
            "en",
            "  OpenMeet  ",
            plan,
            threading.Event(),
            lambda k, p: None,
            lambda fingerprint, size: None,
        )
    finally:
        plan.close()
    assert [entry["speaker"] for entry in entries] == ["You", "Others"]
    assert all(entry["timing"]["kind"] == "untimed" for entry in entries)
    assert len(seen) == 2
    for request in seen:
        body = request.content.decode("latin-1")
        assert str(request.url) == f"{BASE}/audio/transcriptions"
        assert request.method == "POST"
        assert 'name="model"' in body and "fictional-stt-model" in body
        assert 'name="language"' in body and "\r\nen\r\n" in body
        assert 'name="prompt"' in body and "OpenMeet" in body
        assert 'filename="audio.wav"' in body and "RIFF" in body
        assert str(tmp_path) not in body
        assert request.headers["authorization"] == f"Bearer {KEY}"


def test_auto_language_is_omitted_and_no_retry_on_server_error(tmp_path: Path) -> None:
    track = write_track(tmp_path, "mic")
    plan = cloud_stt.plan([track], threading.Event())
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(500, text="fictional body that must not be echoed")

    try:
        with pytest.raises(AppError) as info:
            cloud_stt.transcribe(
                connection(httpx.MockTransport(handler)), [track], "auto", "", plan, threading.Event(),
                lambda k, p: None, lambda f, b: None,
            )
    finally:
        plan.close()
    assert info.value.code == "provider_response"
    assert len(seen) == 1
    assert 'name="language"' not in seen[0].content.decode("latin-1")


def test_unauthorized_answers_name_no_key(tmp_path: Path) -> None:
    track = write_track(tmp_path, "mic")
    plan = cloud_stt.plan([track], threading.Event())
    try:
        with pytest.raises(AppError) as info:
            cloud_stt.transcribe(
                connection(httpx.MockTransport(lambda r: httpx.Response(401))), [track], "auto", "", plan,
                threading.Event(), lambda k, p: None, lambda f, b: None,
            )
    finally:
        plan.close()
    assert info.value.code == "provider_unauthorized"
    assert KEY not in info.value.message


def test_a_refused_request_is_never_sent(tmp_path: Path) -> None:
    track = write_track(tmp_path, "mic")
    plan = cloud_stt.plan([track], threading.Event())
    seen: list[httpx.Request] = []

    def refuse(fingerprint: str, size: int) -> None:
        assert len(fingerprint) == 64 and size > 0
        raise AppError("plan_changed", "Refused.")

    try:
        with pytest.raises(AppError) as info:
            cloud_stt.transcribe(
                connection(httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(200, json={"text": "x"}))),
                [track], "auto", "", plan, threading.Event(), lambda k, p: None, refuse,
            )
    finally:
        plan.close()
    assert info.value.code == "plan_changed"
    assert seen == []


def test_cancel_between_chunks_stops_further_uploads(tmp_path: Path) -> None:
    track = write_track(tmp_path, "mic", blocks=[(1600, 0, 0)])  # 800 frames per chunk at this cap
    plan = cloud_stt.plan([track], threading.Event(), cap=1644)
    assert plan.requests() == 2
    cancel = threading.Event()
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        cancel.set()
        return httpx.Response(200, json={"text": "first"})

    try:
        with pytest.raises(AppError) as info:
            cloud_stt.transcribe(
                connection(httpx.MockTransport(handler)), [track], "auto", "", plan, cancel,
                lambda k, p: None, lambda f, b: None,
            )
    finally:
        plan.close()
    assert info.value.code == "stt_cancelled"
    assert len(seen) == 1


def test_oversize_responses_are_refused(tmp_path: Path) -> None:
    track = write_track(tmp_path, "mic")
    plan = cloud_stt.plan([track], threading.Event())
    big = b'{"text":"' + b"x" * (cloud_stt.MAX_RESPONSE_BYTES + 10) + b'"}'
    try:
        with pytest.raises(AppError) as info:
            cloud_stt.transcribe(
                connection(httpx.MockTransport(lambda r: httpx.Response(200, content=big))), [track], "auto", "",
                plan, threading.Event(), lambda k, p: None, lambda f, b: None,
            )
    finally:
        plan.close()
    assert info.value.code == "cloud_stt"


def test_keys_stay_out_of_reprs_and_logs(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    conn = connection(httpx.MockTransport(lambda r: httpx.Response(500)))
    assert KEY not in repr(conn)
    track = write_track(tmp_path, "mic")
    plan = cloud_stt.plan([track], threading.Event())
    caplog.set_level(logging.DEBUG)
    try:
        with pytest.raises(AppError) as info:
            cloud_stt.transcribe(conn, [track], "auto", "", plan, threading.Event(), lambda k, p: None, lambda f, b: None)
    finally:
        plan.close()
    assert KEY not in info.value.message
    assert KEY not in caplog.text


def test_transport_errors_are_reported_without_the_url(tmp_path: Path) -> None:
    track = write_track(tmp_path, "mic")
    plan = cloud_stt.plan([track], threading.Event())

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("fictional connect failure", request=request)

    try:
        with pytest.raises(AppError) as info:
            cloud_stt.transcribe(
                connection(httpx.MockTransport(handler)), [track], "auto", "", plan, threading.Event(),
                lambda k, p: None, lambda f, b: None,
            )
    finally:
        plan.close()
    assert info.value.code == "cloud_stt"
    assert "Cannot reach the transcription provider" in info.value.message
    assert "speech.example" not in info.value.message


def test_bad_language_or_prompt_is_refused_before_any_request(tmp_path: Path) -> None:
    track = write_track(tmp_path, "mic")
    plan = cloud_stt.plan([track], threading.Event())
    seen: list[httpx.Request] = []
    try:
        for language, prompt in [("de; rm", ""), ("", ""), ("en", "x" * 501)]:
            with pytest.raises(AppError) as info:
                cloud_stt.transcribe(
                    connection(httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(200, json={"text": ""}))),
                    [track], language, prompt, plan, threading.Event(), lambda k, p: None, lambda f, b: None,
                )
            assert info.value.code == "cloud_stt"
    finally:
        plan.close()
    assert seen == []


def test_invalid_samples_refuse_the_chunk(tmp_path: Path) -> None:
    from openmeet_py.audio import audio_wav

    folder = tmp_path / "bad"
    folder.mkdir()
    writer = audio_wav.WavFile(folder / "mic.wav", 16000, 1)
    writer.write(bytes([0, 0, 0xC0, 0x7F]) * 800)  # a NaN sample
    assert writer.finalize()
    (folder / "mic.timing.jsonl").write_text(audio_wav.timing_line(0, 800, 0, 0), encoding="ascii")
    track = {
        "kind": "mic", "path": str(folder / "mic.wav"), "timing_path": str(folder / "mic.timing.jsonl"),
        "device_name": "Synthetic", "sample_rate": 16000, "channels": 1, "frames": 800,
        "dropped_frames": 0, "finalized": 1,
    }
    with pytest.raises(AppError) as info:
        cloud_stt.plan([track], threading.Event())
    assert "invalid samples" in info.value.message
