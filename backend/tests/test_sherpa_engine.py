"""SherpaEngine, sherpa model layouts and status, with a FAKE sherpa_onnx module injected into sys.modules.

The fake records factory arguments and produces segments from fixed speech regions, so the VAD windowing,
timestamps, language rules and cancel can be checked without any native library or model file.
"""

from __future__ import annotations

import importlib.machinery
import sys
import threading
import types
from pathlib import Path
from typing import Any, Callable

import numpy as np
import pytest
from fastapi.testclient import TestClient

from conftest import TOKEN, invoke, invoke_error
from openmeet_py.api.errors import AppError
from openmeet_py.speech import sherpa_models
from openmeet_py.speech.transcription import engine as engine_module
from openmeet_py.speech.transcription.engine import EngineSegment, FakeEngine, SherpaEngine
from stt_fixtures import recording

RATE = 16000
CALLS: list[tuple[str, dict[str, Any]]] = []
REGIONS: list[tuple[int, int]] = []  # speech as (start, end) sample indexes over the fed stream


class FakeStream:
    def __init__(self) -> None:
        self.samples = 0
        self.result = types.SimpleNamespace(text="")

    def accept_waveform(self, rate: int, samples: np.ndarray) -> None:
        assert rate == RATE
        self.samples = int(samples.size)


class FakeRecognizer:
    def __init__(self, kind: str) -> None:
        self.kind = kind

    def create_stream(self) -> FakeStream:
        return FakeStream()

    def decode_stream(self, stream: FakeStream) -> None:
        stream.result.text = f"{self.kind} words {stream.samples}"


class FakeFactory:
    @classmethod
    def from_transducer(cls, **kwargs: Any) -> FakeRecognizer:
        CALLS.append(("from_transducer", kwargs))
        return FakeRecognizer("transducer")

    @classmethod
    def from_moonshine_v2(cls, **kwargs: Any) -> FakeRecognizer:
        CALLS.append(("from_moonshine_v2", kwargs))
        return FakeRecognizer("moonshine")

    @classmethod
    def from_sense_voice(cls, **kwargs: Any) -> FakeRecognizer:
        CALLS.append(("from_sense_voice", kwargs))
        return FakeRecognizer("sense_voice")


class FakeConfig:
    def __init__(self, **kwargs: Any) -> None:
        self.__dict__.update(kwargs)


class FakeSegment:
    def __init__(self, start: int, samples: np.ndarray) -> None:
        self.start = start
        self.samples = samples


class FakeVad:
    """Emits each fixed speech region once its last sample has been fed (or at flush, truncated)."""

    def __init__(self, config: FakeConfig, buffer_size_in_seconds: float) -> None:
        CALLS.append(("vad", {"config": config, "buffer": buffer_size_in_seconds}))
        self.fed = np.zeros(0, dtype=np.float32)
        self.ready: list[FakeSegment] = []
        self.done: set[int] = set()
        self.accepts = 0
        self.flushed = False

    def accept_waveform(self, samples: np.ndarray) -> None:
        assert samples.dtype == np.float32 and samples.flags["C_CONTIGUOUS"]
        self.accepts += 1
        self.largest = max(getattr(self, "largest", 0), int(samples.size))
        self.fed = np.concatenate([self.fed, samples])
        self._emit(final=False)

    def _emit(self, final: bool) -> None:
        for index, (start, end) in enumerate(REGIONS):
            if index in self.done:
                continue
            if end <= self.fed.size or (final and start < self.fed.size):
                stop = min(end, self.fed.size)
                self.ready.append(FakeSegment(start, self.fed[start:stop].copy()))
                self.done.add(index)

    def flush(self) -> None:
        self.flushed = True
        self._emit(final=True)

    def empty(self) -> bool:
        return not self.ready

    @property
    def front(self) -> FakeSegment:
        return self.ready[0]

    def pop(self) -> None:
        self.ready.pop(0)


def fake_module() -> types.ModuleType:
    module = types.ModuleType("sherpa_onnx")
    # A real spec, so importlib.util.find_spec("sherpa_onnx") reports the package as present.
    module.__spec__ = importlib.machinery.ModuleSpec("sherpa_onnx", None)
    module.__version__ = "1.13.8-fake"
    module.OfflineRecognizer = FakeFactory
    module.VadModelConfig = FakeConfig
    module.SileroVadModelConfig = FakeConfig
    module.VoiceActivityDetector = FakeVad
    return module


