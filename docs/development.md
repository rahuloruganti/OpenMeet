# Develop OpenMeet

## Set up and run

Follow the [README prerequisites](../README.md#install-and-run-on-windows). From the repository root, run:

```sh
just setup
just dev
```

`setup` installs the toolchain selected by `rust-toolchain.toml` and JavaScript dependencies from the lockfile. It does not install native system prerequisites or speech artifacts. `dev` starts Vite on `127.0.0.1:1420`, builds Rust, and launches the desktop app. Keep the terminal open.

Use `corepack pnpm dev` only for frontend preview. Native actions are disabled there; it is not a persistence, recording, or permission check. Stop an earlier frontend process before starting another on port 1420.

Prefer a permanent rustup installation. Temporary Rust locations recorded in historical test logs are not project configuration and may disappear.

## Find the relevant code

Use the [architecture code map](architecture.md#code-ownership). React owns presentation and command orchestration. Rust owns audio, storage, HTTP, model files, credentials, and native controls. Command payloads must agree between `src/lib/api.ts`, Rust handlers, and `domain.rs`.

Follow [AGENTS.md](../AGENTS.md) when using coding agents, especially its recording, data-preservation, and repository rules. Consult [implementation status](implementation-status.md) for current capabilities; older plans contain superseded designs.

## Run checks

```sh
just check
```

The recipe runs, in order:

| Check                     | Command                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| TypeScript                | `corepack pnpm typecheck`                                                                 |
| Frontend lint             | `corepack pnpm lint`                                                                      |
| Frontend formatting       | `corepack pnpm format:check`                                                              |
| Frontend behavior tests   | `corepack pnpm test`                                                                      |
| Frontend production build | `corepack pnpm build`                                                                     |
| Rust formatting           | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`                               |
| Rust lint                 | `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` |
| Rust tests                | `cargo test --locked --manifest-path src-tauri/Cargo.toml`                                |
| Native debug build        | `cargo build --locked --manifest-path src-tauri/Cargo.toml`                               |

Build the frontend before standalone Cargo checks. Outside development mode, Tauri embeds `dist/`. Neither compilation nor mocked tests establish hardware capture or real provider quality.

Format frontend changes with `corepack pnpm format` and Rust changes with `cargo fmt --manifest-path src-tauri/Cargo.toml`. The package's formatting scripts exclude Markdown. Pass changed documents explicitly, for example `corepack pnpm exec prettier --check README.md docs/dependencies.md`. Use `--write` instead of `--check` to format them. `just --fmt --check` checks the justfile.

## Test at the right boundary

| Area          | Existing coverage                                                                                                                  | What it does not establish                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| React         | Vitest, jsdom, Testing Library, mocked Tauri commands/events.                                                                      | Native permissions, clipboard, playback devices, or webview behavior.                              |
| Notes         | Debounced writes, stale revision refusal, save failure, draft retention, export and close ordering.                                | Survival of text never saved before power loss.                                                    |
| Storage       | Populated-database upgrades, foreign keys, FTS5 updates, source labels, and deletion bounds.                                       | Secure erasure, live backup consistency, or every filesystem failure.                              |
| Audio         | Synthetic samples, pause generations, WAV writing/repair, and capture internals.                                                   | Audible real-device content, sleep/wake, driver failures, or long-run drift.                       |
| Transcription | Artifact validation, output parsing, timing, arguments, progress, and cancellation with fake engines.                              | Real-engine accuracy or performance across models and languages.                                   |
| Providers     | Synthetic HTTP responses, discovery/custom IDs, redirects, errors, text/audio plans, timing, cancellation, and atomic publication. | Live billing, model quality, availability, provider retention, and native keychain fault behavior. |

Routine tests use synthetic audio and fictional text. Do not start a recording or submit meeting content to a provider as part of normal verification.

The ignored `audio::tests::windows_devices_open_and_stop_writes_both_wavs` test opens actual devices. Run it only after explicit authorization for that test:

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml audio::tests::windows_devices_open_and_stop_writes_both_wavs -- --ignored --exact --nocapture
```

Do not run all ignored tests. Missing devices block the test; they do not count as a pass. Hardware qualification also needs audible distinct tracks, absence of paused content, failure recovery, and a 60-minute run with measured relative drift below 100 ms. See [open work](implementation-status.md#open-work).

The separate ignored Windows keychain test creates and removes only a unique synthetic credential. It does not read configured keys or contact a provider. It exercises the actual credential store, so keep it separate from the routine suite:

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml providers::tests::windows_keychain_round_trip_uses_only_new_synthetic_credentials -- --ignored --exact --nocapture
```

Current executed results and remaining gates are recorded in [Phase 1 foundation verification](phase-1-foundation-verification.md).

## Check dependency hygiene

```sh
corepack pnpm audit --prod --audit-level high
cargo deny --manifest-path src-tauri/Cargo.toml check advisories licenses sources
```

Install cargo-deny separately if needed. [deny.toml](../deny.toml) defines allowed licenses, sources, and target platforms. Update [dependencies](dependencies.md) and [third-party licenses](../THIRD_PARTY_LICENSES.md) when a package or downloaded artifact changes. Passing these checks is not a complete release audit.

## Build a release executable

```sh
just build
```

The recipe runs `corepack pnpm tauri build --no-bundle -- --locked`. Tauri builds the frontend and enables its production asset protocol. A plain `cargo build --release` leaves that protocol disabled and tries to load the development server instead. On Windows the result is `src-tauri/target/release/openmeet.exe`. Close a running release executable before rebuilding it.

The executable embeds the frontend and does not require Vite. WebView2 remains a Windows runtime prerequisite. Local speech artifacts and independent provider credentials are configured in the app. Bundling is disabled in `tauri.conf.json`: this command produces no installer, signing, notarization, or updater.

## Protect data during development

Development and release builds currently share the `dev.openmeet.preview` app identifier and app-data location. Tests normally use temporary storage, but manually launched builds can open existing meetings. Do not delete a database to resolve a development error.

Before a backup, wait for **Saved** and close the app normally. Copy the complete app-data directory, including audio and any SQLite sidecar files, and back up exported snapshots separately. Keep original partial recordings when investigating recovery. Do not replace a live app-data directory.

## Make a contribution

1. Inspect affected callers, command bindings, tests, fixtures, settings, and exports.
2. Make the smallest complete change. Preserve note errors, source distinctions, capture consent, and per-send cloud consent.
3. Add a small behavior test for nontrivial logic. Use synthetic samples instead of devices.
4. Add numbered migrations for schema changes. Test an upgrade with populated notes and relationships.
5. Run the relevant checks, including the full recipe for changes across the frontend and backend.
6. Update the affected guides, status, dependency inventory, and work log.

Keep both lockfiles tracked. Do not commit build output, `node_modules`, databases, recordings, credentials, or environment files. `.gitattributes` enforces LF line endings. Preserve unrelated changes, and commit or push only when requested.

## CI

[ci.yml](../.github/workflows/ci.yml) configures Windows and macOS 15 frontend and Rust checks, production npm audit, and a Linux cargo-deny job. The macOS job requires an ARM64 runner. This describes workflow configuration, not the latest remote result. Local checks do not establish green remote CI or macOS capture support.
