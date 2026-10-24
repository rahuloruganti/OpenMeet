# OpenMeet rebuild: status

OpenMeet is a local-first meeting notetaker for Windows. The app is now **Python only**: a FastAPI
backend that owns storage, audio, speech and native Windows work, a React UI in a pywebview window,
and a single Windows exe built with PyInstaller. The Rust/Tauri application is gone.

Recording and transcription are **built and tested with fakes, not qualified**. Phase 7 (owner-run
hardware qualification) has not been run. Until it passes, nothing about audio reliability, transcript
accuracy or real-device behaviour is claimed.

## Purpose

- Record the microphone and the system output as two separate tracks, from one window.
- Keep everything local: notes, audio, transcripts and models live on the PC; a cloud AI or cloud
  speech provider is used only if the owner configures one.
- Let the owner write notes during the meeting and get a transcript and a summary afterwards.
- Never start capture without the owner pressing Start, and never switch or substitute a device.

## Repository layout

```
src/                 React UI (Feature-Sliced Design layers)
backend/             Python backend
  openmeet_py/       the application package
  tests/             pytest suite (fakes, stub servers, synthetic audio)
  tools/             verify_recording.py, make_test_audio.py (read-only helpers)
  pyproject.toml, uv.lock
packaging/           build.ps1 -> packaging/dist/OpenMeet.exe
docs/                current documentation; docs/archive/ holds retired records
justfile             setup, dev, ui, check, build, smoke, hardware
```

`backend/` was called `py` earlier; the package name inside it is still `openmeet_py`, and the data
folder is still `%APPDATA%\OpenMeetPy`.

## Architecture by package role

The backend is one package, `backend/openmeet_py/`, split into role subpackages — `api/`, `domain/`,
`audio/`, `speech/`, `platform/`, `infra/` — with `app.py`, `paths.py` and `migrations/` at the package
root. Modules are listed in "Module map" at the end.

- **`api/` — the surface the UI talks to.** A FastAPI app serves the UI's commands as
  `POST /api/invoke/{cmd}`, a `/ws` event socket, the `/files` route and `index.html`. The command
  registry converts camelCase arguments to snake_case, so handlers take snake_case parameters, and
  handlers raise a `{code, message}` error that the UI already understands. `/api/invoke`, `/ws`,
  `/files` and the index route require a per-launch token injected into `index.html`, and those routes
  plus the index also require `127.0.0.1` or `localhost` in the `Host` header, which blocks DNS
  rebinding. `/health` and the static files are open, and the index carries the token, so any process
  on this PC that can reach the loopback port can read the token; it is not a defense against other
  local processes of the same user. Read-only queries (settings, meeting detail with track rows,
  transcript lines, freshness hashes) are separated from the handlers so they can be tested without
  the command layer. The shared `Context` (store, event bus, recorder, injectable HTTP transport, one
  AI and one speech slot) lives here because every command feature imports it.
- **`domain/` — what a meeting is.** Meetings, notes with revisions and autosave, tags, search, action
  items, summaries with staleness, question threads, recipes, speaker names, transcript versions and
  edits, session processing, connections and provider assignments, chat and summarising, and Markdown
  export all live here. None of it touches a device or a window.
- **`audio/` — capture and files.** A capture backend interface with a real PortAudio implementation
  (PyAudioWPatch) and a fake one that synthesises tones or silence; a WAV writer and validator; the
  recorder state machine. The recording command handlers sit in `api/recording.py`. Details under
  "Recording".
- **`speech/` — engines, models, downloads.** The engine interface (whisper.cpp through pywhispercpp,
  sherpa-onnx as a second local engine, a fake engine for tests), the pinned model catalogs, the model
  library (scan, import, Hugging Face search, verified downloads), cloud STT chunking, and the
  transcription job runner that maps segment times back to session time.
- **`platform/` — native Windows.** ctypes bindings for user32 (global hotkeys on a message-loop
  thread, `FlashWindowEx`), the microphone consent-store reader used by meeting detection, and the
  credential store (Windows Credential Manager through `keyring`). Everything native sits behind an
  interface with a fake, and tests never touch the real desktop. The pywebview window and the CLI
  entry point are `app.py` at the package root.
