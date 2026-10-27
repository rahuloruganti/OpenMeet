"""Rewriting a selection: one request holding only the selected text and the request.

The result is returned and never stored. The provider is rechecked before the request and before
the reply is handed back, so a changed connection refuses instead of returning a stale rewrite.
"""

from __future__ import annotations

from typing import Any

from openmeet_py.api import reads
from openmeet_py.api.context import Context, ai_slot, text_arg
from openmeet_py.api.errors import AppError
from openmeet_py.domain import llm, providers
from openmeet_py.domain.connections import plan_changed
from openmeet_py.local_ai import service as local_ai


def rewrite_text(ctx: Context, text: Any, request: Any) -> str:
    """Sends only the selected text and the request. The result is returned and never stored."""
    text = text_arg(text, "text")
    request = text_arg(request, "request")
    with ctx.store.lock:
        config = reads.provider_config(ctx.store.db, "llm")
        if config is None:
            raise AppError("provider_missing", "Save a provider connection in Settings first.")
        llm.check_rewrite(text, request)
        if not config["model"]:
            raise AppError("provider_model", "Choose and save a model in Settings first.")
    with ai_slot(ctx):
        local_ai.ensure_ready(ctx, config)
        connection = providers.load_connection(config, ctx.transport)

        def before(_body: bytes) -> None:
            with ctx.store.lock:
                if reads.provider_config(ctx.store.db, "llm") != config:
                    raise plan_changed()

        answer = llm.rewrite(connection, text, request, before)
        with ctx.store.lock:
            if reads.provider_config(ctx.store.db, "llm") != config:
                raise plan_changed()
    return answer
