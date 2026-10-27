"""macOS Local AI: the Apple silicon hardware probe and the managed server's process group.

Everything here runs on Windows against fakes: `sys.platform` is patched to darwin, `sysctl`,
`vm_stat` and `ps` are functions, `subprocess.Popen` is replaced and the process group signal is
recorded. No process is started, no Mac is read and no time is waited. This code has never run on
a Mac, so it is written and unit-tested with fakes, unqualified on a Mac.
"""

from __future__ import annotations

import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Optional

import pytest

from openmeet_py.local_ai import hardware, server

GIB = 1024**3
LLAMA_SERVER = "/Applications/OpenMeet.app/Contents/MacOS/llama-server"

VM_STAT = """Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10240.
Pages active:                            409600.
Pages inactive:                          20480.
Pages speculative:                        5120.
Pages wired down:                        102400.
Pages occupied by compressor:             20480.
"Translation faults":                  12345678.
"""


# ---- hardware probe ------------------------------------------------------------------


def fake_sysctl(answers: dict[str, str]) -> Callable[[str], str]:
    return lambda name: answers.get(name, "")


def test_apple_silicon_reports_metal_and_a_share_of_unified_memory(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    called: list[str] = []

    def never_started() -> str:
        called.append("nvidia-smi")
        return ""

    found = hardware.detect(
        nvidia_smi=never_started,
        sysctl=fake_sysctl(
            {"hw.memsize": "17179869184\n", "machdep.cpu.brand_string": "Apple M3\n"}
        ),
        vm_stat=lambda: VM_STAT,
    )

    assert called == []  # no Windows probe runs on a Mac
    assert found["backend"] == "metal"
    assert found["gpu_name"] == "Apple M3"
    assert found["gpu_vendor"] == "apple"
    assert found["ram_bytes"] == 16 * GIB
    # Unified memory: the GPU is offered a fixed share of total RAM, not a separate pool.
    assert found["vram_bytes"] == int(16 * GIB * hardware.UNIFIED_VRAM_SHARE)
    assert found["ram_available_bytes"] == (10240 + 20480 + 5120) * 16384


def test_the_chip_name_falls_back_to_apple_gpu(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    found = hardware.detect(
        sysctl=fake_sysctl({"hw.memsize": str(8 * GIB)}),
        vm_stat=lambda: VM_STAT,
    )
    assert found["gpu_name"] == hardware.APPLE_GPU
    assert found["backend"] == "metal"


def test_unreadable_apple_memory_is_reported_as_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    found = hardware.detect(sysctl=fake_sysctl({}), vm_stat=lambda: "")
    assert found["ram_bytes"] == 0
    assert found["vram_bytes"] is None
    assert found["ram_available_bytes"] == 0


def test_vm_stat_counts_only_reclaimable_pages() -> None:
    assert hardware.parse_vm_stat(VM_STAT, 16384) == (10240 + 20480 + 5120) * 16384
    assert hardware.parse_vm_stat("", 16384) == 0
    assert hardware.parse_vm_stat("Pages active: 409600.", 16384) == 0


def test_the_vm_stat_page_size_comes_from_its_header_then_the_kernel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert hardware.vm_page_size(VM_STAT) == 16384
    monkeypatch.setattr(hardware.os, "sysconf", lambda name: 4096, raising=False)
    assert hardware.vm_page_size("Pages free: 10240.") == 4096


def test_windows_keeps_its_own_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    found = hardware.detect(
        nvidia_smi=lambda: "NVIDIA GeForce RTX 4070, 12282",
        adapters=lambda: [],
        memory=lambda: (16 * GIB, 8 * GIB),
        sysctl=lambda name: str(64 * GIB),  # must be ignored
        vm_stat=lambda: VM_STAT,
    )
    assert found["backend"] == "cuda"
    assert found["gpu_name"] == "NVIDIA GeForce RTX 4070"
    assert found["ram_bytes"] == 16 * GIB


# ---- server launch and process group ---------------------------------------------------


class FakeMacProcess:
    """A process that never exists: poll, terminate, kill and wait behave, nothing is started."""

    def __init__(self, pid: int = 4242) -> None:
        self.pid = pid
        self.alive = True
        self.terminated = False

    def poll(self) -> Optional[int]:
        return None if self.alive else 1

    def terminate(self) -> None:
        self.terminated = True
        self.alive = False

    def kill(self) -> None:
        self.alive = False

    def wait(self, timeout: Optional[float] = None) -> int:
        self.alive = False
        return 0


class Kills:
    """Records the process group signals, answering whether the group was still there."""

    def __init__(self, accepted: bool = True) -> None:
        self.calls: list[tuple[int, int]] = []
        self.accepted = accepted

    def __call__(self, pid: int, sig: int) -> bool:
        self.calls.append((pid, sig))
        return self.accepted


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
        executable=tmp_path / "engine" / "llama-server",
        model_path=tmp_path / "tiny.gguf",
        model="tiny",
        port=39281,
        api_key="test-key",
        layers=999,
        context=16384,
        log_path=tmp_path / "local-ai" / "server.log",
    )


def supervisor(
    *,
    group_kill: Any = None,
    command_of: Any = None,
    process: Optional[FakeMacProcess] = None,
) -> tuple[server.Supervisor, list[FakeMacProcess], list[FakeJob]]:
    spawned: list[FakeMacProcess] = []
    jobs: list[FakeJob] = []
    one = process or FakeMacProcess()

    def spawn(_spec: server.Spec) -> FakeMacProcess:
        spawned.append(one)
        return one

    def job() -> FakeJob:
        created = FakeJob()
        jobs.append(created)
        return created

    found = server.Supervisor(
        spawn=spawn,
        probe=lambda _spec: True,
        touch=lambda _spec: True,
        job_factory=job,
        group_kill=group_kill or Kills(),
        command_of=command_of or (lambda _pid: ""),
        sleep=lambda _seconds: time.sleep(0.01),
        clock=lambda: 0.0,
    )
    return found, spawned, jobs


@pytest.fixture(autouse=True)
def no_live_servers() -> None:
    """No fake server outlives its test, so one test's hook cannot end another test's process."""
    server._LIVE.clear()


def test_macos_starts_the_server_in_its_own_session(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    started: dict[str, Any] = {}

    class FakePopen:
        def __init__(self, argv: list[str], **kwargs: Any) -> None:
            started["argv"] = argv
            started["kwargs"] = kwargs

    monkeypatch.setattr(server.subprocess, "Popen", FakePopen)
    server.spawn(spec(tmp_path))

    assert started["argv"][0] == str(tmp_path / "engine" / "llama-server")
    assert started["kwargs"]["start_new_session"] is True
    assert "creationflags" not in started["kwargs"]
    assert started["kwargs"]["env"]["LLAMA_API_KEY"] == "test-key"


def test_windows_still_gets_the_no_window_flag(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    started: dict[str, Any] = {}

    class FakePopen:
        def __init__(self, argv: list[str], **kwargs: Any) -> None:
            started["argv"] = argv
            started["kwargs"] = kwargs

    monkeypatch.setattr(server.subprocess, "Popen", FakePopen)
    server.spawn(spec(tmp_path))

    assert "start_new_session" not in started["kwargs"]
    assert started["kwargs"]["creationflags"] == getattr(subprocess, "CREATE_NO_WINDOW", 0)


def test_stopping_the_server_kills_its_group_and_drops_the_pid_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    kills = Kills()
    found, spawned, jobs = supervisor(group_kill=kills)
    built = spec(tmp_path)

    found.start(built, background=False)
    assert found.state == "running"
    assert built.pid_path.read_text(encoding="utf-8") == f"{spawned[0].pid}\n"

    found.stop()
    assert found.state == "stopped"
    assert kills.calls == [(spawned[0].pid, signal.SIGTERM)]
    assert not built.pid_path.exists()
    assert jobs[0].closed


def test_a_stale_pid_file_ends_the_server_a_killed_app_left_behind(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    kills = Kills()
    built = spec(tmp_path)
    built.pid_path.parent.mkdir(parents=True)
    built.pid_path.write_text("999\n", encoding="utf-8")

    found, spawned, _jobs = supervisor(group_kill=kills, command_of=lambda pid: LLAMA_SERVER)
    found.start(built, background=False)

    assert found.state == "running"
    assert kills.calls == [(999, server.SIGKILL)]
    assert built.pid_path.read_text(encoding="utf-8") == f"{spawned[0].pid}\n"


def test_a_reused_pid_is_never_killed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    kills = Kills()
    built = spec(tmp_path)
    built.pid_path.parent.mkdir(parents=True)
    built.pid_path.write_text("999\n", encoding="utf-8")

    found, _spawned, _jobs = supervisor(
        group_kill=kills, command_of=lambda pid: "/usr/bin/python3"
    )
    found.start(built, background=False)

    assert found.state == "running"
    assert kills.calls == []


def test_sigterm_ends_the_group_and_exits(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    kills = Kills()
    found, spawned, _jobs = supervisor(group_kill=kills, command_of=lambda pid: LLAMA_SERVER)
    built = spec(tmp_path)
    found.start(built, background=False)

    with pytest.raises(SystemExit) as exited:
        server._on_sigterm(signal.SIGTERM, None)

    assert exited.value.code == 128 + signal.SIGTERM
    assert kills.calls == [(spawned[0].pid, signal.SIGTERM)]
    assert not built.pid_path.exists()


def test_the_exit_hook_leaves_a_foreign_pid_alone(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    kills = Kills()
    built = spec(tmp_path)
    found, _spawned, _jobs = supervisor(group_kill=kills, command_of=lambda pid: "/usr/bin/python3")
    found.start(built, background=False)
    built.pid_path.write_text("999\n", encoding="utf-8")  # the pid now belongs to something else

    found.end_if_running()

    assert kills.calls == []
    assert not built.pid_path.exists()


def test_exit_hooks_are_installed_on_a_mac_and_not_on_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registered: list[Any] = []
    handled: list[Any] = []
    monkeypatch.setattr(server.atexit, "register", registered.append)
    monkeypatch.setattr(server.signal, "signal", lambda signum, handler: handled.append(signum))

    monkeypatch.setattr(sys, "platform", "win32")
    server.install_exit_hooks()
    assert registered == [] and handled == []

    monkeypatch.setattr(sys, "platform", "darwin")
    server.install_exit_hooks()
    assert registered == [server._end_live]
    assert handled == [signal.SIGTERM]


def test_the_imported_hooks_end_a_run_that_is_still_going(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    kills = Kills()
    found, spawned, _jobs = supervisor(group_kill=kills, command_of=lambda pid: LLAMA_SERVER)
    built = spec(tmp_path)
    found.start(built, background=False)

    server._end_live()

    assert kills.calls == [(spawned[0].pid, signal.SIGTERM)]
    assert not built.pid_path.exists()
