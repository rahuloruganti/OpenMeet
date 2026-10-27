"""Local AI: state, one job at a time, downloads, the managed connection and the UI commands.

The state row (`local_ai`, migration 031) keeps the engine backend, the port, the chosen model and
the id of the one saved connection named "Local AI". The API key lives only in the OS credential
store, under that connection's account, and is never returned to the page.

Commands return the `LocalAiStatus` shape the page reads, except `local_ai_use`, which returns the
saved Settings like every other settings command. Downloads run only on an explicit call from the
Hugging Face search, emit `local_ai_progress`, and honour `local_ai_cancel`.

`ensure_ready` is the one hook the LLM path uses: when the assigned connection is this managed
server, a summary or a rewrite first makes sure the server is running with the chosen model.
"""

from __future__ import annotations

import hashlib
import secrets
import socket
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Optional

from openmeet_py import model_hub
from openmeet_py.api import reads
from openmeet_py.api.context import Context, text_arg
from openmeet_py.api.errors import AppError
from openmeet_py.domain import connections, providers
from openmeet_py.local_ai import catalog as catalog_module
from openmeet_py.local_ai import engine, hardware, hub, server
from openmeet_py.platform import keys
from openmeet_py.speech import model_library

DIR_NAME = "local-ai"
MODELS_DIR = "models"
LOG_FILE = "server.log"
CONNECTION_NAME = "Local AI"
FILE_PREFIX = "file:"
PREFERRED_PORT = 39281
MIN_PORT = 1024
MAX_PORT = 65535
KEY_BYTES = 32
PROGRESS_EVENT = "local_ai_progress"


class Job:
    """The one download or setup running now, and the cancel flag it honours.

    A second operation is refused rather than queued, so two downloads can never fight over the
    same file or the same progress bar.
    """

    def __init__(self) -> None:
        self._running = threading.Lock()
        self._state_lock = threading.Lock()
        self._current: Optional[dict[str, Any]] = None
        self._cancel = threading.Event()

    def snapshot(self) -> Optional[dict[str, Any]]:
        with self._state_lock:
            return dict(self._current) if self._current is not None else None

    def cancel(self) -> None:
        with self._state_lock:
            if self._current is not None:
                self._cancel.set()

    def _put(self, value: Optional[dict[str, Any]]) -> None:
        with self._state_lock:
            self._current = value

    def progress(
        self, emit: Any, phase: str, downloaded: int, total: int
    ) -> None:
        """Records and reports progress for the running job; ignored when nothing is running."""
        with self._state_lock:
            if self._current is None:
                return
            self._current = {
                **self._current,
                "phase": phase,
                "downloaded": max(0, int(downloaded)),
                "total": max(0, int(total)),
            }
            snapshot = dict(self._current)
        emit(PROGRESS_EVENT, snapshot)

    @contextmanager
    def operation(self, kind: str, target: str) -> Iterator[threading.Event]:
        if not self._running.acquire(blocking=False):
            raise AppError(
                "local_ai_busy",
                "Another Local AI download is running. Wait for it or cancel it first.",
            )
        try:
            self._cancel.clear()
            self._put(
                {"kind": kind, "target": target, "phase": "download", "downloaded": 0, "total": 0}
            )
            yield self._cancel
        finally:
            self._put(None)
            self._running.release()


_JOB = Job()
_SERVERS: dict[str, server.Supervisor] = {}
_SERVERS_LOCK = threading.Lock()


@dataclass(frozen=True)
class Row:
    backend: Optional[str]
    port: Optional[int]
    active_model: Optional[str]
    connection_id: Optional[str]


def state_error() -> AppError:
    return AppError(
        "local_ai_state",
        "The Local AI settings row is missing. Reinstall OpenMeet; saved data was not deleted.",
    )


# ---- paths and state -----------------------------------------------------------------


def root(ctx: Context) -> Path:
    return ctx.store.data_dir / DIR_NAME


def models_dir(ctx: Context) -> Path:
    return root(ctx) / MODELS_DIR


def log_path(ctx: Context) -> Path:
    return root(ctx) / LOG_FILE


def _row(db: Any) -> Row:
    found = db.execute(
        "SELECT backend, port, active_model, connection_id FROM local_ai WHERE id = 1"
    ).fetchone()
    if found is None:
        raise state_error()
    return Row(backend=found[0], port=found[1], active_model=found[2], connection_id=found[3])


