#!/usr/bin/env python3
"""Build packaging/openmeet.icns from packaging/openmeet-icon.svg.

Pipeline: rasterise the SVG at 1024 px, then pack it into an .icns with Pillow's
ICNS writer. Pillow does the packing only; it cannot read SVG, so a separate
renderer draws the picture.

Two renderers exist because build machines differ:

- "chromium": headless Chromium screenshot, the default. No extra Python
  dependency, and it paints the SVG exactly as the app's UI would.
- "resvg": the optional `resvg_py` module (uv run --with resvg-py). For machines
  with no Chromium, or where the installed one cannot start headless (a locked
  down Windows host, for example).

`--renderer auto` (the default) tries Chromium, then resvg, and always prints
which one drew the icon, so a renderer never takes over silently.

Usage:
    python packaging/macos/make-icns.py
    python packaging/macos/make-icns.py --chrome "/Applications/Chromium.app/Contents/MacOS/Chromium"
    uv run --with pillow --with resvg-py python packaging/macos/make-icns.py --renderer resvg
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PACKAGING_DIR = Path(__file__).resolve().parents[1]
SVG_PATH = PACKAGING_DIR / "openmeet-icon.svg"
ICNS_PATH = PACKAGING_DIR / "openmeet.icns"

RENDER_SIZE = 1024
CHROME_TIMEOUT_SECONDS = 180

# Sizes Pillow downscales itself for a 1024 px source. Rendering them from the
# large PNG with Lanczos keeps the ring and its dashes crisper than Pillow's
# default resample.
PRE_SCALED_SIZES = (128, 256, 512)

# Entry points tried in order. OPENMEET_CHROME and --chrome win over all of them.
CHROME_CANDIDATES = (
    # Tool copy used on the Windows build machine.
    "C:/Users/Rahul/AppData/Local/hermes/tools/chromium-1208/chrome-win64/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
)

PAGE = """<!doctype html>
<meta charset="utf-8">
<title>OpenMeet icon render</title>
<style>
  html, body {{ margin: 0; padding: 0; background: transparent; overflow: hidden; }}
  img {{ display: block; width: {size}px; height: {size}px; }}