- **`infra/` — storage.** SQLite with the schema applied in numbered SQL migrations and the version
  recorded in `user_version`. Migrations 2 and 6 run with foreign keys off. On startup an unfinished
  meeting is marked `interrupted`. Transactions and lock ordering live here; `paths.py` at the package
  root supplies the data folder and the audio and export paths.

### Outbound requests

Every provider call goes through one `httpx` client with explicit timeouts (15 s for model lists,
120 s for chat), no redirects, no environment proxies and a response size cap (4 MiB for model lists,
2 MiB for chat). A failed request is never retried and no other model is tried. A result is refused
if the notes, transcript, speaker names, provider or thread changed while the request was in flight.
One AI request runs at a time; a second is refused with `processing_busy`.

## Data and files

- Database: `%APPDATA%\OpenMeetPy\meetings.db`. `--data-dir <folder>` overrides the folder for a run.
- Audio: `%APPDATA%\OpenMeetPy\audio\<meeting id>\` with `mic.wav`, `mic.timing.jsonl`, `system.wav`,
  `system.timing.jsonl`.
- Exports go to a folder chosen in Settings and are never overwritten: an existing file is preserved
  and a new snapshot is written beside it.
- Keys are never in the database. A connection row holds an internal account name that points at the
  Windows Credential Manager entry.
- The `/files` route serves only the audio and export folders, never the database.

### WAV format and timing index

- 32-bit float WAV: format tag 3, a `fact` chunk, the data chunk last, sizes patched on finalize,
  then fsync.
- One timing line per written block, in the same format the UI and the verifier expect.
- Validation rules: line size, file size, contiguous offsets, overlap tolerance of 30 ms, total
  frames. An index that fails these rules blocks transcription and seeking.
- Session time maps to a file position through the index (pauses are gaps, not silence).
- An unfinished WAV is repaired into a **new copy**; the original is only ever read.
- Peak computation cleans non-finite or out-of-range samples before reporting levels.

## Recording

- Start resolves both devices before creating any file. A missing device, a bad format or a failed
  stream open leaves no files and no rows. A failure on the second track stops the first. There is no
  one-track fallback and no silent device switch.
- One session at a time, with a `revision` on every transition. Events are notifications; commands
  return the authoritative state.
- The device callback only copies a block into a bounded queue and tags it with a generation. A writer
  thread per session owns the files and writes only blocks of the current generation.
- Pause stops the streams, bumps the generation (queued and in-flight blocks of the old generation are
  discarded), and checkpoints the files. Resume re-resolves both devices, refuses a changed format and
  bumps the generation again.
- Faults pause the recording and keep the files: queue overflow, a device that stops responding, a
  disk write or finalize failure, a writer that stops responding, and a sleep or scheduling gap over
  2 seconds. The meeting is marked `interrupted` with the error text.
- Stop drains the queue, finalizes both WAVs and indexes, then records frames, dropped frames and
  `finalized` per track.
- Startup marks an unfinished recording `interrupted`. Recovery writes repaired copies. Delete-audio
  and delete-meeting remove the meeting's tracked files and any other regular file in **its** folder,
  refuse while the meeting is recording, and touch nothing outside that folder.
- Window close during recording finalizes the files and marks the meeting `stopped` with no error.
  A process crash leaves `interrupted`, recoverable.

### Recording limits to know

- **The system track records everything the chosen output plays, including OpenMeet itself.** The
  library used cannot exclude the app's own playback, so the device label ends with
  `(all audio, includes OpenMeet playback)`.
- Device ids are built from the device name, with the PortAudio index only as a tiebreaker for
  duplicate names. Swapping identical devices or a driver rename makes the saved id unavailable;
  start then fails visibly instead of substituting another device.
- Timestamps come from counted frames, anchored once per stream run to the host clock. Clock accuracy
  is unverified.
- The capture callback is not allocation-free (each callback copies the device buffer). Real-time
  behaviour is unmeasured.
- Paused audio is not saved; the last block or two queued before a pause may be lost.

## Speech

### Local: whisper.cpp

pywhispercpp (wheels only) behind the engine interface. The pinned catalog holds 33 whisper.cpp
models plus a Silero VAD file, each with a size and a SHA-256. Install downloads only the VAD file and
the selected model. Audio is read from the float32 tracks, mixed to mono and resampled to 16 kHz with
a numpy windowed-sinc (Kaiser) filter, five-minute windows at a time. Segments map back to session
time, marker rows are filtered, tracks are merged and sorted.

### Local: sherpa-onnx

A second engine behind the same interface: Parakeet TDT 0.6B v3, Moonshine base, SenseVoice small, and
downloaded `sherpa-dir:<name>` folders. Layout is detected from file names (transducer, Moonshine,
single `model*.onnx` plus `tokens.txt`). Segmentation uses Silero VAD windows, so each segment is timed
by its start sample. The engine is the pip package, not a downloaded binary.

### Cloud

`{base}/audio/transcriptions`, one multipart POST per chunk: 16-bit WAV chunks of at most 16 MiB (plus
header) and 300 seconds, split at pauses and generation changes, at most 200 requests, 4 MiB response
cap, 120 s timeout. Each chunk is hashed before upload; a refused or changed request is never sent;
nothing is retried.

### Transcription behaviour

- One transcription runs at a time on a worker thread. The request waits for it, so the UI's await
  resolves when the transcript is saved or the job fails.
- The transcript is replaced in one database transaction, and only if the settings are unchanged.
- Cancelling keeps the previous transcript. A replacement copies the previous transcript (edits
  included) into `transcript_versions` first.
- `edit_segment` keeps the engine text in `original_text`, refuses a changed base text, and clears the
  edit on revert. Summaries become stale through the transcript hash.

### Download and archive safety

- Downloads stream to a temporary file in the target folder, check size and SHA-256, fsync, then
  publish with `os.link`, so an existing file is never overwritten. Downloads never resume.
- HTTPS only, to an explicit host allow-list (Hugging Face hosts for models, the three GitHub release
  hosts for sherpa archives); no credentials, no environment proxies, redirects followed by hand (at
  most five), every hop re-checked. Model downloads go to `huggingface.co`, `*.huggingface.co` and
  `*.hf.co`.
- Local model scan bounds: 4,096 entries, six levels, 200 models. Import hashes the source before
  copying and the copy again.
- A Hugging Face sherpa **folder** download is all-or-nothing: the listing is re-read at the pinned
  revision, every file is verified in a hidden staging folder, and the folder is renamed into place
  only after the last check.
- Archives (`.tar.bz2`) are validated before anything is written: absolute, drive, backslash, colon,
  `..`, empty or duplicate names (case-folded), links, devices, FIFOs, more than 4,096 members, 2 GiB
  per file, 4 GiB declared in total. Only the wanted basenames are written, with exclusive create into
  a `.staging-*` folder that is renamed into place with a `.release` marker holding the archive SHA-256.
- Local AI server detection probes only `http://127.0.0.1:<port>/v1/models` on the five ports used for
  local LLM servers, with no credentials, no redirects, no proxies, a 2-second timeout and the 4 MiB
  cap. A server is reported when it lists models, or when it answers 401/403 (needs a key).

