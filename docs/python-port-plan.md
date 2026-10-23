# Python desktop build: plan

Status: Phases 1 (notes, shell, exe) and 2 (AI connections, summaries, questions, tasks, library,
rewrite) are built and checked on this PC. Recording, transcription and every feature that needs
native audio are unqualified until phase 7. Nothing in this build is a replacement for the Rust app yet.

## Why

This PC has no Windows SDK and no MSVC, so `src-tauri/` cannot be compiled here. The owner chose a
separate Python build to keep working. It overrides AGENTS.md's "Rust owns audio, storage, native
integration, and processing" rule for this build only. The Rust app and `src-tauri/` are unchanged.

## Architecture

- **Frontend, unchanged.** `src/` is not edited. `py/vite.py.config.ts` builds it into `py/web`
  with two aliases: `@tauri-apps/api/core` to `py/shim/core.ts` and `@tauri-apps/api/event` to
  `py/shim/event.ts`.
  - `invoke(cmd, args)` posts JSON to `/api/invoke/{cmd}`. Non-2xx responses throw the
    `{code, message}` body, which `src/lib/api.ts` already reads.
  - `listen(event, cb)` shares one WebSocket, `/ws`, which carries `{event, payload}`.
  - `convertFileSrc(p)` returns `/files?path=…&token=…`.
- **Backend.** FastAPI and uvicorn in `py/openmeet_py/`:
  - `store.py` opens SQLite and applies the Rust migration files in `src-tauri/migrations`, in
    order, recording the version in `user_version` the way `storage.rs` does. Migrations 2 and 6
    run with foreign keys off, as in Rust.
  - `commands.py` holds the registry and the meeting, note and settings handlers. Arguments arrive
    camelCase and are converted to snake_case, so handler parameters are snake_case.
  - `context.py` holds the shared `Context` (store, events, the injectable HTTP transport, one AI
    request at a time) and argument checks. `reads.py` holds settings, meeting detail, transcript
    lines and freshness hashes, the same as `storage.rs` and `lib.rs`.
  - `connections.py` ports provider connections, keys and assignments. `providers.py` ports
    `providers.rs`: URL and model validation, bounded HTTP and model discovery. `keys.py` keeps
    API keys in the Windows Credential Manager under the service name `OpenMeetPy`.
  - `llm.py` ports `llm.rs` and `retrieval.rs`: prompts, templates, chunking, questions, library
    and rewrite prompts, and keyword excerpts.
  - `summaries.py`, `questions.py` and `tasks.py` hold the command handlers for those features.
  - `exporter.py` ports `export.rs`: the same filenames, the same non-overwriting publish, and the
    summary and task sections.
  - `server.py` serves the API, events, files and the UI. Every API route needs a per-launch token
    that the server injects into `index.html`. Requests must come to `127.0.0.1` or `localhost`,
    which blocks DNS rebinding.
  - `app.py` runs uvicorn in a thread on a free loopback port and opens a pywebview window titled
    "OpenMeet", 1100x780, minimum 720x580. `--smoke` checks `/health` and `list_meetings`, prints
    OK and exits. `--data-dir` overrides the data folder.
- **Data.** `%APPDATA%\OpenMeetPy\meetings.db`. This build never reads or migrates the Rust
  profile's database. Keys are never in the database: a connection row holds only an internal
  account name that points at the credential store.
- **Outbound requests.** Every provider call goes through one `httpx` client with explicit timeouts
  (15 s for model lists, 120 s for chat), no redirects, no environment proxies, and a response size
  cap (4 MiB for model lists, 2 MiB for chat). A failed request is never retried and no other model
  is tried. Results are refused if the notes, transcript, speaker names, provider or thread changed
  while the request was in flight.
- **Packaging.** `py/requirements.txt` pins the wheels, including `keyring` and its Windows
  dependencies. `py/build.ps1` builds the UI, then runs PyInstaller one-file windowed to
  `py/dist/OpenMeet-py.exe`, bundling `py/web` and the migrations. No compiler is needed.

## Command status

Counts from `openmeet_py.commands`: 47 implemented, 31 answer HTTP 501, 78 in total, matching
`src/lib/api.ts`. `py/tests/test_commands.py` fails if the UI invokes a command the registry lacks.

