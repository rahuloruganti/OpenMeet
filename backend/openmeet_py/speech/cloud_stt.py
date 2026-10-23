"""Bounded cloud transcription of frozen WAV chunks, with honest optional timestamps.

The audio is cut into 16-bit WAV chunks at most 16 MiB (plus the 44-byte header) and 300 seconds
long, split at pauses and generation changes, and sent one request per chunk. Each chunk is hashed
before upload and the source tracks are checked before and after preparation. Requests are never
retried, redirects are never followed, and responses are capped at 4 MiB. Keys never reach a log or
an error message.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
import threading
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

import httpx
import numpy as np

from openmeet_py.api.errors import AppError
from openmeet_py.audio import audio_wav
from openmeet_py.domain import providers
from openmeet_py.domain.transcript_edits import timed
from openmeet_py.speech.transcription import audio_read
from openmeet_py.speech.transcription.audio_read import WavTrack
from openmeet_py.speech.transcription.pipeline import session_at_frame, speaker_for

MAX_CHUNK_BYTES = 16 * 1024 * 1024
MAX_CHUNK_SECONDS = 300
MAX_REQUESTS = 200
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
WAV_HEADER_BYTES = 44
REQUEST_TIMEOUT = 120.0
CLOCK_TOLERANCE_US = 2000  # how far a chunk clock may drift from the timing index
CHUNK_PLAN_SIZE_KEY = ("kind", "path", "sample_rate", "channels", "frames", "finalized")


def _error(message: str) -> AppError:
    return AppError("cloud_stt", message)


def _changed() -> AppError:
    return _error("The audio changed while it was being prepared. Transcribe again; nothing was sent.")


def _cancel_check(cancel: threading.Event) -> None:
    if cancel.is_set():
        raise AppError(
            "stt_cancelled",
            "Transcription was cancelled. The previous transcript is unchanged. Audio already uploaded cannot be recalled.",
        )


def _audio_error() -> AppError:
    return _error("Recorded audio could not be read or prepared. Originals and the previous transcript are unchanged.")


def chunk_ranges(index: list[audio_wav.Block], rate: int, channels: int, cap: int) -> list[tuple[int, int]]:
    """(start frame, frame count) for each chunk. Chunks break at pauses, generation changes and caps."""
    frames_per_chunk = max(1, min((cap - WAV_HEADER_BYTES) // (channels * 2), rate * MAX_CHUNK_SECONDS))
    ranges: list[tuple[int, int]] = []
    start = 0
    length = 0
    for position, block in enumerate(index):
        if position > 0:
            previous = index[position - 1]
            end = previous.capture_start_us + previous.frames * 1_000_000 // rate
            gap = max(block.capture_start_us - end, 0)
            if length > 0 and (previous.generation != block.generation or gap > CLOCK_TOLERANCE_US):
                ranges.append((start, length))
                start += length
                length = 0
        remaining = block.frames
        while remaining > 0:
            take = min(remaining, frames_per_chunk - length)
            length += take
            remaining -= take
            if length == frames_per_chunk:
                ranges.append((start, length))
                start += length
                length = 0
    if length > 0:
        ranges.append((start, length))
    return ranges


def _file_digest(path: Path, cancel: threading.Event) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            _cancel_check(cancel)
            block = handle.read(64 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


@dataclass
class Chunk:
    path: Path
    start: int
    frames: int
    size: int
    digest: str


@dataclass
class PreparedTrack:
    kind: str
    rate: int
    index: list[audio_wav.Block]
    chunks: list[Chunk] = field(default_factory=list)


class Plan:
    """Prepared chunks for one transcription. Owns a temporary folder; call close() when done."""

    def __init__(self, key: tuple, prepared: list[PreparedTrack], scratch: tempfile.TemporaryDirectory):
        self.key = key
        self.prepared = prepared
        self._scratch = scratch

    def requests(self) -> int:
        return sum(len(track.chunks) for track in self.prepared)

    def close(self) -> None:
        self._scratch.cleanup()


def _key(tracks: list[dict[str, Any]]) -> tuple:
    return tuple(tuple(track[name] for name in CHUNK_PLAN_SIZE_KEY) for track in tracks)


def _write_chunk(track: WavTrack, start: int, frames: int, path: Path, cancel: threading.Event) -> None:
    raw = audio_read.read_raw(track, start, start + frames)
    if raw.shape[0] != frames:
        raise _audio_error()
    if not np.all(np.isfinite(raw)):
        raise _error("The audio contains invalid samples. Nothing was sent.")
    _cancel_check(cancel)
    pcm = np.round(np.clip(raw, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as out:
        out.setnchannels(track.channels)
        out.setsampwidth(2)
        out.setframerate(track.sample_rate)
        out.writeframes(pcm.tobytes())


def plan(tracks: list[dict[str, Any]], cancel: threading.Event, cap: int = MAX_CHUNK_BYTES) -> Plan:
    """Writes every chunk to a temporary folder and records its size and digest. Nothing is sent here."""
    _cancel_check(cancel)
    if not tracks or len(tracks) > 2 or cap <= WAV_HEADER_BYTES + 64:
        raise _error("Choose a meeting with finalized microphone or system audio.")
    key = _key(tracks)
    scratch = tempfile.TemporaryDirectory(prefix="openmeet-stt-")
    try:
        prepared: list[PreparedTrack] = []
        requests = 0
        kinds: list[str] = []
        for track_number, track in enumerate(tracks):
            _cancel_check(cancel)
            kind = track["kind"]
            rate = int(track["sample_rate"])
            channels = int(track["channels"])
            frames = int(track["frames"])
            if (
                not track["finalized"]
                or frames <= 0
                or rate <= 0
                or channels <= 0
                or kind not in ("mic", "system")
                or kind in kinds
            ):
                raise _error("The selected audio tracks are invalid or incomplete. Nothing was sent.")
            source = Path(track["path"])
            before = os.stat(source)
            wav = audio_read.open_track(source, sample_rate=rate, channels=channels, frames=frames)
            index = audio_wav.read_timing(Path(track["timing_path"]), rate, frames)
            ranges = chunk_ranges(index, rate, channels, cap)
            requests += len(ranges)
            if requests > MAX_REQUESTS:
                raise _error("This recording would require more than 200 cloud requests. Nothing was sent.")
            chunks: list[Chunk] = []
            for chunk_number, (start, length) in enumerate(ranges):
                _cancel_check(cancel)
                path = Path(scratch.name) / f"{track_number}-{chunk_number}.wav"
                _write_chunk(wav, start, length, path, cancel)
                size = path.stat().st_size
                if size > cap:
                    raise _error("An audio chunk exceeded the upload size limit. Nothing was sent.")
                chunks.append(Chunk(path, start, length, size, _file_digest(path, cancel)))
            after = os.stat(source)
            if after.st_size != before.st_size or after.st_mtime_ns != before.st_mtime_ns:
                raise _changed()
            kinds.append(kind)
            prepared.append(PreparedTrack(kind, rate, index, chunks))
        _cancel_check(cancel)
        return Plan(key, prepared, scratch)
    except BaseException:
        scratch.cleanup()
        raise


def _segment_time(track: PreparedTrack, chunk: Chunk, seconds: float, end: bool) -> int:
    frame = chunk.start + min(round(seconds * track.rate), chunk.frames)
    return session_at_frame(track.index, track.rate, frame, end)


def parse_response(body: bytes, track: PreparedTrack, chunk: Chunk) -> list[dict[str, Any]]:
    invalid = _error(
        "The provider returned an unsupported transcription response. The previous transcript is unchanged."
    )
    try:
        response = json.loads(body)
    except ValueError as error:
        raise invalid from error
    if not isinstance(response, dict) or not isinstance(response.get("text"), str):
        raise invalid
    speaker = speaker_for(track.kind)
    segments = response.get("segments")
    if segments is None:
        text = response["text"].strip()
        return [timed(speaker, None, None, text)] if text else []
    if not isinstance(segments, list):
        raise invalid
    duration = chunk.frames / track.rate
    result: list[dict[str, Any]] = []
    for item in segments:
        if not isinstance(item, dict) or not isinstance(item.get("text"), str):
            raise invalid
        start, end = item.get("start"), item.get("end")
        for value in (start, end):
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise invalid
        if not (math.isfinite(start) and math.isfinite(end)) or start < 0 or end < start or end > duration + 0.001:
            raise invalid
        text = item["text"].strip()
        if not text:
            continue
        start_ms = _segment_time(track, chunk, float(start), False)
        end_ms = max(_segment_time(track, chunk, float(end), True), start_ms)
        result.append(timed(speaker, start_ms, end_ms, text))
    if not result and response["text"].strip():
        raise invalid
    return result


def transcribe(
    connection: providers.Connection,
    tracks: list[dict[str, Any]],
    language: str,
    prompt: str,
    prepared: Plan,
    cancel: threading.Event,
    report: Callable[[str, int], None],
    before_request: Callable[[str, int], None],
) -> list[dict[str, Any]]:
    """Sends each chunk once and returns the validated segments. Nothing partial is returned."""
    _cancel_check(cancel)
    if _key(tracks) != prepared.key:
        raise _changed()
    if language != "auto" and (
        not language or len(language) > 16 or not all(c.isascii() and (c.isalpha() or c == "-") for c in language)
    ) or len(prompt) > 500:
        raise _error("The speech language or vocabulary setting is invalid. Nothing was sent.")
    model = connection.require_model()
    url = connection.endpoint("audio/transcriptions")
    unreachable = _error(
        "Cannot reach the transcription provider. Check its API base URL and connection. The previous transcript is unchanged."
    )
    entries: list[dict[str, Any]] = []
    with providers.client(REQUEST_TIMEOUT, connection.transport) as http:
        for track in prepared.prepared:
            report(track.kind, 0)
            for number, chunk in enumerate(track.chunks):
                _cancel_check(cancel)
                if _file_digest(chunk.path, cancel) != chunk.digest:
                    raise _changed()
                data = {"model": model, "response_format": "json"}
                if language != "auto":
                    data["language"] = language
                clean_prompt = prompt.strip()
                if clean_prompt:
                    data["prompt"] = clean_prompt
                identity = json.dumps(
                    [chunk.digest, model, language, clean_prompt], separators=(",", ":")
                ).encode("utf-8")
                before_request(hashlib.sha256(identity).hexdigest(), chunk.size)
                _cancel_check(cancel)
                body = _post_chunk(http, url, connection, data, chunk, unreachable)
                _cancel_check(cancel)
                entries.extend(parse_response(body, track, chunk))
                report(track.kind, (number + 1) * 100 // len(track.chunks))
    _cancel_check(cancel)
    if all(entry["timing"]["kind"] == "timed" for entry in entries):
        entries.sort(key=lambda entry: (entry["timing"]["start_ms"], entry["speaker"]))
    return entries


def _post_chunk(
    http: Any,
    url: str,
    connection: providers.Connection,
    data: dict[str, str],
    chunk: Chunk,
    unreachable: AppError,
) -> bytes:
    """One multipart POST, no retry. The status is checked before the body is read; the body is capped."""
    try:
        with open(chunk.path, "rb") as handle:
            files = {"file": ("audio.wav", handle, "audio/wav")}
            with http.stream("POST", url, headers=connection.headers(), data=data, files=files) as response:
                providers.check_status(response.status_code)
                body = bytearray()
                for block in response.iter_bytes():
                    body.extend(block)
                    if len(body) > MAX_RESPONSE_BYTES:
                        raise _error(
                            "The transcription response was unreadable or too large. The previous transcript is unchanged."
                        )
                return bytes(body)
    except AppError:
        raise
    except httpx.HTTPError:  # the message can echo the URL; the class is not reported either
        raise unreachable from None
