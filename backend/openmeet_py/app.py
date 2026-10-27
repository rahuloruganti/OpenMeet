"""Desktop entry point: serves the API on a free loopback port and opens the OpenMeet window.

    python -m openmeet_py.app                 open the window
    python -m openmeet_py.app --smoke         start, check /health and one command, print OK, exit
    python -m openmeet_py.app --data-dir DIR  use DIR instead of the default data folder (tests)
    python -m openmeet_py.app --check-audio-import  import the audio library, print its version, no device
    python -m openmeet_py.app --check-stt-import    import the speech library, print its version, no model
    python -m openmeet_py.app --import-from DIR     copy an old data folder into this app's folder; no window
"""

from __future__ import annotations

import argparse
import importlib
import secrets
import socket
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

import uvicorn

from openmeet_py.api.server import TOKEN_HEADER, create_app
from openmeet_py.paths import default_data_dir, web_dir
from openmeet_py.platform.detection import consent_from_env
from openmeet_py.platform.win32 import win32_from_env

TITLE = "OpenMeet"
WINDOW_SIZE = (1100, 780)
MIN_SIZE = (720, 580)
# How long the page may take to answer a close request before a second close goes through anyway.
CLOSE_ANSWER_TIMEOUT = 15.0


class CloseGuard:
    """Decides whether a window close goes through, so the page can save everything before it quits.

    pywebview cancels a close when the `closing` handler returns False. Returning False once,
    after emitting `request_close`, lets the page flush a pending note save and then call
    close_application (which sets `allow_close`). The close is never blocked when the page
    cannot answer: no WebSocket client is attached, the UI already asked to close, or it stayed
    silent for CLOSE_ANSWER_TIMEOUT seconds and the user closed again.

    Both backends ask the same question through `closing`: WebView2 raises it from the window
    close button, Cocoa raises it from `windowShouldClose_` and from `applicationShouldTerminate_`
    (Cmd+Q) in pywebview 6.2.1. Both cancel only when the return value `is False`, so the handler
    always returns a bool, never None. The Cocoa event runs handlers on the GUI thread, so the
    emit below must not block; it only schedules the message on the server loop.
    """

    def __init__(
        self,
        client_count: Callable[[], int],
        emit: Callable[[str, Any], None],
        clock: Callable[[], float] = time.monotonic,
        timeout: float = CLOSE_ANSWER_TIMEOUT,
    ) -> None:
        self._client_count = client_count
        self._emit = emit
        self._clock = clock
        self._timeout = timeout
        self.allow_close = False
        self._requested_at: Optional[float] = None

    def allow(self) -> None:
        """Lets the next close through: the UI answered, so its own destroy() is not cancelled."""
        self.allow_close = True

    def closing(self) -> bool:
        """The window `closing` handler: True closes now, False cancels and asks the page."""
        if self.allow_close or self._client_count() <= 0:
            return True
        now = self._clock()
        if self._requested_at is not None and now - self._requested_at >= self._timeout:
            # The page never answered the request: a hung page must not trap the user.
            return True
        self._requested_at = now
        self._emit("request_close", None)
        return False


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


class ServerThread:
    """uvicorn in a background thread, bound to 127.0.0.1 only."""

    def __init__(self, app: Any, port: int):
        config = uvicorn.Config(
            app, host="127.0.0.1", port=port, log_level="warning", lifespan="on"
        )
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.server.run, name="openmeet-server", daemon=True)

    def start(self) -> None:
        self.thread.start()
        deadline = time.monotonic() + 15
        while not self.server.started:
            if not self.thread.is_alive() or time.monotonic() > deadline:
                raise RuntimeError("The local OpenMeet server did not start.")
            time.sleep(0.05)

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=10)


