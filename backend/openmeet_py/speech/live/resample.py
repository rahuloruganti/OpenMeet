"""One lane's continuous downmix and resample to 16 kHz mono.

The audio arrives in blocks of whatever size the capture device produced. Feeding each block
through a resampler of its own would leave a gap of up to one filter length at every boundary, so
this keeps the source tail between blocks: output sample j is always taken at source position
j * rate / 16000, the same position it would have in a single whole-file resample. Only outputs
whose filter taps are all present are produced, and the tail is emitted by finish().
"""

from __future__ import annotations

import numpy as np

from openmeet_py.speech.live.contract import TARGET_RATE
from openmeet_py.speech.transcription import audio_read


class LaneConverter:
    """float32 interleaved device bytes in, float32 mono 16 kHz samples out, block after block."""

    def __init__(self, rate: int, channels: int, target: int = TARGET_RATE):
        self.rate = max(1, int(rate))
        self.channels = max(1, int(channels))
        self.target = max(1, int(target))
        self._resampler = audio_read.Resampler(self.rate, self.target) if self.rate != self.target else None
        self._buffer = np.zeros(0, dtype=np.float64)
        self._base = 0  # absolute source index of self._buffer[0]
        self._total = 0  # source samples received
        self._next_out = 0  # next output sample index
        self._finished = False

    def push(self, data: bytes, frames: int) -> np.ndarray:
        """Samples for the blocks received so far. Returns float32 16 kHz mono, possibly empty."""
        mono = self._mono(data, frames)
        if mono.size == 0:
            return np.zeros(0, dtype=np.float32)
        if self._resampler is None:
            self._total += int(mono.size)
            out = mono.astype(np.float32, copy=False)
            self._next_out += int(out.size)
            return out
        self._buffer = np.concatenate([self._buffer, mono])
        self._total += int(mono.size)
        stop = self._ready_out()
        if stop <= self._next_out:
            return np.zeros(0, dtype=np.float32)
        out = self._resampler.run(self._buffer, self._base, self._next_out, stop)
        self._next_out = stop
        self._trim()
        return np.ascontiguousarray(out, dtype=np.float32)

    def finish(self) -> np.ndarray:
        """The remaining samples, with the missing filter tail treated as silence. Safe to call once."""
        if self._finished or self._resampler is None:
            self._finished = True
            return np.zeros(0, dtype=np.float32)
        self._finished = True
        stop = self._resampler.out_length(self._total)
        if stop <= self._next_out:
            return np.zeros(0, dtype=np.float32)
        out = self._resampler.run(self._buffer, self._base, self._next_out, stop)
        self._next_out = stop
        self._trim()
        return np.ascontiguousarray(out, dtype=np.float32)

    def _mono(self, data: bytes, frames: int) -> np.ndarray:
        raw = np.frombuffer(data, dtype="<f4")
        usable = min(raw.size, max(0, int(frames)) * self.channels)
        if usable <= 0:
            return np.zeros(0, dtype=np.float64)
        usable -= usable % self.channels
        block = raw[:usable].reshape(-1, self.channels)
        mono = block.mean(axis=1, dtype=np.float64) if self.channels > 1 else block[:, 0].astype(np.float64)
        mono = np.nan_to_num(mono, nan=0.0, posinf=0.0, neginf=0.0)
        return np.clip(mono, -1.0, 1.0)

    def _ready_out(self) -> int:
        """How many outputs have every tap available: floor(j * ratio) must not pass total - half."""
        total = self._total - self._resampler.half
        if total < 0:
            return 0
        limit = int(total / self._resampler.ratio) + 1
        return min(self._resampler.out_length(self._total), max(0, limit))

    def _trim(self) -> None:
        """Drops source samples no later output can need, so a long recording stays bounded."""
        need = int(self._next_out * self._resampler.ratio) - self._resampler.half - 2
        cut = min(max(need - self._base, 0), self._buffer.size)
        if cut > 0:
            self._buffer = self._buffer[cut:]
            self._base += cut
