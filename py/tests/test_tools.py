"""Tests for py/tools: make_test_audio.py and verify_recording.py.

Synthetic fixtures only, written into tmp_path. No audio device is opened and nothing plays.
"""

from __future__ import annotations

import json
from array import array
from pathlib import Path

import numpy as np
import pytest

from openmeet_py.audio_wav import WavFile, timing_line
from tools import make_test_audio as gen
from tools import verify_recording as ver

RATE = 16000


def write_tone(path: Path, *extra: str) -> None:
    assert gen.main([str(path), "--rate", str(RATE), *extra]) == 0


def checks_by_id(report: dict) -> dict:
    return {check["id"]: check for check in report["checks"]}


def verify(*argv: str) -> tuple[dict, int]:
    return ver.run(ver.parse_args(list(argv)))


# ---- make_test_audio -------------------------------------------------------------------------


def test_generated_float_file_has_app_layout_and_frame_count(tmp_path: Path) -> None:
    out = tmp_path / "tone.wav"
    write_tone(out, "--duration", "3", "--marker-every", "0", "--channels", "2")
    info = ver.parse_wav(out)
    assert info.fmt_tag == 3 and info.bits == 32
    assert info.channels == 2
    assert info.frames == 3 * RATE
    assert info.fact_frames == 3 * RATE
    assert info.finalized is True


def test_pcm16_mono_file_reads_back(tmp_path: Path) -> None:
    out = tmp_path / "pcm.wav"
    write_tone(out, "--duration", "2", "--format", "pcm16", "--channels", "1", "--freq", "600", "--marker-every", "0")
    info = ver.parse_wav(out)
    assert (info.fmt_tag, info.bits, info.channels) == (1, 16, 1)
    assert info.frames == 2 * RATE
    freqs = ver.dominant_frequencies(info)
    assert abs(np.median(freqs) - 600) / 600 < 0.01


def test_generator_refuses_to_overwrite_and_bad_duration(tmp_path: Path) -> None:
    out = tmp_path / "exists.wav"
    out.write_bytes(b"keep me")
    assert gen.main([str(out), "--duration", "1"]) == 2
    assert out.read_bytes() == b"keep me"
    with pytest.raises(SystemExit):
        gen.parse_args([str(tmp_path / "long.wav"), "--duration", "4000"])  # over 65 minutes


def test_help_exits_zero_for_both_tools() -> None:
    for module in (gen, ver):
        with pytest.raises(SystemExit) as exit_info:
            module.parse_args(["--help"])
        assert exit_info.value.code == 0


# ---- tone and silence ------------------------------------------------------------------------


def test_tone_frequency_is_detected(tmp_path: Path) -> None:
    out = tmp_path / "system.wav"
    write_tone(out, "--duration", "10", "--freq", "440", "--marker-every", "0")
    report, _ = verify("--system", str(out), "--marker-every", "0")
    assert checks_by_id(report)["system.tone"]["status"] == "PASS"
    assert abs(report["tracks"]["system"]["dominant_hz_median"] - 440) < 4.4


def test_wrong_expected_tone_fails(tmp_path: Path) -> None:
    out = tmp_path / "system.wav"
    write_tone(out, "--duration", "4", "--freq", "440", "--marker-every", "0")
    report, code = verify("--system", str(out), "--tone-freq", "660", "--marker-every", "0")
    assert checks_by_id(report)["system.tone"]["status"] == "FAIL"
    assert code == 1


def test_silent_track_is_flagged(tmp_path: Path) -> None:
    out = tmp_path / "mic.wav"
    wav = WavFile(out, RATE, 2)
    wav.write(array("f", [0.0] * (2 * RATE * 2)).tobytes())
    assert wav.finalize() is True
    report, code = verify("--mic", str(out), "--marker-every", "0")
    assert checks_by_id(report)["mic.silence"]["status"] == "FAIL"
    assert code == 1


# ---- markers and drift -----------------------------------------------------------------------


