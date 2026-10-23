"""Safe extraction of pinned sherpa-onnx .tar.bz2 archives (sherpa.rs extract, with stricter checks).

Every member is validated before any file is written, so one bad member refuses the whole archive:
absolute or drive-prefixed names, backslashes, colons, empty or ".." parts, duplicate paths (case
folded), links, devices, FIFOs and other non-regular members, and too many members or too many
declared bytes. Only the wanted basenames are written, each with exclusive create into a staging
folder that the caller renames into place. Nothing is written outside the destination.
"""

from __future__ import annotations

import re
import tarfile
import threading
from pathlib import Path
from typing import Iterable, Optional

from .errors import AppError
from .model_library import check_cancel

MAX_MEMBERS = 4096
MAX_MEMBER_BYTES = 2 * 1024 * 1024 * 1024  # Rust: 2 GiB per wanted file
MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024  # declared bytes across every member
MAX_NAME_CHARS = 1024
CHUNK = 64 * 1024
_DRIVE = re.compile(r"^[A-Za-z]:")
_FILE_TYPES = (tarfile.REGTYPE, tarfile.AREGTYPE)


def _unreadable() -> AppError:
    return AppError("stt", "A downloaded speech archive could not be read.")


def _unsafe() -> AppError:
    return AppError("stt", "A downloaded speech archive contains an unsafe path or entry. Nothing was extracted.")


def member_parts(name: str) -> list[str]:
    """Relative path parts of a member name, or raise if it could leave the destination folder."""
    if (
        not name
        or len(name) > MAX_NAME_CHARS
        or name.startswith("/")
        or "\\" in name
        or ":" in name
        or "\x00" in name
        or _DRIVE.match(name)
    ):
        raise _unsafe()
    parts = name.split("/")
    if parts[-1] == "":  # a directory entry ends with "/"
        parts = parts[:-1]
    if not parts or any(part in ("", "..") for part in parts):
        raise _unsafe()
    return [part for part in parts if part != "."]


def extract_wanted(
    archive: Path,
    destination: Path,
    wanted: Iterable[str],
    cancel: Optional[threading.Event] = None,
) -> None:
    """Copies the wanted basenames from a .tar.bz2 into destination. Raises if any is missing.

    Raises AppError for every refused archive. Any bytes already written are left for the caller to
    remove together with the staging folder.
    """
    names = tuple(wanted)
    found: set[str] = set()
    paths: set[str] = set()
    members = 0
    declared = 0
    try:
        with tarfile.open(archive, mode="r:bz2") as tar:
            for member in tar:
                check_cancel(cancel)
                members += 1
                if members > MAX_MEMBERS:
                    raise _unsafe()
                parts = member_parts(member.name)
                key = "/".join(parts).casefold()
                if key in paths:
                    raise _unsafe()
                paths.add(key)
                if member.type == tarfile.DIRTYPE:
                    continue
                if member.type not in _FILE_TYPES:
                    raise _unsafe()  # symlink, hard link, device, FIFO or anything else
                declared += member.size
                if member.size > MAX_MEMBER_BYTES or declared > MAX_TOTAL_BYTES:
                    raise _unsafe()
                name = parts[-1]
                if name not in names:
                    continue
                if name in found:
                    raise _unsafe()  # two wanted files with one name: ambiguous, refuse
                source = tar.extractfile(member)
                if source is None:
                    raise _unreadable()
                _copy_member(source, destination / name, member.size, cancel)
                found.add(name)
    except AppError:
        raise
    except (tarfile.TarError, EOFError, ValueError, OSError, RuntimeError):
        raise _unreadable() from None
    if any(name not in found for name in names):
        raise AppError("stt", "A downloaded speech archive did not contain the expected files.")


def _copy_member(source, target: Path, size: int, cancel: Optional[threading.Event]) -> None:
    copied = 0
    try:
        out = open(target, "xb")  # exclusive create: never overwrites inside the staging folder
    except OSError as error:
        raise AppError("stt", "Cannot write the speech model files. Check available disk space.") from error
    with out:
        while True:
            check_cancel(cancel)
            block = source.read(CHUNK)
            if not block:
                break
            copied += len(block)
            if copied > size:
                raise _unsafe()
            try:
                out.write(block)
            except OSError as error:
                raise AppError("stt", "Cannot write the speech model files. Check available disk space.") from error
    if copied != size:
        raise _unreadable()