## Automatic processing, detection, shortcuts

### Session processing

- The plan is frozen at recording start from the saved default (`recording`, `live`, `final`, `both`,
  a built-in summary template, saved instructions) and stored per meeting. It holds ids, revisions and
  base URLs, never credentials. A plan that cannot be built skips processing with a notice; the
  recording still starts.
- Stages: `live`, `finalizing_audio`, `transcribing`, `awaiting_notes`, `summarizing`, then
  `completed`, `failed`, `cancelled`, `interrupted` or `needs_attention`.
- Budgets: 14,400 s recording, 14,400 s processing after stop, 256 MiB upload, 1,000 requests,
  800,000 text bytes. Each billable request is counted under the store lock before it is sent; over
  budget sends nothing. Requests are fingerprinted (SHA-256) and stored.
- The summary waits for `acknowledge_processing_notes`. A wrong barrier or a stale run is
  `processing_cancelled`; a different notes revision is `notes_conflict`.
- Cancel keeps the transcript. Retry runs for a stopped final recording with current settings, fresh
  budgets and a new deadline; it keeps a completed transcript and continues with the summary.
- Restart marks unfinished runs and sessions `interrupted` once, then starts nothing and replays no
  request.
- Live preview copies each written block into a bounded tap (about 10 s chunks, queue of 3). A full
  queue or a 200-row/1 MiB overflow marks the preview incomplete. Provisional rows live in
  `processing_provisional`, not in `segments`, so search, the transcript, summaries and exports never
  read them. Live is the least proven part: it has only run with the fake engine, and both local
  engines reload the model per chunk (unmeasured cost).

