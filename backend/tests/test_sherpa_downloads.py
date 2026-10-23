"""sherpa-onnx installs and folder downloads. Stub servers on 127.0.0.1 and httpx.MockTransport only.

Pinned installs point the catalog at a synthetic archive served from the stub, with checksums computed from
the synthetic bytes. The Hugging Face folder test serves a fictional repository through MockTransport.
"""

from __future__ import annotations

import hashlib
import json
import tarfile
import threading
from pathlib import Path
from typing import Any

import httpx
import pytest

from openmeet_py.api.errors import AppError
from openmeet_py.speech import model_library, sherpa_models
from openmeet_py.speech.stt_catalog import Artifact, SherpaModel
from stub_http import reply, serve  # noqa: F401  (serve is the stub-server fixture)
from test_safe_archive import GOOD, build

VAD_BYTES = b"\0" * 1024  # size and checksum are patched to match
REPO = "fictional-org/sherpa-one"
REV = "a" * 40


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def archive_bytes(tmp_path: Path, members: Any = GOOD) -> bytes:
    path = build(tmp_path / f"archive-{len(list(tmp_path.iterdir()))}.tar.bz2", members)
    data = path.read_bytes()
    path.unlink()
    return data


@pytest.fixture
def patched_catalog(monkeypatch: pytest.MonkeyPatch):
    """Points the pinned catalog at the stub: returns a function that sets the served archive and VAD."""

    def configure(server, archive: bytes, *, archive_sha: str | None = None, archive_size: int | None = None,
                  vad: bytes = VAD_BYTES, vad_sha: str | None = None) -> SherpaModel:
        vad_artifact = Artifact("sherpa-silero", "silero_vad.onnx", server.url("/vad.onnx"),
                                vad_sha or sha(vad), len(vad))
        model = SherpaModel(
            "sherpa:fake-sense", "fake-sense",
            Artifact("sherpa-fake", "fake.tar.bz2", server.url("/model.tar.bz2"),
                     archive_sha or sha(archive), archive_size or len(archive)),
            ("tokens.txt", "model.int8.onnx"),
            "sense_voice",
        )
        monkeypatch.setattr(sherpa_models, "SHERPA_VAD", vad_artifact)
        monkeypatch.setattr(sherpa_models, "SHERPA_MODELS", (model,))
        return model

    return configure


def serving(archive: bytes, vad: bytes = VAD_BYTES):
    def archive_route(handler) -> None:
        reply(handler, 200, archive)

    def vad_route(handler) -> None:
        reply(handler, 200, vad)

    return {"/model.tar.bz2": archive_route, "/vad.onnx": vad_route}


def no_stray_files(root: Path) -> list[str]:
    sherpa = root / "sherpa"
    if not sherpa.exists():
        return []
    return sorted(
        p.name for p in sherpa.rglob("*")
        if (p.name.startswith(".") and p.name != sherpa_models.MARKER) or p.name.endswith((".tar.bz2", ".tmp"))
    )


# ---- pinned archives -----------------------------------------------------------------


def test_install_fetches_the_vad_and_archive_and_publishes_one_verified_folder(
    serve, patched_catalog, tmp_path: Path
) -> None:
    archive = archive_bytes(tmp_path)
    server = serve(serving(archive))
    model = patched_catalog(server, archive)
    root = tmp_path / "stt"
    root.mkdir()
    sherpa_models.install(root, model, lambda *_: None, threading.Event())
    folder = root / "sherpa" / "fake-sense"
    assert (folder / "tokens.txt").read_bytes() == b"a 1\n"
    assert (folder / "model.int8.onnx").read_bytes() == b"fictional-weights"
    assert (folder / sherpa_models.MARKER).read_text() == sha(archive)
    assert (root / "sherpa" / "silero_vad.onnx").read_bytes() == VAD_BYTES
    assert sorted(p.name for p in folder.iterdir()) == sorted(["tokens.txt", "model.int8.onnx", sherpa_models.MARKER])
    assert no_stray_files(root) == []
    assert sherpa_models.installed(root, model.id).model is True


def test_a_present_vad_is_not_downloaded_again(serve, patched_catalog, tmp_path: Path) -> None:
    archive = archive_bytes(tmp_path)
    server = serve(serving(archive))
    model = patched_catalog(server, archive)
    root = tmp_path / "stt"
    (root / "sherpa").mkdir(parents=True)
    (root / "sherpa" / "silero_vad.onnx").write_bytes(VAD_BYTES)
    sherpa_models.install(root, model, lambda *_: None, threading.Event())
    assert "/vad.onnx" not in server.hits and "/model.tar.bz2" in server.hits


def test_a_wrong_archive_checksum_publishes_nothing_and_leaves_no_temporary_file(
    serve, patched_catalog, tmp_path: Path
) -> None:
    archive = archive_bytes(tmp_path)
    server = serve(serving(archive))
    model = patched_catalog(server, archive, archive_sha="0" * 64)
    root = tmp_path / "stt"
    root.mkdir()
    with pytest.raises(AppError) as info:
        sherpa_models.install(root, model, lambda *_: None, threading.Event())
    assert info.value.code == "model_library"
    assert not (root / "sherpa" / "fake-sense").exists()
    assert no_stray_files(root) == []