@pytest.fixture
def sherpa(monkeypatch: pytest.MonkeyPatch) -> types.ModuleType:
    CALLS.clear()
    REGIONS.clear()
    module = fake_module()
    monkeypatch.setitem(sys.modules, "sherpa_onnx", module)
    return module


def layout(root: Path, name: str, files: dict[str, bytes]) -> Path:
    folder = root / name
    folder.mkdir(parents=True)
    for file, body in files.items():
        (folder / file).write_bytes(body)
    return folder


def transducer_spec(folder: Path, model_type: str = "nemo_transducer") -> sherpa_models.Spec:
    return sherpa_models.Spec(
        "transducer",
        {role: folder / name for role, name in [
            ("encoder", "encoder.int8.onnx"), ("decoder", "decoder.int8.onnx"),
            ("joiner", "joiner.int8.onnx"), ("tokens", "tokens.txt"),
        ]},
        model_type,
    )


def make_vad(root: Path) -> Path:
    path = root / "silero_vad.onnx"
    path.write_bytes(b"fictional-vad")
    return path


def run(engine: SherpaEngine, samples: np.ndarray, language: str = "en", prompt: str = "",
        cancel: threading.Event | None = None, on_segment: Callable[[EngineSegment], None] | None = None) -> list[EngineSegment]:
    return engine.transcribe(samples, language, prompt, cancel or threading.Event(),
                             on_segment or (lambda _segment: None), lambda _percent: None)


def test_the_engine_module_is_not_imported_by_building_the_engine(tmp_path: Path) -> None:
    folder = layout(tmp_path, "m", {"encoder.int8.onnx": b"e", "decoder.int8.onnx": b"d",
                                    "joiner.int8.onnx": b"j", "tokens.txt": b"t"})
    SherpaEngine(transducer_spec(folder), make_vad(tmp_path))  # no sherpa_onnx in sys.modules here
    assert "sherpa_onnx" not in sys.modules or sys.modules["sherpa_onnx"] is None


def test_parakeet_transducer_factory_gets_the_pinned_files_and_model_type(tmp_path: Path, sherpa: types.ModuleType) -> None:
    folder = layout(tmp_path, "parakeet", {"encoder.int8.onnx": b"e", "decoder.int8.onnx": b"d",
                                           "joiner.int8.onnx": b"j", "tokens.txt": b"t"})
    engine = SherpaEngine(transducer_spec(folder), make_vad(tmp_path), threads=3)
    run(engine, np.zeros(RATE, dtype=np.float32))
    name, kwargs = next((c for c in CALLS if c[0] == "from_transducer"))
    assert kwargs == {
        "encoder": str(folder / "encoder.int8.onnx"), "decoder": str(folder / "decoder.int8.onnx"),
        "joiner": str(folder / "joiner.int8.onnx"), "tokens": str(folder / "tokens.txt"),
        "num_threads": 3, "model_type": "nemo_transducer",
    }


def test_a_downloaded_transducer_folder_passes_an_empty_model_type(tmp_path: Path, sherpa: types.ModuleType) -> None:
    folder = layout(tmp_path, "custom", {"encoder.onnx": b"e", "decoder.onnx": b"d",
                                         "joiner.onnx": b"j", "tokens.txt": b"t"})
    spec = sherpa_models.Spec("transducer", {"encoder": folder / "encoder.onnx", "decoder": folder / "decoder.onnx",
                                             "joiner": folder / "joiner.onnx", "tokens": folder / "tokens.txt"})
    run(SherpaEngine(spec, make_vad(tmp_path)), np.zeros(RATE, dtype=np.float32))
    assert [c[1]["model_type"] for c in CALLS if c[0] == "from_transducer"] == [""]


def test_moonshine_uses_the_encoder_and_merged_decoder_factory(tmp_path: Path, sherpa: types.ModuleType) -> None:
    folder = layout(tmp_path, "moon", {"encoder_model.ort": b"e", "decoder_model_merged.ort": b"d", "tokens.txt": b"t"})
    spec = sherpa_models.Spec("moonshine", {"encoder": folder / "encoder_model.ort",
                                            "decoder": folder / "decoder_model_merged.ort",
                                            "tokens": folder / "tokens.txt"})
    run(SherpaEngine(spec, make_vad(tmp_path)), np.zeros(RATE, dtype=np.float32), language="de")
    name, kwargs = next((c for c in CALLS if c[0] == "from_moonshine_v2"))
    assert set(kwargs) == {"encoder", "decoder", "tokens", "num_threads"}
    assert kwargs["decoder"] == str(folder / "decoder_model_merged.ort")  # language is not passed to Moonshine


