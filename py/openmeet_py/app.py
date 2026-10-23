"""Desktop entry point: serves the API on a free loopback port and opens the OpenMeet window.

    python -m openmeet_py.app                 open the window
    python -m openmeet_py.app --smoke         start, check /health and one command, print OK, exit
    python -m openmeet_py.app --data-dir DIR  use DIR instead of %APPDATA%\\OpenMeetPy (tests)
    python -m openmeet_py.app --check-audio-import  import the audio library, print its version, no device
"""

from __future__ import annotations

import argparse
import secrets
import socket
import sys
import threading
import time
from pathlib import Path
from typing import Any, Optional

import uvicorn

from .paths import default_data_dir, web_dir
from .server import TOKEN_HEADER, create_app

TITLE = "OpenMeet"
WINDOW_SIZE = (1100, 780)
MIN_SIZE = (720, 580)


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
        windows["window"].destroy()

    app = create_app(
        data_dir,
        web_dir(),
        token=token,
        pick_folder=pick_folder,
        close_window=close_window,
    )
    server = ServerThread(app, port)
    server.start()
    try:
        windows["window"] = webview.create_window(
            TITLE,
            f"http://127.0.0.1:{port}/",
            width=WINDOW_SIZE[0],
            height=WINDOW_SIZE[1],
            min_size=MIN_SIZE,
        )
        webview.start()
    finally:
        server.stop()
    return 0


def check_audio_import() -> int:
    # Import only. PyAudio() is never constructed here, so no PortAudio stream or device is opened.
    try:
        import pyaudiowpatch
    except ImportError as error:
        print(f"FAILED: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    print(f"OK: pyaudiowpatch {pyaudiowpatch.__version__} imported; no audio device was opened.")
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="openmeet-py", description="OpenMeet Python desktop build")
    parser.add_argument("--smoke", action="store_true", help="check the server and exit; no window")
    parser.add_argument(
        "--data-dir", type=Path, default=None, help="data folder (default: %%APPDATA%%\\OpenMeetPy)"
    )
    parser.add_argument(
        "--check-audio-import",
        action="store_true",
        help="import the audio library and print its version; opens no device",
    )
    args = parser.parse_args(argv)
    if args.check_audio_import:
        return check_audio_import()
    data_dir = args.data_dir or default_data_dir()
    if args.smoke:
        return smoke(data_dir)
    return run_window(data_dir)


if __name__ == "__main__":
    raise SystemExit(main())
