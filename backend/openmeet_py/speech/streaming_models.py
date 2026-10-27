"""Pinned streaming (online) sherpa-onnx models: folder layout, installed state, install and load.

Live transcript models live under <stt root>/streaming/:
- pinned archives from stt_catalog.STREAMING_MODELS, downloaded only by an explicit click and
  verified against the pinned size and SHA-256, then extracted by safe_archive into a staging folder
  that is renamed into place after every wanted file exists and a marker with the archive digest
  has been written. An existing incomplete folder is refused, not overwritten.
- custom folders under streaming/custom/<name>, found on disk only and never downloaded.
A streaming model needs no VAD file: the recognizer decides utterance ends by itself.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

import httpx

from openmeet_py.api.errors import AppError
from openmeet_py.speech import model_library, safe_archive
from openmeet_py.speech.stt_catalog import STREAMING_MODELS, StreamingModel

STREAM_PREFIX = "stream:"
CUSTOM_PREFIX = "stream-dir:"
CUSTOM = "custom"
MARKER = ".release"
MODULE = "sherpa_onnx"
SAMPLE_RATE = 16_000
FEATURE_DIM = 80
DEFAULT_THREADS = 2
RULE1_SECONDS = 2.4
RULE2_SECONDS = 0.8
RULE3_SECONDS = 20.0
SINGLE_MODEL = "nemo_ctc"


@dataclass(frozen=True)
class Entry:
    """One row of the live model list: a pinned model or a folder found on disk."""

    id: str
    label: str
    installed: bool
    download_bytes: Optional[int]
    languages: tuple[str, ...]
    custom: bool = False


def folder(root: Path) -> Path:
    return root / "streaming"


def pinned(model_id: str) -> Optional[StreamingModel]:
    return next((model for model in STREAMING_MODELS if model.id == model_id), None)


def custom_name(model_id: str) -> Optional[str]:
    """The name after `stream-dir:` if it is one plain folder name (no separators, no \"..\", no leading dot)."""
    if not model_id.startswith(CUSTOM_PREFIX):
        return None
    name = model_id[len(CUSTOM_PREFIX):]
    plain = (
        bool(name)
        and not name.startswith(".")
        and ".." not in name
        and all(char.isascii() and (char.isalnum() or char in "-_.") for char in name)
        and "/" not in name
        and "\\" not in name
        and ":" not in name
    )
    return name if plain else None


def is_streaming(model_id: str) -> bool:
    return pinned(model_id) is not None or custom_name(model_id) is not None


def engine_available() -> bool:
    """Whether the sherpa-onnx package is importable. find_spec only; the module is not imported here."""
    try:
        import importlib.util

        return importlib.util.find_spec(MODULE) is not None
    except (ImportError, ValueError):
        return False


def unavailable_reason() -> Optional[str]:
    from openmeet_py.speech.stt import local_speech_supported

    if not local_speech_supported():
        return "Live transcript models need Windows x64 or a Mac with Apple silicon."
    if not engine_available():
        return "The sherpa-onnx speech engine is missing from this build. Reinstall OpenMeet."
    return None


def _model_dir(root: Path, model: StreamingModel) -> Path:
    return folder(root) / model.folder


def _custom_dir(root: Path, model_id: str) -> Optional[Path]:
    name = custom_name(model_id)
    return None if name is None else folder(root) / CUSTOM / name


def folder_files(directory: Path) -> list[tuple[str, int]]:
    """Regular files directly inside a folder, with sizes. Links and subfolders are ignored."""
    found: list[tuple[str, int]] = []
    try:
        entries = list(os.scandir(directory))
    except OSError:
        return found
    for entry in entries:
        try:
            if entry.is_file(follow_symlinks=False):
                found.append((entry.name, entry.stat(follow_symlinks=False).st_size))
        except OSError:
            continue
    return found


def _complete(directory: Path, model: StreamingModel) -> bool:
    try:
        marker = (directory / MARKER).read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return False
    if marker != model.archive.sha256:
        return False
    names = {name for name, _ in folder_files(directory)}
    return all(name in names for name in model.files)


def _layout(directory: Path) -> Optional[tuple[str, dict[str, Path]]]:
    """The recognizer layout of a folder: transducer roles, or one NeMo CTC model plus tokens."""
    names = [name for name, _ in folder_files(directory)]
    layout = model_library.sherpa_layout(names)
    if layout is None:
        return None
    kind, needed = layout
    if kind == "transducer":
        encoder, decoder, joiner, tokens = needed
        return kind, {
            "encoder": directory / encoder,
            "decoder": directory / decoder,
            "joiner": directory / joiner,
            "tokens": directory / tokens,
        }
    if kind == "single_model":
        model, tokens = needed
        return SINGLE_MODEL, {"model": directory / model, "tokens": directory / tokens}
    return None  # moonshine is an offline layout; a live model cannot use it


def custom_models(root: Path) -> list[Entry]:
    """Folders under streaming/custom that hold a streaming layout, sorted by name."""
    base = folder(root) / CUSTOM
    try:
        entries = list(os.scandir(base))
    except OSError:
        return []
    rows: list[Entry] = []
    for entry in entries:
        model_id = f"{CUSTOM_PREFIX}{entry.name}"
        if custom_name(model_id) is None or not entry.is_dir(follow_symlinks=False):
            continue
        directory = Path(entry.path)
        if _layout(directory) is None:
            continue
        rows.append(Entry(model_id, entry.name, True, None, (), custom=True))
    return sorted(rows, key=lambda row: row.id)


def installed(root: Path, model_id: str) -> bool:
    if not engine_available():
        return False
    model = pinned(model_id)
    if model is not None:
        return _complete(_model_dir(root, model), model)
    directory = _custom_dir(root, model_id)
    return directory is not None and directory.is_dir() and _layout(directory) is not None


def models(root: Path) -> list[Entry]:
    """Pinned models in catalog order, then custom folders found on disk."""
    ready = engine_available()
    rows: list[Entry] = []
    for model in STREAMING_MODELS:
        present = ready and _complete(_model_dir(root, model), model)
        rows.append(
            Entry(model.id, model.label, present, None if present else model.archive.size, model.languages)
        )
    rows.extend(custom_models(root))
    return rows


def spec(root: Path, model_id: str) -> tuple[str, dict[str, Path]]:
    """(family, absolute file paths) for an installed model. Raises AppError when it cannot run."""
    reason = unavailable_reason()
    if reason is not None:
        raise AppError("live_model", reason)
    model = pinned(model_id)
    if model is not None:
        directory = _model_dir(root, model)
        if not _complete(directory, model):
            raise AppError("live_model", f"Download {model.label} in Settings first.")
        return model.family, {
            "encoder": directory / next(name for name in model.files if name.startswith("encoder")),
            "decoder": directory / next(name for name in model.files if name.startswith("decoder")),
            "joiner": directory / next(name for name in model.files if name.startswith("joiner")),
            "tokens": directory / "tokens.txt",
        }
    directory = _custom_dir(root, model_id)
    if directory is None or not directory.is_dir():
        raise AppError("live_model", "That streaming model folder is missing. Choose another live model.")
    layout = _layout(directory)
    if layout is None:
        raise AppError(
            "live_model",
            "That folder is not a streaming model. It needs an encoder, a decoder, a joiner and tokens.txt.",
        )
    return layout


def recognizer(root: Path, model_id: str, threads: int = DEFAULT_THREADS) -> Any:
    """A loaded sherpa_onnx.OnlineRecognizer with endpoint detection, for an installed model."""
    family, paths = spec(root, model_id)
    import sherpa_onnx  # lazy: the native library loads only when a live transcript starts

    common: dict[str, Any] = {
        "tokens": str(paths["tokens"]),
        "num_threads": max(1, int(threads)),
        "sample_rate": SAMPLE_RATE,
        "feature_dim": FEATURE_DIM,
        "enable_endpoint_detection": True,
        "rule1_min_trailing_silence": RULE1_SECONDS,
        "rule2_min_trailing_silence": RULE2_SECONDS,
        "rule3_min_utterance_length": RULE3_SECONDS,
        "decoding_method": "greedy_search",
    }
    if family == SINGLE_MODEL:
        return sherpa_onnx.OnlineRecognizer.from_nemo_ctc(model=str(paths["model"]), **common)
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        encoder=str(paths["encoder"]),
        decoder=str(paths["decoder"]),
        joiner=str(paths["joiner"]),
        **common,
    )