def _save_row(db: Any, row: Row) -> None:
    db.execute(
        "UPDATE local_ai SET backend = ?1, port = ?2, active_model = ?3, connection_id = ?4 "
        "WHERE id = 1",
        (row.backend, row.port, row.active_model, row.connection_id),
    )


def _in_use(db: Any, row: Row) -> bool:
    if row.connection_id is None:
        return False
    assigned = db.execute(
        "SELECT connection_id FROM provider_assignments WHERE role = 'llm'"
    ).fetchone()
    return assigned is not None and assigned[0] == row.connection_id


def _new_supervisor(ctx: Context) -> server.Supervisor:
    return server.Supervisor(transport=ctx.transport)


def _supervisor(ctx: Context, create: bool = False) -> Optional[server.Supervisor]:
    key = str(ctx.store.data_dir)
    with _SERVERS_LOCK:
        found = _SERVERS.get(key)
        if found is None and create:
            found = _new_supervisor(ctx)
            _SERVERS[key] = found
        return found


def shutdown() -> None:
    """Stops a running server on app exit and cancels a download in flight."""
    _JOB.cancel()
    with _SERVERS_LOCK:
        servers = list(_SERVERS.values())
        _SERVERS.clear()
    for supervisor in servers:
        supervisor.stop()


# ---- hardware, catalog and models ----------------------------------------------------


def _present(directory: Path, pin: catalog_module.Model) -> bool:
    path = directory / pin.file
    try:
        return path.is_file() and path.stat().st_size == pin.size_bytes
    except OSError:
        return False


def _local_files(ctx: Context) -> list[dict[str, Any]]:
    """GGUF files the existing local model scan finds on this PC. They are used where they are."""
    from openmeet_py.speech.stt import stt_root

    report = model_library.scan(model_library.common_folders(Path.home(), stt_root(ctx)))
    return [item for item in report["models"] if item["format"] == "gguf"]


def _fit_of(
    catalog: catalog_module.Catalog,
    hardware_now: dict[str, Any],
    pin: Optional[catalog_module.Model],
    size_bytes: int,
) -> str:
    kv = pin.kv_bytes_per_token if pin is not None else catalog_module.FILE_KV_BYTES_PER_TOKEN
    return catalog_module.fit(
        catalog_module.needs_bytes(size_bytes, kv, catalog.context_tokens), hardware_now
    )


def _layers(pin: Optional[catalog_module.Model], fit_kind: str, vram: Optional[int]) -> int:
    if pin is None:
        return catalog_module.FULL_OFFLOAD_LAYERS if fit_kind == "gpu" else 0
    return catalog_module.offload_layers(pin, fit_kind, vram)


def _alias(model_id: str) -> str:
    """The model name the server answers to. A file path is hashed: provider model ids allow no spaces."""
    if model_id.startswith(FILE_PREFIX):
        return "local-file-" + hashlib.sha256(model_id.encode("utf-8")).hexdigest()[:16]
    return model_id


def _managed_files(ctx: Context) -> list[tuple[Path, int]]:
    """GGUF files this app downloaded: one folder per owner and repository, and flat files from an earlier catalog."""
    found: list[tuple[Path, int]] = []
    for pattern in ("*.gguf", "*/*/*.gguf"):
        for path in models_dir(ctx).glob(pattern):
            try:
                if path.is_file():
                    found.append((path, path.stat().st_size))
            except OSError:
                continue
    return found


def _file_entry(
    catalog: catalog_module.Catalog,
    hardware_now: dict[str, Any],
    path: str,
    size: int,
    removable: bool,
    description: str,
) -> dict[str, Any]:
    return {
        "id": f"{FILE_PREFIX}{path}",
        "name": Path(path).name,
        "description": description,
        "size_bytes": size,
        "license": None,
        "fit": _fit_of(catalog, hardware_now, None, size),
        "downloaded": True,
        "source": "file",
        "removable": removable,
    }


