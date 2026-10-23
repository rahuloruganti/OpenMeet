"""Explicit model discovery, verified downloads and imports.

Files never start an inference server. Every download streams to a temporary file in the
destination folder, is size-capped and SHA-256 verified, fsynced, then published with os.link so an
existing file is never replaced. Only one artifact operation runs at a time.

Network rules: HTTPS only, hosts huggingface.co, *.huggingface.co and *.hf.co, default port, no
credentials, no proxies from the environment, no automatic redirects. Redirects are followed by hand
(at most five) and every hop is checked again. OPENMEET_PY_TEST_HOSTS replaces the host list
(comma-separated) and also allows plain HTTP; it is read only when set and is used by the stub-server
tests on 127.0.0.1.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import threading
from collections import deque
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Optional
from urllib.parse import quote

import httpx

from openmeet_py.api.context import Context, byte_len, has_control, text_arg
from openmeet_py.api.errors import AppError, not_available
from openmeet_py.speech.stt_catalog import WHISPER_MODELS, Artifact

MAX_ENTRIES = 4096
MAX_MODELS = 200
MAX_DEPTH = 6
MAX_METADATA = 4 * 1024 * 1024
MAX_FILE_BYTES = 64 * 1024 * 1024 * 1024
MAX_FOLDER_BYTES = 2 * 1024 * 1024 * 1024
MAX_HUB_ITEMS = 200
MAX_SIBLINGS = 2000
SPEECH_TAG = "automatic-speech-recognition"
HUB = "https://huggingface.co"
CONNECT_TIMEOUT = 15.0
TRANSFER_TIMEOUT = 30 * 60.0
REDIRECT_LIMIT = 5
CHUNK = 64 * 1024
DISK_MARGIN = 64 * 1024 * 1024
TEST_HOSTS_ENV = "OPENMEET_PY_TEST_HOSTS"
REDIRECT_CODES = (301, 302, 303, 307, 308)
WINDOWS_RESERVED = frozenset(
    ["CON", "PRN", "AUX", "NUL"]
    + [f"COM{i}" for i in range(1, 10)]
    + [f"LPT{i}" for i in range(1, 10)]
)

_OPERATION = threading.Lock()
_PUBLICATION = threading.Lock()
_CANCEL = threading.Event()


def _error(message: str) -> AppError:
    return AppError("model_library", message)


def _cancelled() -> AppError:
    return AppError("model_cancelled", "Model operation cancelled. No partial file was activated.")


@contextmanager
def artifact_operation() -> Iterator[threading.Event]:
    """One download, install or import at a time. Yields the cancel event for this operation."""
    if not _OPERATION.acquire(blocking=False):
        raise _error("Another model download or import is running. Wait or cancel it first.")
    try:
        _CANCEL.clear()
        yield _CANCEL
    finally:
        _OPERATION.release()


def cancel_download() -> None:
    with _PUBLICATION:
        _CANCEL.set()


def check_cancel(cancel: Optional[threading.Event]) -> None:
    if cancel is not None and cancel.is_set():
        raise _cancelled()


def managed_folder(root: Path, parts: list[str]) -> Path:
    """Creates root/parts... and refuses links or files along the way."""
    root.mkdir(parents=True, exist_ok=True)
    root = Path(os.path.realpath(root))
    folder = root
    for part in parts:
        folder = folder / part
        if folder.is_symlink() or _is_junction(folder):
            raise _error("A managed model folder is a link or is not a directory. Existing files were preserved.")
        if folder.exists():
            if not folder.is_dir():
                raise _error("A managed model folder is a link or is not a directory. Existing files were preserved.")
        else:
            folder.mkdir()
        if not _within(Path(os.path.realpath(folder)), root):
            raise _error("Managed model folders must stay inside OpenMeet's speech folder.")
    return folder


def _is_junction(path: Path) -> bool:
    check = getattr(path, "is_junction", None)
    return bool(check and check())


def _within(child: Path, root: Path) -> bool:
    try:
        child.relative_to(root)
    except ValueError:
        return False
    return True


# ---- network rules -----------------------------------------------------------------


def _test_hosts() -> Optional[set[str]]:
    raw = os.environ.get(TEST_HOSTS_ENV)
    if raw is None:
        return None
    return {host.strip().lower() for host in raw.split(",") if host.strip()}


def allowed_url(url: httpx.URL) -> bool:
    """True when a request to this URL may be sent. Checked before every hop."""
    if url.username or url.password:
        return False
    host = (url.host or "").lower()
    if not host:
        return False
    hosts = _test_hosts()
    if hosts is not None:
        return url.scheme in ("http", "https") and host in hosts
    if url.scheme != "https" or url.port not in (None, 443):
        return False
    return host == "huggingface.co" or host.endswith(".huggingface.co") or host.endswith(".hf.co")


GITHUB_HOSTS = frozenset({"github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"})


def allowed_release_url(url: httpx.URL) -> bool:
    """True for sherpa-onnx release assets: HTTPS to the GitHub hosts only (test hosts override, as above)."""
    if url.username or url.password:
        return False
    host = (url.host or "").lower()
    hosts = _test_hosts()
    if hosts is not None:
        return url.scheme in ("http", "https") and host in hosts
    return url.scheme == "https" and url.port in (None, 443) and host in GITHUB_HOSTS


def _client(transport: Optional[httpx.BaseTransport]) -> httpx.Client:
    return httpx.Client(
        timeout=httpx.Timeout(TRANSFER_TIMEOUT, connect=CONNECT_TIMEOUT),
        follow_redirects=False,
        trust_env=False,
        transport=transport,
    )


def _open_stream(client: httpx.Client, url: httpx.URL, allowed: Callable[[httpx.URL], bool] = allowed_url) -> httpx.Response:
    """Sends a GET and follows redirects by hand, validating every hop. Caller closes the response."""
    current = url
    for hop in range(REDIRECT_LIMIT + 1):
        if not allowed(current):
            raise _error("The model download redirected to a host that is not allowed. Existing files were preserved.")
        request = client.build_request("GET", current)
        response = client.send(request, stream=True)
        if response.status_code not in REDIRECT_CODES:
            return response
        location = response.headers.get("location")
        response.close()
        if not location or hop >= REDIRECT_LIMIT:
            raise _error("The model download redirected too many times. Existing files were preserved.")
        current = current.join(location)
    raise _error("The model download redirected too many times. Existing files were preserved.")


# ---- verified streaming ------------------------------------------------------------


def _stream_verified(
    chunks: Iterable[bytes],
    folder: Path,
    size: int,
    sha256: str,
    progress: Callable[[int], None],
    cancel: Optional[threading.Event],
) -> Path:
    """Writes chunks to a temporary file in folder and verifies size and SHA-256. Returns its path.

    Any failure removes the temporary file, so nothing partial is left behind.
    """
    handle, name = tempfile.mkstemp(dir=folder, prefix=".model-", suffix=".tmp")
    temp = Path(name)
    try:
        digest = hashlib.sha256()
        done = 0
        with os.fdopen(handle, "wb") as out:
            for chunk in chunks:
                check_cancel(cancel)
                done += len(chunk)
                if done > size:
                    raise _error("The model file is larger than its pinned size.")
                digest.update(chunk)
                try:
                    out.write(chunk)
                except OSError as error:
                    raise _error("Cannot write the model file. Check available disk space.") from error
                progress(done)
            check_cancel(cancel)
            if done != size:
                raise _error("The model file is incomplete. Nothing was activated.")
            out.flush()
            os.fsync(out.fileno())
        if digest.hexdigest() != sha256:
            raise _error("The model checksum did not match. Nothing was activated.")
        return temp
    except BaseException:
        temp.unlink(missing_ok=True)
        raise


def _publish(temp: Path, destination: Path, cancel: Optional[threading.Event]) -> None:
    """No-clobber publish: os.link fails if the destination exists. The temporary name is removed."""
    try:
        with _PUBLICATION:
            check_cancel(cancel)
            try:
                os.link(temp, destination)
            except FileExistsError as error:
                raise _error(
                    "A file already exists at the destination, or publication failed. Existing files "
                    "were preserved. Choose another model or inspect the destination."
                ) from error
            except OSError as error:
                raise _error("Model publication failed. Existing files were preserved.") from error
    finally:
        temp.unlink(missing_ok=True)


def publish_directory(staging: Path, destination: Path, cancel: Optional[threading.Event]) -> None:
    """Renames a finished staging folder into place. Refuses if the destination exists (never overwrites)."""
    with _PUBLICATION:
        check_cancel(cancel)
        if destination.exists():
            raise _error("This folder already exists. It was preserved. Scan local models to inspect it.")
        try:
            os.rename(staging, destination)
        except OSError as error:
            raise _error("Folder publication failed. Existing files were preserved.") from error


def _check_disk(folder: Path, size: int) -> None:
    free = shutil.disk_usage(folder).free
    if free < size + DISK_MARGIN:
        raise _error(
            f"Not enough free disk space for this model: it needs {size // (1024 * 1024)} MB plus "
            f"a safety margin, and {free // (1024 * 1024)} MB is free. Nothing was downloaded."
        )


def fetch_verified(
    url: str,
    folder: Path,
    filename: str,
    size: int,
    sha256: str,
    *,
    progress: Callable[[int], None],
    cancel: Optional[threading.Event],
    transport: Optional[httpx.BaseTransport] = None,
    allowed: Callable[[httpx.URL], bool] = allowed_url,
) -> Path:
    """Downloads one file into folder/filename: verified, no-clobber, no resume. Returns the path."""
    destination = folder / filename
    if destination.exists():
        raise _error("This destination already exists. It was preserved. Scan local models to inspect it.")
    temp = _download_to_temp(url, folder, size, sha256, progress, cancel, transport, allowed)
    _publish(temp, destination, cancel)
    return destination


# ---- local models ------------------------------------------------------------------


def common_folders(home: Path, stt_root: Path) -> list[Path]:
    return [
        stt_root / "models",
        stt_root / "library",
        home / ".cache" / "whisper",
        home / ".cache" / "huggingface" / "hub",
        home / ".ollama" / "models" / "blobs",
        home / ".lmstudio" / "models",
        home / ".cache" / "lm-studio" / "models",
    ]


def _catalog_id(name: str, size: int) -> Optional[str]:
    for entry in WHISPER_MODELS:
        if entry.file == name and entry.size == size:
            return entry.id
    return None


def scan(
    folders: list[Path],
    max_entries: int = MAX_ENTRIES,
    max_models: int = MAX_MODELS,
    max_depth: int = MAX_DEPTH,
) -> dict[str, Any]:
    """Lists model files under each folder within fixed bounds. Links are followed only inside a root."""
    models: list[dict[str, Any]] = []
    report_folders: list[dict[str, str]] = []
    truncated = False
    seen: set[str] = set()
    entries = 0
    for folder in folders:
        status = "Scanned"
        try:
            root = Path(os.path.realpath(folder, strict=True))
        except (OSError, RuntimeError):
            report_folders.append({"path": str(folder), "status": "Missing or inaccessible"})
            continue
        if not root.is_dir():
            report_folders.append({"path": str(folder), "status": "Not a folder"})
            continue
        pending: deque[tuple[Path, int]] = deque([(root, 0)])
        visited = {root}
        while pending:
            directory, depth = pending.popleft()
            try:
                children = list(os.scandir(directory))
            except OSError:
                status = "Some folders inaccessible"
                continue
            for child in children:
                if entries >= max_entries or len(models) >= max_models:
                    truncated = True
                    status = "Scan limit reached"
                    break
                entries += 1
                path = Path(child.path)
                try:
                    resolved: Optional[Path] = Path(os.path.realpath(path, strict=True))
                except (OSError, RuntimeError):
                    resolved = None
                try:
                    is_folder = resolved.is_dir() if resolved is not None else child.is_dir()
                except OSError:
                    is_folder = False
                if is_folder:
                    if resolved is None:
                        status = "Some folders inaccessible"
                        continue
                    if not _within(resolved, root) or resolved in visited:
                        continue
                    visited.add(resolved)
                    if depth < max_depth:
                        pending.append((resolved, depth + 1))
                    else:
                        truncated = True
                        status = "Depth limit reached"
                    continue
                if resolved is None or not _within(resolved, root) or not resolved.is_file():
                    continue
                try:
                    size = resolved.stat().st_size
                    with open(resolved, "rb") as handle:
                        magic = handle.read(4)
                except OSError:
                    continue
                if len(magic) < 4:
                    continue
                name = child.name
                if magic == b"GGUF":
                    fmt = "gguf"
                elif magic in (b"ggml", b"lmgg"):
                    fmt = "whisper"
                elif name.endswith((".bin", ".gguf", ".safetensors")):
                    fmt = "unknown"
                else:
                    continue
                key = str(resolved)
                if key not in seen:
                    seen.add(key)
                    models.append(
                        {"path": key, "format": fmt, "size": size, "model_id": _catalog_id(name, size)}
                    )
            if entries >= max_entries or len(models) >= max_models:
                break
        if entries >= max_entries or len(models) >= max_models:
            truncated = True
            status = "Scan limit reached"
        report_folders.append({"path": str(folder), "status": status})
    models.sort(key=lambda item: item["path"])
    return {"models": models, "folders": report_folders, "truncated": truncated}


def _hash_file(path: Path, cancel: Optional[threading.Event]) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            check_cancel(cancel)
            block = handle.read(CHUNK)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def _file_chunks(path: Path) -> Iterator[bytes]:
    with open(path, "rb") as handle:
        while True:
            block = handle.read(CHUNK)
            if not block:
                return
            yield block


def import_model(root: Path, path: Path) -> dict[str, str]:
    """Copies a pinned Whisper file into the managed models folder after checksum verification.

    The source is read for hashing first and is never modified. The copy is hashed again while it
    is written, so a file that changes mid-import is refused.
    """
    with artifact_operation() as cancel:
        try:
            size = path.stat().st_size
        except OSError as error:
            raise _error("Cannot open that model file. Scan its folder again.") from error
        candidates = [entry for entry in WHISPER_MODELS if entry.size == size]
        if not candidates:
            raise _error(
                "This file does not match a pinned Whisper model size. Other Whisper files can be used in place."
            )
        folder = managed_folder(root, ["models"])
        source_hash = _hash_file(path, cancel)
        approved = next((entry for entry in candidates if entry.sha256 == source_hash), None)
        if approved is None:
            raise _error("The file does not match a pinned Whisper checksum. Existing files were preserved.")
        temp = _stream_verified(_file_chunks(path), folder, approved.size, approved.sha256, lambda _n: None, cancel)
        _publish(temp, folder / approved.file, cancel)
        return {"model_id": approved.id}


# ---- Hugging Face ------------------------------------------------------------------

_HEX40 = re.compile(r"^[0-9a-f]{40}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_REPO_PART = re.compile(r"^[A-Za-z0-9_.-]+$")
_FILE_PART = re.compile(r"^[A-Za-z0-9_\- .]+$")


def valid_repo(repo: str) -> bool:
    if len(repo) > 200 or repo.count("/") != 1:
        return False
    for part in repo.split("/"):
        if not part or part.startswith(".") or part.endswith(".") or not _REPO_PART.match(part):
            return False
    return True


def valid_filename(value: str) -> bool:
    if not value or len(value) > 256:
        return False
    for part in value.split("/"):
        if (
            not part
            or part.startswith(".")
            or part.endswith((".", " "))
            or part.split(".")[0].upper() in WINDOWS_RESERVED
            or not _FILE_PART.match(part)
        ):
            return False
    return True


def _is_ggml(name: str) -> bool:
    return name.startswith("ggml-") and name.endswith(".bin")


def _split_path(path: str) -> tuple[str, str]:
    if "/" in path:
        folder, _, base = path.rpartition("/")
        return folder, base
    return "", path


def _license(card: Any) -> Optional[str]:
    if not isinstance(card, dict):
        return None
    value = card.get("license")
    if not isinstance(value, str) or len(value) > 200 or has_control(value):
        return None
    return value


def sherpa_layout(names: list[str]) -> Optional[tuple[str, list[str]]]:
    """Matches one sherpa-onnx layout by file names. Each role needs exactly one file."""

    def only(predicate: Callable[[str], bool]) -> Optional[str]:
        found = [name for name in names if predicate(name)]
        return found[0] if len(found) == 1 else None

    def onnx(name: str) -> bool:
        return name.endswith(".onnx")

    def onnx_or_ort(name: str) -> bool:
        return onnx(name) or name.endswith(".ort")

    tokens = only(lambda name: name == "tokens.txt")
    if tokens is None:
        return None
    encoder = only(lambda name: name.startswith("encoder") and onnx(name))
    decoder = only(lambda name: name.startswith("decoder") and onnx(name))
    joiner = only(lambda name: name.startswith("joiner") and onnx(name))
    if encoder and decoder and joiner:
        return "transducer", [encoder, decoder, joiner, tokens]
    encoder = only(lambda name: name.startswith("encoder") and onnx_or_ort(name))
    merged = only(lambda name: name.startswith("decoder_model_merged") and onnx_or_ort(name))
    if encoder and merged:
        return "moonshine", [encoder, merged, tokens]
    model = only(lambda name: name.startswith("model") and onnx(name))
    if model is None:
        return None
    return "single_model", [model, tokens]


def _kind_of(names: list[str]) -> str:
    folders: dict[str, list[str]] = {}
    for name in names:
        folder, base = _split_path(name)
        folders.setdefault(folder, []).append(base)
    if any(sherpa_layout(bases) is not None for bases in folders.values()):
        return "sherpa_onnx"
    if any(_is_ggml(_split_path(name)[1]) for name in names):
        return "whisper_ggml"
    return "other"


def _client_get_json(url: str, params: Optional[dict[str, str]], transport: Optional[httpx.BaseTransport]) -> Any:
    try:
        with _client(transport) as client:
            response = _open_stream(client, httpx.URL(url, params=params or {}))
            try:
                if response.status_code < 200 or response.status_code >= 300:
                    raise _error(f"Cannot reach Hugging Face (HTTP {response.status_code}). Retry explicitly.")
                body = bytearray()
                for block in response.iter_bytes(CHUNK):
                    body.extend(block)
                    if len(body) > MAX_METADATA:
                        raise _error("The model listing exceeds the supported response limit.")
            finally:
                response.close()
    except httpx.HTTPError as error:
        raise _error("Cannot reach Hugging Face. Retry explicitly.") from error
    try:
        return json.loads(bytes(body))
    except ValueError as error:
        raise _error("The model service returned unsupported metadata.") from error


def search(query: str, transport: Optional[httpx.BaseTransport] = None) -> list[dict[str, Any]]:
    query = query.strip()
    if not query or byte_len(query) > 100 or has_control(query):
        raise _error("Enter a model search of 1–100 bytes.")
    results = _client_get_json(
        f"{HUB}/api/models",
        {"search": query, "pipeline_tag": SPEECH_TAG, "limit": "20", "full": "true"},
        transport,
    )
    if not isinstance(results, list):
        raise _error("The model service returned unsupported metadata.")
    if len(results) > 20:
        raise _error("Model search returned too many results.")
    hits: list[dict[str, Any]] = []
    for item in results:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        repo = item["id"]
        tag = item.get("pipeline_tag")
        if not valid_repo(repo) or item.get("private") is True:
            continue
        if item.get("gated") not in (None, False, "false"):
            continue
        if tag not in (None, SPEECH_TAG):
            continue
        siblings = item.get("siblings") if isinstance(item.get("siblings"), list) else []
        names = [
            sibling["rfilename"]
            for sibling in siblings
            if isinstance(sibling, dict) and isinstance(sibling.get("rfilename"), str)
            and valid_filename(sibling["rfilename"])
        ]
        hits.append({"id": repo, "license": _license(item.get("cardData")), "kind": _kind_of(names)})
    return hits


def list_files(repo: str, transport: Optional[httpx.BaseTransport] = None, revision: Optional[str] = None) -> dict[str, Any]:
    if not valid_repo(repo) or (revision is not None and not _HEX40.match(revision)):
        raise _error("Invalid model repository or revision.")
    url = f"{HUB}/api/models/{repo}"
    if revision is not None:
        url += f"/revision/{revision}"
    metadata = _client_get_json(url, {"blobs": "true"}, transport)
    if not isinstance(metadata, dict):
        raise _error("The model service returned unsupported metadata.")
    return parse_files(metadata, repo, revision)


def parse_files(metadata: dict[str, Any], repo: str, requested: Optional[str]) -> dict[str, Any]:
    """Turns a Hub model record into whisper files and sherpa folders. Malformed entries are skipped."""
    siblings = metadata.get("siblings") if isinstance(metadata.get("siblings"), list) else []
    gated = metadata.get("gated")
    if (
        metadata.get("id") != repo
        or metadata.get("private") is True
        or gated not in (None, False, "false")
        or len(siblings) > MAX_SIBLINGS
    ):
        raise _error("Only bounded public, ungated model repositories are supported.")
    revision = metadata.get("sha")
    if not isinstance(revision, str) or not _HEX40.match(revision):
        raise _error("The model repository has no pinned commit revision.")
    if requested is not None and requested != revision:
        raise _error("The model revision changed. Refresh its files.")
    license_name = _license(metadata.get("cardData"))
    files: list[dict[str, Any]] = []
    by_folder: dict[str, list[dict[str, Any]]] = {}
    for sibling in siblings:
        if not isinstance(sibling, dict) or not isinstance(sibling.get("rfilename"), str):
            continue
        name_path = sibling["rfilename"]
        lfs = sibling.get("lfs")
        if not valid_filename(name_path) or not isinstance(lfs, dict):
            continue
        size = lfs.get("size")
        sha = lfs.get("sha256")
        if (
            not isinstance(size, int) or isinstance(size, bool)
            or sibling.get("size") != size
            or size < 4
            or size > MAX_FILE_BYTES
            or not isinstance(sha, str)
            or not _HEX64.match(sha)
        ):
            continue
        folder, base = _split_path(name_path)
        catalog = next(
            (
                entry.id
                for entry in WHISPER_MODELS
                if entry.file == base and entry.size == size and entry.sha256 == sha
            ),
            None,
        )
        record = {
            "repo_id": repo,
            "revision": revision,
            "filename": name_path,
            "size": size,
            "sha256": sha,
            "license": license_name,
            "model_id": catalog,
        }
        if _is_ggml(base):
            files.append(record)
        by_folder.setdefault(folder, []).append(record)
    folders: list[dict[str, Any]] = []
    for folder, candidates in by_folder.items():
        layout = sherpa_layout([_split_path(item["filename"])[1] for item in candidates])
        if layout is None:
            continue
        kind, needed = layout
        chosen = [item for item in candidates if _split_path(item["filename"])[1] in needed]
        if sum(item["size"] for item in chosen) > MAX_FOLDER_BYTES:
            continue
        folders.append(
            {
                "repo_id": repo,
                "revision": revision,
                "folder": folder,
                "layout": kind,
                "license": license_name,
                "files": chosen,
            }
        )
    if len(files) > MAX_HUB_ITEMS or len(folders) > MAX_HUB_ITEMS:
        raise _error("This repository has too many supported files. Use a smaller repository.")
    return {"files": files, "folders": folders}


def download_hf_model(
    root: Path,
    proposed: dict[str, Any],
    progress: Callable[[dict[str, int]], None],
    transport: Optional[httpx.BaseTransport] = None,
) -> dict[str, Any]:
    """Downloads one Whisper ggml file the user confirmed. The listing is re-read at its pinned commit."""
    fields = ("repo_id", "revision", "filename", "size", "sha256", "license", "model_id")
    if not isinstance(proposed, dict) or any(key not in proposed for key in fields):
        raise _error("Confirm the model download again.")
    if not isinstance(proposed["repo_id"], str) or not isinstance(proposed["revision"], str):
        raise _error("Confirm the model download again.")
    with artifact_operation() as cancel:
        approved_listing = list_files(proposed["repo_id"], transport, proposed["revision"])
        approved = next(
            (
                item
                for item in approved_listing["files"]
                if all(item.get(key) == proposed.get(key) for key in fields)
            ),
            None,
        )
        if approved is None:
            raise _error("Model metadata changed. Refresh and confirm the download again.")
        check_cancel(cancel)
        folder = managed_folder(root, ["models"])
        filename = approved["filename"].rsplit("/", 1)[-1]
        destination = folder / filename
        if destination.exists():
            raise _error("This destination already exists. It was preserved. Scan local models to inspect it.")
        path = "/".join(quote(part) for part in approved["repo_id"].split("/"))
        url = f"{HUB}/{path}/resolve/{approved['revision']}/" + "/".join(
            quote(part) for part in approved["filename"].split("/")
        )
        temp = _download_to_temp(
            url,
            folder,
            approved["size"],
            approved["sha256"],
            lambda done: progress({"downloaded": done, "total": approved["size"]}),
            cancel,
            transport,
        )
        manifest_name = filename + ".openmeet.json"
        handle, manifest_name_temp = tempfile.mkstemp(dir=folder, prefix=".manifest-", suffix=".tmp")
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            out.write(json.dumps(approved, indent=2))
            out.flush()
            os.fsync(out.fileno())
        manifest_temp = Path(manifest_name_temp)
        try:
            with _PUBLICATION:
                check_cancel(cancel)
                if (folder / manifest_name).exists() or destination.exists():
                    raise _error(
                        "The model destination or manifest already exists. Existing files were preserved."
                    )
                _link_or_fail(temp, destination)
                _link_or_fail(manifest_temp, folder / manifest_name)
        finally:
            temp.unlink(missing_ok=True)
            manifest_temp.unlink(missing_ok=True)
        return {"path": str(destination), "model_id": approved["model_id"]}


def _link_or_fail(source: Path, destination: Path) -> None:
    try:
        os.link(source, destination)
    except FileExistsError as error:
        raise _error("Model publication failed. Existing files were preserved.") from error
    except OSError as error:
        raise _error("Model publication failed. Existing files were preserved.") from error


def _download_to_temp(
    url: str,
    folder: Path,
    size: int,
    sha256: str,
    progress: Callable[[int], None],
    cancel: Optional[threading.Event],
    transport: Optional[httpx.BaseTransport],
    allowed: Callable[[httpx.URL], bool] = allowed_url,
) -> Path:
    """Streams one pinned file to a verified temporary file in folder. The caller publishes it."""
    _check_disk(folder, size)
    with _client(transport) as client:
        try:
            response = _open_stream(client, httpx.URL(url), allowed)
        except httpx.HTTPError as error:
            raise _error("Cannot download this model. Existing files were preserved.") from error
        try:
            if response.status_code < 200 or response.status_code >= 300:
                raise _error(f"The model server returned HTTP {response.status_code}. Existing files were preserved.")
            declared = response.headers.get("content-length")
            if declared is not None and declared.isdigit() and int(declared) != size:
                raise _error("The model download size differs from its pinned metadata.")
            try:
                return _stream_verified(response.iter_bytes(CHUNK), folder, size, sha256, progress, cancel)
            except httpx.HTTPError as error:
                raise _error("Model transfer interrupted. Retry explicitly; existing files were preserved.") from error
        finally:
            response.close()


CUSTOM_FOLDER_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
FOLDER_MANIFEST = "openmeet-source.json"


def folder_name(folder: dict[str, Any]) -> str:
    """Name under sherpa/custom: repo--folder, with / replaced by --."""
    repo = folder["repo_id"].replace("/", "--")
    return repo if not folder["folder"] else f"{repo}--{folder['folder'].replace('/', '--')}"


def download_hf_folder(
    root: Path,
    proposed: dict[str, Any],
    progress: Callable[[dict[str, int]], None],
    transport: Optional[httpx.BaseTransport] = None,
) -> dict[str, Any]:
    """All-or-nothing download of a sherpa-onnx folder the user confirmed.

    The listing is re-read at the pinned revision and must equal the confirmed folder. Every file is
    streamed to a verified temporary file in a hidden staging folder; the folder is renamed into
    sherpa/custom only after the last checksum passed. Any failure removes the staging folder.
    """
    fields = ("repo_id", "revision", "folder", "layout", "license", "files")
    if not isinstance(proposed, dict) or any(key not in proposed for key in fields):
        raise _error("Confirm the model download again.")
    if not isinstance(proposed["repo_id"], str) or not isinstance(proposed["revision"], str):
        raise _error("Confirm the model download again.")
    with artifact_operation() as cancel:
        listing = list_files(proposed["repo_id"], transport, proposed["revision"])
        approved = next((folder for folder in listing["folders"] if folder == proposed), None)
        if approved is None:
            raise _error("Model metadata changed. Refresh and confirm the download again.")
        check_cancel(cancel)
        name = folder_name(approved)
        if not CUSTOM_FOLDER_RE.match(name) or name.startswith(".") or ".." in name:
            raise _error("This folder name cannot be stored. Choose another model.")
        custom = managed_folder(root, ["sherpa", "custom"])
        destination = custom / name
        if destination.exists():
            raise _error("This folder already exists. It was preserved. Scan local models to inspect it.")
        total = sum(item["size"] for item in approved["files"])
        _check_disk(custom, total)
        staging = Path(tempfile.mkdtemp(dir=custom, prefix=".staging-"))
        try:
            done = 0
            for item in approved["files"]:
                filename = item["filename"].rsplit("/", 1)[-1]
                path = "/".join(quote(part) for part in approved["repo_id"].split("/"))
                url = f"{HUB}/{path}/resolve/{approved['revision']}/" + "/".join(
                    quote(part) for part in item["filename"].split("/")
                )
                temp = _download_to_temp(
                    url,
                    staging,
                    item["size"],
                    item["sha256"],
                    lambda n, base=done: progress({"downloaded": base + n, "total": total}),
                    cancel,
                    transport,
                    allowed_url,
                )
                _publish(temp, staging / filename, cancel)
                done += item["size"]
            (staging / FOLDER_MANIFEST).write_text(json.dumps(approved, indent=2), encoding="utf-8")
            publish_directory(staging, destination, cancel)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
    return {"path": str(destination), "files": len(approved["files"]), "model_id": f"sherpa-dir:{name}"}


# ---- command handlers ----------------------------------------------------------------


def choose_model_folder(ctx: Context) -> Optional[str]:
    if ctx.pick_folder is None:
        raise not_available("Choosing a folder")
    return ctx.pick_folder()


def scan_local_models(ctx: Context, folder: Any) -> dict[str, Any]:
    from openmeet_py.speech.stt import stt_root

    if folder is None:
        folders = common_folders(Path.home(), stt_root(ctx))
    else:
        folders = [Path(text_arg(folder, "folder"))]
    return scan(folders)


def import_local_model(ctx: Context, path: Any) -> dict[str, str]:
    from openmeet_py.speech.stt import stt_root

    return import_model(stt_root(ctx), Path(text_arg(path, "path")))


def search_hf_models(ctx: Context, query: Any) -> list[dict[str, Any]]:
    return search(text_arg(query, "query"), ctx.transport)


def list_hf_files(ctx: Context, repo_id: Any) -> dict[str, Any]:
    return list_files(text_arg(repo_id, "repo_id"), ctx.transport)


def download_hf_model_command(ctx: Context, file: Any) -> dict[str, Any]:
    from openmeet_py.speech.stt import stt_root

    if not isinstance(file, dict):
        raise AppError("invalid_args", "file must be an object.")
    return download_hf_model(
        stt_root(ctx),
        file,
        lambda progress: ctx.emit("model_library_progress", progress),
        ctx.transport,
    )


def cancel_model_download(ctx: Context) -> None:
    cancel_download()


def download_hf_folder_command(ctx: Context, folder: Any) -> dict[str, Any]:
    from openmeet_py.speech.stt import stt_root

    if not isinstance(folder, dict):
        raise AppError("invalid_args", "folder must be an object.")
    return download_hf_folder(
        stt_root(ctx),
        folder,
        lambda progress: ctx.emit("model_library_progress", progress),
        ctx.transport,
    )
