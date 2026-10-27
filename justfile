[windows]
set shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# List available commands.
default:
    @just --list

# Install the locked Python environment and the JavaScript dependencies.
setup:
    uv sync --project backend --locked
    corepack pnpm install --frozen-lockfile

# Build the UI into backend/web, then run the desktop app from source.
dev:
    corepack pnpm exec vite build
    uv run --directory backend python -m openmeet_py.app

# UI-only work; nothing records, transcribes or stores anything without the backend.
# Vite dev server on 127.0.0.1:1420 with no backend attached: the page shows the not-connected notice; use it only to check that the UI bundle loads.
ui:
    corepack pnpm exec vite --port 1420

# `-c backend/pyproject.toml` pins pytest's rootdir to backend/ so the ini options and
# the `tests` testpath apply no matter which directory the recipe is invoked from.
# Frontend and backend checks, without recording audio.
check:
    corepack pnpm typecheck
    corepack pnpm lint
    corepack pnpm format:check
    corepack pnpm test
    corepack pnpm build
    uv run --project backend pytest -c backend/pyproject.toml

# Build the one-file Windows executable: packaging/dist/OpenMeet.exe.
build:
    powershell -ExecutionPolicy Bypass -File packaging/build.ps1

# Start the built exe, check /health and one command, then exit.
smoke:
    packaging/dist/OpenMeet.exe --smoke

# Opt-in real-audio run on real devices.
hardware:
    $env:OPENMEET_PY_HARDWARE_AUDIO = "1"; uv run --project backend pytest -c backend/pyproject.toml -m hardware
