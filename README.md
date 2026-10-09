# OpenMeet

A local-first meeting notetaker under development. **This is the Phase 1A foundation preview, not a working meeting recorder.**

## What exists

- Tauri 2 / React desktop shell; Rust owns SQLite, settings, recording state, exports, tray, and shortcuts.
- Clearly labeled simulation with start, pause/resume, stop, and interrupted-session recovery.
- Fictional sample meeting, transcript, and hand-written summary.
- Persistent Markdown notes with debounced, serialized saves and optimistic revision checks.
- Save-before-switch, save-before-export, and save-before-quit behavior. Failed saves keep edits on screen.
- Native export-folder picker, configurable pause shortcut, single-instance protection.
- Markdown snapshot export: never overwrites an existing differing file.
- Frontend tests, Rust regression tests, lockfiles, and Windows/Apple Silicon CI configuration.

**Not implemented:** real audio capture, VAD, Whisper, model downloads, Ollama/OpenAI, summary templates, processing jobs, or installers. The Phase 1A native-build gate has not passed. See [implementation status](docs/implementation-status.md) and [the phase-wise plan](docs/phase-1-implementation-plan.md).

## Development

Prerequisites:

- Node 24 and Corepack (`npm install -g corepack` if unavailable). `package.json` pins pnpm.
- Rust via rustup; `rust-toolchain.toml` pins the toolchain and components.
- Windows: Visual Studio Build Tools with **Desktop development with C++**, MSVC x64 tools, Windows SDK, and WebView2. Use a Developer PowerShell if the compiler is not discovered.
- macOS: Apple Silicon, Xcode command-line tools (`xcode-select --install`). Actual minimum capture OS is still undecided.
- CMake/Clang are needed for future native ML work, not this foundation.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm tauri dev
```

`corepack pnpm dev` opens a frontend-only browser preview. It intentionally disables desktop actions instead of using fake browser persistence.

### Checks

```sh
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
corepack pnpm test
corepack pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Build frontend assets before standalone Cargo checks: Tauri embeds `dist/` outside dev mode.

### Try the native preview

1. Load the fictional sample; edit its notes; wait for **saved**.
2. Restart and check that the notes persist.
3. Choose an export folder in Settings and export Markdown.
4. Edit that file externally, change a note in the app, and export again. The external file must remain untouched; a new snapshot is created.
5. Acknowledge the simulation reminder, start a simulation, and pause/resume using the UI, tray, and shortcut. No microphone or system audio is opened.
6. Close the window or use **Save notes and quit…** in the tray; confirm save and quit. If saving fails, copy your edits and keep the app open.

## Data and privacy

The database lives in Tauri's OS app-data directory for `dev.openmeet.preview`:

- Windows: `%APPDATA%/dev.openmeet.preview/meetings.db`
- macOS: `~/Library/Application Support/dev.openmeet.preview/meetings.db`

SQLite uses WAL and foreign keys. Exported snapshots live under `<chosen folder>/Meetings/`. No production network client, telemetry, audio recording, or model downloads exist in this preview. Development dependency installation and Vite's local development server are separate from production runtime behavior.

Files are **not encrypted**. OS backups and cloud-synced export folders may copy them off-device. Use only synthetic/non-sensitive data until native validation passes. See [privacy](docs/privacy.md) and [consent](docs/consent.md).

## License

MIT. See [LICENSE](LICENSE) and [third-party inventory](THIRD_PARTY_LICENSES.md).
