# OpenMeet agent guide

## Project and current scope

OpenMeet is a local-first desktop meeting notetaker built with Tauri 2, Rust, React, TypeScript, and Vite.

- Phase 1A foundation exists: SQLite persistence, notes, settings, simulation, tray controls, shortcuts, and safe Markdown snapshots.
- Phase 1B Windows capture code exists: microphone plus system-output capture through cpal, separate WAV files, timing indexes, and pause/resume controls.
- Actual two-track recording has **not passed its hardware gate**. The last local hardware attempt found no microphone endpoint; device enumeration is not proof of capture.
- macOS capture, VAD, resampling for STT, Whisper, model downloads, LLM summaries, and remaining MVP validation are unfinished.
- Simulation and fictional fixtures are not real recordings or generated summaries. Preserve that distinction in the UI, database, exports, and reports.

Read `docs/phase-1-implementation-plan.md` and `docs/implementation-status.md` before substantial work. Consult the original development-plan document for broader requirements. Documentation may lag implementation: verify claims against code and executed tests.

## Code map

| Path | Responsibility |
| --- | --- |
| `src/App.tsx` | Meeting UI, notes, recording controls, settings |
| `src/lib/api.ts` | Typed Tauri commands and event payloads |
| `src/lib/note-writer.ts` | Serialized, debounced note saves |
| `src-tauri/src/lib.rs` | Tauri commands, events, tray, shortcuts, lifecycle |
| `src-tauri/src/domain.rs` | Shared backend types and errors |
| `src-tauri/src/storage.rs` | SQLite, recording lifecycle, capture integration |
| `src-tauri/src/audio.rs` | Device discovery, native capture, bounded queues, WAV writers |
| `src-tauri/src/export.rs` | Markdown rendering and non-overwriting snapshot export |
| `src-tauri/migrations/` | Ordered database migrations |
| `fixtures/` | Fictional test data; never real meeting content |
| `.github/workflows/ci.yml` | Windows/macOS build checks and dependency hygiene |
| `log.md` | User prompt history and brief context |

## Development environment

- Use Node 24 and the pnpm version pinned in `package.json` through Corepack.
- Use the Rust version/components pinned in `rust-toolchain.toml`.
- Windows needs Visual Studio C++ Build Tools, Windows SDK, and WebView2.
- macOS native builds need Apple Silicon and Xcode command-line tools; a successful shell build does not establish capture support.
- Earlier Windows checks used a temporary Rust installation under `%TEMP%/openmeet-rustup` and `%TEMP%/openmeet-cargo`. Do not assume those paths still exist or hard-code them into project configuration. Prefer a permanent rustup installation.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm tauri dev
```

`corepack pnpm dev` is a frontend-only browser preview. It cannot validate native persistence, capture, shortcuts, or permissions.

## Required checks

Run the checks relevant to the change. For a cross-layer change, run the full set:

```sh
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
corepack pnpm test
corepack pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo build --locked --manifest-path src-tauri/Cargo.toml
```

Build frontend assets before standalone Cargo checks; Tauri embeds `dist/` outside development mode. To format changes, use `corepack pnpm format` and `cargo fmt --manifest-path src-tauri/Cargo.toml`.

The ignored `windows_devices_open_and_stop_writes_both_wavs` test accesses real audio devices. Do not run it or start any recording without explicit user authorization. Run only that named test when authorized, not every ignored test indiscriminately. Missing devices are a blocked test, not a pass. Two valid files alone do not establish audible content, pause privacy, or clock accuracy.

Capture qualification still requires real-machine checks: distinct tracks, audible signals, excluded paused audio, device loss/switch, sleep/wake, and a 60-minute run with measured drift below 100 ms. Do not fabricate those results or infer macOS results from Windows.

## Implementation rules

1. Make the smallest complete change. Reuse existing code and dependencies before introducing another abstraction, package, or configuration option.
2. Trace affected callers, tests, fixtures, command bindings, settings, and exports before editing. Keep Rust serialization and TypeScript payloads consistent, including nested field names and nullability.
3. Rust owns audio, storage, native integration, and processing. React issues commands and renders state; do not move native work or secrets into the webview.
4. Keep callbacks allocation-light and nonblocking. No filesystem writes, inference, locks that can block, or unbounded queues in audio callbacks.
5. Keep the backend authoritative for recording state. Preserve revision ordering and use events as notifications; handle errors even when an operation partially changes state.
6. Never silently change the selected device or sample format, fall back to one-track capture, or substitute fixture output for failed capture. Fail visibly and preserve recoverable data.
7. Add a small regression test for nontrivial behavior. Use synthetic samples for routine audio tests; native-device tests must be explicit and separate.
8. Do not widen scope to detection, bots, SharePoint, diarization, or speculative integrations before their planned phase. Record unmet gates rather than marking a phase complete.

## Data, consent, and privacy

- Require consent acknowledgement before real recording. Keep active, paused, failed, and simulated states visibly distinct.
- Paused audio must not be persisted or transcribed. Test queued and in-flight callbacks and resume boundaries, not only the UI label.
- Preserve user notes and external Markdown edits. Save failures must not silently discard text or allow an unsafe close.
- Use additive, versioned migrations; test upgrades with existing notes and foreign-key relationships. Do not reset a user's database to fix development errors.
- Keep snapshot exports non-overwriting until a tested merge implementation replaces them. Protect filenames, destination paths, and concurrent publication.
- Never delete existing audio, notes, or database files without explicit authorization. Keep partial artifacts recognizable and distinguish incomplete files from successful captures.
- The user initially selected local-only LLM use, then explicitly requested an API-backed model and a Granola-style UI, and selected Merge Gateway (`merge.dev`). The model remains unconfirmed. Merge's documented OpenAI-compatible base URL is `https://api-gateway.merge.dev/v1/openai`; no gateway integration or connection test exists yet. Local Ollama model selection was removed as unused; cloud content submission still needs explicit per-action consent, backend-only credentials, and OS keychain storage. The key is imported from the `OPENMEET_LLM_API_KEY` environment variable (the backend no longer parses `.env`).
- Do not add telemetry, automatic uploads, or cloud processing by default. Future cloud providers require clear disclosure and explicit opt-in; keys belong in the OS keychain, never in SQLite, Markdown, logs, or frontend state.
- Do not log transcript content, private audio, credentials, or signed webhook URLs. Use fictional or properly licensed/consented fixtures.
- App data and exports are currently unencrypted. A cloud-synced export folder can move files off-device even without an app upload feature.

## Repository and handoff

- Preserve unrelated user changes. Never force-push, rewrite history, change repository visibility, or commit/push unless requested.
- Keep build output, `node_modules`, local databases/audio, credentials, and environment files out of commits. Keep both dependency lockfiles tracked.
- Track new dependency/model licenses in `THIRD_PARTY_LICENSES.md`; do not treat the initial inventory as a completed release audit.
- Update affected documentation when behavior changes, especially consent/privacy wording and simulation-only claims. Append significant user requests and brief outcomes to `log.md` without secrets or invented timestamps.
- Installed Ponytail skills live under `.pi/skills/ponytail-bundle/`; their installation details are in `INSTALLATION.md` there. Skills are not an always-on executable extension.
- End each handoff with what changed, checks actually run, and important unverified behavior or blockers. Never describe a successful compile or mocked test as a successful hardware recording.
