"""Local AI's Hugging Face search and download, through the API, with fakes only.

No network: every request goes to httpx.MockTransport. Downloads are a few bytes, the engine is never
installed and no GPU is probed.
"""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path
from typing import Any, Callable, Optional

import httpx
import pytest
from fastapi.testclient import TestClient

from conftest import invoke, invoke_error
from openmeet_py.api.commands import COMMANDS
from openmeet_py.local_ai import catalog, hardware, service
from test_local_ai_commands import CPU_ONLY, PAYLOAD, tiny_catalog

GiB = 1024**3
REVISION = "b" * 40
SHA = hashlib.sha256(PAYLOAD).hexdigest()
SEARCH_HITS = [
    {
        "id": "owner/tiny-GGUF",
        "downloads": 1234,
        "likes": 5,
        "lastModified": "2025-01-05T10:00:00.000Z",
        "gated": False,
        "private": False,
    }
]


def pick(filename: str = "tiny.gguf", size: int = len(PAYLOAD), sha: str = SHA) -> dict[str, Any]:
    return {
        "repoId": "owner/tiny",
        "revision": REVISION,
        "filename": filename,
        "sizeBytes": size,
        "sha256": sha,
    }


def listing(*files: tuple[str, int]) -> dict[str, Any]:
    return {
        "sha": REVISION,
        "siblings": [
            {"rfilename": name, "size": size, "lfs": {"sha256": "a" * 64, "size": size}}
            for name, size in files
        ],
    }


def use(
    client: TestClient,
    metadata: Optional[dict[str, Any]] = None,
    requests: Optional[list[httpx.Request]] = None,
) -> list[httpx.Request]:
    seen: list[httpx.Request] = [] if requests is None else requests
    served = metadata if metadata is not None else listing(("tiny.gguf", len(PAYLOAD)))

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.host != "huggingface.co":
            return httpx.Response(404)
        if request.url.path == "/api/models":
            return httpx.Response(200, json=SEARCH_HITS)
        if request.url.path == "/api/models/owner/tiny":
            return httpx.Response(200, json=served)
        if "/resolve/" in request.url.path:
            return httpx.Response(
                200, content=PAYLOAD, headers={"content-length": str(len(PAYLOAD))}
            )
        return httpx.Response(404)

    client.app.state.ctx.transport = httpx.MockTransport(handle)  # type: ignore[attr-defined]
    return seen


def models_dir(client: TestClient) -> Path:
    return client.app.state.ctx.store.data_dir / "local-ai" / "models"  # type: ignore[attr-defined]


def record_events(client: TestClient) -> list[tuple[str, Any]]:
    events: list[tuple[str, Any]] = []
    client.app.state.ctx.emit = lambda name, payload: events.append((name, payload))  # type: ignore[attr-defined]
    return events


def nothing_partial(client: TestClient) -> None:
    folder = models_dir(client) / "owner" / "tiny"
    assert not list(folder.glob("*.gguf"))
    assert not list(folder.glob(".model-*"))


@pytest.fixture
def pinned(monkeypatch: pytest.MonkeyPatch) -> catalog.Catalog:
    pinned_catalog = tiny_catalog()
    monkeypatch.setattr(catalog, "load", lambda: pinned_catalog)
    monkeypatch.setattr(hardware, "detect", lambda: dict(CPU_ONLY))
    monkeypatch.setattr(service, "_local_files", lambda _ctx: [])
    return pinned_catalog


# ---- what the page offers ----------------------------------------------------------


def test_the_catalog_models_and_the_quickstart_are_not_offered(
    client: TestClient, pinned: catalog.Catalog
) -> None:
    assert invoke(client, "local_ai_status")["models"] == []
    assert "local_ai_quickstart" not in COMMANDS
    assert "local_ai_download_model" not in COMMANDS


def test_search_returns_gguf_repos_through_the_command(
    client: TestClient, pinned: catalog.Catalog
) -> None:
    requests = use(client)
    hits = invoke(client, "local_ai_search_hf", query="tiny")
    assert hits == [
        {"id": "owner/tiny-GGUF", "downloads": 1234, "likes": 5, "updated": "2025-01-05"}
    ]
    assert requests[0].url.params["filter"] == "gguf"


def test_files_show_size_fit_and_whether_each_is_already_here(
    client: TestClient, pinned: catalog.Catalog, monkeypatch: pytest.MonkeyPatch
) -> None:
    use(client, listing(("small.gguf", 1 * GiB), ("huge.gguf", 150 * GiB)))
    folder = models_dir(client) / "owner" / "tiny"
    folder.mkdir(parents=True)
    (folder / "small.gguf").write_bytes(b"already here")

    result = invoke(client, "local_ai_hf_files", repoId="owner/tiny")
    assert result["revision"] == REVISION
    files = {entry["filename"]: entry for entry in result["files"]}
    assert files["small.gguf"]["fit"] == "ram" and files["small.gguf"]["downloaded"] is True
    assert files["small.gguf"]["size_bytes"] == 1 * GiB
    assert files["huge.gguf"]["fit"] == "too_big" and files["huge.gguf"]["downloaded"] is False

    gpu = {**CPU_ONLY, "gpu_name": "Test GPU", "vram_bytes": 24 * GiB, "backend": "cuda"}
    monkeypatch.setattr(hardware, "detect", lambda: dict(gpu))
    again = {entry["filename"]: entry for entry in invoke(client, "local_ai_hf_files", repoId="owner/tiny")["files"]}
    assert again["small.gguf"]["fit"] == "gpu"


def test_a_listing_for_an_invalid_repo_is_refused(client: TestClient, pinned: catalog.Catalog) -> None:
    status, body = invoke_error(client, "local_ai_hf_files", repoId="../etc")
    assert (status, body["code"]) == (400, "model_library")


