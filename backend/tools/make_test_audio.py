"""Writes a synthetic test WAV: a steady sine tone with a short marker burst every N seconds.

Only WRITES a file. It never plays audio and never opens a device. Play the file with any media
player, for example a browser or Windows Media Player, while OpenMeet records.

Examples:
    py\\.venv\\Scripts\\python.exe py\\tools\\make_test_audio.py --help
    py\\.venv\\Scripts\\python.exe py\\tools\\make_test_audio.py C:\\scratch\\tone440.wav
    py\\.venv\\Scripts\\python.exe py\\tools\\make_test_audio.py C:\\scratch\\paused1000.wav --freq 1000 --marker-every 0 --duration 120
    py\\.venv\\Scripts\\python.exe py\\tools\\make_test_audio.py C:\\scratch\\drift.wav --duration 3600 --marker-drift-ppm 200

Refuses to overwrite an existing file. Delete the old file yourself before regenerating it.
"""

from __future__ import annotations

import argparse
import math
import os
import struct
import sys
from pathlib import Path
from typing import Optional

import numpy as np

MAX_DURATION_S = 65 * 60  # the owner's upper bound
CHUNK_FRAMES = 48_000  # generated and written one second at a time, so long files need little RAM
MARKER_FADE_S = 0.005  # short fade in and out, so the burst does not click


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Write a synthetic WAV: a sine tone plus a short marker burst every N seconds. "
            "Only writes the file; the owner plays it with a media player."
        ),
        epilog=(
            "Use --marker-every 0 for a plain tone (for example, the paused-marker variant with a "
            "different --freq). Refuses to overwrite an existing file."
        ),
    )
    parser.add_argument("out", type=Path, help="output WAV path (must not exist)")
    parser.add_argument("--freq", type=float, default=440.0, help="tone frequency in Hz (default 440)")
    parser.add_argument(
        "--marker-freq", type=float, default=1000.0, help="marker burst frequency in Hz (default 1000)"
    )
    parser.add_argument(
        "--marker-every",
        type=float,
        default=60.0,
        help="seconds between marker bursts; 0 disables markers (default 60). Markers start at N s.",
    )
    parser.add_argument("--marker-ms", type=float, default=150.0, help="marker burst length in ms (default 150)")
    parser.add_argument("--duration", type=float, default=300.0, help=f"length in seconds (default 300, max {MAX_DURATION_S})")
    parser.add_argument("--rate", type=int, default=48000, help="sample rate in Hz (default 48000)")
    parser.add_argument("--channels", type=int, choices=(1, 2), default=2, help="1 or 2 (default 2)")
    parser.add_argument(
        "--format",
        choices=("float32", "pcm16"),
        default="float32",
        help="float32 (format tag 3, like the app) or pcm16 (default float32)",
    )
    parser.add_argument("--amplitude", type=float, default=0.25, help="tone peak, 0-1 (default 0.25 = -12 dBFS)")
    parser.add_argument("--marker-amplitude", type=float, default=0.5, help="marker peak, 0-1 (default 0.5)")
    parser.add_argument(
        "--marker-drift-ppm",
        type=float,
        default=0.0,
        help=(
            "test-only: place marker k at k*N*(1+ppm/1e6) seconds, to inject a known clock error for "
            "checking verify_recording.py (default 0)"
        ),
    )
    args = parser.parse_args(argv)
    if not 0 < args.duration <= MAX_DURATION_S:
        parser.error(f"--duration must be above 0 and at most {MAX_DURATION_S} seconds")
    if args.marker_every < 0 or (0 < args.marker_every < 0.5):
        parser.error("--marker-every must be 0 (none) or at least 0.5 seconds")
    if not 8000 <= args.rate <= 192000:
        parser.error("--rate must be between 8000 and 192000 Hz")
    if not 0 < args.freq < args.rate / 2 or not 0 < args.marker_freq < args.rate / 2:
        parser.error("frequencies must be above 0 and below half the sample rate")
    if not 0 <= args.amplitude <= 1 or not 0 <= args.marker_amplitude <= 1:
        parser.error("amplitudes must be between 0 and 1")
    if not 0 < args.marker_ms < 1000:
        parser.error("--marker-ms must be between 0 and 1000")
    return args


