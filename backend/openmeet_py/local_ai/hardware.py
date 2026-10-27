"""What this PC can run: GPU name and vendor, memory for the GPU and system RAM.

Nothing here loads a driver SDK. On Windows the GPU comes from `nvidia-smi`, which ships with the
NVIDIA driver, and from the display adapters Windows already reports; RAM comes from
GlobalMemoryStatusEx. On Apple silicon the chip name and the memory size come from `sysctl` and the
free memory from `vm_stat`, because memory is unified and there is no separate VRAM to read. Every
probe is injectable (`nvidia_smi`, `adapters`, `memory`, `sysctl`, `vm_stat`), so tests never start
a process or read the real machine.

The engine build follows the vendor: CUDA for NVIDIA, Vulkan for AMD and Intel, Metal on Apple
silicon, CPU otherwise. A display adapter with no recognised vendor is not guessed: this PC then
reports no GPU, so a model is only ever offered for system RAM.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from typing import Any, Callable, Optional

MIB = 1024 * 1024
BACKENDS = ("cuda", "vulkan", "metal", "cpu")
NVIDIA_QUERY = ("nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits")
NVIDIA_TIMEOUT = 10.0
MAX_ADAPTERS = 16
SYSCTL_TIMEOUT = 5.0
# Apple silicon has one memory pool shared by the CPU and the GPU. llama.cpp can use most of it, but
# the app, the window and the rest of macOS need room, so the GPU is offered a fixed share of RAM.
UNIFIED_VRAM_SHARE = 0.65
APPLE_GPU = "Apple GPU"
# "Pages free: 1234." lines in vm_stat; the app can use free, inactive and speculative pages.
_VM_PAGES = re.compile(r"^(Pages free|Pages inactive|Pages speculative):\s+(\d+)\.", re.MULTILINE)
_VM_PAGE_SIZE = re.compile(r"page size of (\d+) bytes")
# Display adapters Windows reports for software rendering; they never mean a usable GPU.
_GENERIC_ADAPTERS = ("microsoft basic display", "remote display", "virtual display", "generic")

NVIDIA_WORDS = ("nvidia", "geforce", "quadro", "tesla", "rtx", "gtx")
AMD_WORDS = ("amd", "radeon", "ati ")
INTEL_WORDS = ("intel", "arc ", "iris", "uhd graphics", "hd graphics")


def vendor_of(name: str) -> Optional[str]:
    """The vendor a display adapter name names, or None when it is not one of the known three."""
    lowered = name.lower()
    if any(word in lowered for word in NVIDIA_WORDS):
        return "nvidia"
    if any(word in lowered for word in AMD_WORDS):
        return "amd"
    if any(word in lowered for word in INTEL_WORDS):
        return "intel"
    return None


def backend_for(vendor: Optional[str]) -> str:
    """The llama.cpp build for a vendor. CUDA for NVIDIA, Vulkan for AMD and Intel, else CPU."""
    if vendor == "nvidia":
        return "cuda"
    if vendor in ("amd", "intel"):
        return "vulkan"
    return "cpu"


def _mib(value: str) -> Optional[int]:
    try:
        amount = int(float(value.strip()))
    except ValueError:
        return None
    return amount * MIB if amount > 0 else None


def parse_nvidia_smi(output: str) -> Optional[tuple[str, Optional[int]]]:
    """Name and VRAM of the largest GPU in `nvidia-smi` CSV output; None when there is no GPU."""
    best: Optional[tuple[str, Optional[int]]] = None
    for line in output.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 2 or not parts[0]:
            continue
        name, vram = parts[0], _mib(parts[1])
        if best is None or (vram or 0) > (best[1] or 0):
            best = (name, vram)
    return best


def _run_nvidia_smi() -> str:
    """Runs nvidia-smi. Any failure (no driver, no card, timeout) means no NVIDIA GPU is readable."""
    try:
        done = subprocess.run(
            list(NVIDIA_QUERY),
            capture_output=True,
            text=True,
            timeout=NVIDIA_TIMEOUT,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return done.stdout if done.returncode == 0 else ""


def _display_adapters() -> list[str]:
    """Adapter names Windows reports as active. Empty when the call is unavailable or fails."""
    if sys.platform != "win32":
        return []
    try:
        import ctypes

        class DisplayDevice(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong),
                ("DeviceName", ctypes.c_wchar * 32),
                ("DeviceString", ctypes.c_wchar * 128),
                ("StateFlags", ctypes.c_ulong),
                ("DeviceID", ctypes.c_wchar * 128),
                ("DeviceKey", ctypes.c_wchar * 128),
            ]

        user32 = ctypes.windll.user32
        names: list[str] = []
        for index in range(MAX_ADAPTERS):
            device = DisplayDevice()
            device.cb = ctypes.sizeof(device)
            if not user32.EnumDisplayDevicesW(None, index, ctypes.byref(device), 0):
                break
            name = str(device.DeviceString).strip()
            if device.StateFlags & 0x1 and name:
                names.append(name)
        return names
    except Exception:  # a probe that cannot run must never fail the settings page
        return []


def _memory_status() -> tuple[int, int]:
    """Total and available physical RAM in bytes, from GlobalMemoryStatusEx."""
    if sys.platform != "win32":
        return (0, 0)
    import ctypes

    class MemoryStatusEx(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong),
            ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    status = MemoryStatusEx()
    status.dwLength = ctypes.sizeof(status)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        return (0, 0)
    return (int(status.ullTotalPhys), int(status.ullAvailPhys))


def _sysctl(name: str) -> str:
    """One `sysctl -n` value. An unreadable key is an empty string, never an exception."""
    try:
        done = subprocess.run(
            ("sysctl", "-n", name),
            capture_output=True,
            text=True,
            timeout=SYSCTL_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return done.stdout.strip() if done.returncode == 0 else ""


def _vm_stat() -> str:
    """The `vm_stat` report. An unreadable report is empty, so free memory reads as unknown."""
    try:
        done = subprocess.run(
            ("vm_stat",),
            capture_output=True,
            text=True,
            timeout=SYSCTL_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return done.stdout if done.returncode == 0 else ""


def parse_vm_stat(report: str, page_size: int) -> int:
    """Free, inactive and speculative pages of a `vm_stat` report, in bytes.

    Pages that are inactive or speculative are still reclaimable, which is why they count as
    available; wired, active and compressed memory does not.
    """
    pages = sum(int(count) for _name, count in _VM_PAGES.findall(report))
    return pages * page_size


def vm_page_size(report: str) -> int:
    """The page size `vm_stat` prints in its header, else the kernel's own page size."""
    found = _VM_PAGE_SIZE.search(report)
    if found is not None:
        return int(found.group(1))
    sysconf = getattr(os, "sysconf", None)  # POSIX only, so it is looked up, not called blindly
    if sysconf is None:
        return 0
    try:
        return int(sysconf("SC_PAGE_SIZE"))
    except (OSError, ValueError):
        return 0


