"""Meeting detection on macOS: which other apps are capturing the microphone.

Core Audio keeps one process object per client process coreaudiod knows about (macOS 14.2+).
The system object lists them, and each one reports its pid, its bundle id and whether it holds an
active input stream. Only that metadata is read: no audio, screen or camera content, and no
permission prompt, because the question goes to the audio server rather than to the other process.

Ids and ownership rules, from `AudioHardware.h` in the macOS SDK (Xcode 15.1, the 14.2 SDK):

- `kAudioHardwarePropertyProcessObjectList = 'prs#'` on `kAudioObjectSystemObject` (1): an array of
  `AudioObjectID` for every process currently connected to the system.
- `kAudioProcessPropertyPID = 'ppid'`: the `pid_t` behind the object.
- `kAudioProcessPropertyBundleID = 'pbid'`: a `CFString` with the bundle id, empty for a bare
  binary. The header says "the caller is responsible for releasing the returned CFObject", so
  every string read here is released with `CFRelease`.
- `kAudioProcessPropertyIsRunningInput = 'piri'`: a `UInt32` that is 1 while at least one input
  stream is active.

Scopes follow the header's own examples: `kAudioObjectPropertyScopeGlobal` ('glob') and
`kAudioObjectPropertyElementMain` (0).

`entries()` runs on the detection poll thread; Core Audio property reads are valid off the main
thread.
"""

from __future__ import annotations

import ctypes
import os
import platform
import sys
import time
from typing import Any, Callable, Optional

from openmeet_py.platform.detection import ConsentEntry

CORE_AUDIO = "/System/Library/Frameworks/CoreAudio.framework/CoreAudio"
CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"

# The bundle id `packaging/build.sh` passes to `--osx-bundle-identifier`. Detection keys are bundle
# ids on macOS, so this is how the app recognises itself and never offers a prompt about itself.
OWN_BUNDLE_ID = "dev.openmeet.app"

MIN_MACOS = (14, 2)
NO_ERROR = 0
SYSTEM_OBJECT = 1  # kAudioObjectSystemObject
SCOPE_GLOBAL = 0x676C6F62  # 'glob', kAudioObjectPropertyScopeGlobal
ELEMENT_MAIN = 0  # kAudioObjectPropertyElementMain
SELECTOR_PROCESS_LIST = 0x70727323  # 'prs#'
SELECTOR_PID = 0x70706964  # 'ppid'
SELECTOR_BUNDLE_ID = 0x70626964  # 'pbid'
SELECTOR_RUNNING_INPUT = 0x70697269  # 'piri'
UTF8 = 0x08000100  # kCFStringEncodingUTF8
MAX_PROCESSES = 4096

# Components a bundle id carries that are plumbing rather than an app name.
NOT_A_NAME = frozenset({"helper", "xpc", "agent", "service", "renderer", "gpu", "plugin", "extension"})


class PropertyAddress(ctypes.Structure):
    """`AudioObjectPropertyAddress`: selector, scope, element."""

    _fields_ = [
        ("selector", ctypes.c_uint32),
        ("scope", ctypes.c_uint32),
        ("element", ctypes.c_uint32),
    ]


def _address(selector: int) -> PropertyAddress:
    return PropertyAddress(selector, SCOPE_GLOBAL, ELEMENT_MAIN)


def _macos_version() -> tuple[int, int]:
    parts = platform.mac_ver()[0].split(".")[:2]
    numbers = [int(part) if part.isdigit() else 0 for part in parts]
    while len(numbers) < 2:
        numbers.append(0)
    return numbers[0], numbers[1]


def supported() -> bool:
    """True on macOS 14.2 or newer, the first release with Core Audio process objects."""
    if sys.platform != "darwin":
        return False
    return _macos_version() >= MIN_MACOS


def display_name(bundle_id: str) -> str:
    """`us.zoom.xos` is Zoom, `com.apple.Safari` is Safari, `com.google.Chrome.helper` is Chrome.

    Core Audio gives a bundle id, not a name. Resolving the real name would mean NSWorkspace on the
    poll thread, so the id's own components are used instead, skipping the ones that only describe
    plumbing (a helper suffix, a short code like `xos`, a version number).
    """
    parts = [part for part in bundle_id.split(".") if part]
    while len(parts) > 1 and parts[-1].lower() in NOT_A_NAME:
        parts.pop()
    if not parts:
        return bundle_id
    name = parts[-1]
    if len(parts) > 1 and (len(name) <= 3 or name.isdigit()):
        name = parts[-2]
    return name[:1].upper() + name[1:]


