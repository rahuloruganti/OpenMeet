"""Live decoders, LiveSession, resolve() and listing(), on synthetic audio and fakes only.

No model file, no native library and no network: decoders take a fake gate or a fake recognizer, the
session takes a fake decoder, and the resolver gets model files made here.
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

import numpy as np
import pytest

from openmeet_py.api.errors import AppError
from openmeet_py.speech import sherpa_models, stt, streaming_models
from openmeet_py.speech.live import (
    CloudDecoder,
    FakeDecoder,
    LiveSession,
    Resolved,
    StreamingDecoder,
    Update,
    VadDecoder,
    listing,
    resolve,
)
from openmeet_py.speech.live.decoders import CLOUD_MAX_UTTERANCE, LevelGate
from openmeet_py.speech.live.resample import LaneConverter
from openmeet_py.speech.live.session import PARTIAL_GAP_SECONDS, SPEECH_FAILED
from openmeet_py.speech.transcription import audio_read

RATE = 16000
BLOCK = 1600  # 100 ms


def tone(seconds: float, rate: int = RATE, channels: int = 1) -> np.ndarray:
    t = np.arange(int(rate * seconds)) / rate
    mono = (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    return mono if channels == 1 else np.repeat(mono[:, None], channels, axis=1)


def packed(samples: np.ndarray) -> bytes:
    return np.ascontiguousarray(samples, dtype="<f4").tobytes()


class FakeGate:
    """Closes the fixed regions once their last sample has been pushed."""

    def __init__(self, regions: list[tuple[int, int]]):
        self.regions = list(regions)
        self.fed = 0
        self.closed: set[int] = set()

    def push(self, samples16k: np.ndarray) -> list[tuple[int, int]]:
        self.fed += int(np.asarray(samples16k).size)
        return self._ready(final=False)

    def flush(self) -> list[tuple[int, int]]:
        return self._ready(final=True)

    def _ready(self, final: bool) -> list[tuple[int, int]]:
        out: list[tuple[int, int]] = []
        for index, (start, end) in enumerate(self.regions):
            if index in self.closed:
                continue
            if end <= self.fed or (final and start < self.fed):
                out.append((start, min(end, self.fed)))
                self.closed.add(index)
        return out


def words(audio: np.ndarray) -> str:
    return f"words {int(np.asarray(audio).size)}"


# ---- resampling --------------------------------------------------------------------------


def test_the_resampler_has_no_gap_or_seam_between_blocks() -> None:
    samples = tone(1.0, 44100, 1)
    whole = LaneConverter(44100, 1)
    one_shot = np.concatenate([whole.push(packed(samples), samples.size), whole.finish()])

    blocked = LaneConverter(44100, 1)
    pieces: list[np.ndarray] = []
    at = 0
    step = 1023  # an awkward block size, so no block boundary falls on a resampler period
    while at < samples.size:
        take = samples[at:at + step]
        pieces.append(blocked.push(packed(take), take.size))
        at += step
    pieces.append(blocked.finish())
    split = np.concatenate(pieces)

    assert split.size == one_shot.size == whole._resampler.out_length(samples.size)
    assert np.allclose(split, one_shot, atol=1e-6)


def test_downmix_and_resample_keep_a_stereo_signal_aligned() -> None:
    stereo = tone(0.5, 48000, 2)
    converter = LaneConverter(48000, 2)
    out = np.concatenate([converter.push(packed(stereo), stereo.shape[0]), converter.finish()])
    expected = audio_read.resample(stereo.mean(axis=1).astype(np.float64), 48000, 16000)
    assert out.size == pytest.approx(expected.size, abs=1)
    assert np.allclose(out[: expected.size], expected, atol=2e-3)
    assert not np.isnan(out).any()


def test_a_block_of_nan_samples_does_not_reach_the_decoder() -> None:
    samples = tone(0.1, RATE, 1).copy()
    samples[10:20] = np.nan
    converter = LaneConverter(RATE, 1)
    out = converter.push(packed(samples), samples.size)
    assert out.size == samples.size and np.all(np.isfinite(out))


# ---- VAD plus an offline engine ----------------------------------------------------------


def test_vad_decoder_emits_a_partial_then_the_final_for_the_same_utterance() -> None:
    decoder = VadDecoder(FakeGate([(0, 3 * RATE)]), words)
    seen: list[Update] = []
    for _ in range(3):
        seen.extend(decoder.feed(tone(1.0)))
    seen.extend(decoder.finish())

    partials = [item for item in seen if not item.final]
    finals = [item for item in seen if item.final]
    assert [(item.utterance, item.text) for item in partials] == [(0, "words 32000")]
    assert [(item.utterance, item.start, item.end, item.text) for item in finals] == [(0, 0, 48000, "words 48000")]
    assert seen.index(partials[0]) < seen.index(finals[0])


def test_vad_decoder_forces_a_cut_at_fifteen_seconds() -> None:
    decoder = VadDecoder(FakeGate([]), words)
    updates: list[Update] = []
    for _ in range(16):
        updates.extend(decoder.feed(tone(1.0)))
    finals = [item for item in updates if item.final]
    assert [(item.start, item.end) for item in finals] == [(0, 15 * RATE)]
    assert finals[0].text == "words 240000"


def test_vad_decoder_decodes_a_partial_round_at_most_every_one_and_a_half_seconds() -> None:
    calls: list[int] = []
    in_flight = [0]
    deepest = [0]

    def decode(audio: np.ndarray) -> str:
        in_flight[0] += 1
        deepest[0] = max(deepest[0], in_flight[0])
        calls.append(int(audio.size))
        time.sleep(0.001)  # a decode takes real time; a second one must not start inside it
        in_flight[0] -= 1
        return words(audio)

    decoder = VadDecoder(FakeGate([]), decode)
    for _ in range(10):
        decoder.feed(tone(1.0))
    assert deepest[0] == 1
    assert len(calls) == 5  # 1.5 s rounds inside 10 s of open speech, one decode each
    assert all(later - earlier >= 24_000 for earlier, later in zip(calls, calls[1:]))


def test_vad_decoder_decodes_the_leftover_at_finish() -> None:
    decoder = VadDecoder(FakeGate([]), words)
    assert decoder.feed(tone(1.2)) == []
    finals = decoder.finish()
    assert [(item.start, item.end, item.final) for item in finals] == [(0, 19200, True)]


# ---- streaming ---------------------------------------------------------------------------


class FakeResult:
    def __init__(self, text: str = "") -> None:
        self.text = text


class FakeStream:
    def __init__(self) -> None:
        self.fed = 0
        self.ready = False
        self.finished = False
        self.result = FakeResult()

    def accept_waveform(self, rate: int, samples: np.ndarray) -> None:
        assert rate == RATE
        self.fed += int(np.asarray(samples).size)
        self.ready = True

    def input_finished(self) -> None:
        self.finished = True


class FakeRecognizer:
    """Decodes once per feed and returns the next text from a script."""

    def __init__(self, script: list[str], endpoint: bool = False):
        self.script = list(script)
        self.endpoint = endpoint
        self.calls = 0

    def create_stream(self) -> FakeStream:
        return FakeStream()

    def is_ready(self, stream: FakeStream) -> bool:
        return stream.ready

    def decode_stream(self, stream: FakeStream) -> None:
        stream.ready = False
        self.calls += 1
        stream.result.text = self.script[min(self.calls, len(self.script)) - 1]

    def is_endpoint(self, stream: FakeStream) -> bool:
        return self.endpoint

    def get_result(self, stream: FakeStream) -> Any:
        return stream.result.text  # sherpa-onnx 1.13 returns the text itself


def test_streaming_decoder_emits_a_partial_per_text_change_and_a_final_on_endpoint() -> None:
    recognizer = FakeRecognizer(["one", "one two", "one two three"])
    decoder = StreamingDecoder(recognizer)
    assert [(u.utterance, u.text, u.start, u.end, u.final) for u in decoder.feed(tone(1.0))] == [
        (0, "one", 0, 16000, False)
    ]
    assert [(u.utterance, u.text, u.final) for u in decoder.feed(tone(1.0))] == [(0, "one two", False)]
    recognizer.endpoint = True
    assert [(u.utterance, u.text, u.start, u.end, u.final) for u in decoder.feed(tone(1.0))] == [
        (0, "one two three", 0, 48000, True)
    ]
    # The next utterance starts where this one ended, with a clean stream.
    assert [(u.utterance, u.start) for u in StreamingDecoder(FakeRecognizer(["again"])).feed(tone(1.0))] == [(0, 0)]


def test_streaming_decoder_accepts_a_result_object_from_an_older_library() -> None:
    recognizer = FakeRecognizer(["one"])
    recognizer.get_result = lambda stream: stream.result  # an object with .text
    assert [item.text for item in StreamingDecoder(recognizer).feed(tone(1.0))] == ["one"]


def test_streaming_decoder_finish_closes_the_open_utterance_and_can_carry_on() -> None:
    recognizer = FakeRecognizer(["hello", "after"])
    decoder = StreamingDecoder(recognizer)
    assert decoder.feed(tone(1.0))[0].final is False
    assert [(u.text, u.start, u.end, u.final) for u in decoder.finish()] == [("hello", 0, 16000, True)]
    resumed = decoder.feed(tone(1.0))
    assert [(u.utterance, u.text, u.start) for u in resumed] == [(1, "after", 16000)]


# ---- cloud -------------------------------------------------------------------------------


def test_cloud_decoder_uploads_one_finished_utterance_and_never_partials() -> None:
    uploads: list[int] = []

    def upload(audio: np.ndarray) -> str:
        uploads.append(int(audio.size))
        return "hello there"

    decoder = CloudDecoder(upload, FakeGate([(0, RATE), (2 * RATE, 3 * RATE)]))
    updates: list[Update] = []
    for _ in range(3):
        updates.extend(decoder.feed(tone(1.0)))
    updates.extend(decoder.finish())
    assert [item.text for item in updates] == ["hello there", "hello there"]
    assert all(item.final for item in updates)
    assert uploads == [RATE, RATE]
    assert decoder.requests == 2 and decoder.blocked is False


def test_cloud_decoder_stops_at_its_request_cap_and_never_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("openmeet_py.speech.live.decoders.CLOUD_MAX_REQUESTS", 1)
    calls: list[int] = []

    def upload(audio: np.ndarray) -> str:
        calls.append(int(audio.size))
        return "line"

    decoder = CloudDecoder(upload, FakeGate([]))
    for _ in range(30):
        decoder.feed(tone(1.0))  # a forced cut at 30 s makes one upload
    assert decoder.requests == 1 and calls == [CLOUD_MAX_UTTERANCE]
    for _ in range(30):
        decoder.feed(tone(1.0))
    assert decoder.blocked is True and decoder.requests == 1 and calls == [CLOUD_MAX_UTTERANCE]


# ---- LiveSession -------------------------------------------------------------------------


class RecordingDecoder:
    """A decoder that reports whatever the test asks for and records lifecycle calls."""

    def __init__(self, feed: Optional[Callable[[int], list[Update]]] = None):
        self.fed = 0
        self.finishes = 0
        self._feed = feed or (lambda _samples: [])

    def feed(self, samples16k: np.ndarray) -> list[Update]:
        size = int(np.asarray(samples16k).size)
        self.fed += size
        return self._feed(self.fed)

    def finish(self) -> list[Update]:
        self.finishes += 1
        return []


class BlockingDecoder(RecordingDecoder):
    def __init__(self, gate) -> None:
        super().__init__()
        self.gate = gate

    def feed(self, samples16k: np.ndarray) -> list[Update]:
        self.gate.wait(5.0)
        return super().feed(samples16k)


def wait_for(predicate: Callable[[], bool], timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def session(lanes: list[tuple[str, int, int]], decoder, lines: list[dict], states: list[dict],
            **kwargs: Any) -> LiveSession:
    resolved = Resolved("Test engine", False, lambda: decoder)
    return LiveSession("meeting-1", lanes, resolved, lines.append, states.append, **kwargs)


def test_a_full_queue_drops_blocks_and_marks_the_transcript_incomplete() -> None:
    gate = threading.Event()
    states: list[dict] = []
    lines: list[dict] = []
    live = session([("mic", RATE, 1)], BlockingDecoder(gate), lines, states, queue_seconds=2.0)
    live.start()
    assert wait_for(lambda: any(item["state"] == "running" for item in states))
    blocks = [packed(tone(1.0)) for _ in range(4)]
    for index, data in enumerate(blocks):
        live.accept(0, data, RATE, index * 1_000_000, 0)  # never raises, never blocks
    assert live.incomplete is True
    gate.set()
    live.stop()
    assert [item["state"] for item in states] == ["starting", "running", "stopped"]


def test_blocks_are_kept_in_order_and_the_lane_reports_its_speaker_and_id() -> None:
    seen: list[int] = []

    def feed(fed: int) -> list[Update]:
        seen.append(fed)
        return [Update(0, f"line {fed}", 0, fed, True)] if fed >= 32000 else []

    decoder = RecordingDecoder(feed)
    states: list[dict] = []
    lines: list[dict] = []
    live = session([("system", RATE, 1)], decoder, lines, states)
    live.start()
    live.accept(0, packed(tone(1.0)), RATE, 0, 0)
    live.accept(0, packed(tone(1.0)), RATE, 1_000_000, 0)
    live.stop()
    assert live.incomplete is False
    assert [line["id"] for line in lines] == ["system:0"]
    assert lines[0]["lane"] == "system" and lines[0]["speaker"] == "Others"
    assert lines[0]["start_ms"] == 0 and lines[0]["end_ms"] == 2000 and lines[0]["final"] is True


def test_utterance_times_follow_the_capture_clock_across_a_pause() -> None:
    def feed(fed: int) -> list[Update]:
        return [Update(fed // RATE - 1, f"line {fed}", fed - RATE, fed, True)]

    lines: list[dict] = []
    live = session([("mic", RATE, 1)], RecordingDecoder(feed), lines, [])
    live.start()
    live.accept(0, packed(tone(1.0)), RATE, 0, 0)
    live.accept(0, packed(tone(1.0)), RATE, 1_000_000, 0)
    # A pause: the recorder writes no audio, and the next block starts six seconds later.
    live.accept(0, packed(tone(1.0)), RATE, 7_000_000, 1)
    live.accept(0, packed(tone(1.0)), RATE, 8_000_000, 1)
    live.stop()
    assert [line["start_ms"] for line in lines] == [0, 1000, 7000, 8000]
    assert [line["end_ms"] for line in lines] == [1000, 2000, 8000, 9000]


def test_partials_are_throttled_to_five_a_second_and_finals_never_are() -> None:
    now = [0.0]
    stamps: list[float] = []

    def feed(fed: int) -> list[Update]:
        now[0] += 0.05  # every block advances the clock, so the throttle is deterministic
        utterance = fed // (2 * RATE)
        return [
            Update(utterance, f"partial {fed}", fed - 800, fed, False),
            Update(utterance, f"final {utterance}", fed - 800, fed, True),
        ]

    lines: list[dict] = []

    def on_line(line: dict) -> None:
        lines.append(line)
        if not line["final"]:
            stamps.append(now[0])

    live = LiveSession(
        "meeting-1", [("mic", RATE, 1)], Resolved("Test engine", False, lambda: RecordingDecoder(feed)),
        on_line, lambda _payload: None, clock=lambda: now[0],
    )
    live.start()
    for _ in range(40):
        live.accept(0, packed(tone(0.1)), BLOCK, 0, 0)
    live.stop()
    assert stamps, "partials do arrive"
    for index, stamp in enumerate(stamps):
        assert len([later for later in stamps[index:] if later - stamp < 1.0]) <= 5
    assert all(later - earlier >= PARTIAL_GAP_SECONDS - 1e-9 for earlier, later in zip(stamps, stamps[1:]))
    assert [line["final"] for line in lines].count(True) == len(lines) - len(stamps)


def test_a_decoder_failure_sets_failed_with_one_sentence_and_never_reaches_accept() -> None:
    class Broken(RecordingDecoder):
        def feed(self, samples16k: np.ndarray) -> list[Update]:
            raise RuntimeError("a transcript fragment that must not be reported")

    states: list[dict] = []
    lines: list[dict] = []
    live = session([("mic", RATE, 1)], Broken(), lines, states)
    live.start()
    live.accept(0, packed(tone(1.0)), RATE, 0, 0)
    live.stop()
    assert [item["state"] for item in states] == ["starting", "running", "failed"]
    assert states[-1]["notice"] == SPEECH_FAILED
    assert "transcript fragment" not in states[-1]["notice"]
    assert lines == []


def test_a_resume_closes_the_open_utterance_instead_of_joining_across_the_pause() -> None:
    decoder = RecordingDecoder()
    states: list[dict] = []
    live = session([("mic", RATE, 1)], decoder, [], states)
    live.start()
    live.accept(0, packed(tone(1.0)), RATE, 0, 0)
    live.accept(0, packed(tone(1.0)), RATE, 1_000_000, 0)
    live.accept(0, packed(tone(1.0)), RATE, 9_000_000, 1)
    live.stop()
    assert decoder.finishes >= 2  # once at the resume, once at the end


def test_flush_all_finishes_the_open_utterance_before_the_files_close() -> None:
    decoder = FakeDecoder(segment=2 * RATE)
    lines: list[dict] = []
    live = session([("mic", RATE, 1)], decoder, lines, [])
    live.start()
    for _ in range(15):
        live.accept(0, packed(tone(0.1)), BLOCK, 0, 0)
    live.flush_all()
    assert wait_for(lambda: any(line["final"] for line in lines))
    live.stop()
    assert [line["text"] for line in lines] == ["Fictional line 1"]


def test_two_lanes_get_their_own_ids_and_do_not_share_a_decoder() -> None:
    made: list[RecordingDecoder] = []

    def factory() -> RecordingDecoder:
        decoder = RecordingDecoder(lambda fed: [Update(0, "hello", 0, fed, True)] if fed >= RATE else [])
        made.append(decoder)
        return decoder

    lines: list[dict] = []
    live = LiveSession("meeting-1", [("mic", RATE, 1), ("system", RATE, 1)],
                       Resolved("Test engine", False, factory), lines.append, lambda _payload: None)
    live.start()
    live.accept(0, packed(tone(1.0)), RATE, 0, 0)
    live.accept(1, packed(tone(1.0)), RATE, 0, 0)
    live.stop()
    assert len(made) == 2
    assert {line["id"] for line in lines} == {"mic:0", "system:0"}
    assert {line["speaker"] for line in lines} == {"You", "Others"}


def test_stop_without_start_reports_stopped_and_accept_stays_harmless() -> None:
    states: list[dict] = []
    live = session([("mic", RATE, 1)], RecordingDecoder(), [], states)
    live.accept(0, packed(tone(0.1)), BLOCK, 0, 0)
    live.stop()
    assert [item["state"] for item in states] == ["stopped"]
    assert live.incomplete is False


def test_cancel_stops_without_finishing_the_decoder() -> None:
    decoder = RecordingDecoder()
    states: list[dict] = []
    live = session([("mic", RATE, 1)], decoder, [], states)
    live.start()
    live.accept(0, packed(tone(1.0)), RATE, 0, 0)
    live.cancel()
    assert decoder.finishes == 0


# ---- resolve -----------------------------------------------------------------------------


@pytest.fixture
def fake_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(stt.FAKE_ENV, "1")


@pytest.fixture
def real_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(stt.FAKE_ENV, raising=False)


def tmp_whisper(tmp_path: Path) -> Path:
    path = tmp_path / "ggml-tiny.bin"
    path.write_bytes(b"ggml" + b"\0" * 64)
    return path


def test_resolve_returns_a_deterministic_fake_decoder_in_fake_mode(fake_mode: None, tmp_path: Path) -> None:
    resolved = resolve(tmp_path, {"live_model": "stream:nemo-en-80ms"})
    assert resolved.label == "Test speech engine" and resolved.leaves_device is False
    first = resolved.make_decoder().feed(tone(4.0))
    second = resolve(tmp_path, {}).make_decoder().feed(tone(4.0))
    assert [item.text for item in first] == ["Fictional line 1", "Fictional line 2"]
    assert [item.text for item in second] == [item.text for item in first]


def test_resolve_falls_back_to_the_transcription_model(real_mode: None, tmp_path: Path) -> None:
    settings = {"stt_model": str(tmp_whisper(tmp_path)), "stt_language": "en"}
    resolved = resolve(tmp_path, settings)
    assert resolved.leaves_device is False
    assert resolved.label.endswith("(on this PC)") and "Whisper" in resolved.label
    assert isinstance(resolved.make_decoder(), VadDecoder)


def test_resolve_runs_an_offline_sherpa_model_behind_the_vad(real_mode: None, tmp_path: Path) -> None:
    folder = tmp_path / "sherpa" / "custom" / "team--sv"
    folder.mkdir(parents=True)
    (folder / "model.onnx").write_bytes(b"m")
    (folder / "tokens.txt").write_bytes(b"t")
    (tmp_path / "sherpa" / "silero_vad.onnx").write_bytes(b"\0" * sherpa_models.SHERPA_VAD.size)
    resolved = resolve(tmp_path, {"stt_model": "sherpa-dir:team--sv"})
    assert resolved.label == "team--sv (on this PC)"
    assert isinstance(resolved.make_decoder(), VadDecoder)


def test_resolve_uses_the_cloud_connection_when_transcription_is_cloud(real_mode: None, tmp_path: Path) -> None:
    with pytest.raises(AppError) as info:
        resolve(tmp_path, {"stt_mode": "cloud"})
    assert info.value.message == "Save a cloud transcription connection in Settings first."
    resolved = resolve(tmp_path, {"stt_mode": "cloud"}, lambda samples: "cloud words")
    assert resolved.leaves_device is True
    decoder = resolved.make_decoder()
    assert isinstance(decoder, CloudDecoder)
    assert [item.text for item in decoder.feed(tone(1.0))] == []  # nothing until the VAD closes


def test_cloud_needs_a_saved_connection(real_mode: None, tmp_path: Path) -> None:
    with pytest.raises(AppError) as info:
        resolve(tmp_path, {"live_model": "cloud"})
    assert info.value.code == "live_model" and info.value.message.endswith("in Settings first.")


def test_a_streaming_model_that_is_not_installed_names_the_download(real_mode: None, tmp_path: Path,
                                                                  monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(streaming_models, "engine_available", lambda: True)
    with pytest.raises(AppError) as info:
        resolve(tmp_path, {"live_model": "stream:nemo-en-80ms"})
    assert info.value.message == "Download Streaming English (NeMo) in Settings first."


def test_a_streaming_model_loads_a_shared_recognizer_once(real_mode: None, tmp_path: Path,
                                                         monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(streaming_models, "engine_available", lambda: True)
    model = streaming_models.pinned("stream:kroko-en")
    assert model is not None
    directory = streaming_models.folder(tmp_path) / model.folder
    directory.mkdir(parents=True)
    for name in model.files:
        (directory / name).write_bytes(b"x")
    (directory / streaming_models.MARKER).write_text(model.archive.sha256, encoding="utf-8")
    loads: list[int] = []

    def recognizer(_root: Path, _model_id: str, threads: int = 2) -> object:
        loads.append(threads)
        return FakeRecognizer(["hi"])

    monkeypatch.setattr(streaming_models, "recognizer", recognizer)
    resolved = resolve(tmp_path, {"live_model": "stream:kroko-en"})
    assert resolved.label == "Streaming English (Zipformer)" and resolved.leaves_device is False
    first, second = resolved.make_decoder(), resolved.make_decoder()
    assert isinstance(first, StreamingDecoder) and isinstance(second, StreamingDecoder)
    assert len(loads) == 1


def test_an_unknown_or_missing_folder_is_refused(real_mode: None, tmp_path: Path,
                                                monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(streaming_models, "engine_available", lambda: True)
    with pytest.raises(AppError) as info:
        resolve(tmp_path, {"live_model": "stream-dir:gone"})
    assert info.value.message == "That streaming model folder is missing. Choose another live model."
    with pytest.raises(AppError) as info:
        resolve(tmp_path, {"live_model": "nonsense"})
    assert info.value.code == "live_model"


def test_listing_offers_same_streaming_custom_and_cloud_with_reasons(real_mode: None, tmp_path: Path,
                                                                    monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(streaming_models, "engine_available", lambda: True)
    custom = streaming_models.folder(tmp_path) / "custom" / "team-kroko"
    custom.mkdir(parents=True)
    for name in ("encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"):
        (custom / name).write_bytes(b"x")
    rows = {row["id"]: row for row in listing(tmp_path, {"stt_model": str(tmp_whisper(tmp_path))}, False)["models"]}
    assert set(rows) == {"", "stream:kroko-en", "stream:nemo-en-80ms", "stream-dir:team-kroko", "cloud"}
    assert rows[""]["kind"] == "same" and rows[""]["label"] == "Same as Transcription"
    assert rows["stream:kroko-en"]["download_bytes"] == 57_267_600
    assert rows["stream:kroko-en"]["languages"] == ["en"]
    assert rows["stream:kroko-en"]["reason"] == "Download Streaming English (Zipformer) in Settings first."
    assert rows["stream-dir:team-kroko"]["kind"] == "custom" and rows["stream-dir:team-kroko"]["installed"] is True
    assert rows["cloud"]["leaves_device"] is True and rows["cloud"]["installed"] is False
    assert rows["cloud"]["reason"] == "Save a cloud transcription connection in Settings first."


def test_listing_reports_readiness_for_the_selected_model(real_mode: None, tmp_path: Path,
                                                         monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(streaming_models, "engine_available", lambda: True)
    monkeypatch.setattr(stt, "engine_available", lambda: True)
    not_ready = listing(tmp_path, {"live_model": "stream:nemo-en-80ms", "stt_model": ""}, False)
    assert not_ready["selected"] == "stream:nemo-en-80ms" and not_ready["ready"] is False
    assert not_ready["reason"] == "Download Streaming English (NeMo) in Settings first."
    assert not_ready["installing"] is None
    cloud = listing(tmp_path, {"live_model": "cloud", "stt_model": ""}, True)
    assert cloud["ready"] is True and cloud["reason"] is None
    whisper = listing(tmp_path, {"live_model": "", "stt_model": str(tmp_whisper(tmp_path))}, False)
    assert whisper["ready"] is True and whisper["models"][0]["installed"] is True


def test_listing_in_fake_mode_marks_everything_ready(fake_mode: None, tmp_path: Path) -> None:
    result = listing(tmp_path, {"live_model": "stream:nemo-en-80ms"}, False, "stream:nemo-en-80ms")
    assert result["ready"] is True
    assert result["installing"] == "stream:nemo-en-80ms"
    assert all(row["installed"] and row["reason"] is None for row in result["models"])
    assert all(row["download_bytes"] is None for row in result["models"])


def test_the_level_gate_opens_and_closes_on_loud_audio() -> None:
    gate = LevelGate()
    quiet = np.zeros(RATE, dtype=np.float32)
    loud = tone(0.5) * 4
    assert gate.push(quiet) == []
    assert gate.push(loud) == []
    closed = gate.push(np.zeros(RATE, dtype=np.float32))
    assert closed, "a loud stretch followed by quiet must close one segment"
    start, end = closed[0]
    assert abs(start - RATE) <= 4 * LevelGate.FRAME  # it opens at the first loud frame
    assert end - start >= RATE // 2  # and covers the half second of speech


# ---- opt-in real models ------------------------------------------------------------------


STREAM_ROOT = os.environ.get(
    "OPENMEET_PY_STREAM_MODELS", r"C:\Users\Rahul\AppData\Local\hermes\cache\scratch\stream_models"
)
STREAM_WAV = os.environ.get(
    "OPENMEET_PY_STREAM_WAV", r"C:\Users\Rahul\AppData\Local\hermes\cache\scratch\tts_probe.wav"
)
REAL = os.environ.get("OPENMEET_PY_REAL_STREAMING") == "1" and Path(STREAM_ROOT).is_dir() and Path(STREAM_WAV).is_file()
REAL_MODELS = {
    "stream:kroko-en": "sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06",
    "stream:nemo-en-80ms": "sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-80ms-int8",
}


def load_probe() -> tuple[np.ndarray, int]:
    import wave

    with wave.open(STREAM_WAV, "rb") as handle:
        rate = handle.getframerate()
        channels = handle.getnchannels()
        raw = handle.readframes(handle.getnframes())
    pcm = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)
    return pcm.astype(np.float32), rate


def place_model(root: Path, model_id: str, source: Path) -> None:
    """A published folder of hard links to an extracted model, so resolve() sees an installed model."""
    model = streaming_models.pinned(model_id)
    assert model is not None
    directory = streaming_models.folder(root) / model.folder
    directory.mkdir(parents=True)
    for name in model.files:
        try:
            os.link(source / name, directory / name)
        except OSError:
            (directory / name).write_bytes((source / name).read_bytes())
    (directory / streaming_models.MARKER).write_text(model.archive.sha256, encoding="utf-8")


def run_live(root: Path, model_id: str, samples: np.ndarray, rate: int) -> list[dict]:
    lines: list[dict] = []
    states: list[dict] = []
    resolved = resolve(root, {"live_model": model_id})
    # The whole 22 s clip is handed over at once here, so the queue must be able to hold it; a real
    # recording arrives in realtime and never fills an 8 s queue at this decoder's speed.
    live = LiveSession("real-probe", [("mic", rate, 1)], resolved, lines.append, states.append,
                       queue_seconds=60.0)
    live.start()
    step = int(rate * 0.1)
    for at in range(0, samples.size, step):
        block = samples[at:at + step]
        live.accept(0, packed(block), block.size, at * 1_000_000 // rate, 0)
    live.stop()
    assert [item["state"] for item in states] == ["starting", "running", "stopped"]
    assert live.incomplete is False
    return lines


@pytest.mark.real_model
@pytest.mark.skipif(not REAL, reason="opt-in: set OPENMEET_PY_REAL_STREAMING=1 with the extracted streaming models")
def test_both_real_streaming_models_transcribe_the_probe_clip(tmp_path: Path) -> None:
    samples, rate = load_probe()
    root = tmp_path / "stt"
    for model_id, folder_name in REAL_MODELS.items():
        source = Path(STREAM_ROOT) / folder_name
        assert source.is_dir(), source
        place_model(root, model_id, source)
        lines = run_live(root, model_id, samples, rate)
        finals = [line for line in lines if line["final"]]
        text = " ".join(line["text"] for line in finals).lower()
        print(f"{model_id}: {len(finals)} finals, {len(text)} chars: {text}")
        assert len(finals) >= 2, f"{model_id} produced {len(finals)} finals"
        assert [line["start_ms"] for line in finals] == sorted(line["start_ms"] for line in finals)
        assert any("budget" in line["text"].lower() for line in finals), text
        assert any("november" in line["text"].lower() for line in finals), text