def marker_starts(duration: float, every: float, drift_ppm: float) -> list[tuple[int, float]]:
    """(index, start in frames) for each marker k*N with k >= 1 that fits in the file. Index k is 1-based."""
    starts = []
    if every <= 0:
        return starts
    k = 1
    while k * every < duration:
        starts.append((k, k * every * (1 + drift_ppm / 1e6)))
        k += 1
    return starts


def generate(args: argparse.Namespace):  # yields float32 arrays of shape (frames, channels)
    rate = args.rate
    total = int(round(args.duration * rate))
    marker_len = int(round(args.marker_ms / 1000 * rate))
    envelope = np.ones(marker_len, dtype=np.float64)
    fade = min(int(round(MARKER_FADE_S * rate)), marker_len // 2)
    if fade > 0:
        ramp = np.linspace(0.0, 1.0, fade)
        envelope[:fade] = ramp
        envelope[marker_len - fade :] = ramp[::-1]
    markers = [(int(round(start * rate)), start) for _, start in marker_starts(args.duration, args.marker_every, args.marker_drift_ppm)]
    m_index = 0
    for c0 in range(0, total, CHUNK_FRAMES):
        c1 = min(total, c0 + CHUNK_FRAMES)
        n = np.arange(c0, c1, dtype=np.float64)
        mono = args.amplitude * np.sin(2 * math.pi * args.freq * n / rate)
        while m_index < len(markers) and markers[m_index][0] < c1:
            s0 = markers[m_index][0]
            if s0 + marker_len > c0:
                lo = max(s0, c0)
                hi = min(s0 + marker_len, c1)
                local = np.arange(lo, hi, dtype=np.float64) - s0
                burst = args.marker_amplitude * envelope[(lo - s0) : (hi - s0)] * np.sin(
                    2 * math.pi * args.marker_freq * local / rate
                )
                mono[lo - c0 : hi - c0] += burst
            if s0 + marker_len > c1:
                break  # the burst continues into the next chunk
            m_index += 1
        block = np.clip(mono, -1.0, 1.0).astype(np.float32)
        yield np.repeat(block[:, None], args.channels, axis=1)


def write_wav(path: Path, args: argparse.Namespace) -> int:
    """Writes the file with exclusive creation. Returns frames written."""
    is_float = args.format == "float32"
    fmt = 3 if is_float else 1
    bits = 32 if is_float else 16
    block_align = args.channels * bits // 8
    frames = int(round(args.duration * args.rate))
    data_bytes = frames * block_align
    fmt_body = struct.pack("<HHIIHH", fmt, args.channels, args.rate, args.rate * block_align, block_align, bits)
    if is_float:
        fmt_body += struct.pack("<H", 0)  # cbSize, as the app writes
        fmt_chunk = b"fmt " + struct.pack("<I", len(fmt_body)) + fmt_body
        fact = b"fact" + struct.pack("<II", 4, frames)
    else:
        fmt_chunk = b"fmt " + struct.pack("<I", len(fmt_body)) + fmt_body
        fact = b""
    riff_size = 4 + len(fmt_chunk) + len(fact) + 8 + data_bytes
    head = b"RIFF" + struct.pack("<I", riff_size) + b"WAVE" + fmt_chunk + fact + b"data" + struct.pack("<I", data_bytes)
    with open(path, "xb") as out:  # never truncates an existing file
        out.write(head)
        written = 0
        for block in generate(args):
            if args.format == "float32":
                out.write(block.astype("<f4").tobytes())
            else:
                out.write((np.clip(block, -1, 1) * 32767).astype("<i2").tobytes())
            written += block.shape[0]
        out.flush()
        os.fsync(out.fileno())
    if written != frames:
        raise RuntimeError(f"internal error: wrote {written} frames, expected {frames}")
    return frames


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    if args.out.exists():
        print(f"Refusing to overwrite {args.out}. Delete it yourself first.", file=sys.stderr)
        return 2
    try:
        frames = write_wav(args.out, args)
    except FileExistsError:
        print(f"Refusing to overwrite {args.out}.", file=sys.stderr)
        return 2
    markers = len(marker_starts(args.duration, args.marker_every, args.marker_drift_ppm))
    print(
        f"Wrote {args.out}: {frames} frames, {args.duration:g} s, {args.rate} Hz, {args.channels} ch, "
        f"{args.format}, tone {args.freq:g} Hz, {markers} marker bursts"
        + (f" every {args.marker_every:g} s" if markers else "")
        + "."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
