"""API keys in the OS credential store, never in SQLite, logs, responses or frontend state.

Keys go to the OS credential store through `keyring`: Windows Credential Manager on Windows, Keychain
on macOS, always under this build's own service name. Tests install an in-memory backend with
use_backend(); nothing else changes.
"""

from __future__ import annotations

import sys
import uuid
from typing import Any, Optional

from keyring.errors import PasswordDeleteError

from openmeet_py.api.errors import AppError

SERVICE = "OpenMeetPy"
MAX_KEY_BYTES = 4096

_override: Any = None
_default: Any = None
_default_platform: Optional[str] = None


def use_backend(backend: Any) -> None:
    """Replaces the credential backend (tests only). None restores the OS credential store."""
    global _override
    _override = backend


def _backend() -> Any:
    global _default, _default_platform
    if _override is not None:
        return _override
    if _default is None or _default_platform != sys.platform:
        # Constructed explicitly: entry-point discovery can miss inside a frozen PyInstaller build.
        # keyring.backends.macOS.Keyring is a pure ctypes wrapper, so no pyobjc import happens here.
        if sys.platform == "darwin":
            from keyring.backends.macOS import Keyring

            _default = Keyring()
        else:
            from keyring.backends.Windows import WinVaultKeyring

            _default = WinVaultKeyring()
        _default_platform = sys.platform
    return _default


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


def store_at(account: str, value: str) -> None:
    """Stores a secret under a caller-chosen account (calendar feeds use 'calendar:<feed id>')."""
    try:
        _backend().set_password(SERVICE, account, value)
    except Exception:
        raise _unavailable() from None


def delete_key(account: str) -> None:
    try:
        _backend().delete_password(SERVICE, account)
    except PasswordDeleteError:
        return  # already gone
    except Exception:
        raise _unavailable() from None
