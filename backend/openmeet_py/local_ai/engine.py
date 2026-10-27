"""The pinned llama.cpp build: download by pinned URL and SHA-256, unpack, find the server program.

One folder per build and backend: `local-ai/engine/<tag>-<backend>/`. The archive is unpacked into a
hidden staging folder and renamed into place only when it is complete, so a failed or cancelled
install never leaves a half-unpacked engine behind. Nothing is downloaded except from a catalog pin,
and only when the user asks.

Two archive shapes are supported: `.zip` for the Windows builds and `.tar.gz` for the macOS build.
Archive rules follow `speech/safe_archive.py`: every member name is validated before anything is
written, special files are refused, duplicates (case folded) are refused, and every member is
size-capped. A link is allowed only when it is a relative symlink resolving inside the destination,
because the macOS tarball names its shared libraries with relative links. Downloads go through the
verified streaming download in `speech/model_library.py`.
"""

from __future__ import annotations

import os
import re
import shutil
import stat
import sys
import tarfile
import tempfile
import threading
import zipfile
from pathlib import Path
from typing import Any, Callable, Optional

from openmeet_py.api.errors import AppError
from openmeet_py.local_ai import catalog as catalog_module
from openmeet_py.speech import model_library, safe_archive

ENGINE_DIR = "engine"
WINDOWS_PROGRAM = "llama-server.exe"
MAC_PROGRAM = "llama-server"
EXECUTABLE_MODE = 0o755
DATA_MODE = 0o644
MAX_MEMBERS = 4096
MAX_MEMBER_BYTES = 1024 * 1024 * 1024
MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024
MAX_SEARCH_DEPTH = 4
CHUNK = 64 * 1024
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:zip|tar\.gz)$", re.IGNORECASE)


def error(message: str) -> AppError:
    return AppError("local_ai_engine", message)


def server_program() -> str:
    """The server's file name here: `llama-server.exe` on Windows, `llama-server` on macOS.

    Other modules build the executable path through this function only, so the extension is
    decided in one place.
    """
    return WINDOWS_PROGRAM if sys.platform == "win32" else MAC_PROGRAM


def folder(base: Path, tag: str, backend: str) -> Path:
    return base / ENGINE_DIR / f"{tag}-{backend}"


def executable(directory: Path) -> Optional[Path]:
    """The server program inside an installed engine folder, or None when the folder is not one."""
    if not directory.is_dir():
        return None
    wanted = server_program().lower()
    found: list[Path] = []
    root = directory.resolve()
    for current, folders, files in os.walk(root):
        depth = len(Path(current).relative_to(root).parts)
        if depth >= MAX_SEARCH_DEPTH:
            folders[:] = []
        for name in files:
            if name.lower() == wanted:
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


def _archive_name(url: str, index: int) -> str:
    """The download file name taken from the pinned URL, or a refusal for an unsupported shape.

    Only the two shapes the catalog pins are accepted, so a mistyped link fails before anything
    is downloaded rather than after.
    """
    name = url.rsplit("/", 1)[-1]
    if not _NAME.match(name):
        raise error("The engine download link is not a supported archive. Nothing was installed.")
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
    _mark_executable(destination)


def extract_archive(archive: Path, destination: Path, cancel: Optional[threading.Event]) -> None:
    """Unpacks one engine archive into destination, choosing the reader by its suffix."""
    if archive.name.lower().endswith(".tar.gz"):
        extract_tar(archive, destination, cancel)
    else:
        extract_zip(archive, destination, cancel)


