"""One managed llama-server on loopback: start, poll /health, prove readiness, restart once, stop.

The server runs only while the user wants it. `Supervisor` owns at most one process, keeps its state
(stopped, starting, running, failed), waits for `/health` and then one small generation before it
reports "running", and restarts the process once if it crashes. A second crash is reported as failed
with the fix, never retried forever.

The process is killed with OpenMeet, even if OpenMeet is killed: a Windows Job object with
KILL_ON_JOB_CLOSE is assigned to it. `stop()` also ends it directly, which frees GPU memory for the
"Turn off" button.

macOS has no job object, so the server is started in its own session and ended by its process
group: on stop, from an `atexit` hook, from a SIGTERM handler, and on the next start from a pid file
for the case where OpenMeet itself was killed outright.

Every external effect is injectable: `spawn` (tests use a fake process), `probe` and `touch` (tests
never call the network), `job_factory`, `group_kill`, `command_of`, `sleep` and `clock` (tests never
wait in real time).
"""

from __future__ import annotations

import atexit
import ctypes
import json
import os
import signal
import subprocess
import sys
import threading
import time
import weakref
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

import httpx

from openmeet_py.api.errors import AppError

HOST = "127.0.0.1"
HEALTH_TIMEOUT = 2.0
TOUCH_TIMEOUT = 60.0
READY_TIMEOUT = 180.0
POLL_SECONDS = 1.0
WATCH_SECONDS = 1.0
TERMINATE_SECONDS = 5.0
MAX_RESTARTS = 1
TOUCH_TOKENS = 64
TOUCH_PROMPT = "ping"
PID_FILE = "server.pid"
# SIGKILL is POSIX only, so it is looked up by name; the fallback is never used, because a stale
# pid is only ever reaped on macOS.
SIGKILL = getattr(signal, "SIGKILL", signal.SIGTERM)
CRASH_MESSAGE = (
    "Local AI stopped twice. Check local-ai/server.log, then turn it off and on again."
)
TIMEOUT_MESSAGE = (
    "Local AI did not start in time. Check local-ai/server.log, then turn it off and on again."
)
SILENT_MESSAGE = "Local AI started but did not answer. Turn it off and on again."
SPAWN_MESSAGE = "Local AI could not start. Check local-ai/server.log, then turn it off and on again."
STOPPED_MESSAGE = "Local AI was turned off before it finished starting."


def error(message: str) -> AppError:
    return AppError("local_ai_server", message)


@dataclass(frozen=True)
class Spec:
    """Everything one llama-server run needs. Two runs are the same run when these are equal."""

    executable: Path
    model_path: Path
    model: str
    port: int
    api_key: str = field(repr=False)
    layers: int
    context: int
    log_path: Path

    @property
    def base_url(self) -> str:
        return base_url(self.port)

    @property
    def alias(self) -> str:
        return self.model

    @property
    def pid_path(self) -> Path:
        """Beside the log, in the Local AI data folder: what a later start reads after a hard kill."""
        return self.log_path.parent / PID_FILE


def base_url(port: int) -> str:
    return f"http://{HOST}:{port}/v1"


def arguments(spec: Spec) -> list[str]:
    """The exact command line. Only llama-server's documented flags; no verbose logging. The API key
    is not here: a command line is readable by other processes, so it goes in `environment()`."""
    return [
        str(spec.executable),
        "-m",
        str(spec.model_path),
        "--alias",
        spec.model,
        "--host",
        HOST,
        "--port",
        str(spec.port),
        "--ctx-size",
        str(spec.context),
        "--jinja",
        "--no-webui",
        "-ngl",
        str(spec.layers),
    ]


# ---- Windows Job object ---------------------------------------------------------------

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
PROCESS_SET_QUOTA = 0x0100
PROCESS_TERMINATE = 0x0001


