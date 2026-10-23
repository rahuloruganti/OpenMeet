"""Read-only checker for a Python-build meeting audio folder (or two WAV files).

It never writes to, renames or repairs the inputs. It reads the WAV files through numpy memmaps and
validates each timing index with openmeet_py.audio.audio_wav.read_timing (the same rules the app uses).

Checks cover: header and finalization, frame counts against the timing index, peak/RMS/clipping,
silence, dominant frequency of the tone, marker onsets and their spacing, clock drift against the
expected marker spacing and against a wall-clock duration you supply, pause gaps, and whether the
two tracks are distinct.

Examples:
    py\\.venv\\Scripts\\python.exe py\\tools\\verify_recording.py --help
    py\\.venv\\Scripts\\python.exe py\\tools\\verify_recording.py "%APPDATA%\\OpenMeetPy-test\\audio\\<meeting-id>"
    py\\.venv\\Scripts\\python.exe py\\tools\\verify_recording.py D:\\scratch\\mic.wav D:\\scratch\\system.wav --json

Exit codes: 0 no FAIL, 1 at least one FAIL, 2 inputs could not be read or found.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # so openmeet_py imports from backend/

from openmeet_py.api.errors import AppError  # noqa: E402
from openmeet_py.audio.audio_wav import Block, read_timing  # noqa: E402  (read-only use)

# ---- thresholds (each is named so the checklist can quote it) -----------------------------------
SILENT_PEAK = 0.001  # about -60 dBFS, the same tuning knob as the UI's SILENT_PEAK
SILENT_BLOCK_S = 0.1  # silence is counted per 100 ms block
CLIP_LEVEL = 0.999
CLIP_FRACTION_MAX = 1e-4  # more than 0.01 % of samples at full scale is a FAIL
GAP_US = 30_000  # same tolerance as the app's JITTER_US: a larger discontinuity is a real gap
DRIFT_LIMIT_MS = 100.0  # AGENTS.md: 60-minute drift must stay below 100 ms
LONG_RUN_S = 3300.0  # a measured 60-minute verdict needs a run of at least 55 minutes
TARGET_RUN_S = 3600.0
FREQ_TOLERANCE_PCT = 1.0
PAUSE_TOLERANCE_MS = 50.0
WALL_TOLERANCE_MS = 100.0
TRACK_DIFF_MS = 100.0
CHUNK_S = 30.0  # streaming chunk, so 60-minute files need little RAM
DEFAULT_THRESHOLD = 0.02  # normalized marker amplitude (a 0.5 peak tone reads about 0.5)


@dataclass
class WavInfo:
    path: Path
    file_size: int
    fmt_tag: int = 0
    channels: int = 0
    rate: int = 0
    bits: int = 0
    block_align: int = 0
    data_offset: int = 0
    header_data_bytes: int = 0
    riff_declared: int = 0
    fact_frames: Optional[int] = None
    frames: int = 0  # whole frames readable from the file
    finalized: bool = False
    partial_bytes: int = 0
    problems: list[str] = field(default_factory=list)


class WavError(Exception):
    pass


def parse_wav(path: Path) -> WavInfo:
    """Reads the RIFF chunk layout. Raises WavError when the file is not a WAV this build can read."""
    size = path.stat().st_size
    info = WavInfo(path=path, file_size=size)
    with open(path, "rb") as handle:
        head = handle.read(12)
        if len(head) < 12 or head[:4] != b"RIFF" or head[8:12] != b"WAVE":
            raise WavError("not a RIFF/WAVE file (header missing or damaged)")
        info.riff_declared = int.from_bytes(head[4:8], "little")
        at = 12
        fmt_seen = False
        while True:
            handle.seek(at)
            chunk = handle.read(8)
            if len(chunk) < 8:
                raise WavError("no data chunk found (file truncated before the samples)")
            tag, chunk_size = chunk[:4], int.from_bytes(chunk[4:8], "little")
            if tag == b"fmt ":
                body = handle.read(min(chunk_size, 40))
                if len(body) < 16:
                    raise WavError("fmt chunk truncated")
                fmt_tag, channels, rate, _, block_align, bits = (
                    int.from_bytes(body[0:2], "little"),
                    int.from_bytes(body[2:4], "little"),
                    int.from_bytes(body[4:8], "little"),
                    int.from_bytes(body[8:12], "little"),
                    int.from_bytes(body[12:14], "little"),
                    int.from_bytes(body[14:16], "little"),
                )
                if fmt_tag == 0xFFFE and len(body) >= 26:  # WAVE_FORMAT_EXTENSIBLE: real tag in the GUID
                    fmt_tag = int.from_bytes(body[24:26], "little")
                info.fmt_tag, info.channels, info.rate, info.bits, info.block_align = (
                    fmt_tag,
                    channels,
                    rate,
                    bits,
                    block_align,
                )
                fmt_seen = True
            elif tag == b"fact" and chunk_size >= 4:
                info.fact_frames = int.from_bytes(handle.read(4), "little")
            elif tag == b"data":
                if not fmt_seen:
                    raise WavError("data chunk before fmt chunk")
                info.data_offset = at + 8
                info.header_data_bytes = chunk_size
                break
            at += 8 + chunk_size + (chunk_size & 1)
            if at > size:
                raise WavError("a chunk runs past the end of the file (truncated before the samples)")
    supported = {(3, 32), (1, 16)}
    if (info.fmt_tag, info.bits) not in supported:
        raise WavError(f"unsupported sample format (tag {info.fmt_tag}, {info.bits} bits); expected float32 or PCM16")
    if info.channels < 1 or info.rate <= 0 or info.block_align != info.channels * info.bits // 8:
        raise WavError("invalid fmt chunk (channels, rate or block size)")
    available = size - info.data_offset
    frame_bytes = info.block_align
    info.partial_bytes = available % frame_bytes
    if info.header_data_bytes > available:
        info.problems.append(
            f"header declares {info.header_data_bytes} data bytes but only {available} are in the file (truncated)"
        )
        info.frames = available // frame_bytes
    elif info.header_data_bytes == 0:
        info.problems.append("header sizes were never finalized (interrupted write); frames counted from the file")
        info.frames = available // frame_bytes
    else:
        info.frames = info.header_data_bytes // frame_bytes
    if info.partial_bytes:
        info.problems.append(f"{info.partial_bytes} trailing bytes do not form a whole frame and were ignored")
    info.finalized = (
        not info.problems
        and info.riff_declared == size - 8
        and info.header_data_bytes == info.frames * frame_bytes
        and (info.fact_frames is None or info.fact_frames == info.frames)
    )
    return info


def samples(info: WavInfo) -> np.memmap:
    """Raw memmap of (frames, channels). Read-only; the file is never written."""
    dtype = "<f4" if info.fmt_tag == 3 else "<i2"
    return np.memmap(info.path, dtype=dtype, mode="r", offset=info.data_offset, shape=(info.frames, info.channels))


def as_float(raw: np.ndarray, info: WavInfo) -> np.ndarray:
    data = raw.astype(np.float32)
    return data if info.fmt_tag == 3 else data / 32768.0


def mono(raw: np.ndarray, info: WavInfo) -> np.ndarray:
    return as_float(raw, info).mean(axis=1, dtype=np.float64).astype(np.float32)


def _pow2_at_least(value: float) -> int:
    return 1 << max(4, int(math.ceil(math.log2(max(16.0, value)))))


def scan_windows(info: WavInfo, window: int, hop: int, freqs: list[float], rate: int):
    """Yields (window start frames, normalized magnitude at each freq) for Hann windows over the file.

    Normalized: 2 * |X(bin)| / sum(window), so a pure sine of amplitude a reads about a at its bin.
    """
    hann = np.hanning(window)
    wsum = float(hann.sum())
    bins = [int(round(f * window / rate)) for f in freqs]
    bins = [min(max(b, 1), window // 2) for b in bins]
    raw = samples(info)
    per_chunk = max(hop, int(CHUNK_S * rate) // hop * hop)
    for c0 in range(0, info.frames, per_chunk):
        c1 = min(info.frames, c0 + per_chunk + window - hop)
        block = mono(raw[c0:c1], info)
        if len(block) < window:
            break
        count = min(per_chunk // hop, (len(block) - window) // hop + 1)
        if count <= 0:
            break
        views = np.lib.stride_tricks.sliding_window_view(block, window)[::hop][:count]
        magnitude = np.abs(np.fft.rfft(views * hann, axis=1)) * (2.0 / wsum)
        yield c0 + np.arange(count, dtype=np.int64) * hop, magnitude[:, bins]


def dominant_frequencies(info: WavInfo) -> list[float]:
    """Peak frequency (parabolic interpolation) of each non-silent 8192-class window."""
    rate = info.rate
    window = _pow2_at_least(0.17 * rate)
    result: list[float] = []
    hann = np.hanning(window)
    raw = samples(info)
    for c0 in range(0, info.frames - window + 1, window * max(1, int(CHUNK_S * rate) // window)):
        c1 = min(info.frames, c0 + window * max(1, int(CHUNK_S * rate) // window))
        block = mono(raw[c0:c1], info)
        count = (len(block) - window) // window + 1
        if count <= 0:
            continue
        views = np.lib.stride_tricks.sliding_window_view(block, window)[::window][:count]
        magnitude = np.abs(np.fft.rfft(views * hann, axis=1))
        for row in magnitude:
            if row[1:].max() < SILENT_PEAK * window / 4:
                continue  # silence: nothing to measure
            k = int(np.argmax(row[1:-1])) + 1
            a, b, c = np.log(row[k - 1] + 1e-12), np.log(row[k] + 1e-12), np.log(row[k + 1] + 1e-12)
            denominator = a - 2 * b + c
            shift = 0.5 * (a - c) / denominator if denominator != 0 else 0.0
            result.append((k + shift) * rate / window)
    return result


def group_onsets(starts: np.ndarray, window: int, rate: int, hop: int) -> list[float]:
    """Groups consecutive detected windows into bursts; returns each burst's centre time in seconds."""
    if starts.size == 0:
        return []
    breaks = np.flatnonzero(np.diff(starts) > 3 * hop) + 1
    onsets = []
    for group in np.split(starts, breaks):
        onsets.append((int(group[0]) + window / 2) / rate)
    return onsets


