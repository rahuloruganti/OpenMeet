# OpenMeet architecture

OpenMeet ships as one Windows executable that contains three things: a Python backend owning all state and system access, a local HTTP/WebSocket server bound to `127.0.0.1`, and a WebView2 window (through `pywebview`) rendering a React interface. The UI does no privileged work: it renders state and sends commands.

## Runtime flow

```mermaid
flowchart LR
    UI[React UI in WebView2] -->|POST /api/invoke/{cmd}| API[FastAPI command registry]
    API --> Store[(SQLite meetings.db)]
    API --> Capture[WASAPI capture: microphone + process loopback]
    Capture --> Tracks[WAV tracks and timing indexes]
    API --> Local[whisper.cpp or sherpa-onnx]
    Tracks --> Local
    Local --> Store
    Capture --> Live[Live transcript decoders]
    Live --> Store
    Live -->|Utterances, when Cloud connection| Cloud
    API -->|Meeting text| LLM[Configured chat API]
    API -->|Meeting text, when Local AI is assigned| Llama[llama-server on 127.0.0.1]
    API -->|Audio chunks| Cloud[Configured speech API]
    API --> Export[Markdown snapshots]
    API -->|Events on /ws| UI
    API -->|Audio on /files| UI
```

Model downloads are separate explicit actions. Cloud transcription uploads audio only when the user transcribes, the saved automatic-processing default runs, or the live model is **Cloud connection**; local Whisper stays the default. Summary, question and rewrite calls send text only, to the assigned connection: a remote provider, or the managed llama-server on loopback when **Local AI** is assigned. The diagram describes code paths, not qualified hardware or provider behavior.

## Process and transport

