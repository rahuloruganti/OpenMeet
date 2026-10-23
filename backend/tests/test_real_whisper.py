"""Opt-in: runs one real whisper.cpp model on a synthetic tone. Never run by default.

Requires OPENMEET_PY_REAL_MODEL=1 and OPENMEET_PY_MODEL_FILE set to an existing absolute path of a
ggml model file. This test downloads nothing and never names a model by name, so pywhispercpp cannot
fetch one. It asserts only that the engine returns a list; it does not judge transcript quality.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

import numpy as np
import pytest

from openmeet_py.speech.transcription.engine import WhisperCppEngine

MODEL_FILE = os.environ.get("OPENMEET_PY_MODEL_FILE", "")
ENABLED = os.environ.get("OPENMEET_PY_REAL_MODEL") == "1" and bool(MODEL_FILE)


@pytest.mark.real_model
@pytest.mark.skipif(not ENABLED, reason="opt-in: set OPENMEET_PY_REAL_MODEL=1 and OPENMEET_PY_MODEL_FILE")
def test_a_real_model_returns_segments_for_a_synthetic_clip() -> None:
    model = Path(MODEL_FILE)
    assert model.is_absolute() and model.is_file()
    t = np.arange(16000 * 3) / 16000
    samples = (0.2 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    engine = WhisperCppEngine(model, None)
    results = engine.transcribe(samples, "en", "", threading.Event(), lambda segment: None, lambda percent: None)
    assert isinstance(results, list)
    assert all(item.end_ms >= item.start_ms for item in results)
