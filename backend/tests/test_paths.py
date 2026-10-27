"""Data folders and bundle paths on Windows and macOS. No real app folder is read."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from openmeet_py import paths


def test_windows_data_folder_follows_appdata(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setenv("APPDATA", str(tmp_path / "Roaming"))
    assert paths.default_data_dir() == tmp_path / "Roaming" / "OpenMeetPy"


def test_macos_data_folder_is_in_application_support(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    assert paths.default_data_dir() == (
        Path.home() / "Library" / "Application Support" / "OpenMeetPy"
    )


def test_the_appdata_variable_is_ignored_on_macos(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setenv("APPDATA", str(tmp_path / "Roaming"))
    assert "AppData" not in str(paths.default_data_dir())


def test_windows_old_folder_is_the_preview_app(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.delenv("OPENMEET_OLD_DATA_DIR", raising=False)
    monkeypatch.setenv("APPDATA", str(tmp_path / "Roaming"))
    assert paths.old_data_dir() == tmp_path / "Roaming" / "dev.openmeet.preview"


def test_macos_has_no_previous_app_folder(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.delenv("OPENMEET_OLD_DATA_DIR", raising=False)
    folder = paths.old_data_dir()
    assert folder == paths.default_data_dir().parent / "OpenMeetPy-no-previous-app"
    assert not folder.exists()


def test_the_old_folder_override_wins_on_both_platforms(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("OPENMEET_OLD_DATA_DIR", str(tmp_path / "old"))
    for platform in ("win32", "darwin"):
        monkeypatch.setattr(sys, "platform", platform)
        assert paths.old_data_dir() == tmp_path / "old"


def _fake_bundle(tmp_path: Path, *, resources: bool) -> Path:
    frameworks = tmp_path / "OpenMeet.app" / "Contents" / "Frameworks"
    frameworks.mkdir(parents=True)
    (frameworks / "web").mkdir()
    (frameworks / "web" / "index.html").write_text("<html></html>", encoding="utf-8")
    if resources:
        real = tmp_path / "OpenMeet.app" / "Contents" / "Resources"
        (real / "openmeet_py" / "migrations").mkdir(parents=True)
        (real / "openmeet_py" / "migrations" / "001_init.sql").write_text("", encoding="utf-8")
    return frameworks


def _freeze(monkeypatch: pytest.MonkeyPatch, bundle_root: Path) -> None:
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(bundle_root), raising=False)


def test_a_macos_onedir_bundle_reads_data_from_contents_resources(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """PyInstaller 6 puts sys._MEIPASS in Contents/Frameworks and the data folders in Resources."""
    root = _fake_bundle(tmp_path, resources=True)
    _freeze(monkeypatch, root)
    resources = tmp_path / "OpenMeet.app" / "Contents" / "Resources"
    assert paths.migrations_dir() == resources / "openmeet_py" / "migrations"
    assert paths.migrations_dir().is_dir()
    # --add-data files are cross-linked back into Frameworks, so both spellings reach the file.
    assert paths.web_dir() == resources / "web"
    assert (root / "web" / "index.html").is_file()


def test_a_frozen_bundle_without_resources_stays_in_meipass(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    root = _fake_bundle(tmp_path, resources=False)
    _freeze(monkeypatch, root)
    assert paths.web_dir() == root / "web"
    assert paths.migrations_dir() == root / "openmeet_py" / "migrations"


def test_a_windows_onefile_bundle_uses_meipass(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    _freeze(monkeypatch, tmp_path / "_MEI123")
    assert paths.web_dir() == tmp_path / "_MEI123" / "web"
    assert paths.migrations_dir() == tmp_path / "_MEI123" / "openmeet_py" / "migrations"


def test_a_source_checkout_reads_next_to_the_package(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    assert paths.migrations_dir() == paths.PACKAGE_DIR / "migrations"
    assert paths.migrations_dir().is_dir()
    assert paths.web_dir() == paths.PACKAGE_DIR.parent / "web"
