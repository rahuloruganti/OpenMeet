"""Opt-in hardware check: records a few seconds from the real microphone and output loopback.

Not run by default (pytest.ini excludes the hardware marker). It runs only when BOTH hold:
  - the run selects it:          pytest -m hardware tests/test_hardware_audio.py
  - the owner authorized it:     OPENMEET_PY_HARDWARE_AUDIO=1
Missing devices FAIL here, never skip, as the Rust ignored test does. Passing proves only that two
finalized files were written. It does not prove audible content, pause privacy or clock accuracy.
Those are phase 7 manual checks (docs/python-port-plan.md).
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

HARDWARE_ENV = "OPENMEET_PY_HARDWARE_AUDIO"
RECORD_SECONDS = 3


@pytest.mark.hardware
def test_records_microphone_and_loopback_for_a_few_seconds(tmp_path: Path) -> None:
    if os.environ.get(HARDWARE_ENV) != "1":
        pytest.skip(f"Set {HARDWARE_ENV}=1 to record from real audio devices.")
    # Imported here, never at module level: a hardware-free run must not reach the library.
    from openmeet_py.audio_backend import PortAudioBackend
    from openmeet_py.recorder import Recorder
    from openmeet_py.store import Store

    backend = PortAudioBackend()
    microphones = backend.input_devices()
    outputs = backend.output_devices()
    assert microphones, "No microphone found. This hardware test fails rather than skipping."
    assert outputs, "No output loopback found. This hardware test fails rather than skipping."

    store = Store(tmp_path)
    recorder = Recorder(store, backend, lambda name, payload: None, store.data_dir / "audio")
    try:
        recorder.start("Hardware check", microphones[0].id, outputs[0].id)
        time.sleep(RECORD_SECONDS)
        state = recorder.stop()
        assert state["status"] == "stopped", state
        assert state["error"] is None, state["error"]
        rows = store.db.execute(
            "SELECT kind, frames, finalized FROM tracks ORDER BY kind"
        ).fetchall()
    finally:
        recorder.shutdown()
        store.close()
    assert [row[0] for row in rows] == ["mic", "system"]
    for kind, frames, finalized in rows:
        assert finalized == 1, f"{kind} track was not finalized"
        assert frames > 0, f"{kind} track recorded no frames"
