"""WAV reading, mono mixing and the windowed-sinc resampler. Synthetic audio only."""

from __future__ import annotations

from array import array
from pathlib import Path

import numpy as np
import pytest

from openmeet_py.api.errors import AppError
from openmeet_py.audio import audio_wav
from openmeet_py.speech.transcription import audio_read
from stt_fixtures import tone


def write_float_wav(path: Path, samples: np.ndarray, rate: int, channels: int = 1, finalize: bool = True) -> int:
    frames = samples.size // channels
    writer = audio_wav.WavFile(path, rate, channels)
    writer.write(np.asarray(samples, dtype="<f4").tobytes())
    if finalize:
        assert writer.finalize()
    else:
        writer.checkpoint()
        writer.close()
    return frames


def open_for(path: Path, rate: int, channels: int, frames: int) -> audio_read.WavTrack:
    return audio_read.open_track(path, sample_rate=rate, channels=channels, frames=frames)


def test_float_wav_reads_back_the_written_samples(tmp_path: Path) -> None:
    samples = np.array(tone(1600, 16000, 300.0), dtype=np.float32)
    path = tmp_path / "mic.wav"
    frames = write_float_wav(path, samples, 16000)
    track = open_for(path, 16000, 1, frames)
    assert np.array_equal(audio_read.read_mono(track, 0, frames), samples)
    assert np.array_equal(audio_read.read_mono(track, 100, 200), samples[100:200])


def test_stereo_tracks_are_mixed_to_mono_by_average(tmp_path: Path) -> None:
    left = np.full(800, 0.5, dtype=np.float32)
    right = np.full(800, -0.25, dtype=np.float32)
    interleaved = np.empty(1600, dtype=np.float32)
    interleaved[0::2] = left
    interleaved[1::2] = right
    path = tmp_path / "system.wav"
    frames = write_float_wav(path, interleaved, 16000, channels=2)
    track = open_for(path, 16000, 2, frames)
    mono = audio_read.read_mono(track, 0, frames)
    assert np.allclose(mono, 0.125)


def test_truncated_wav_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "mic.wav"
    frames = write_float_wav(path, np.ones(16000, dtype=np.float32), 16000)
    with open(path, "r+b") as handle:
        handle.truncate(path.stat().st_size - 4000)
    with pytest.raises(AppError) as info:
        open_for(path, 16000, 1, frames)
    assert info.value.code == "stt"
    assert "does not match" in info.value.message or "truncated" in info.value.message


def test_unfinalized_wav_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "mic.wav"
    write_float_wav(path, np.ones(16000, dtype=np.float32), 16000, finalize=False)
    with pytest.raises(AppError) as info:
        open_for(path, 16000, 1, 16000)
    assert "unfinalized" in info.value.message


def test_empty_track_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "mic.wav"
    write_float_wav(path, np.zeros(0, dtype=np.float32), 16000)
    with pytest.raises(AppError):
        open_for(path, 16000, 1, 0)


def test_metadata_that_disagrees_with_the_file_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "mic.wav"
    frames = write_float_wav(path, np.ones(16000, dtype=np.float32), 16000)
    with pytest.raises(AppError) as info:
        open_for(path, 48000, 1, frames)
    assert "does not match the recording metadata" in info.value.message
    with pytest.raises(AppError):
        open_for(path, 16000, 1, frames + 1)


def test_not_a_wav_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "junk.wav"
    path.write_bytes(b"not audio at all, just text")
    with pytest.raises(AppError):
        open_for(path, 16000, 1, 1)


def test_resampler_keeps_an_in_band_tone_and_removes_an_aliasing_one() -> None:
    rate = 48000
    seconds = 2
    t = np.arange(rate * seconds) / rate
    tone_1k = np.sin(2 * np.pi * 1000 * t).astype(np.float32)
    out = audio_read.resample(tone_1k, rate, 16000)
    assert out.size == 16000 * seconds  # length is exact: ceil(in * dst / src)
    core = out[500:-500]
    assert abs(np.max(np.abs(core)) - 1.0) < 0.01
    spectrum = np.abs(np.fft.rfft(out))
    freqs = np.fft.rfftfreq(out.size, 1 / 16000)
    assert abs(freqs[np.argmax(spectrum)] - 1000) < 1.0
    # 10 kHz is above the 8 kHz output Nyquist: the filter must suppress it, not fold it down.
    tone_10k = np.sin(2 * np.pi * 10000 * t).astype(np.float32)
    aliased = audio_read.resample(tone_10k, rate, 16000)
    assert np.sqrt(np.mean(aliased[500:-500] ** 2)) < 1e-3


def test_resampler_length_and_identity_cases() -> None:
    assert audio_read.resample(np.ones(44100, dtype=np.float32), 44100, 16000).size == 16000
    assert audio_read.resample(np.ones(1000, dtype=np.float32), 16000, 16000).size == 1000
    up = audio_read.resample(np.ones(8000, dtype=np.float32), 8000, 16000)
    assert up.size == 16000 and np.allclose(up[200:-200], 1.0, atol=1e-4)
    constant = audio_read.resample(np.full(48000, 0.5, dtype=np.float32), 48000, 16000)
    assert np.allclose(constant[100:-100], 0.5, atol=1e-4)


def test_windowed_resampling_matches_the_whole_array_across_seams(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(audio_read, "WINDOW_SECONDS", 1)
    rate = 48000
    seconds = 3
    t = np.arange(rate * seconds + 123) / rate
    signal = (0.4 * np.sin(2 * np.pi * 700 * t) + 0.2 * np.sin(2 * np.pi * 2100 * t)).astype(np.float32)
    path = tmp_path / "long.wav"
    frames = write_float_wav(path, signal, rate)
    track = open_for(path, rate, 1, frames)
    pieces = [window.samples for window in audio_read.iter_16k_windows(track)]
    stitched = np.concatenate(pieces)
    whole = audio_read.resample(signal, rate, 16000)
    assert stitched.size == whole.size == -(-frames * 16000 // rate)
    assert np.max(np.abs(stitched - whole)) < 1e-4
    assert len(pieces) == 4


def test_cancel_stops_the_window_iteration(tmp_path: Path, monkeypatch) -> None:
    import threading

    monkeypatch.setattr(audio_read, "WINDOW_SECONDS", 1)
    path = tmp_path / "long.wav"
    frames = write_float_wav(path, np.ones(16000 * 3, dtype=np.float32), 16000)
    track = open_for(path, 16000, 1, frames)
    cancel = threading.Event()
    seen = []
    with pytest.raises(AppError) as info:
        for window in audio_read.iter_16k_windows(track, cancel):
            seen.append(window.index)
            cancel.set()
    assert info.value.code == "stt_cancelled"
    assert seen == [0]