### Global shortcuts

Ctrl/Control, Shift, Alt, Win/Super/Meta/Cmd and CommandOrControl; letters, digits, F1 to F24, and
Space, Enter, Tab, Escape, Backspace, Delete, Insert, Home, End, PageUp, PageDown and the arrows. A
non-F key needs Ctrl or Alt, pause and stop must differ after normalization, and the text is at most
100 characters. Registration uses `RegisterHotKey` with `MOD_NOREPEAT` on the message-loop thread;
saving unregisters the old pair, registers the new one, and restores the old pair on failure. There is
no shortcut to start a recording — start always goes through New recording.

### Meeting detection and attention

- A poll thread reads `HKCU\ConsentStore\microphone` and its `NonPackaged` subkeys every 3 s; an app
  must appear in two polls in a row. Ignored apps are never emitted, "Prompt again" removes them from
  the list, and OpenMeet's own executable is excluded.
- Detection only emits `microphone_apps`, which opens the New recording setup. It never starts capture,
  never chooses a device and has no reference to the recorder.
- Attention uses `FlashWindowEx` with `FLASHW_TRAY` and `FLASHW_TIMERNOFG` on the window titled
  "OpenMeet". It never activates the window.

## Frontend (Feature-Sliced Design)

`src/` is split into `app`, `pages`, `widgets`, `features`, `entities` and `shared`, in that order.
Each page, widget, feature and entity has an `index.ts` that exports only what other slices import, and
imports are relative, so no alias is configured. There is no `recording` or `settings` entity and no `@`
alias. `eslint.config.js` enforces the boundary with the built-in `no-restricted-imports` rule: a file
may import only from strictly lower layers, slices inside one layer may not import each other, and a
lower layer's slices are reachable only through their `index.ts`. Tests and `src/shared/test/` are
exempt, and `shared/api` and `shared/lib` have no `index.ts`, so deep imports into them remain allowed.

`vite.config.ts` builds the root `index.html` into `backend/web`. The UI talks to the backend through
one module, `src/shared/api/transport.ts`; there is no desktop-shell bridge and no path alias:

- `invoke(cmd, args)` posts JSON to `/api/invoke/<cmd>` with the page's token; non-2xx responses throw
  the `{code, message}` body the server serialises.
- `listen(event, cb)` shares one WebSocket at `/ws`, carrying `{event, payload}`.
- `convertFileSrc(path)` returns `/files?path=…&token=…`.
- The server injects `window.__OPENMEET_TOKEN__` into the page it serves; `isBackendConnected()` is
  true only once that token is present.

## Console redesign

The UI is a flat "Console" restyle: monospace small labels, an amber accent and a 300 px sidebar
with flat two-line rows. **Settings → General → Theme** offers **System**, **Dark** and **Light**.
**System** is the default and follows the OS; the choice is stored in the database
(`settings.theme`), not webview storage, and applied through `data-theme` on the document root. The
same settings row keeps the meeting inspector's open state (`settings.inspector_open`). Known rough
edge, not a blocker: compact controls are 28 px, below the 32 px control height.

## Build, run and check

- `just setup` installs the locked Python environment with `uv` and the JavaScript dependencies with
  pnpm. Python dependencies live in `backend/pyproject.toml` and `uv.lock`.
- `just dev` builds the UI into `backend/web` and runs the app from source with
  `uv run --directory backend python -m openmeet_py.app`.