def smoke(data_dir: Path) -> int:
    import httpx

    port = free_port()
    token = secrets.token_urlsafe(32)
    server = ServerThread(create_app(data_dir, web_dir(), token=token), port)
    server.start()
    try:
        # trust_env=False: a system proxy must never see loopback traffic.
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=15) as client:
            health = client.get("/health")
            health.raise_for_status()
            invoke = client.post(
                "/api/invoke/list_meetings", json={}, headers={TOKEN_HEADER: token}
            )
            invoke.raise_for_status()
            meetings = invoke.json()
        if not isinstance(meetings, list):
            raise RuntimeError("list_meetings did not return a list.")
        print(f"OK: /health {health.status_code}, list_meetings returned {len(meetings)} meetings.")
        return 0
    except Exception as error:  # report the failure type and message only
        print(f"FAILED: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    finally:
        server.stop()


def run_window(data_dir: Path) -> int:
    import webview  # imported here so --smoke never touches the GUI stack

    port = free_port()
    token = secrets.token_urlsafe(32)
    windows: dict[str, Any] = {}

    def pick_folder() -> Optional[str]:
        # Called from a worker thread while the request waits; pywebview runs the dialog on the GUI thread.
        picked = windows["window"].create_file_dialog(webview.FileDialog.FOLDER)
        return picked[0] if picked else None

    def close_window() -> None:
        # destroy() raises the same `closing` event on WebView2, so let our own close through first.
        # Cocoa's window.close() skips windowShouldClose_, so allow() is simply unused there.
        guard.allow()
        windows["window"].destroy()

    app = create_app(
        data_dir,
        web_dir(),
        token=token,
        pick_folder=pick_folder,
        close_window=close_window,
        # The real desktop only in the window: shortcuts, Dock or taskbar attention and the consent store.
        # OPENMEET_PY_FAKE_HOTKEYS=1 and OPENMEET_PY_FAKE_DETECTION=1 select the fakes (browser check).
        win32=win32_from_env(),
        consent=consent_from_env(data_dir),
    )
    hub = app.state.hub
    # The page answers a close with close_application; with no WebSocket client it cannot answer.
    guard = CloseGuard(hub.client_count, hub.emit)
    server = ServerThread(app, port)
    server.start()
    try:
        # No icon: on macOS the window icon comes from the app bundle, and pywebview only reads
        # start(icon=...) on GTK/QT. No custom menu either: pywebview 6.2.1 MenuAction has no key
        # equivalent, so it cannot give Settings Cmd+comma. Its default Cocoa app menu already
        # supplies Quit with Cmd+Q, and that terminate: path runs the same close guard (see CloseGuard).
        window = webview.create_window(
            TITLE,
            f"http://127.0.0.1:{port}/",
            width=WINDOW_SIZE[0],
            height=WINDOW_SIZE[1],
            min_size=MIN_SIZE,
        )
        windows["window"] = window
        window.events.closing += guard.closing
        webview.start()
    finally:
        server.stop()
    return 0


def check_audio_import() -> int:
    # Import only. No stream and no device is opened: the library object is never constructed.
    # Windows ships WASAPI through pyaudiowpatch; a Mac has no PortAudio patch wheel, so it uses sounddevice.
    module_name = "sounddevice" if sys.platform == "darwin" else "pyaudiowpatch"
    try:
        module = importlib.import_module(module_name)
        version = getattr(module, "__version__", None)
        if version is None:
            from importlib.metadata import version as package_version

            version = package_version(module_name)
    except Exception as error:  # report the failure type and message only
        print(f"FAILED: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    print(f"OK: {module_name} {version} imported; no audio device was opened.")
    return 0


def check_stt_import() -> int:
    # Import only. No Model is constructed, so no model file is opened and nothing can be downloaded.
    try:
        import pywhispercpp

        version = getattr(pywhispercpp, "__version__", None)
        if version is None:
            from importlib.metadata import version as package_version

            version = package_version("pywhispercpp")
    except Exception as error:  # report the failure type and message only
        print(f"FAILED: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    print(f"OK: pywhispercpp {version} imported; no speech model was loaded.")
    return 0


def check_sherpa_import() -> int:
    # Import only. No recognizer or VAD is constructed, so no model file is opened and nothing can be downloaded.
    try:
        import sherpa_onnx

        version = getattr(sherpa_onnx, "__version__", None)
        if version is None:
            from importlib.metadata import version as package_version

            version = package_version("sherpa-onnx")
    except Exception as error:  # report the failure type and message only
        print(f"FAILED: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    print(f"OK: sherpa-onnx {version} imported; no speech model was loaded.")
    return 0


def write_import_report(data_dir: Path, text: str) -> None:
    """Writes the counts-only report next to the data so a frozen windowed exe still has a record."""
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        (data_dir / "import-report.txt").write_text(text + "\n", encoding="utf-8")
    except OSError as error:
        print(f"WARNING: could not write import-report.txt: {error}", file=sys.stderr)


def run_import(source: Path, data_dir: Path) -> int:
    from openmeet_py.infra.importer import ImportProblem, import_old_data

    try:
        report = import_old_data(source, data_dir)
    except ImportProblem as error:
        message = f"Import failed: {error}"
        print(message, file=sys.stderr)
        write_import_report(data_dir, message)
        return 2
    except Exception as error:  # a CLI import must report, not traceback, in a windowed exe
        message = f"Import failed: {type(error).__name__}: {error}"
        print(message, file=sys.stderr)
        write_import_report(data_dir, message)
        return 2
    text = report.as_text()
    print(text)
    write_import_report(data_dir, text)
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="OpenMeet", description="OpenMeet desktop app")
    parser.add_argument("--smoke", action="store_true", help="check the server and exit; no window")
    parser.add_argument(
        "--data-dir", type=Path, default=None, help="data folder (default: this app's data folder)"
    )
    parser.add_argument(
        "--check-audio-import",
        action="store_true",
        help="import the audio library and print its version; opens no device",
    )
    parser.add_argument(
        "--check-stt-import",
        action="store_true",
        help="import the speech library and print its version; loads no model",
    )
    parser.add_argument(
        "--check-sherpa-import",
        action="store_true",
        help="import sherpa-onnx and print its version; loads no model",
    )
    parser.add_argument(
        "--import-from",
        type=Path,
        default=None,
        metavar="DIR",
        help="import an old data folder into this app's data folder, then exit",
    )
    args = parser.parse_args(argv)
    if args.check_audio_import:
        return check_audio_import()
    if args.check_stt_import:
        return check_stt_import()
    if args.check_sherpa_import:
        return check_sherpa_import()
    data_dir = args.data_dir or default_data_dir()
    if args.import_from is not None:
        return run_import(args.import_from, data_dir)
    if args.smoke:
        return smoke(data_dir)
    return run_window(data_dir)


if __name__ == "__main__":
    raise SystemExit(main())
