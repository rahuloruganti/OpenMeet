# Develop OpenMeet

## Set up and run

Follow the [README prerequisites](../README.md#build-and-run-from-source). From the repository root:

```sh
just setup
just dev
```

`setup` installs the pinned Python environment with `uv` (Python 3.13, `backend/uv.lock`) and the JavaScript dependencies with the pinned pnpm version. It does not download speech models. `dev` builds the UI into the backend, starts the FastAPI server on a free loopback port, and opens the `pywebview` window. Keep the terminal open.

`just ui` starts only the Vite dev server on `127.0.0.1:1420`; no backend is attached and there is no mock layer, so the page shows the not-connected notice and every command fails. It does not prove persistence, capture, shortcuts or permissions. Stop the earlier process before starting another on port 1420.

`.preview/` is an untracked browser harness on port 1430 that serves fictional data and simulated recording; run it with `corepack pnpm exec vite --config .preview/vite.preview.config.ts`. Nothing in it touches a database, an audio device or the network.

## Find the relevant code

Use the layout table in [AGENTS.md](../AGENTS.md). The frontend follows Feature-Sliced Design: `app` > `pages` > `widgets` > `features` > `entities` > `shared`, imports only downward, and each slice exposes a public `index.ts`. ESLint's `no-restricted-imports` rule enforces the boundary.

The backend is `backend/openmeet_py/`: `api/` (HTTP surface and `commands.py` registry), `domain/` (meetings, notes, transcripts, summaries, settings, processing, provider HTTP, chat calls and export), `audio/`, `speech/` (engines, cloud STT, model library, safe archive, live transcript decoding in `live/`, streaming models in `streaming_models.py`), `platform/` (Windows integration), `infra/` (SQLite store and migrations, plus the read-only importer), plus `app.py`, `paths.py` and `migrations/`. Command arguments must agree between `src/shared/api/api.ts`, `api/commands.py` and the payload types the handlers return; `backend/tests/test_commands.py` catches a command the UI invokes but the backend does not serve.

Follow [AGENTS.md](../AGENTS.md) when using coding agents, especially its recording, data-preservation and repository rules.

## Run checks

```sh
just check
```

The recipe runs, in order:

| Check | Command |
| --- | --- |
| TypeScript | `corepack pnpm typecheck` |
| Frontend lint (includes the FSD import boundary) | `corepack pnpm lint` |
| Frontend formatting | `corepack pnpm format:check` |
| Frontend behavior tests | `corepack pnpm test` |
| Frontend production build | `corepack pnpm build` |
| Backend tests | `uv run --directory backend pytest` |

Format frontend changes with `corepack pnpm format`. The formatting scripts exclude Markdown, so pass documents explicitly: `corepack pnpm exec prettier --check README.md docs/README.md`, and `--write` to fix them. `just --fmt --check` checks the justfile.

Compilation and mocked tests do not establish hardware capture or live provider quality.

## Test at the right boundary

| Area | Existing coverage | What it does not establish |
| --- | --- | --- |
| React | Vitest, jsdom, Testing Library, mocked transport commands and events. | WebView2 behavior, permissions, playback devices. |
| Notes | Debounced writes, stale revision refusal, save failure, draft retention, export and close ordering. | Survival of text never saved before power loss. |
| Storage | Populated-database upgrades, foreign keys, FTS5 updates, source labels, deletion bounds. | Secure erasure, live backup consistency, every filesystem failure. |
| Audio | Synthetic samples, pause generations, WAV writing and repair, capture internals with `OPENMEET_PY_FAKE_AUDIO=1`. | Audible real-device content, pause privacy on real callbacks, sleep/wake, driver failure, drift. |
| Speech | Fake engines via `OPENMEET_PY_FAKE_STT=1`: argument building, output parsing, timing, cancellation. | whisper.cpp or sherpa-onnx accuracy and performance on real models. |
| Providers | `httpx` mock transports: discovery, custom IDs, redirects, errors, text and audio plans, atomic publication. | Live billing, quality, availability, provider retention, Credential Manager fault behavior. |

The fake switches exist for tests and the browser harness only. Never enable them in a build you hand to someone, and never present their output as real capture or a real transcript.

Routine tests use synthetic audio and fictional text. Do not start a recording, open audio devices, or send meeting content to a provider during normal verification.

`just hardware` runs the opt-in real-hardware tests. Run it only with explicit authorization and only when real devices are the point; missing devices block the test rather than passing it. Hardware qualification also needs audible distinct tracks, absence of paused content, failure recovery, and a 60-minute run with measured relative drift below 100 ms. See [Phase 7 hardware qualification](phase-7-hardware-qualification.md).

## Build the executable

```sh
just build
```

The recipe runs `packaging/build.ps1`, which builds the UI into `backend/web`, bundles it and the SQL migrations, and runs PyInstaller in one-file windowed mode. The result is `packaging/dist/OpenMeet.exe`: one unsigned file, no installer, no signing, no updater. Close a running `OpenMeet.exe` before rebuilding.

The app icon is `packaging/openmeet.ico` (16 to 256 px). Its source is `packaging/openmeet-icon.svg`, the open-ring mark on the dark tile; if you change the SVG, re-render the ICO at the same sizes. The sidebar mark is `src/shared/ui/brand-mark.tsx`.

`just smoke` runs `OpenMeet.exe --smoke`, which starts the server, checks `/health` and one command, prints `OK` and exits. It proves the bundle starts; it does not prove capture or transcription.

## Protect data during development

Source runs and the built executable use the same data folder, `%APPDATA%\OpenMeetPy\`. Tests and ad-hoc runs should pass `--data-dir` to a scratch folder instead. Do not delete a database to resolve a development error, and do not point a development build at a folder you have not backed up.

Before a backup, wait for **Saved** and close the app normally. Copy the whole data folder, including `meetings.db-wal` and `meetings.db-shm` if present, plus exported snapshots separately. Keep original partial recordings when investigating recovery.

## Make a contribution

1. Inspect affected callers, command bindings, tests, fixtures, settings and exports.
2. Make the smallest complete change. Preserve note errors, source distinctions, recording-consent wording and the "Leaves this device" disclosures.
3. Add a small behavior test for nontrivial logic. Use synthetic samples instead of devices and fake engines instead of real models.
4. Add the next numbered migration for schema changes (append-only; next is `033`). Test an upgrade with populated notes and relationships.
5. Run `just check`, plus `just smoke` for packaging changes.
6. Update the affected guides, status, dependency inventory and work log.

Keep both lockfiles tracked. Do not commit build output (`packaging/dist/`, `backend/web/`), `node_modules`, `.venv`, databases, recordings, credentials or environment files. `.gitattributes` enforces LF line endings. Preserve unrelated changes, and commit or push only as the repository rules allow.

## CI

`.github/workflows/ci.yml` runs on `windows-latest`: pnpm install, typecheck, lint, format check, tests and the UI build, then `uv sync --project backend --locked` and `uv run --project backend pytest`. There is no installer workflow and no signing, publishing or release automation. This describes the workflow file, not a result this documentation observed; report remote CI status only from a run you actually saw.
