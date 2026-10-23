"""WAV files, timing indexes and their validation for the Python build's capture.

The file rules are these: append-only track writing, a header repair for interrupted files, one
index line per block, and the mapping from a session time to a position in the file. Nothing here
touches audio devices.

WAV layout: 32-bit IEEE float (format tag 3), a fact chunk, and the data chunk LAST. The RIFF and
data sizes are placeholders until finalize, so an interrupted file is recognisable and repairable.
"""

from __future__ import annotations

import json
import math
import os
import struct
import tempfile
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Optional

from openmeet_py.api.errors import AppError

HEADER_SIZE = 58
BYTES_PER_SAMPLE = 4
# Classic WAV ends at 4 GiB; stop a little early so the size fields stay valid.
MAX_FILE_BYTES = 2**32 - 4096
MAX_INDEX_BYTES = 64 * 1024 * 1024
MAX_LINE_BYTES = 1024
JITTER_US = 30_000  # packet stamps jitter by about 11 ms on real devices
U64_MAX = 2**64 - 1
I64_MAX = 2**63 - 1


def timing_line(frame_offset: int, frames: int, capture_start_us: int, generation: int) -> str:
    """One index line: four integers, no spaces, keys in this fixed order, then a newline."""
    return (
        f'{{"frame_offset":{frame_offset},"frames":{frames},'
        f'"capture_start_us":{capture_start_us},"generation":{generation}}}\n'
    )


# ---- WAV writing -----------------------------------------------------------


class WavFile:
    """Writes one float WAV. Created exclusively; never truncates an existing file."""

    def __init__(self, path: Path, rate: int, channels: int):
        self.rate = rate
        self.channels = channels
        self.block_align = channels * BYTES_PER_SAMPLE
        self.frames = 0
        self.data_bytes = 0
        self._fh: Optional[BinaryIO] = open(path, "xb")
        try:
            self._fh.write(self._header(0, 0))
            self._fh.flush()
        except BaseException:
            self.close()
            raise

    def _header(self, frames: int, data_bytes: int) -> bytes:
        fmt = struct.pack(
            "<HHIIHHH",
            3,  # WAVE_FORMAT_IEEE_FLOAT
            self.channels,
            self.rate,
            self.rate * self.block_align,
            self.block_align,
            32,
            0,  # cbSize
        )
        return (
            b"RIFF"
            + struct.pack("<I", 50 + data_bytes)
            + b"WAVE"
            + b"fmt "
            + struct.pack("<I", len(fmt))
            + fmt
            + b"fact"
            + struct.pack("<II", 4, frames)
            + b"data"
            + struct.pack("<I", data_bytes)
        )

    def write(self, data: bytes) -> None:
        if self._fh is None:
            raise OSError("The audio file is closed.")
        if self.data_bytes + len(data) + HEADER_SIZE > MAX_FILE_BYTES:
            raise OSError("WAV size limit reached")
        self._fh.write(data)
        self.data_bytes += len(data)
        self.frames += len(data) // self.block_align

    def checkpoint(self, sync: bool = False) -> None:
        if self._fh is None:
            return
        self._fh.flush()
        if sync:
            os.fsync(self._fh.fileno())

    def finalize(self) -> bool:
        """Patches the sizes, fsyncs and closes. Returns False if anything failed."""
        if self._fh is None:
            return False
        ok = True
        try:
            self._fh.seek(0)
            self._fh.write(self._header(self.frames, self.data_bytes))
            self._fh.flush()
            os.fsync(self._fh.fileno())
        except OSError:
            ok = False
        self.close()
        return ok

    def close(self) -> None:
        if self._fh is not None:
            try:
                self._fh.close()
            except OSError:
                pass
            self._fh = None


# ---- timing index ------------------------------------------------------------


@dataclass
class Block:
    frame_offset: int
    frames: int
    capture_start_us: int
    generation: Optional[int] = None


def _timing_error(message: str) -> AppError:
    return AppError("audio_timing", message)


def _unreadable() -> AppError:
    return _timing_error(
        "The audio timing index could not be read. Originals and previous transcripts are unchanged."
    )


def _uint(value: object) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= U64_MAX:
        return None
    return value