- `just ui` runs only the Vite dev server on `http://127.0.0.1:1420`. No backend is attached and there
  is no mock layer, so the page shows the not-connected notice and nothing records, transcribes or
  stores anything.
- `just check` runs typecheck, lint, format check, the UI tests, the UI build and the Python tests.
- `just build` runs `packaging/build.ps1`: a `uv sync`, a Vite build into `backend/web`, then
  PyInstaller one-file windowed to `packaging/dist/OpenMeet.exe`, with
  the web folder and migrations bundled and the `webview`, `pyaudiowpatch`, `websockets` and
  `pywhispercpp` packages collected. No Visual Studio, Windows SDK or C compiler is needed.
- `just smoke` runs `packaging/dist/OpenMeet.exe --smoke`: it starts the server, checks `/health` and
  `list_meetings`, prints `OK` and exits without a window.
- `just hardware` sets `OPENMEET_PY_HARDWARE_AUDIO=1` and runs the opt-in real-device test group.
- `uv run --project backend pytest` runs the suite from the repo root.
- Diagnostic flags: `--check-audio-import`, `--check-stt-import`, `--check-sherpa-import` import the
  library and print its version without opening a device or loading a model. `--data-dir` overrides
  the data folder.

The exe opens uvicorn on a free loopback port and a pywebview window titled "OpenMeet", 1100x780,
minimum 720x580. Shutdown finalizes an active recording before the database closes.

## Environment switches

These exist for tests, the browser check and the owner's hardware run. None is set in an installed
exe.

| Variable | Effect |
| --- | --- |
| `OPENMEET_PY_FAKE_AUDIO=1` | Use the synthetic capture backend (440 Hz mono "microphone", 660 Hz stereo "output") instead of PortAudio. |
| `OPENMEET_PY_FAKE_STT=1` | Use the fake speech engine; `stt_status` reports the files as installed without creating anything. |
| `OPENMEET_PY_TEST_HOSTS` | Replace the download host allow-list (and permit plain HTTP) for stub-server tests. Unset in normal use. |
| `OPENMEET_PY_FAKE_HOTKEYS=1` | Use the recording fake of the Win32 wrapper instead of registering real hotkeys. |
| `OPENMEET_PY_FAKE_DETECTION=1` | Read `<data folder>\fake-microphone-apps.json` instead of the Windows consent store. |
| `OPENMEET_PY_HARDWARE_AUDIO=1` | Opt in to the real-device recording test. Not run. |
| `OPENMEET_PY_REAL_MODEL=1` | Opt in to a real-model transcription test; needs `OPENMEET_PY_MODEL_FILE` or the two sherpa variables below. |
| `OPENMEET_PY_MODEL_FILE` | Absolute path to an existing whisper.cpp model file for that test. |
| `OPENMEET_PY_SHERPA_DIR`, `OPENMEET_PY_SHERPA_VAD` | Existing absolute paths for the real sherpa test. |
| `OPENMEET_DATA_DIR`, `OPENMEET_TOKEN` | Read by `server.py` when the server is started directly (data folder, per-launch API token). The app passes both in-process. |

`backend/tests/conftest.py` makes the real Win32 wrapper and the `winreg` reader unusable in every
test, so a test run cannot touch the desktop.

## Phase history

