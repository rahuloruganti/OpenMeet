"""Local AI building blocks: hardware probes, the pinned catalog, the engine and the supervisor.

No real hardware, no real process, no network and no real time: every probe, spawn and clock is
injected. The engine tests write their own zip archives in a temporary folder.
"""

from __future__ import annotations

import itertools
import math
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
    assert set(pinned.engine.backends) == {"cuda", "vulkan", "cpu"}
    assert len(pinned.engine.files("cuda")) == 2
    assert all(entry.url.startswith("https://github.com/ggml-org/llama.cpp/") for entry in pinned.engine.files("cpu"))
    for entry in pinned.models:
        assert len(entry.sha256) == 64 and len(entry.revision) == 40
        assert entry.size_bytes > 0 and entry.kv_bytes_per_token > 0 and entry.n_layers > 0


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


def test_recommended_is_the_best_model_that_fits_the_gpu() -> None:
    pinned = catalog.load()
    big = {"vram_bytes": 16 * 1024**3, "ram_available_bytes": 32 * 1024**3}
    fits = {entry.id: catalog.fit_of(entry, pinned.context_tokens, big) for entry in pinned.models}
    assert fits["qwen3-30b-a3b-instruct"] == "ram"
    assert fits["qwen3-14b"] == "gpu"
    assert catalog.recommended(pinned, fits) == "qwen3-14b"


def test_without_a_gpu_the_best_small_model_that_fits_ram_is_recommended() -> None:
    pinned = catalog.load()
    cpu = {"vram_bytes": None, "ram_available_bytes": 32 * 1024**3}
    fits = {entry.id: catalog.fit_of(entry, pinned.context_tokens, cpu) for entry in pinned.models}
    assert "gpu" not in fits.values()
    assert catalog.recommended(pinned, fits) == "qwen3-8b"
    none = {entry.id: "too_big" for entry in pinned.models}
    assert catalog.recommended(pinned, none) is None


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


# ---- engine --------------------------------------------------------------------------


def write_zip(path: Path, entries: dict[str, bytes], modes: Optional[dict[str, int]] = None) -> bytes:
    with zipfile.ZipFile(path, "w") as bundle:
        for name, body in entries.items():
            info = zipfile.ZipInfo(name)
            if modes and name in modes:
                info.external_attr = modes[name] << 16
            bundle.writestr(info, body)
    return path.read_bytes()


def engine_catalog(archive: bytes, files: int = 1) -> catalog.Catalog:
    """A one-model catalog whose engine is one tiny zip served from the pinned URL."""
    entry = catalog.EngineFile(
        url="https://github.com/ggml-org/llama.cpp/releases/download/b11671/llama-b11671-bin-win-cpu-x64.zip",
        size=len(archive),
        sha256="c" * 64,
    )
    return catalog.Catalog(
        context_tokens=16384,
        engine=catalog.Engine(tag="b11671", backends={"cpu": tuple([entry] * files)}),
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

    found = server.Supervisor(
        spawn=spawn,
        probe=probe or (lambda _spec: True),
        touch=touch or (lambda _spec: True),
        job_factory=job,
        sleep=(sleeps.append if sleeps is not None else (lambda _seconds: time.sleep(0.01))),
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
