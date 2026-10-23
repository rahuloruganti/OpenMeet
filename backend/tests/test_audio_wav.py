"""WAV and timing-index rules: header bytes, finalize, repair, index validation, position mapping, peak.

Synthetic samples only. These tests never touch an audio device.
"""

from __future__ import annotations

import struct
from array import array
from pathlib import Path

import pytest

from openmeet_py.api.errors import AppError
from openmeet_py.audio.audio_wav import (
    HEADER_SIZE,
    Block,
    WavFile,
    file_ms,
    measure,
    read_timing,
    repair_wav,
    timing_line,
)

RATE = 16000
CHANNELS = 2
BLOCK_ALIGN = CHANNELS * 4


def floats(*values: float) -> bytes:
    return array("f", values).tobytes()


def make_wav(path: Path, frames: int, value: float = 0.5, finalize: bool = True) -> None:
    wav = WavFile(path, RATE, CHANNELS)
    wav.write(floats(*([value] * (frames * CHANNELS))))
    if finalize:
        assert wav.finalize() is True
    else:
        wav.checkpoint(sync=True)
        wav.close()


def test_header_is_ieee_float_with_fact_and_data_last(tmp_path: Path) -> None:
    path = tmp_path / "mic.wav"
    wav = WavFile(path, RATE, CHANNELS)
    raw = path.read_bytes()
    # Before any audio: placeholder sizes, but the layout is final.
    assert len(raw) == HEADER_SIZE
    assert raw[0:4] == b"RIFF" and raw[8:12] == b"WAVE"
    assert raw[12:16] == b"fmt " and struct.unpack_from("<I", raw, 16)[0] == 18
    tag, channels, rate, byte_rate, align, bits, cb = struct.unpack_from("<HHIIHHH", raw, 20)
    assert (tag, channels, rate, byte_rate, align, bits, cb) == (
        3,
        CHANNELS,
        RATE,
        RATE * BLOCK_ALIGN,
        BLOCK_ALIGN,
        32,
        0,
    )
    assert raw[38:42] == b"fact" and struct.unpack_from("<I", raw, 42)[0] == 4
    assert raw[50:54] == b"data"
    wav.close()


def test_finalize_patches_sizes_and_the_file_is_the_header_plus_data(tmp_path: Path) -> None:
    path = tmp_path / "mic.wav"
    wav = WavFile(path, RATE, CHANNELS)
    wav.write(floats(0.1, 0.2, 0.3, 0.4))  # two stereo frames
    assert wav.finalize() is True
    raw = path.read_bytes()
    data_bytes = 2 * BLOCK_ALIGN
    assert len(raw) == HEADER_SIZE + data_bytes
    assert struct.unpack_from("<I", raw, 4)[0] == 50 + data_bytes  # RIFF size
    assert struct.unpack_from("<I", raw, 46)[0] == 2  # fact: sample frames
    assert struct.unpack_from("<I", raw, 54)[0] == data_bytes  # data size
    assert raw[HEADER_SIZE:] == floats(0.1, 0.2, 0.3, 0.4)


def test_wav_never_overwrites_an_existing_file(tmp_path: Path) -> None:
    path = tmp_path / "mic.wav"
    path.write_bytes(b"keep me")
    with pytest.raises(FileExistsError):
        WavFile(path, RATE, CHANNELS)
    assert path.read_bytes() == b"keep me"


def test_repair_writes_whole_frames_to_a_new_copy_and_keeps_the_original(tmp_path: Path) -> None:
    original = tmp_path / "mic.wav"
    make_wav(original, frames=3, value=0.25, finalize=False)
    with original.open("ab") as handle:
        handle.write(b"\x01\x02\x03")  # a partial frame from a crash
    before = original.read_bytes()
    copy = tmp_path / "mic.recovered-1.wav"
    assert repair_wav(original, copy) == 3
    assert original.read_bytes() == before  # the original is only read
    repaired = copy.read_bytes()
    assert struct.unpack_from("<I", repaired, 54)[0] == 3 * BLOCK_ALIGN
    assert struct.unpack_from("<I", repaired, 4)[0] == 50 + 3 * BLOCK_ALIGN
    assert repaired[HEADER_SIZE:] == floats(*([0.25] * 6))


def test_repair_never_overwrites_an_existing_copy(tmp_path: Path) -> None:
    original = tmp_path / "mic.wav"
    make_wav(original, frames=2, finalize=False)
    copy = tmp_path / "mic.recovered-2.wav"
    copy.write_bytes(b"earlier recovery")
    with pytest.raises(AppError) as info:
        repair_wav(original, copy)
    assert info.value.code == "recovery_exists"
    assert copy.read_bytes() == b"earlier recovery"


def test_repair_rejects_a_file_that_is_not_a_wav(tmp_path: Path) -> None:
    original = tmp_path / "junk.wav"
    original.write_bytes(b"not a wave file at all")
    with pytest.raises(AppError) as info:
        repair_wav(original, tmp_path / "copy.wav")
    assert "Nothing was recovered" in info.value.message