@pytest.mark.parametrize(
    ("language", "expected"),
    [("en", "en"), ("zh", "zh"), ("ja", "ja"), ("ko", "ko"), ("yue", "yue"), ("de", "auto"), ("auto", "auto")],
)
def test_sense_voice_maps_its_five_languages_and_runs_everything_else_as_auto(
    tmp_path: Path, sherpa: types.ModuleType, language: str, expected: str
) -> None:
    folder = layout(tmp_path, "sv", {"model.int8.onnx": b"m", "tokens.txt": b"t"})
    spec = sherpa_models.Spec("sense_voice", {"model": folder / "model.int8.onnx", "tokens": folder / "tokens.txt"})
    run(SherpaEngine(spec, make_vad(tmp_path)), np.zeros(RATE, dtype=np.float32), language=language)
    kwargs = next(c[1] for c in CALLS if c[0] == "from_sense_voice")
    assert kwargs["language"] == expected and kwargs["use_itn"] is True


def test_a_vocabulary_hint_is_ignored_by_the_sherpa_command(tmp_path: Path, sherpa: types.ModuleType) -> None:
    folder = layout(tmp_path, "p", {"encoder.int8.onnx": b"e", "decoder.int8.onnx": b"d",
                                    "joiner.int8.onnx": b"j", "tokens.txt": b"t"})
    engine = SherpaEngine(transducer_spec(folder), make_vad(tmp_path))
    REGIONS.append((0, RATE))
    results = run(engine, np.zeros(2 * RATE, dtype=np.float32), prompt="Kubernetes")
    assert [r.text for r in results] == ["transducer words 16000"]
    assert all("Kubernetes" not in str(kwargs) for _, kwargs in CALLS)