def extract_tar(archive: Path, destination: Path, cancel: Optional[threading.Event]) -> None:
    """Unpacks one engine .tar.gz into destination. A bad member refuses the whole archive."""
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    seen: set[str] = set()
    declared = 0
    members = 0
    try:
        with tarfile.open(archive, mode="r:gz") as bundle:
            for info in bundle:
                model_library.check_cancel(cancel)
                members += 1
                if members > MAX_MEMBERS:
                    raise error("The engine archive has too many files. Nothing was installed.")
                try:
                    parts = safe_archive.member_parts(info.name)
                except AppError:
                    raise error(
                        "The engine archive contains an unsafe path. Nothing was installed."
                    ) from None
                key = "/".join(parts).casefold()
                if key in seen:
                    raise error("The engine archive contains duplicate paths. Nothing was installed.")
                seen.add(key)
                if info.isdir():
                    continue
                target = root.joinpath(*parts)
                if not _within(target, root):
                    raise error(
                        "The engine archive contains an unsafe path. Nothing was installed."
                    )
                if info.issym():
                    _check_link(info, target, root)
                    _create_link(info, target)
                    continue
                if not info.isreg():
                    raise error(
                        "The engine archive contains a link or a special file. Nothing was installed."
                    )
                declared += info.size
                if info.size > MAX_MEMBER_BYTES or declared > MAX_TOTAL_BYTES:
                    raise error("The engine archive is larger than supported. Nothing was installed.")
                if target.exists():
                    continue  # a second archive of the same build may ship the same library
                target.parent.mkdir(parents=True, exist_ok=True)
                source = bundle.extractfile(info)
                if source is None:
                    raise error("The engine archive could not be unpacked. Nothing was installed.")
                with source:
                    _copy_stream(source, target, info.size, cancel)
    except AppError:
        raise
    except (tarfile.TarError, OSError, EOFError, ValueError, RuntimeError):
        raise error("The engine archive could not be unpacked. Nothing was installed.") from None
    if members == 0:
        raise error("The engine archive was empty. Nothing was installed.")
    _mark_executable(destination)


def _check_link(info: tarfile.TarInfo, target: Path, root: Path) -> None:
    """A symlink is allowed only when it is relative and resolves inside the destination.

    The macOS tarball links shared library names this way, so refusing every link would break the
    install; an absolute link, or one that climbs out, is still refused.
    """
    if not info.linkname or info.linkname.startswith("/") or "\\" in info.linkname:
        raise error(
            "The engine archive contains a link that leaves the destination. Nothing was installed."
        )
    try:
        parts = safe_archive.member_parts(info.linkname)
    except AppError:
        raise error(
            "The engine archive contains a link that leaves the destination. Nothing was installed."
        ) from None
    if not _within(target.parent.joinpath(*parts), root):
        raise error(
            "The engine archive contains a link that leaves the destination. Nothing was installed."
        )


def _create_link(info: tarfile.TarInfo, target: Path) -> None:
    try:
        if os.path.lexists(target):
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(info.linkname, target)
    except OSError as cause:
        raise error("Cannot write the engine files. Check available disk space.") from cause


def _within(target: Path, root: Path) -> bool:
    try:
        target.resolve().relative_to(root)
    except (OSError, ValueError):
        return False
    return True


def _file_mode(name: str) -> int:
    """The mode an extracted file gets: the server and macOS libraries must be executable."""
    lowered = name.lower()
    if lowered == server_program().lower() or lowered.endswith(".dylib"):
        return EXECUTABLE_MODE
    return DATA_MODE


def _mark_executable(destination: Path) -> None:
    """Restores the executable bit the archive format does not carry to every file system.

    macOS needs it on the server and on the libraries it loads. On Windows chmod only clears the
    read-only bit, so this changes nothing there.
    """
    for current, _folders, files in os.walk(destination):
        for name in files:
            path = Path(current) / name
            if path.is_symlink():
                continue
            try:
                os.chmod(path, _file_mode(name))
            except OSError as cause:
                raise error(
                    "Cannot set the engine file permissions. Check the OpenMeet data folder."
                ) from cause


def _copy_member(
    bundle: zipfile.ZipFile, info: zipfile.ZipInfo, target: Path, cancel: Optional[threading.Event]
) -> None:
    with bundle.open(info) as source:
        _copy_stream(source, target, info.file_size, cancel)


def _copy_stream(source: Any, target: Path, size: int, cancel: Optional[threading.Event]) -> None:
    written = 0
    try:
        out = open(target, "xb")
    except OSError as cause:
        raise error("Cannot write the engine files. Check available disk space.") from cause
    with out:
        while True:
            model_library.check_cancel(cancel)
            block = source.read(CHUNK)
            if not block:
                break
            written += len(block)
            if written > size:
                raise error("The engine archive did not match its recorded sizes.")
            try:
                out.write(block)
            except OSError as cause:
                raise error("Cannot write the engine files. Check available disk space.") from cause
    if written != size:
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
    """Downloads and unpacks this PC's pinned engine build. Returns the server program."""
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
        downloaded: list[Path] = []
        done = 0
        for index, entry in enumerate(files):
            model_library.check_cancel(cancel)
            name = _archive_name(entry.url, index)
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
            downloaded.append(archives / name)
            done += entry.size
        progress("verify", total, total)
        package = staging / "package"
        for archive in downloaded:
            model_library.check_cancel(cancel)
            extract_archive(archive, package, cancel)
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