| Phase | What it added | Status, honestly |
| --- | --- | --- |
| 1 | Notes CRUD and autosave with revisions, tags, search, settings, Markdown export, the window, `--smoke`, the exe | Built and checked on this PC |
| 2 | AI connections, summaries, questions, tasks, library, rewrite; keys in Windows Credential Manager; speaker names | Built and checked on this PC. Transcript-dependent previews were only exercised with segment rows inserted directly |
| 3 | Microphone and system-audio recording, WAV and timing files, pause, resume, recovery, audio deletion | **Built in code and checked with a fake backend only. It is UNQUALIFIED.** |
| 4a | whisper.cpp transcription, cloud STT, transcript editing and history, model library | **Built in code and checked with a fake engine, stub servers and synthetic audio only. It is UNQUALIFIED: no real model has been loaded, no real speech has been transcribed, and transcription quality and speed are unverified.** |
| 4b | sherpa-onnx as a second local engine (Parakeet TDT 0.6B v3, Moonshine base, SenseVoice small), downloaded sherpa folders, local AI server detection | **Built in code and checked with a fake sherpa module, stub servers, a synthetic archive and MockTransport only. It is UNQUALIFIED: no sherpa model has been loaded, no archive has been downloaded from GitHub or Hugging Face, and no sherpa model has transcribed anything.** |
| 5 | Automatic processing after a recording, meeting detection prompts, global pause/stop shortcuts, taskbar flashing | **Built in code and checked with fakes, a stub server, a browser check against fake devices, and an exe smoke run only. It is UNQUALIFIED: RegisterHotKey, the Windows consent store and FlashWindowEx have not run on a real desktop; live transcription has not run on a real model; the tray is deferred.** |
| 6 | The frontend moved into Feature-Sliced Design layers | Pure move, checked: typecheck, lint, format, 269 tests in 29 files (same count as before), both UI builds |
| 7 | Owner-run hardware qualification | **Pending. Nothing has been run.** |

Every command the UI invokes is implemented: 78 of 78, none answers HTTP 501, and `NOT_AVAILABLE` is
empty. The `not_available()` error is raised only where a window is required and absent: the native
folder picker for choosing an export folder, and the close-window fallback when no window handle is
attached. The registry test fails if the UI invokes a command the backend lacks.

The Phase 5 browser check (fake devices, a stub OpenAI-compatible server, a fresh data folder) ran a
four-second recording with "Final transcription after stop" and the General summary: the panel reached
"Stage: Done. Used 1 request, 2 KB of text", the meeting had 8 transcript segments and a summary, a
fake Teams microphone entry produced the detection prompt, and "Set up recording" opened New recording
without starting a capture.

## What the build replaced

The repository used to hold a Rust/Tauri application (`src-tauri/`, a Cargo workspace, a bundled
whisper.cpp CLI and the Rust audio, storage and processing code). It could not be built on the owner's
PC for lack of the Windows SDK and MSVC, so a Python build was started alongside it; once the Python
build covered every UI command, the Rust app and `src-tauri/` were deleted. The last Rust code is kept
at git tag `rust-final`. Documentation, verification notes and plans written for the Rust app are in
`docs/archive/` and are marked as history.

The schema itself carried over: the migrations that define the database were taken from that code base
and are now `backend/openmeet_py/migrations/`. The data folder name `%APPDATA%\OpenMeetPy` also dates
from the side-by-side period, and is kept so existing installs keep their settings. The Python build
never reads or migrates another profile's database on its own; a different `--data-dir` is a fresh
start, not a migration.

## Open items

1. **Phase 7 hardware qualification** —
   [docs/phase-7-hardware-qualification.md](phase-7-hardware-qualification.md) is the owner-run
   checklist (sections A to O). A PASS results table is the only basis for removing the "unqualified"
   labels; a BLOCKED step is never a PASS.
2. **Tray icon, deferred.** No tray icon, tray recording controls or tray tooltip. `Shell_NotifyIcon`
   needs a message window and icon handling that were out of the scope set for phase 5.
3. **Quality parity unverified.** No real model has transcribed real speech here, so accuracy, speed,
   segment boundaries and language behaviour are unknown, and there is no measurement against the
   earlier whisper.cpp pipeline. The bundled whisper.cpp build version is not stated in pywhispercpp's
   metadata.
4. **Other unverified paths:** a real GitHub or Hugging Face download, the Windows Credential Manager
   backend (only the in-memory keyring backend is exercised), the native folder picker, real
   `RegisterHotKey` behaviour (taken chords, NOREPEAT, the message loop), real consent-store reads,
   `FlashWindowEx`, cloud speech and cloud summaries against a real provider, and the exe's WebSocket
   path end-to-end in a window (checked only through the dev server).
5. **Live preview** has only run on the fake engine, and both local engines reload the model for every
   chunk — an unmeasured cost that matters for long meetings.
