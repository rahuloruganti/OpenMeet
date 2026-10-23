"""Session-time mapping, the merge, validation, cancel, progress and failure.

Fixtures are 16 kHz, one second per block, with a six-second pause before the last block.
"""

from __future__ import annotations

import threading
from pathlib import Path

import pytest

from openmeet_py.api.errors import AppError
from openmeet_py.audio import audio_wav
from openmeet_py.speech import stt
from openmeet_py.speech.transcription import engine as engine_module
from openmeet_py.speech.transcription import pipeline
from openmeet_py.speech.transcription.engine import FakeEngine, WhisperCppEngine
from stt_fixtures import write_track

RATE = 16000
INDEX = [
    audio_wav.Block(0, 16000, 1_000_000, 0),
    audio_wav.Block(16000, 16000, 2_000_000, 0),
    audio_wav.Block(32000, 16000, 8_000_000, 0),
]


def test_positions_map_through_the_timing_index_across_pauses() -> None:
    assert pipeline.session_ms(INDEX, RATE, 0, False) == 1000
    assert pipeline.session_ms(INDEX, RATE, 750, False) == 1750
    assert pipeline.session_ms(INDEX, RATE, 1000, False) == 2000
    assert pipeline.session_ms(INDEX, RATE, 2250, False) == 8250
    # Past the final block clamps to its end instead of extrapolating.
    assert pipeline.session_ms(INDEX, RATE, 99_000, False) == 9000
    assert pipeline.session_ms([], RATE, 1234, False) == 1234


def test_a_segment_ending_at_a_pause_does_not_extend_into_resumed_audio() -> None:
    index = [audio_wav.Block(0, 16000, 1_000_000, 0), audio_wav.Block(16000, 16000, 8_000_000, 0)]
    first = (pipeline.session_ms(index, RATE, 0, False), pipeline.session_ms(index, RATE, 1000, True))
    second = (pipeline.session_ms(index, RATE, 1000, False), pipeline.session_ms(index, RATE, 1500, True))
    assert first == (1000, 2000)
    assert second == (8000, 8500)


def test_session_times_map_back_to_file_times_across_a_pause() -> None:
    # Same index: 0-2 s recorded, paused, then 1 s more at session time 8 s.
    assert audio_wav.file_ms(INDEX, RATE, 1750) == 750
    assert audio_wav.file_ms(INDEX, RATE, 8250) == 2250
    assert audio_wav.file_ms(INDEX, RATE, 5000) == 2000  # inside the gap: first frame after it
    assert audio_wav.file_ms(INDEX, RATE, 500) == 0
    assert audio_wav.file_ms(INDEX, RATE, 99_000) == 3000
    for audio in [0, 250, 1000, 1999, 2000, 2600, 3000]:
        assert audio_wav.file_ms(INDEX, RATE, pipeline.session_ms(INDEX, RATE, audio, False)) == audio


def test_marker_and_blank_text_is_not_transcript() -> None:
    assert pipeline.is_marker("[MUSIC]")
    assert pipeline.is_marker("(silence)")
    assert not pipeline.is_marker("Hello [there]")


def test_segments_merge_by_start_then_speaker_and_untimed_sort_last() -> None:
    merged = [
        {"speaker": "Others", "timing": {"kind": "timed", "start_ms": 500, "end_ms": 900}, "text": "b"},
        {"speaker": "You", "timing": {"kind": "timed", "start_ms": 500, "end_ms": 700}, "text": "a"},
        {"speaker": "You", "timing": {"kind": "untimed"}, "text": "z"},
        {"speaker": "You", "timing": {"kind": "timed", "start_ms": 100, "end_ms": 200}, "text": "c"},
    ]
    merged.sort(key=pipeline._sort_key)
    # Speakers compare as strings: "Others" sorts before "You".
    assert [item["text"] for item in merged] == ["c", "b", "a", "z"]


def test_run_tracks_labels_speakers_filters_markers_and_maps_times(tmp_path: Path) -> None:
    mic = write_track(tmp_path, "mic", blocks=[(16000, 1_000_000, 0), (16000, 8_000_000, 0)])
    system = write_track(tmp_path, "system", blocks=[(32000, 1_000_000, 0)], freq=660.0)
    engine = FakeEngine(text="Fictional")
    segments = pipeline.run_tracks(
        [mic, system], engine, "auto", "", threading.Event(), lambda kind, percent: None
    )
    speakers = {segment["speaker"] for segment in segments}
    assert speakers == {"You", "Others"}
    timed = [segment["timing"] for segment in segments]
    assert all(timing["kind"] == "timed" for timing in timed)
    starts = [timing["start_ms"] for timing in timed]
    assert starts == sorted(starts)
    assert all(timing["end_ms"] >= timing["start_ms"] for timing in timed)
    assert engine.calls and engine.calls[0][1] == "auto"