def _job_handle() -> Optional[int]:
    """A Job object that kills its members when the last handle closes, or None when unavailable."""
    if sys.platform != "win32":
        return None

    class IoCounters(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_ulonglong),
            ("WriteOperationCount", ctypes.c_ulonglong),
            ("OtherOperationCount", ctypes.c_ulonglong),
            ("ReadTransferCount", ctypes.c_ulonglong),
            ("WriteTransferCount", ctypes.c_ulonglong),
            ("OtherTransferCount", ctypes.c_ulonglong),
        ]

    class BasicLimits(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", ctypes.c_uint32),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", ctypes.c_uint32),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", ctypes.c_uint32),
            ("SchedulingClass", ctypes.c_uint32),
        ]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BasicLimits),
            ("IoInfo", IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    kernel32 = ctypes.windll.kernel32
    handle = kernel32.CreateJobObjectW(None, None)
    if not handle:
        return None
    limits = ExtendedLimits()
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    ok = kernel32.SetInformationJobObject(
        handle,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        ctypes.byref(limits),
        ctypes.sizeof(limits),
    )
    if not ok:
        kernel32.CloseHandle(handle)
        return None
    return int(handle)


class JobGuard:
    """Kills the assigned process when OpenMeet exits, even on a crash."""

    def __init__(self) -> None:
        self.handle: Optional[int] = _job_handle()

    def assign(self, process: Any) -> None:
        if not self.handle:
            return
        handle = getattr(process, "_handle", None)
        if handle is None:
            return
        kernel32 = ctypes.windll.kernel32
        opened = kernel32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, process.pid)
        if not opened:
            return
        try:
            kernel32.AssignProcessToJobObject(self.handle, opened)
        finally:
            kernel32.CloseHandle(opened)

    def close(self) -> None:
        handle, self.handle = self.handle, None
        if handle:
            ctypes.windll.kernel32.CloseHandle(handle)


# ---- macOS process group ---------------------------------------------------------------