def install(
    root: Path,
    model_id: str,
    cancel: threading.Event,
    progress: Callable[[str, int, int], None],
    client: Optional[httpx.Client] = None,
    *,
    transport: Optional[httpx.BaseTransport] = None,
) -> None:
    """Downloads and verifies one pinned model. Custom folders are never installed.

    `client` is accepted for the command layer (a configured httpx.Client); its transport is used for
    the download, so a test can pass a client backed by httpx.MockTransport.
    """
    model = pinned(model_id)
    if model is None:
        raise AppError("live_model", "That live model is not a download. Choose a streaming model.")
    reason = unavailable_reason()
    if reason is not None:
        raise AppError("live_model", reason)
    target = _model_dir(root, model)
    if _complete(target, model):
        return
    if target.exists():
        raise AppError(
            "live_model",
            "The folder for this live model already exists but is incomplete. It was preserved; "
            "move it aside, then try again.",
        )
    base = model_library.managed_folder(folder(root), [])
    if transport is None:
        transport = getattr(client, "_transport", None)
    model_library.check_cancel(cancel)
    archive = model_library._download_to_temp(
        model.archive.url,
        base,
        model.archive.size,
        model.archive.sha256,
        lambda done: progress("downloading", done, model.archive.size),
        cancel,
        transport,
        model_library.allowed_release_url,
    )
    staging = Path(tempfile.mkdtemp(dir=base, prefix=".staging-"))
    try:
        progress("verifying", 0, model.archive.size)
        try:
            safe_archive.extract_wanted(archive, staging, model.files, cancel)
        finally:
            archive.unlink(missing_ok=True)
        (staging / MARKER).write_text(model.archive.sha256, encoding="utf-8")
        model_library.publish_directory(staging, target, cancel)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
