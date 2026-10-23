"""AI provider connections, key status, model discovery and task assignments.

Ports storage.rs save/delete/assign functions and the command wrappers in lib.rs. Every write is
guarded by an expected revision. A changed destination always needs a new key, except for loopback
servers, which may run without one. Keys go to keys.py and never into a response.
"""

from __future__ import annotations

import uuid
from typing import Any, Optional

from . import keys, providers
from .context import Context, byte_len, dict_arg, has_control, optional_int_arg, optional_text_arg, text_arg
from .errors import AppError
from .reads import PROVIDER_ROLES, provider_config, read_settings, saved_connection
from .store import transaction

MAX_CONNECTION_NAME_BYTES = 120


def provider_conflict() -> AppError:
    return AppError(
        "provider_conflict",
        "Provider settings changed elsewhere. Reload Settings and try again; nothing was overwritten.",
    )


def plan_changed() -> AppError:
    return AppError(
        "processing_plan_changed",
        "The meeting or provider settings changed while this was running. Nothing new was saved; try again.",
    )


def _role(value: Any) -> str:
    if value not in PROVIDER_ROLES:
        raise AppError("invalid_args", "Unknown provider role.")
    return value


def provider_key_status(ctx: Context, role: str) -> str:
    role = _role(role)
    with ctx.store.lock:
        config = provider_config(ctx.store.db, role)
    return keys.key_status(config["credential_account"] if config else None)


def api_connection_key_status(ctx: Context, id: str) -> str:
    with ctx.store.lock:
        row = saved_connection(ctx.store.db, text_arg(id, "id"))
    if row is None:
        raise provider_conflict()
    return keys.key_status(row["credential_account"])


def _name(value: str) -> str:
    value = value.strip()
    if not value or byte_len(value) > MAX_CONNECTION_NAME_BYTES or has_control(value):
        raise AppError(
            "provider_name",
            "Enter a connection name of at most 120 bytes without control characters.",
        )
    return value


def _key_account(
    change: dict[str, Any], previous: Optional[dict[str, Any]], base_url: str
) -> Optional[str]:
    """The account the connection will use: keep, a new stored key, or none."""
    kind = change.get("kind")
    if kind == "keep":
        if previous is not None and previous["base_url"] != base_url:
            if providers.is_local_base(base_url):
                return None
            raise AppError(
                "provider_key",
                "Enter a new API key when changing the provider URL. Nothing was saved.",
            )
        return previous["credential_account"] if previous else None
    if kind == "replace":
        return keys.store_key(text_arg(change.get("key"), "key"))
    if kind == "remove":
        return None
    raise AppError("invalid_args", "Choose how to change the API key.")


def _check_destination(
    previous: Optional[dict[str, Any]], base_url: str, account: Optional[str]
) -> None:
    """Changing the destination needs a new key, unless the new destination is loopback."""
    if previous is None or previous["base_url"] == base_url:
        return
    unkeyed_remote = account is None and not providers.is_local_base(base_url)
    reused_key = account is not None and account == previous["credential_account"]
    if unkeyed_remote or reused_key:
        raise AppError(
            "provider_key_required",
            "Enter a new API key when changing the provider URL.",
        )


def _account_in_use(db: Any, account: str) -> bool:
    return bool(
        db.execute(
            "SELECT EXISTS(SELECT 1 FROM saved_connections WHERE credential_account = ?1)",
            (account,),
        ).fetchone()[0]
    )


