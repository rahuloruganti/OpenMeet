"""Where the bundled web UI, the migrations and the Python build's own data live."""

import os
import sys
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent


def _bundle_root() -> Path:
    # PyInstaller one-file builds unpack data files under sys._MEIPASS, and a PyInstaller 6 onedir
    # macOS app bundle points it at Contents/Frameworks.
    return Path(sys._MEIPASS) if getattr(sys, "frozen", False) else PACKAGE_DIR.parent


def _data_root() -> Path:
    """Where the --add-data files were written, which is not always the bundle root.

    In a PyInstaller 6 onedir macOS app bundle, sys._MEIPASS is Contents/Frameworks, which holds
    only binaries; data-only folders are written to Contents/Resources and cross-linked into
    Contents/Frameworks (PyInstaller/building/osx.py). Read the real folder when it exists.
    """
    root = _bundle_root()
    if not getattr(sys, "frozen", False):
        return root
    resources = root.parent / "Resources"
    if root.name == "Frameworks" and resources.is_dir():
        return resources
    return root


def web_dir() -> Path:
    # backend/web in a source checkout, written there by the Vite build.
    return _data_root() / "web"


def migrations_dir() -> Path:
    # Shipped next to the package: read in place, never copied or edited.
    if getattr(sys, "frozen", False):
        return _data_root() / "openmeet_py" / "migrations"
    return PACKAGE_DIR / "migrations"


def default_data_dir() -> Path:
    # This build's own folder, so it can never open or migrate another app's database.
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "OpenMeetPy"
    base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(base) / "OpenMeetPy"


def old_data_dir() -> Path:
    """The previous app's data folder, read-only. Every caller goes through this one helper.

    OPENMEET_OLD_DATA_DIR points it somewhere else: tests resolve it to a temp folder, so the real
    previous-app folder is never read, written or migrated by a test. macOS never had this app, so
    there the default is a sibling name that never exists and the first-run import shows nothing.
    """
    override = os.environ.get("OPENMEET_OLD_DATA_DIR")
    if override:
        return Path(override)
    if sys.platform == "darwin":
        return default_data_dir().parent / "OpenMeetPy-no-previous-app"
    base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(base) / "dev.openmeet.preview"