</style>
<img src="{svg}" alt="">
"""


class RenderError(Exception):
    """A renderer could not produce the PNG."""


def chrome_candidates(explicit: str | None) -> list[Path]:
    """Return the Chromium binaries to try, in priority order."""
    if explicit and not Path(explicit).is_file():
        raise RenderError(f"--chrome path does not exist: {explicit}")
    ordered = [explicit, os.environ.get("OPENMEET_CHROME"), *CHROME_CANDIDATES]
    found: list[Path] = []
    for candidate in ordered:
        if not candidate:
            continue
        path = Path(candidate)
        if path.is_file() and path not in found:
            found.append(path)
    return found


def render_with_chromium(chrome: Path, svg: Path, png: Path, workdir: Path) -> None:
    """Screenshot the SVG at RENDER_SIZE square through headless Chromium."""
    page = workdir / "icon.html"
    page.write_text(PAGE.format(size=RENDER_SIZE, svg=svg.name), encoding="utf-8")
    # Chromium resolves the relative <img> path next to the page, so keep the
    # SVG in the same directory rather than encoding it into a data: URL.
    local_svg = workdir / svg.name
    if not local_svg.exists():
        shutil.copyfile(svg, local_svg)

    command = [
        str(chrome),
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-background-networking",
        "--disable-extensions",
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--default-background-color=00000000",
        f"--window-size={RENDER_SIZE},{RENDER_SIZE}",
        f"--user-data-dir={workdir / 'profile'}",
        f"--screenshot={png}",
        page.as_uri(),
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=CHROME_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise RenderError(
            f"{chrome.name} did not finish in {CHROME_TIMEOUT_SECONDS}s"
        ) from None
    if not png.is_file():
        lines = (result.stderr or result.stdout or "").strip().splitlines()
        reason = lines[-1] if lines else f"exit code {result.returncode}"
        raise RenderError(f"{chrome.name} wrote no screenshot: {reason}")


def render_with_resvg(svg: Path, png: Path) -> None:
    """Rasterise the SVG with resvg (optional module, no browser needed)."""
    try:
        import resvg_py
    except ImportError:
        raise RenderError(
            "resvg-py is not installed (run with --with resvg-py)"
        ) from None
    try:
        png.write_bytes(
            resvg_py.svg_to_bytes(
                svg_path=str(svg), width=RENDER_SIZE, height=RENDER_SIZE
            )
        )
    except ValueError as error:
        raise RenderError(f"resvg could not render {svg.name}: {error}") from None


def render(svg: Path, png: Path, renderer: str, chrome: str | None) -> str:
    """Render the PNG, returning the name of the renderer that succeeded."""
    order = ["chromium", "resvg"] if renderer == "auto" else [renderer]
    problems: list[str] = []

    for name in order:
        try:
            if name == "chromium":
                candidates = chrome_candidates(chrome)
                if not candidates:
                    raise RenderError(
                        "no Chromium found (pass --chrome or set OPENMEET_CHROME)"
                    )
                render_with_chromium(candidates[0], svg, png, png.parent)
            else:
                render_with_resvg(svg, png)
        except RenderError as error:
            png.unlink(missing_ok=True)
            problems.append(f"{name}: {error}")
            print(f"make-icns: {name} unavailable, {error}", file=sys.stderr)
            continue
        return name

    raise SystemExit("make-icns: no renderer produced a PNG. " + " | ".join(problems))


def write_icns(png: Path, icns: Path) -> list[int]:
    """Pack the render into an .icns and return the pixel sizes written."""
    from PIL import Image

    with Image.open(png) as source:
        if source.size != (RENDER_SIZE, RENDER_SIZE):
            raise SystemExit(
                f"make-icns: render is {source.size[0]}x{source.size[1]}, "
                f"expected {RENDER_SIZE}x{RENDER_SIZE}"
            )
        image = source.convert("RGBA")
    smaller = [
        image.resize((size, size), Image.Resampling.LANCZOS)
        for size in PRE_SCALED_SIZES
    ]
    icns.parent.mkdir(parents=True, exist_ok=True)
    image.save(icns, format="ICNS", append_images=smaller)
    return describe_icns(icns)


def describe_icns(icns: Path) -> list[int]:
    """Read the .icns back and report the pixel sizes it actually contains."""
    from PIL import Image

    with Image.open(icns) as packed:
        # Pillow reports (width, height, scale) for every representation.
        pixels = {width * scale for width, _height, scale in packed.info["sizes"]}
    return sorted(pixels)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Render packaging/openmeet-icon.svg to packaging/openmeet.icns."
    )
    parser.add_argument("--svg", default=str(SVG_PATH), help="source SVG")
    parser.add_argument("--out", default=str(ICNS_PATH), help="output .icns")
    parser.add_argument(
        "--renderer",
        choices=("auto", "chromium", "resvg"),
        default="auto",
        help="SVG rasteriser (default: try chromium, then resvg)",
    )
    parser.add_argument("--chrome", default=None, help="Chromium binary to use")
    parser.add_argument(
        "--png", default=None, help="also keep the 1024 px render at this path"
    )
    args = parser.parse_args(argv)

    svg = Path(args.svg)
    if not svg.is_file():
        raise SystemExit(f"make-icns: missing {svg}")
    icns = Path(args.out)

    with tempfile.TemporaryDirectory(prefix="openmeet-icns-") as temp:
        workdir = Path(temp)
        png = workdir / "icon-1024.png"
        used = render(svg, png, args.renderer, args.chrome)
        if args.png:
            kept = Path(args.png)
            kept.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(png, kept)
        sizes = write_icns(png, icns)

    print(f"renderer: {used}")
    print(f"wrote {icns} ({icns.stat().st_size / 1024:.1f} KiB)")
    print("representations: " + ", ".join(f"{size}px" for size in sizes))
    return 0


if __name__ == "__main__":
    sys.exit(main())
