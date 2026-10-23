# Python desktop build: plan

Status: Phase 1 (notes, shell, exe) is built and checked on this PC. Recording, transcription and
every feature that needs native audio are unqualified until phase 7. Nothing in this build is a
replacement for the Rust app yet.

## Why

This PC has no Windows SDK and no MSVC, so `src-tauri/` cannot be compiled here. The owner chose a
separate Python build to keep working. It overrides AGENTS.md's "Rust owns audio, storage, native
integration" rule for this build only. The Rust app and `src-tauri/` are unchanged.

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
  - `commands.py` holds the handlers and the 501 registry. Arguments arrive camelCase and are
    converted to snake_case.
  - `exporter.py` ports `export.rs`: the same filenames, and the same non-overwriting publish.
  - `server.py` serves the API, events, files and the UI. Every API route needs a per-launch token
    that the server injects into `index.html`. Requests must come to `127.0.0.1` or `localhost`,
    which blocks DNS rebinding.
  - `app.py` runs uvicorn in a thread on a free loopback port and opens a pywebview window titled
    "OpenMeet", 1100x780, minimum 720x580. `--smoke` checks `/health` and `list_meetings`, prints
    OK and exits. `--data-dir` overrides the data folder.
- **Data.** `%APPDATA%\OpenMeetPy\meetings.db`. This build never reads or migrates the Rust
  profile's database.
- **Packaging.** `py/requirements.txt` pins the wheels. `py/build.ps1` builds the UI, then runs
  PyInstaller one-file windowed to `py/dist/OpenMeet-py.exe`, bundling `py/web` and the migrations.
  No compiler is needed. `proxy_tools`, a pure-Python dependency of pywebview, is built as a wheel
  by setuptools, which needs no C toolchain.

## Command status

Counts from `openmeet_py.commands`: 24 implemented, 54 answer HTTP 501, 78 in total, matching
`src/lib/api.ts`. `py/tests/test_commands.py` fails if the UI invokes a command the registry lacks.

| Status | Commands | Planned phase |
| --- | --- | --- |
| Implemented | list_meetings, get_meeting, create_note, save_notes, rename_meeting, set_meeting_tags, delete_meeting, search_meetings, export_meeting, choose_vault_folder, close_application, get_settings, save_export_options, save_setup_done | 1 |
| Implemented, idle or empty (honest, not faked) | get_recording_state, get_startup_warning, list_audio_devices, detection_supported, provider_key_status (unavailable), stt_status (not supported), audio_usage, get_session_processing (null), list_summaries ([]), list_library_answers ([]) | 1 |
| 501: summaries, questions, tasks, library, rewrite, recipes, summary templates and defaults, speaker names, transcript editing | generate_summary, save_summary_*, ask_*, delete_question_thread, delete/library answer, rewrite_text, save/delete_recipe, save/delete/import_action_item(s), save_speaker_names, edit_segment, get_transcript_version, save_processing_default | 2 |
| 501: AI provider connections and keys | save/delete_api_connection, api_connection_key_status, save_provider_assignment, list_api_connection_models | 2 |
| 501: recording, pause, devices, audio files | start/pause/resume/stop_recording, save_default_devices, delete_audio, recover_audio, audio_position | 3 |
| 501: local and cloud speech, local models, downloads, server detection | save_stt_mode, save_stt_settings, stt_install, transcribe_meeting, cancel_transcription, choose_model_folder, scan_local_models, import_local_model, search/list/download hf and cancel_model_download, detect_local_servers | 4 |
| 501: shortcuts, detection, taskbar attention | save_settings, save_detection, set_detection_ignored, request_attention | 5 |
| 501: session processing workflow | acknowledge_processing_notes, retry_session_processing, cancel_session_processing | 5 |

Only the 54 commands in the 501 rows answer HTTP 501. Each one names its feature in the message.

## Phases

1. **Notes, shell, exe (this build).** Notes CRUD, autosave with revisions, tags, search, settings
   that need no native features, Markdown export to a chosen folder, the window, `--smoke`, and the
   exe. Everything else returns 501.
2. **Summaries, questions, action items, library.** OpenAI-compatible HTTP through httpx. Keys in
   Windows Credential Manager through `keyring`. Read the phase-2 tables that phase 1 leaves empty.
3. **Microphone and system audio.** Research PyAudioWPatch and sounddevice wheels for WASAPI
   loopback. Write WAV files and timing indexes compatible with `src-tauri/src/audio_timing.rs`.
   Delete owned audio folders in `delete_meeting`.
4. **Local transcription and cloud STT.** Evaluate faster-whisper and sherpa-onnx wheels. Cloud
   STT over the same HTTP client as phase 2.
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
