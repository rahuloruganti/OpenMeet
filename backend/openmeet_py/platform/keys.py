"""API keys in the OS credential store, never in SQLite, logs, responses or frontend state.

Keys go to the Windows Credential Manager through `keyring`, under this build's own service name.
Tests install an in-memory backend with use_backend(); nothing else changes.
"""

from __future__ import annotations

import uuid
from typing import Any, Optional

from keyring.errors import PasswordDeleteError

from openmeet_py.api.errors import AppError

SERVICE = "OpenMeetPy"
MAX_KEY_BYTES = 4096

_override: Any = None
_windows: Any = None


def use_backend(backend: Any) -> None:
    """Replaces the credential backend (tests only). Pass None to restore the Windows store."""
    global _override
    _override = backend


def _backend() -> Any:
    global _windows
    if _override is not None:
        return _override
    if _windows is None:
        # Constructed explicitly: entry-point discovery can miss inside a one-file PyInstaller exe.
        from keyring.backends.Windows import WinVaultKeyring

        _windows = WinVaultKeyring()
    return _windows


def _unavailable() -> AppError:
    return AppError(
        "keychain_unavailable",
        "The OS credential store could not be used. Check Settings and try again.",
    )


def valid_key(value: str) -> bool:
    raw = value.encode("utf-8")
    return 0 < len(raw) <= MAX_KEY_BYTES and all(0x21 <= byte <= 0x7E for byte in raw)


def key_status(account: Optional[str]) -> str:
    """present, missing or unavailable. Never returns the key itself."""
    if account is None:
        return "missing"
    try:
        return "missing" if _backend().get_password(SERVICE, account) is None else "present"
    except Exception:  # any backend failure is "unavailable"; the message must not echo details
        return "unavailable"


def read_key(account: str) -> Optional[str]:
    try:
        return _backend().get_password(SERVICE, account)
    except Exception:
        raise _unavailable() from None


def store_key(key: str) -> str:
    """Stores a validated key under a new account name and returns that name."""
    key = key.strip()
    if not valid_key(key):
        raise AppError(
            "provider_key",
            "Enter a valid API key without whitespace, at most 4096 bytes.",
        )
    account = f"connection-{uuid.uuid4()}"
    try:
        _backend().set_password(SERVICE, account, key)
    except Exception:
        raise _unavailable() from None
    return account


def delete_key(account: str) -> None:
    try:
        _backend().delete_password(SERVICE, account)
    except PasswordDeleteError:
        return  # already gone
    except Exception:
        raise _unavailable() from None
