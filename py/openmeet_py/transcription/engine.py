"""Speech engines behind one protocol: whisper.cpp (pywhispercpp, phase 4a), sherpa-onnx (phase 4b) and a fake.

pywhispercpp and sherpa_onnx are imported only inside engine methods, never at module import, so nothing
in the app or the tests loads a native library until a real transcription starts. Models are constructed
only from existing absolute file paths: the libraries would otherwise treat a name as a model to fetch.
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional, Protocol

import numpy as np

from .. import sherpa_models
from ..errors import AppError

ENGINE_SAMPLE_RATE = 16_000
DEFAULT_THREADS = 4


@dataclass(frozen=True)
class EngineSegment:
    """One decoded span, in milliseconds from the start of the window the engine was given."""

    start_ms: int
    end_ms: int
    text: str


class Engine(Protocol):
    name: str

    def transcribe(
        self,
        samples16k: np.ndarray,
        language: str,
        prompt: str,
        cancel_event: threading.Event,
        on_segment: Callable[[EngineSegment], None],
        on_progress: Callable[[int], None],
    ) -> list[EngineSegment]: ...


def _existing_absolute(path: Path) -> Path:
    if not path.is_absolute() or not path.is_file():
        raise AppError("stt", "The speech model file is missing. Choose or download it again.")
    return path


class WhisperCppEngine:
    """whisper.cpp through pywhispercpp, in this process."""

    name = "whisper"

    def __init__(self, model_path: Path, vad_path: Optional[Path] = None, threads: int = DEFAULT_THREADS):
        self.model_path = _existing_absolute(Path(model_path))
        self.vad_path = Path(vad_path) if vad_path is not None and Path(vad_path).is_file() else None
        self.threads = max(1, min(threads, os.cpu_count() or threads))
        self._model = None

    def _load(self):
        if self._model is None:
            # Lazy import: the native library is loaded only for a real transcription.
            from pywhispercpp.model import Model

            options: dict = {
                "n_threads": self.threads,
                "print_progress": False,
                "print_realtime": False,
                "suppress_nst": True,
            }
            if self.vad_path is not None:
                options.update(vad=True, vad_model_path=str(self.vad_path))
            # The first argument is an existing absolute file, so no download can start.
            self._model = Model(str(self.model_path), **options)
        return self._model

    def transcribe(
        self,
        samples16k: np.ndarray,
        language: str,
        prompt: str,
        cancel_event: threading.Event,
        on_segment: Callable[[EngineSegment], None],
        on_progress: Callable[[int], None],
    ) -> list[EngineSegment]:
        model = self._load()
        window_ms = max(1, samples16k.size * 1000 // ENGINE_SAMPLE_RATE)
        params: dict = {}
        if language == "auto":
            params.update(language="auto", detect_language=True)
        else:
            params.update(language=language, detect_language=False)
        if prompt:
            params["initial_prompt"] = prompt

        def on_new(segment) -> None:
            item = EngineSegment(int(segment.t0) * 10, int(segment.t1) * 10, str(segment.text))
            on_segment(item)
            on_progress(min(100, item.end_ms * 100 // window_ms))

        results = model.transcribe(
            samples16k.astype(np.float32, copy=False),
            new_segment_callback=on_new,
            abort_callback=cancel_event.is_set,
            **params,
        )
        return [
            EngineSegment(int(segment.t0) * 10, int(segment.t1) * 10, str(segment.text))
            for segment in results
        ]


SHERPA_THREADS_CAP = 8
SHERPA_VAD_CHUNK = ENGINE_SAMPLE_RATE * 10  # fed to the VAD in 10 s chunks, drained after each
SHERPA_VAD_BUFFER_SECONDS = 60


class SherpaEngine:
    """sherpa-onnx offline recognizer behind the Silero VAD (Parakeet, Moonshine, SenseVoice, downloaded folders).

    Speech is found with the VoiceActivityDetector, so every segment carries its own start offset and
    is timed within the window. Each segment is decoded as its own stream. Cancel is checked between VAD
    chunks and between segments; the pipeline checks it between windows.

    A vocabulary hint is not passed to sherpa models: sherpa.rs never passes --prompt, so it is ignored.
    Language: SenseVoice takes zh, en, ja, ko or yue and runs as auto otherwise; Parakeet and Moonshine
    ignore the setting, as sherpa.rs does.
    """

    name = "sherpa"

    def __init__(self, spec: sherpa_models.Spec, vad_path: Path, threads: Optional[int] = None):
        self.spec = spec
        for path in spec.paths.values():
            _existing_absolute(Path(path))
        self.vad_path = _existing_absolute(Path(vad_path))
        cores = os.cpu_count() or 4
        self.threads = max(1, min(threads or cores, SHERPA_THREADS_CAP))
        self._recognizers: dict[str, Any] = {}

    def _module(self):
        # Lazy import: the native library is loaded only for a real transcription.
        import sherpa_onnx

        return sherpa_onnx

    def _recognizer(self, sherpa_onnx, language: str):
        key = sherpa_models.sense_voice_language(language) if self.spec.family == "sense_voice" else ""
        if key in self._recognizers:
            return self._recognizers[key]
        paths = {role: str(path) for role, path in self.spec.paths.items()}
        factory = sherpa_onnx.OfflineRecognizer
        if self.spec.family == "transducer":
            recognizer = factory.from_transducer(
                encoder=paths["encoder"],
                decoder=paths["decoder"],
                joiner=paths["joiner"],
                tokens=paths["tokens"],
                num_threads=self.threads,
                model_type=self.spec.model_type,
            )
        elif self.spec.family == "moonshine":
            # Encoder plus merged decoder: the pinned and downloaded Moonshine layout.
            recognizer = factory.from_moonshine_v2(
                encoder=paths["encoder"],
                decoder=paths["decoder"],
                tokens=paths["tokens"],
                num_threads=self.threads,
            )
        else:
            recognizer = factory.from_sense_voice(
                model=paths["model"],
                tokens=paths["tokens"],
                num_threads=self.threads,
                language=key,
                use_itn=True,
            )
        self._recognizers[key] = recognizer
        return recognizer

    def _vad(self, sherpa_onnx):
        config = sherpa_onnx.VadModelConfig(
            silero_vad=sherpa_onnx.SileroVadModelConfig(model=str(self.vad_path)),
            sample_rate=ENGINE_SAMPLE_RATE,
            num_threads=1,
        )
        return sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=SHERPA_VAD_BUFFER_SECONDS)

    def transcribe(
        self,
        samples16k: np.ndarray,
        language: str,
        prompt: str,
        cancel_event: threading.Event,
        on_segment: Callable[[EngineSegment], None],
        on_progress: Callable[[int], None],
    ) -> list[EngineSegment]:
        del prompt  # sherpa models take no vocabulary hint (see the class docstring)
        sherpa_onnx = self._module()
        recognizer = self._recognizer(sherpa_onnx, language)
        vad = self._vad(sherpa_onnx)
        total = int(samples16k.size)
        results: list[EngineSegment] = []

        def drain() -> None:
            while not vad.empty():
                if cancel_event.is_set():
                    return
                segment = vad.front
                start = int(segment.start)
                samples = np.ascontiguousarray(segment.samples, dtype=np.float32)
                vad.pop()
                stream = recognizer.create_stream()
                stream.accept_waveform(ENGINE_SAMPLE_RATE, samples)
                recognizer.decode_stream(stream)
                end = start + int(samples.size)
                item = EngineSegment(
                    start * 1000 // ENGINE_SAMPLE_RATE, end * 1000 // ENGINE_SAMPLE_RATE, str(stream.result.text)
                )
                results.append(item)
                on_segment(item)
                if total > 0:
                    on_progress(min(100, end * 100 // total))

        for offset in range(0, total, SHERPA_VAD_CHUNK):
            if cancel_event.is_set():
                break
            chunk = np.ascontiguousarray(samples16k[offset:offset + SHERPA_VAD_CHUNK], dtype=np.float32)
            vad.accept_waveform(chunk)
            drain()
        if not cancel_event.is_set():
            vad.flush()
            drain()
        return results


class FakeEngine:
    """Deterministic engine for tests and the browser check. Produces fictional text, one line per second."""

    name = "fake"

    def __init__(
        self,
        text: str = "Fictional line",
        fail_with: Optional[str] = None,
        on_window: Optional[Callable[[int], None]] = None,
    ):
        self.text = text
        self.fail_with = fail_with
        self.on_window = on_window
        self.calls: list[tuple[int, str, str]] = []

    def transcribe(
        self,
        samples16k: np.ndarray,
        language: str,
        prompt: str,
        cancel_event: threading.Event,
        on_segment: Callable[[EngineSegment], None],
        on_progress: Callable[[int], None],
    ) -> list[EngineSegment]:
        self.calls.append((int(samples16k.size), language, prompt))
        if self.fail_with is not None:
            raise RuntimeError(self.fail_with)
        window_ms = max(1, samples16k.size * 1000 // ENGINE_SAMPLE_RATE)
        count = max(1, window_ms // 1000)
        results: list[EngineSegment] = []
        for index in range(count):
            if cancel_event.is_set():
                break
            if self.on_window is not None:
                self.on_window(index)
            start = index * 1000
            end = min((index + 1) * 1000, window_ms)
            item = EngineSegment(start, max(end, start), f"{self.text} {index + 1}")
            results.append(item)
            on_segment(item)
            on_progress(min(100, (index + 1) * 100 // count))
        return results


def make_engine(
    model_path: Optional[Path],
    vad_path: Optional[Path],
    fake: bool,
    spec: Optional[sherpa_models.Spec] = None,
) -> Engine:
    """Chooses the engine from the selected model: a sherpa spec for sherpa ids, else whisper. Fake wins."""
    if fake:
        return FakeEngine()
    if spec is not None:
        if vad_path is None:
            raise AppError("stt", "The sherpa-onnx VAD model is not installed. Download it in Settings first.")
        return SherpaEngine(spec, vad_path)
    if model_path is None:
        raise AppError("stt", "The speech model is not installed. Download it in Settings first.")
    return WhisperCppEngine(model_path, vad_path)