def list_models(
    ctx: Context, catalog: catalog_module.Catalog, hardware_now: dict[str, Any]
) -> list[dict[str, Any]]:
    """The model choice: GGUF files on this PC, downloaded here or found in place. Catalog models are not offered."""
    downloaded = _managed_files(ctx)
    downloaded_keys = {str(path.resolve()) for path, _size in downloaded}
    models = [
        _file_entry(catalog, hardware_now, str(path), size, True, "Downloaded from Hugging Face.")
        for path, size in downloaded
    ]
    for item in _local_files(ctx):
        if str(Path(item["path"]).resolve()) in downloaded_keys:
            continue
        models.append(
            _file_entry(
                catalog,
                hardware_now,
                str(item["path"]),
                int(item["size"]),
                False,
                "A .gguf file on this PC, used where it is.",
            )
        )
    return models


def _model_path(
    ctx: Context, catalog: catalog_module.Catalog, model_id: str
) -> tuple[Path, Optional[catalog_module.Model]]:
    """The .gguf to run and its catalog pin (None for a file used in place)."""
    pin = catalog.model(model_id)
    if pin is not None:
        path = models_dir(ctx) / pin.file
        try:
            present = path.is_file() and path.stat().st_size == pin.size_bytes
        except OSError:
            present = False
        if not present:
            raise AppError("local_ai_model", "Download this model first, then choose it.")
        return path, pin
    if model_id.startswith(FILE_PREFIX):
        path = Path(model_id[len(FILE_PREFIX) :])
        try:
            usable = path.is_absolute() and path.suffix.lower() == ".gguf" and path.is_file()
        except OSError:
            usable = False
        if not usable:
            raise AppError(
                "local_ai_model",
                "That model file is gone or is not a .gguf file. Scan local models again.",
            )
        return path, None
    raise AppError("local_ai_model", "Choose a listed Local AI model.")


# ---- ports ---------------------------------------------------------------------------


def _free(port: int) -> bool:
    if not MIN_PORT <= port <= MAX_PORT:
        return False
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind((server.HOST, port))
    except OSError:
        return False
    return True


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((server.HOST, 0))
        return int(probe.getsockname()[1])


def _owned(ctx: Context, port: Optional[int]) -> bool:
    """True when the managed server already runs on this port, so the port is ours, not taken."""
    supervisor = _supervisor(ctx)
    if supervisor is None or port is None:
        return False
    spec = supervisor.spec
    return spec is not None and spec.port == port and supervisor.state in ("starting", "running")


def _port(stored: Optional[int], owned: bool = False) -> int:
    """The saved port while it is ours or free, else 39281, else any free loopback port."""
    if stored and owned:
        return int(stored)
    for candidate in (stored, PREFERRED_PORT):
        if candidate and _free(int(candidate)):
            return int(candidate)
    return _free_port()


# ---- status --------------------------------------------------------------------------


def status(ctx: Context) -> dict[str, Any]:
    catalog = catalog_module.load()
    hardware_now = hardware.detect()
    backend = hardware_now["backend"]
    with ctx.store.lock:
        row = _row(ctx.store.db)
        in_use = _in_use(ctx.store.db, row)
    supervisor = _supervisor(ctx)
    return {
        "hardware": hardware_now,
        "engine_installed": engine.installed(root(ctx), catalog.engine.tag, backend),
        "engine_tag": catalog.engine.tag,
        "engine_download_bytes": engine.missing_bytes(catalog, backend, root(ctx)),
        "server": supervisor.state if supervisor is not None else "stopped",
        "server_error": supervisor.error_message if supervisor is not None else None,
        "active_model": _normalize_model_id(ctx, catalog, row.active_model),
        "in_use": in_use,
        "models": list_models(ctx, catalog, hardware_now),
        "job": _JOB.snapshot(),
    }


# ---- starting the server -------------------------------------------------------------


def _start(
    ctx: Context,
    model_id: str,
    path: Path,
    pin: Optional[catalog_module.Model],
    port: int,
    key: str,
    layers: int,
    hardware_now: dict[str, Any],
    background: bool = True,
) -> None:
    catalog = catalog_module.load()
    program = engine.server_executable(root(ctx), catalog.engine.tag, hardware_now["backend"])
    spec = server.Spec(
        executable=program,
        model_path=path,
        model=_alias(model_id),
        port=port,
        api_key=key,
        layers=layers,
        context=catalog.context_tokens,
        log_path=log_path(ctx),
    )
    supervisor = _supervisor(ctx, create=True)
    if supervisor is None:
        return
    if background:
        supervisor.start(spec)
    else:
        # A blocking start waits for readiness and leaves the crash watcher running.
        supervisor.ensure(spec)


