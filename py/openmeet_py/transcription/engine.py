"""Speech engines behind one protocol. Phase 4a implements whisper.cpp (pywhispercpp) and a fake.

pywhispercpp is imported only inside WhisperCppEngine methods, never at module import, so nothing
in the app or the tests loads the native library until a real transcription starts. The model is
constructed only from an existing absolute file path: pywhispercpp would otherwise treat a name as
a model to download, and this module never allows that.
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Protocol

import numpy as np

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


def make_engine(model_path: Optional[Path], vad_path: Optional[Path], fake: bool) -> Engine:
    if fake:
        return FakeEngine()
    if model_path is None:
        raise AppError("stt", "The speech model is not installed. Download it in Settings first.")
    return WhisperCppEngine(model_path, vad_path)
