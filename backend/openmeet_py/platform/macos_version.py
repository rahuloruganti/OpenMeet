"""The running macOS version, and the one release gate the Core Audio features share."""

import platform
import sys
from typing import Optional

# Core Audio process objects (detection) and process taps (system audio) both arrive in 14.2.
MIN_PROCESS_AUDIO = (14, 2)


def macos_version() -> Optional[tuple[int, int]]:
    """Major and minor of the running macOS, or None when it cannot be read."""
    parts = platform.mac_ver()[0].split(".")
    try:
        return int(parts[0]), int(parts[1])
    except (IndexError, ValueError):
        return None


def process_audio_supported() -> bool:
    """True on macOS 14.2 or newer. An unreadable version counts as unsupported."""
    if sys.platform != "darwin":
        return False
    version = macos_version()
    return version is not None and version >= MIN_PROCESS_AUDIO
