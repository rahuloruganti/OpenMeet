"""The pinned llama.cpp build: download by pinned URL and SHA-256, unpack, find llama-server.exe.

One folder per build and backend: `local-ai/engine/<tag>-<backend>/`. The archive is unpacked into a
hidden staging folder and renamed into place only when it is complete, so a failed or cancelled
install never leaves a half-unpacked engine behind. Nothing is downloaded except from a catalog pin,
and only when the user asks.

Archive rules follow `speech/safe_archive.py`: every member name is validated before anything is
written, links and special files are refused, duplicates (case folded) are refused, and every
member is size-capped. Downloads go through the verified streaming download in
`speech/model_library.py`.
"""

from __future__ import annotations

import os
import re
import shutil
import stat
import tempfile
import threading
import zipfile
from pathlib import Path
from typing import Any, Callable, Optional

from openmeet_py.api.errors import AppError
from openmeet_py.local_ai import catalog as catalog_module
from openmeet_py.speech import model_library, safe_archive

ENGINE_DIR = "engine"
SERVER_PROGRAM = "llama-server.exe"
MAX_MEMBERS = 4096
MAX_MEMBER_BYTES = 1024 * 1024 * 1024
MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024
MAX_SEARCH_DEPTH = 4
CHUNK = 64 * 1024
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$")


def error(message: str) -> AppError:
    return AppError("local_ai_engine", message)


def folder(base: Path, tag: str, backend: str) -> Path:
    return base / ENGINE_DIR / f"{tag}-{backend}"


def executable(directory: Path) -> Optional[Path]:
    """llama-server.exe inside an installed engine folder, or None when the folder is not one."""
    if not directory.is_dir():
        return None
    found: list[Path] = []
    root = directory.resolve()
    for current, folders, files in os.walk(root):
        depth = len(Path(current).relative_to(root).parts)
        if depth >= MAX_SEARCH_DEPTH:
            folders[:] = []
        for name in files:
            if name.lower() == SERVER_PROGRAM:
                found.append(Path(current) / name)
    return found[0] if len(found) == 1 else None


def installed(base: Path, tag: str, backend: str) -> bool:
    return executable(folder(base, tag, backend)) is not None


def server_executable(base: Path, tag: str, backend: str) -> Path:
    program = executable(folder(base, tag, backend))
    if program is None:
        raise error("The Local AI engine is not installed. Install it in Settings first.")
    return program


def missing_bytes(catalog: catalog_module.Catalog, backend: str, base: Path) -> int:
    """Bytes still to download for this PC's backend; 0 once the engine is installed."""
    if installed(base, catalog.engine.tag, backend):
        return 0
    return sum(entry.size for entry in catalog.engine.files(backend))


def _zip_name(url: str, index: int) -> str:
    name = url.rsplit("/", 1)[-1]
    if not _NAME.match(name):
        return f"engine-{index}.zip"
    return name


def _member_type(info: zipfile.ZipInfo) -> int:
    """The POSIX file-type bits of a zip member, or 0 when the archive records none.

    Archives written on Windows leave the attributes empty, and Python's own writestr records only
    permission bits; neither carries a type, so 0 is treated as a regular file.
    """
    return stat.S_IFMT(info.external_attr >> 16) if info.external_attr else 0