def detect_bursts(info: WavInfo, freq: float, threshold: float) -> tuple[list[float], int, int]:
    """Onset times (s) of bursts at freq, with the window and hop used."""
    rate = info.rate
    window = _pow2_at_least(0.02 * rate)
    hop = max(1, int(round(0.01 * rate)))
    hits: list[np.ndarray] = []
    for starts, values in scan_windows(info, window, hop, [freq], rate):
        hits.append(starts[values[:, 0] >= threshold])
    starts = np.concatenate(hits) if hits else np.array([], dtype=np.int64)
    return group_onsets(starts, window, rate, hop), window, hop


def level_stats(info: WavInfo) -> dict[str, Any]:
    raw = samples(info)
    block = max(1, int(round(SILENT_BLOCK_S * info.rate)))
    peak = 0.0
    sumsq = 0.0
    clipped = 0
    silent_blocks = 0
    total_blocks = 0
    rms_blocks: list[float] = []
    chunk = max(block, int(CHUNK_S * info.rate) // block * block)
    for c0 in range(0, info.frames, chunk):
        data = as_float(raw[c0 : min(info.frames, c0 + chunk)], info)
        magnitude = np.abs(data)
        peak = max(peak, float(magnitude.max()))
        sumsq += float(np.square(data, dtype=np.float64).sum())
        clipped += int((magnitude >= CLIP_LEVEL).sum())
        pad = (-len(data)) % block
        padded = np.concatenate([data, np.zeros((pad, data.shape[1]), dtype=data.dtype)]) if pad else data
        blocks = padded.reshape(-1, block, data.shape[1])
        block_peaks = np.abs(blocks).max(axis=(1, 2))
        silent_blocks += int((block_peaks < SILENT_PEAK).sum())
        total_blocks += len(block_peaks)
        mean_sq = np.square(blocks.mean(axis=2)).mean(axis=1)
        rms_blocks.extend(float(v) for v in np.sqrt(mean_sq))
    values = info.frames * info.channels
    rms = math.sqrt(sumsq / values) if values else 0.0
    return {
        "peak": peak,
        "rms": rms,
        "peak_dbfs": round(20 * math.log10(peak), 2) if peak > 0 else None,
        "rms_dbfs": round(20 * math.log10(rms), 2) if rms > 0 else None,
        "clipped_samples": clipped,
        "clipped_fraction": clipped / values if values else 0.0,
        "silent_blocks": silent_blocks,
        "blocks": total_blocks,
        "silent_percent": round(100.0 * silent_blocks / total_blocks, 2) if total_blocks else 100.0,
        "rms_envelope": rms_blocks,
    }


def timing_analysis(info: WavInfo, timing_path: Path) -> dict[str, Any]:
    """Validates the index with the app's rules and measures gaps. Gaps with a generation change are pauses."""
    out: dict[str, Any] = {"path": str(timing_path), "valid": False, "error": None}
    if not timing_path.exists():
        out["error"] = "timing index file is missing"
        return out
    try:
        blocks: list[Block] = read_timing(timing_path, info.rate, info.frames)
    except AppError as error:
        out["error"] = error.message
        return out
    except (OSError, ValueError) as error:
        out["error"] = f"timing index could not be read: {error}"
        return out
    out["valid"] = True
    out["blocks"] = len(blocks)
    out["index_frames"] = blocks[-1].frame_offset + blocks[-1].frames
    pauses: list[dict[str, Any]] = []
    unexplained: list[dict[str, Any]] = []
    for previous, current in zip(blocks, blocks[1:]):
        expected = previous.capture_start_us + previous.frames * 1_000_000 // info.rate
        gap = current.capture_start_us - expected
        if gap <= GAP_US:
            continue
        entry = {
            "file_time_s": round(current.frame_offset / info.rate, 3),
            "duration_ms": round(gap / 1000, 1),
            "generation_from": previous.generation,
            "generation_to": current.generation,
        }
        changed = previous.generation is not None and current.generation is not None and previous.generation != current.generation
        (pauses if changed else unexplained).append(entry)
    out["pauses"] = pauses
    out["unexplained_gaps"] = unexplained
    span = blocks[-1].capture_start_us + blocks[-1].frames * 1_000_000 // info.rate - blocks[0].capture_start_us
    gap_total = sum(p["duration_ms"] for p in pauses + unexplained) * 1000
    active = info.frames * 1_000_000 / info.rate
    out["active_ms"] = round(active / 1000, 1)
    out["index_span_ms"] = round(span / 1000, 1)
    out["consistency_error_ms"] = round((span - gap_total - active) / 1000, 1)
    return out


def marker_fit(onsets: list[float], spacing: float) -> Optional[dict[str, Any]]:
    """Least-squares slope of onset time against marker number. Returns None with fewer than 3 markers."""
    if len(onsets) < 3 or spacing <= 0:
        return None
    t0 = onsets[0]
    k = np.array([round((t - t0) / spacing) for t in onsets], dtype=np.float64)
    t = np.array(onsets, dtype=np.float64)
    if np.ptp(k) == 0:
        return None
    slope, intercept = np.polyfit(k, t, 1)  # seconds per marker
    residuals = (t - (intercept + slope * k)) * 1000
    ppm = (slope / spacing - 1.0) * 1e6
    span_s = float(k[-1] - k[0]) * spacing
    return {
        "markers": len(onsets),
        "expected_spacing_s": spacing,
        "measured_spacing_s": round(float(slope), 6),
        "spacing_error_ppm": round(ppm, 2),
        "max_residual_ms": round(float(np.abs(residuals).max()), 2),
        "run_span_s": round(span_s, 3),
        "measured_drift_ms": round((slope - spacing) * float(k[-1] - k[0]) * 1000, 3),
        "extrapolated_60min_ms": round((slope / spacing - 1.0) * TARGET_RUN_S * 1000, 3),
        "missing_markers": int(k[-1] - k[0] + 1 - len(onsets)),
    }


def analyze_track(path: Path, kind: str, args: argparse.Namespace) -> tuple[dict[str, Any], list[dict[str, Any]], Optional[np.ndarray]]:
    checks: list[dict[str, Any]] = []

    def add(check_id: str, status: str, message: str, **values: Any) -> None:
        checks.append({"id": f"{kind}.{check_id}", "status": status, "message": message, **values})

    result: dict[str, Any] = {"path": str(path), "kind": kind}
    try:
        info = parse_wav(path)
    except (OSError, WavError) as error:
        add("header", "FAIL", f"{error}")
        result["readable"] = False
        return result, checks, None
    result.update(
        {
            "readable": True,
            "format": "float32" if info.fmt_tag == 3 else "pcm16",
            "channels": info.channels,
            "sample_rate": info.rate,
            "frames": info.frames,
            "duration_s": round(info.frames / info.rate, 3),
            "finalized": info.finalized,
            "problems": info.problems,
        }
    )
    add("header", "PASS", f"{result['format']}, {info.channels} ch, {info.rate} Hz, {info.frames} frames")
    add("finalized", "PASS" if info.finalized else "FAIL", "finalized" if info.finalized else "; ".join(info.problems) or "not finalized")
    if info.frames <= 0:
        add("frames", "FAIL", "no audio frames")
        return result, checks, None
    add("frames", "PASS", f"{info.frames} frames = {info.frames / info.rate:.3f} s")

    levels = level_stats(info)
    result.update({k: v for k, v in levels.items() if k != "rms_envelope"})
    silent = levels["peak"] < SILENT_PEAK
    if silent:
        add("silence", "FAIL", f"track is silent (peak {levels['peak']:.6f}); nothing reached this track")
    else:
        add("silence", "INFO", f"{levels['silent_percent']} % of 100 ms blocks are below -60 dBFS")
    add("level", "INFO", f"peak {levels['peak_dbfs']} dBFS, RMS {levels['rms_dbfs']} dBFS")
    clip_ok = levels["clipped_fraction"] <= CLIP_FRACTION_MAX
    add(
        "clipping",
        "PASS" if clip_ok else "FAIL",
        f"{levels['clipped_samples']} samples at full scale ({levels['clipped_fraction'] * 100:.4f} %)",
    )

    timing = timing_analysis(info, Path(args._timing_paths[kind]))
    result["timing"] = timing
    if not timing["valid"]:
        add("timing", "FAIL", timing["error"])
    elif timing["index_frames"] != info.frames:
        add("timing", "FAIL", f"index covers {timing['index_frames']} frames but the WAV has {info.frames}")
    else:
        add("timing", "PASS", f"index valid, {timing['blocks']} blocks, {timing['index_frames']} frames match the WAV")
    if timing["valid"]:
        add("pauses", "INFO", f"{len(timing['pauses'])} pause gap(s) with a generation change", pauses=timing["pauses"])
        ok_gaps = not timing["unexplained_gaps"]
        add(
            "gaps",
            "PASS" if ok_gaps else "FAIL",
            "no gaps without a pause" if ok_gaps else f"{len(timing['unexplained_gaps'])} gap(s) without a pause (possible dropped audio or sleep)",
            gaps=timing["unexplained_gaps"],
        )
        consistent = abs(timing["consistency_error_ms"]) <= PAUSE_TOLERANCE_MS
        add(
            "pause_consistency",
            "PASS" if consistent else "FAIL",
            f"active {timing['active_ms']} ms + gaps match index span {timing['index_span_ms']} ms "
            f"(error {timing['consistency_error_ms']} ms, limit {PAUSE_TOLERANCE_MS:g} ms)",
        )

    if not silent:
        freqs = dominant_frequencies(info)
        if freqs:
            median = statistics.median(freqs)
            near = sum(1 for f in freqs if abs(f - args.tone_freq) <= args.tone_freq * FREQ_TOLERANCE_PCT / 100)
            result["dominant_hz_median"] = round(median, 2)
            result["dominant_match_percent"] = round(100.0 * near / len(freqs), 2)
            if kind == "system":
                ok = abs(median - args.tone_freq) <= args.tone_freq * FREQ_TOLERANCE_PCT / 100
                add("tone", "PASS" if ok else "FAIL", f"median dominant {median:.2f} Hz, expected {args.tone_freq:g} Hz (+/-{FREQ_TOLERANCE_PCT:g} %)")
            else:
                add("tone", "INFO", f"median dominant {median:.2f} Hz over {len(freqs)} windows")
        else:
            add("tone", "FAIL" if kind == "system" else "INFO", "no non-silent windows to measure")

        if args.marker_every > 0 and kind in args.marker_tracks:
            onsets, _, _ = detect_bursts(info, args.marker_freq, args.detect_threshold)
            result["marker_onsets_s"] = [round(t, 3) for t in onsets]
            duration = info.frames / info.rate
            expected = int(duration // args.marker_every)
            if duration >= 2 * args.marker_every:
                ok = abs(len(onsets) - expected) <= 2
                add(
                    "markers",
                    "PASS" if ok else "FAIL",
                    f"{len(onsets)} marker bursts at {args.marker_freq:g} Hz, about {expected} expected",
                )
            else:
                add("markers", "INFO", f"{len(onsets)} marker bursts; run shorter than two marker intervals")
            fit = marker_fit(onsets, args.marker_every)
            if fit:
                result["marker_fit"] = fit
                long_run = fit["run_span_s"] >= LONG_RUN_S
                if long_run:
                    ok = abs(fit["measured_drift_ms"]) < DRIFT_LIMIT_MS
                    add(
                        "drift",
                        "PASS" if ok else "FAIL",
                        f"measured drift {fit['measured_drift_ms']} ms over {fit['run_span_s']:.0f} s "
                        f"({fit['spacing_error_ppm']} ppm; limit {DRIFT_LIMIT_MS:g} ms)",
                    )
                else:
                    extrapolated = fit["extrapolated_60min_ms"]
                    status = "FAIL" if abs(extrapolated) >= DRIFT_LIMIT_MS else "INFO"
                    add(
                        "drift",
                        status,
                        f"run is {fit['run_span_s']:.0f} s, not 55+ minutes: extrapolated 60-minute drift "
                        f"{extrapolated} ms (limit {DRIFT_LIMIT_MS:g} ms); a measured verdict needs a 55+ minute run",
                    )
                add(
                    "marker_jitter",
                    "INFO",
                    f"max residual {fit['max_residual_ms']} ms; {fit['missing_markers']} missing marker(s)",
                )
        if args.paused_freq:
            paused, _, _ = detect_bursts(info, args.paused_freq, args.detect_threshold)
            result["paused_marker_onsets_s"] = [round(t, 3) for t in paused]
            status = "FAIL" if paused else "PASS"
            add(
                "paused_marker",
                status,
                f"{len(paused)} onset(s) of the paused-marker tone at {args.paused_freq:g} Hz"
                + (" (must be 0 unless it was played while recording was active)" if paused else ""),
            )
    if args.wall_seconds is not None:
        drift_ms = (info.frames / info.rate - args.wall_seconds) * 1000
        result["wall_drift_ms"] = round(drift_ms, 2)
        add(
            "wallclock",
            "PASS" if abs(drift_ms) < WALL_TOLERANCE_MS else "FAIL",
            f"track {info.frames / info.rate:.3f} s vs wall clock {args.wall_seconds:.3f} s: {drift_ms:+.1f} ms "
            f"(limit {WALL_TOLERANCE_MS:g} ms)",
        )
    envelope = np.array(levels["rms_envelope"]) if not silent else None
    return result, checks, envelope


def pair_checks(results: dict[str, dict[str, Any]], envelopes: dict[str, Optional[np.ndarray]], paths: dict[str, Path]) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    mic, system = results.get("mic"), results.get("system")
    if not (mic and system and mic.get("readable") and system.get("readable")):
        return checks
    diff = (mic["frames"] / mic["sample_rate"] - system["frames"] / system["sample_rate"]) * 1000
    checks.append(
        {
            "id": "pair.duration",
            "status": "PASS" if abs(diff) < TRACK_DIFF_MS else "FAIL",
            "message": f"track durations differ by {diff:+.1f} ms (limit {TRACK_DIFF_MS:g} ms)",
        }
    )
    identical = _identical(paths["mic"], paths["system"], mic, system)
    checks.append(
        {
            "id": "pair.distinct",
            "status": "FAIL" if identical else "PASS",
            "message": "both tracks hold the same samples (one device was duplicated)" if identical else "tracks hold different samples",
        }
    )
    a, b = envelopes.get("mic"), envelopes.get("system")
    if a is not None and b is not None and len(a) > 2 and len(b) > 2:
        n = min(len(a), len(b))
        x, y = a[:n] - a[:n].mean(), b[:n] - b[:n].mean()
        denominator = math.sqrt(float((x * x).sum()) * float((y * y).sum()))
        corr = float((x * y).sum() / denominator) if denominator > 0 else 0.0
        checks.append(
            {
                "id": "pair.envelope_correlation",
                "status": "INFO",
                "message": f"100 ms RMS envelope correlation {corr:+.3f} (speaker bleed into the mic raises it)",
                "value": round(corr, 4),
            }
        )
    return checks


def _identical(mic_path: Path, system_path: Path, mic: dict[str, Any], system: dict[str, Any]) -> bool:
    count = min(mic["frames"], system["frames"], int(5 * mic["sample_rate"]))
    if count < mic["sample_rate"]:
        return False
    mic_info, system_info = parse_wav(mic_path), parse_wav(system_path)
    a = mono(samples(mic_info)[:count], mic_info)
    b = mono(samples(system_info)[:count], system_info)
    return float(np.abs(a - b).max()) < 1e-6 and float(np.abs(a).max()) > SILENT_PEAK


def resolve_paths(args: argparse.Namespace) -> dict[str, Path]:
    if args.target is not None:
        folder = Path(args.target)
        if folder.is_dir():
            return {"mic": folder / "mic.wav", "system": folder / "system.wav"}
        raise SystemExit(f"Not a folder: {folder}. Pass a folder, or use --mic and --system.")
    if args.mic is None and args.system is None:
        raise SystemExit("Pass a meeting folder, or --mic FILE and/or --system FILE.")
    paths: dict[str, Path] = {}
    if args.mic:
        paths["mic"] = Path(args.mic)
    if args.system:
        paths["system"] = Path(args.system)
    return paths


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Read-only check of a meeting's mic.wav and system.wav and their timing indexes. "
            "Never modifies the inputs."
        ),
        epilog=(
            "Exit codes: 0 no FAIL, 1 at least one FAIL, 2 inputs missing or unreadable. "
            "Marker options must match make_test_audio.py (default 1000 Hz every 60 s)."
        ),
    )
    parser.add_argument("target", nargs="?", help="meeting audio folder containing mic.wav and system.wav")
    parser.add_argument("--mic", help="microphone WAV (instead of a folder)")
    parser.add_argument("--system", help="system-audio WAV (instead of a folder)")
    parser.add_argument("--tone-freq", type=float, default=440.0, help="expected tone on the system track, Hz (default 440)")
    parser.add_argument("--marker-freq", type=float, default=1000.0, help="marker burst frequency, Hz (default 1000)")
    parser.add_argument(
        "--marker-every", type=float, default=60.0, help="marker spacing in seconds; 0 skips marker checks (default 60)"
    )
    parser.add_argument(
        "--marker-tracks",
        default="system",
        help="comma-separated tracks that carry the markers and get marker and drift checks (default system)",
    )
    parser.add_argument("--paused-freq", type=float, default=None, help="paused-marker tone frequency; any onset is reported")
    parser.add_argument(
        "--detect-threshold", type=float, default=DEFAULT_THRESHOLD, help="normalized burst threshold (default 0.02)"
    )
    parser.add_argument(
        "--wall-seconds",
        type=float,
        default=None,
        help="wall-clock duration of the run in seconds, e.g. from the meeting's started_at and ended_at (ms precision)",
    )
    parser.add_argument("--json", action="store_true", help="print JSON instead of text")
    args = parser.parse_args(argv)
    if args.tone_freq <= 0 or args.marker_freq <= 0:
        parser.error("frequencies must be above 0")
    if args.marker_every < 0:
        parser.error("--marker-every must be 0 or above")
    args.marker_tracks = [t.strip() for t in args.marker_tracks.split(",") if t.strip()]
    if not set(args.marker_tracks) <= {"mic", "system"}:
        parser.error("--marker-tracks takes mic, system or both")
    return args


