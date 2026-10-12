[windows]
set shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# List available commands.
default:
    @just --list

# Install the pinned Rust toolchain and JavaScript dependencies.
setup:
    rustup toolchain install
    corepack pnpm install --frozen-lockfile

# Open the native desktop app with live frontend updates.
dev:
    corepack pnpm tauri dev

# Run frontend and Rust checks, without recording audio.
check:
    corepack pnpm typecheck
    corepack pnpm lint
    corepack pnpm format:check
    corepack pnpm test
    corepack pnpm build
    cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
    cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
    cargo test --locked --manifest-path src-tauri/Cargo.toml
    cargo build --locked --manifest-path src-tauri/Cargo.toml

# Build a release executable with the frontend embedded (no installer).
build:
    corepack pnpm build
    cargo build --release --locked --manifest-path src-tauri/Cargo.toml