class MacConsentRegistry:
    """Which processes hold the microphone, read from Core Audio process objects.

    Only ever called on the poll thread, on macOS 14.2+. `lib` and `read_string` are the seam for
    tests: they stand in for CoreAudio.framework and for the Core Foundation string reader, so no
    test loads a framework.

    Reads that fail for a single process are not fatal, because processes come and go between the
    list and the read. A process with no readable bundle id is skipped: there is no stable key to
    offer or to ignore. A process whose input state cannot be read counts as in use, so a one-poll
    read error never looks like the user hung up and never ends an automatic capture.
    """

    def __init__(self, lib: Any = None, read_string: Optional[Callable[[Any], Optional[str]]] = None):
        self._lib = lib
        self._read_string = read_string
        self._foundation: Any = None

    def entries(self) -> list[ConsentEntry]:
        if sys.platform != "darwin":
            return []
        lib = self._library()
        read_string = self._strings()
        now = int(time.time())
        own_pid = os.getpid()
        found: list[ConsentEntry] = []
        for process in self._process_objects(lib):
            pid = self._uint32(lib, process, SELECTOR_PID)
            if pid is None or pid == own_pid:
                continue
            name = self._bundle_id(lib, read_string, process)
            if not name:
                continue
            running_input = self._uint32(lib, process, SELECTOR_RUNNING_INPUT)
            found.append(ConsentEntry(name, now, 0) if running_input != 0 else ConsentEntry(name, 0, 0))
        return found

    def _library(self) -> Any:
        if self._lib is None:
            self._lib = ctypes.CDLL(CORE_AUDIO)
        return self._lib

    def _strings(self) -> Callable[[Any], Optional[str]]:
        if self._read_string is None:
            if self._foundation is None:
                self._foundation = ctypes.CDLL(CORE_FOUNDATION)
            self._read_string = _core_foundation_reader(self._foundation)
        return self._read_string

    def _process_objects(self, lib: Any) -> list[int]:
        """The system object's process object list. A failure here is real, so it is raised, not hidden."""
        address = _address(SELECTOR_PROCESS_LIST)
        size = ctypes.c_uint32(0)
        status = lib.AudioObjectGetPropertyDataSize(
            SYSTEM_OBJECT, ctypes.byref(address), 0, None, ctypes.byref(size)
        )
        if status != NO_ERROR:
            raise RuntimeError(f"Core Audio could not list audio processes (error {status}).")
        count = min(size.value // ctypes.sizeof(ctypes.c_uint32), MAX_PROCESSES)
        if count == 0:
            return []
        objects = (ctypes.c_uint32 * count)()
        size = ctypes.c_uint32(count * ctypes.sizeof(ctypes.c_uint32))
        status = lib.AudioObjectGetPropertyData(
            SYSTEM_OBJECT, ctypes.byref(address), 0, None, ctypes.byref(size), objects
        )
        if status != NO_ERROR:
            raise RuntimeError(f"Core Audio could not read audio processes (error {status}).")
        width = ctypes.sizeof(ctypes.c_uint32)
        return [int(objects[index]) for index in range(min(count, size.value // width))]

    def _uint32(self, lib: Any, process: int, selector: int) -> Optional[int]:
        address = _address(selector)
        size = ctypes.c_uint32(ctypes.sizeof(ctypes.c_uint32))
        value = ctypes.c_uint32(0)
        status = lib.AudioObjectGetPropertyData(
            process, ctypes.byref(address), 0, None, ctypes.byref(size), ctypes.byref(value)
        )
        if status != NO_ERROR or size.value != ctypes.sizeof(ctypes.c_uint32):
            return None
        return int(value.value)

    def _bundle_id(self, lib: Any, read_string: Callable[[Any], Optional[str]], process: int) -> Optional[str]:
        address = _address(SELECTOR_BUNDLE_ID)
        size = ctypes.c_uint32(ctypes.sizeof(ctypes.c_void_p))
        reference = ctypes.c_void_p()
        status = lib.AudioObjectGetPropertyData(
            process, ctypes.byref(address), 0, None, ctypes.byref(size), ctypes.byref(reference)
        )
        if status != NO_ERROR or not reference.value:
            return None
        return read_string(reference) or None


def _core_foundation_reader(foundation: Any) -> Callable[[Any], Optional[str]]:
    """Turns the CFString Core Audio hands back into text, then releases it as the header requires."""

    def read(reference: Any) -> Optional[str]:
        length = foundation.CFStringGetLength(reference)
        capacity = foundation.CFStringGetMaximumSizeForEncoding(length, UTF8) + 1
        buffer = ctypes.create_string_buffer(capacity)
        try:
            if not foundation.CFStringGetCString(reference, buffer, capacity, UTF8):
                return None
            return buffer.value.decode("utf-8", "replace")
        finally:
            foundation.CFRelease(reference)

    return read
