"""The pinned Local AI catalog: engine builds and GGUF models, plus the fit rules the UI shows.

`catalog.json` sits next to this module and is bundled with the app. Its pins (release tag, file
sizes, SHA-256, revisions) are verified data: nothing here invents, edits or downloads them.

Fit for one model:
    need = size_bytes + context_tokens * kv_bytes_per_token + 600 MiB overhead
    gpu      need <= 0.9 * VRAM
    ram      need <= 0.9 * VRAM + 0.7 * available RAM     (slower: part runs from system memory)
    too_big  neither

Without a readable GPU there is no "gpu" fit, so a model is either "ram" or "too big".
The recommended model is the best-quality one that fits the GPU; if none does, the best-quality
one under 6 GB that fits RAM; if none does, nothing is recommended.

Engine backends are `cuda`, `vulkan`, `cpu` and `metal`. On macOS the probe reports unified memory
as `vram_bytes`, so the fit rules and `offload_layers` below apply unchanged there.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from openmeet_py.api.errors import AppError

MIB = 1024 * 1024
CATALOG_FILE = "catalog.json"
FIT_KINDS = ("gpu", "ram", "too_big")
OVERHEAD_BYTES = 600 * MIB
GPU_SHARE = 0.9
RAM_SHARE = 0.7
FULL_OFFLOAD_LAYERS = 999
# A .gguf found on this PC carries no per-model KV figure, so this generic one is used instead.
FILE_KV_BYTES_PER_TOKEN = 131072
MAX_MODELS = 50
MAX_ENGINE_FILES = 4
# The only archive shapes an engine pin may name: Windows zips and the macOS tarball.
ENGINE_SUFFIXES = (".zip", ".tar.gz")
_HEX40 = re.compile(r"^[0-9a-f]{40}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def _broken(detail: str) -> AppError:
    return AppError(
        "local_ai_catalog",
        f"The Local AI catalog is unreadable ({detail}). Reinstall OpenMeet; existing files were kept.",
    )


@dataclass(frozen=True)
class EngineFile:
    url: str
    size: int
    sha256: str


@dataclass(frozen=True)
class Engine:
    tag: str
    backends: dict[str, tuple[EngineFile, ...]] = field(default_factory=dict)

    def files(self, backend: str) -> tuple[EngineFile, ...]:
        return self.backends.get(backend, ())


@dataclass(frozen=True)
class Model:
    id: str
    name: str
    description: str
    repo: str
    revision: str
    file: str
    size_bytes: int
    sha256: str
    license: Optional[str]
    n_layers: int
    kv_bytes_per_token: int
    quality: int


@dataclass(frozen=True)
class Catalog:
    context_tokens: int
    engine: Engine
    models: tuple[Model, ...] = ()

    def model(self, model_id: str) -> Optional[Model]:
        return next((entry for entry in self.models if entry.id == model_id), None)


def catalog_path() -> Path:
    """catalog.json beside this module. The build bundles it into openmeet_py/local_ai."""
    return Path(__file__).with_name(CATALOG_FILE)


def _text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise _broken(name)
    return value


def _size(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise _broken(name)
    return value


def _engine(raw: Any) -> Engine:
    if not isinstance(raw, dict):
        raise _broken("engine")
    tag = _text(raw.get("tag"), "engine tag")
    backends = raw.get("backends")
    if not isinstance(backends, dict) or not backends:
        raise _broken("engine backends")
    parsed: dict[str, tuple[EngineFile, ...]] = {}
    for backend, entries in backends.items():
        if not isinstance(backend, str) or not backend or not isinstance(entries, list):
            raise _broken("engine backend")
        if not entries or len(entries) > MAX_ENGINE_FILES:
            raise _broken(f"{backend} engine files")
        files = []
        for entry in entries:
            if not isinstance(entry, dict):
                raise _broken(f"{backend} engine file")
            url = _text(entry.get("url"), "engine url")
            sha = _text(entry.get("sha256"), "engine checksum")
            if (
                not url.lower().startswith("https://")
                or unsafe_text(url)
                or not url.lower().endswith(ENGINE_SUFFIXES)
                or not _HEX64.match(sha)
            ):
                raise _broken(f"{backend} engine file")
            files.append(EngineFile(url=url, size=_size(entry.get("size"), "engine size"), sha256=sha))
        parsed[backend] = tuple(files)
    return Engine(tag=tag, backends=parsed)


def unsafe_text(value: str) -> bool:
    """A URL or name with whitespace or control characters is refused before it is used."""
    return any(character.isspace() or ord(character) < 0x20 for character in value)


def _model(raw: Any) -> Model:
    if not isinstance(raw, dict):
        raise _broken("model")
    model_id = _text(raw.get("id"), "model id")
    if unsafe_text(model_id) or "/" in model_id or ":" in model_id:
        raise _broken(f"model id {model_id}")
    revision = _text(raw.get("revision"), "model revision")
    sha = _text(raw.get("sha256"), "model checksum")
    repo = _text(raw.get("repo"), "model repo")
    filename = _text(raw.get("file"), "model file")
    if not _HEX40.match(revision) or not _HEX64.match(sha):
        raise _broken(model_id)
    if repo.count("/") != 1 or unsafe_text(repo) or "/" in filename or unsafe_text(filename):
        raise _broken(model_id)
    license_name = raw.get("license")
    if license_name is not None and not isinstance(license_name, str):
        raise _broken(model_id)
    return Model(
        id=model_id,
        name=_text(raw.get("name"), "model name"),
        description=str(raw.get("description") or ""),
        repo=repo,
        revision=revision,
        file=filename,
        size_bytes=_size(raw.get("size_bytes"), "model size"),
        sha256=sha,
        license=license_name,
        n_layers=_size(raw.get("n_layers"), "model layers"),
        kv_bytes_per_token=_size(raw.get("kv_bytes_per_token"), "model kv bytes"),
        quality=int(raw.get("quality") or 0),
    )


def parse(raw: Any) -> Catalog:
    """Validates one catalog record. Malformed pins are refused rather than guessed."""
    if not isinstance(raw, dict):
        raise _broken("root")
    context_tokens = _size(raw.get("context_tokens"), "context length")
    engine = _engine(raw.get("engine"))
    models = raw.get("models")
    if not isinstance(models, list) or not models or len(models) > MAX_MODELS:
        raise _broken("models")
    parsed = tuple(_model(entry) for entry in models)
    if len({entry.id for entry in parsed}) != len(parsed):
        raise _broken("duplicate model ids")
    if len({entry.file for entry in parsed}) != len(parsed):
        raise _broken("duplicate model files")
    return Catalog(context_tokens=context_tokens, engine=engine, models=parsed)


@lru_cache(maxsize=1)
def load() -> Catalog:
    """The bundled catalog, read once. Tests replace this function, never the file."""
    try:
        raw = json.loads(catalog_path().read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise _broken("file missing") from error
    return parse(raw)


def needs_bytes(size_bytes: int, kv_bytes_per_token: int, context_tokens: int) -> int:
    """Memory a model needs with its context: weights, KV cache and the runtime's own overhead."""
    return size_bytes + context_tokens * kv_bytes_per_token + OVERHEAD_BYTES


def fit(need: int, hardware: dict[str, Any]) -> str:
    """gpu, ram or too_big for a memory need, using this PC's VRAM and available RAM.

    Unchanged for `metal`: unified memory arrives as `vram_bytes`, and the shares still apply.
    """
    vram = hardware.get("vram_bytes") or 0
    available = hardware.get("ram_available_bytes") or 0
    gpu_limit = GPU_SHARE * vram
    if vram > 0 and need <= gpu_limit:
        return "gpu"
    if need <= gpu_limit + RAM_SHARE * available:
        return "ram"
    return "too_big"


def offload_layers(model: Model, fit_kind: str, vram_bytes: Optional[int]) -> int:
    """GPU layers to offload: all of them when the model fits VRAM, else the share VRAM covers.

    Unchanged for `metal`; the Apple GPU shares memory with the CPU, so the same split holds.
    """
    if fit_kind == "gpu":
        return FULL_OFFLOAD_LAYERS
    if not vram_bytes or vram_bytes <= 0 or model.size_bytes <= 0:
        return 0
    return max(0, int(model.n_layers * GPU_SHARE * vram_bytes / model.size_bytes))
