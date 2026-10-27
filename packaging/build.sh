#!/usr/bin/env bash
# Builds the macOS app for Apple silicon: OpenMeet.app plus packaging/dist/OpenMeet-<version>-arm64.dmg.
# Steps: sync the uv environment, build the React UI into backend/web, bundle the UI and the SQL
# migrations into a PyInstaller --onedir --windowed app, write the Info.plist keys, ad-hoc sign,
# wrap a DMG around the app, then smoke the built app. No Xcode and no Apple Developer account.
# Usage (works from any cwd): bash packaging/build.sh
set -euo pipefail

packaging="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$packaging/.." && pwd)"
backend="$repo/backend"
web="$backend/web"
migrations="$backend/openmeet_py/migrations"
catalog="$backend/openmeet_py/local_ai/catalog.json"
launcher="$backend/launcher.py"
entitlements="$packaging/macos/entitlements.plist"
# App icon (Dock, Finder and the DMG). Rendered from openmeet-icon.svg by packaging/macos/make-icns.py.
icon="$packaging/openmeet.icns"
dist="$packaging/dist"
work="$packaging/build"
log="$work/pyinstaller.log"
bundle_id="dev.openmeet.app"

# This script builds the Mac app only. Nothing here runs on Windows.
if [ "$(uname -s)" != "Darwin" ]; then
    echo "packaging/build.sh builds the macOS app; run it on macOS." >&2
    exit 1
fi
if [ "$(uname -m)" != "arm64" ]; then
    echo "OpenMeet ships for Apple silicon only; this Mac is $(uname -m)." >&2
    exit 1
fi

# Version comes from the one place it is declared, so the DMG name cannot drift.
for required in "$launcher" "$migrations" "$catalog" "$icon" "$entitlements" "$backend/pyproject.toml" "$repo/package.json"; do
    if [ ! -e "$required" ]; then
        echo "Missing $required." >&2
        exit 1
    fi
done
plutil -lint "$entitlements" >/dev/null

version="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$backend/pyproject.toml" | head -n 1)"
if [ -z "$version" ]; then
    echo "Could not read the version from $backend/pyproject.toml." >&2
    exit 1
fi

cd "$repo"

echo "==> 1/7 Python environment, exactly as locked"
uv sync --project backend --locked

echo "==> 2/7 React UI into backend/web"
if [ ! -d "$repo/node_modules" ]; then
    corepack pnpm install --frozen-lockfile
fi
corepack pnpm exec vite build
if [ ! -f "$web/index.html" ]; then
    echo "vite build did not produce $web/index.html." >&2
    exit 1
fi

echo "==> 3/7 PyInstaller app bundle"
mkdir -p "$dist" "$work"
# A one-file bundle is a poor macOS GUI app: the window, the icon and the TCC prompts all want a
# real bundle directory, so this is --onedir --windowed, which PyInstaller wraps in OpenMeet.app.
# --add-data is "source:destination" here, not the Windows "source;destination".
# The hidden imports are the modules the code reaches only through a lazy import (each *_mac
# module and platform/macos.py is imported inside a sys.platform == "darwin" branch), plus
# keyring's macOS backend, which is chosen by name. PyInstaller cannot see any of them.
uv run --project backend pyinstaller --noconfirm --clean --onedir --windowed \
    --name OpenMeet \
    --icon "$icon" \
    --osx-bundle-identifier "$bundle_id" \
    --distpath "$dist" \
    --workpath "$work" \
    --specpath "$packaging" \
    --paths "$backend" \
    --add-data "$web:web" \
    --add-data "$migrations:openmeet_py/migrations" \
    --add-data "$catalog:openmeet_py/local_ai" \
    --collect-submodules openmeet_py \
    --collect-submodules uvicorn \
    --hidden-import uvicorn.logging \
    --hidden-import uvicorn.loops.auto \
    --hidden-import uvicorn.protocols.http.auto \
    --hidden-import uvicorn.protocols.websockets.auto \
    --hidden-import uvicorn.lifespan.on \
    --collect-all webview \
    --collect-all sounddevice \
    --collect-all catap \
    --collect-all websockets \
    --collect-all pywhispercpp \
    --collect-binaries pywhispercpp \
    --hidden-import pywhispercpp.model \
    --hidden-import pywhispercpp.constants \
    --hidden-import pywhispercpp.utils \
    --hidden-import _pywhispercpp \
    --collect-all sherpa_onnx \
    --collect-binaries sherpa_onnx \
    --hidden-import sherpa_onnx.lib._sherpa_onnx \
    --hidden-import openmeet_py.audio.audio_backend_mac \
    --hidden-import openmeet_py.audio.system_tap_mac \
    --hidden-import openmeet_py.platform.macos \
    --hidden-import openmeet_py.platform.detection_mac \
    --hidden-import keyring.backends.macOS \
    --collect-submodules keyring.backends \
    --hidden-import objc \
    --hidden-import AppKit \
    --hidden-import Foundation \
    --hidden-import PyObjCTools.AppHelper \
    "$launcher" 2>&1 | tee "$log"