def test_progress_is_reported_per_track_and_ends_at_100(tmp_path: Path) -> None:
    mic = write_track(tmp_path, "mic")
    seen: list[tuple[str, int]] = []
    pipeline.run_tracks([mic], FakeEngine(), "en", "", threading.Event(), lambda k, p: seen.append((k, p)))
    assert seen[0] == ("mic", 0)
    assert seen[-1] == ("mic", 100)
    percents = [percent for _, percent in seen]
    assert percents == sorted(percents)


def test_cancel_between_windows_returns_nothing_and_stops_the_engine(tmp_path: Path, monkeypatch) -> None:
    from openmeet_py.speech.transcription import audio_read

    monkeypatch.setattr(audio_read, "WINDOW_SECONDS", 1)
    mic = write_track(tmp_path, "mic", blocks=[(16000 * 3, 1_000_000, 0)])
    cancel = threading.Event()
    engine = FakeEngine(on_window=lambda index: cancel.set())
    with pytest.raises(AppError) as info:
        pipeline.run_tracks([mic], engine, "en", "", cancel, lambda k, p: None)
    assert info.value.code == "stt_cancelled"
    assert len(engine.calls) == 1


def test_engine_failure_is_a_clean_error_that_does_not_echo_the_engine_message(tmp_path: Path) -> None:
    mic = write_track(tmp_path, "mic")
    engine = FakeEngine(fail_with="secret transcript words spoken aloud")
    with pytest.raises(AppError) as info:
        pipeline.run_tracks([mic], engine, "en", "", threading.Event(), lambda k, p: None)
    assert info.value.code == "stt"
    assert "secret" not in info.value.message
    assert "previous transcript is unchanged" in info.value.message


def test_bad_timing_is_rejected_before_any_engine_call(tmp_path: Path) -> None:
    mic = write_track(tmp_path, "mic")
    Path(mic["timing_path"]).write_text("{partial", encoding="ascii")
    engine = FakeEngine()
    with pytest.raises(AppError) as info:
        pipeline.run_tracks([mic], engine, "en", "", threading.Event(), lambda k, p: None)
    assert info.value.code == "audio_timing"
    assert engine.calls == []


def test_settings_validation_matches_stt_validate() -> None:
    stt.validate("auto", "", "small")
    stt.validate("de", "Okta, Kubernetes", "base")
    for language in ["xx", "de; rm", ""]:
        with pytest.raises(AppError) as info:
            stt.validate(language, "", "small")
        assert info.value.code == "stt_settings"
    with pytest.raises(AppError):
        stt.validate("en", "x" * 501, "small")
    with pytest.raises(AppError):
        stt.validate("en", "two\nlines", "small")
    with pytest.raises(AppError):
        stt.validate("en", "tab\there", "small")
    with pytest.raises(AppError):
        stt.validate("en", "", "huge")
    stt.validate("en", "é" * 500, "small")


def test_sherpa_ids_are_accepted_and_downloaded_folder_names_must_be_plain() -> None:
    for model_id in ["sherpa:parakeet-v3", "sherpa:moonshine-base-en", "sherpa:sense-voice", "sherpa-dir:team--parakeet"]:
        stt.validate("en", "", model_id)
    for model_id in ["sherpa-dir:", "sherpa-dir:..", "sherpa-dir:a/b", "sherpa-dir:.hidden"]:
        with pytest.raises(AppError) as info:
            stt.validate("en", "", model_id)
        assert info.value.code == "stt_settings"
    with pytest.raises(AppError) as info:
        stt.validate("en", "", "sherpa:unlisted")  # not a catalog id, not a file: refused like any unknown model
    assert info.value.code == "stt_settings"


def test_a_scanned_whisper_file_is_used_in_place_and_anything_else_is_refused(tmp_path: Path) -> None:
    whisper = tmp_path / "ggml-custom.bin"
    whisper.write_bytes(b"lmggfictional-weights")
    other = tmp_path / "notes.bin"
    other.write_bytes(b"GGUFllm")
    stt.validate("en", "", str(whisper))
    assert stt.status(tmp_path / "stt", str(whisper))["model"] is True
    for bad in [str(other), "ggml-custom.bin", str(tmp_path / "missing.bin")]:
        with pytest.raises(AppError) as info:
            stt.validate("en", "", bad)
        assert info.value.code == "stt_settings"
        assert stt.status(tmp_path / "stt", bad)["model"] is False


def test_whisper_engine_refuses_names_and_missing_files_before_importing_the_library(tmp_path: Path) -> None:
    # pywhispercpp would download a model for a name that is not a file, so only absolute, existing
    # files are accepted. The library is blocked in tests, so any import attempt would also fail loudly.
    with pytest.raises(AppError):
        WhisperCppEngine(Path("ggml-small.bin"))
    with pytest.raises(AppError):
        WhisperCppEngine(tmp_path / "missing-model.bin")


def test_make_engine_selects_fake_or_whisper_by_flag(tmp_path: Path) -> None:
    assert isinstance(engine_module.make_engine(None, None, fake=True), FakeEngine)
    with pytest.raises(AppError):
        engine_module.make_engine(None, None, fake=False)