def _key_of(row: dict[str, Any]) -> Optional[str]:
    account = row.get("credential_account")
    if account is None:
        return None
    return keys.read_key(account)


def _connection_by_name(db: Any) -> Optional[dict[str, Any]]:
    rows = db.execute(
        "SELECT id FROM saved_connections WHERE name = ?1 ORDER BY revision DESC",
        (CONNECTION_NAME,),
    ).fetchall()
    for (connection_id,) in rows:
        found = reads.saved_connection(db, connection_id)
        if found is not None and providers.is_local_base(found["base_url"]):
            return found
    return None


def _ensure_connection(ctx: Context, db: Any, row: Row, base: str) -> tuple[str, str]:
    """Creates or updates the one "Local AI" connection and returns its id and key."""
    existing = reads.saved_connection(db, row.connection_id) if row.connection_id else None
    if existing is None:
        existing = _connection_by_name(db)
    if existing is None:
        key = secrets.token_urlsafe(KEY_BYTES)
        before = {item["id"] for item in reads.read_settings(db)["saved_connections"]}
        after = connections.save_api_connection(
            ctx, None, CONNECTION_NAME, base, {"kind": "replace", "key": key}, None
        )
        created = next(
            (
                item["id"]
                for item in after["saved_connections"]
                if item["id"] not in before and item["name"] == CONNECTION_NAME
            ),
            None,
        )
        if created is None:
            raise AppError(
                "local_ai_connection",
                "The Local AI connection could not be saved. Reload Settings and try again.",
            )
        return created, key
    # A stored key is reused only for this same local destination. Any other address (a changed
    # port, or a connection edited to a remote address) gets a new key, so no other credential
    # ever reaches the local server.
    stored = _key_of(existing) if existing["base_url"] == base else None
    key = stored if stored is not None else secrets.token_urlsafe(KEY_BYTES)
    if stored is None or existing["name"] != CONNECTION_NAME or existing["base_url"] != base:
        connections.save_api_connection(
            ctx,
            existing["id"],
            CONNECTION_NAME,
            base,
            {"kind": "replace", "key": key},
            existing["revision"],
        )
    return existing["id"], key


def _assign_llm(ctx: Context, db: Any, connection_id: str, model: str) -> None:
    found = db.execute(
        "SELECT connection_id, revision FROM provider_assignments WHERE role = 'llm'"
    ).fetchone()
    expected = found[1] if found is not None and found[0] is not None else None
    connections.save_provider_assignment(
        ctx,
        "llm",
        {"kind": "assigned", "connection_id": connection_id, "model": model},
        expected,
    )


# ---- command handlers ----------------------------------------------------------------


def local_ai_status(ctx: Context) -> dict[str, Any]:
    return status(ctx)


def local_ai_install_engine(ctx: Context) -> dict[str, Any]:
    """Downloads this PC's pinned llama.cpp build. Runs only on an explicit call."""
    catalog = catalog_module.load()
    backend = hardware.detect()["backend"]
    if engine.installed(root(ctx), catalog.engine.tag, backend):
        return status(ctx)
    with _JOB.operation("engine", backend) as cancel:
        root(ctx).mkdir(parents=True, exist_ok=True)
        progress = lambda phase, done, total: _JOB.progress(ctx.emit, phase, done, total)  # noqa: E731
        engine.install(root(ctx), backend, catalog, progress, cancel, ctx.transport)
    return status(ctx)


def local_ai_search_hf(ctx: Context, query: Any) -> list[dict[str, Any]]:
    """Searches Hugging Face for GGUF models. Only the search text is sent there."""
    return hub.search(text_arg(query, "query"), ctx.transport)


def local_ai_hf_files(ctx: Context, repo_id: Any) -> dict[str, Any]:
    """One repository's GGUF files, each with its fit for this PC and whether it is already here."""
    repo = text_arg(repo_id, "repo_id")
    listing = hub.files(repo, ctx.transport)
    catalog = catalog_module.load()
    hardware_now = hardware.detect()
    for entry in listing["files"]:
        entry["fit"] = _fit_of(catalog, hardware_now, None, entry["size_bytes"])
        entry["downloaded"] = hub.managed_path(models_dir(ctx), repo, entry["filename"]).is_file()
    return listing


