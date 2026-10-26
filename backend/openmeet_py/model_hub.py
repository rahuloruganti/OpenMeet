"""Shared Hugging Face transfer rules for every model feature (speech and Local AI).

Hosts are allow-listed, redirects are followed by hand with each hop checked, metadata responses are
size-capped, and every download streams to a temporary file, is verified (size and SHA-256), and is
published with a no-clobber link. Nothing here knows about a specific model family.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Optional

import httpx

from openmeet_py.api.errors import AppError


MAX_METADATA = 4 * 1024 * 1024


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
