"""The macOS version parser: a bare major is a .0 release, 10.16 is unknown, junk is None."""

from __future__ import annotations

import platform
import sys

import pytest

from openmeet_py.platform import macos_version


def _report(monkeypatch: pytest.MonkeyPatch, text: str) -> None:
    monkeypatch.setattr(platform, "mac_ver", lambda: (text, ("", "", ""), ""))


@pytest.mark.parametrize(
    "text,expected",
    [
        ("14.2", (14, 2)),
        ("14.2.1", (14, 2)),
        ("14", (14, 0)),
        ("15", (15, 0)),
        ("13.6.7", (13, 6)),
    ],
)
def test_the_major_and_minor_are_read_and_a_missing_minor_is_zero(
    monkeypatch: pytest.MonkeyPatch, text: str, expected: tuple[int, int]
) -> None:
    _report(monkeypatch, text)
    assert macos_version.macos_version() == expected


@pytest.mark.parametrize("text", ["10.16", "10.16.0"])
def test_the_sdk_compatibility_report_of_10_16_is_unknown(monkeypatch: pytest.MonkeyPatch, text: str) -> None:
    _report(monkeypatch, text)
    assert macos_version.macos_version() is None
    monkeypatch.setattr(sys, "platform", "darwin")
    assert macos_version.process_audio_supported() is False


@pytest.mark.parametrize("text", ["", "unknown", "14.x", "x.2"])
def test_an_unreadable_version_is_none(monkeypatch: pytest.MonkeyPatch, text: str) -> None:
    _report(monkeypatch, text)
    assert macos_version.macos_version() is None


@pytest.mark.parametrize(
    "text,supported",
    [("14", False), ("14.1.9", False), ("14.2", True), ("14.2.1", True), ("15", True)],
)
def test_process_audio_needs_14_2_and_a_bare_14_is_14_0(
    monkeypatch: pytest.MonkeyPatch, text: str, supported: bool
) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    _report(monkeypatch, text)
    assert macos_version.process_audio_supported() is supported


def test_process_audio_is_false_off_macos(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    _report(monkeypatch, "15.0")
    assert macos_version.process_audio_supported() is False
