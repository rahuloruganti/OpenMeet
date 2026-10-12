# OpenMeet

A local-first meeting notetaker under development. **This is a Windows capture preview, not a qualified meeting recorder or complete MVP.**

## What exists

- Tauri 2 / React desktop shell; Rust owns SQLite, settings, recording state, exports, tray, and shortcuts.
- Windows microphone + system-output capture code with separate local WAVs and timing indexes; real-device qualification has not passed (the last hardware attempt found no microphone). While recording, per-track level meters warn when the microphone stays silent.
- Clearly labeled simulation with start, pause/resume, stop, and interrupted-session marking.
- **Recover audio** for interrupted recordings: writes a repaired copy of each unfinished WAV next to the original and never modifies the original. Tested on synthetic truncated files only.
- Local transcription (Windows x64): an explicit download of a pinned whisper.cpp build, the Whisper "small" model, and the Silero VAD model, verified by SHA-256, transcribes finalized tracks on this computer. Audio is never uploaded. Accuracy has only been spot-checked.
- Merge Gateway summaries: the API key is imported from `OPENMEET_LLM_API_KEY` into the OS keychain by the backend. **Enhance notes** sends notes and transcript text (never audio) only after a per-send confirmation. Tested against mock servers; no live summary has been verified.
- Fictional sample meeting, transcript, and hand-written summary.
- Persistent Markdown notes with debounced, serialized saves and optimistic revision checks. Meetings can be renamed.
- Save-before-switch, save-before-export, and save-before-quit behavior. Stop does not wait for saving; failed saves keep edits on screen.
- Native export-folder picker, configurable pause shortcut, single-instance protection.
- Markdown snapshot export: never overwrites an existing differing file. Settings choose whether the summary and transcript are included, and whether filenames start with the date.
- Frontend tests, Rust regression tests, lockfiles, and Windows/Apple Silicon CI configuration.

**Not implemented:** macOS capture and transcription, summary templates, long-meeting summaries (very long meetings are refused), transcription progress/cancel, processing job queue, or installers. Windows native checks and the previous macOS CI shell/build job passed; cross-platform capture and interactive qualification have not. See [implementation status](docs/implementation-status.md) and [the phase-wise plan](docs/phase-1-implementation-plan.md).

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
5. Start a simulation and pause/resume using the UI, tray, and shortcut. Simulation opens no microphone or system audio. Real Windows recording is separate, requires consent and both devices, and must use explicitly authorized synthetic signals for qualification.
6. Close the window or use **Save notes and quit…** in the tray; confirm save and quit. If saving fails, copy your edits and keep the app open.

## Data and privacy

The database lives in Tauri's OS app-data directory for `dev.openmeet.preview`:

- Windows: `%APPDATA%/dev.openmeet.preview/meetings.db`
- macOS: `~/Library/Application Support/dev.openmeet.preview/meetings.db`

SQLite uses WAL and foreign keys. Windows recordings write separate mic/system WAVs and timing JSONL under the app-data `audio/<meeting ID>/` directory. Partial files are retained after failures; there is no automatic cleanup. Exported snapshots live under `<chosen folder>/Meetings/`. The application makes network requests only on explicit actions: downloading the speech engine and models (github.com, huggingface.co), connecting to Merge to list models (sends only the API key), and a confirmed **Enhance notes** (sends that meeting's notes and transcript text to Merge). There is no telemetry, automatic upload, or audio upload. Development dependency installation and Vite's local development server are separate from production runtime behavior.

Files are **not encrypted**. OS backups and cloud-synced export folders may copy them off-device. Use only synthetic/non-sensitive data until native validation passes. See [privacy](docs/privacy.md) and [consent](docs/consent.md).

## License

MIT. See [LICENSE](LICENSE) and [third-party inventory](THIRD_PARTY_LICENSES.md).