`backend/openmeet_py/app.py` is the desktop entry point. It picks a free loopback port, starts `uvicorn` in a background thread, generates a random token for that launch, and opens the `pywebview` window on the local URL. Window close shuts the server down. The same entry point serves `--smoke` (start, check `/health` and one command, print `OK`, exit) and `--data-dir` for tests.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/invoke/{cmd}` | The single RPC endpoint. JSON arguments in, JSON result out; requires the `X-OpenMeet-Token` header. Failures return a non-2xx status with `{code, message}`. |
| `GET /health` | Liveness probe used by `--smoke`. |
| `GET /ws?token=…` | Server-to-client events. The client sends nothing; the socket is read only to detect disconnects. |
| `GET /files?…` | Audio playback. The path must resolve inside the data folder's `audio/` root or the chosen export folder; database files are refused. |

Requests and the socket accept only loopback clients carrying the launch token. `/api/invoke`, `/ws` and `/files` require a per-run token and check the `Host` header; `/` checks `Host` but is served without a token, and `/health` and the static assets check neither. Because `/` is served without one and carries the token, any local process that can reach the loopback port can read it — the token separates the page from remote pages, not from other processes of the same user. `src/shared/api/transport.ts` implements `invoke`, `listen`, `convertFileSrc` and connection state; `src/shared/api/api.ts` declares every command and payload type on top of it. Pages, widgets and features go through `api.ts` and never fetch or open a socket themselves.

## Code ownership

The frontend is Feature-Sliced Design: `app` > `pages` > `widgets` > `features` > `entities` > `shared`. Imports may only point down that list, each slice exposes a public `index.ts`, and ESLint's `no-restricted-imports` rule enforces the boundary. The allow-list lives in `eslint.config.js`.

`src/app/App.tsx` switches between the meetings page, the full-page Settings and Ask screens, and the full-screen first-run setup. The global shortcuts and the Ctrl+K command palette live in that shell, and full pages return to Meetings with **← Meetings** or **Escape**.

| Path | Responsibility |
| --- | --- |
| `src/app/` | App shell, providers, layout, page routing, global styles. |
| `src/pages/meeting/` | Meeting workspace: library selection, notes, transcript, summaries, playback, export, deletion. |
| `src/pages/settings/` | Settings page: all six sections on one scrolling page, with an **On this page** index that follows the scroll and settings search (General, Recording, Transcription, AI notes, Export & storage, Privacy & about). |
| `src/pages/setup/` | First-run setup: optional import, speech engine, optional AI connection, default devices. |
| `src/pages/ask/` | Ask across meetings as a full page, without the meetings sidebar. |
| `src/widgets/meeting-sidebar/` | Meeting library, source labels, title and content search. |
| `src/widgets/meeting-workspace/` | Notes, transcript, playback, summaries, questions, action items, the meeting inspector (Details, Tasks, Devices), New recording dialog. |
| `src/widgets/command-palette/` | Ctrl+K actions and meeting search. |
| `src/widgets/recording-controls/` | Backend capture state, pause/resume/stop, level meters. |
| `src/widgets/settings-panel/`, `widgets/setup-panel/`, `widgets/first-run-setup/` | Settings sections, pre-recording setup, first-run flow. |
| `src/widgets/library-question/` | Ask across meetings with validated source links. |
| `src/features/note-writer/` | Debounced, serialized note saves. |
| `src/features/live-transcript/`, `features/live-settings/` | Live text on the Transcript tab, and its Settings switch, model list and download. |
| `src/features/transcription-settings/`, `provider-settings/`, `model-library/` | Speech engine choice and downloads, saved connections and assignments, model discovery. |
| `src/features/local-ai/` | The Local AI group: engine install, one model dropdown with fit labels, download and cancel, server on and off, **Set up for me**. |
| `src/features/recipes/`, `rewrite-selection/`, `action-items/`, `meeting-tags/`, `speaker-names/`, `summary-templates/`, `transcript-versions/` | Meeting actions and their editing state. |
| `src/entities/meeting/`, `entities/processing/` | Domain models and their read/update logic. |
| `src/shared/api/` | `transport.ts` (RPC, events, file URLs) and `api.ts` (commands and types). |
| `src/shared/lib/` | Markdown rendering, timestamp parsing, shortcut labels, tab helpers. |
| `src/shared/test/` | Test utilities and mocked transport. |

The backend is `backend/openmeet_py/`: `app.py`, `paths.py`, seven subpackages and the SQL migrations.

| Path | Responsibility |
| --- | --- |
| `app.py` | Desktop entry point, server thread, window, `--smoke`, `--import-from`. |
| `paths.py` | Data folder (`%APPDATA%\OpenMeetPy`), bundled UI directory, migration directory. |
| `api/` | FastAPI app and routes, token check, WebSocket hub, the command registry in `commands.py`, and the in-app import commands in `import_commands.py`. |
| `domain/` | Meetings, notes, transcripts, summaries, questions, tasks, tags, settings and processing-run state; provider HTTP (`providers.py`), chat calls (`llm.py`) and export (`exporter.py`). |
| `audio/` | WASAPI microphone and loopback capture, bounded queues, WAV writers and repair, timing indexes, recorder lifecycle. |
| `speech/` | whisper.cpp (`pywhispercpp`) and sherpa-onnx engines, cloud STT, the model catalogue and verified downloads (`model_library.py`), safe archive extraction (`safe_archive.py`), live transcript decoding (`live/`) and the streaming model list and downloads (`streaming_models.py`). |
| `local_ai/` | The pinned llama.cpp build and GGUF catalog (`catalog.json`), the hardware probe, the one-process llama-server supervisor (`server.py`), and the Local AI state, downloads and commands (`service.py`). |
| `platform/` | Windows integration: global shortcuts, Credential Manager keys, meeting detection, process metadata. |
| `infra/` | SQLite access, migrations and the read-only importer. |
| `migrations/` | Append-only numbered SQL, currently through `032`, next number `033`. |

`backend/tests/` mirrors these areas and uses fakes; `packaging/build.ps1` produces the executable.

## Command dispatch

Every UI action is a command. `backend/openmeet_py/api/commands.py` holds the registry that maps the camelCase command names used by `api.ts` to handlers. The dispatcher converts camelCase arguments to snake_case handler parameters, so the UI never sends Python-style names. Handlers raise typed errors that become `{code, message}` responses; an unexpected exception becomes a visible `backend_error` event rather than a silent failure.

`backend/tests/test_commands.py` reads `src/shared/api/api.ts` and fails when the UI invokes a command the registry does not serve, or when a registered command has no handler. Add a command in the registry and its handler; never stub it in the UI.

## State and concurrency

The process is single-tenant: one user, one database, one active capture. SQLite runs in WAL mode; the store is the only writer, and lifecycle operations are serialized. Blocking work (SQLite writes, model inference, HTTP, file copies) runs off the event loop and outside audio callbacks.

The backend's `RecordingState` carries a monotonically increasing revision, status (`idle`, `recording`, `paused`, `stopped`), meeting ID, source, error and audio-derived offset. Commands return authoritative state; events only tell the UI to refresh, and the UI ignores a revision older than the one it holds. A persisted meeting may also be `interrupted`.

## Notes and close behavior

Note saves are debounced (400 ms) and serialized, and carry the revision the text was based on. A stale write fails instead of replacing newer text. Meeting switches, exports and closing the window flush notes. Closing saves notes and any open summary or transcript edit, stops capture, interrupts processing and quits with no prompt; a save that cannot complete keeps the window open with a **Not saved yet** dialog that lists what failed and offers **Try again** and **Keep working**, plus **Quit anyway** for a summary or transcript edit only, because notes are never discarded. Stopping a recording proceeds regardless, so capture is never kept running by a note error.

## Capture and transcription

Capture opens the explicitly selected microphone and, for the system track, a WASAPI loopback client (`PyAudioWPatch`) that records everything the output plays, including OpenMeet's own playback; loopback capture cannot exclude it, so the device label says so. Each device feeds a bounded queue drained by a writer thread that produces a separate WAV file at the device's native rate plus a timing index. Pause generations reject queued samples belonging to an earlier recording interval, so paused audio is neither written nor transcribed. Queue overflow, a lost device or a failed finalize is a visible error; there is no fallback to one track and no silent device switch. Process loopback may deliver no frames while nothing plays audio.

Local transcription runs `pywhispercpp` (whisper.cpp) with the selected model, Silero VAD, language and vocabulary hint, or the pinned sherpa-onnx runtime with one of the supported models (parakeet-v3, moonshine-base-en, sense-voice). Model files are downloaded only on an explicit action and verified against pinned checksums. The sherpa-onnx engine feeds its Silero detector 512 samples at a time: a larger block made sherpa-onnx drop every speech segment that ended inside the block, which lost most of a sentence in both live and final transcription. Cloud transcription uploads frozen PCM16 WAV chunks to the assigned speech connection and stores untimed text as untimed: no fabricated timestamps and no playback links. `You` and `Others` label the two tracks; neither identifies individual speakers.

All of this is exercised with fakes (`OPENMEET_PY_FAKE_AUDIO`, `OPENMEET_PY_FAKE_STT`) and synthetic audio. Real devices and real engines are unqualified; see [Phase 7 hardware qualification](phase-7-hardware-qualification.md).

## Processing runs

The automatic-processing default chosen in Settings becomes a plan attached to each new recording: **Recording only**, or **Transcribe after stop** with an optional summary. Settings offers no live choice any more; a stored `live` value reads as `recording` and `both` as `final`. Plans carry finite budgets (recording horizon, post-stop allowance, uploaded bytes, request count, text bytes), the destination and model for each role, and the configuration revision they were built from.

Live text is a separate setting and not part of the plan. `backend/openmeet_py/speech/live/` takes blocks from the recorder writer without blocking it, downmixes each lane to mono, resamples continuously to 16 kHz and runs one decoder per lane. A decoder emits updates for one utterance id: a partial replaces the text of that id and a final closes it. There are three kinds. A streaming model runs a sherpa-onnx `OnlineRecognizer` with endpoint detection. The Transcription model runs behind Silero VAD fed 512 samples at a time, re-decoding the open utterance about every 1.5 s and loading the engine once per recording. The cloud connection uploads each finished utterance once, has no partials, never retries, and caps a recording at 240 requests and 100 MiB. Same as Transcription is unavailable while Transcription is cloud, with a reason that points to Cloud connection; nothing uploads. The per-block timing map grows with the length of a recording; this is a known, non-blocking performance limitation. The exact mapping is kept, and this is not a runtime hardware qualification. A full queue drops blocks and marks the live transcript incomplete; final lines go to `live_lines` and are marked provisional until a final transcript exists.

A final transcription replaces the authoritative transcript atomically with provider and model provenance; failure or cancellation keeps the previous transcript and the original audio. An automatic summary waits for the saved-note revision to be acknowledged after stop and refuses to publish if notes or transcript changed meanwhile.

Restart marks unfinished stages as interrupted and replays nothing. Retry is explicit, builds a fresh plan and new budgets from current settings, and may repeat a billed request. There is no automatic billable retry and no model or provider fallback.

## Provider requests

A saved connection is a named base URL plus an optional key held in Windows Credential Manager under a revision-specific account name; SQLite stores the non-secret reference. Independent summary and speech assignments may share one connection with different model IDs. Request URLs are formed by appending `/models`, `/chat/completions` or `/audio/transcriptions` to the validated base URL, preserving its path prefix. Remote destinations require HTTPS; loopback HTTP is allowed with an optional key; redirects are disabled.

Saving settings makes no network request, and opening Settings contacts no provider. **Test** lists a connection's models to check its URL and key: a key typed into the field is used for that one call and never stored, and a saved key is used only for the base URL it was saved with. The list is read from the generic `data[].id`; a model list proves neither chat nor audio capability. The **Model** dropdown is filled by that call, or automatically after saving a new connection without a model, and **Other…** takes a typed id. Each dispatch revalidates the run, stage, configuration revision and remaining budget, and reserves the exact bytes it will send before dispatch. Credentials, prompts and response bodies never enter diagnostics.

## Local AI

`backend/openmeet_py/local_ai/` runs OpenMeet's own llama.cpp server. `catalog.json` pins one llama.cpp release (`b11671`) per backend and seven GGUF models with their repository revision, file size, SHA-256, license and KV figure; `catalog.py` validates those pins and turns them into the fit labels the page shows (`gpu`, `ram`, `too_big`, from VRAM and available RAM, plus one recommended model).

`hardware.py` reads the GPU from `nvidia-smi` and from the display adapters Windows reports, and RAM from `GlobalMemoryStatusEx`. The vendor picks the build: CUDA for NVIDIA, Vulkan for AMD and Intel, CPU otherwise. `engine.py` downloads the pinned zips, checks each size and hash, unpacks into a staging folder and renames it into place.

`server.py` owns at most one llama-server. It spawns the process with the model, alias, port, context size and GPU layer count, passes the key in the `LLAMA_API_KEY` environment variable rather than on the command line, waits for `/health` and then one small generation before reporting `running`, restarts once, and reports `stopped`, `starting`, `running` or `failed`. The process joins a Windows Job object with `KILL_ON_JOB_CLOSE`, so it dies with OpenMeet even if OpenMeet is killed, and `shutdown()` also stops it before the database closes.

`ensure_ready` is the single hook on the LLM path. Summaries, per-meeting questions, cross-meeting questions and automatic processing call it before building a request: when the assigned connection's base URL is the managed server, it starts the server with the saved model and waits for it, and a failed start raises a message with the fix. **Use** and **Set up for me** create or update the one connection named **Local AI**, save its key, assign the `llm` role and start the server. The port is the stored one, then `39281`, then any free loopback port.

The model list also includes `.gguf` files the read-only local scan finds on this PC, used where they are. State is one `local_ai` row; the engine, models and `server.log` live in `%APPDATA%\OpenMeetPy\local-ai\`.

No engine or model has been downloaded or run in this build. The supervisor, downloads and fit rules are covered with fakes; real llama-server behaviour, GPU offload, the Job-object kill and model quality are unqualified.

## Storage and migrations

| Table | Contents |
| --- | --- |
| `meetings` | Title, source, timestamps, status, capture error. |
| `notes` | User Markdown and its optimistic revision. |
| `tracks` | Paths, audio format, frame counts, dropped frames, finalization. |
| `segments` | Track label, nullable paired times, text, source, final-pass flag. |
| `summaries`, `summary_templates` | Versioned summaries with provider/model/template provenance; custom templates. |
| `settings` | Devices, shortcuts, speech and summary settings, export defaults, setup completion, theme and inspector state. |
| `transcript_versions` | Read-only earlier transcripts and edits with engine provenance. |
| `speaker_names`, `meeting_tags`, `action_items` | Per-meeting display names, tags, and editable tasks. |
| `saved_connections`, `provider_assignments`, `provider_connections` | Non-secret endpoint references and independent task assignments. |
| `processing_configuration`, `processing_sessions`, `processing_runs`, `processing_requests`, `processing_provisional` | Plan revisions, deadlines, durable stages, reserved bytes/digests, bounded live text. |
| `live_lines` | Live transcript finals per meeting: lane, speaker, session start and end, and text. |
| `question_threads`, `question_turns`, `library_answers`, `library_answer_meetings`, `recipes` | Saved questions and answers with their scope, and saved question recipes. |
| `meeting_transcriptions` | Last successful provider/model provenance per meeting. |
| `search` | FTS5 copies of titles, notes, transcript text and summaries. |
| `detection_ignored_apps`, `capture_events` | Meeting-detection ignore list; historical capture event table. |
| `local_ai` | One row: the llama.cpp backend for this PC, the loopback port, the chosen model id, and the saved **Local AI** connection id. No key. |

Migrations are append-only numbered SQL files applied in order under `PRAGMA user_version`. Never edit or renumber a shipped file; the next number is `033`. Upgrades must be tested against populated databases with notes, transcripts, search rows and foreign keys. A migration that rebuilds a table checks foreign keys before committing. Existing user databases are upgraded in place and never reset. `docs/privacy.md` lists what is stored and what stays unencrypted.

## Data folder and packaging

`%APPDATA%\OpenMeetPy\` holds `meetings.db` (plus WAL sidecars while running), `audio/<meeting id>/`, `stt/` for the downloaded speech engine and models, and `local-ai/` for the Local AI engine, models and `server.log`. Nothing is written to the repository or to the old app's folder, except by the one-time `--import-from` importer, which reads that folder without modifying it.

`packaging/build.ps1` builds the UI into `backend/web`, bundles it with the backend, migrations and pinned dependencies, and runs PyInstaller in one-file windowed mode to produce `packaging/dist/OpenMeet.exe`. There is no installer, code signing, auto-update or delta patch: replacing the file is the upgrade. WebView2 remains the only system runtime prerequisite.

## Events

| Event | Purpose |
| --- | --- |
| `recording_state` | Capture-state notification with revision. |
| `meeting_updated` | Refresh library or detail data. |
| `session_processing_changed` | Revisioned processing notification; fetch authoritative state. |
| `live_transcript` | One live line, partial or final, for a recording. |
| `live_state` | Live transcript state, engine and device boundary. |
| `live_model_progress` | Streaming model download progress, while Settings is open. |
| `audio_health` | Capture metrics and level-meter input. |
| `stt_progress` | Model download or transcription progress. |
| `local_ai_progress` | Local AI engine or model download progress, while Settings is open. |
| `backend_error` | Visible backend failure message. |
| `microphone_apps` | Opt-in meeting detection prompt (never starts capture). |

Events are notifications, not state. A missed event costs a refresh, never correctness.

## Qualification boundary

Everything above describes implemented code paths. The Python rebuild's hardware behavior is unqualified: capture, pause privacy, device and power failures, drift, real engines, shortcuts, detection and Credential Manager have been tested only with fakes and stubs. [Phase 7 hardware qualification](phase-7-hardware-qualification.md) is the only route to retiring those labels, and [rebuild status](rebuild-status.md) records how the port was done.