def test_marker_spacing_is_clean_without_injected_drift(tmp_path: Path) -> None:
    out = tmp_path / "system.wav"
    write_tone(out, "--duration", "40", "--marker-every", "4")
    report, _ = verify("--system", str(out), "--marker-every", "4")
    fit = report["tracks"]["system"]["marker_fit"]
    assert fit["markers"] == 9
    assert abs(fit["measured_spacing_s"] - 4.0) < 0.002
    assert abs(fit["spacing_error_ppm"]) < 500  # onset quantization is 10 ms per window
    assert checks_by_id(report)["system.markers"]["status"] == "PASS"


def test_injected_drift_is_measured(tmp_path: Path) -> None:
    out = tmp_path / "system.wav"
    write_tone(out, "--duration", "40", "--marker-every", "4", "--marker-drift-ppm", "5000")
    report, _ = verify("--system", str(out), "--marker-every", "4")
    fit = report["tracks"]["system"]["marker_fit"]
    assert abs(fit["spacing_error_ppm"] - 5000) < 500
    # A 40 s run is too short for a measured verdict, so it is extrapolated to 60 minutes and fails.
    assert checks_by_id(report)["system.drift"]["status"] == "FAIL"


def test_marker_fit_math_with_synthetic_onsets() -> None:
    spacing = 2.0
    onsets = [k * spacing * (1 + 1e-4) for k in range(1, 51)]
    fit = ver.marker_fit(onsets, spacing)
    assert abs(fit["spacing_error_ppm"] - 100) < 0.5
    assert abs(fit["extrapolated_60min_ms"] - 360) < 1.0  # 100 ppm for 3600 s
    assert fit["missing_markers"] == 0
    assert ver.marker_fit(onsets[:2], spacing) is None


def test_missing_marker_is_counted() -> None:
    onsets = [2.0, 4.0, 8.0, 10.0]  # the one at 6 s is missing
    fit = ver.marker_fit(onsets, 2.0)
    assert fit["missing_markers"] == 1


def test_paused_marker_tone_must_be_absent(tmp_path: Path) -> None:
    out = tmp_path / "system.wav"
    write_tone(out, "--duration", "6", "--freq", "440", "--marker-every", "0")
    report_clean, _ = verify("--system", str(out), "--marker-every", "0", "--paused-freq", "2000")
    assert checks_by_id(report_clean)["system.paused_marker"]["status"] == "PASS"
    report_present, _ = verify("--system", str(out), "--marker-every", "0", "--paused-freq", "440")
    assert checks_by_id(report_present)["system.paused_marker"]["status"] == "FAIL"


# ---- pause gaps and timing -------------------------------------------------------------------


def write_track_with_index(folder: Path, generations: tuple[int, int], timing_name: str = "mic") -> Path:
    """One second of audio, a two second gap, then one more second. The gap is a pause when generations differ."""
    wav_path = folder / f"{timing_name}.wav"
    wav = WavFile(wav_path, RATE, 1)
    wav.write(array("f", [0.5] * RATE).tobytes())
    wav.write(array("f", [0.5] * RATE).tobytes())
    assert wav.finalize() is True
    index = folder / f"{timing_name}.timing.jsonl"
    index.write_text(  # two blocks: the second starts after a 2 s pause (or a 2 s unexplained gap)
        timing_line(0, RATE, 0, generations[0]) + timing_line(RATE, RATE, 3_000_000, generations[1]),
        encoding="ascii",
    )
    return wav_path


def test_pause_gap_is_reported_as_a_pause(tmp_path: Path) -> None:
    wav_path = write_track_with_index(tmp_path, generations=(0, 1))
    report, code = verify("--mic", str(wav_path), "--marker-every", "0")
    timing = report["tracks"]["mic"]["timing"]
    assert timing["valid"] is True
    assert len(timing["pauses"]) == 1
    assert abs(timing["pauses"][0]["duration_ms"] - 2000) < 0.5
    assert checks_by_id(report)["mic.gaps"]["status"] == "PASS"
    assert checks_by_id(report)["mic.pause_consistency"]["status"] == "PASS"
    assert code == 0


