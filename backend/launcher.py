"""Entry script for the PyInstaller build. A windowed exe has no console, so give logging real streams."""
import os
import sys

if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

from openmeet_py.app import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
