"""sherpa-onnx speech models: ids, folder layout, installed state, runnable specs and installs.

Install rules for the sherpa-onnx engine. Choices worth naming:
- The engine is the pip package `sherpa-onnx` (pinned in requirements.txt), not a downloaded runtime.
  "Engine installed" means the package is importable. Nothing is downloaded for it.
- Downloads of the shared VAD and the pinned archives go through model_library's verified streaming
  (sha256, size cap, no-clobber). Archives are extracted by safe_archive into a staging folder that is
  renamed into place only after every wanted file exists and a marker holding the archive SHA-256 is written.
- An existing incomplete model folder is refused, not overwritten.
"""

from __future__ import annotations

import importlib.util
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
from openmeet_py.speech.stt_catalog import SHERPA_MODELS, SHERPA_VAD, SherpaModel

SHERPA_PREFIX = "sherpa:"
CUSTOM_PREFIX = "sherpa-dir:"
CUSTOM = "custom"
MARKER = ".release"
MODULE = "sherpa_onnx"
SENSE_VOICE_LANGUAGES = ("zh", "en", "ja", "ko", "yue")
ENGINE_LABEL = "sherpa-onnx"


@dataclass(frozen=True)
class Spec:
    """What the engine loads: family plus the absolute file paths for that family's roles."""

    family: str  # transducer | moonshine | sense_voice
    paths: dict[str, Path]
    model_type: str = ""  # passed to from_transducer; "" lets the engine read the model's metadata


@dataclass(frozen=True)
class Installed:
    engine: bool
    model: bool
    vad: bool
    missing_bytes: int


def folder(root: Path) -> Path:
    return root / "sherpa"


def pinned(model_id: str) -> Optional[SherpaModel]:
    return next((model for model in SHERPA_MODELS if model.id == model_id), None)


def custom_name(model_id: str) -> Optional[str]:
    """The name after `sherpa-dir:` if it is one plain folder name (no separators, no "..", no leading dot)."""
    if not model_id.startswith(CUSTOM_PREFIX):
        return None
    name = model_id[len(CUSTOM_PREFIX):]
    plain = (
        bool(name)
        and not name.startswith(".")
        and ".." not in name
        and all(char.isascii() and (char.isalnum() or char in "-_.") for char in name)
    )
    return name if plain else None


def is_sherpa(model_id: str) -> bool:
    return pinned(model_id) is not None or custom_name(model_id) is not None


def supported() -> bool:
    """The shared target gate lives in stt.py, which imports this module, so it is imported lazily."""
    from openmeet_py.speech.stt import local_speech_supported

    return local_speech_supported()


def engine_available() -> bool:
    """Whether the sherpa-onnx package is importable. find_spec only; the module is not imported here."""
    try:
        return importlib.util.find_spec(MODULE) is not None
    except (ImportError, ValueError):
        return False


def _vad_file(root: Path) -> Path:
    return folder(root) / SHERPA_VAD.file


def vad_path(root: Path) -> Optional[Path]:
    return _vad_file(root) if _vad_ready(root) else None


def _vad_ready(root: Path) -> bool:
    try:
        return _vad_file(root).stat().st_size == SHERPA_VAD.size
    except OSError:
        return False


def _model_dir(root: Path, model: SherpaModel) -> Path:
    return folder(root) / model.folder


def _custom_dir(root: Path, model_id: str) -> Optional[Path]:
    name = custom_name(model_id)
    return None if name is None else folder(root) / CUSTOM / name


def _complete(directory: Path, model: SherpaModel) -> bool:
    try:
        marker = (directory / MARKER).read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return False
    return marker == model.archive.sha256 and all((directory / name).is_file() for name in model.files)


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


def custom_size(files: list[tuple[str, int]]) -> Optional[int]:
    """Bytes of a downloaded folder whose files match one sherpa layout, or None if none matches."""
    if model_library.sherpa_layout([name for name, _ in files]) is None:
        return None
    return sum(size for _, size in files)


def custom_models(root: Path) -> list[tuple[str, int]]:
    """Status rows for downloaded folders that match a runnable layout, sorted by id."""
    base = folder(root) / CUSTOM
    try:
        entries = list(os.scandir(base))
    except OSError:
        return []
    rows: list[tuple[str, int]] = []
    for entry in entries:
        model_id = f"{CUSTOM_PREFIX}{entry.name}"
        if custom_name(model_id) is None or not entry.is_dir(follow_symlinks=False):
            continue
        size = custom_size(folder_files(Path(entry.path)))
        if size is not None:
            rows.append((model_id, size))
    return sorted(rows)


def installed(root: Path, model_id: str) -> Installed:
    """Installed state for a pinned model or a downloaded folder. The engine is the package, so it is not a download."""
    engine = engine_available()
    vad = _vad_ready(root)
    model = pinned(model_id)
    if model is not None:
        ready = _complete(_model_dir(root, model), model)
        missing = (0 if vad else SHERPA_VAD.size) + (0 if ready else model.archive.size)
    else:
        directory = _custom_dir(root, model_id)
        ready = directory is not None and custom_size(folder_files(directory)) is not None
        missing = 0 if vad else SHERPA_VAD.size
    return Installed(engine=engine, model=ready, vad=vad, missing_bytes=missing)


