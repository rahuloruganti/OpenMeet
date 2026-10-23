"""Reads the float32 WAV tracks written by audio_wav.WavFile and prepares 16 kHz mono windows.

Only the pieces of a track that are needed are read, so a long recording never has to fit in memory:
each window of WINDOW_SECONDS is read, mixed to mono and resampled on its own. The resampler is a
windowed-sinc (Kaiser) filter written with numpy only; it introduces no new dependency.
"""

from __future__ import annotations

import math
import os
import struct
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional

import numpy as np

from openmeet_py.api.errors import AppError

TARGET_RATE = 16_000
WINDOW_SECONDS = 300
KAISER_BETA = 8.6
ZERO_CROSSINGS = 16
BLOCK_OUTPUTS = 8192
FORMAT_TAG_FLOAT = 3


def _audio_error(message: str) -> AppError:
    return AppError("stt", message)


@dataclass(frozen=True)
class WavTrack:
    path: Path
    sample_rate: int
    channels: int
    frames: int
    data_offset: int

    @property
    def frame_bytes(self) -> int:
        return self.channels * 4


def open_track(path: Path, *, sample_rate: int, channels: int, frames: int) -> WavTrack:
    """Checks a track file against its database row before any audio is read.

    Refuses anything but a 32-bit IEEE float WAV whose data chunk holds exactly the recorded frames.
    An unfinalized file has a zero data size and is refused here as well.
    """
    try:
        with open(path, "rb") as handle:
            head = handle.read(64 * 1024)
        file_size = os.path.getsize(path)
    except OSError as error:
        raise _audio_error("The recording audio file could not be read. Nothing was transcribed.") from error
    if len(head) < 12 or head[0:4] != b"RIFF" or head[8:12] != b"WAVE":
        raise _audio_error("The recording audio file is not a readable WAV. Nothing was transcribed.")
    fmt: Optional[tuple[int, int, int, int, int]] = None
    data: Optional[tuple[int, int]] = None
    at = 12
    while at + 8 <= len(head):
        tag = head[at : at + 4]
        size = struct.unpack_from("<I", head, at + 4)[0]
        if tag == b"fmt " and size >= 16 and at + 8 + 16 <= len(head):
            fmt = struct.unpack_from("<HHIIHH", head, at + 8)[0:6]  # tag, channels, rate, bytes/s, align, bits
        if tag == b"data":
            data = (at + 8, size)
            break
        at += 8 + size + size % 2
    if fmt is None or data is None:
        raise _audio_error("The recording audio file is incomplete. Nothing was transcribed.")
    tag, file_channels, file_rate, _bytes_per_second, block_align, bits = fmt
    if (
        tag != FORMAT_TAG_FLOAT
        or bits != 32
        or file_channels != channels
        or file_rate != sample_rate
        or block_align != channels * 4
    ):
        raise _audio_error("The WAV format does not match the recording metadata. Nothing was transcribed.")
    data_offset, data_size = data
    if data_size == 0 or data_size // block_align != frames or data_size % block_align:
        raise _audio_error(
            "The recording audio file is unfinalized or does not match its recorded length. "
            "Recover it before transcription."
        )
    if data_offset + data_size > file_size:
        raise _audio_error("The recording audio file is truncated. Recover it before transcription.")
    return WavTrack(Path(path), sample_rate, channels, frames, data_offset)


def read_raw(track: WavTrack, start: int, stop: int) -> np.ndarray:
    """Frames [start, stop) as a (frames, channels) float32 array. Clamped to the file."""
    start = max(0, start)
    stop = min(stop, track.frames)
    if stop <= start:
        return np.zeros((0, track.channels), dtype=np.float32)
    with open(track.path, "rb") as handle:
        handle.seek(track.data_offset + start * track.frame_bytes)
        raw = handle.read((stop - start) * track.frame_bytes)
    samples = np.frombuffer(raw, dtype="<f4")
    usable = samples.size - samples.size % track.channels
    return samples[:usable].reshape(-1, track.channels)


def read_mono(track: WavTrack, start: int, stop: int) -> np.ndarray:
    """Frames [start, stop) mixed to mono. Non-finite samples become 0; values are kept in [-1, 1]."""
    block = read_raw(track, start, stop)
    if block.shape[0] == 0:
        return np.zeros(0, dtype=np.float32)
    mono = block.mean(axis=1, dtype=np.float64) if track.channels > 1 else block[:, 0].astype(np.float64)
    mono = np.nan_to_num(mono, nan=0.0, posinf=0.0, neginf=0.0)
    return np.clip(mono, -1.0, 1.0).astype(np.float32)


