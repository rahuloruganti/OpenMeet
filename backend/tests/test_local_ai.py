"""Local AI building blocks: hardware probes, the pinned catalog, the engine and the supervisor.

No real hardware, no real process, no network and no real time: every probe, spawn and clock is
injected. The engine tests write their own zip and tar.gz archives in a temporary folder.
"""

from __future__ import annotations

import io
import itertools
import math
import os
import sys
import tarfile
import threading
import time
import zipfile
from pathlib import Path
from typing import Any, Optional

import pytest

from openmeet_py.api.errors import AppError
from openmeet_py.local_ai import catalog, engine, hardware, server
from openmeet_py.speech import model_library


# ---- hardware ------------------------------------------------------------------------


def test_nvidia_smi_supplies_the_gpu_name_vram_and_cuda_backend() -> None:
    found = hardware.detect(
        nvidia_smi=lambda: "NVIDIA GeForce RTX 3060, 6144\nNVIDIA GeForce RTX 4070, 12282\n",
        adapters=lambda: ["Intel(R) UHD Graphics"],
        memory=lambda: (32 * 1024**3, 20 * 1024**3),
    )
    assert found["gpu_name"] == "NVIDIA GeForce RTX 4070"
    assert found["gpu_vendor"] == "nvidia"
    assert found["vram_bytes"] == 12282 * 1024 * 1024
    assert found["backend"] == "cuda"
    assert (found["ram_bytes"], found["ram_available_bytes"]) == (32 * 1024**3, 20 * 1024**3)


def test_an_amd_adapter_uses_vulkan_and_reports_no_vram() -> None:
    found = hardware.detect(
        nvidia_smi=lambda: "",
        adapters=lambda: ["Microsoft Basic Display Adapter", "AMD Radeon RX 7800 XT"],
        memory=lambda: (16 * 1024**3, 8 * 1024**3),
    )
    assert found["gpu_name"] == "AMD Radeon RX 7800 XT"
    assert found["gpu_vendor"] == "amd"
    assert found["vram_bytes"] is None
    assert found["backend"] == "vulkan"


def test_intel_uses_vulkan_and_an_unknown_adapter_uses_the_cpu_build() -> None:
    intel = hardware.detect(
        nvidia_smi=lambda: "",
        adapters=lambda: ["Intel(R) Arc(TM) A770 Graphics"],
        memory=lambda: (64 * 1024**3, 60 * 1024**3),
    )
    assert (intel["gpu_vendor"], intel["backend"]) == ("intel", "vulkan")
    unknown = hardware.detect(
        nvidia_smi=lambda: "",
        adapters=lambda: ["Some Future Graphics Device"],
        memory=lambda: (8 * 1024**3, 4 * 1024**3),
    )
    assert (unknown["gpu_name"], unknown["gpu_vendor"], unknown["backend"]) == (
        "Some Future Graphics Device",
        None,
        "cpu",
    )
    assert hardware.vendor_of("Whatever") is None


def test_no_readable_gpu_at_all_is_a_cpu_build() -> None:
    found = hardware.detect(
        nvidia_smi=lambda: "", adapters=lambda: [], memory=lambda: (8 * 1024**3, 8 * 1024**3)
    )
    assert found["gpu_name"] is None and found["gpu_vendor"] is None
    assert found["vram_bytes"] is None and found["backend"] == "cpu"


def test_unreadable_nvidia_smi_output_is_ignored() -> None:
    assert hardware.parse_nvidia_smi("") is None
    assert hardware.parse_nvidia_smi("no gpu here") is None
    assert hardware.parse_nvidia_smi("RTX 9999, [N/A]") == ("RTX 9999", None)


# ---- catalog -------------------------------------------------------------------------


def test_the_bundled_catalog_holds_the_verified_pins() -> None:
    catalog.load.cache_clear()
    pinned = catalog.load()
    assert pinned.engine.tag == "b11671"
    assert pinned.context_tokens == 16384
    assert len(pinned.models) == 7
    assert set(pinned.engine.backends) == {"cuda", "vulkan", "cpu", "metal"}
    assert len(pinned.engine.files("cuda")) == 2
    assert all(entry.url.startswith("https://github.com/ggml-org/llama.cpp/") for entry in pinned.engine.files("cpu"))
    assert len(pinned.engine.files("metal")) == 1
    for entry in pinned.models:
        assert len(entry.sha256) == 64 and len(entry.revision) == 40
        assert entry.size_bytes > 0 and entry.kv_bytes_per_token > 0 and entry.n_layers > 0


