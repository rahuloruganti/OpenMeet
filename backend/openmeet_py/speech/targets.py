"""Supported targets for the local speech engines, without engine dependencies."""

import platform
import sys


def local_speech_supported() -> bool:
    """Whether this machine is one of the two targets the local engines ship binaries for.

    Windows x64 and Apple silicon macOS only: the whisper.cpp and sherpa-onnx wheels exist for those
    and nothing else, so an Intel Mac reports unsupported instead of failing inside a native library
    after the download. Other speech modules import this one function.
    """
    machine = platform.machine().lower()
    if sys.platform == "win32":
        return machine in ("amd64", "x86_64")
    return sys.platform == "darwin" and machine == "arm64"