def _kaiser(u: np.ndarray) -> np.ndarray:
    inside = np.abs(u) <= 1.0
    values = np.zeros_like(u)
    values[inside] = np.i0(KAISER_BETA * np.sqrt(1.0 - u[inside] ** 2)) / np.i0(KAISER_BETA)
    return values


class Resampler:
    """Windowed-sinc resampler from src to dst samples per second.

    Output j is taken at source position j * src / dst. Each output uses 2*half taps; the filter
    cutoff is the lower of the two Nyquist frequencies, and every output's taps are normalised so a
    constant input stays constant.
    """

    def __init__(self, src: int, dst: int):
        if src <= 0 or dst <= 0:
            raise ValueError("sample rates must be positive")
        self.src = src
        self.dst = dst
        self.ratio = src / dst
        self.half = int(math.ceil(ZERO_CROSSINGS * max(1.0, self.ratio)))
        self.cutoff = min(1.0, dst / src)
        self.pad = self.half + 2

    def out_length(self, in_length: int) -> int:
        return -(-in_length * self.dst // self.src)

    def output_range(self, start: int, stop: int) -> tuple[int, int]:
        """Output indices whose source positions fall in [start, stop). Windows partition the output."""
        return -(-start * self.dst // self.src), -(-stop * self.dst // self.src)

    def run(
        self,
        x: np.ndarray,
        x_start: int,
        out_start: int,
        out_stop: int,
        cancel: Optional[threading.Event] = None,
    ) -> np.ndarray:
        """Resamples outputs [out_start, out_stop). x holds source samples from x_start on."""
        result = np.zeros(max(0, out_stop - out_start), dtype=np.float32)
        offsets = np.arange(-self.half + 1, self.half + 1, dtype=np.float64)
        for block_start in range(out_start, out_stop, BLOCK_OUTPUTS):
            if cancel is not None and cancel.is_set():
                raise AppError("stt_cancelled", "Transcription was cancelled. The previous transcript was kept.")
            block_stop = min(block_start + BLOCK_OUTPUTS, out_stop)
            js = np.arange(block_start, block_stop, dtype=np.float64)
            t = js * self.ratio
            base = np.floor(t).astype(np.int64)
            taps = base[:, None] + offsets.astype(np.int64)[None, :]
            distance = taps - t[:, None]
            weights = self.cutoff * np.sinc(self.cutoff * distance) * _kaiser(distance / self.half)
            weights /= weights.sum(axis=1, keepdims=True)
            local = taps - x_start
            valid = (local >= 0) & (local < x.size)
            gathered = x[np.clip(local, 0, x.size - 1)] if x.size else np.zeros(local.shape, dtype=np.float32)
            values = np.where(valid, gathered, 0.0)
            result[block_start - out_start : block_stop - out_start] = (values * weights).sum(axis=1)
        return result


def resample(samples: np.ndarray, src: int, dst: int) -> np.ndarray:
    """Whole-array resample, used by tests and for short signals."""
    if src == dst:
        return samples.astype(np.float32, copy=True)
    resampler = Resampler(src, dst)
    total = samples.size
    return resampler.run(samples.astype(np.float64), 0, 0, resampler.out_length(total))


def windows(frames: int, rate: int, seconds: Optional[int] = None) -> list[tuple[int, int]]:
    step = max(1, rate * (WINDOW_SECONDS if seconds is None else seconds))
    return [(start, min(start + step, frames)) for start in range(0, frames, step)]


@dataclass(frozen=True)
class Window:
    index: int
    count: int
    start: int
    stop: int
    samples: np.ndarray  # 16 kHz mono


def iter_16k_windows(track: WavTrack, cancel: Optional[threading.Event] = None) -> Iterator[Window]:
    """Yields the track as 16 kHz mono windows. Cancellation is checked before each window."""
    resampler = Resampler(track.sample_rate, TARGET_RATE)
    spans = windows(track.frames, track.sample_rate)
    for index, (start, stop) in enumerate(spans):
        if cancel is not None and cancel.is_set():
            raise AppError("stt_cancelled", "Transcription was cancelled. The previous transcript was kept.")
        pad_start = max(0, start - resampler.pad)
        pad_stop = min(track.frames, stop + resampler.pad)
        mono = read_mono(track, pad_start, pad_stop)
        out_start, out_stop = resampler.output_range(start, stop)
        samples = resampler.run(mono, pad_start, out_start, out_stop, cancel)
        yield Window(index, len(spans), start, stop, samples)