def read_timing(path: Path, sample_rate: int, frames: int) -> list[Block]:
    """Validates a timing index against its track. Never edits the file."""
    if sample_rate <= 0 or frames <= 0:
        raise _timing_error("The recording has invalid timing metadata.")
    try:
        if os.stat(path).st_size > MAX_INDEX_BYTES:
            raise _timing_error(
                "The audio timing index exceeds the supported size. Originals and previous "
                "transcripts are unchanged."
            )
        handle = open(path, "rb")
    except FileNotFoundError as error:
        raise _unreadable() from error
    except OSError as error:
        raise _unreadable() from error

    malformed = _timing_error(
        "The audio timing index is malformed. Originals and previous transcripts are unchanged."
    )
    mismatch = _timing_error(
        "The audio timing index does not match the recording. Originals and previous transcripts "
        "are unchanged."
    )
    blocks: list[Block] = []
    offset = 0
    consumed = 0
    previous_raw_start = 0

    def duration(count: int) -> int:
        return count * 1_000_000 // sample_rate

    with handle:
        while True:
            try:
                line = handle.readline(MAX_LINE_BYTES + 1)
            except OSError as error:
                raise _unreadable() from error
            if not line:
                break
            consumed += len(line)
            if consumed > MAX_INDEX_BYTES:
                raise _timing_error("The audio timing index exceeds the supported size.")
            if len(line) > MAX_LINE_BYTES:
                raise malformed
            try:
                raw = json.loads(line)
            except ValueError as error:
                raise malformed from error
            if not isinstance(raw, dict):
                raise malformed
            frame_offset = _uint(raw.get("frame_offset"))
            block_frames = _uint(raw.get("frames"))
            raw_start = _uint(raw.get("capture_start_us"))
            generation = raw.get("generation")
            if frame_offset is None or block_frames is None or raw_start is None:
                raise malformed
            if generation is not None and _uint(generation) is None:
                raise malformed
            if block_frames * 1_000_000 > U64_MAX:
                raise _timing_error("Invalid audio timing range.")
            end_us = raw_start + duration(block_frames)
            if end_us > U64_MAX:
                raise _timing_error("Invalid audio timing range.")
            if frame_offset != offset or block_frames == 0 or end_us // 1000 > I64_MAX:
                raise mismatch
            start = raw_start
            if blocks:
                previous = blocks[-1]
                previous_end = previous.capture_start_us + duration(previous.frames)
                # Judge overlap on the raw stamps, then lay jittered packets end to end. Real gaps stay.
                if raw_start + JITTER_US < previous_raw_start + duration(previous.frames):
                    raise _timing_error(
                        "Audio timestamps overlap or move backwards. Originals and previous "
                        "transcripts are unchanged."
                    )
                if raw_start <= previous_end + JITTER_US:
                    start = previous_end
            previous_raw_start = raw_start
            offset += block_frames
            blocks.append(
                Block(frame_offset, block_frames, start, None if generation is None else int(generation))
            )
    if not blocks or offset != frames:
        raise _timing_error(
            "The audio timing index is incomplete. Originals and previous transcripts are unchanged."
        )
    return blocks


def file_ms(blocks: list[Block], sample_rate: int, session_ms: int) -> int:
    """Maps a session time to a position in the WAV, honouring pause gaps.

    A time inside a pause gap lands on the first frame recorded after it.
    """
    if not blocks or sample_rate <= 0:
        return max(session_ms, 0)
    session_us = max(session_ms, 0) * 1000
    lo, hi = 0, len(blocks)
    while lo < hi:  # partition point: blocks whose capture_start_us <= session_us
        mid = (lo + hi) // 2
        if blocks[mid].capture_start_us <= session_us:
            lo = mid + 1
        else:
            hi = mid
    if lo == 0:
        return 0
    block = blocks[lo - 1]
    within = min((session_us - block.capture_start_us) * sample_rate // 1_000_000, block.frames)
    return (block.frame_offset + within) * 1000 // sample_rate


# ---- samples -------------------------------------------------------------------


def measure(data: bytes) -> tuple[float, Optional[bytes]]:
    """Peak of one block of float32 samples, plus cleaned bytes when the block needed cleaning.

    Non-finite samples become 0 and values are clamped to [-1, 1].
    The fast path (clean input) returns None for the bytes, so the caller keeps the original.
    """
    samples = array("f")
    samples.frombytes(data)
    if math.isfinite(sum(samples)):
        peak = max(map(abs, samples), default=0.0)
        if peak <= 1.0:
            return float(peak), None
    cleaned = array(
        "f",
        (0.0 if not math.isfinite(v) else min(1.0, max(-1.0, v)) for v in samples),
    )
    return float(max(map(abs, cleaned), default=0.0)), cleaned.tobytes()


# ---- repair ----------------------------------------------------------------------


def repair_wav(original: Path, copy: Path) -> int:
    """Writes a playable copy of a WAV whose header was never finalized.

    Sizes come from the actual file length, truncated to whole frames. The original is only read.
    Assumes the data chunk is the last chunk, as this module writes it. Returns frames in the copy.
    """

    def invalid() -> AppError:
        return AppError("audio", "Audio capture: The audio file header is unreadable. Nothing was recovered.")

    with open(original, "rb") as source:
        length = os.fstat(source.fileno()).st_size
        header = source.read(min(length, 64 * 1024))
        if len(header) < 12 or header[0:4] != b"RIFF" or header[8:12] != b"WAVE":
            raise invalid()
        at = 12
        block_align = 0
        while True:
            if at + 8 > len(header):
                raise invalid()
            size = struct.unpack_from("<I", header, at + 4)[0]
            tag = header[at : at + 4]
            if tag == b"data":
                data_start = at + 8
                break
            if tag == b"fmt " and size >= 16 and at + 22 <= len(header):
                block_align = struct.unpack_from("<H", header, at + 20)[0]
            at += 8 + size + size % 2
        if block_align == 0:
            raise invalid()
        available = min(length - data_start, 2**32 - 1 - data_start)
        data_len = available // block_align * block_align
        pad = data_len % 2
        fixed = bytearray(header[:data_start])
        struct.pack_into("<I", fixed, 4, data_start + data_len + pad - 8)
        struct.pack_into("<I", fixed, data_start - 4, data_len)

        folder = copy.parent
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(dir=folder, delete=False, suffix=".tmp") as out:
                temp_path = Path(out.name)
                out.write(bytes(fixed))
                source.seek(data_start)
                remaining = data_len
                while remaining:
                    chunk = source.read(min(remaining, 1024 * 1024))
                    if not chunk:
                        raise invalid()
                    out.write(chunk)
                    remaining -= len(chunk)
                out.write(b"\0" * pad)
                out.flush()
                os.fsync(out.fileno())
            try:
                os.link(temp_path, copy)  # fails if the copy exists: never overwrite
            except FileExistsError as error:
                raise AppError(
                    "recovery_exists",
                    f"A recovered copy already exists at {copy}. Nothing was overwritten.",
                ) from error
        finally:
            if temp_path is not None:
                try:
                    temp_path.unlink()
                except OSError:
                    pass
    return data_len // block_align