def save_api_connection(
    ctx: Context,
    id: Any,
    name: Any,
    base_url: Any,
    key_change: Any,
    expected_revision: Any,
) -> dict[str, Any]:
    id = optional_text_arg(id, "id")
    base_url = providers.validate_base_url(text_arg(base_url, "base_url"))
    name = _name(text_arg(name, "name"))
    change = dict_arg(key_change, "key_change")
    expected = optional_int_arg(expected_revision, "expected_revision")
    with ctx.store.lock:
        db = ctx.store.db
        previous = None
        if id is not None:
            previous = saved_connection(db, id)
            if previous is None:
                raise provider_conflict()
        if (previous["revision"] if previous else None) != expected:
            raise plan_changed()
        old_account = previous["credential_account"] if previous else None
        account: Optional[str] = None
        try:
            account = _key_account(change, previous, base_url)
            _check_destination(previous, base_url, account)
            new_id = id if id is not None else str(uuid.uuid4())
            revision = (expected or 0) + 1
            with transaction(db):
                db.execute(
                    "INSERT INTO saved_connections(id,name,base_url,credential_account,revision) "
                    "VALUES (?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name, "
                    "base_url=excluded.base_url, credential_account=excluded.credential_account, "
                    "revision=excluded.revision",
                    (new_id, name, base_url, account, revision),
                )
                db.execute(
                    "UPDATE provider_assignments SET revision=revision+1 WHERE connection_id=?1",
                    (new_id,),
                )
        except BaseException:
            # A credential stored for this save only is removed so nothing is orphaned.
            if account is not None and account != old_account:
                keys.delete_key(account)
            raise
        if old_account is not None and old_account != account and not _account_in_use(db, old_account):
            try:
                keys.delete_key(old_account)
            except AppError as error:
                raise AppError(
                    "provider_cleanup",
                    "The connection was saved, but its previous credential could not be removed "
                    "from the OS keychain. Reload Settings to see the current connection.",
                ) from error
        return read_settings(db)


def delete_api_connection(ctx: Context, id: Any, expected_revision: Any) -> dict[str, Any]:
    id = text_arg(id, "id")
    expected = optional_int_arg(expected_revision, "expected_revision")
    with ctx.store.lock:
        db = ctx.store.db
        row = saved_connection(db, id)
        if row is None:
            raise provider_conflict()
        if db.execute(
            "SELECT EXISTS(SELECT 1 FROM provider_assignments WHERE connection_id=?1)", (id,)
        ).fetchone()[0]:
            raise AppError(
                "provider_assigned",
                "Unassign this connection from all tasks before deleting it.",
            )
        with transaction(db):
            deleted = db.execute(
                "DELETE FROM saved_connections WHERE id=?1 AND revision=?2", (id, expected)
            ).rowcount
            if deleted != 1:
                raise provider_conflict()
        account = row["credential_account"]
        if account is not None and not _account_in_use(db, account):
            try:
                keys.delete_key(account)
            except AppError as error:
                raise AppError(
                    "provider_cleanup",
                    "The connection was deleted, but its credential could not be removed from the OS keychain.",
                ) from error
        return read_settings(db)


def save_provider_assignment(
    ctx: Context, role: Any, selection: Any, expected_revision: Any
) -> dict[str, Any]:
    role = _role(role)
    selection = dict_arg(selection, "selection")
    expected = optional_int_arg(expected_revision, "expected_revision")
    with ctx.store.lock:
        db = ctx.store.db
        with transaction(db) as tx:
            connection_id, revision = tx.execute(
                "SELECT connection_id, revision FROM provider_assignments WHERE role=?1", (role,)
            ).fetchone()
            assigned_revision = revision if connection_id is not None else None
            if assigned_revision != expected:
                raise provider_conflict()
            if selection.get("kind") == "unassigned":
                next_id, model = None, None
            elif selection.get("kind") == "assigned":
                next_id = text_arg(selection.get("connection_id"), "connection_id")
                model = text_arg(selection.get("model"), "model")
                providers.validate_model(model)
                if not tx.execute(
                    "SELECT EXISTS(SELECT 1 FROM saved_connections WHERE id=?1)", (next_id,)
                ).fetchone()[0]:
                    raise provider_conflict()
            else:
                raise AppError("invalid_args", "Choose a listed connection and model.")
            tx.execute(
                "UPDATE provider_assignments SET connection_id=?1, model=?2, revision=?3 WHERE role=?4",
                (next_id, model, revision + 1, role),
            )
        return read_settings(db)


def list_api_connection_models(ctx: Context, id: Any, expected_revision: Any) -> list[dict[str, str]]:
    id = text_arg(id, "id")
    expected = optional_int_arg(expected_revision, "expected_revision")

    def current() -> dict[str, Any]:
        row = saved_connection(ctx.store.db, id)
        if row is None:
            raise provider_conflict()
        if row["revision"] != expected:
            raise plan_changed()
        return row

    with ctx.store.lock:
        config = current()
    connection = providers.load_connection(
        {"base_url": config["base_url"], "model": None, "credential_account": config["credential_account"]},
        ctx.transport,
    )
    models = providers.list_models(connection)
    with ctx.store.lock:
        current()
    return models