def download_size(model: SherpaModel) -> int:
    """Bytes the Python build downloads for a pinned model: the VAD plus its archive (the engine is a package)."""
    return SHERPA_VAD.size + model.archive.size


def unavailable_reason() -> Optional[str]:
    """Why a sherpa model cannot run in this build right now, or None."""
    if not supported():
        return "sherpa-onnx speech models need Windows x64 or a Mac with Apple silicon."
    if not engine_available():
        return "The sherpa-onnx speech engine is missing from this build. Reinstall OpenMeet."
    return None


def sense_voice_language(language: str) -> str:
    """SenseVoice takes these codes; anything else runs as auto."""
    return language if language in SENSE_VOICE_LANGUAGES else "auto"


def _spec_for_files(directory: Path, files: list[str], model_type: str) -> Spec:
    layout = model_library.sherpa_layout(files)
    if layout is None:
        raise AppError("stt_settings", "This downloaded speech model is incomplete. Download it again.")
    kind, needed = layout
    if kind == "transducer":
        encoder, decoder, joiner, tokens = needed
        return Spec("transducer", {"encoder": directory / encoder, "decoder": directory / decoder,
                                   "joiner": directory / joiner, "tokens": directory / tokens}, model_type)
    if kind == "moonshine":
        encoder, decoder, tokens = needed
        return Spec("moonshine", {"encoder": directory / encoder, "decoder": directory / decoder,
                                  "tokens": directory / tokens})
    model, tokens = needed
    return Spec("sense_voice", {"model": directory / model, "tokens": directory / tokens})


def spec_for(root: Path, model_id: str) -> Spec:
    """The runnable spec for an installed sherpa model. Raises AppError if its files are not all present."""
    model = pinned(model_id)
    if model is not None:
        if not _complete(_model_dir(root, model), model):
            raise AppError("stt", "The selected speech model is not installed. Download it in Settings first.")
        directory = _model_dir(root, model)
        if model.family == "transducer":
            return Spec("transducer", {
                "encoder": directory / "encoder.int8.onnx",
                "decoder": directory / "decoder.int8.onnx",
                "joiner": directory / "joiner.int8.onnx",
                "tokens": directory / "tokens.txt",
            }, model_type="nemo_transducer")
        if model.family == "moonshine":
            return Spec("moonshine", {
                "encoder": directory / "encoder_model.ort",
                "decoder": directory / "decoder_model_merged.ort",
                "tokens": directory / "tokens.txt",
            })
        return Spec("sense_voice", {"model": directory / "model.int8.onnx", "tokens": directory / "tokens.txt"})
    directory = _custom_dir(root, model_id)
    if directory is None:
        raise AppError("stt_settings", "Choose a downloaded sherpa-onnx folder from the list.")
    files = folder_files(directory)
    if custom_size(files) is None:
        raise AppError("stt", "This downloaded speech model is incomplete. Download it again in the model library.")
    return _spec_for_files(directory, [name for name, _ in files], model_type="")


def custom_ready(root: Path, model_id: str) -> bool:
    directory = _custom_dir(root, model_id)
    return directory is not None and custom_size(folder_files(directory)) is not None


def install(
    root: Path,
    model: Optional[SherpaModel],
    progress: Callable[[str, int, int], None],
    cancel: threading.Event,
    transport: Optional[httpx.BaseTransport] = None,
) -> None:
    """Downloads what is missing: the shared VAD, and the pinned archive for a pinned model.

    A downloaded folder (model is None) needs only the VAD. Callers hold model_library.artifact_operation().
    """
    base = model_library.managed_folder(root, ["sherpa"])
    if not _vad_ready(root):
        model_library.check_cancel(cancel)
        model_library.fetch_verified(
            SHERPA_VAD.url,
            base,
            SHERPA_VAD.file,
            SHERPA_VAD.size,
            SHERPA_VAD.sha256,
            progress=lambda done: progress("vad", done, SHERPA_VAD.size),
            cancel=cancel,
            transport=transport,
            allowed=model_library.allowed_release_url,
        )
    if model is None or _complete(_model_dir(root, model), model):
        return
    target = _model_dir(root, model)
    if target.exists():
        raise AppError(
            "stt",
            "The folder for this speech model already exists but is incomplete. It was preserved; "
            "move it aside, then try again.",
        )
    model_library.check_cancel(cancel)
    archive = model_library._download_to_temp(
        model.archive.url,
        base,
        model.archive.size,
        model.archive.sha256,
        lambda done: progress("model", done, model.archive.size),
        cancel,
        transport,
        model_library.allowed_release_url,
    )
    staging = Path(tempfile.mkdtemp(dir=base, prefix=".staging-"))
    try:
        try:
            safe_archive.extract_wanted(archive, staging, model.files, cancel)
        finally:
            archive.unlink(missing_ok=True)
        (staging / MARKER).write_text(model.archive.sha256, encoding="utf-8")
        model_library.publish_directory(staging, target, cancel)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
