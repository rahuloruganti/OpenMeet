"""The local speech target gate: Windows x64 and Apple silicon macOS, and nothing else.

Every other platform (an Intel Mac included) must say so before anything is downloaded, because the
whisper.cpp and sherpa-onnx wheels ship only for those two targets. All checks here run with the
platform faked, so this suite proves the dispatch, never a real Mac.
"""

from __future__ import annotations

import platform
import sys
import threading
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from conftest import invoke, invoke_error
from openmeet_py.speech import model_library, sherpa_models, streaming_models, stt, targets
from test_streaming_models import KROKO, archive_bytes, fake_catalog
from stub_http import reply, serve  # noqa: F401  (serve is the stub-server fixture)

NEEDS_TARGET = "Windows x64 or a Mac with Apple silicon."


def fake_platform(monkeypatch: pytest.MonkeyPatch, name: str, machine: str) -> None:
    monkeypatch.setattr(sys, "platform", name)
    monkeypatch.setattr(platform, "machine", lambda: machine)


@pytest.mark.parametrize("module", [stt, sherpa_models, streaming_models])
def test_speech_modules_import_the_gate_from_targets(module: Any) -> None:
    assert module.local_speech_supported.__module__ == "openmeet_py.speech.targets"


@pytest.mark.parametrize(
    ("name", "machine", "wanted"),
    [
        ("win32", "AMD64", True),
        ("win32", "x86_64", True),
        ("win32", "arm64", False),
        ("darwin", "arm64", True),
        ("darwin", "x86_64", False),
        ("darwin", "AMD64", False),
        ("linux", "x86_64", False),
        ("linux", "aarch64", False),
    ],
)
def test_the_gate_allows_windows_x64_and_apple_silicon_only(
    monkeypatch: pytest.MonkeyPatch, name: str, machine: str, wanted: bool
) -> None:
    fake_platform(monkeypatch, name, machine)
    assert targets.local_speech_supported() is wanted
    assert stt.supported() is wanted


@pytest.mark.parametrize(("name", "machine"), [("win32", "AMD64"), ("darwin", "arm64")])
def test_sherpa_and_streaming_ask_the_same_shared_gate(
    monkeypatch: pytest.MonkeyPatch, name: str, machine: str
) -> None:
    fake_platform(monkeypatch, name, machine)
    monkeypatch.setattr(sherpa_models, "engine_available", lambda: True)
    monkeypatch.setattr(streaming_models, "engine_available", lambda: True)
    assert sherpa_models.supported() is True
    assert sherpa_models.unavailable_reason() is None
    assert streaming_models.unavailable_reason() is None


def test_an_intel_mac_is_told_which_targets_work(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_platform(monkeypatch, "darwin", "x86_64")
    monkeypatch.setattr(sherpa_models, "engine_available", lambda: True)
    monkeypatch.setattr(streaming_models, "engine_available", lambda: True)
    assert sherpa_models.supported() is False
    assert sherpa_models.unavailable_reason() == "sherpa-onnx speech models need " + NEEDS_TARGET
    assert streaming_models.unavailable_reason() == "Live transcript models need " + NEEDS_TARGET


def test_status_reports_apple_silicon_as_supported_and_an_intel_mac_as_not(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(stt, "engine_available", lambda: True)
    fake_platform(monkeypatch, "darwin", "arm64")
    assert invoke(client, "stt_status")["supported"] is True
    fake_platform(monkeypatch, "darwin", "x86_64")
    assert invoke(client, "stt_status")["supported"] is False


def test_whisper_install_on_an_intel_mac_stops_before_any_download(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def no_download(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("no download may start on an unsupported platform")

    monkeypatch.delenv("OPENMEET_PY_FAKE_STT", raising=False)
    monkeypatch.setattr(model_library, "fetch_verified", no_download)
    monkeypatch.setattr(stt, "engine_available", lambda: True)
    fake_platform(monkeypatch, "darwin", "x86_64")
    status, body = invoke_error(client, "stt_install")
    assert status == 400 and body["code"] == "stt"
    assert body["message"] == "Local speech-to-text needs " + NEEDS_TARGET


def test_sherpa_install_on_an_intel_mac_raises_the_same_short_message(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("OPENMEET_PY_FAKE_STT", raising=False)
    fake_platform(monkeypatch, "darwin", "x86_64")
    monkeypatch.setattr(sherpa_models, "engine_available", lambda: True)
    invoke(client, "save_stt_settings", language="en", prompt="", model="sherpa:sense-voice")
    status, body = invoke_error(client, "stt_install")
    assert status == 400 and body["code"] == "stt"
    assert body["message"] == "The sherpa-onnx speech engine needs " + NEEDS_TARGET


def test_a_streaming_install_publishes_its_folder_when_the_gate_is_open(
    serve: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The install path is the same code on a Mac: verified archive, safe extraction, one published folder."""
    archive = archive_bytes(tmp_path)
    server = serve({"/kroko.tar.bz2": lambda handler: reply(handler, 200, archive)})
    fake_catalog(monkeypatch, server, archive)
    fake_platform(monkeypatch, "darwin", "arm64")
    root = tmp_path / "stt"
    streaming_models.install(root, KROKO, threading.Event(), lambda *_: None)
    published = streaming_models.folder(root) / "kroko-en"
    assert sorted(path.name for path in published.iterdir()) == sorted(
        ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt", streaming_models.MARKER]
    )
    assert sorted(path.name for path in streaming_models.folder(root).iterdir()) == ["kroko-en"]