def test_vad_windows_give_each_segment_its_own_start_offset_and_end(tmp_path: Path, sherpa: types.ModuleType) -> None:
    folder = layout(tmp_path, "p", {"encoder.int8.onnx": b"e", "decoder.int8.onnx": b"d",
                                    "joiner.int8.onnx": b"j", "tokens.txt": b"t"})
    # Three regions across 25 s of audio, fed one VAD window at a time.
    REGIONS.extend([(RATE * 1, RATE * 2 + RATE // 2), (RATE * 12, RATE * 13), (RATE * 22, RATE * 24)])
    engine = SherpaEngine(transducer_spec(folder), make_vad(tmp_path))
    results = run(engine, np.zeros(RATE * 25, dtype=np.float32))
    assert [(r.start_ms, r.end_ms) for r in results] == [(1000, 2500), (12000, 13000), (22000, 24000)]
    assert [r.text for r in results] == ["transducer words 24000", "transducer words 16000", "transducer words 32000"]
    vad = next(c[1]["buffer"] for c in CALLS if c[0] == "vad")
    assert vad == 60  # buffer seconds
    config = next(c[1]["config"] for c in CALLS if c[0] == "vad")
    assert config.sample_rate == RATE and config.silero_vad.model == str(tmp_path / "silero_vad.onnx")


def test_the_vad_is_fed_one_silero_window_at_a_time(tmp_path: Path, sherpa: types.ModuleType,
                                                  monkeypatch: pytest.MonkeyPatch) -> None:
    # The real VoiceActivityDetector keeps only the last segment that ends inside one large accept call
    # (a 10 s feed turned a 22 s clip into one word), so no call may exceed the 512-sample Silero window.
    folder = layout(tmp_path, "p", {"encoder.int8.onnx": b"e", "decoder.int8.onnx": b"d",
                                    "joiner.int8.onnx": b"j", "tokens.txt": b"t"})
    seen: list[FakeVad] = []
    original = sherpa.VoiceActivityDetector

    def record(config: FakeConfig, buffer_size_in_seconds: float) -> FakeVad:
        vad = original(config, buffer_size_in_seconds)
        seen.append(vad)
        return vad

    monkeypatch.setattr(sherpa, "VoiceActivityDetector", record)
    REGIONS.extend([(RATE // 2, RATE), (RATE * 2, RATE * 3)])
    run(SherpaEngine(transducer_spec(folder), make_vad(tmp_path)), np.zeros(RATE * 4, dtype=np.float32))
    assert engine_module.SHERPA_VAD_CHUNK == 512
    assert seen and seen[0].largest <= 512 and seen[0].accepts >= RATE * 4 // 512


def test_a_segment_that_ends_inside_a_chunk_is_timed_from_its_start(tmp_path: Path, sherpa: types.ModuleType) -> None:
    folder = layout(tmp_path, "p", {"encoder.int8.onnx": b"e", "decoder.int8.onnx": b"d",
                                    "joiner.int8.onnx": b"j", "tokens.txt": b"t"})
    REGIONS.append((RATE * 2, RATE * 3))  # ends inside the fed audio, so it is emitted on feed
    engine = SherpaEngine(transducer_spec(folder), make_vad(tmp_path))
    results = run(engine, np.zeros(RATE * 4, dtype=np.float32))
    assert [(r.start_ms, r.end_ms) for r in results] == [(2000, 3000)]


def test_progress_and_segments_are_reported_as_they_are_decoded(tmp_path: Path, sherpa: types.ModuleType) -> None:
    folder = layout(tmp_path, "p", {"encoder.int8.onnx": b"e", "decoder.int8.onnx": b"d",
                                    "joiner.int8.onnx": b"j", "tokens.txt": b"t"})
    REGIONS.extend([(0, RATE), (RATE, 2 * RATE)])
    seen: list[EngineSegment] = []
    run(SherpaEngine(transducer_spec(folder), make_vad(tmp_path)), np.zeros(2 * RATE, dtype=np.float32),
        on_segment=seen.append)
    assert [(s.start_ms, s.end_ms) for s in seen] == [(0, 1000), (1000, 2000)]


def test_cancel_before_the_run_returns_nothing_and_feeds_no_audio(tmp_path: Path, sherpa: types.ModuleType) -> None:
    folder = layout(tmp_path, "p", {"encoder.int8.onnx": b"e", "decoder.int8.onnx": b"d",
                                    "joiner.int8.onnx": b"j", "tokens.txt": b"t"})
    REGIONS.append((0, RATE))
    cancel = threading.Event()
    cancel.set()
    assert run(SherpaEngine(transducer_spec(folder), make_vad(tmp_path)), np.zeros(RATE, dtype=np.float32), cancel=cancel) == []


def test_cancel_after_a_segment_stops_before_the_next_one(tmp_path: Path, sherpa: types.ModuleType) -> None:
    folder = layout(tmp_path, "p", {"encoder.int8.onnx": b"e", "decoder.int8.onnx": b"d",
                                    "joiner.int8.onnx": b"j", "tokens.txt": b"t"})
    REGIONS.extend([(0, RATE), (RATE, 2 * RATE)])
    cancel = threading.Event()
    results = run(SherpaEngine(transducer_spec(folder), make_vad(tmp_path)), np.zeros(2 * RATE, dtype=np.float32),
                  cancel=cancel, on_segment=lambda _segment: cancel.set())
    assert [(r.start_ms, r.end_ms) for r in results] == [(0, 1000)]


def test_a_missing_model_file_is_refused_when_the_engine_is_built(tmp_path: Path) -> None:
    spec = sherpa_models.Spec("sense_voice", {"model": tmp_path / "gone.onnx", "tokens": tmp_path / "t.txt"})
    with pytest.raises(AppError) as info:
        SherpaEngine(spec, make_vad(tmp_path))
    assert info.value.code == "stt"


def test_make_engine_chooses_sherpa_for_a_spec_and_the_fake_flag_wins(tmp_path: Path) -> None:
    folder = layout(tmp_path, "p", {"encoder.int8.onnx": b"e", "decoder.int8.onnx": b"d",
                                    "joiner.int8.onnx": b"j", "tokens.txt": b"t"})
    spec = transducer_spec(folder)
    vad = make_vad(tmp_path)
    assert isinstance(engine_module.make_engine(None, vad, False, spec), SherpaEngine)
    assert isinstance(engine_module.make_engine(None, vad, True, spec), FakeEngine)
    with pytest.raises(AppError):
        engine_module.make_engine(None, None, False, spec)


def test_sherpa_status_and_listing_follow_the_installed_files(client: TestClient, sherpa: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sherpa_models, "supported", lambda: True)  # platform-independent: the gate is tested in test_speech_targets
    root = client.app.state.ctx.store.data_dir / "stt"
    by_id = {row["id"]: row for row in invoke(client, "stt_status")["models"]}
    assert by_id["sherpa:parakeet-v3"]["installed"] is False and by_id["sherpa:parakeet-v3"]["engine"] == "sherpa-onnx"
    assert "reason" not in by_id["sherpa:parakeet-v3"]  # the package is present, so no reason
    assert by_id["sherpa:parakeet-v3"]["size"] == 487_170_055 + 643_854
    # Place the pinned Moonshine folder and the VAD at their catalog sizes, with a matching marker.
    model = sherpa_models.pinned("sherpa:moonshine-base-en")
    folder = root / "sherpa" / model.folder
    folder.mkdir(parents=True)
    for name in model.files:
        (folder / name).write_bytes(b"fictional")
    (folder / sherpa_models.MARKER).write_text(model.archive.sha256)
    (root / "sherpa" / "silero_vad.onnx").write_bytes(b"\0" * sherpa_models.SHERPA_VAD.size)
    invoke(client, "save_stt_settings", language="en", prompt="", model="sherpa:moonshine-base-en")
    status = invoke(client, "stt_status")
    assert status["installed"] is True and status["missing_bytes"] == 0 and status["reason"] is None
    assert {r["id"]: r["installed"] for r in status["models"]}["sherpa:moonshine-base-en"] is True


def test_a_downloaded_folder_is_listed_only_when_its_layout_matches(client: TestClient, sherpa: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sherpa_models, "supported", lambda: True)
    root = client.app.state.ctx.store.data_dir / "stt"
    good = root / "sherpa" / "custom" / "team--parakeet"
    good.mkdir(parents=True)
    (good / "encoder.onnx").write_bytes(b"12345")
    (good / "decoder.onnx").write_bytes(b"123")
    (good / "joiner.onnx").write_bytes(b"12")
    (good / "tokens.txt").write_bytes(b"1")
    (good / "openmeet-source.json").write_bytes(b"{}")
    broken = root / "sherpa" / "custom" / "team--broken"
    broken.mkdir(parents=True)
    (broken / "tokens.txt").write_bytes(b"1")
    rows = {row["id"]: row for row in invoke(client, "stt_status")["models"] if row["id"].startswith("sherpa-dir:")}
    assert set(rows) == {"sherpa-dir:team--parakeet"}
    assert rows["sherpa-dir:team--parakeet"]["size"] == 5 + 3 + 2 + 1 + 2
    assert rows["sherpa-dir:team--parakeet"]["installed"] is True
    invoke(client, "save_stt_settings", language="en", prompt="", model="sherpa-dir:team--parakeet")
    status = invoke(client, "stt_status")
    assert status["model"] is True and status["vad"] is False and status["installed"] is False
    assert status["missing_bytes"] == sherpa_models.SHERPA_VAD.size


def test_spec_for_a_downloaded_single_model_folder_is_sense_voice(tmp_path: Path) -> None:
    folder = layout(tmp_path / "stt", "sherpa/custom/team--sv", {"model.onnx": b"m", "tokens.txt": b"t"})
    assert folder.is_dir()
    spec = sherpa_models.spec_for(tmp_path / "stt", "sherpa-dir:team--sv")
    assert spec.family == "sense_voice" and spec.model_type == ""
    assert spec.paths["model"] == folder / "model.onnx"


def test_spec_for_refuses_an_incomplete_pinned_folder(tmp_path: Path) -> None:
    with pytest.raises(AppError) as info:
        sherpa_models.spec_for(tmp_path, "sherpa:parakeet-v3")
    assert info.value.code == "stt"


def test_end_to_end_with_a_sherpa_id_and_the_fake_engine(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENMEET_PY_FAKE_STT", "1")
    meeting = recording(client.app.state.ctx)
    invoke(client, "save_stt_settings", language="en", prompt="", model="sherpa:parakeet-v3")
    invoke(client, "transcribe_meeting", id=meeting)
    detail = invoke(client, "get_meeting", id=meeting)
    assert detail["transcript_provider"] == "whisper"  # every local run records "whisper"
    assert detail["transcript_model"] == "sherpa:parakeet-v3"
    assert {segment["speaker"] for segment in detail["segments"]} == {"You", "Others"}
    assert all(segment["timing"]["kind"] == "timed" for segment in detail["segments"])


def test_sherpa_run_without_installed_files_is_refused_outside_fake_mode(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENMEET_PY_FAKE_STT", raising=False)
    meeting = recording(client.app.state.ctx)
    invoke(client, "save_stt_settings", language="en", prompt="", model="sherpa:parakeet-v3")
    status, body = invoke_error(client, "transcribe_meeting", id=meeting)
    assert body["code"] == "stt"

