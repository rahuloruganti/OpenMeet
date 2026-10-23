"""Local transcription of finalized tracks: window decoding, session-time mapping and the merge.

Covers session_ms (the end flag and clamping rules), parse_output (marker filtering), run_tracks
(per-track reads, merge and sort) and track_file_ms's neighbours. Timing comes from the pause index
written by the recorder, so a segment is placed on the session clock that skips paused time.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any, Callable, Optional

from openmeet_py.api.errors import AppError
from openmeet_py.audio import audio_wav
from openmeet_py.domain.transcript_edits import timed
from openmeet_py.speech.transcription import audio_read
from openmeet_py.speech.transcription.engine import Engine

log = logging.getLogger("openmeet_py")
INT64_MAX = 2**63 - 1
Segment = dict[str, Any]
Report = Callable[[str, int], None]


def cancelled() -> AppError:
    return AppError("stt_cancelled", "Transcription was cancelled. The previous transcript was kept.")


def session_at_frame(index: list[audio_wav.Block], rate: int, frame: int, end: bool) -> int:
    """Session milliseconds for a frame in the track file, after the ms-to-frame step.

    end=False maps a segment start to the block that contains it. end=True maps a segment end, so a
    segment that stops at a pause does not extend into the audio recorded after the pause.
    """
    if not index or rate <= 0:
        return frame * 1000 // max(rate, 1)
    lo, hi = 0, len(index)
    while lo < hi:
        mid = (lo + hi) // 2
        block = index[mid]
        before = block.frame_offset < frame if end else block.frame_offset <= frame
        if before:
            lo = mid + 1
        else:
            hi = mid
    block = index[max(lo - 1, 0)]
    within = min(max(frame - block.frame_offset, 0), block.frames)
    return (block.capture_start_us + within * 1_000_000 // rate) // 1000


def session_ms(index: list[audio_wav.Block], rate: int, audio_ms: int, end: bool) -> int:
    """Maps a position in the track, in ms, to session milliseconds. An empty index returns audio_ms."""
    if not index or rate <= 0:
        return audio_ms
    frame = max(audio_ms, 0) * rate // 1000
    return session_at_frame(index, rate, frame, end)


def _sort_key(segment: Segment) -> tuple[int, str, int]:
    timing = segment["timing"]
    if timing["kind"] == "timed":
        return (timing["start_ms"], segment["speaker"], timing["end_ms"])
    return (INT64_MAX, segment["speaker"], INT64_MAX)


def is_marker(text: str) -> bool:
    """Non-speech markers such as [MUSIC] or (silence) are not transcript content."""
    return (text.startswith("[") and text.endswith("]")) or (text.startswith("(") and text.endswith(")"))


def speaker_for(kind: str) -> str:
    return "You" if kind == "mic" else "Others"


def run_track(
    track: dict[str, Any],
    engine: Engine,
    language: str,
    prompt: str,
    cancel: threading.Event,
    report: Report,
) -> list[Segment]:
    kind = track["kind"]
    rate = int(track["sample_rate"])
    index = audio_wav.read_timing(Path(track["timing_path"]), rate, int(track["frames"]))
    wav = audio_read.open_track(
        Path(track["path"]),
        sample_rate=rate,
        channels=int(track["channels"]),
        frames=int(track["frames"]),
    )
    speaker = speaker_for(kind)
    segments: list[Segment] = []
    report(kind, 0)
    for window in audio_read.iter_16k_windows(wav, cancel):
        if cancel.is_set():
            raise cancelled()
        window_ms = window.start * 1000 // rate

        def on_progress(percent: int, window: audio_read.Window = window) -> None:
            report(kind, min(100, (window.index * 100 + percent) // window.count))

        try:
            results = engine.transcribe(
                window.samples,
                language,
                prompt,
                cancel,
                lambda _segment: None,
                on_progress,
            )
        except AppError:
            raise
        except Exception as error:  # the engine's own messages can echo transcript text; log the type only
            log.error("speech engine failed: %s", type(error).__name__)
            raise AppError(
                "stt", "The speech engine failed. Nothing was saved; the previous transcript is unchanged."
            ) from None
        if cancel.is_set():
            raise cancelled()
        for item in results:
            text = item.text.strip()
            if not text or is_marker(text):
                continue
            start = session_ms(index, rate, window_ms + max(item.start_ms, 0), False)
            end = session_ms(index, rate, window_ms + max(item.end_ms, item.start_ms), True)
            segments.append(timed(speaker, start, max(end, start), text))
        report(kind, min(100, (window.index + 1) * 100 // window.count))
    return segments


def run_tracks(
    tracks: list[dict[str, Any]],
    engine: Engine,
    language: str,
    prompt: str,
    cancel: threading.Event,
    report: Report,
) -> list[Segment]:
    """Transcribes each track in turn, then merges and sorts. Nothing is returned on failure or cancel."""
    if cancel.is_set():
        raise cancelled()
    merged: list[Segment] = []
    for track in tracks:
        merged.extend(run_track(track, engine, language, prompt, cancel, report))
    merged.sort(key=_sort_key)
    if cancel.is_set():
        raise cancelled()
    return merged
