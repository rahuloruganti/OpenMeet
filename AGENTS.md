# OpenMeet agent guide

## What this is

OpenMeet is a local-first Windows meeting notetaker: one PyInstaller executable that runs a Python 3.13 backend (`FastAPI` + `uvicorn`), a `pywebview` window on WebView2, and a React 19 + TypeScript + Vite UI. Windows 11 only. Version 0.9.0. The retired implementation is kept at git tag `rust-final` for history; do not restore or port from it.

- One active capture: microphone plus system audio, written locally as separate tracks.
- Local transcription (whisper.cpp and sherpa-onnx) is the default; cloud STT and AI summaries are optional user-configured connections.
- Real-hardware qualification is **not** done. Audio capture, local transcription, global shortcuts, meeting detection and the Windows credential store are exercised only with fakes and stubs. Every `unqualified` label in the docs is current. See `docs/phase-7-hardware-qualification.md`.
- Simulation and fictional fixtures are not recordings or generated summaries. Preserve that distinction in the UI, database, exports and reports.

Read `docs/architecture.md` and `docs/development.md` before substantial work. Verify claims against code and executed checks; documentation can lag implementation.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/app/` | App shell: providers, layout, page routing, global styles. |
| `src/pages/meeting/`, `pages/settings/`, `pages/setup/` | One page per route: meeting workspace, settings, first-run setup. |
| `src/widgets/` | Composite UI blocks (`meeting-sidebar`, `meeting-workspace`, `settings-panel`, `setup-panel`, `recording-controls`, `library-question`, `first-run-setup`). |
| `src/features/` | User actions with their own state (`note-writer`, `transcription-settings`, `provider-settings`, `recipes`, `rewrite-selection`, `action-items`, `meeting-tags`, `model-library`, `speaker-names`, `summary-templates`, `transcript-versions`). |
| `src/entities/` | Domain models and their read/update logic (`meeting`, `processing`). |
| `src/shared/` | Framework-free code: `api/` (command bindings, `transport.ts`), `lib/` (Markdown, timestamps), `ui/` (small shared components), `test/`. |
| `backend/openmeet_py/app.py` | Desktop entry point: free loopback port, server thread, `pywebview` window, `--smoke`, `--import-from`. |
| `backend/openmeet_py/api/` | HTTP/WebSocket surface and the command registry (`commands.py`), recording command handlers, reads. |
| `backend/openmeet_py/domain/` | Summaries, questions, tasks, export, transcript edits, processing runs, provider connections and LLM calls. |
| `backend/openmeet_py/audio/` | WASAPI capture backend, WAV writing and repair, timing indexes, recorder lifecycle. |
| `backend/openmeet_py/speech/` | Local engines (whisper.cpp, sherpa-onnx), model catalogues and library, downloads, safe archive install, cloud STT, transcription pipeline. |
| `backend/openmeet_py/platform/` | Windows integration: global shortcuts, keyring credentials, meeting detection, Win32 helpers. |
| `backend/openmeet_py/infra/` | SQLite store and migrations runner, and the one-time importer for an old data folder. |
| `backend/openmeet_py/paths.py` | Data folder (`%APPDATA%\OpenMeetPy`) and bundled UI paths. |
| `backend/openmeet_py/migrations/` | Append-only numbered SQL migrations. |
| `backend/tests/` | pytest suite; fakes instead of devices and engines. |
| `packaging/build.ps1` | Builds the UI into `backend/web` and produces `packaging/dist/OpenMeet.exe`. |
| `.preview/` | Untracked browser harness on port 1430 with fictional data. |
| `docs/` | Current documentation; `docs/archive/` holds retired records and is not a source of truth. |

## Run and check

```sh
just setup     # uv sync + pnpm install
just dev       # build UI, then run the Python app window
just ui        # Vite only on 127.0.0.1:1420, no backend
just check     # pnpm typecheck, lint, format:check, test, build; then uv run --project backend pytest
just build     # packaging/dist/OpenMeet.exe
just smoke     # OpenMeet.exe --smoke
```

- `just check` is the required gate for any change. `just ui` starts Vite with no backend attached (the page shows the not-connected notice); it proves only that the bundle loads.
- `just hardware` runs opt-in real-hardware tests. Do not run it, and do not start a recording or open audio devices, without explicit user authorization. Missing devices are a blocked test, not a pass.
- `corepack pnpm exec prettier --write <file>` formats a document; `pnpm format` covers code only. `just --fmt --check` checks the justfile.

## Frontend rules

- Feature-Sliced Design: layers are `app` > `pages` > `widgets` > `features` > `entities` > `shared`. An import may only point down that list; nothing may import upward. ESLint enforces this through `no-restricted-imports` — do not weaken the rule to land an import, move the code.
- Each slice exposes a public `index.ts`; never import another slice's internal file.
- Every backend call goes through `src/shared/api/api.ts` on top of `src/shared/api/transport.ts`. Components do not fetch, open sockets or know the RPC URL.
- Keep payload types in `api.ts` aligned with the Python handler arguments, including nested names and nullability.
- No secrets in the webview: keys are posted once and never read back into React state, storage or logs.

## Backend rules

1. Register every command the UI invokes in `backend/openmeet_py/api/commands.py`. The UI sends camelCase arguments; the dispatcher converts them to snake_case handler parameters. `backend/tests/test_commands.py` fails when the UI invokes a command the registry lacks — add the handler rather than faking it in the UI.
2. Make the smallest complete change. Reuse existing code and dependencies before adding another abstraction, package or configuration option.
3. Trace affected callers, tests, fixtures, command bindings, settings and exports before editing.
4. The backend is authoritative for recording state. Commands return authoritative state; events only notify. Preserve revision ordering and handle partially applied failures.
5. Keep SQLite, inference, HTTP and file writes off the event loop and out of audio callbacks. Callbacks enqueue samples; no blocking locks, allocations in a tight loop, or unbounded queues.
6. Never silently change the selected device or sample format, fall back to one-track capture, or substitute fake output for failed capture. Fail visibly and preserve recoverable data.
7. SQLite migrations are append-only: add the next number (currently `030`), never edit or renumber a shipped file, never reset a user's database. Test upgrades with populated notes and foreign keys.
8. Fake backends exist for tests only: `OPENMEET_PY_FAKE_AUDIO=1` and `OPENMEET_PY_FAKE_STT=1`. Never ship a path that enables them implicitly, and never present their output as real capture or a real transcript.
9. Add a small regression test for nontrivial behavior. Routine audio tests use synthetic samples; real-device tests are separate and opt-in.
10. Record unmet gates instead of marking a phase complete. Do not widen scope to bots, SharePoint, diarization, calendar or speculative integrations before their planned phase. Opt-in meeting detection may only offer a prompt that opens recording setup; it must never start capture, check consent or pick devices by itself.

## Data, consent and privacy

- No telemetry, no updater, and no cloud processing by default. Audio and transcripts stay on this PC unless the user assigns a cloud connection and triggers the action.
- Consent is the user's responsibility; the app does not check it and there is no consent checkbox. Keep active, paused, failed and simulated states visibly distinct.
- Paused audio must not be persisted or transcribed. Test queued and in-flight callbacks and the resume boundary, not only the UI label.
- Cloud destinations require a "Leaves this device" disclosure. There are no per-request confirmation cards; automatic processing is off (recording only) by default and runs only from the saved Settings default.
- API keys live only in Windows Credential Manager through `keyring`, under a per-connection account. Never write a key to SQLite, Markdown, logs, environment files, frontend state or a report. Read responses carry key status only. Changing a destination requires a new key.
- Keep hard request and byte limits. Never retry a billable request, fall back to another model automatically, or publish a result whose configuration changed mid-request.
- Preserve user notes and external Markdown edits. A failed save must not discard text or allow an unsafe close.
- Snapshot exports are non-overwriting until a tested merge replaces them; protect filenames, destinations and concurrent publication.
- Never delete existing audio, notes or database files without explicit authorization. Keep partial artifacts recognizable and distinct from successful captures. The importer (`--import-from`) is read-only on its source, refuses a non-empty destination and never copies API keys.
- Do not log transcript content, private audio, credentials or signed URLs. Use fictional or properly licensed fixtures; never record real meetings in tests or paste meeting content into a report.
- App data and exports are unencrypted. A cloud-synced export folder can move files off-device without any upload by the app.

## Honesty about qualification

- Phase 7 (`docs/phase-7-hardware-qualification.md`) is open. A passing pytest run, a `--smoke` run, a browser preview or a fake-device run does **not** qualify audio capture, pause privacy, drift, transcription accuracy, shortcuts, detection or credential storage.
- Never describe a successful build or a mocked test as verified hardware behavior. Do not invent measurements, device results or provider quality.
- Keep `unqualified` labels unless a recorded PASS entry exists in Phase 7.

## Repository and handoff

- Preserve unrelated user changes. Never force-push, rewrite history or change repository visibility.
- Commit work directly to `main` and push it when the user asks. Do not create feature branches, pull requests or GitHub issues unless the user asks.
- Keep build output (`packaging/dist/`, `backend/web/`, `dist/`), `node_modules`, `.venv`, local databases and audio, credentials and environment files out of commits.
- Keep both lockfiles tracked: `pnpm-lock.yaml` and `backend/uv.lock`.
- Track new dependency and model licenses in `THIRD_PARTY_LICENSES.md`; the inventory is not a completed release audit.
- Update affected documentation when behavior changes, especially privacy wording and qualification claims. Append significant requests and brief outcomes to `log.md` without secrets or invented timestamps.
- End each handoff with what changed, which checks actually ran, and what remains unverified or blocked.
