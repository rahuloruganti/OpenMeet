"""Shortcut parsing and validation with sys.platform set to darwin: Command, mac key codes, messages."""

from __future__ import annotations

import sys

import pytest

from openmeet_py.api.errors import AppError
from openmeet_py.platform.hotkeys import BARE_KEY, BARE_KEY_MAC, USE_HINT, USE_HINT_MAC, parse, validate
from openmeet_py.platform.macos import mac_key_code
from openmeet_py.platform.win32 import MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN


@pytest.fixture
def on_mac(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")


def test_commandorcontrol_is_command_and_keys_map_to_carbon_codes(on_mac: None) -> None:
    accelerator = parse("CommandOrControl+Shift+F9")
    assert (accelerator.modifiers, accelerator.vk, accelerator.f_key) == (MOD_WIN | MOD_SHIFT, 0x65, True)
    assert parse("Cmd+K").modifiers == MOD_WIN
    assert parse("Cmd+K").vk == 0x28
    assert parse("Control+Shift+Space").modifiers == MOD_CONTROL | MOD_SHIFT
    assert parse("Control+Shift+Space").vk == 0x31
    assert parse("Option+Up").modifiers == MOD_ALT
    assert parse("Option+Up").vk == 0x7E
    assert parse("Meta+Left").vk == 0x7B
    assert parse("Control+Delete").vk == 0x75
    assert parse("Control+Return").vk == 0x24
    assert parse("Control+5").vk == 0x17  # the unshifted key position, as on Windows
    assert parse("F9").f_key is True  # an F-key may stand alone


@pytest.mark.parametrize(
    "token,expected",
    [
        ("a", (0x00, False)),
        ("z", (0x06, False)),
        ("0", (0x1D, False)),
        ("f1", (0x7A, True)),
        ("f12", (0x6F, True)),
        ("f20", (0x5A, True)),
        ("insert", None),  # Mac keyboards have no Insert key
        ("f21", None),  # there is no F21 to F24
        ("nonsense", None),
    ],
)
def test_key_code_table(token: str, expected: object) -> None:
    assert mac_key_code(token) == expected


@pytest.mark.parametrize("text", ["Ctrl+Insert", "Ctrl+F21", "Ctrl+Foo", "", "Ctrl+"])
def test_unknown_tokens_are_refused_on_mac(on_mac: None, text: str) -> None:
    with pytest.raises(AppError) as error:
        parse(text)
    assert error.value.code == "invalid_shortcut"
    assert error.value.message == USE_HINT_MAC


@pytest.mark.parametrize("text", ["Space", "A", "Shift+A", "Shift+Space"])
def test_bare_non_f_keys_need_command_control_or_option(on_mac: None, text: str) -> None:
    with pytest.raises(AppError) as error:
        validate(text, None)
    assert error.value.code == "invalid_shortcut"
    assert error.value.message == BARE_KEY_MAC == "Add Command, Control or Option, or use an F-key."
    assert BARE_KEY_MAC != BARE_KEY


def test_command_control_and_option_are_enough_on_mac(on_mac: None) -> None:
    for text in ("Cmd+K", "Command+K", "Control+K", "Option+K"):
        assert validate(text, None)[0].ctrl_or_alt is True


def test_windows_messages_are_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    with pytest.raises(AppError) as error:
        validate("Space", None)
    assert error.value.message == BARE_KEY
    with pytest.raises(AppError) as error:
        parse("Ctrl+F25")  # there is no F25 on either platform
    assert error.value.message == USE_HINT
    assert parse("Ctrl+Insert").vk == 0x2D
    assert parse("CommandOrControl+Shift+F9").modifiers == MOD_CONTROL | MOD_SHIFT


def test_a_saved_accelerator_string_means_the_same_thing_on_both_platforms(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    text = "CommandOrControl+Shift+Space"
    monkeypatch.setattr(sys, "platform", "win32")
    windows = parse(text)
    monkeypatch.setattr(sys, "platform", "darwin")
    mac = parse(text)
    assert (windows.modifiers, windows.vk) == (MOD_CONTROL | MOD_SHIFT, 0x20)
    assert (mac.modifiers, mac.vk) == (MOD_WIN | MOD_SHIFT, 0x31)