def run(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    paths = resolve_paths(args)
    args._timing_paths = {kind: str(path.with_name(path.stem + ".timing.jsonl")) for kind, path in paths.items()}
    results: dict[str, dict[str, Any]] = {}
    checks: list[dict[str, Any]] = []
    envelopes: dict[str, Optional[np.ndarray]] = {}
    for kind, path in paths.items():
        if not path.is_file():
            results[kind] = {"path": str(path), "kind": kind, "readable": False}
            checks.append({"id": f"{kind}.header", "status": "FAIL", "message": "file not found"})
            continue
        result, track_checks, envelope = analyze_track(path, kind, args)
        results[kind] = result
        checks.extend(track_checks)
        envelopes[kind] = envelope
    checks.extend(pair_checks(results, envelopes, paths))
    counts = {status: sum(1 for c in checks if c["status"] == status) for status in ("PASS", "FAIL", "INFO")}
    overall = "FAIL" if counts["FAIL"] else ("PASS" if counts["PASS"] else "INFO")
    unreadable = not any(r.get("readable") for r in results.values())
    report = {
        "tool": "verify_recording",
        "target": str(args.target or {k: str(v) for k, v in paths.items()}),
        "parameters": {
            "tone_freq": args.tone_freq,
            "marker_freq": args.marker_freq,
            "marker_every": args.marker_every,
            "paused_freq": args.paused_freq,
            "detect_threshold": args.detect_threshold,
            "marker_tracks": args.marker_tracks,
            "wall_seconds": args.wall_seconds,
        },
        "tracks": results,
        "checks": checks,
        "counts": counts,
        "overall": overall,
    }
    return report, (2 if unreadable else (1 if counts["FAIL"] else 0))


def print_text(report: dict[str, Any]) -> None:
    for kind, track in report["tracks"].items():
        if track.get("readable"):
            print(
                f"{kind}: {track['path']}\n  {track['format']}, {track['channels']} ch, {track['sample_rate']} Hz, "
                f"{track['frames']} frames, {track['duration_s']} s, finalized={track['finalized']}, "
                f"peak {track.get('peak_dbfs')} dBFS"
            )
        else:
            print(f"{kind}: {track['path']}\n  not readable")
    for check in report["checks"]:
        print(f"[{check['status']}] {check['id']}: {check['message']}")
    counts = report["counts"]
    print(f"OVERALL: {report['overall']} ({counts['PASS']} pass, {counts['FAIL']} fail, {counts['INFO']} info)")


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    try:
        report, code = run(args)
    except SystemExit as error:
        print(error, file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(report, indent=2, default=str))
    else:
        print_text(report)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
