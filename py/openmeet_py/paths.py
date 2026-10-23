"""Where the bundled web UI, the migrations and the Python build's own data live."""

import os
import sys
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
REPO_ROOT = PACKAGE_DIR.parent.parent


def _bundle_root() -> Path:
    # PyInstaller one-file builds unpack data files under sys._MEIPASS.
    return Path(sys._MEIPASS) if getattr(sys, "frozen", False) else PACKAGE_DIR.parent


def web_dir() -> Path:
    return _bundle_root() / "web"


def migrations_dir() -> Path:
    # The Rust app's migration files are the schema. Read them in place, never copied or edited.
    if getattr(sys, "frozen", False):
        return _bundle_root() / "migrations"
    return REPO_ROOT / "src-tauri" / "migrations"


def default_data_dir() -> Path:
    # Separate from the Rust app's folder, so this build can never open or migrate its database.
    base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(base) / "OpenMeetPy"
