"""Provider URLs, model IDs, bounded HTTP and model discovery.

Requests carry the key only as a Bearer header, never follow redirects, never retry, and read
at most a fixed number of bytes. Errors use the codes the UI already knows and never echo a body
or a key.
"""

from __future__ import annotations

import ipaddress
import json
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Optional
from urllib.parse import urlsplit

import httpx

from openmeet_py.api.context import byte_len
from openmeet_py.api.errors import AppError
from openmeet_py.platform import keys

MAX_BASE_URL_BYTES = 2048
MAX_MODEL_BYTES = 256
MAX_MODELS_BYTES = 4 * 1024 * 1024
MAX_MODELS = 2000
MAX_CHAT_BYTES = 2 * 1024 * 1024
MODELS_TIMEOUT = 15.0
CHAT_TIMEOUT = 120.0


def invalid_url() -> AppError:
    return AppError(
        "provider_url",
        "Enter an HTTPS API base URL, or HTTP on localhost, without credentials, query parameters or a fragment.",
    )


def is_local_base(value: str) -> bool:
    try:
        host = urlsplit(value).hostname
    except ValueError:
        return False
    if not host:
        return False
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def validate_base_url(value: str) -> str:
    value = value.strip()
    if not value or byte_len(value) > MAX_BASE_URL_BYTES:
        raise invalid_url()
    # Any ? or # is refused outright, so an empty query or fragment cannot slip through.
    if any(c.isspace() for c in value) or "?" in value or "#" in value:
        raise invalid_url()
    try:
        parts = urlsplit(value)
        parts.port  # raises ValueError for a bad port
    except ValueError:
        raise invalid_url() from None
    scheme = parts.scheme.lower()
    if not parts.hostname or parts.username is not None or parts.password is not None:
        raise invalid_url()
    if scheme != "https" and not (scheme == "http" and is_local_base(value)):
        raise invalid_url()
    return value.rstrip("/")


def validate_model(value: str) -> None:
    if (
        not value
        or byte_len(value) > MAX_MODEL_BYTES
        or any(c.isspace() or unicodedata.category(c) == "Cc" for c in value)
    ):
        raise AppError(
            "provider_model",
            "Enter a nonempty model ID of at most 256 bytes without whitespace.",
        )


def _model_ok(value: str) -> bool:
    try:
        validate_model(value)
    except AppError:
        return False
    return True


@dataclass(frozen=True)
class Connection:
    base_url: str
    model: Optional[str]
    key: str = field(repr=False)
    transport: Any = field(default=None, repr=False)

    def endpoint(self, path: str) -> str:
        return f"{self.base_url}/{path}"

    def require_model(self) -> str:
        if not self.model:
            raise AppError("provider_model_missing", "Choose and save a model in Settings first.")
        return self.model

    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.key}"} if self.key else {}


def missing_key() -> AppError:
    return AppError(
        "provider_key_missing",
        "No usable API key is saved for this provider. Add one in Settings.",
    )


def load_connection(config: dict[str, Any], transport: Any = None) -> Connection:
    """Builds a sendable connection from a stored provider row (with its internal account name)."""
    base_url = validate_base_url(config["base_url"])
    model = config.get("model")
    if model is not None:
        validate_model(model)
    account = config.get("credential_account")
    if account is None and is_local_base(base_url):
        return Connection(base_url, model, "", transport)
    if account is None:
        raise missing_key()
    key = keys.read_key(account)
    if key is None or not keys.valid_key(key):
        raise missing_key()
    return Connection(base_url, model, key, transport)


def client(timeout: float, transport: Any) -> httpx.Client:
    return httpx.Client(
        timeout=httpx.Timeout(timeout, connect=min(5.0, timeout)),
        follow_redirects=False,
        trust_env=False,
        transport=transport,
    )


def check_status(status: int) -> None:
    if status in (401, 403):
        raise AppError(
            "provider_unauthorized",
            "The provider rejected the API key. Check the saved key and its permissions.",
        )
    if status == 429:
        raise AppError(
            "provider_rate_limited",
            "The provider is rate limiting requests. Wait and retry explicitly.",
        )
    if not 200 <= status < 300:
        raise AppError(
            "provider_response",
            f"The provider returned HTTP {status}. Check endpoint and model compatibility; nothing was saved.",
        )


def request_capped(
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    content: Optional[bytes],
    timeout: float,
    transport: Any,
    limit: int,
    invalid: AppError,
) -> bytes:
    """One request, no retries. Status is checked before any body is read; oversize bodies fail."""
    unreachable = AppError(
        "provider_unreachable",
        "Cannot reach the provider. Check the API base URL and your connection.",
    )
    with client(timeout, transport) as http:
        try:
            with http.stream(method, url, headers=headers, content=content) as response:
                check_status(response.status_code)
                body = bytearray()
                try:
                    for chunk in response.iter_bytes():
                        body.extend(chunk)
                        if len(body) > limit:
                            raise invalid
                except httpx.HTTPError:
                    raise invalid from None
                return bytes(body)
        except httpx.HTTPError:
            raise unreachable from None


def models_invalid() -> AppError:
    return AppError(
        "provider_models",
        "The provider returned an unsupported model list. Enter a model ID manually if discovery is unavailable.",
    )


def list_models(connection: Connection, timeout: float = MODELS_TIMEOUT) -> list[dict[str, str]]:
    """GET {base}/models. Returns sorted, de-duplicated IDs that pass model validation."""
    invalid = models_invalid()
    raw = request_capped(
        "GET",
        connection.endpoint("models"),
        headers=connection.headers(),
        content=None,
        timeout=timeout,
        transport=connection.transport,
        limit=MAX_MODELS_BYTES,
        invalid=invalid,
    )
    try:
        catalog = json.loads(raw)
    except ValueError:
        raise invalid from None
    if not isinstance(catalog, dict):
        raise invalid
    has_more = catalog.get("has_more", False)
    if not isinstance(has_more, bool) or has_more:
        raise invalid
    data = catalog.get("data")
    if not isinstance(data, list) or len(data) > MAX_MODELS:
        raise invalid
    ids: set[str] = set()
    for item in data:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            raise invalid
        if _model_ok(item["id"]):
            ids.add(item["id"])
    return [{"id": model_id} for model_id in sorted(ids)]


def chat_completion(connection: Connection, payload: bytes, timeout: float = CHAT_TIMEOUT) -> str:
    """POST {base}/chat/completions with a prebuilt JSON body. Returns the first non-empty reply."""
    raw = request_capped(
        "POST",
        connection.endpoint("chat/completions"),
        headers={**connection.headers(), "Content-Type": "application/json"},
        content=payload,
        timeout=timeout,
        transport=connection.transport,
        limit=MAX_CHAT_BYTES,
        invalid=AppError(
            "provider_response",
            "the selected provider returned an unusable response. Nothing was saved.",
        ),
    )
    try:
        reply = json.loads(raw)
        texts = [choice["message"].get("content") for choice in reply["choices"]]
    except (ValueError, KeyError, TypeError, AttributeError):
        raise AppError(
            "provider_response",
            "the selected provider returned an unusable response. Nothing was saved.",
        ) from None
    for text in texts:
        if isinstance(text, str) and text.strip():
            return text.strip()
    raise AppError("provider_response", "The model returned an empty response. Nothing was saved.")
