"""Streaming ONNX model catalogue, folders, verified install and recognizer loading.

Every test is synthetic: a stub release server or a fake sherpa_onnx module, no real model, no network.
"""

from __future__ import annotations

import hashlib
import importlib.machinery
import sys
import tarfile
import threading
import types
from pathlib import Path
from typing import Any

import httpx
import pytest

from openmeet_py.api.errors import AppError
from openmeet_py.speech import streaming_models
from openmeet_py.speech.stt_catalog import STREAMING_MODELS, Artifact, StreamingModel
from stub_http import reply, serve  # noqa: F401  (serve is the stub-server fixture)
from test_safe_archive import build

KROKO = "stream:kroko-en"
NEMO = "stream:nemo-en-80ms"
FILES = ("encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt")


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def archive_bytes(tmp_path: Path) -> bytes:
    path = build(
        tmp_path / "stream.tar.bz2",
        [
            ("pack/", None, tarfile.DIRTYPE),
            ("pack/encoder.onnx", b"fictional-encoder", tarfile.REGTYPE),
            ("pack/decoder.onnx", b"fictional-decoder", tarfile.REGTYPE),
            ("pack/joiner.onnx", b"fictional-joiner", tarfile.REGTYPE),
            ("pack/tokens.txt", b"a 1\n", tarfile.REGTYPE),
            ("pack/README.md", b"not wanted", tarfile.REGTYPE),
            ("pack/test_wavs/0.wav", b"RIFF-fictional", tarfile.REGTYPE),
        ],
    )
    data = path.read_bytes()
    path.unlink()
    return data


def fake_catalog(monkeypatch: pytest.MonkeyPatch, server: Any, archive: bytes, *,
                 archive_sha: str | None = None, archive_size: int | None = None) -> StreamingModel:
    model = StreamingModel(
        KROKO, "kroko-en", "Streaming English (Zipformer)",
        Artifact("stream-kroko-en", "kroko.tar.bz2", server.url("/kroko.tar.bz2"),
                 archive_sha or sha(archive), archive_size or len(archive)),
        FILES, "transducer", ("en",), "CC-BY-SA",
    )
    monkeypatch.setattr(streaming_models, "STREAMING_MODELS", (model,))
    monkeypatch.setattr(streaming_models, "engine_available", lambda: True)
    return model


