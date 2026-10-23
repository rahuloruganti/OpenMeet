"""Archive extraction attacks, on synthetic .tar.bz2 files built here. Nothing is downloaded.

Each hostile member must refuse the whole archive, write nothing outside the staging folder, and leave the
staging folder for the caller to remove. The wanted names are "tokens.txt" and "model.int8.onnx".
"""

from __future__ import annotations

import bz2
import io
import tarfile
import threading
import uuid
from pathlib import Path
from typing import Any, Iterable, Optional

import pytest

from openmeet_py.api.errors import AppError
from openmeet_py.speech import safe_archive

WANTED = ("tokens.txt", "model.int8.onnx")
GOOD = [
    ("pack/", None, tarfile.DIRTYPE),
    ("pack/tokens.txt", b"a 1\n", tarfile.REGTYPE),
    ("pack/test_wavs/0.wav", b"RIFF-fictional", tarfile.REGTYPE),
    ("pack/model.int8.onnx", b"fictional-weights", tarfile.REGTYPE),
]


def build(path: Path, members: Iterable[tuple[str, Optional[bytes], bytes]], *, raw: Optional[bytes] = None) -> Path:
    """Writes a .tar.bz2 whose members are (name, body, type). Links carry body None and a link target in `body`."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as tar:
        for name, body, kind in members:
            info = tarfile.TarInfo(name)
            info.type = kind
            if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                info.linkname = body.decode()
            elif kind in (tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.FIFOTYPE, tarfile.DIRTYPE):
                info.size = 0
            else:
                info.size = len(body or b"")
            tar.addfile(info, io.BytesIO(body or b"") if kind in (tarfile.REGTYPE, tarfile.AREGTYPE) else None)
    data = raw if raw is not None else bz2.compress(buffer.getvalue())
    path.write_bytes(data)
    return path


def normal(name: str, body: bytes = b"x") -> tuple[str, bytes, bytes]:
    return (name, body, tarfile.REGTYPE)


def extract(tmp_path: Path, archive: Path, cancel: Any = None) -> Path:
    staging = tmp_path / "staging"
    staging.mkdir()
    safe_archive.extract_wanted(archive, staging, WANTED, cancel or threading.Event())
    return staging


def refused(tmp_path: Path, members: list[tuple[str, Optional[bytes], bytes]], **kwargs: Any) -> AppError:
    work = tmp_path / uuid.uuid4().hex  # one folder per call, so a test may refuse several archives
    work.mkdir()
    archive = build(work / "hostile.tar.bz2", members, **kwargs)
    staging = work / "staging"
    staging.mkdir()
    with pytest.raises(AppError) as info:
        safe_archive.extract_wanted(archive, staging, WANTED, threading.Event())
    # Nothing was written outside the staging folder, and nothing wanted was published.
    outside = [p for p in work.rglob("*") if p.is_file() and p.relative_to(work).parts[0] != "staging"]
    assert [p.name for p in outside] == ["hostile.tar.bz2"]
    return info.value


def test_a_clean_archive_yields_the_wanted_files_by_basename(tmp_path: Path) -> None:
    staging = extract(tmp_path, build(tmp_path / "ok.tar.bz2", GOOD))
    assert sorted(p.name for p in staging.iterdir()) == ["model.int8.onnx", "tokens.txt"]
    assert (staging / "tokens.txt").read_bytes() == b"a 1\n"


@pytest.mark.parametrize(
    "name",
    ["/etc/passwd", "../escape.txt", "pack/../../escape.txt", "C:/Windows/evil.txt", "C:evil", "pack\\..\\evil.txt", "a:b.txt", "pack//double.txt"],
)
def test_unsafe_member_names_refuse_the_whole_archive(tmp_path: Path, name: str) -> None:
    error = refused(tmp_path, [normal("pack/tokens.txt"), normal(name)])
    assert error.code == "stt"
    assert "unsafe" in error.message


def test_a_symlink_is_refused_even_under_a_wanted_name(tmp_path: Path) -> None:
    error = refused(tmp_path, [(  "pack/tokens.txt", b"/etc/passwd", tarfile.SYMTYPE)])
    assert "unsafe" in error.message


def test_a_hard_link_is_refused(tmp_path: Path) -> None:
    error = refused(tmp_path, [normal("pack/real.txt"), ("pack/tokens.txt", b"pack/real.txt", tarfile.LNKTYPE)])
    assert "unsafe" in error.message


@pytest.mark.parametrize("kind", [tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.FIFOTYPE])
def test_device_and_fifo_members_are_refused(tmp_path: Path, kind: bytes) -> None:
    error = refused(tmp_path, [(  "pack/tokens.txt", None, kind)])
    assert "unsafe" in error.message


def test_duplicate_paths_are_refused_even_when_case_differs(tmp_path: Path) -> None:
    assert "unsafe" in refused(tmp_path, [normal("pack/tokens.txt"), normal("pack/tokens.txt", b"again")]).message
    assert "unsafe" in refused(tmp_path, [normal("pack/Tokens.txt"), normal("pack/tokens.txt")]).message


def test_two_wanted_files_with_one_name_are_ambiguous_and_refused(tmp_path: Path) -> None:
    assert "unsafe" in refused(tmp_path, [normal("a/tokens.txt"), normal("b/tokens.txt")]).message


def test_too_many_members_are_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(safe_archive, "MAX_MEMBERS", 3)
    members = [normal(f"pack/file{i}.txt") for i in range(5)]
    assert "unsafe" in refused(tmp_path, members).message


def test_a_member_declaring_more_than_the_per_file_cap_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(safe_archive, "MAX_MEMBER_BYTES", 10)
    assert "unsafe" in refused(tmp_path, [normal("pack/tokens.txt", b"x" * 20)]).message


def test_the_total_declared_size_cap_refuses_a_bomb_of_many_small_members(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(safe_archive, "MAX_TOTAL_BYTES", 30)
    members = [normal(f"pack/part{i}.bin", b"x" * 15) for i in range(3)]
    assert "unsafe" in refused(tmp_path, members).message


def test_a_truncated_bz2_stream_is_a_clean_unreadable_error(tmp_path: Path) -> None:
    whole_file = build(tmp_path / "whole.tar.bz2", GOOD)
    whole = whole_file.read_bytes()
    whole_file.unlink()
    error = refused(tmp_path, [], raw=whole[: len(whole) // 2])
    assert error.message == "A downloaded speech archive could not be read."


def test_bytes_that_are_not_an_archive_are_refused(tmp_path: Path) -> None:
    error = refused(tmp_path, [], raw=b"not an archive at all, fictional")
    assert error.message == "A downloaded speech archive could not be read."


def test_a_missing_wanted_file_is_reported(tmp_path: Path) -> None:
    archive = build(tmp_path / "partial.tar.bz2", [normal("pack/tokens.txt")])
    staging = tmp_path / "staging"
    staging.mkdir()
    with pytest.raises(AppError) as info:
        safe_archive.extract_wanted(archive, staging, WANTED, threading.Event())
    assert info.value.message == "A downloaded speech archive did not contain the expected files."


class CancelAfter:
    """A cancel event that reports itself set after a number of checks."""

    def __init__(self, checks: int) -> None:
        self.checks = checks

    def is_set(self) -> bool:
        self.checks -= 1
        return self.checks < 0


def test_cancel_mid_extract_stops_with_the_cancel_error(tmp_path: Path) -> None:
    archive = build(tmp_path / "ok.tar.bz2", GOOD)
    staging = tmp_path / "staging"
    staging.mkdir()
    with pytest.raises(AppError) as info:
        safe_archive.extract_wanted(archive, staging, WANTED, CancelAfter(3))  # type: ignore[arg-type]
    assert info.value.code == "model_cancelled"


def test_an_existing_file_in_the_staging_folder_is_never_overwritten(tmp_path: Path) -> None:
    archive = build(tmp_path / "ok.tar.bz2", GOOD)
    staging = tmp_path / "staging"
    staging.mkdir()
    (staging / "tokens.txt").write_bytes(b"keep me")
    with pytest.raises(AppError) as info:
        safe_archive.extract_wanted(archive, staging, WANTED, threading.Event())
    assert info.value.message == "Cannot write the speech model files. Check available disk space."
    assert (staging / "tokens.txt").read_bytes() == b"keep me"