6. **Known limits by design:** the system track includes OpenMeet's own playback; paused audio is
   dropped; a corrupt file at a download destination blocks a re-download with "already exists";
   sherpa VAD thresholds are the package defaults, so segment boundaries may differ from an
   engine-specific setup; a sentence crossing a five-minute window boundary can be split and segments
   are not deduplicated across windows; sherpa models ignore the vocabulary hint, Parakeet and
   Moonshine ignore the language setting, and SenseVoice accepts `zh`, `en`, `ja`, `ko`, `yue` (auto
   otherwise); the SenseVoice licence is unconfirmed (`THIRD_PARTY_LICENSES.md`).
7. **Smaller gaps:** no request cancellation for AI calls; question excerpts match keywords as
   substrings in transcript order rather than ranked; due dates accept years 1 to 9999 only; the
   Markdown export still writes "No transcript generated." for a meeting with no transcript; and
   the Starlette test client prints an httpx
   deprecation warning.

## Module map

Confirmed by listing `backend/openmeet_py/` on 2026-10-23.

| Module | Role |
| --- | --- |
| `app.py` | Entry point: uvicorn thread, pywebview window, CLI flags (`--smoke`, `--check-*-import`, `--data-dir`) |
| `paths.py` | Data folder (`%APPDATA%\OpenMeetPy`), audio and export paths |
| `migrations/` | 30 numbered SQL migrations, taken from the earlier code base |
| `api/server.py` | FastAPI app: `/api/invoke/{cmd}`, `/ws`, `/files`, `index.html` with the per-launch token, host check, shutdown |
| `api/commands.py` | Command registry and the meeting, note and settings handlers |
| `api/recording.py` | Recording commands: devices, start, pause, resume, stop, state, delete, recover, seeking, usage |
| `api/reads.py` | Read-only queries: settings, meeting detail with track rows, transcript lines, freshness hashes |
| `api/context.py` | Shared `Context`: store, events, recorder, HTTP transport, AI and speech slots; argument checks |
| `api/errors.py` | Error codes and the `{code, message}` body |
| `domain/processing.py` | Session processing plan, stages, budgets, worker, notes barrier, cancel/retry |
| `domain/transcript_edits.py` | Segment edits, transcript versions, revert |
| `domain/summaries.py`, `domain/questions.py`, `domain/tasks.py` | Summaries and templates, question threads, action items |
| `domain/connections.py`, `domain/providers.py`, `domain/llm.py` | Connections and assignments, model lists and local server detection, chat and summarising |
| `domain/exporter.py` | Markdown export, non-overwriting snapshots |
| `audio/audio_backend.py` | `CaptureBackend` protocol, `PortAudioBackend` (PyAudioWPatch, lazy import), `FakeBackend` |
| `audio/audio_wav.py` | float32 WAV write/validate/repair, timing index, session-to-file mapping, peaks |
| `audio/recorder.py` | Recording state machine, queue, writer and meter threads, revisions |
| `speech/stt.py`, `speech/stt_catalog.py` | Speech status, settings validation, install; pinned whisper models and VAD |
| `speech/sherpa_models.py` | sherpa catalog, layout detection, installed state, runnable spec, install |
| `speech/model_library.py` | Local scan/import, Hugging Face search and listing, verified downloads, host allow-list |
| `speech/safe_archive.py` | Validating `.tar.bz2` extractor with staging and a `.release` marker |
| `speech/cloud_stt.py` | Chunking, hashing and upload for a cloud speech endpoint |
| `speech/transcription/` | `engine.py` (whisper.cpp, sherpa-onnx, fake), `audio_read.py`, `pipeline.py`, `jobs.py` |
| `platform/win32.py` | ctypes user32 (`RegisterHotKey`, `FlashWindowEx`, `FindWindowW`) and its fake |
| `platform/hotkeys.py` | Accelerator parsing and validation, `HotkeyService`, settings save |
| `platform/detection.py` | Consent-store reader, debounce, ignored list, detection commands |
| `platform/keys.py` | Credential store through `keyring` |
| `infra/store.py` | SQLite open/migrate, `user_version`, startup interruption, transactions |