@pytest.fixture
def sherpa_fake(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    calls: list[tuple[str, dict[str, Any]]] = []

    class Recognizer:
        @classmethod
        def from_transducer(cls, **kwargs: Any) -> object:
            calls.append(("from_transducer", kwargs))
            return object()

        @classmethod
        def from_nemo_ctc(cls, **kwargs: Any) -> object:
            calls.append(("from_nemo_ctc", kwargs))
            return object()

    module = types.ModuleType("sherpa_onnx")
    module.__spec__ = importlib.machinery.ModuleSpec("sherpa_onnx", None)
    module.OnlineRecognizer = Recognizer
    monkeypatch.setitem(sys.modules, "sherpa_onnx", module)
    return calls


def touching(root: Path, model_id: str = KROKO, files: dict[str, bytes] | None = None) -> Path:
    """A pinned folder published with its marker, as a finished install leaves it."""
    model = streaming_models.pinned(model_id)
    assert model is not None
    directory = streaming_models.folder(root) / model.folder
    directory.mkdir(parents=True)
    for name, body in (files or {name: b"fictional" for name in model.files}).items():
        (directory / name).write_bytes(body)
    (directory / streaming_models.MARKER).write_text(model.archive.sha256, encoding="utf-8")
    return directory


# ---- catalogue ---------------------------------------------------------------------------


def test_the_catalogue_pins_the_two_streaming_models_settings_offers() -> None:
    ids = [model.id for model in STREAMING_MODELS]
    assert ids == ["stream:kroko-en", "stream:nemo-en-80ms"]
    kroko = STREAMING_MODELS[0]
    assert kroko.label == "Streaming English (Zipformer)"
    assert kroko.archive.size == 57_267_600
    assert kroko.archive.sha256 == "c8676e5ff9ac2a85296e53ee0fd4d5fb1db6770e7a7647166eeafe349ade6834"
    assert kroko.files == FILES and kroko.languages == ("en",)
    nemo = STREAMING_MODELS[1]
    assert nemo.label == "Streaming English (NeMo)"
    assert nemo.archive.size == 102_813_625
    assert nemo.archive.sha256 == "7bd33a914e93370a1ba9c2066d9e841bdcad8613fa2a00537c1ae15d851a14d8"
    assert nemo.files == ("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt")
    for model in STREAMING_MODELS:
        assert model.archive.url.startswith(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-"
        )
        assert model.family == "transducer"


def test_a_folder_counts_as_installed_only_with_the_marker_and_every_file(tmp_path: Path,
                                                                         monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(streaming_models, "engine_available", lambda: True)
    directory = touching(tmp_path)
    assert streaming_models.installed(tmp_path, KROKO) is True
    (directory / "joiner.onnx").unlink()
    assert streaming_models.installed(tmp_path, KROKO) is False
    (directory / "joiner.onnx").write_bytes(b"back")
    (directory / streaming_models.MARKER).write_text("0" * 64, encoding="utf-8")
    assert streaming_models.installed(tmp_path, KROKO) is False


def test_models_lists_pinned_models_with_their_download_size_and_custom_folders_from_disk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(streaming_models, "engine_available", lambda: True)
    touching(tmp_path, NEMO, {"encoder.int8.onnx": b"e", "decoder.int8.onnx": b"d",
                              "joiner.int8.onnx": b"j", "tokens.txt": b"t"})
    custom = streaming_models.folder(tmp_path) / "custom" / "team-kroko"
    custom.mkdir(parents=True)
    for name in FILES:
        (custom / name).write_bytes(b"x")
    offline = streaming_models.folder(tmp_path) / "custom" / "moon"
    offline.mkdir(parents=True)
    (offline / "encoder_model.ort").write_bytes(b"e")
    (offline / "decoder_model_merged.ort").write_bytes(b"d")
    (offline / "tokens.txt").write_bytes(b"t")

    rows = {entry.id: entry for entry in streaming_models.models(tmp_path)}
    assert set(rows) == {KROKO, NEMO, "stream-dir:team-kroko"}
    assert rows[KROKO].installed is False and rows[KROKO].download_bytes == 57_267_600
    assert rows[NEMO].installed is True and rows[NEMO].download_bytes is None
    assert rows["stream-dir:team-kroko"].custom is True and rows["stream-dir:team-kroko"].installed is True


def test_a_custom_folder_that_is_not_a_streaming_layout_is_not_offered(tmp_path: Path) -> None:
    half = streaming_models.folder(tmp_path) / "custom" / "half"
    half.mkdir(parents=True)
    (half / "tokens.txt").write_bytes(b"t")
    assert streaming_models.custom_models(tmp_path) == []


def test_custom_names_refuse_separators_and_dotdot() -> None:
    assert streaming_models.custom_name("stream-dir:team-kroko") == "team-kroko"
    for bad in ["stream-dir:", "stream-dir:../x", "stream-dir:a/b", "stream-dir:.hidden", "stream:kroko-en"]:
        assert streaming_models.custom_name(bad) is None


# ---- install -----------------------------------------------------------------------------


def test_install_downloads_verifies_and_publishes_one_folder(serve, tmp_path: Path,
                                                             monkeypatch: pytest.MonkeyPatch) -> None:
    archive = archive_bytes(tmp_path)
    server = serve({"/kroko.tar.bz2": lambda handler: reply(handler, 200, archive)})
    fake_catalog(monkeypatch, server, archive)
    root = tmp_path / "stt"
    stages: list[str] = []
    client = httpx.Client()  # the command layer passes a configured client; only its transport is used
    try:
        streaming_models.install(root, KROKO, threading.Event(),
                                 lambda stage, done, total: stages.append(stage), client)
    finally:
        client.close()
    directory = streaming_models.folder(root) / "kroko-en"
    assert sorted(path.name for path in directory.iterdir()) == sorted([*FILES, streaming_models.MARKER])
    assert (directory / streaming_models.MARKER).read_text(encoding="utf-8") == sha(archive)
    assert (directory / "encoder.onnx").read_bytes() == b"fictional-encoder"
    assert (directory / "README.md").exists() is False and (directory / "test_wavs").exists() is False
    assert stages[0] == "downloading" and "verifying" in stages
    assert sorted(path.name for path in (streaming_models.folder(root)).iterdir()) == ["kroko-en"]


def test_a_wrong_checksum_publishes_nothing_and_leaves_no_staging_folder(
    serve, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = archive_bytes(tmp_path)
    server = serve({"/kroko.tar.bz2": lambda handler: reply(handler, 200, archive)})
    fake_catalog(monkeypatch, server, archive, archive_sha="0" * 64)
    root = tmp_path / "stt"
    with pytest.raises(AppError) as info:
        streaming_models.install(root, KROKO, threading.Event(), lambda *_: None)
    assert info.value.code == "model_library"
    assert not (streaming_models.folder(root) / "kroko-en").exists()
    assert [path.name for path in streaming_models.folder(root).iterdir()] == []


def test_a_body_larger_than_the_pinned_size_is_refused(serve, tmp_path: Path,
                                                       monkeypatch: pytest.MonkeyPatch) -> None:
    archive = archive_bytes(tmp_path)
    body = archive + b"extra bytes past the pin"

    def unsized(handler) -> None:  # no Content-Length, so the body itself has to be counted
        handler.send_response(200)
        handler.end_headers()
        handler.wfile.write(body)
        handler.close_connection = True

    server = serve({"/kroko.tar.bz2": unsized})
    fake_catalog(monkeypatch, server, archive)  # pinned to the shorter archive
    root = tmp_path / "stt"
    with pytest.raises(AppError) as info:
        streaming_models.install(root, KROKO, threading.Event(), lambda *_: None)
    assert "larger than its pinned size" in info.value.message
    assert not (streaming_models.folder(root) / "kroko-en").exists()


def test_an_existing_incomplete_folder_is_refused_before_any_download(
    serve, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = archive_bytes(tmp_path)
    server = serve({"/kroko.tar.bz2": lambda handler: reply(handler, 200, archive)})
    fake_catalog(monkeypatch, server, archive)
    root = tmp_path / "stt"
    partial = streaming_models.folder(root) / "kroko-en"
    partial.mkdir(parents=True)
    (partial / "tokens.txt").write_bytes(b"mine")
    with pytest.raises(AppError) as info:
        streaming_models.install(root, KROKO, threading.Event(), lambda *_: None)
    assert "already exists but is incomplete" in info.value.message
    assert (partial / "tokens.txt").read_bytes() == b"mine"
    assert server.hits == []


def test_cancel_during_the_download_publishes_nothing(serve, tmp_path: Path,
                                                      monkeypatch: pytest.MonkeyPatch) -> None:
    archive = archive_bytes(tmp_path)
    server = serve({"/kroko.tar.bz2": lambda handler: reply(handler, 200, archive)})
    fake_catalog(monkeypatch, server, archive)
    root = tmp_path / "stt"
    cancel = threading.Event()

    def progress(stage: str, done: int, total: int) -> None:
        if stage == "downloading":
            cancel.set()

    with pytest.raises(AppError) as info:
        streaming_models.install(root, KROKO, cancel, progress)
    assert info.value.code == "model_cancelled"
    assert [path.name for path in streaming_models.folder(root).iterdir()] == []


def test_a_custom_folder_is_never_installed(tmp_path: Path) -> None:
    with pytest.raises(AppError) as info:
        streaming_models.install(tmp_path, "stream-dir:team-kroko", threading.Event(), lambda *_: None)
    assert "not a download" in info.value.message


# ---- recognizer --------------------------------------------------------------------------


def test_the_recognizer_loads_a_transducer_with_the_endpoint_rules(tmp_path: Path,
                                                                  monkeypatch: pytest.MonkeyPatch,
                                                                  sherpa_fake: list[tuple[str, dict[str, Any]]]) -> None:
    monkeypatch.setattr(streaming_models, "engine_available", lambda: True)
    directory = touching(tmp_path)
    streaming_models.recognizer(tmp_path, KROKO, threads=3)
    name, kwargs = sherpa_fake[0]
    assert name == "from_transducer"
    assert kwargs == {
        "encoder": str(directory / "encoder.onnx"),
        "decoder": str(directory / "decoder.onnx"),
        "joiner": str(directory / "joiner.onnx"),
        "tokens": str(directory / "tokens.txt"),
        "num_threads": 3,
        "sample_rate": 16000,
        "feature_dim": 80,
        "enable_endpoint_detection": True,
        "rule1_min_trailing_silence": 2.4,
        "rule2_min_trailing_silence": 0.8,
        "rule3_min_utterance_length": 20.0,
        "decoding_method": "greedy_search",
    }


def test_a_custom_nemo_ctc_folder_loads_through_from_nemo_ctc(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                              sherpa_fake: list[tuple[str, dict[str, Any]]]) -> None:
    monkeypatch.setattr(streaming_models, "engine_available", lambda: True)
    folder = streaming_models.folder(tmp_path) / "custom" / "ctc"
    folder.mkdir(parents=True)
    (folder / "model.onnx").write_bytes(b"m")
    (folder / "tokens.txt").write_bytes(b"t")
    streaming_models.recognizer(tmp_path, "stream-dir:ctc")
    name, kwargs = sherpa_fake[0]
    assert name == "from_nemo_ctc"
    assert kwargs["model"] == str(folder / "model.onnx") and kwargs["tokens"] == str(folder / "tokens.txt")
    assert kwargs["enable_endpoint_detection"] is True


def test_a_missing_streaming_model_names_the_download_that_fixes_it(tmp_path: Path,
                                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(streaming_models, "engine_available", lambda: True)
    with pytest.raises(AppError) as info:
        streaming_models.recognizer(tmp_path, NEMO)
    assert info.value.code == "live_model"
    assert info.value.message == "Download Streaming English (NeMo) in Settings first."
