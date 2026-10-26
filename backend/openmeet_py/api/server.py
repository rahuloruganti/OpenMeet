"""FastAPI server: command dispatch, events over one WebSocket, file serving and the bundled UI.

Every API route needs the per-launch token. The server injects it into the served index.html, so
only the OpenMeet page can read it. A page from another origin cannot.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import sqlite3
import threading
import traceback
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Optional

from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocketDisconnect

from openmeet_py.api import live_commands
from openmeet_py.api.commands import Context, dispatch
from openmeet_py.api.errors import AppError
from openmeet_py.api.lifecycle import LifecycleController
from openmeet_py.api.reads import read_settings
from openmeet_py.audio.audio_backend import CaptureBackend, make_backend
from openmeet_py.audio.recorder import Recorder
from openmeet_py.domain.processing import Processing
from openmeet_py.infra.store import DB_FILE, Store
from openmeet_py.local_ai import service as local_ai
from openmeet_py.platform.detection import DetectionService, EmptyConsentRegistry
from openmeet_py.platform.hotkeys import HotkeyService, press_action
from openmeet_py.platform.win32 import FakeWin32

log = logging.getLogger("openmeet_py")
TOKEN_HEADER = "x-openmeet-token"
LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost"})
TITLE = "OpenMeet"  # the window title, also the taskbar-flash lookup


def _start_hotkey_action(ctx: Context, kind: str) -> None:
    """A press runs on its own thread, so a slow stop never holds the hotkey message loop."""
    threading.Thread(target=press_action, args=(ctx, kind), name="openmeet-hotkey-action", daemon=True).start()


class Hub:
    """Fans events out to connected WebSocket clients. Safe to call from worker threads."""

    def __init__(self) -> None:
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.clients: set[WebSocket] = set()

    def emit(self, event: str, payload: Any) -> None:
        if self.loop is None or not self.clients:
            return
        message = json.dumps({"event": event, "payload": payload})
        try:
            asyncio.run_coroutine_threadsafe(self._send(message), self.loop)
        except RuntimeError:
            pass  # loop already closed: the server is shutting down

    def client_count(self) -> int:
        """Connected WebSocket clients. Zero means the page cannot answer a close request."""
        return len(self.clients)

    async def _send(self, message: str) -> None:
        for client in list(self.clients):
            try:
                await client.send_text(message)
            except Exception:
                self.clients.discard(client)


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"code": code, "message": message}, status_code=status)


def create_app(
    data_dir: Path,
    web_dir: Optional[Path] = None,
    token: Optional[str] = None,
    pick_folder: Optional[Callable[[], Optional[str]]] = None,
    close_window: Optional[Callable[[], None]] = None,
    backend: Optional[CaptureBackend] = None,
    win32: Optional[Any] = None,
    consent: Optional[Any] = None,
    workers: bool = True,
) -> FastAPI:
    """Builds the app. `win32` and `consent` default to fakes, so nothing here touches the desktop or the registry.

    The window and create_app_from_env pass the real ones (win32.win32_from_env, detection.consent_from_env).
    `workers=False` keeps the processing workflow out of background threads (tests step it themselves).
    """
    token = token or secrets.token_urlsafe(32)
    hub = Hub()
    store = Store(Path(data_dir))
    backend = backend or make_backend()
    recorder = Recorder(store, backend, hub.emit, store.data_dir / "audio")
    desktop: Any = win32 if win32 is not None else FakeWin32()
    ctx = Context(
        store=store,
        emit=hub.emit,
        pick_folder=pick_folder,
        close_window=close_window,
        recorder=recorder,
    )
    ctx.processing = Processing(ctx, workers=workers)
    recorder.processing = ctx.processing
    ctx.live = live_commands.LiveService(ctx)
    recorder.live = ctx.live
    ctx.hotkeys = HotkeyService(desktop, lambda kind: _start_hotkey_action(ctx, kind))
    ctx.detection = DetectionService(ctx, consent if consent is not None else EmptyConsentRegistry())
    ctx.attention = lambda: desktop.flash_window(TITLE)
    # Subscribes to detection and listens to the recorder. Its thread starts in the lifespan below.
    ctx.lifecycle = LifecycleController(ctx)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        hub.loop = asyncio.get_running_loop()
        with store.lock:
            settings = read_settings(store.db)
        warning = ctx.hotkeys.start(settings["pause_shortcut"], settings["stop_shortcut"])
        if warning:
            hub.emit("backend_error", warning)  # no client yet; get_startup_warning returns it too
        ctx.detection.start()
        ctx.lifecycle.start()
        yield
        # Shutdown order: refuse processing work, stop the call lifecycle (it never stops a recording
        # itself), finalize the recording (its stop marks the stage), then stop the poll and hotkey
        # threads and wait for workers before the database closes.
        # The managed Local AI server is stopped before the database closes, so it never outlives the app.
        ctx.processing.quit()
        ctx.lifecycle.stop()
        recorder.shutdown()
        ctx.detection.stop()
        ctx.hotkeys.stop()
        ctx.processing.join()
        ctx.live.quit()  # final live lines are written before the database closes
        local_ai.shutdown()
        store.close()

    app = FastAPI(title="OpenMeet (Python build)", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.token = token
    app.state.ctx = ctx
    app.state.backend = backend
    app.state.hub = hub

    def authorized(value: Optional[str]) -> bool:
        return value is not None and secrets.compare_digest(value, token)

    def local_host(headers: Any) -> bool:
        # DNS rebinding: a page on another name that resolves to 127.0.0.1 is still a foreign origin.
        host = headers.get("host", "")
        return host.rsplit(":", 1)[0] in LOCAL_HOSTS

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "app": "openmeet", "phase": 5, "audio": backend.name}

    @app.post("/api/invoke/{cmd}")
    async def invoke(cmd: str, request: Request) -> JSONResponse:
        if not local_host(request.headers):
            return _error(400, "bad_host", "Requests must come to 127.0.0.1.")
        if not authorized(request.headers.get(TOKEN_HEADER)):
            return _error(401, "unauthorized", "The OpenMeet page must be opened from the app.")
        raw = await request.body()
        try:
            args = json.loads(raw) if raw.strip() else {}
        except ValueError:
            return _error(400, "invalid_args", "The request body is not valid JSON.")
        if not isinstance(args, dict):
            return _error(400, "invalid_args", "Command arguments must be a JSON object.")
        try:
            result = await run_in_threadpool(dispatch, ctx, cmd, args)
        except AppError as error:
            return _error(error.status, error.code, error.message)
        except sqlite3.Error:
            log.error("database error in %s", cmd)
            return _error(500, "database", "The local database operation failed.")
        except Exception:
            # Log the exception type and frame only; messages can echo user content.
            log.error("unexpected failure in %s: %s", cmd, traceback.format_exc(limit=1))
            return _error(500, "internal", "The operation failed. Check the app log.")
        return JSONResponse(result)

    @app.websocket("/ws")
    async def events(websocket: WebSocket, token: str = "") -> None:
        if not local_host(websocket.headers) or not authorized(token):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        hub.clients.add(websocket)
        try:
            while True:
                await websocket.receive_text()  # the client sends nothing; this detects disconnects
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            hub.clients.discard(websocket)

    @app.get("/files")
    async def files(request: Request, path: str = "", token: str = "") -> Any:
        # Only the audio folder and the export folder. The database lives in the data folder too,
        # so the data folder itself is never served.
        if not local_host(request.headers) or not authorized(token):
            return _error(401, "unauthorized", "The OpenMeet page must be opened from the app.")
        roots = [store.data_dir / "audio"]
        with store.lock:
            vault = store.db.execute("SELECT vault_folder FROM settings WHERE id = 1").fetchone()[0]
        if vault:
            roots.append(Path(vault))
        try:
            target = Path(path).resolve(strict=True)
        except (OSError, RuntimeError):
            return _error(404, "not_found", "File not found.")
        allowed = False
        for root in roots:
            try:
                if target.is_relative_to(root.resolve()) and target.is_file():
                    allowed = True
                    break
            except OSError:
                continue
        if not allowed or target.name == DB_FILE or target.suffix == ".db":
            return _error(403, "forbidden", "That file is not available to the page.")
        return FileResponse(target)

    index_path = web_dir / "index.html" if web_dir else None

    @app.get("/", response_class=HTMLResponse)
    async def index(request: Request) -> Any:
        if not local_host(request.headers):
            return HTMLResponse("Requests must come to 127.0.0.1.", status_code=400)
        if index_path is None or not index_path.is_file():
            return HTMLResponse("<p>The OpenMeet page is not built.</p>", status_code=404)
        html = index_path.read_text(encoding="utf-8")
        script = f"<script>window.__OPENMEET_TOKEN__={json.dumps(token)};</script>"
        return HTMLResponse(html.replace("</head>", script + "</head>", 1))

    if web_dir is not None and web_dir.is_dir():
        # Mounted last so the API routes above win. html=False: "/" is served by index() above.
        app.mount("/", StaticFiles(directory=str(web_dir)), name="web")

    return app


def create_app_from_env() -> FastAPI:
    """Factory for `uvicorn openmeet_py.api.server:create_app_from_env --factory` (manual runs)."""
    from openmeet_py.platform.detection import consent_from_env
    from openmeet_py.paths import default_data_dir, web_dir as bundled_web
    from openmeet_py.platform.win32 import win32_from_env

    data_dir = Path(os.environ.get("OPENMEET_DATA_DIR") or default_data_dir())
    token = os.environ.get("OPENMEET_TOKEN") or None
    return create_app(
        data_dir,
        bundled_web(),
        token=token,
        win32=win32_from_env(),
        consent=consent_from_env(data_dir),
    )
