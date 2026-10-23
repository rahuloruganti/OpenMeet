"""Where the bundled web UI, the migrations and the Python build's own data live."""

import os
import sys
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent


def _bundle_root() -> Path:
    # PyInstaller one-file builds unpack data files under sys._MEIPASS.
    return Path(sys._MEIPASS) if getattr(sys, "frozen", False) else PACKAGE_DIR.parent


def web_dir() -> Path:
    # backend/web in a source checkout, written there by the Vite build.
    return _bundle_root() / "web"


def migrations_dir() -> Path:
    # Shipped next to the package: read in place, never copied or edited.
    if getattr(sys, "frozen", False):
        return _bundle_root() / "openmeet_py" / "migrations"
    return PACKAGE_DIR / "migrations"


def default_data_dir() -> Path:
    # This build's own folder, so it can never open or migrate another app's database.
    base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(base) / "OpenMeetPy"