# ---- downloading -------------------------------------------------------------------


def test_downloading_a_pick_streams_verifies_and_reports_progress(
    client: TestClient, pinned: catalog.Catalog
) -> None:
    requests = use(client)
    events = record_events(client)

    status = invoke(client, "local_ai_download_hf", **pick())

    written = models_dir(client) / "owner" / "tiny" / "tiny.gguf"
    assert written.read_bytes() == PAYLOAD
    (listed,) = status["models"]
    assert listed["id"] == f"file:{written}"
    assert (listed["source"], listed["removable"], listed["downloaded"]) == ("file", True, True)
    assert status["job"] is None
    assert len(requests) == 1
    assert str(requests[0].url) == f"https://huggingface.co/owner/tiny/resolve/{REVISION}/tiny.gguf"
    assert {name for name, _ in events} == {"local_ai_progress"}
    last = events[-1][1]
    assert (last["kind"], last["target"], last["phase"]) == ("model", "owner/tiny/tiny.gguf", "download")
    assert (last["downloaded"], last["total"]) == (len(PAYLOAD), len(PAYLOAD))


def test_a_checksum_mismatch_leaves_nothing_behind(client: TestClient, pinned: catalog.Catalog) -> None:
    use(client)
    status, body = invoke_error(client, "local_ai_download_hf", **pick(sha="e" * 64))
    assert body["code"] == "model_library"
    nothing_partial(client)


def test_a_file_already_here_is_not_downloaded_again(client: TestClient, pinned: catalog.Catalog) -> None:
    requests = use(client)
    invoke(client, "local_ai_download_hf", **pick())
    invoke(client, "local_ai_download_hf", **pick())
    assert len(requests) == 1


def test_a_file_too_big_for_this_pc_is_refused_before_any_request(
    client: TestClient, pinned: catalog.Catalog
) -> None:
    requests = use(client)
    status, body = invoke_error(client, "local_ai_download_hf", **pick("huge.gguf", 150 * GiB))
    assert (status, body["code"]) == (400, "local_ai_fit")
    assert requests == []


def test_a_second_download_is_refused_while_one_runs(client: TestClient, pinned: catalog.Catalog) -> None:
    use(client)
    with service._JOB.operation("model", "something-else"):
        status, body = invoke_error(client, "local_ai_download_hf", **pick())
    assert (status, body["code"]) == (400, "local_ai_busy")


class CancelAfterFirstBlock(httpx.SyncByteStream):
    def __iter__(self) -> Any:
        yield PAYLOAD[:16]
        service._JOB.cancel()
        yield PAYLOAD[16:]


def test_cancel_during_a_download_stops_it_and_leaves_nothing(
    client: TestClient, pinned: catalog.Catalog
) -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.host == "huggingface.co" and "/resolve/" in request.url.path:
            return httpx.Response(
                200, stream=CancelAfterFirstBlock(), headers={"content-length": str(len(PAYLOAD))}
            )
        return httpx.Response(404)

    client.app.state.ctx.transport = httpx.MockTransport(handle)  # type: ignore[attr-defined]
    status, body = invoke_error(client, "local_ai_download_hf", **pick())
    assert body["code"] == "model_cancelled"
    nothing_partial(client)


def test_a_redirect_to_another_host_is_refused(client: TestClient, pinned: catalog.Catalog) -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "https://evil.example/tiny.gguf"})

    client.app.state.ctx.transport = httpx.MockTransport(handle)  # type: ignore[attr-defined]
    status, body = invoke_error(client, "local_ai_download_hf", **pick())
    assert body["code"] == "model_library" and "not allowed" in body["message"]
    nothing_partial(client)


def test_a_name_that_is_not_one_standalone_gguf_is_refused_before_any_request(
    client: TestClient, pinned: catalog.Catalog
) -> None:
    requests = use(client)
    status, body = invoke_error(client, "local_ai_download_hf", **pick("tiny.bin"))
    assert body["code"] == "model_library"
    assert requests == []


# ---- keeping and removing ----------------------------------------------------------


def test_a_downloaded_file_is_removed_with_its_folders(client: TestClient, pinned: catalog.Catalog) -> None:
    use(client)
    status = invoke(client, "local_ai_download_hf", **pick())
    after = invoke(client, "local_ai_remove_model", modelId=status["models"][0]["id"])
    assert after["models"] == []
    assert not (models_dir(client) / "owner").exists()


def test_a_gguf_from_an_earlier_catalog_download_is_still_listed_and_removable(
    client: TestClient, pinned: catalog.Catalog
) -> None:
    folder = models_dir(client)
    folder.mkdir(parents=True)
    (folder / "tiny.gguf").write_bytes(PAYLOAD)
    (listed,) = invoke(client, "local_ai_status")["models"]
    assert listed["source"] == "file" and listed["removable"] is True
    invoke(client, "local_ai_remove_model", modelId=listed["id"])
    assert not (folder / "tiny.gguf").exists()


def test_a_junctioned_models_folder_is_refused_before_any_request(
    client: TestClient, pinned: catalog.Catalog
) -> None:
    requests = use(client)
    base = models_dir(client)
    base.mkdir(parents=True, exist_ok=True)
    target = base.parent / "junction-target"
    target.mkdir(exist_ok=True)
    link = base / "owner"
    created = False
    try:
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr
        created = True
        status, body = invoke_error(client, "local_ai_download_hf", **pick())
        assert body["code"] == "model_library"
        assert requests == []
    finally:
        if created:
            subprocess.run(["cmd", "/c", "rmdir", str(link)], capture_output=True)
