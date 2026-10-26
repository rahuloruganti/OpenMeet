"""Hugging Face GGUF search and listing for Local AI, over httpx.MockTransport only."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import httpx
import pytest

from openmeet_py.api.errors import AppError
from openmeet_py.local_ai import hub

REVISION = "b" * 40


def sha_of(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def serve(payload: Any, requests: list[httpx.Request]) -> httpx.MockTransport:
    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=payload)

    return httpx.MockTransport(handle)


def sibling(name: str, size: int = 1000, lfs: bool = True) -> dict[str, Any]:
    entry: dict[str, Any] = {"rfilename": name, "size": size}
    if lfs:
        entry["lfs"] = {"sha256": sha_of(name), "size": size}
    return entry


# ---- search -----------------------------------------------------------------------


def test_search_asks_for_gguf_repos_sorted_by_downloads() -> None:
    requests: list[httpx.Request] = []
    assert hub.search("qwen coder", serve([], requests)) == []
    url = requests[0].url
    assert url.host == "huggingface.co" and url.path == "/api/models"
    assert dict(url.params.items()) == {
        "search": "qwen coder",
        "filter": "gguf",
        "sort": "downloads",
        "direction": "-1",
        "limit": "20",
        "full": "true",
    }


def test_search_keeps_open_repos_with_their_counts_and_update_day() -> None:
    payload = [
        {
            "id": "owner/open-GGUF",
            "downloads": 10,
            "likes": 2,
            "lastModified": "2025-01-05T10:00:00.000Z",
            "gated": False,
            "private": False,
        }
    ]
    assert hub.search("open", serve(payload, [])) == [
        {"id": "owner/open-GGUF", "downloads": 10, "likes": 2, "updated": "2025-01-05"}
    ]


def test_search_drops_gated_private_malformed_and_unsafe_repos() -> None:
    payload = [
        {"id": "owner/gated", "downloads": 99, "gated": "manual", "private": False},
        {"id": "owner/secret", "downloads": 98, "gated": False, "private": True},
        {"id": "../escape", "downloads": 97, "gated": False, "private": False},
        {"downloads": 96},
        "not a repo",
    ]
    assert hub.search("x", serve(payload, [])) == []


def test_search_refuses_an_empty_control_or_oversized_query_without_asking() -> None:
    requests: list[httpx.Request] = []
    for query in ("", "   ", "bad\nquery", "x" * 101):
        with pytest.raises(AppError):
            hub.search(query, serve([], requests))
    assert requests == []


def test_search_refuses_a_response_that_is_not_a_list() -> None:
    with pytest.raises(AppError) as caught:
        hub.search("qwen", serve({"error": "nope"}, []))
    assert caught.value.code == "model_library"


# ---- listing ----------------------------------------------------------------------


def test_files_keep_standalone_gguf_files_largest_first_pinned_to_the_commit() -> None:
    payload = {
        "sha": REVISION,
        "siblings": [
            sibling("tiny-Q4_K_M.gguf", size=2_000),
            sibling("tiny-Q8_0.gguf", size=8_000),
            sibling("README.md", size=10, lfs=False),
            sibling("mmproj-tiny.gguf", size=500),
            sibling("tiny-draft-Q4.gguf", size=600),
            sibling("tiny-f16-00001-of-00002.gguf", size=9_000),
            sibling("subfolder/tiny-Q2.gguf", size=100),
            {"rfilename": "no-lfs.gguf", "size": 100},
            {"rfilename": "bad-sha.gguf", "size": 100, "lfs": {"sha256": "xyz", "size": 100}},
        ],
    }
    requests: list[httpx.Request] = []
    listing = hub.files("owner/tiny", serve(payload, requests))
    assert listing["repo_id"] == "owner/tiny" and listing["revision"] == REVISION
    assert [entry["filename"] for entry in listing["files"]] == [
        "tiny-Q8_0.gguf",
        "tiny-Q4_K_M.gguf",
    ]
    assert listing["files"][0] == {
        "filename": "tiny-Q8_0.gguf",
        "size_bytes": 8_000,
        "sha256": sha_of("tiny-Q8_0.gguf"),
    }
    url = requests[0].url
    assert url.path == "/api/models/owner/tiny" and url.params["blobs"] == "true"


def test_files_refuse_a_listing_without_a_commit() -> None:
    with pytest.raises(AppError):
        hub.files("owner/tiny", serve({"siblings": []}, []))


def test_files_refuse_an_invalid_repo_without_a_request() -> None:
    requests: list[httpx.Request] = []
    with pytest.raises(AppError):
        hub.files("../etc", serve({}, requests))
    assert requests == []


# ---- the pick a download is made from ---------------------------------------------


def test_a_pick_is_one_standalone_gguf_pinned_to_a_commit_with_a_checksum() -> None:
    good = {
        "repo_id": "owner/tiny",
        "revision": REVISION,
        "filename": "tiny-Q8_0.gguf",
        "size_bytes": 8_000,
        "sha256": sha_of("tiny-Q8_0.gguf"),
    }
    hub.check_pick(**good)
    bad_values = [
        ("repo_id", "no-slash"),
        ("revision", "main"),
        ("filename", "tiny.bin"),
        ("filename", "subfolder/tiny.gguf"),
        ("filename", "tiny-00001-of-00002.gguf"),
        ("filename", "mmproj-tiny.gguf"),
        ("sha256", "abc"),
        ("size_bytes", 0),
        ("size_bytes", True),
    ]
    for field, value in bad_values:
        with pytest.raises(AppError):
            hub.check_pick(**{**good, field: value})


def test_the_download_url_is_the_pinned_commit_on_the_hub() -> None:
    assert (
        hub.resolve_url("owner/tiny", REVISION, "tiny Q8.gguf")
        == f"https://huggingface.co/owner/tiny/resolve/{REVISION}/tiny%20Q8.gguf"
    )


def test_downloads_are_kept_in_one_folder_per_repo(tmp_path: Path) -> None:
    assert hub.managed_path(tmp_path, "owner/tiny", "tiny.gguf") == (
        tmp_path / "owner" / "tiny" / "tiny.gguf"
    )
