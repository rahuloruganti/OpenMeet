"""Transcription jobs: one at a time, on a worker thread, replacing the transcript only on success.

The HTTP request waits for the job, so the UI's await resolves when the transcript is saved or the
job fails. The work itself runs on its own thread, and cancel_transcription can reach it from another
request. Ports lib.rs transcribe_meeting, finalized_tracks and same_stt_settings.
"""

from __future__ import annotations

import threading
from typing import Any, Optional

from .. import cloud_stt, providers, reads, sherpa_models, stt, transcript_edits
from ..connections import plan_changed
from ..context import Context, text_arg
from ..errors import AppError
from ..store import transaction
from . import engine as engine_module
from . import pipeline


def finalized_tracks(detail: dict[str, Any]) -> list[dict[str, Any]]:
    if detail["meeting"]["status"] in ("recording", "paused"):
        raise AppError("stt", "Stop the recording before transcribing it.")
    if any(not track["finalized"] for track in detail["tracks"]):
        raise AppError("stt", "This recording has incomplete audio. Recover it before transcription.")
    tracks = [track for track in detail["tracks"] if track["frames"] > 0]
    if not tracks:
        raise AppError("stt", "This meeting has no finalized audio tracks to transcribe.")
    return tracks


def same_stt_settings(current: dict[str, Any], snapshot: dict[str, Any]) -> bool:
    if (
        current["stt_mode"] != snapshot["stt_mode"]
        or current["stt_language"] != snapshot["stt_language"]
        or current["stt_prompt"] != snapshot["stt_prompt"]
    ):
        return False
    if snapshot["stt_mode"] == "local":
        return current["stt_model"] == snapshot["stt_model"]
    return current["cloud_stt"] == snapshot["cloud_stt"]


def _local(ctx: Context, settings: dict[str, Any], tracks: list[dict[str, Any]], cancel: threading.Event, report: Any):
    stt.validate(settings["stt_language"], settings["stt_prompt"], settings["stt_model"])
    root = stt.stt_root(ctx)
    fake = stt.fake_engine()
    if not fake and not stt.status(root, settings["stt_model"])["installed"]:
        raise AppError(
            "stt",
            "The speech engine and the selected model are not installed. Download them in Settings first.",
        )
    if sherpa_models.is_sherpa(settings["stt_model"]):
        # Provider stays "whisper" for every local run, as lib.rs records it.
        spec = None if fake else sherpa_models.spec_for(root, settings["stt_model"])
        engine = engine_module.make_engine(
            None, None if fake else sherpa_models.vad_path(root), fake, spec
        )
    else:
        model_path = None if fake else stt.selected_model_path(root, settings["stt_model"])
        engine = engine_module.make_engine(model_path, stt.vad_path(root), fake)
    segments = pipeline.run_tracks(
        tracks, engine, settings["stt_language"], settings["stt_prompt"], cancel, report
    )
    return segments, "whisper", settings["stt_model"]


def _cloud(
    ctx: Context,
    settings: dict[str, Any],
    config: Optional[dict[str, Any]],
    tracks: list[dict[str, Any]],
    cancel: threading.Event,
    report: Any,
):
    if config is None:
        raise AppError("provider_missing", "Save a cloud transcription connection in Settings first.")

    def unchanged() -> None:
        with ctx.store.lock:
            if not same_stt_settings(reads.read_settings(ctx.store.db), settings):
                raise plan_changed()

    plan = cloud_stt.plan(tracks, cancel)
    try:
        unchanged()
        connection = providers.load_connection(config, ctx.transport)
        model = connection.require_model()
        segments = cloud_stt.transcribe(
            connection,
            tracks,
            settings["stt_language"],
            settings["stt_prompt"],
            plan,
            cancel,
            report,
            lambda _fingerprint, _bytes: unchanged(),
        )
    finally:
        plan.close()
    return segments, connection.base_url, model


def _run(ctx: Context, meeting_id: str, cancel: threading.Event) -> None:
    def report(track: str, percent: int) -> None:
        ctx.emit("stt_progress", {"stage": "transcribing", "track": track, "percent": percent})

    report("preparing", 0)
    with ctx.store.lock:
        db = ctx.store.db
        reads.require_meeting(db, meeting_id)
        tracks = finalized_tracks(reads.meeting_detail(db, meeting_id))
        settings = reads.read_settings(db)
        config = reads.provider_config(db, "cloud_stt") if settings["stt_mode"] == "cloud" else None
    if settings["stt_mode"] == "cloud":
        segments, provider, model = _cloud(ctx, settings, config, tracks, cancel, report)
    else:
        segments, provider, model = _local(ctx, settings, tracks, cancel, report)
    if cancel.is_set():
        raise AppError("stt_cancelled", "Transcription was cancelled. The previous transcript is unchanged.")
    with ctx.store.lock:
        db = ctx.store.db
        if not same_stt_settings(reads.read_settings(db), settings):
            raise plan_changed()
        reads.require_meeting(db, meeting_id)
        with transaction(db) as tx:
            transcript_edits.replace_transcript(tx, meeting_id, segments, provider, model)


def transcribe_meeting(ctx: Context, id: Any) -> None:
    meeting_id = text_arg(id, "id")
    if not ctx.stt_busy.acquire(blocking=False):
        raise AppError(
            "processing_busy", "Another transcription or AI request is still running. Wait for it to finish."
        )
    cancel = threading.Event()
    outcome: dict[str, BaseException] = {}
    try:
        ctx.stt_cancel = cancel

        def work() -> None:
            try:
                _run(ctx, meeting_id, cancel)
            except BaseException as error:  # handed back to the request thread below
                outcome["error"] = error

        worker = threading.Thread(target=work, name="openmeet-transcription", daemon=True)
        worker.start()
        worker.join()
    finally:
        ctx.stt_cancel = None
        ctx.stt_busy.release()
    if "error" in outcome:
        raise outcome["error"]
    ctx.emit("meeting_updated", None)


def cancel_transcription(ctx: Context) -> bool:
    event = ctx.stt_cancel
    if event is None:
        return False
    event.set()
    return True