| Status | Commands | Planned phase |
| --- | --- | --- |
| Implemented | list_meetings, get_meeting, create_note, save_notes, rename_meeting, set_meeting_tags, delete_meeting, search_meetings, export_meeting, choose_vault_folder, close_application, get_settings, save_export_options, save_setup_done | 1 |
| Implemented (phase 2) | save_api_connection, delete_api_connection, api_connection_key_status, save_provider_assignment, list_api_connection_models, provider_key_status, list_summaries, generate_summary, save_summary_edit, save_summary_instructions, save_summary_template, delete_summary_template, save_summary_default, save_processing_default, save_recipe, delete_recipe, save_speaker_names, ask_meeting, delete_question_thread, ask_library, list_library_answers, delete_library_answer, rewrite_text, save_action_item, delete_action_item, import_action_items | 2 |
| Implemented, idle or empty (honest, not faked) | get_recording_state, get_startup_warning, list_audio_devices, detection_supported, stt_status (not supported), audio_usage, get_session_processing (null) | 1 |
| 501: transcript editing and history (need transcripts, which no earlier phase writes) | edit_segment, get_transcript_version | 4 |
| 501: recording, pause, devices, audio files | start/pause/resume/stop_recording, save_default_devices, delete_audio, recover_audio, audio_position | 3 |
| 501: local and cloud speech, local models, downloads, server detection | save_stt_mode, save_stt_settings, stt_install, transcribe_meeting, cancel_transcription, choose_model_folder, scan_local_models, import_local_model, search/list/download hf and cancel_model_download, detect_local_servers | 4 |
| 501: shortcuts, detection, taskbar attention | save_settings, save_detection, set_detection_ignored, request_attention | 5 |
| 501: session processing workflow | acknowledge_processing_notes, retry_session_processing, cancel_session_processing | 5 |

Only the 31 commands in the 501 rows answer HTTP 501. Each one names its feature in the message.

## Phases

1. **Notes, shell, exe.** Notes CRUD, autosave with revisions, tags, search, settings that need no
   native features, Markdown export to a chosen folder, the window, `--smoke`, and the exe.
2. **AI connections, summaries, questions, tasks, library (done).** OpenAI-compatible HTTP through
   httpx. Keys in Windows Credential Manager through `keyring`. Speaker names, which need no
   transcript to save. Transcript-dependent paths (chunking, excerpts, staleness) are tested only
   with segment rows inserted directly, since no transcript can be created before phase 4.
3. **Microphone and system audio.** Research PyAudioWPatch and sounddevice wheels for WASAPI
   loopback. Write WAV files and timing indexes compatible with `src-tauri/src/audio_timing.rs`.
   Delete owned audio folders in `delete_meeting`.
4. **Local transcription and cloud STT.** Evaluate faster-whisper and sherpa-onnx wheels. Cloud
   STT over the same HTTP client as phase 2. Also `edit_segment` and `get_transcript_version`.
5. **Session workflow, meeting detection, tray, global shortcuts.** Detection only offers a prompt,
   as AGENTS.md requires.
6. **Frontend reorganisation.** Feature-Sliced Design as a separate, pure-move change.
7. **Hardware qualification.** Recording and transcription stay unqualified until this phase
   passes on real hardware: audible distinct tracks, paused audio excluded, device loss and sleep,
   and drift below 100 ms over 60 minutes.

## Known gaps and deliberate simplifications

- The `/files` route serves only the audio and export folders and never the database.
- `choose_vault_folder` needs pywebview's folder dialog. It is untested on a real desktop session.
- The Starlette test client shows a deprecation warning about httpx2. The tests still pass.
- Timestamps are UTC with microseconds. The Rust app's RFC 3339 output differs in digit count only.
- Question excerpts match keywords as substrings, in transcript order. The Rust app ranks full-text
  matches; with no transcripts before phase 4 the difference cannot show yet.
- No request can be cancelled. The Rust app's cancel flag has no counterpart here.
- One AI request runs at a time across the app; a second one is refused with `processing_busy`.
- Due dates are checked as ISO calendar dates with year 1 to 9999. The Rust app also accepts year 0000.
- The `keyring` credential backend is only exercised with an in-memory backend in tests. The
  Windows Credential Manager path has not been run on this PC.