# PyInstaller 6 leaves the bundle either at dist/OpenMeet.app or inside dist/OpenMeet/.
app="$dist/OpenMeet.app"
if [ ! -d "$app" ]; then
    app="$dist/OpenMeet/OpenMeet.app"
fi
if [ ! -d "$app" ]; then
    echo "PyInstaller did not produce an OpenMeet.app in $dist." >&2
    exit 1
fi
plist="$app/Contents/Info.plist"
if [ ! -f "$plist" ]; then
    echo "The app bundle has no Contents/Info.plist." >&2
    exit 1
fi

echo "==> 4/7 Info.plist keys"
# PlistBuddy fails on Add when the key already exists (PyInstaller writes a few of them), so delete first.
plist_set() {
    local key=$1 type=$2 value=$3
    /usr/libexec/PlistBuddy -c "Delete :$key" "$plist" >/dev/null 2>&1 || true
    /usr/libexec/PlistBuddy -c "Add :$key $type $value" "$plist" >/dev/null
}

# TCC names the app in its prompts with this string; it must exist or the microphone request is
# denied without a prompt.
plist_set NSMicrophoneUsageDescription string "OpenMeet records your microphone while you take meeting notes, and only then."
plist_set NSAudioCaptureUsageDescription string "OpenMeet records the audio your Mac plays so it is part of your meeting notes."
# Core Audio process taps (system audio) need macOS 14.2 or newer.
plist_set LSMinimumSystemVersion string "14.2"
plist_set NSHighResolutionCapable bool true
plist_set LSApplicationCategoryType string "public.app-category.productivity"

echo "==> 5/7 Ad-hoc signature"
# No Apple Developer account, so the signature is ad-hoc ("-") and there is no notarization.
# Two consequences worth knowing before shipping a build:
# - The signature identifies the bundle to TCC, and it changes with every rebuild, so a rebuilt
#   app can ask for Microphone and System Audio Recording permission again.
# - Gatekeeper still quarantines the download. Users right-click Open the first time, or run
#   xattr -dr com.apple.quarantine OpenMeet.app.
# --deep signs the bundled dylibs too; the entitlements cover the hardened runtime.
codesign --force --deep --sign - --entitlements "$entitlements" --options runtime "$app"
codesign --verify --deep --strict "$app"

echo "==> 6/7 DMG"
stage="$work/dmg"
rm -rf "$stage"
mkdir -p "$stage"
# ditto keeps the signature and the resource forks that cp would drop.
ditto "$app" "$stage/OpenMeet.app"
ln -s /Applications "$stage/Applications"
dmg="$dist/OpenMeet-$version-arm64.dmg"
hdiutil create -volname "OpenMeet $version" -srcfolder "$stage" -ov -format UDZO "$dmg" >/dev/null

echo "==> 7/7 Smoke test"
smoke_dir="$(mktemp -d)"
trap 'rm -rf "$smoke_dir"' EXIT
# A temp data folder, so the check never reads or writes ~/Library/Application Support/OpenMeetPy.
"$app/Contents/MacOS/OpenMeet" --smoke --data-dir "$smoke_dir"
# A submodule that PyInstaller could not walk means hidden imports are missing; the app will fail
# at some unrelated later point, so refuse the build instead.
if grep -q "Failed to collect submodules for 'pydantic'" "$log"; then
    echo "PyInstaller could not collect pydantic's submodules (see $log). Add the missing hidden imports." >&2
    exit 1
fi

echo ""
echo "Built  $dmg"
echo "Size   $(/usr/bin/stat -f%z "$dmg") bytes"
echo "SHA256 $(shasum -a 256 "$dmg" | cut -d' ' -f1)"