def _pick_adapter(names: list[str]) -> Optional[str]:
    """The first named adapter with a known vendor, else the first one that is not software-only."""
    named = [name for name in names if name.strip()]
    for name in named:
        if vendor_of(name) is not None:
            return name
    for name in named:
        if not any(generic in name.lower() for generic in _GENERIC_ADAPTERS):
            return name
    return None


def _detect_apple(
    sysctl: Callable[[str], str], vm_stat: Callable[[], str]
) -> dict[str, Any]:
    """Apple silicon: the chip, the unified memory pool and the free part of it."""
    try:
        total = int(sysctl("hw.memsize").strip())
    except ValueError:
        total = 0
    report = vm_stat()
    chip = sysctl("machdep.cpu.brand_string").strip()
    return {
        "gpu_name": chip or APPLE_GPU,
        "gpu_vendor": "apple",
        # Metal takes the GPU's memory from the same pool as the CPU, so a share of total RAM is
        # what a model can actually use. There is no separate VRAM figure to report.
        "vram_bytes": int(total * UNIFIED_VRAM_SHARE) if total > 0 else None,
        "ram_bytes": total,
        "ram_available_bytes": parse_vm_stat(report, vm_page_size(report)),
        "backend": "metal",
    }


def detect(
    *,
    nvidia_smi: Optional[Callable[[], str]] = None,
    adapters: Optional[Callable[[], list[str]]] = None,
    memory: Optional[Callable[[], tuple[int, int]]] = None,
    sysctl: Optional[Callable[[str], str]] = None,
    vm_stat: Optional[Callable[[], str]] = None,
) -> dict[str, Any]:
    """This PC's GPU, memory for it and RAM, in the shape the Settings page reads."""
    if sys.platform == "darwin":
        return _detect_apple(sysctl or _sysctl, vm_stat or _vm_stat)
    nvidia = parse_nvidia_smi((nvidia_smi or _run_nvidia_smi)())
    if nvidia is not None:
        name, vram = nvidia
    else:
        name = _pick_adapter((adapters or _display_adapters)())
        vram = None
    vendor = vendor_of(name) if name else None
    total, available = (memory or _memory_status)()
    return {
        "gpu_name": name,
        "gpu_vendor": vendor,
        "vram_bytes": vram,
        "ram_bytes": int(total),
        "ram_available_bytes": int(available),
        "backend": backend_for(vendor),
    }
