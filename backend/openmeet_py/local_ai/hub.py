"""Hugging Face GGUF search and file listing for Local AI.

Reads public model metadata only. Searching sends the query to huggingface.co; nothing is
downloaded here. A download is made by the service from the commit listed here, through the
shared model_hub transfer, and is checked against the SHA-256 the listing published.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote

import httpx

from openmeet_py.api.context import byte_len, has_control
from openmeet_py.model_hub import (
    HUB,
    _client_get_json,
    _error,
    _HEX40,
    _HEX64,
    valid_filename,
    valid_repo,
)

SEARCH_LIMIT = 20
MAX_QUERY_BYTES = 100
MAX_GGUF_BYTES = 200 * 1024**3
# A split part, a vision projector and a draft model are not a chat model on their own.
_SPLIT_PART = re.compile(r"-\d{5}-of-\d{5}\.gguf$")
_COMPANIONS = ("mmproj", "draft")
_DAY = re.compile(r"^(\d{4}-\d{2}-\d{2})")


def search(query: str, transport: Optional[httpx.BaseTransport] = None) -> list[dict[str, Any]]:
    """GGUF repositories matching the text, most downloaded first. Gated and private ones are left out."""
    query = query.strip()
    if not query or byte_len(query) > MAX_QUERY_BYTES or has_control(query):
        raise _error("Enter a model search of 1–100 bytes.")
    results = _client_get_json(
        f"{HUB}/api/models",
        {
            "search": query,
            "filter": "gguf",
            "sort": "downloads",
            "direction": "-1",
            "limit": str(SEARCH_LIMIT),
            "full": "true",
        },
        transport,
    )
    if not isinstance(results, list):
        raise _error("The model service returned unsupported metadata.")
    hits: list[dict[str, Any]] = []
    for item in results[:SEARCH_LIMIT]:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        repo = item["id"]
        if not valid_repo(repo) or item.get("private") is True:
            continue
        if item.get("gated") not in (None, False, "false"):
            continue
        hits.append(
            {
                "id": repo,
                "downloads": _count(item.get("downloads")),
                "likes": _count(item.get("likes")),
                "updated": _day(item.get("lastModified")),
            }
        )
    return hits


def files(repo_id: str, transport: Optional[httpx.BaseTransport] = None) -> dict[str, Any]:
    """The standalone GGUF files of one repository, largest first, pinned to its current commit.

    A file needs a published LFS SHA-256, so an unchecked file is not offered.
    """
    if not valid_repo(repo_id):
        raise _error("Invalid model repository or revision.")
    metadata = _client_get_json(f"{HUB}/api/models/{repo_id}", {"blobs": "true"}, transport)
    if not isinstance(metadata, dict):
        raise _error("The model service returned unsupported metadata.")
    revision = metadata.get("sha")
    if not isinstance(revision, str) or not _HEX40.match(revision):
        raise _error("The model service returned unsupported metadata.")
    siblings = metadata.get("siblings")
    if not isinstance(siblings, list):
        siblings = []
    found = [entry for entry in (_standalone_gguf(item) for item in siblings) if entry is not None]
    found.sort(key=lambda entry: (-entry["size_bytes"], entry["filename"]))
    return {"repo_id": repo_id, "revision": revision, "files": found}


def check_pick(
    repo_id: str, revision: str, filename: str, size_bytes: Any, sha256: str
) -> None:
    """Refuses anything that is not one listed-shaped GGUF pinned to a commit with a checksum."""
    if (
        not isinstance(repo_id, str)
        or not valid_repo(repo_id)
        or not isinstance(revision, str)
        or not _HEX40.match(revision)
        or not isinstance(filename, str)
        or not _standalone_name(filename)
        or not isinstance(sha256, str)
        or not _HEX64.match(sha256)
        or not _is_size(size_bytes)
    ):
        raise _error("That model file cannot be downloaded. Search for it again.")


def resolve_url(repo_id: str, revision: str, filename: str) -> str:
    repo = "/".join(quote(part) for part in repo_id.split("/"))
    return f"{HUB}/{repo}/resolve/{revision}/{quote(filename)}"


def managed_path(folder: Path, repo_id: str, filename: str) -> Path:
    """Where a download lands: one folder per owner and repository, so names cannot collide."""
    owner, name = repo_id.split("/", 1)
    return folder / owner / name / filename


def _standalone_name(name: str) -> bool:
    if "/" in name or not name.endswith(".gguf") or not valid_filename(name):
        return False
    if _SPLIT_PART.search(name):
        return False
    return not any(word in name.lower() for word in _COMPANIONS)


def _standalone_gguf(item: Any) -> Optional[dict[str, Any]]:
    if not isinstance(item, dict) or not isinstance(item.get("rfilename"), str):
        return None
    name = item["rfilename"]
    lfs = item.get("lfs")
    if not isinstance(lfs, dict) or not _standalone_name(name):
        return None
    sha = lfs.get("sha256")
    size = lfs.get("size")
    if not isinstance(sha, str) or not _HEX64.match(sha) or not _is_size(size):
        return None
    return {"filename": name, "size_bytes": size, "sha256": sha}


def _is_size(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 < value <= MAX_GGUF_BYTES


def _count(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _day(value: Any) -> Optional[str]:
    match = _DAY.match(value) if isinstance(value, str) else None
    return match.group(1) if match else None