def local_ai_download_hf(
    ctx: Context,
    repo_id: Any,
    revision: Any,
    filename: Any,
    size_bytes: Any,
    sha256: Any,
) -> dict[str, Any]:
    """Downloads one GGUF pinned to the listed commit. It must match its SHA-256, or nothing is kept."""
    repo = text_arg(repo_id, "repo_id")
    name = text_arg(filename, "filename")
    hub.check_pick(repo, revision, name, size_bytes, sha256)
    catalog = catalog_module.load()
    hardware_now = hardware.detect()
    if _fit_of(catalog, hardware_now, None, size_bytes) == "too_big":
        raise AppError("local_ai_fit", "This model needs more memory than this PC has.")
    destination = hub.managed_path(models_dir(ctx), repo, name)
    if destination.is_file():
        return status(ctx)
    owner, _repo_name = repo.split("/", 1)
    model_hub.managed_folder(models_dir(ctx), [owner, _repo_name])
    with _JOB.operation("model", f"{repo}/{name}") as cancel:
        model_hub.fetch_verified(
            hub.resolve_url(repo, revision, name),
            destination.parent,
            name,
            size_bytes,
            sha256,
            progress=lambda done: _JOB.progress(ctx.emit, "download", done, size_bytes),
            cancel=cancel,
            transport=ctx.transport,
        )
    return status(ctx)


def _prune_empty_folders(folder: Path, stop: Path) -> None:
    """Removes the folders a removed download left empty, up to but never including the models folder."""
    current = folder
    while current != stop and stop in current.parents:
        try:
            current.rmdir()
        except OSError:
            return
        current = current.parent


def _normalize_model_id(ctx: Context, catalog: catalog_module.Catalog, model_id: Optional[str]) -> Optional[str]:
    """A catalog id saved by an earlier version names the same flat file the new UI lists."""
    if model_id is None or model_id.startswith(FILE_PREFIX):
        return model_id
    pin = catalog.model(model_id)
    if pin is None:
        return model_id
    path = models_dir(ctx) / pin.file
    try:
        if path.is_file() and path.stat().st_size == pin.size_bytes:
            return f"{FILE_PREFIX}{path}"
    except OSError:
        pass
    return model_id


def local_ai_remove_model(ctx: Context, model_id: Any) -> dict[str, Any]:
    """Deletes a GGUF this app downloaded. A file used in place on this PC is never deleted."""
    model_id = text_arg(model_id, "model_id")
    catalog = catalog_module.load()
    if model_id.startswith(FILE_PREFIX):
        wanted = Path(model_id[len(FILE_PREFIX) :]).resolve()
    else:
        pin = catalog.model(model_id)
        if pin is None:
            raise AppError("local_ai_model", "Choose a listed Local AI model.")
        wanted = (models_dir(ctx) / pin.file).resolve()
    managed = next((item for item in _managed_files(ctx) if item[0].resolve() == wanted), None)
    if managed is None:
        raise AppError(
            "local_ai_file",
            "This model is a file on this PC. Delete it in its own folder instead.",
        )
    if _JOB.snapshot() is not None:
        raise AppError(
            "local_ai_busy",
            "A Local AI download is running. Wait for it or cancel it first.",
        )
    path = managed[0]
    with ctx.store.lock:
        db = ctx.store.db
        row = _row(db)
        supervisor = _supervisor(ctx)
        busy = supervisor is not None and supervisor.state in ("starting", "running")
        normalized_active = _normalize_model_id(ctx, catalog, row.active_model)
        normalized_model = _normalize_model_id(ctx, catalog, model_id)
        if normalized_active is not None and normalized_active == normalized_model and busy:
            raise AppError("local_ai_active", "Turn off Local AI first.")
        try:
            path.unlink(missing_ok=True)
        except OSError as cause:
            raise AppError(
                "local_ai_files",
                "The model file could not be removed. Close other apps and try again.",
            ) from cause
        _prune_empty_folders(path.parent, models_dir(ctx))
        if normalized_active is not None and normalized_active == normalized_model:
            _save_row(db, Row(row.backend, row.port, None, row.connection_id))
    return status(ctx)


def local_ai_cancel(ctx: Context) -> None:
    _JOB.cancel()


