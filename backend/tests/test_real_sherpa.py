"""Opt-in: runs one real sherpa-onnx model folder on a synthetic tone. NEVER run by default.

Requires OPENMEET_PY_REAL_MODEL=1 and OPENMEET_PY_SHERPA_DIR set to an existing absolute folder that already
holds a sherpa-onnx model (for example, a folder downloaded in Settings), plus its silero_vad.onnx in
OPENMEET_PY_SHERPA_VAD. This test downloads nothing and names no model, so nothing can be fetched. It asserts
only that the engine returns a list with valid timings; it does not judge transcript quality.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

import numpy as np
import pytest

from openmeet_py.speech import sherpa_models
from openmeet_py.speech.transcription.engine import SherpaEngine

MODEL_DIR = os.environ.get("OPENMEET_PY_SHERPA_DIR", "")
VAD_FILE = os.environ.get("OPENMEET_PY_SHERPA_VAD", "")
ENABLED = os.environ.get("OPENMEET_PY_REAL_MODEL") == "1" and bool(MODEL_DIR) and bool(VAD_FILE)


@pytest.mark.real_model
@pytest.mark.skipif(not ENABLED, reason="opt-in: set OPENMEET_PY_REAL_MODEL=1, OPENMEET_PY_SHERPA_DIR and OPENMEET_PY_SHERPA_VAD")
def test_a_real_sherpa_folder_returns_timed_segments_for_a_synthetic_clip() -> None:
    folder = Path(MODEL_DIR)
    vad = Path(VAD_FILE)
    assert folder.is_absolute() and folder.is_dir() and vad.is_absolute() and vad.is_file()
    names = [name for name, _ in sherpa_models.folder_files(folder)]
    spec = sherpa_models._spec_for_files(folder, names, model_type="")
    t = np.arange(16000 * 3) / 16000
    samples = (0.2 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    engine = SherpaEngine(spec, vad)
    results = engine.transcribe(samples, "auto", "", threading.Event(), lambda segment: None, lambda percent: None)
    assert isinstance(results, list)
    assert all(item.end_ms >= item.start_ms >= 0 for item in results)
