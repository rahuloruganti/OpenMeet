"""Synthetic recordings for speech tests: float WAV tracks and timing indexes, written as the recorder does.

Every sample is generated here (a sine tone). Nothing is recorded from a device and no fixture is real
speech.
"""

from __future__ import annotations

import math
import struct
import uuid
from array import array
from pathlib import Path
from typing import Any, Optional, Sequence

from openmeet_py import audio_wav
from openmeet_py.context import now


def tone(frames: int, rate: int, freq: float = 440.0, amp: float = 0.25) -> array:
    step = 2 * math.pi * freq / rate
    return array("f", (amp * math.sin(step * i) for i in range(frames)))


def write_track(
    folder: Path,
    kind: str,
    *,
    rate: int = 16000,
    channels: int = 1,
    blocks: Optional[Sequence[tuple[int, int, int]]] = None,
    finalize: bool = True,
    freq: float = 440.0,
) -> dict[str, Any]:
    """Writes folder/<kind>.wav and its timing index. blocks: (frames, capture_start_us, generation)."""
    folder.mkdir(parents=True, exist_ok=True)
    if blocks is None:
        blocks = [(rate * 3, 1_000_000, 0)]
    total = sum(frames for frames, _, _ in blocks)
    wav_path = folder / f"{kind}.wav"
    timing_path = folder / f"{kind}.timing.jsonl"
    mono = tone(total, rate, freq)
    interleaved = array("f")
    for sample in mono:
        interleaved.extend([sample] * channels)
    writer = audio_wav.WavFile(wav_path, rate, channels)
    writer.write(interleaved.tobytes())
    if finalize:
        assert writer.finalize()
    else:
        writer.checkpoint()
        writer.close()
    lines = []
    offset = 0
    for frames, start_us, generation in blocks:
        lines.append(audio_wav.timing_line(offset, frames, start_us, generation))
        offset += frames
    timing_path.write_text("".join(lines), encoding="ascii")
    return {
        "kind": kind,
        "path": str(wav_path),
        "timing_path": str(timing_path),
        "device_name": "Synthetic",
        "sample_rate": rate,
        "channels": channels,
        "frames": total,
        "dropped_frames": 0,
        "finalized": 1 if finalize else 0,
    }


def add_meeting(ctx: Any, tracks: Sequence[dict[str, Any]] = (), status: str = "stopped") -> str:
    """Inserts a desktop meeting with the given track rows. Returns its id."""
    meeting_id = str(uuid.uuid4())
    db = ctx.store.db
    db.execute(
        "INSERT INTO meetings(id, title, started_at, source, status) VALUES (?1, ?2, ?3, 'desktop', ?4)",
        (meeting_id, "Fictional meeting", now(), status),
    )
    db.execute("INSERT INTO notes(meeting_id) VALUES (?1)", (meeting_id,))
    for track in tracks:
        db.execute(
            "INSERT INTO tracks(meeting_id, kind, path, timing_path, device_name, sample_rate, channels, "
            "frames, dropped_frames, finalized) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            (
                meeting_id,
                track["kind"],
                track["path"],
                track["timing_path"],
                track["device_name"],
                track["sample_rate"],
                track["channels"],
                track["frames"],
                track["dropped_frames"],
                track["finalized"],
            ),
        )
    return meeting_id


def recording(ctx: Any, *, status: str = "stopped", kinds: Sequence[str] = ("mic", "system")) -> str:
    """A finalized two-track meeting: 3 s per track, one pause-free block, synthetic tones."""
    folder = ctx.store.data_dir / "audio" / str(uuid.uuid4())
    rows = [write_track(folder, kind, freq=440.0 if kind == "mic" else 660.0) for kind in kinds]
    return add_meeting(ctx, rows, status=status)


def wav_header_bytes(path: Path) -> bytes:
    with open(path, "rb") as handle:
        return handle.read(64)


def le_u32(value: int) -> bytes:
    return struct.pack("<I", value)
