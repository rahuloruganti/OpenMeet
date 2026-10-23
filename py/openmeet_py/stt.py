"""Local speech-to-text: status, settings validation and the explicit install (src-tauri/src/stt.rs).

Port notes. The Rust app ran whisper.cpp b5454 as a downloaded subprocess. This build runs
pywhispercpp in-process (the package is installed with the app), so the "engine" flag means the
package imports and no engine download exists. Only the selected model and the Silero VAD file are
downloaded, and only by stt_install. OPENMEET_PY_FAKE_STT=1 replaces the engine with a fake for
tests and browser checks; it reports the speech files as installed without creating any file.
"""

from __future__ import annotations

import importlib.util
import os
import platform
import sys
import unicodedata
from pathlib import Path
from typing import Any, Optional

from . import model_library
from .context import Context, text_arg
from .errors import AppError
from .stt_catalog import SHERPA_ENGINE_SIZE, SHERPA_MODELS, SHERPA_VAD_SIZE, VAD, WHISPER_MODELS, Artifact
from .reads import read_settings

LANGUAGES = (
    "auto", "ar", "ca", "cs", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "hr", "hu",
    "id", "it", "ja", "ko", "ms", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sv", "ta", "th", "tr",
    "uk", "ur", "vi", "zh",
)
PROMPT_LIMIT = 500
FAKE_ENV = "OPENMEET_PY_FAKE_STT"
SHERPA_REASON = (
    "sherpa-onnx speech models are not available in this build yet (planned for phase 4b). "
    "Use a Whisper model."
)
MODEL_ERROR = "Choose one of the listed speech models."
CUSTOM_ERROR = "That speech model file is missing or is not a Whisper ggml model. Choose again."
GGML_MAGIC = (b"lmgg", b"ggml")


def fake_engine() -> bool:
    return os.environ.get(FAKE_ENV) == "1"


def engine_available() -> bool:
    """Whether the speech engine package is importable. Uses find_spec, so nothing is imported."""
    if fake_engine():
        return True
    return importlib.util.find_spec("pywhispercpp") is not None


def supported() -> bool:
    return sys.platform == "win32" and platform.machine().lower() in ("amd64", "x86_64")


def stt_root(ctx: Context) -> Path:
    return ctx.store.data_dir / "stt"


def _is_sherpa(model_id: str) -> bool:
    return model_id.startswith("sherpa:") or model_id.startswith("sherpa-dir:")


def _catalog(model_id: str) -> Optional[Artifact]:
    return next((entry for entry in WHISPER_MODELS if entry.id == model_id), None)


def _custom_ok(model_id: str) -> bool:
    """A Whisper ggml file used in place: an absolute path to an existing file with a ggml magic."""
    try:
        path = Path(model_id)
        if not path.is_absolute() or not path.is_file():
            return False
        with open(path, "rb") as handle:
            magic = handle.read(4)
    except (OSError, ValueError):
        return False
    return magic in GGML_MAGIC


def validate(language: str, prompt: str, model_id: str) -> None:
    """Checks transcription settings before they are stored or passed to the engine (stt::validate)."""
    if language not in LANGUAGES:
        raise AppError("stt_settings", "Choose one of the listed transcription languages.")
    if len(prompt) > PROMPT_LIMIT or any(_is_control(char) for char in prompt):
        raise AppError("stt_settings", "Keep the vocabulary hint to one line of at most 500 characters.")
    if _catalog(model_id) is not None:
        return
    if _is_sherpa(model_id):
        raise AppError("stt_settings", SHERPA_REASON)
    if not _custom_ok(model_id):
        raise AppError("stt_settings", CUSTOM_ERROR)


def _is_control(char: str) -> bool:
    return unicodedata.category(char) == "Cc"


def _model_file(root: Path, artifact: Artifact) -> Path:
    return root / "models" / artifact.file


def _present(root: Path, artifact: Artifact) -> bool:
    path = _model_file(root, artifact)
    try:
        return path.is_file() and path.stat().st_size == artifact.size
    except OSError:
        return False


def _models_listing(root: Path) -> list[dict[str, Any]]:
    listing: list[dict[str, Any]] = []
    for entry in WHISPER_MODELS:
        listing.append({"id": entry.id, "size": entry.size, "installed": _present(root, entry)})
    for model_id, archive_size in SHERPA_MODELS:
        listing.append(
            {
                "id": model_id,
                "size": SHERPA_ENGINE_SIZE + SHERPA_VAD_SIZE + archive_size,
                "installed": False,
                "reason": SHERPA_REASON,
            }
        )
    return listing


