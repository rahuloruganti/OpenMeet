"""Model downloads, imports, scans and Hugging Face parsing. No real network: stub servers on 127.0.0.1
(with OPENMEET_PY_TEST_HOSTS set) and httpx.MockTransport for the Hub metadata.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from collections import namedtuple
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator

import httpx
import pytest

from openmeet_py import model_library
from openmeet_py.errors import AppError
from openmeet_py.stt_catalog import WHISPER_MODELS, Artifact

PAYLOAD = (b"fictional-ggml-weights-" * 220)[:5000]
SHA = hashlib.sha256(PAYLOAD).hexdigest()


class _Handler(BaseHTTPRequestHandler):
    server: "_StubServer"

    def log_message(self, *args: Any) -> None:  # keep test output quiet
        pass

    def _send(self, body: bytes) -> None:
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _redirect(self, location: str) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        self.server.hits.append((self.path, {key.lower(): value for key, value in self.headers.items()}))
        if self.path == "/file/ok":
            self._send(PAYLOAD)
        elif self.path == "/redirect":
            self._redirect("/file/ok")
        elif self.path == "/redirect-out":
            self._redirect(f"http://localhost:{self.server.server_address[1]}/file/ok")
        elif self.path == "/loop":
            self._redirect("/loop")
        elif self.path == "/short":
            self.send_response(200)
            self.send_header("Content-Length", str(len(PAYLOAD)))
            self.end_headers()
            self.wfile.write(PAYLOAD[: len(PAYLOAD) // 2])
            self.close_connection = True
        elif self.path == "/oversize":
            self.send_response(200)  # no Content-Length: the body runs until the connection closes
            self.end_headers()
            self.wfile.write(PAYLOAD + b"0123456789")
            self.close_connection = True
        elif self.path == "/declared-wrong":
            self.send_response(200)
            self.send_header("Content-Length", str(len(PAYLOAD) - 1))
            self.end_headers()
            self.wfile.write(PAYLOAD[:-1])
        elif self.path == "/slow":
            self.send_response(200)
            self.end_headers()
            for _ in range(100):
                self.wfile.write(b"\0" * 65536)
                self.wfile.flush()
                time.sleep(0.01)
        else:
            self.send_error(404)


class _StubServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), _Handler)
        self.hits: list[tuple[str, dict[str, str]]] = []


@pytest.fixture
def stub(monkeypatch: pytest.MonkeyPatch) -> Iterator[_StubServer]:
    server = _StubServer()
    monkeypatch.setenv(model_library.TEST_HOSTS_ENV, "127.0.0.1")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()


def url_for(server: _StubServer, path: str) -> str:
    return f"http://127.0.0.1:{server.server_address[1]}{path}"


def fetch(server: _StubServer, path: str, folder: Path, size: int = len(PAYLOAD), sha: str = SHA, cancel=None, progress=None) -> Path:
    return model_library.fetch_verified(
        url_for(server, path),
        folder,
        "ggml-fictional.bin",
        size,
        sha,
        progress=progress or (lambda done: None),
        cancel=cancel or threading.Event(),
    )


def leftovers(folder: Path) -> list[str]:
    return sorted(p.name for p in folder.iterdir())


# ---- downloads ---------------------------------------------------------------------


def test_verified_download_is_published_without_temporary_files(stub: _StubServer, tmp_path: Path) -> None:
    folder = tmp_path / "models"
    folder.mkdir()
    path = fetch(stub, "/file/ok", folder)
    assert path.read_bytes() == PAYLOAD
    assert leftovers(folder) == ["ggml-fictional.bin"]


def test_checksum_mismatch_publishes_nothing(stub: _StubServer, tmp_path: Path) -> None:
    folder = tmp_path / "models"
    folder.mkdir()
    with pytest.raises(AppError) as info:
        fetch(stub, "/file/ok", folder, sha="0" * 64)
    assert info.value.code == "model_library" and "checksum" in info.value.message
    assert leftovers(folder) == []


def test_truncated_transfer_is_refused_and_removed(stub: _StubServer, tmp_path: Path) -> None:
    folder = tmp_path / "models"
    folder.mkdir()
    with pytest.raises(AppError) as info:
        fetch(stub, "/short", folder)
    assert "interrupted" in info.value.message or "incomplete" in info.value.message
    assert leftovers(folder) == []


def test_oversize_body_is_refused_at_the_pinned_size(stub: _StubServer, tmp_path: Path) -> None:
    folder = tmp_path / "models"
    folder.mkdir()
    with pytest.raises(AppError) as info:
        fetch(stub, "/oversize", folder)
    assert "larger than its pinned size" in info.value.message
    assert leftovers(folder) == []


def test_a_declared_length_that_differs_from_the_pin_is_refused_before_the_body(stub: _StubServer, tmp_path: Path) -> None:
    folder = tmp_path / "models"
    folder.mkdir()
    with pytest.raises(AppError) as info:
        fetch(stub, "/declared-wrong", folder)
    assert "size differs" in info.value.message
    assert leftovers(folder) == []


def test_redirect_to_an_allowed_host_is_followed_hop_by_hop(stub: _StubServer, tmp_path: Path) -> None:
    folder = tmp_path / "models"
    folder.mkdir()
    fetch(stub, "/redirect", folder)
    assert [path for path, _ in stub.hits] == ["/redirect", "/file/ok"]


def test_redirect_to_a_host_outside_the_list_is_refused(stub: _StubServer, tmp_path: Path) -> None:
    folder = tmp_path / "models"
    folder.mkdir()
    with pytest.raises(AppError) as info:
        fetch(stub, "/redirect-out", folder)
    assert "not allowed" in info.value.message
    assert [path for path, _ in stub.hits] == ["/redirect-out"]
    assert leftovers(folder) == []


def test_redirect_loops_are_bounded_at_five_hops(stub: _StubServer, tmp_path: Path) -> None:
    folder = tmp_path / "models"
    folder.mkdir()
    with pytest.raises(AppError) as info:
        fetch(stub, "/loop", folder)
    assert "too many" in info.value.message
    assert len(stub.hits) == model_library.REDIRECT_LIMIT + 1


def test_cancel_mid_download_leaves_no_partial_file(stub: _StubServer, tmp_path: Path) -> None:
    folder = tmp_path / "models"
    folder.mkdir()
    cancel = threading.Event()
    seen: list[int] = []

    def progress(done: int) -> None:
        seen.append(done)
        cancel.set()

    with pytest.raises(AppError) as info:
        fetch(stub, "/slow", folder, size=100 * 65536, sha="f" * 64, cancel=cancel, progress=progress)
    assert info.value.code == "model_cancelled"
    assert len(seen) == 1
    assert leftovers(folder) == []


def test_an_existing_destination_is_never_overwritten_or_requested(stub: _StubServer, tmp_path: Path) -> None:
    folder = tmp_path / "models"
    folder.mkdir()
    (folder / "ggml-fictional.bin").write_bytes(b"keep me")
    with pytest.raises(AppError) as info:
        fetch(stub, "/file/ok", folder)
    assert "already exists" in info.value.message
    assert stub.hits == []
    assert (folder / "ggml-fictional.bin").read_bytes() == b"keep me"


def test_low_disk_space_is_refused_before_any_request(stub: _StubServer, tmp_path: Path, monkeypatch) -> None:
    folder = tmp_path / "models"
    folder.mkdir()
    Usage = namedtuple("Usage", "total used free")
    monkeypatch.setattr(model_library.shutil, "disk_usage", lambda path: Usage(10**9, 10**9 - 1000, 1000))
    with pytest.raises(AppError) as info:
        fetch(stub, "/file/ok", folder)
    assert "Not enough free disk space" in info.value.message
    assert stub.hits == []


def test_a_retry_starts_from_zero_with_no_range_header(stub: _StubServer, tmp_path: Path) -> None:
    folder = tmp_path / "models"
    folder.mkdir()
    with pytest.raises(AppError):
        fetch(stub, "/short", folder)
    fetch(stub, "/file/ok", folder)
    assert all("range" not in headers for _, headers in stub.hits)
    assert (folder / "ggml-fictional.bin").read_bytes() == PAYLOAD


def test_without_the_test_override_plain_http_and_local_hosts_are_refused(
    stub: _StubServer, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(model_library.TEST_HOSTS_ENV, raising=False)
    folder = tmp_path / "models"
    folder.mkdir()
    with pytest.raises(AppError):
        fetch(stub, "/file/ok", folder)
    assert stub.hits == []


def test_allowed_urls_are_https_hugging_face_hosts_without_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(model_library.TEST_HOSTS_ENV, raising=False)
    allowed = [
        "https://huggingface.co/x",
        "https://cdn-lfs.huggingface.co/x",
        "https://cas-bridge.xethub.hf.co/x",
    ]
    refused = [
        "http://huggingface.co/x",
        "https://huggingface.co:8443/x",
        "https://huggingface.co.evil.example/x",
        "https://evil.example/x",
        "https://user:secret@huggingface.co/x",
        "https://evilhf.co/x",
    ]
    for url in allowed:
        assert model_library.allowed_url(httpx.URL(url)), url
    for url in refused:
        assert not model_library.allowed_url(httpx.URL(url)), url


def test_the_client_never_reads_proxy_or_netrc_settings() -> None:
    client = model_library._client(None)
    assert client.trust_env is False
    assert client.follow_redirects is False


def test_the_download_timeout_and_redirect_cap_are_fixed() -> None:
    assert model_library.TRANSFER_TIMEOUT == 30 * 60
    assert model_library.REDIRECT_LIMIT == 5


# ---- imports -----------------------------------------------------------------------


def test_import_refuses_a_size_no_pinned_model_has(tmp_path: Path) -> None:
    source = tmp_path / "notes.bin"
    source.write_bytes(b"ggml" + b"0" * 119)
    with pytest.raises(AppError) as info:
        model_library.import_model(tmp_path / "stt", source)
    assert "does not match a pinned Whisper model size" in info.value.message


def test_import_checksum_failure_leaves_the_source_and_the_library_untouched(tmp_path: Path) -> None:
    entry = next(item for item in WHISPER_MODELS if item.id == "base.en-q5_1")
    source = tmp_path / "ggml-base.en-q5_1.bin"
    with open(source, "wb") as handle:
        handle.truncate(entry.size)  # zeros: the right size, the wrong checksum
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    with pytest.raises(AppError) as info:
        model_library.import_model(tmp_path / "stt", source)
    assert "checksum" in info.value.message
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before
    assert not (tmp_path / "stt" / "models" / entry.file).exists()


def test_a_matching_file_is_copied_in_and_the_source_stays(tmp_path: Path, monkeypatch) -> None:
    fictional = Artifact("fictional-tiny", "ggml-fictional.bin", "https://huggingface.co/x", SHA, len(PAYLOAD))
    monkeypatch.setattr(model_library, "WHISPER_MODELS", (fictional,))
    source = tmp_path / "downloaded.bin"
    source.write_bytes(PAYLOAD)
    result = model_library.import_model(tmp_path / "stt", source)
    assert result == {"model_id": "fictional-tiny"}
    assert (tmp_path / "stt" / "models" / "ggml-fictional.bin").read_bytes() == PAYLOAD
    assert source.read_bytes() == PAYLOAD


# ---- scans -------------------------------------------------------------------------


def test_scan_reports_formats_and_bounds(tmp_path: Path) -> None:
    root = tmp_path / "models"
    (root / "deep" / "deeper").mkdir(parents=True)
    (root / "ggml-custom.bin").write_bytes(b"ggml-fictional")
    (root / "llm.gguf").write_bytes(b"GGUF-fictional")
    (root / "other.safetensors").write_bytes(b"nope")
    (root / "readme.txt").write_text("skip me")
    (root / "deep" / "lmgg-model.bin").write_bytes(b"lmgg-fictional")
    (root / "deep" / "deeper" / "too-deep.bin").write_bytes(b"ggml-deep")
    result = model_library.scan([root])
    formats = {Path(item["path"]).name: item["format"] for item in result["models"]}
    assert formats["ggml-custom.bin"] == "whisper"
    assert formats["llm.gguf"] == "gguf"
    assert formats["other.safetensors"] == "unknown"
    assert formats["lmgg-model.bin"] == "whisper"
    assert "readme.txt" not in formats
    assert result["truncated"] is False
    shallow = model_library.scan([root], max_depth=1)
    assert shallow["folders"][0]["status"] == "Depth limit reached" and shallow["truncated"] is True
    limited = model_library.scan([root], max_entries=2)
    assert limited["truncated"] is True and limited["folders"][0]["status"] == "Scan limit reached"
    capped = model_library.scan([root], max_models=1)
    assert len(capped["models"]) == 1 and capped["truncated"] is True


def test_scan_reports_missing_and_non_folder_inputs(tmp_path: Path) -> None:
    a_file = tmp_path / "file.bin"
    a_file.write_bytes(b"ggml")
    result = model_library.scan([tmp_path / "absent", a_file])
    statuses = [item["status"] for item in result["folders"]]
    assert statuses == ["Missing or inaccessible", "Not a folder"]


# ---- Hugging Face (MockTransport) --------------------------------------------------


def hub(handler: Any) -> httpx.MockTransport:
    return httpx.MockTransport(handler)


def sibling(name: str, payload: bytes, sha: str | None = None) -> dict[str, Any]:
    digest = sha or hashlib.sha256(payload).hexdigest()
    return {"rfilename": name, "size": len(payload), "lfs": {"size": len(payload), "sha256": digest}}


REVISION = "a" * 40
REPO = "fictional-org/fictional-whisper"


def metadata(files: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    base = {"id": REPO, "sha": REVISION, "private": False, "gated": False, "cardData": {"license": "mit"}, "siblings": files}
    base.update(extra)
    return base


def test_search_parses_defensively_and_labels_each_result() -> None:
    results = [
        {"id": "fictional-org/whisper-one", "pipeline_tag": "automatic-speech-recognition", "gated": False,
         "cardData": {"license": "apache-2.0"}, "siblings": [{"rfilename": "ggml-one.bin"}]},
        {"id": "fictional-org/sherpa-one", "pipeline_tag": "automatic-speech-recognition", "siblings": [
            {"rfilename": "tokens.txt"}, {"rfilename": "encoder.onnx"}, {"rfilename": "decoder.onnx"},
            {"rfilename": "joiner.onnx"}]},
        {"id": "fictional-org/llm-gguf", "siblings": [{"rfilename": "model.gguf"}]},
        {"id": "fictional-org/private", "private": True, "siblings": []},
        {"id": "fictional-org/gated", "gated": "auto", "siblings": []},
        {"id": "fictional-org/other-task", "pipeline_tag": "text-generation", "siblings": []},
        {"id": "not a repo", "siblings": []},
        "not even an object",
    ]
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path + "?" + request.url.query.decode())
        return httpx.Response(200, json=results)

    hits = model_library.search("whisper", transport=hub(handler))
    assert [(hit["id"], hit["kind"], hit["license"]) for hit in hits] == [
        ("fictional-org/whisper-one", "whisper_ggml", "apache-2.0"),
        ("fictional-org/sherpa-one", "sherpa_onnx", None),
        ("fictional-org/llm-gguf", "other", None),
    ]
    assert seen[0].startswith("/api/models?") and "pipeline_tag=automatic-speech-recognition" in seen[0]
    assert "limit=20" in seen[0] and "full=true" in seen[0]


def test_search_refuses_empty_control_and_oversized_answers() -> None:
    with pytest.raises(AppError):
        model_library.search("   ", transport=hub(lambda r: httpx.Response(200, json=[])))
    with pytest.raises(AppError):
        model_library.search("bad\nquery", transport=hub(lambda r: httpx.Response(200, json=[])))
    with pytest.raises(AppError) as info:
        model_library.search("x", transport=hub(lambda r: httpx.Response(200, json=[{"id": "a/b"}] * 21)))
    assert "too many" in info.value.message


def test_listing_pins_the_revision_and_matches_the_catalog() -> None:
    catalog = next(item for item in WHISPER_MODELS if item.id == "base.en-q5_1")
    listing = model_library.parse_files(
        metadata([
            {"rfilename": "ggml-base.en-q5_1.bin", "size": catalog.size,
             "lfs": {"size": catalog.size, "sha256": catalog.sha256}},
            {"rfilename": "ggml-unpinned.bin", "size": 9, "lfs": None},
            {"rfilename": "ggml-mismatch.bin", "size": 10, "lfs": {"size": 11, "sha256": "b" * 64}},
            {"rfilename": "weights.bin", "size": 8, "lfs": {"size": 8, "sha256": "c" * 64}},
        ], cardData={"license": "x" * 300}),
        REPO,
        None,
    )
    assert [item["filename"] for item in listing["files"]] == ["ggml-base.en-q5_1.bin"]
    assert listing["files"][0]["model_id"] == "base.en-q5_1"
    assert listing["files"][0]["revision"] == REVISION
    assert listing["files"][0]["license"] is None  # over-long license text is dropped
    with pytest.raises(AppError):
        model_library.parse_files(metadata([]), REPO, "b" * 40)
    with pytest.raises(AppError):
        model_library.parse_files(metadata([], sha="not-a-sha"), REPO, None)
    with pytest.raises(AppError):
        model_library.parse_files(metadata([], private=True), REPO, None)
    with pytest.raises(AppError):
        model_library.parse_files(metadata([], id="other/repo"), REPO, None)


def test_a_sherpa_folder_is_offered_only_when_every_role_is_present() -> None:
    names = ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"]
    complete = [dict(sibling(f"fictional-model/{name}", b"fictional-bytes")) for name in names]
    listing = model_library.parse_files(metadata(complete), REPO, None)
    assert [folder["layout"] for folder in listing["folders"]] == ["transducer"]
    partial = [item for item in complete if not item["rfilename"].endswith("joiner.onnx")]
    assert model_library.parse_files(metadata(partial), REPO, None)["folders"] == []


def test_download_from_the_hub_verifies_checksum_writes_a_manifest_and_never_clobbers(tmp_path: Path) -> None:
    payload = b"fictional-whisper-weights" * 40
    file_entry = sibling("ggml-fictional.bin", payload)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == f"/api/models/{REPO}/revision/{REVISION}":
            return httpx.Response(200, json=metadata([file_entry]))
        if request.url.path == f"/{REPO}/resolve/{REVISION}/ggml-fictional.bin":
            return httpx.Response(200, content=payload)
        return httpx.Response(404)

    proposed = {
        "repo_id": REPO, "revision": REVISION, "filename": "ggml-fictional.bin", "size": len(payload),
        "sha256": file_entry["lfs"]["sha256"], "license": "mit", "model_id": None,
    }
    events: list[dict[str, int]] = []
    result = model_library.download_hf_model(tmp_path / "stt", proposed, events.append, transport=hub(handler))
    model_path = Path(result["path"])
    assert model_path.read_bytes() == payload
    manifest = json.loads((model_path.parent / "ggml-fictional.bin.openmeet.json").read_text(encoding="utf-8"))
    assert manifest["sha256"] == file_entry["lfs"]["sha256"]
    assert events and events[-1] == {"downloaded": len(payload), "total": len(payload)}
    with pytest.raises(AppError) as info:
        model_library.download_hf_model(tmp_path / "stt", proposed, events.append, transport=hub(handler))
    assert "already exists" in info.value.message
    assert model_path.read_bytes() == payload


def test_a_download_whose_metadata_changed_is_refused(tmp_path: Path) -> None:
    file_entry = sibling("ggml-fictional.bin", b"fictional-bytes")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=metadata([file_entry]))

    proposed = {
        "repo_id": REPO, "revision": REVISION, "filename": "ggml-fictional.bin", "size": 15,
        "sha256": "d" * 64, "license": "mit", "model_id": None,
    }
    with pytest.raises(AppError) as info:
        model_library.download_hf_model(tmp_path / "stt", proposed, lambda p: None, transport=hub(handler))
    assert "metadata changed" in info.value.message
    assert not (tmp_path / "stt" / "models").exists() or leftovers(tmp_path / "stt" / "models") == []


def test_list_files_reads_metadata_with_blobs_and_no_credentials() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json=metadata([]))

    model_library.list_files(REPO, transport=hub(handler))
    assert captured[0].url.params.get("blobs") == "true"
    assert "authorization" not in {key.lower() for key in captured[0].headers}


def test_hf_helpers_refuse_bad_repositories_and_filenames() -> None:
    assert model_library.valid_repo("org/model-1.0")
    assert not model_library.valid_repo("../etc")
    assert not model_library.valid_repo("a/b/c")
    assert model_library.valid_filename("ggml-base.bin")
    assert not model_library.valid_filename("../x.bin")
    assert not model_library.valid_filename("CON.bin")
    assert not model_library.valid_filename("trailing.")
