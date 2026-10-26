"""Automatic capture opt-in: the saved switch, and the notice to the call lifecycle.

Saving the switch starts nothing by itself. The lifecycle controller reads the new value and decides
whether a detected call may start a recording (api/lifecycle.py).
"""

from __future__ import annotations

from typing import Any

from openmeet_py.api.context import Context, bool_arg
from openmeet_py.api.reads import read_settings


def save_auto_capture(ctx: Context, enabled: Any) -> dict[str, Any]:
    enabled = bool_arg(enabled, "enabled")
    with ctx.store.lock:
        db = ctx.store.db
        db.execute("UPDATE settings SET auto_capture = ?1 WHERE id = 1", (int(enabled),))
        settings = read_settings(db)
    if ctx.lifecycle is not None:
        ctx.lifecycle.setting_changed(enabled)
    return settings