def status(root: Path, model_id: str) -> dict[str, Any]:
    """The SttStatus shape from src/lib/api.ts. Extra per-model "reason" keys are additive."""
    models = _models_listing(root)
    languages = list(LANGUAGES)
    if fake_engine():
        return {
            "engine": True,
            "model": True,
            "vad": True,
            "installed": True,
            "missing_bytes": 0,
            "supported": True,
            "models": models,
            "languages": languages,
            "reason": None,
        }
    engine = engine_available()
    reason: Optional[str] = None
    if _is_sherpa(model_id):
        reason = SHERPA_REASON
        model_ok = False
        model_size = 0
    else:
        selected = _catalog(model_id)
        if selected is not None:
            model_ok = _present(root, selected)
            model_size = selected.size
        else:
            model_ok = _custom_ok(model_id)
            model_size = 0
    vad_ok = _present(root, VAD)
    missing = (0 if model_ok else model_size) + (0 if vad_ok else VAD.size)
    installed = engine and model_ok and vad_ok and reason is None
    return {
        "engine": engine,
        "model": model_ok,
        "vad": vad_ok,
        "installed": installed,
        "missing_bytes": missing,
        "supported": supported(),
        "models": models,
        "languages": languages,
        "reason": reason,
    }


def selected_model_path(root: Path, model_id: str) -> Path:
    """Absolute path of the model file the engine loads. Raises if it is not installed."""
    selected = _catalog(model_id)
    if selected is not None:
        if not _present(root, selected):
            raise AppError("stt", "The selected speech model is not installed. Download it in Settings first.")
        return _model_file(root, selected)
    if _custom_ok(model_id):
        return Path(model_id)
    raise AppError("stt_settings", CUSTOM_ERROR)


def vad_path(root: Path) -> Optional[Path]:
    return _model_file(root, VAD) if _present(root, VAD) else None


def install(ctx: Context) -> dict[str, Any]:
    """Downloads the missing pinned VAD file and selected model. Runs only on an explicit user action."""
    root = stt_root(ctx)
    with ctx.store.lock:
        model_id = read_settings(ctx.store.db)["stt_model"]
    if _is_sherpa(model_id):
        raise AppError("stt", SHERPA_REASON)
    if fake_engine():
        return status(root, model_id)
    if not supported():
        raise AppError("stt", "Local speech-to-text needs Windows x64 in this build.")
    if not engine_available():
        raise AppError(
            "stt", "The speech engine (pywhispercpp) is missing from this build. Reinstall OpenMeet."
        )
    selected = _catalog(model_id)
    if selected is None and not _custom_ok(model_id):
        raise AppError("stt_settings", MODEL_ERROR)
    with model_library.artifact_operation() as cancel:
        folder = model_library.managed_folder(root, ["models"])
        pending: list[tuple[str, Artifact]] = []
        if not _present(root, VAD):
            pending.append(("vad", VAD))
        if selected is not None and not _present(root, selected):
            pending.append(("model", selected))
        for stage, artifact in pending:
            model_library.check_cancel(cancel)
            model_library.fetch_verified(
                artifact.url,
                folder,
                artifact.file,
                artifact.size,
                artifact.sha256,
                progress=lambda done, stage=stage, total=artifact.size: ctx.emit(
                    "stt_progress", {"stage": stage, "downloaded": done, "total": total}
                ),
                cancel=cancel,
                transport=ctx.transport,
            )
        return status(root, model_id)


# ---- command handlers ----------------------------------------------------------------


def stt_status(ctx: Context) -> dict[str, Any]:
    with ctx.store.lock:
        model_id = read_settings(ctx.store.db)["stt_model"]
    return status(stt_root(ctx), model_id)


def save_stt_mode(ctx: Context, mode: Any) -> dict[str, Any]:
    if mode not in ("local", "cloud"):
        raise AppError("invalid_args", "Choose local or cloud speech-to-text.")
    with ctx.store.lock:
        db = ctx.store.db
        db.execute("UPDATE settings SET stt_mode = ?1 WHERE id = 1", (mode,))
        return read_settings(db)


def save_stt_settings(ctx: Context, language: Any, prompt: Any, model: Any) -> dict[str, Any]:
    language = text_arg(language, "language")
    prompt = text_arg(prompt, "prompt").strip()
    model = text_arg(model, "model")
    validate(language, prompt, model)
    with ctx.store.lock:
        db = ctx.store.db
        db.execute(
            "UPDATE settings SET stt_language = ?1, stt_prompt = ?2, stt_model = ?3 WHERE id = 1",
            (language, prompt, model),
        )
        return read_settings(db)


def stt_install(ctx: Context) -> dict[str, Any]:
    return install(ctx)
