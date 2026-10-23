"""Guards: no test outside the opt-in real-model file can load the speech library or a model."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

TESTS = Path(__file__).resolve().parent
# conftest.py holds the import block that keeps the library out; this file names it in its checks.
ALLOWED = {"conftest.py", "test_guards.py", "test_real_whisper.py", "test_real_sherpa.py"}
SHERPA_IMPORT = re.compile(r"(^|\n)\s*(import|from)\s+sherpa_onnx")
PATTERN = re.compile(r"(^|\n)\s*(import|from)\s+pywhispercpp|pywhispercpp\.model\b.*Model\(|\bModel\(\s*['\"]")


def test_no_other_test_imports_pywhispercpp_or_constructs_a_model() -> None:
    offenders = []
    for path in sorted(TESTS.glob("*.py")):
        if path.name in ALLOWED:
            continue
        text = path.read_text(encoding="utf-8")
        if PATTERN.search(text) or SHERPA_IMPORT.search(text):
            offenders.append(path.name)
    assert offenders == []


def test_the_library_is_blocked_inside_ordinary_tests() -> None:
    with pytest.raises(ImportError):
        import pywhispercpp  # noqa: F401


def test_the_sherpa_library_is_blocked_inside_ordinary_tests() -> None:
    with pytest.raises(ImportError):
        import sherpa_onnx  # noqa: F401


def test_the_app_module_does_not_import_the_speech_libraries() -> None:
    import subprocess
    import sys

    code = (
        "import sys; sys.path.insert(0, %r); import openmeet_py.app, openmeet_py.api.commands; "
        "print('pywhispercpp' in sys.modules or 'sherpa_onnx' in sys.modules)"
    ) % str(TESTS.parent)
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120)
    assert result.stdout.strip() == "False", result.stderr