def _process_command(pid: int) -> str:
    """The command a pid runs, from `ps`. Empty when there is no such process."""
    try:
        done = subprocess.run(
            ("ps", "-p", str(pid), "-o", "comm="),
            capture_output=True,
            text=True,
            timeout=HEALTH_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return done.stdout.strip() if done.returncode == 0 else ""


def _kill_group(pid: int, sig: int) -> bool:
    """Signals the process group `pid` leads. False when the group is gone or has no such call."""
    killpg = getattr(os, "killpg", None)  # POSIX only, so it is looked up, not called blindly
    getpgid = getattr(os, "getpgid", None)
    if killpg is None or getpgid is None:
        return False
    try:
        killpg(getpgid(pid), sig)
    except OSError:
        return False
    return True


def is_server(pid: int, program: str, command_of: Callable[[int], str]) -> bool:
    """True only when `pid` really is our llama-server. A reused pid must never be killed."""
    command = command_of(pid).strip()
    return bool(command) and Path(command).name == program


def write_pid(spec: Spec, pid: int) -> None:
    """Records the running server's pid so a later start can end it after a hard kill of OpenMeet."""
    try:
        spec.pid_path.parent.mkdir(parents=True, exist_ok=True)
        spec.pid_path.write_text(f"{int(pid)}\n", encoding="utf-8")
    except OSError:
        # The pid file only helps a future start, so failing to write it must not stop this one.
        return


def read_pid(spec: Spec) -> Optional[int]:
    """The pid a previous run recorded, or None when there is no readable pid file."""
    try:
        return int(spec.pid_path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None


def clear_pid(spec: Spec) -> None:
    """Removes the pid file, so a pid that is gone is never looked at again."""
    try:
        spec.pid_path.unlink(missing_ok=True)
    except OSError:
        return


# ---- process and HTTP ------------------------------------------------------------------


def environment(spec: Spec) -> dict[str, str]:
    """This process's environment plus the key, read by llama-server from LLAMA_API_KEY (the env
    form of --api-key in common/arg.cpp at the pinned build)."""
    return {**os.environ, "LLAMA_API_KEY": spec.api_key}


def _launch_flags(handle: Any) -> dict[str, Any]:
    """Process flags for one platform: no console window on Windows, and its own session on macOS
    so the whole group, including anything the server started, can be signalled on stop."""
    flags: dict[str, Any] = {
        "stdin": subprocess.DEVNULL,
        "stdout": handle,
        "stderr": subprocess.STDOUT,
    }
    if sys.platform == "darwin":
        flags["start_new_session"] = True
    else:
        flags["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return flags


def spawn(spec: Spec) -> subprocess.Popen:
    """Starts llama-server with its output appended to server.log. No window, no console."""
    spec.log_path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(spec.log_path, "ab", buffering=0)
    try:
        return subprocess.Popen(
            arguments(spec),
            cwd=str(spec.executable.parent),
            env=environment(spec),
            **_launch_flags(handle),
        )
    finally:
        handle.close()


def _client(transport: Any, timeout: float) -> httpx.Client:
    return httpx.Client(timeout=timeout, follow_redirects=False, trust_env=False, transport=transport)


def _headers(spec: Spec) -> dict[str, str]:
    return {"Authorization": f"Bearer {spec.api_key}"}


def http_health(spec: Spec, transport: Any = None) -> bool:
    """True when /health answers 200 with status ok. Any failure, including 503 loading, is False."""
    try:
        with _client(transport, HEALTH_TIMEOUT) as client:
            response = client.get(f"http://{HOST}:{spec.port}/health", headers=_headers(spec))
            if response.status_code != 200:
                return False
            body = response.json()
    except (httpx.HTTPError, ValueError):
        return False
    return isinstance(body, dict) and body.get("status") in (None, "ok")


def http_touch(spec: Spec, transport: Any = None) -> bool:
    """One tiny generation through /v1. Proves the model actually answers, not just that a port is open."""
    payload = {
        "model": spec.model,
        "messages": [{"role": "user", "content": TOUCH_PROMPT}],
        "max_tokens": TOUCH_TOKENS,
    }
    try:
        with _client(transport, TOUCH_TIMEOUT) as client:
            response = client.post(
                f"{spec.base_url}/chat/completions",
                headers={**_headers(spec), "Content-Type": "application/json"},
                content=json.dumps(payload).encode("utf-8"),
            )
            return response.status_code == 200
    except httpx.HTTPError:
        return False


# ---- supervisor ------------------------------------------------------------------------


class Supervisor:
    """At most one llama-server, with a readiness wait, one restart and a clean stop."""

    def __init__(
        self,
        *,
        spawn: Optional[Callable[[Spec], Any]] = None,
        probe: Optional[Callable[[Spec], bool]] = None,
        touch: Optional[Callable[[Spec], bool]] = None,
        job_factory: Optional[Callable[[], Any]] = None,
        group_kill: Optional[Callable[[int, int], bool]] = None,
        command_of: Optional[Callable[[int], str]] = None,
        transport: Any = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        timeout: float = READY_TIMEOUT,
    ) -> None:
        self._spawn = spawn or globals()["spawn"]
        self._probe = probe or (lambda spec: http_health(spec, transport))
        self._touch = touch or (lambda spec: http_touch(spec, transport))
        self._job_factory = job_factory or JobGuard
        self._group_kill = group_kill or _kill_group
        self._command_of = command_of or _process_command
        self._sleep = sleep
        self._clock = clock
        self._timeout = timeout
        self._lock = threading.RLock()
        self._changed = threading.Condition(self._lock)
        self._state = "stopped"
        self._error: Optional[str] = None
        self._spec: Optional[Spec] = None
        self._process: Any = None
        self._job: Any = None
        self._thread: Optional[threading.Thread] = None
        self._generation = 0
        self._restarts = 0

    # -- reads --
    @property
    def state(self) -> str:
        with self._lock:
            return self._state

    @property
    def error_message(self) -> Optional[str]:
        with self._lock:
            return self._error

    @property
    def spec(self) -> Optional[Spec]:
        with self._lock:
            return self._spec

    # -- commands --
    def start(self, spec: Spec, background: bool = True) -> None:
        """Starts the server. `background` returns at once; False waits until it answers."""
        with self._lock:
            if self._spec == spec and self._state == "running" and self._alive_locked():
                return
            if self._spec == spec and self._state == "starting":
                # Another caller is already bringing this exact run up: share its outcome.
                if not background:
                    generation = self._generation
                    self._changed.wait_for(
                        lambda: self._generation != generation or self._state != "starting",
                        timeout=self._timeout + TERMINATE_SECONDS,
                    )
                return
            generation, detached, thread = self._begin_locked(spec, background)
        self._release(*detached)
        if thread is not None:
            thread.start()
        else:
            self._run(generation, watch=False)

    def ensure(self, spec: Spec) -> None:
        """Starts the server if it is not already answering, waits for it, then supervises it."""
        with self._lock:
            if self._state == "running" and self._spec == spec and self._alive_locked():
                self._supervise_locked()
                return
        self.start(spec, background=False)
        with self._lock:
            if self._state != "running" or self._spec != spec:
                raise error(self._error or STOPPED_MESSAGE)
            self._supervise_locked()

    def stop(self) -> None:
        """Turns the server off and frees the memory it held. Never waits for a start in progress."""
        with self._lock:
            detached = self._retire_locked()
            self._spec = None
            self._error = None
            self._set_state_locked("stopped")
        self._release(*detached)

    # -- macOS exit and stale pid --
    def _reap_stale(self, spec: Spec) -> None:
        """Ends a server left behind by a killed OpenMeet, and only when it really is llama-server.

        A hard kill runs no hook, so the pid file is the only record of a server that outlived
        the app. The pid may belong to something else by now, so the command is checked first.
        """
        if sys.platform != "darwin":
            return
        pid = read_pid(spec)
        if pid is None:
            return
        if is_server(pid, spec.executable.name, self._command_of):
            self._group_kill(pid, SIGKILL)  # it never reported readiness, so no grace period
        clear_pid(spec)

    def end_if_running(self) -> None:
        """Ends a server still running when OpenMeet exits, without waiting for it to answer."""
        spec = self._spec
        if spec is None:
            return
        pid = read_pid(spec)
        if pid is None:
            return
        if is_server(pid, spec.executable.name, self._command_of):
            self._group_kill(pid, signal.SIGTERM)
        clear_pid(spec)

    # -- internals --
    def _alive_locked(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def _set_state_locked(self, state: str) -> None:
        self._state = state
        self._changed.notify_all()

    def _detach_locked(self) -> tuple[Any, Any]:
        process, job = self._process, self._job
        self._process = None
        self._job = None
        if process is not None and sys.platform == "darwin":
            self._forget_pid_locked(process)
        return process, job

    def _forget_pid_locked(self, process: Any) -> None:
        """Drops the pid file of a server that is ending, so the next start does not chase it."""
        spec = self._spec
        if spec is not None and read_pid(spec) == getattr(process, "pid", None):
            clear_pid(spec)

    def _retire_locked(self) -> tuple[Any, Any]:
        """Ends the current generation. Its process and job are returned for release outside the lock."""
        self._generation += 1
        self._thread = None
        self._changed.notify_all()
        return self._detach_locked()

    def _begin_locked(
        self, spec: Spec, background: bool
    ) -> tuple[int, tuple[Any, Any], Optional[threading.Thread]]:
        detached = self._retire_locked()
        self._spec = spec
        self._error = None
        self._restarts = 0
        self._set_state_locked("starting")
        generation = self._generation
        thread = None
        if background:
            thread = threading.Thread(
                target=self._run, args=(generation,), name="openmeet-local-ai", daemon=True
            )
            self._thread = thread
        return generation, detached, thread

    def _supervise_locked(self) -> None:
        """Starts a watcher for the current run unless a live one already exists."""
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(
            target=self._watch, args=(self._generation,), name="openmeet-local-ai", daemon=True
        )
        self._thread.start()

    def _current(self, generation: int) -> bool:
        with self._lock:
            return self._generation == generation

    def _stop_group(self, process: Any, force: bool = False) -> bool:
        """macOS: signals the whole group the child leads. False when there is no group of ours."""
        if sys.platform != "darwin":
            return False
        pid = getattr(process, "pid", None)
        if not pid:
            return False
        return bool(self._group_kill(int(pid), SIGKILL if force else signal.SIGTERM))

    def _release(self, process: Any, job: Any) -> None:
        """Ends one process and closes its job. Runs outside the lock: a stubborn process may take seconds."""
        if process is not None:
            try:
                if process.poll() is None:
                    if not self._stop_group(process):
                        process.terminate()
                    try:
                        process.wait(timeout=TERMINATE_SECONDS)
                    except subprocess.TimeoutExpired:
                        # Nothing that ignored the polite signal survives the group being killed.
                        if not self._stop_group(process, force=True):
                            process.kill()
                        process.wait(timeout=TERMINATE_SECONDS)
            except (OSError, subprocess.SubprocessError):
                pass
        if job is not None:
            job.close()

    def _finish(self, generation: int, message: str) -> None:
        """Marks the run failed and frees its process, unless the run was already retired."""
        with self._lock:
            if self._generation != generation:
                return
            self._error = message
            self._set_state_locked("failed")
            detached = self._detach_locked()
        self._release(*detached)

    def _publish_running(self, generation: int) -> bool:
        with self._lock:
            if self._generation != generation:
                return False
            self._set_state_locked("running")
            return True

    def _run(self, generation: int, watch: bool = True) -> None:
        try:
            self._settle(generation)
        except Exception:  # an unexpected failure must not leave the state stuck on "starting"
            self._finish(generation, SPAWN_MESSAGE)
            return
        if watch and self._is_running(generation):
            self._watch(generation)

    def _is_running(self, generation: int) -> bool:
        with self._lock:
            return self._generation == generation and self._state == "running"

    def _settle(self, generation: int) -> None:
        """Spawns the process and waits until it answers. Leaves the state running or failed."""
        try:
            self._wait_ready(generation, self._launch(generation))
        except AppError as cause:
            self._finish(generation, cause.message)
            return
        self._publish_running(generation)

    def _launch(self, generation: int) -> Any:
        with self._lock:
            spec = self._spec if self._generation == generation else None
        if spec is None:
            raise error(STOPPED_MESSAGE)
        self._reap_stale(spec)
        try:
            process = self._spawn(spec)
        except OSError as cause:
            raise error(SPAWN_MESSAGE) from cause
        job = self._job_factory()
        try:
            job.assign(process)
        except Exception:  # a job that cannot be assigned must not keep the server from running
            job.close()
            job = None
        with self._lock:
            if self._generation == generation:
                self._process = process
                self._job = job
                if sys.platform == "darwin":
                    write_pid(spec, process.pid)
                    _LIVE.add(self)
                return process
        # Stopped while the process was starting: nothing else knows about it, so end it here.
        self._release(process, job)
        raise error(STOPPED_MESSAGE)

    def _wait_ready(self, generation: int, process: Any) -> None:
        with self._lock:
            spec = self._spec if self._generation == generation else None
            restarted = self._restarts > 0
        if spec is None:
            raise error(STOPPED_MESSAGE)
        deadline = self._clock() + self._timeout
        while True:
            if not self._current(generation):
                raise error(STOPPED_MESSAGE)
            if process.poll() is not None:
                raise error(CRASH_MESSAGE if restarted else SPAWN_MESSAGE)
            if self._probe(spec):
                break
            if self._clock() >= deadline:
                raise error(TIMEOUT_MESSAGE)
            self._sleep(POLL_SECONDS)
        answered = self._touch(spec)
        if not self._current(generation):
            raise error(STOPPED_MESSAGE)
        if not answered:
            raise error(SILENT_MESSAGE)

    def _watch(self, generation: int) -> None:
        try:
            while self._tick(generation):
                self._sleep(WATCH_SECONDS)
        except Exception:  # never leave a dead watcher behind a server that still says it is running
            self._finish(generation, CRASH_MESSAGE)

    def _tick(self, generation: Optional[int] = None) -> bool:
        """One supervision step for `generation` (default: the current run). False when that run
        must not be watched any more: stopped, replaced, failed, or restarted and no longer running."""
        with self._lock:
            if generation is None:
                generation = self._generation
            if self._generation != generation or self._process is None:
                return False
            if self._process.poll() is None:
                return True
            restart = self._restarts < MAX_RESTARTS
            if restart:
                self._restarts += 1
                self._set_state_locked("starting")
            else:
                self._error = CRASH_MESSAGE
                self._set_state_locked("failed")
            detached = self._detach_locked()  # the dead run's job closes before any replacement starts
        self._release(*detached)
        if not restart:
            return False
        try:
            self._wait_ready(generation, self._launch(generation))
        except AppError as cause:
            self._finish(generation, cause.message)
            return False
        return self._publish_running(generation)


# ---- macOS exit --------------------------------------------------------------------------

# Supervisors with a server running. macOS has no job object, so these hooks are what ends a
# server when OpenMeet goes away; a weak set keeps a stopped one from being held alive by them.
_LIVE: "weakref.WeakSet[Supervisor]" = weakref.WeakSet()


def _end_live() -> None:
    """Ends every server this process started, whichever supervisor owns it."""
    for supervisor in list(_LIVE):
        supervisor.end_if_running()


def _on_sigterm(signum: int, _frame: Any) -> None:
    _end_live()
    raise SystemExit(128 + int(signum))


def install_exit_hooks() -> None:
    """Ends the servers on exit and on SIGTERM. Registered at import, on the main thread, because
    a supervisor that starts later runs on a request thread, where a signal cannot be taken."""
    if sys.platform != "darwin":
        return
    atexit.register(_end_live)
    try:
        signal.signal(signal.SIGTERM, _on_sigterm)
    except (OSError, ValueError):
        # Only the main thread may take a signal; the atexit hook still covers a normal exit.
        return


install_exit_hooks()