def local_ai_use(ctx: Context, model_id: Any) -> dict[str, Any]:
    """Makes this model the Local AI default and starts the server behind the saved connection."""
    model_id = text_arg(model_id, "model_id")
    catalog = catalog_module.load()
    hardware_now = hardware.detect()
    path, pin = _model_path(ctx, catalog, model_id)
    fit_kind = _fit_of(catalog, hardware_now, pin, pin.size_bytes if pin else path.stat().st_size)
    layers = _layers(pin, fit_kind, hardware_now.get("vram_bytes"))
    with ctx.store.lock:
        db = ctx.store.db
        row = _row(db)
        port = _port(row.port, _owned(ctx, row.port))
        base = server.base_url(port)
        connection_id, key = _ensure_connection(ctx, db, row, base)
        _assign_llm(ctx, db, connection_id, _alias(model_id))
        _save_row(db, Row(hardware_now["backend"], port, model_id, connection_id))
        settings = reads.read_settings(db)
    _start(ctx, model_id, path, pin, port, key, layers, hardware_now, background=True)
    return settings


def local_ai_start(ctx: Context) -> dict[str, Any]:
    """Turns the server on with the chosen model and port."""
    catalog = catalog_module.load()
    hardware_now = hardware.detect()
    with ctx.store.lock:
        db = ctx.store.db
        row = _row(db)
        if not row.active_model:
            raise AppError("local_ai_model", "Choose a Local AI model first.")
        path, pin = _model_path(ctx, catalog, row.active_model)
        connection = (
            reads.saved_connection(db, row.connection_id) if row.connection_id else None
        )
        if connection is None:
            raise AppError("local_ai_connection", "Choose a Local AI model first.")
        if not providers.is_local_base(connection["base_url"]):
            raise AppError(
                "local_ai_connection",
                "The Local AI connection points to a remote address, so the server was not "
                "started. Choose the model again in Local AI.",
            )
        port = _port(row.port, _owned(ctx, row.port))
        base = server.base_url(port)
        if base == connection["base_url"]:
            key = _key_of(connection)
            if key is None:
                raise AppError(
                    "local_ai_key", "The Local AI key is missing. Choose the model again."
                )
            connection_id = connection["id"]
        else:
            # The port moved: the saved address and the row change together, with a new key.
            connection_id, key = _ensure_connection(ctx, db, row, base)
        if (port, connection_id) != (row.port, row.connection_id):
            _save_row(db, Row(row.backend, port, row.active_model, connection_id))
        fit_kind = _fit_of(
            catalog, hardware_now, pin, pin.size_bytes if pin else path.stat().st_size
        )
        layers = _layers(pin, fit_kind, hardware_now.get("vram_bytes"))
    _start(ctx, row.active_model, path, pin, port, key, layers, hardware_now, background=True)
    return status(ctx)


def local_ai_stop(ctx: Context) -> dict[str, Any]:
    supervisor = _supervisor(ctx)
    if supervisor is not None:
        supervisor.stop()
    return status(ctx)


def ensure_ready(ctx: Context, config: Optional[dict[str, Any]]) -> None:
    """Starts the managed server first when the assigned LLM connection is Local AI.

    Called before an LLM request is built. A stopped server with the chosen model is started and
    waited for; a server that cannot start raises, so the request fails with a message that says
    what to do instead of a bare connection error.
    """
    if not config:
        return
    catalog = catalog_module.load()
    with ctx.store.lock:
        db = ctx.store.db
        row = _row(db)
        if row.connection_id is None or row.port is None:
            return
        connection = reads.saved_connection(db, row.connection_id)
    if connection is None:
        return
    expected = (connection["base_url"] or "").rstrip("/")
    if (config.get("base_url") or "").rstrip("/") != expected:
        return
    # Only a connection saved for this managed server may start it. A remote or other local
    # address never receives this server's key, and this server never starts for it.
    if expected != server.base_url(row.port):
        return
    if row.active_model is None:
        raise AppError(
            "local_ai_model",
            "The Local AI model was removed. Choose a model in Local AI, then try again.",
        )
    path, pin = _model_path(ctx, catalog, row.active_model)
    key = _key_of(connection)
    if key is None:
        raise AppError("local_ai_key", "The Local AI key is missing. Choose the model again.")
    hardware_now = hardware.detect()
    fit_kind = _fit_of(catalog, hardware_now, pin, pin.size_bytes if pin else path.stat().st_size)
    layers = _layers(pin, fit_kind, hardware_now.get("vram_bytes"))
    _start(ctx, row.active_model, path, pin, row.port, key, layers, hardware_now, background=False)
