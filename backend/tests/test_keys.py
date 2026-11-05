"""Credential backend selection on both platforms. The real store is never read or written."""

from __future__ import annotations

import sys
from typing import Any, Optional

import pytest
from conftest import MemoryKeyring
from keyring.backends.Windows import WinVaultKeyring

from openmeet_py.api.errors import AppError
from openmeet_py.platform import keys


class BrokenBackend:
    """A store that refuses every call, the way a locked or missing one would."""

    def get_password(self, _service: str, _account: str) -> Optional[str]:
        raise RuntimeError("store is locked")

    def set_password(self, _service: str, _account: str, _value: str) -> None:
        raise RuntimeError("store is locked")

    def delete_password(self, _service: str, _account: str) -> None:
        raise RuntimeError("store is locked")


@pytest.fixture(autouse=True)
def default_backend(memory_keyring: MemoryKeyring) -> Any:
    """conftest installs the in-memory store; these tests exercise the platform selection instead.

    Depending on memory_keyring makes this run after it, so the override is cleared last.
    """
    keys.use_backend(None)
    yield
    keys.use_backend(None)


def test_windows_selects_the_credential_vault(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    assert isinstance(keys._backend(), WinVaultKeyring)


def test_macos_selects_the_keychain(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    from keyring.backends.macOS import Keyring

    assert isinstance(keys._backend(), Keyring)


def test_the_backend_is_reselected_when_the_platform_changes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    assert isinstance(keys._backend(), WinVaultKeyring)
    monkeypatch.setattr(sys, "platform", "darwin")
    from keyring.backends.macOS import Keyring

    assert isinstance(keys._backend(), Keyring)


def test_an_installed_backend_wins_on_both_platforms(
    monkeypatch: pytest.MonkeyPatch, memory_keyring: MemoryKeyring
) -> None:
    keys.use_backend(memory_keyring)
    for platform in ("win32", "darwin"):
        monkeypatch.setattr(sys, "platform", platform)
        assert keys._backend() is memory_keyring


def test_store_round_trip_reports_status_only(memory_keyring: MemoryKeyring) -> None:
    keys.use_backend(memory_keyring)
    account = keys.store_key("  sk-fictional-key  ")
    assert account.startswith("connection-")
    assert memory_keyring.items[(keys.SERVICE, account)] == "sk-fictional-key"
    assert keys.key_status(account) == "present"
    assert keys.key_status(None) == "missing"
    keys.delete_key(account)
    assert keys.key_status(account) == "missing"
    assert list(memory_keyring.items.values()) == []


def test_a_broken_store_is_unavailable_without_echoing_the_error() -> None:
    keys.use_backend(BrokenBackend())
    assert keys.key_status("connection-1") == "unavailable"
    with pytest.raises(AppError) as caught:
        keys.read_key("connection-1")
    assert caught.value.code == "keychain_unavailable"
    assert "locked" not in caught.value.message
    with pytest.raises(AppError) as caught:
        keys.store_key("sk-fictional")
    assert caught.value.code == "keychain_unavailable"


def test_invalid_keys_are_refused_before_the_store_is_touched(memory_keyring: MemoryKeyring) -> None:
    keys.use_backend(memory_keyring)
    with pytest.raises(AppError) as caught:
        keys.store_key("has space")
    assert caught.value.code == "provider_key"
    assert memory_keyring.items == {}


def test_the_key_size_limit_is_2560_bytes_on_windows_and_4096_elsewhere(
    memory_keyring: MemoryKeyring, monkeypatch: pytest.MonkeyPatch
) -> None:
    keys.use_backend(memory_keyring)
    long_key = "k" * 2561
    monkeypatch.setattr(sys, "platform", "win32")
    assert keys.max_key_bytes() == 2560
    assert keys.valid_key("k" * 2560)
    assert not keys.valid_key(long_key)
    with pytest.raises(AppError) as caught:
        keys.store_key(long_key)
    assert caught.value.code == "provider_key"
    assert "at most 2560 bytes" in caught.value.message
    assert memory_keyring.items == {}

    monkeypatch.setattr(sys, "platform", "darwin")
    assert keys.max_key_bytes() == 4096
    assert keys.valid_key(long_key)
    assert not keys.valid_key("k" * 4097)
    account = keys.store_key(long_key)
    assert keys.read_key(account) == long_key