def extract_zip(archive: Path, destination: Path, cancel: Optional[threading.Event]) -> None:
    """Unpacks one engine archive into destination. A bad member refuses the whole archive."""
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    seen: set[str] = set()
    declared = 0
    members = 0
    try:
        with zipfile.ZipFile(archive) as bundle:
            infos = bundle.infolist()
            if len(infos) > MAX_MEMBERS:
                raise error("The engine archive has too many files. Nothing was installed.")
            for info in infos:
                model_library.check_cancel(cancel)
                members += 1
                try:
                    parts = safe_archive.member_parts(info.filename)
                except AppError:
                    raise error(
                        "The engine archive contains an unsafe path. Nothing was installed."
                    ) from None
                key = "/".join(parts).casefold()
                if key in seen:
                    raise error("The engine archive contains duplicate paths. Nothing was installed.")
                seen.add(key)
                if info.is_dir():
                    continue
                kind = _member_type(info)
                if kind not in (0, stat.S_IFREG):
                    raise error(
                        "The engine archive contains a link or a special file. Nothing was installed."
                    )
                declared += info.file_size
                if info.file_size > MAX_MEMBER_BYTES or declared > MAX_TOTAL_BYTES:
                    raise error("The engine archive is larger than supported. Nothing was installed.")
                target = root.joinpath(*parts)
                if not _within(target, root):
                    raise error(
                        "The engine archive contains an unsafe path. Nothing was installed."
                    )
                if target.exists():
                    continue  # a second archive of the same build may ship the same DLL
                target.parent.mkdir(parents=True, exist_ok=True)
                _copy_member(bundle, info, target, cancel)
    except AppError:
        raise
    except (zipfile.BadZipFile, OSError, EOFError, ValueError, RuntimeError):
        raise error("The engine archive could not be unpacked. Nothing was installed.") from None
    if members == 0:
        raise error("The engine archive was empty. Nothing was installed.")


def _within(target: Path, root: Path) -> bool:
    try:
        target.resolve().relative_to(root)
    except (OSError, ValueError):
        return False
    return True


def _copy_member(
    bundle: zipfile.ZipFile, info: zipfile.ZipInfo, target: Path, cancel: Optional[threading.Event]
) -> None:
    written = 0
    try:
        out = open(target, "xb")
    except OSError as cause:
        raise error("Cannot write the engine files. Check available disk space.") from cause
    with out, bundle.open(info) as source:
        while True:
            model_library.check_cancel(cancel)
            block = source.read(CHUNK)
            if not block:
                break
            written += len(block)
            if written > info.file_size:
                raise error("The engine archive did not match its recorded sizes.")
            try:
                out.write(block)
            except OSError as cause:
                raise error("Cannot write the engine files. Check available disk space.") from cause
    if written != info.file_size:
        raise error("The engine archive did not match its recorded sizes.")


def install(
    base: Path,
    backend: str,
    catalog: catalog_module.Catalog,
    progress: Callable[[str, int, int], None],
    cancel: Optional[threading.Event],
    transport: Any = None,
    fetch: Optional[Callable[..., Path]] = None,
) -> Path:
    """Downloads and unpacks this PC's pinned engine build. Returns llama-server.exe."""
    engine = catalog.engine
    files = engine.files(backend)
    if not files:
        raise error("This build has no Local AI engine for this graphics type.")
    destination = folder(base, engine.tag, backend)
    found = executable(destination)
    if found is not None:
        return found
    parent = base / ENGINE_DIR
    parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(dir=parent, prefix=".staging-"))
    downloads = fetch or model_library.fetch_verified
    total = sum(entry.size for entry in files)
    try:
        archives = staging / "archives"
        archives.mkdir()
        done = 0
        for index, entry in enumerate(files):
            model_library.check_cancel(cancel)
            name = _zip_name(entry.url, index)
            downloads(
                entry.url,
                archives,
                name,
                entry.size,
                entry.sha256,
                progress=lambda written, base_bytes=done, size=entry.size: progress(
                    "download", base_bytes + written, total
                ),
                cancel=cancel,
                transport=transport,
                allowed=model_library.allowed_release_url,
            )
            done += entry.size
        progress("verify", total, total)
        package = staging / "package"
        for archive in sorted(archives.glob("*.zip")):
            model_library.check_cancel(cancel)
            extract_zip(archive, package, cancel)
        progress("extract", total, total)
        program = executable(package)
        if program is None:
            raise error("The engine download did not contain llama-server. Nothing was installed.")
        if destination.exists():
            raise error(
                "A previous engine folder is incomplete. Delete it in the OpenMeet data folder "
                "and install again."
            )
        os.rename(package, destination)
        return server_executable(base, engine.tag, backend)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
