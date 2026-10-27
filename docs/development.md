# Develop OpenMeet

## Set up and run

Install the tools listed in the [README](../README.md#install). From the repository root:

```sh
just setup
just dev
```

`setup` installs the pinned Python environment with `uv` (Python 3.13, `backend/uv.lock`) and the JavaScript dependencies with the pinned pnpm version. It does not download speech models. `dev` builds the UI into the backend, starts the FastAPI server on a free loopback port, and opens the `pywebview` window. Keep the terminal open.

`just ui` starts only the Vite dev server on `127.0.0.1:1420`; no backend is attached and there is no mock layer, so the page shows the not-connected notice and every command fails. It does not prove persistence, capture, shortcuts or permissions. Stop the earlier process before starting another on port 1420.

## Find the relevant code

Use the layout table in [AGENTS.md](../AGENTS.md). The frontend follows Feature-Sliced Design: `app` > `pages` > `widgets` > `features` > `entities` > `shared`, imports only downward, and each slice exposes a public `index.ts`. ESLint's `no-restricted-imports` rule enforces the boundary.

The backend is `backend/openmeet_py/`: `api/` (HTTP surface and `commands.py` registry), `domain/` (meetings, notes, transcripts, summaries, settings, processing, provider HTTP, chat calls and export), `audio/`, `speech/` (engines, cloud STT, model library, safe archive, live transcript decoding in `live/`, streaming models in `streaming_models.py`), `platform/` (Windows and macOS integration), `infra/` (SQLite store and migrations, plus the read-only importer), plus `app.py`, `paths.py` and `migrations/`. Command arguments must agree between `src/shared/api/api.ts`, `api/commands.py` and the payload types the handlers return; `backend/tests/test_commands.py` catches a command the UI invokes but the backend does not serve.

Follow [AGENTS.md](../AGENTS.md) when using coding agents, especially its recording, data-preservation and repository rules.

## Run checks

```sh
just check
```

The recipe runs, in order:

| Check                                            | Command                             |
| ------------------------------------------------ | ----------------------------------- |
| TypeScript                                       | `corepack pnpm typecheck`           |
| Frontend lint (includes the FSD import boundary) | `corepack pnpm lint`                |
| Frontend formatting                              | `corepack pnpm format:check`        |
| Frontend behavior tests                          | `corepack pnpm test`                |
| Frontend production build                        | `corepack pnpm build`               |
| Backend tests                                    | `uv run --directory backend pytest` |

Format frontend changes with `corepack pnpm format`. The formatting scripts exclude Markdown, so pass documents explicitly: `corepack pnpm exec prettier --check README.md docs/README.md`, and `--write` to fix them. `just --fmt --check` checks the justfile.

Compilation and mocked tests do not establish hardware capture or live provider quality.

## Test at the right boundary

| Area      | Existing coverage                                                                                                | What it does not establish                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| React     | Vitest, jsdom, Testing Library, mocked transport commands and events.                                            | WebView2 or WKWebView behavior, permissions, playback devices.                                   |
| Notes     | Debounced writes, stale revision refusal, save failure, draft retention, export and close ordering.              | Survival of text never saved before power loss.                                                  |
| Storage   | Populated-database upgrades, foreign keys, FTS5 updates, source labels, deletion bounds.                         | Secure erasure, live backup consistency, every filesystem failure.                               |
| Audio     | Synthetic samples, pause generations, WAV writing and repair, capture internals with `OPENMEET_PY_FAKE_AUDIO=1`. | Audible real-device content, pause privacy on real callbacks, sleep/wake, driver failure, drift. |
| Speech    | Fake engines via `OPENMEET_PY_FAKE_STT=1`: argument building, output parsing, timing, cancellation.              | whisper.cpp or sherpa-onnx accuracy and performance on real models.                              |
| Providers | `httpx` mock transports: discovery, custom IDs, redirects, errors, text and audio plans, atomic publication.     | Live billing, quality, availability, provider retention, credential store fault behavior.        |

The fake switches exist for tests only. Never enable them in a build you hand to someone, and never present their output as real capture or a real transcript.

Routine tests use synthetic audio and fictional text. Do not start a recording, open audio devices, or send meeting content to a provider during normal verification.

`just hardware` runs the opt-in real-hardware tests. Run it only with explicit authorization and only when real devices are the point; missing devices block the test rather than passing it. Hardware qualification also needs audible distinct tracks, absence of paused content, failure recovery, and a 60-minute run with measured relative drift below 100 ms.

## Build the executable

```sh
just build
```

The recipe runs `packaging/build.ps1`, which builds the UI into `backend/web`, bundles it and the SQL migrations, and runs PyInstaller in one-file windowed mode. The result is `packaging/dist/OpenMeet.exe`: one unsigned file, no installer, no signing, no updater. Close a running `OpenMeet.exe` before rebuilding.

The app icon is `packaging/openmeet.ico` (16 to 256 px). Its source is `packaging/openmeet-icon.svg`, the open-ring mark on the dark tile; if you change the SVG, re-render the ICO at the same sizes. The sidebar mark is `src/shared/ui/brand-mark.tsx`.

`just smoke` runs `OpenMeet.exe --smoke`, which starts the server, checks `/health` and one command, prints `OK` and exits. It proves the bundle starts; it does not prove capture or transcription.

### Build the Mac app

On an Apple silicon Mac with macOS 14.2 or newer, `just build` runs `packaging/build.sh` instead, which needs Xcode command line tools, `uv`, Node.js 24 with Corepack and Git. It reuses the same steps as the Windows script, then differs where macOS does:

- PyInstaller runs `--windowed --onedir`, because a one-file bundle is a poor Mac app, and produces `OpenMeet.app` with bundle id `dev.openmeet.app`.
- The two permission sentences, `LSMinimumSystemVersion` 14.2 and the high-resolution and category keys are written into `Contents/Info.plist`.
- The bundle is ad-hoc signed (`codesign --sign -`) with `packaging/macos/entitlements.plist`, which grants audio input and disables library validation because ad-hoc signing carries no team identifier. There is no notarization, and the signature changes on every rebuild, so a rebuilt app can need the permissions granted again.
- `hdiutil` wraps `packaging/dist/OpenMeet-<version>-arm64.dmg` around the app; the version comes from `backend/pyproject.toml`.
- The smoke step runs the built app with `--smoke` in a temporary data folder, and the build fails if PyInstaller could not collect `pydantic`'s submodules.

The script refuses a non-Mac and an Intel Mac, and it prints the DMG's path, size and SHA-256. `just smoke` repeats the check against an existing bundle. Building the Mac app is untested here: the script was reviewed on a Windows PC, not run on a Mac. See [macOS](macos.md).

## Protect data during development

Source runs and the built executable use the same data folder, `%APPDATA%\OpenMeetPy\` on Windows and `~/Library/Application Support/OpenMeetPy` on a Mac. Tests and ad-hoc runs should pass `--data-dir` to a scratch folder instead. Do not delete a database to resolve a development error, and do not point a development build at a folder you have not backed up.

Before a backup, wait for **Saved** and close the app normally. Copy the whole data folder, including `meetings.db-wal` and `meetings.db-shm` if present, plus exported snapshots separately. Keep original partial recordings when investigating recovery.

## Make a contribution

1. Inspect affected callers, command bindings, tests, fixtures, settings and exports.
2. Make the smallest complete change. Preserve note errors, source distinctions, recording-consent wording and the privacy disclosures in docs/privacy.md.
3. Add a small behavior test for nontrivial logic. Use synthetic samples instead of devices and fake engines instead of real models.
4. Add the next numbered migration for schema changes (append-only; next is `033`). Test an upgrade with populated notes and relationships.
5. Run `just check`, plus `just smoke` for packaging changes.
6. Update the affected guides, status, dependency inventory and work log.

Keep both lockfiles tracked. Do not commit build output (`packaging/dist/`, `backend/web/`), `node_modules`, `.venv`, databases, recordings, credentials or environment files. `.gitattributes` enforces LF line endings. Preserve unrelated changes, and commit or push only as the repository rules allow.

## CI

`.github/workflows/ci.yml` runs on `windows-latest`: pnpm install, typecheck, lint, format check, tests and the UI build, then `uv sync --project backend --locked` and `uv run --project backend pytest`. There is no installer workflow and no signing, publishing or release automation. This describes the workflow file, not a result this documentation observed; report remote CI status only from a run you actually saw.