def test_the_macos_pin_is_the_arm64_tarball_with_its_release_digest() -> None:
    catalog.load.cache_clear()
    metal = catalog.load().engine.files("metal")
    assert [entry.url for entry in metal] == [
        "https://github.com/ggml-org/llama.cpp/releases/download/b11671/"
        "llama-b11671-bin-macos-arm64.tar.gz"
    ]
    assert metal[0].size == 12201717
    assert metal[0].sha256 == "0f9c093f77b9c194f2f097df6204d9f5f8758968815e7db0374e98b0485ef9df"
    for backend in ("cuda", "vulkan", "cpu", "metal"):
        assert all(entry.url.endswith(catalog.ENGINE_SUFFIXES) for entry in catalog.load().engine.files(backend))


def test_fit_uses_vram_first_then_available_ram() -> None:
    pinned = catalog.load()
    small = pinned.model("qwen3-4b-instruct")
    assert small is not None
    need = catalog.needs_bytes(small.size_bytes, small.kv_bytes_per_token, pinned.context_tokens)
    assert need == small.size_bytes + 16384 * small.kv_bytes_per_token + 600 * 1024 * 1024
    gpu = {"vram_bytes": math.ceil(need / 0.9), "ram_available_bytes": 0}
    assert catalog.fit(need, gpu) == "gpu"
    half = {"vram_bytes": int(need / 1.8), "ram_available_bytes": need}
    assert catalog.fit(need, half) == "ram"
    tight = {"vram_bytes": 0, "ram_available_bytes": need // 2}
    assert catalog.fit(need, tight) == "too_big"
    assert catalog.fit(need, {"vram_bytes": None, "ram_available_bytes": math.ceil(need / 0.7)}) == "ram"


def test_offload_layers_pours_everything_on_the_gpu_or_only_what_fits() -> None:
    pinned = catalog.load()
    model = pinned.model("qwen3-8b")
    assert model is not None
    assert catalog.offload_layers(model, "gpu", 8 * 1024**3) == 999
    assert catalog.offload_layers(model, "ram", None) == 0
    partial = catalog.offload_layers(model, "ram", model.size_bytes // 2)
    assert partial == math.floor(model.n_layers * 0.9 / 2)
    assert 0 < partial < model.n_layers


def test_a_broken_pin_is_refused_instead_of_guessed() -> None:
    raw = {
        "context_tokens": 16384,
        "engine": {
            "tag": "b1",
            "backends": {"cpu": [{"url": "https://example.com/a.zip", "size": 10, "sha256": "0" * 64}]},
        },
        "models": [
            {
                "id": "one",
                "name": "One",
                "description": "",
                "repo": "owner/name",
                "revision": "a" * 40,
                "file": "one.gguf",
                "size_bytes": 10,
                "sha256": "not-a-checksum",
                "license": None,
                "n_layers": 1,
                "kv_bytes_per_token": 1,
                "quality": 1,
            }
        ],
    }
    with pytest.raises(AppError) as caught:
        catalog.parse(raw)
    assert caught.value.code == "local_ai_catalog"
    raw["models"][0]["sha256"] = "b" * 64  # type: ignore[index]
    assert catalog.parse(raw).models[0].id == "one"


def raw_catalog(url: str) -> dict[str, Any]:
    """One valid catalog record whose only engine file is served from url."""
    return {
        "context_tokens": 16384,
        "engine": {"tag": "b1", "backends": {"cpu": [{"url": url, "size": 10, "sha256": "0" * 64}]}},
        "models": [
            {
                "id": "one",
                "name": "One",
                "description": "",
                "repo": "owner/name",
                "revision": "a" * 40,
                "file": "one.gguf",
                "size_bytes": 10,
                "sha256": "b" * 64,
                "license": None,
                "n_layers": 1,
                "kv_bytes_per_token": 1,
                "quality": 1,
            }
        ],
    }


def test_an_engine_pin_must_name_a_zip_or_a_tar_gz() -> None:
    for allowed in (".zip", ".tar.gz"):
        url = f"https://github.com/ggml-org/llama.cpp/releases/download/b1/engine{allowed}"
        assert catalog.parse(raw_catalog(url)).engine.tag == "b1"
    for refused in (".7z", ".tar.bz2", ".exe", ""):
        url = f"https://github.com/ggml-org/llama.cpp/releases/download/b1/engine{refused}"
        with pytest.raises(AppError) as caught:
            catalog.parse(raw_catalog(url))
        assert caught.value.code == "local_ai_catalog"


# ---- engine --------------------------------------------------------------------------


def write_zip(path: Path, entries: dict[str, bytes], modes: Optional[dict[str, int]] = None) -> bytes:
    with zipfile.ZipFile(path, "w") as bundle:
        for name, body in entries.items():
            info = zipfile.ZipInfo(name)
            if modes and name in modes:
                info.external_attr = modes[name] << 16
            bundle.writestr(info, body)
    return path.read_bytes()


def engine_catalog(
    archive: bytes,
    files: int = 1,
    *,
    backend: str = "cpu",
    name: str = "llama-b11671-bin-win-cpu-x64.zip",
) -> catalog.Catalog:
    """A one-model catalog whose engine is one tiny archive served from the pinned URL."""
    entry = catalog.EngineFile(
        url="https://github.com/ggml-org/llama.cpp/releases/download/b11671/" + name,
        size=len(archive),
        sha256="c" * 64,
    )
    return catalog.Catalog(
        context_tokens=16384,
        engine=catalog.Engine(tag="b11671", backends={backend: tuple([entry] * files)}),
        models=(
            catalog.Model(
                id="tiny",
                name="Tiny",
                description="A stand-in.",
                repo="owner/tiny",
                revision="a" * 40,
                file="tiny.gguf",
                size_bytes=4,
                sha256="d" * 64,
                license="apache-2.0",
                n_layers=1,
                kv_bytes_per_token=1,
                quality=1,
            ),
        ),
    )


def test_the_engine_installs_only_what_the_archive_holds(tmp_path: Path) -> None:
    archive = write_zip(
        tmp_path / "engine.zip", {"llama-server.exe": b"MZ fake", "ggml.dll": b"dll"}
    )
    pinned = engine_catalog(archive)
    base = tmp_path / "local-ai"
    phases: list[str] = []

    def fetch(url: str, folder: Path, name: str, size: int, sha256: str, **kwargs: Any) -> Path:
        path = folder / name
        path.write_bytes(archive)
        kwargs["progress"](size)
        return path

    assert engine.installed(base, pinned.engine.tag, "cpu") is False
    assert engine.missing_bytes(pinned, "cpu", base) == len(archive)
    program = engine.install(
        base, "cpu", pinned, lambda phase, done, total: phases.append(phase),
        None, fetch=fetch,
    )
    assert program.name == "llama-server.exe" and program.is_file()
    assert engine.executable(program.parent) == program
    assert engine.installed(base, pinned.engine.tag, "cpu") is True
    assert engine.missing_bytes(pinned, "cpu", base) == 0
    assert phases == ["download", "verify", "extract"]
    assert not list((base / engine.ENGINE_DIR).glob(".staging-*"))


def test_an_archive_without_llama_server_is_not_installed(tmp_path: Path) -> None:
    archive = write_zip(tmp_path / "engine.zip", {"readme.txt": b"nothing here"})
    pinned = engine_catalog(archive)
    base = tmp_path / "local-ai"

    def fetch(url: str, folder: Path, name: str, size: int, sha256: str, **kwargs: Any) -> Path:
        path = folder / name
        path.write_bytes(archive)
        return path

    with pytest.raises(AppError) as caught:
        engine.install(base, "cpu", pinned, lambda *_: None, None, fetch=fetch)
    assert caught.value.code == "local_ai_engine"
    assert engine.installed(base, pinned.engine.tag, "cpu") is False


def test_an_archive_that_climbs_out_of_the_folder_is_refused(tmp_path: Path) -> None:
    archive = tmp_path / "evil.zip"
    write_zip(archive, {"../escaped.exe": b"MZ"})
    destination = tmp_path / "out"
    with pytest.raises(AppError) as caught:
        engine.extract_zip(archive, destination, None)
    assert caught.value.code == "local_ai_engine"
    assert not (tmp_path / "escaped.exe").exists()


def test_a_link_member_is_refused(tmp_path: Path) -> None:
    archive = tmp_path / "link.zip"
    write_zip(archive, {"link": b"target"}, modes={"link": 0o120777})
    with pytest.raises(AppError):
        engine.extract_zip(archive, tmp_path / "out", None)


def test_a_cancelled_engine_install_leaves_nothing_behind(tmp_path: Path) -> None:
    archive = write_zip(tmp_path / "engine.zip", {"llama-server.exe": b"MZ"})
    pinned = engine_catalog(archive)
    base = tmp_path / "local-ai"
    cancel = threading.Event()
    cancel.set()

    def fetch(url: str, folder: Path, name: str, size: int, sha256: str, **kwargs: Any) -> Path:
        model_library.check_cancel(kwargs["cancel"])
        raise AssertionError("the download should have been cancelled")

    with pytest.raises(AppError) as caught:
        engine.install(base, "cpu", pinned, lambda *_: None, cancel, fetch=fetch)
    assert caught.value.code == "model_cancelled"
    assert not (base / engine.ENGINE_DIR / "b11671-cpu").exists()


# ---- engine tarballs -----------------------------------------------------------------


def tar_file(name: str, body: bytes, mode: int = 0o644) -> tuple[tarfile.TarInfo, bytes]:
    info = tarfile.TarInfo(name)
    info.mode = mode
    info.size = len(body)
    return info, body


def tar_link(name: str, target: str, kind: str = "symlink") -> tuple[tarfile.TarInfo, bytes]:
    info = tarfile.TarInfo(name)
    info.type = tarfile.SYMTYPE if kind == "symlink" else tarfile.LNKTYPE
    info.linkname = target
    return info, b""


def write_tar(path: Path, entries: list[tuple[tarfile.TarInfo, bytes]]) -> Path:
    with tarfile.open(path, "w:gz") as bundle:
        for info, body in entries:
            bundle.addfile(info, io.BytesIO(body) if info.isreg() else None)
    return path


def can_symlink(folder: Path) -> bool:
    """Windows needs a privilege to create symlinks, so the positive test is skipped without it."""
    if not hasattr(os, "symlink"):
        return False
    probe = folder / "probe-link"
    try:
        os.symlink("probe-target", probe)
    except (OSError, NotImplementedError):
        return False
    probe.unlink(missing_ok=True)
    return True


MAC_ARCHIVE = "llama-b11671-bin-macos-arm64.tar.gz"


def mac_catalog(archive: bytes) -> catalog.Catalog:
    return engine_catalog(archive, backend="metal", name=MAC_ARCHIVE)


def test_the_server_program_name_follows_the_platform(tmp_path: Path, monkeypatch: Any) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    assert engine.server_program() == "llama-server.exe"
    installed = tmp_path / "b11671-cpu"
    nested = installed / "build" / "bin"
    nested.mkdir(parents=True)
    (nested / "llama-server").write_bytes(b"MZ")
    assert engine.executable(installed) is None  # a Windows engine needs the .exe
    (nested / "llama-server.exe").write_bytes(b"MZ")
    assert engine.executable(installed) == nested / "llama-server.exe"
    monkeypatch.setattr(sys, "platform", "darwin")
    assert engine.server_program() == "llama-server"
    assert engine.executable(installed) == nested / "llama-server"


def test_the_server_and_libraries_get_the_executable_mode(monkeypatch: Any) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    assert engine._file_mode("llama-server") == 0o755
    assert engine._file_mode("libggml.dylib") == 0o755
    assert engine._file_mode("LICENSE") == 0o644
    monkeypatch.setattr(sys, "platform", "win32")
    assert engine._file_mode("llama-server.exe") == 0o755


def test_an_engine_link_that_is_not_an_archive_is_refused() -> None:
    assert engine._archive_name("https://example.com/a.zip", 0) == "a.zip"
    assert engine._archive_name("https://example.com/a.tar.gz", 0) == "a.tar.gz"
    for refused in ("a.7z", "a.tar.bz2", "a.exe", ""):
        with pytest.raises(AppError) as caught:
            engine._archive_name(f"https://example.com/{refused}", 0)
        assert caught.value.code == "local_ai_engine"


def test_a_tarball_installs_the_nested_server_and_keeps_it_executable(
    tmp_path: Path, monkeypatch: Any
) -> None:
    archive = write_tar(
        tmp_path / MAC_ARCHIVE,
        [
            tar_file("llama-b11671/llama-server", b"\xcf\xfa\xed\xfe fake"),
            tar_file("llama-b11671/libggml.dylib", b"dylib"),
            tar_file("llama-b11671/LICENSE", b"MIT"),
        ],
    )
    monkeypatch.setattr(sys, "platform", "darwin")
    pinned = mac_catalog(archive.read_bytes())
    base = tmp_path / "local-ai"

    def fetch(url: str, folder: Path, name: str, size: int, sha256: str, **kwargs: Any) -> Path:
        path = folder / name
        path.write_bytes(archive.read_bytes())
        return path

    program = engine.install(base, "metal", pinned, lambda *_: None, None, fetch=fetch)
    assert program.name == "llama-server"
    assert program.parent.name == "llama-b11671"
    assert program.read_bytes() == b"\xcf\xfa\xed\xfe fake"
    assert (program.parent / "libggml.dylib").is_file()
    assert engine.installed(base, pinned.engine.tag, "metal") is True
    assert not list((base / engine.ENGINE_DIR).glob(".staging-*"))
    if os.name == "posix":
        assert program.stat().st_mode & 0o111
        assert (program.parent / "libggml.dylib").stat().st_mode & 0o111


def test_a_relative_symlink_inside_the_tarball_is_kept(tmp_path: Path) -> None:
    if not can_symlink(tmp_path):
        pytest.skip("this file system cannot create symlinks")
    archive = write_tar(
        tmp_path / MAC_ARCHIVE,
        [
            tar_file("engine/libggml.0.dylib", b"lib"),
            tar_link("engine/libggml.dylib", "libggml.0.dylib"),
        ],
    )
    out = tmp_path / "out"
    engine.extract_tar(archive, out, None)
    link = out / "engine" / "libggml.dylib"
    assert link.is_symlink()
    assert os.readlink(link) == "libggml.0.dylib"
    assert link.read_bytes() == b"lib"


@pytest.mark.parametrize("target", ["../../etc/passwd", "/usr/lib/libSystem.B.dylib", "..\\x"])
def test_a_symlink_that_leaves_the_destination_is_refused(tmp_path: Path, target: str) -> None:
    archive = write_tar(tmp_path / MAC_ARCHIVE, [tar_link("engine/libevil.dylib", target)])
    with pytest.raises(AppError) as caught:
        engine.extract_tar(archive, tmp_path / "out", None)
    assert caught.value.code == "local_ai_engine"
    assert not (tmp_path / "out" / "engine" / "libevil.dylib").is_symlink()


def test_link_checks_accept_a_relative_target_inside_the_destination(tmp_path: Path) -> None:
    """The resolver check runs on every platform, including one that cannot create symlinks."""
    root = tmp_path.resolve()
    target = root / "engine" / "libggml.dylib"
    info = tarfile.TarInfo("engine/libggml.dylib")
    info.linkname = "libggml.0.dylib"
    engine._check_link(info, target, root)
    for refused in ("../elsewhere.dylib", "/usr/lib/libSystem.B.dylib", ""):
        info.linkname = refused
        with pytest.raises(AppError):
            engine._check_link(info, target, root)


def test_a_hard_link_member_is_refused(tmp_path: Path) -> None:
    archive = write_tar(
        tmp_path / MAC_ARCHIVE,
        [tar_file("engine/llama-server", b"x"), tar_link("engine/copy", "engine/llama-server", "hard")],
    )
    with pytest.raises(AppError):
        engine.extract_tar(archive, tmp_path / "out", None)


def test_a_device_member_is_refused(tmp_path: Path) -> None:
    device = tarfile.TarInfo("engine/console")
    device.type = tarfile.CHRTYPE
    device.devmajor, device.devminor = 1, 3
    archive = write_tar(tmp_path / MAC_ARCHIVE, [(device, b"")])
    with pytest.raises(AppError):
        engine.extract_tar(archive, tmp_path / "out", None)


@pytest.mark.parametrize("name", ["../escaped", "/etc/escaped", "engine/../../escaped"])
def test_a_tar_member_that_climbs_out_of_the_folder_is_refused(tmp_path: Path, name: str) -> None:
    archive = write_tar(tmp_path / MAC_ARCHIVE, [tar_file(name, b"x")])
    with pytest.raises(AppError) as caught:
        engine.extract_tar(archive, tmp_path / "out", None)
    assert caught.value.code == "local_ai_engine"
    assert not (tmp_path / "escaped").exists()


def test_duplicate_tar_paths_are_refused_whatever_their_case(tmp_path: Path) -> None:
    archive = write_tar(
        tmp_path / MAC_ARCHIVE,
        [tar_file("engine/lib.dylib", b"a"), tar_file("engine/LIB.dylib", b"b")],
    )
    with pytest.raises(AppError) as caught:
        engine.extract_tar(archive, tmp_path / "out", None)
    assert caught.value.code == "local_ai_engine"


def test_a_tarball_larger_than_its_cap_is_refused(tmp_path: Path, monkeypatch: Any) -> None:
    monkeypatch.setattr(engine, "MAX_MEMBER_BYTES", 4)
    archive = write_tar(tmp_path / MAC_ARCHIVE, [tar_file("engine/big.bin", b"0123456789")])
    with pytest.raises(AppError) as caught:
        engine.extract_tar(archive, tmp_path / "out", None)
    assert caught.value.code == "local_ai_engine"
    monkeypatch.setattr(engine, "MAX_MEMBER_BYTES", 1024)
    monkeypatch.setattr(engine, "MAX_TOTAL_BYTES", 6)
    archive = write_tar(
        tmp_path / "two.tar.gz",
        [tar_file("engine/a.bin", b"0123"), tar_file("engine/b.bin", b"4567")],
    )
    with pytest.raises(AppError):
        engine.extract_tar(archive, tmp_path / "other", None)


def test_a_tarball_reader_cannot_be_tricked_by_a_zip(tmp_path: Path) -> None:
    archive = write_zip(tmp_path / "engine.zip", {"llama-server": b"x"})
    with pytest.raises(AppError):
        engine.extract_tar(tmp_path / "engine.zip", tmp_path / "out", None)


# ---- supervisor ----------------------------------------------------------------------


class FakeProcess:
    """A process that never exists: poll/terminate/wait behave, nothing is started."""

    def __init__(self) -> None:
        self.alive = True
        self.terminated = False
        self.pid = 4242

    def poll(self) -> Optional[int]:
        return None if self.alive else 1

    def terminate(self) -> None:
        self.terminated = True
        self.alive = False

    def wait(self, timeout: Optional[float] = None) -> int:
        return 1

    def kill(self) -> None:
        self.alive = False


class FakeJob:
    def __init__(self) -> None:
        self.assigned: list[Any] = []
        self.closed = False

    def assign(self, process: Any) -> None:
        self.assigned.append(process)

    def close(self) -> None:
        self.closed = True


def spec(tmp_path: Path) -> server.Spec:
    return server.Spec(
        executable=tmp_path / "llama-server.exe",
        model_path=tmp_path / "tiny.gguf",
        model="tiny",
        port=39281,
        api_key="test-key",
        layers=999,
        context=16384,
        log_path=tmp_path / "server.log",
    )


def supervisor(
    tmp_path: Path,
    *,
    processes: Optional[list[FakeProcess]] = None,
    probe: Any = None,
    touch: Any = None,
    sleeps: Optional[list[float]] = None,
    clock: Any = None,
    timeout: float = 180.0,
    sleep: Any = None,
) -> tuple[server.Supervisor, list[FakeProcess], list[FakeJob]]:
    queue = list(processes or [FakeProcess()])
    spawned: list[FakeProcess] = []
    jobs: list[FakeJob] = []

    def spawn(_spec: server.Spec) -> FakeProcess:
        process = queue.pop(0) if len(queue) > 1 else queue[0]
        spawned.append(process)
        return process

    def job() -> FakeJob:
        created = FakeJob()
        jobs.append(created)
        return created

    if sleep is None:
        sleep = sleeps.append if sleeps is not None else (lambda _seconds: time.sleep(0.01))
    found = server.Supervisor(
        spawn=spawn,
        probe=probe or (lambda _spec: True),
        touch=touch or (lambda _spec: True),
        job_factory=job,
        sleep=sleep,
        clock=clock or (lambda: 0.0),
        timeout=timeout,
    )
    return found, spawned, jobs


def test_arguments_are_the_documented_command_line(tmp_path: Path) -> None:
    command = server.arguments(spec(tmp_path))
    assert command[1:5] == ["-m", str(tmp_path / "tiny.gguf"), "--alias", "tiny"]
    for flag in ("--host", "--port", "--ctx-size", "--jinja", "--no-webui", "-ngl"):
        assert flag in command
    assert command[command.index("--host") + 1] == "127.0.0.1"
    assert command[command.index("--ctx-size") + 1] == "16384"
    assert "-v" not in command and "--verbose" not in command


def test_the_key_goes_in_the_environment_never_on_the_command_line(tmp_path: Path) -> None:
    built = spec(tmp_path)
    command = server.arguments(built)
    assert "--api-key" not in command and built.api_key not in command
    assert server.environment(built)["LLAMA_API_KEY"] == built.api_key


def test_the_server_counts_as_running_only_after_health_and_one_touch(tmp_path: Path) -> None:
    answers = iter([False, False, True])
    probed: list[int] = []
    touched: list[str] = []
    sleeps: list[float] = []

    def probe(_spec: server.Spec) -> bool:
        probed.append(1)
        return next(answers)

    def touch(taken: server.Spec) -> bool:
        touched.append(taken.model)
        return True

    found, spawned, jobs = supervisor(tmp_path, probe=probe, touch=touch, sleeps=sleeps)
    found.start(spec(tmp_path), background=False)

    assert found.state == "running"
    assert len(probed) == 3 and sleeps == [1.0, 1.0]
    assert touched == ["tiny"]
    assert len(spawned) == 1 and jobs[0].assigned == [spawned[0]]

    found.stop()
    assert found.state == "stopped"
    assert spawned[0].terminated and jobs[0].closed


def test_a_crash_is_restarted_once_and_then_reported_as_failed(tmp_path: Path) -> None:
    first, second = FakeProcess(), FakeProcess()
    found, spawned, jobs = supervisor(tmp_path, processes=[first, second])
    found.start(spec(tmp_path), background=False)
    assert found.state == "running"

    first.alive = False
    assert found._tick() is True  # one restart
    assert len(spawned) == 2 and found.state == "running"
    assert jobs[0].closed and jobs[1].assigned == [second]

    second.alive = False
    assert found._tick() is False
    assert found.state == "failed"
    assert found.error_message == server.CRASH_MESSAGE
    assert "server.log" in (found.error_message or "")


def test_a_server_that_never_answers_health_times_out(tmp_path: Path) -> None:
    ticks = itertools.count(0.0, 1.0)
    sleeps: list[float] = []

    def clock() -> float:
        return float(next(ticks))

    found, spawned, _ = supervisor(
        tmp_path, probe=lambda _spec: False, sleeps=sleeps, clock=clock, timeout=3.0
    )
    found.start(spec(tmp_path), background=False)
    assert found.state == "failed"
    assert found.error_message == server.TIMEOUT_MESSAGE
    assert spawned[0].terminated


def test_a_server_that_answers_health_but_not_the_touch_is_not_running(tmp_path: Path) -> None:
    found, _, _ = supervisor(tmp_path, touch=lambda _spec: False)
    found.start(spec(tmp_path), background=False)
    assert found.state == "failed"
    assert found.error_message == server.SILENT_MESSAGE


def test_a_process_that_exits_during_startup_fails_with_the_fix(tmp_path: Path) -> None:
    process = FakeProcess()
    process.alive = False
    found, _, _ = supervisor(tmp_path, processes=[process])
    found.start(spec(tmp_path), background=False)
    assert found.state == "failed"
    assert found.error_message == server.SPAWN_MESSAGE


def test_ensure_does_not_restart_a_server_that_is_already_running(tmp_path: Path) -> None:
    found, spawned, _ = supervisor(tmp_path)
    found.ensure(spec(tmp_path))
    assert found.state == "running"
    found.ensure(spec(tmp_path))
    assert len(spawned) == 1
    found.stop()


def test_a_spawn_failure_is_reported_with_the_fix(tmp_path: Path) -> None:
    def refuse(_spec: server.Spec) -> FakeProcess:
        raise OSError("no such file")

    found = server.Supervisor(
        spawn=refuse,
        probe=lambda _spec: True,
        touch=lambda _spec: True,
        job_factory=FakeJob,
        sleep=lambda _seconds: None,
    )
    found.start(spec(tmp_path), background=False)
    assert found.state == "failed"
    assert found.error_message == server.SPAWN_MESSAGE


# ---- supervisor lifecycle races: every interleaving is held open by an Event, never by timing ----


def wait_for(predicate: Any, timeout: float = 5.0) -> bool:
    """Polls a condition the code under test produces. Bounded, so a regression fails instead of hanging."""
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.001)
    return True


def test_stop_does_not_wait_for_a_blocking_start_to_finish(tmp_path: Path) -> None:
    waiting = threading.Event()
    release = threading.Event()
    ticks = itertools.count(0.0, 1.0)  # the readiness loop still ends if stop is not honoured

    def sleep(_seconds: float) -> None:
        waiting.set()
        release.wait(timeout=5)

    found, spawned, jobs = supervisor(
        tmp_path,
        probe=lambda _spec: False,
        sleep=sleep,
        clock=lambda: next(ticks),
    )
    starter = threading.Thread(
        target=found.start, args=(spec(tmp_path),), kwargs={"background": False}
    )
    starter.start()
    try:
        assert waiting.wait(5)
        stopper = threading.Thread(target=found.stop)
        stopper.start()
        stopper.join(2)
        assert not stopper.is_alive(), "stop() waited for the readiness loop"
        assert found.state == "stopped"
    finally:
        release.set()
        starter.join(5)
    assert not starter.is_alive()
    assert found.state == "stopped"
    assert spawned[0].terminated and jobs[0].closed


def test_a_process_spawned_after_stop_is_terminated_not_leaked(tmp_path: Path) -> None:
    process = FakeProcess()
    spawning = threading.Event()
    release = threading.Event()
    jobs: list[FakeJob] = []

    def spawn(_spec: server.Spec) -> FakeProcess:
        spawning.set()
        release.wait(timeout=5)
        return process

    def job() -> FakeJob:
        created = FakeJob()
        jobs.append(created)
        return created

    found = server.Supervisor(
        spawn=spawn,
        probe=lambda _spec: True,
        touch=lambda _spec: True,
        job_factory=job,
        sleep=lambda _seconds: None,
        clock=lambda: 0.0,
    )
    found.start(spec(tmp_path))
    try:
        assert spawning.wait(5)
        stopper = threading.Thread(target=found.stop)
        stopper.start()
        stopper.join(2)
        assert not stopper.is_alive()
        assert found.state == "stopped"
    finally:
        release.set()
    assert wait_for(lambda: process.terminated), "the late process was leaked"
    assert found.state == "stopped"
    assert jobs and jobs[0].closed


def test_a_restart_that_finishes_after_stop_is_terminated(tmp_path: Path) -> None:
    first, second = FakeProcess(), FakeProcess()
    spawning = threading.Event()
    release = threading.Event()
    spawns: list[FakeProcess] = []

    def spawn(_spec: server.Spec) -> FakeProcess:
        spawns.append(first if not spawns else second)
        if len(spawns) == 2:
            spawning.set()
            release.wait(timeout=5)
        return spawns[-1]

    found = server.Supervisor(
        spawn=spawn,
        probe=lambda _spec: True,
        touch=lambda _spec: True,
        job_factory=FakeJob,
        sleep=lambda _seconds: None,
        clock=lambda: 0.0,
    )
    found.start(spec(tmp_path), background=False)
    first.alive = False
    outcome: list[bool] = []
    ticker = threading.Thread(target=lambda: outcome.append(found._tick()))
    ticker.start()
    try:
        assert spawning.wait(5)
        stopper = threading.Thread(target=found.stop)
        stopper.start()
        stopper.join(2)
        assert not stopper.is_alive()
    finally:
        release.set()
    ticker.join(5)
    assert not ticker.is_alive()
    assert outcome == [False]
    assert second.terminated, "the restarted process was leaked"
    assert found.state == "stopped"


def test_ensure_resumes_supervision_after_the_watcher_gave_up(tmp_path: Path) -> None:
    processes = [FakeProcess() for _ in range(4)]
    gate = threading.Semaphore(0)
    found, spawned, _ = supervisor(
        tmp_path,
        processes=processes,
        sleep=lambda _seconds: gate.acquire(timeout=5),
    )
    try:
        found.ensure(spec(tmp_path))
        processes[0].alive = False
        gate.release()  # watcher tick 1: restart with the second process
        assert wait_for(lambda: len(spawned) == 2 and found.state == "running")
        processes[1].alive = False
        gate.release()  # watcher tick 2: second crash, the watcher gives up
        assert found._thread is not None
        found._thread.join(5)
        assert found.state == "failed"

        found.ensure(spec(tmp_path))  # recovery must supervise again
        assert found.state == "running"
        assert found._thread is not None and found._thread.is_alive()
        processes[2].alive = False
        gate.release()
        assert wait_for(lambda: len(spawned) == 4 and found.state == "running")
        assert spawned[3] is processes[3]
    finally:
        found.stop()
        gate.release()


def test_ensure_replaces_a_process_that_died_since_the_last_check(tmp_path: Path) -> None:
    first, second = FakeProcess(), FakeProcess()
    found, spawned, _ = supervisor(tmp_path, processes=[first, second])
    found.start(spec(tmp_path), background=False)
    first.alive = False
    try:
        found.ensure(spec(tmp_path))
        assert len(spawned) == 2
        assert found.state == "running" and second.alive
    finally:
        found.stop()


def test_a_watcher_from_a_stopped_run_does_not_supervise_the_next_run(tmp_path: Path) -> None:
    first, second, third = FakeProcess(), FakeProcess(), FakeProcess()
    gate = threading.Semaphore(0)
    found, spawned, _ = supervisor(
        tmp_path,
        processes=[first, second, third],
        sleep=lambda _seconds: gate.acquire(timeout=5),
    )
    try:
        found.ensure(spec(tmp_path))
        old_watcher = found._thread
        assert old_watcher is not None
        stopper = threading.Thread(target=found.stop)
        stopper.start()
        stopper.join(2)  # stop() must not wait on the old watcher, which is still asleep
        found.start(spec(tmp_path), background=False)
        second.alive = False
        gate.release()  # the old watcher wakes after the new run has started
        old_watcher.join(5)
        assert not old_watcher.is_alive()
        assert len(spawned) == 2, "a stale watcher restarted the newer run"
    finally:
        found.stop()
        gate.release()


def test_an_unexpected_error_in_the_watcher_fails_the_run_instead_of_leaving_it_starting(
    tmp_path: Path,
) -> None:
    first = FakeProcess()
    attempts: list[int] = []
    gate = threading.Semaphore(0)

    def spawn(_spec: server.Spec) -> FakeProcess:
        attempts.append(1)
        if len(attempts) == 1:
            return first
        raise RuntimeError("unexpected spawn failure")

    def pause(_seconds: float) -> None:
        gate.acquire(timeout=5)

    found = server.Supervisor(
        spawn=spawn,
        probe=lambda _spec: True,
        touch=lambda _spec: True,
        job_factory=FakeJob,
        sleep=pause,
        clock=lambda: 0.0,
    )
    try:
        found.ensure(spec(tmp_path))
        first.alive = False
        gate.release()  # the watcher tries to restart and the spawn raises
        assert wait_for(lambda: found.state == "failed"), "the run was left in 'starting'"
        assert found.error_message == server.CRASH_MESSAGE
    finally:
        found.stop()
        gate.release()