def test_timing_line_is_the_exact_index_format() -> None:
    assert (
        timing_line(0, 1024, 5, 2)
        == '{"frame_offset":0,"frames":1024,"capture_start_us":5,"generation":2}\n'
    )


def index_path(tmp_path: Path, text: bytes) -> Path:
    path = tmp_path / "mic.timing.jsonl"
    path.write_bytes(text)
    return path


def test_complete_pause_index_is_accepted_and_keeps_the_real_gap(tmp_path: Path) -> None:
    text = (
        b'{"frame_offset":0,"frames":16000,"capture_start_us":1000000,"generation":1}\n'
        b'{"frame_offset":16000,"frames":16000,"capture_start_us":8000000}\n'
    )
    path = index_path(tmp_path, text)
    blocks = read_timing(path, RATE, 32000)
    assert [b.capture_start_us for b in blocks] == [1_000_000, 8_000_000]
    assert blocks[0].generation == 1 and blocks[1].generation is None
    assert path.read_bytes() == text  # validation never edits the index


def test_jittered_device_stamps_are_laid_end_to_end(tmp_path: Path) -> None:
    stamps = [43_218, 61_236, 60_296, 70_338, 5_000_000]
    text = "".join(
        f'{{"frame_offset":{i * 160},"frames":160,"capture_start_us":{us},"generation":1}}\n'
        for i, us in enumerate(stamps)
    ).encode()
    blocks = read_timing(index_path(tmp_path, text), RATE, 800)
    assert [b.capture_start_us for b in blocks] == [43_218, 53_218, 63_218, 73_218, 5_000_000]


BAD_INDEXES = {
    "empty": b"",
    "not json": b"not json\n",
    "negative frames": b'{"frame_offset":0,"frames":-1,"capture_start_us":0}\n',
    "zero frames": b'{"frame_offset":0,"frames":0,"capture_start_us":0}\n',
    "first offset not zero": b'{"frame_offset":1,"frames":32000,"capture_start_us":0}\n',
    "incomplete total": b'{"frame_offset":0,"frames":16000,"capture_start_us":0}\n',
    "too many frames": b'{"frame_offset":0,"frames":32001,"capture_start_us":0}\n',
    "backwards start": (
        b'{"frame_offset":0,"frames":16000,"capture_start_us":1000000}\n'
        b'{"frame_offset":16000,"frames":16000,"capture_start_us":0}\n'
    ),
    "overlap beyond tolerance": (
        b'{"frame_offset":0,"frames":16000,"capture_start_us":1000000}\n'
        b'{"frame_offset":16000,"frames":16000,"capture_start_us":1500000}\n'
    ),
    "partial last line": (
        b'{"frame_offset":0,"frames":32000,"capture_start_us":0}\n{partial'
    ),
    "u64 overflow": b'{"frame_offset":0,"frames":32000,"capture_start_us":18446744073709551615}\n',
    "line over 1024 bytes": b" " * 1025,
}


@pytest.mark.parametrize("name", sorted(BAD_INDEXES))
def test_malformed_index_is_refused_and_left_unchanged(tmp_path: Path, name: str) -> None:
    text = BAD_INDEXES[name]
    path = index_path(tmp_path, text)
    with pytest.raises(AppError) as info:
        read_timing(path, RATE, 32000)
    assert info.value.code == "audio_timing"
    assert path.read_bytes() == text


def test_index_for_zero_rate_or_frames_is_refused(tmp_path: Path) -> None:
    path = index_path(tmp_path, b'{"frame_offset":0,"frames":16000,"capture_start_us":0}\n')
    with pytest.raises(AppError):
        read_timing(path, 0, 16000)
    with pytest.raises(AppError):
        read_timing(path, RATE, 0)


def test_missing_index_is_refused(tmp_path: Path) -> None:
    with pytest.raises(AppError) as info:
        read_timing(tmp_path / "missing.jsonl", RATE, 16000)
    assert info.value.code == "audio_timing"


def test_session_time_maps_to_file_position_across_a_pause_gap() -> None:
    blocks = [
        Block(frame_offset=0, frames=16000, capture_start_us=1_000_000),
        Block(frame_offset=16000, frames=16000, capture_start_us=8_000_000),
    ]
    assert file_ms(blocks, RATE, 0) == 0
    assert file_ms(blocks, RATE, 500) == 0
    assert file_ms(blocks, RATE, 2000) == 1000  # end of the first block
    assert file_ms(blocks, RATE, 8000) == 1000  # inside the gap: first frame after it
    assert file_ms(blocks, RATE, 9000) == 2000


def test_peak_meter_reads_the_largest_absolute_sample() -> None:
    peak, cleaned = measure(floats(0.0, -0.5, 0.25))
    assert peak == pytest.approx(0.5) and cleaned is None


def test_non_finite_samples_read_as_zero_and_values_are_clamped() -> None:
    peak, cleaned = measure(floats(float("nan"), 0.2))
    assert peak == pytest.approx(0.2)
    assert cleaned == floats(0.0, 0.2)
    peak, cleaned = measure(floats(2.0, -0.1))
    assert peak == 1.0
    assert cleaned == floats(1.0, -0.1)