def test_a_truncated_archive_that_matches_its_pin_fails_extraction_and_is_cleaned_up(
    serve, patched_catalog, tmp_path: Path
) -> None:
    whole = archive_bytes(tmp_path)
    cut = whole[: len(whole) // 2]
    server = serve(serving(cut))
    model = patched_catalog(server, cut)
    root = tmp_path / "stt"
    root.mkdir()
    with pytest.raises(AppError) as info:
        sherpa_models.install(root, model, lambda *_: None, threading.Event())
    assert info.value.message == "A downloaded speech archive could not be read."
    assert not (root / "sherpa" / "fake-sense").exists()
    assert no_stray_files(root) == []


def test_an_archive_without_a_wanted_file_publishes_nothing(serve, patched_catalog, tmp_path: Path) -> None:
    # A valid archive with only tokens.txt: model.int8.onnx is missing.
    archive = archive_bytes(tmp_path, [("pack/tokens.txt", b"a 1\n", tarfile.REGTYPE)])
    server = serve(serving(archive))
    model = patched_catalog(server, archive)
    root = tmp_path / "stt"
    root.mkdir()
    with pytest.raises(AppError) as info:
        sherpa_models.install(root, model, lambda *_: None, threading.Event())
    assert "did not contain the expected files" in info.value.message
    assert not (root / "sherpa" / "fake-sense").exists() and no_stray_files(root) == []


def test_an_oversize_archive_body_is_refused_at_the_pinned_size(serve, patched_catalog, tmp_path: Path) -> None:
    archive = archive_bytes(tmp_path)
    body = archive + b"extra-bytes"

    def unsized(handler) -> None:  # no Content-Length, so the body itself must be counted
        handler.send_response(200)
        handler.end_headers()
        handler.wfile.write(body)
        handler.close_connection = True

    server = serve({"/model.tar.bz2": unsized, "/vad.onnx": lambda h: reply(h, 200, VAD_BYTES)})
    model = patched_catalog(server, archive)  # pinned to the shorter archive
    root = tmp_path / "stt"
    root.mkdir()
    with pytest.raises(AppError) as info:
        sherpa_models.install(root, model, lambda *_: None, threading.Event())
    assert "larger than its pinned size" in info.value.message
    assert no_stray_files(root) == []


def test_a_redirect_to_a_host_outside_the_list_is_refused(serve, patched_catalog, tmp_path: Path) -> None:
    archive = archive_bytes(tmp_path)
    # localhost is not in the test host list, so the hop is refused before any connection is made.
    server = serve({
        "/vad.onnx": lambda handler: reply(handler, 200, VAD_BYTES),
        "/model.tar.bz2": lambda handler: reply(handler, 302, b"", {"Location": "http://localhost:9/model.tar.bz2"}),
    })
    model = patched_catalog(server, archive)
    root = tmp_path / "stt"
    root.mkdir()
    with pytest.raises(AppError) as info:
        sherpa_models.install(root, model, lambda *_: None, threading.Event())
    assert "not allowed" in info.value.message
    assert server.hits.count("/model.tar.bz2") == 1  # the disallowed hop was never requested
    assert no_stray_files(root) == []


def test_cancel_during_the_archive_download_publishes_nothing(serve, patched_catalog, tmp_path: Path) -> None:
    archive = archive_bytes(tmp_path)
    server = serve(serving(archive))
    model = patched_catalog(server, archive)
    root = tmp_path / "stt"
    root.mkdir()
    cancel = threading.Event()

    def progress(stage: str, done: int, total: int) -> None:
        if stage == "model":
            cancel.set()

    with pytest.raises(AppError) as info:
        sherpa_models.install(root, model, progress, cancel)
    assert info.value.code == "model_cancelled"
    assert not (root / "sherpa" / "fake-sense").exists() and no_stray_files(root) == []


def test_an_existing_incomplete_model_folder_is_preserved_not_overwritten(serve, patched_catalog, tmp_path: Path) -> None:
    archive = archive_bytes(tmp_path)
    server = serve(serving(archive))
    model = patched_catalog(server, archive)
    root = tmp_path / "stt"
    folder = root / "sherpa" / "fake-sense"
    folder.mkdir(parents=True)
    (folder / "tokens.txt").write_bytes(b"mine")
    with pytest.raises(AppError) as info:
        sherpa_models.install(root, model, lambda *_: None, threading.Event())
    assert "already exists but is incomplete" in info.value.message
    assert (folder / "tokens.txt").read_bytes() == b"mine"
    assert "/model.tar.bz2" not in server.hits


def test_release_hosts_are_github_only_over_https_and_never_huggingface(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(model_library.TEST_HOSTS_ENV, raising=False)
    allowed = model_library.allowed_release_url
    for good in [
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/a.tar.bz2",
        "https://objects.githubusercontent.com/x",
        "https://release-assets.githubusercontent.com/x",
    ]:
        assert allowed(httpx.URL(good)), good
    for bad in [
        "https://huggingface.co/x",
        "https://example.com/x",
        "http://github.com/x",
        "https://github.com:8443/x",
        "https://user:pw@github.com/x",
        "https://evil.github.com.example/x",
    ]:
        assert not allowed(httpx.URL(bad)), bad


# ---- Hugging Face sherpa-onnx folders -----------------------------------------------------

FICTIONAL = {
    "encoder-fict.onnx": b"fictional-encoder",
    "decoder-fict.onnx": b"fictional-decoder",
    "joiner-fict.onnx": b"fictional-joiner",
    "tokens.txt": b"a 1\n",
}


def hub(served: dict[str, bytes], metadata_files: dict[str, bytes] | None = None, *, redirect: dict[str, str] | None = None):
    listing = metadata_files if metadata_files is not None else FICTIONAL
    metadata = {
        "id": REPO,
        "sha": REV,
        "private": False,
        "gated": False,
        "pipeline_tag": "automatic-speech-recognition",
        "cardData": {"license": "apache-2.0"},
        "siblings": [
            {"rfilename": name, "size": len(body), "lfs": {"size": len(body), "sha256": sha(body)}}
            for name, body in listing.items()
        ],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == f"/api/models/{REPO}/revision/{REV}":
            return httpx.Response(200, content=json.dumps(metadata).encode(), headers={"content-type": "application/json"})
        prefix = f"/{REPO}/resolve/{REV}/"
        if path.startswith(prefix):
            name = path[len(prefix):]
            if redirect and name in redirect:
                return httpx.Response(302, headers={"location": redirect[name]})
            body = served.get(name)
            if body is None:
                return httpx.Response(404)
            return httpx.Response(200, content=body, headers={"content-length": str(len(body))})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


def proposed_folder(transport: httpx.MockTransport) -> dict[str, Any]:
    return model_library.list_files(REPO, transport, REV)["folders"][0]


def test_a_hub_folder_downloads_all_or_nothing_into_a_named_folder(tmp_path: Path) -> None:
    transport = hub(FICTIONAL)
    root = tmp_path / "stt"
    result = model_library.download_hf_folder(root, proposed_folder(transport), lambda _p: None, transport)
    assert result["model_id"] == "sherpa-dir:fictional-org--sherpa-one"
    assert result["files"] == 4
    folder = root / "sherpa" / "custom" / "fictional-org--sherpa-one"
    assert sorted(p.name for p in folder.iterdir()) == sorted([*FICTIONAL, "openmeet-source.json"])
    manifest = json.loads((folder / "openmeet-source.json").read_text(encoding="utf-8"))
    assert manifest["revision"] == REV and manifest["layout"] == "transducer"
    assert no_stray_files(root) == []


def test_one_wrong_checksum_keeps_nothing_from_the_folder(tmp_path: Path) -> None:
    served = dict(FICTIONAL)
    served["decoder-fict.onnx"] = b"fictional-DECODE!"  # same length, different bytes
    transport = hub(served)
    root = tmp_path / "stt"
    with pytest.raises(AppError) as info:
        model_library.download_hf_folder(root, proposed_folder(transport), lambda _p: None, transport)
    assert info.value.code == "model_library"
    custom = root / "sherpa" / "custom"
    assert list(custom.iterdir()) == []


def test_a_redirect_to_a_non_hugging_face_host_keeps_nothing(tmp_path: Path) -> None:
    transport = hub(FICTIONAL, redirect={"joiner-fict.onnx": "https://example.com/joiner-fict.onnx"})
    root = tmp_path / "stt"
    with pytest.raises(AppError) as info:
        model_library.download_hf_folder(root, proposed_folder(transport), lambda _p: None, transport)
    assert "not allowed" in info.value.message
    assert list((root / "sherpa" / "custom").iterdir()) == []


def test_a_listing_that_changed_since_the_user_confirmed_it_is_refused(tmp_path: Path) -> None:
    transport = hub(FICTIONAL)
    proposed = proposed_folder(transport)
    proposed["files"][0]["sha256"] = "0" * 64
    with pytest.raises(AppError) as info:
        model_library.download_hf_folder(tmp_path / "stt", proposed, lambda _p: None, transport)
    assert "Model metadata changed" in info.value.message


def test_an_existing_downloaded_folder_is_never_replaced(tmp_path: Path) -> None:
    transport = hub(FICTIONAL)
    root = tmp_path / "stt"
    existing = root / "sherpa" / "custom" / "fictional-org--sherpa-one"
    existing.mkdir(parents=True)
    (existing / "tokens.txt").write_bytes(b"kept")
    with pytest.raises(AppError) as info:
        model_library.download_hf_folder(root, proposed_folder(transport), lambda _p: None, transport)
    assert "already exists" in info.value.message
    assert (existing / "tokens.txt").read_bytes() == b"kept"