def test_gap_without_generation_change_is_unexplained(tmp_path: Path) -> None:
    wav_path = write_track_with_index(tmp_path, generations=(0, 0))
    report, code = verify("--mic", str(wav_path), "--marker-every", "0")
    timing = report["tracks"]["mic"]["timing"]
    assert timing["pauses"] == []
    assert len(timing["unexplained_gaps"]) == 1
    assert checks_by_id(report)["mic.gaps"]["status"] == "FAIL"
    assert code == 1


def test_index_frame_mismatch_fails(tmp_path: Path) -> None:
    wav_path = write_track_with_index(tmp_path, generations=(0, 1))
    index = tmp_path / "mic.timing.jsonl"
    index.write_text(timing_line(0, RATE, 0, 0), encoding="ascii")  # covers only half the file
    report, _ = verify("--mic", str(wav_path), "--marker-every", "0")
    assert checks_by_id(report)["mic.timing"]["status"] == "FAIL"


# ---- invalid and truncated files -------------------------------------------------------------


def test_non_wav_file_is_unreadable(tmp_path: Path) -> None:
    bad = tmp_path / "bad.wav"
    bad.write_bytes(b"hello, this is not a wav file")
    report, code = verify("--system", str(bad), "--marker-every", "0")
    assert report["tracks"]["system"]["readable"] is False
    assert checks_by_id(report)["system.header"]["status"] == "FAIL"
    assert code == 2


def test_truncated_file_is_flagged_and_counts_whole_frames(tmp_path: Path) -> None:
    out = tmp_path / "system.wav"
    write_tone(out, "--duration", "2", "--marker-every", "0", "--channels", "2")
    data = out.read_bytes()
    out.write_bytes(data[: len(data) - 10])  # cut into the last frame
    info = ver.parse_wav(out)
    assert info.finalized is False
    assert info.frames == 2 * RATE - 2  # 10 cut bytes = one whole 8-byte frame and 2 stray bytes
    assert info.partial_bytes == 6
    assert any("truncated" in problem for problem in info.problems)
    report, code = verify("--system", str(out), "--marker-every", "0")
    assert checks_by_id(report)["system.finalized"]["status"] == "FAIL"
    assert code == 1


def test_unfinalized_file_is_recognised(tmp_path: Path) -> None:
    out = tmp_path / "mic.wav"
    wav = WavFile(out, RATE, 1)
    wav.write(array("f", [0.25] * RATE).tobytes())
    wav.checkpoint()
    wav.close()  # never finalized: the header still says zero data bytes
    info = ver.parse_wav(out)
    assert info.finalized is False
    assert info.frames == RATE


def test_both_tracks_identical_is_flagged(tmp_path: Path) -> None:
    mic = tmp_path / "mic.wav"
    system = tmp_path / "system.wav"
    write_tone(mic, "--duration", "2", "--marker-every", "0", "--channels", "1")
    system.write_bytes(mic.read_bytes())
    report, _ = verify("--mic", str(mic), "--system", str(system), "--marker-every", "0")
    assert checks_by_id(report)["pair.distinct"]["status"] == "FAIL"


# ---- output ----------------------------------------------------------------------------------


def test_json_output_is_parseable(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / "system.wav"
    write_tone(out, "--duration", "2", "--marker-every", "0")
    capsys.readouterr()  # drop the generator's "Wrote ..." line
    code = ver.main(["--json", "--system", str(out), "--marker-every", "0"])
    report = json.loads(capsys.readouterr().out)
    assert report["tool"] == "verify_recording"
    assert report["overall"] == "FAIL"  # no timing index was written, so the timing check fails
    assert checks_by_id(report)["system.timing"]["status"] == "FAIL"
    assert report["counts"]["PASS"] + report["counts"]["FAIL"] + report["counts"]["INFO"] == len(report["checks"])
    assert code == 1


def test_missing_folder_is_exit_two(tmp_path: Path) -> None:
    with pytest.raises(SystemExit):
        ver.resolve_paths(ver.parse_args([str(tmp_path / "nope")]))
    assert ver.main([str(tmp_path / "nope")]) == 2
