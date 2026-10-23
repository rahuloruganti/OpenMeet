# Python desktop build: plan

Status: Phases 1 (notes, shell, exe) and 2 (AI connections, summaries, questions, tasks, library,
rewrite) are built and checked on this PC. Phase 3 (microphone and system-audio recording, WAV and
timing files, pause, recovery, audio deletion) is **built in code and checked with a fake backend
only. It is UNQUALIFIED.** Nothing here has recorded real audio. Transcription and every feature
that needs transcripts are unqualified until phase 4 and phase 7. Nothing in this build is a
replacement for the Rust app yet.

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
    run with foreign keys off, as in Rust. On startup it marks any meeting still `recording` or
    `paused` as `interrupted`.
  - `commands.py` holds the registry and the meeting, note and settings handlers. Arguments arrive
    camelCase and are converted to snake_case, so handler parameters are snake_case.
  - `context.py` holds the shared `Context` (store, events, recorder, the injectable HTTP transport,
    one AI request at a time) and argument checks. `reads.py` holds settings, meeting detail
    (including track rows), transcript lines and freshness hashes.
  - `connections.py`, `providers.py`, `keys.py`, `llm.py`, `summaries.py`, `questions.py`,
    `tasks.py`, `exporter.py`: phase 2, unchanged in phase 3.
  - **Phase 3 audio:**
    - `audio_wav.py` writes and checks the files. It writes a 32-bit float WAV (format tag 3, a fact
      chunk, data chunk last, sizes patched on finalize, fsync). It writes one timing line per block
      in the exact `audio_timing.rs` format. It validates timing indexes (the rules of
      `audio_timing.rs`: line size, file size, contiguous offsets, overlap tolerance 30 ms, total
      frames). It maps session time to file position (`stt.rs` `file_ms`). It repairs an unfinished
      WAV into a new copy (`repair_wav`, never overwriting, original only read). It computes peaks
      and cleans non-finite or out-of-range samples.
    - `audio_backend.py` defines the `CaptureBackend` protocol. `FakeBackend` makes synthetic tones
      (440 Hz mono "microphone", 660 Hz stereo "output") or silence, and offers failure hooks for
      tests. `PortAudioBackend` wraps PyAudioWPatch. The library is imported only inside its methods,
      so building the backend imports nothing. `make_backend()` returns the fake backend only when
      `OPENMEET_PY_FAKE_AUDIO=1`.
    - `recorder.py` holds the state machine. One session at a time, with a `revision` on every
      transition. The backend callback only copies a block into a bounded queue (`put_nowait`),
      tagged with a generation. A writer thread per session owns the files. It writes only blocks of
      the current generation, and it finalizes on the stop marker. A meter thread per session polls
      stream errors and sleep gaps, pauses on a fault, and emits `audio_health` about 5 times a second.
      Lock order: recorder lock, then store lock.
    - `recording.py` holds the command handlers: devices, start, pause, resume, stop, state, delete,
      recovery, seeking, usage.
  - `server.py` serves the API, events, files and the UI. Every API route needs a per-launch token
    that the server injects into `index.html`. Requests must come to `127.0.0.1` or `localhost`,
    which blocks DNS rebinding. Shutdown finalizes an active recording before the database closes.
  - `app.py` runs uvicorn in a thread on a free loopback port and opens a pywebview window titled
    "OpenMeet", 1100x780, minimum 720x580. `--smoke` checks `/health` and `list_meetings`, prints
    OK and exits. `--check-audio-import` imports PyAudioWPatch and prints its version. It never
    creates a PyAudio object, so no device is opened. `--data-dir` overrides the data folder.
- **Data.** `%APPDATA%\OpenMeetPy\meetings.db`, with audio in `%APPDATA%\OpenMeetPy\audio\<meeting
  id>\` (`mic.wav`, `mic.timing.jsonl`, `system.wav`, `system.timing.jsonl`). This build never reads
  or migrates the Rust profile's database. Keys are never in the database: a connection row holds
  only an internal account name that points at the credential store.
- **Outbound requests.** Every provider call goes through one `httpx` client with explicit timeouts
  (15 s for model lists, 120 s for chat), no redirects, no environment proxies, and a response size
  cap (4 MiB for model lists, 2 MiB for chat). A failed request is never retried and no other model
  is tried. Results are refused if the notes, transcript, speaker names, provider or thread changed
  while the request was in flight.
- **Packaging.** `py/requirements.txt` pins the wheels, including `keyring`, `PyAudioWPatch==0.2.12.9`
  and `websockets==15.0.1`. Pip installs with `--only-binary=:all:`, so no compiler is needed.
  `py/build.ps1` builds the UI, then runs PyInstaller one-file windowed to `py/dist/OpenMeet-py.exe`,
  bundling `py/web`, the migrations, and the collected `pyaudiowpatch` and `websockets` packages.

## Recording (phase 3): behaviour and limits

Ported from `audio.rs`, `audio_timing.rs`, `session_runtime.rs` and the recording parts of
`storage.rs`/`lib.rs`:

- Start creates the meeting (`source` desktop, status `recording`), a notes row, and two track rows.
  It resolves both devices before creating any file. A missing device, a bad format, or a failed
  stream open leaves no files and no rows. A failure on the second track stops the first one. There
  is no one-track fallback and no silent device switch.
- Stop drains the queue, finalizes both WAVs and indexes, then records frames, dropped frames and
  `finalized` per track. The meeting becomes `stopped`, or `interrupted` with the error text if
  anything faulted. Stop with nothing running returns the current state. A second Stop is harmless.
- Pause stops the streams, bumps the generation (so queued and in-flight blocks of the old
  generation are discarded), and checkpoints the files. Resume re-resolves both devices, refuses a
  changed format, opens new streams, and bumps the generation again.
- Faults pause the recording and keep the files: queue overflow, a device that stops responding,
  a disk write or finalize failure, a writer that stops responding, and a sleep or scheduling gap of
  more than 2 seconds. The error text is the Rust text. `interrupted` is set on the meeting.
- Startup marks an unfinished recording `interrupted`. `recover_audio` writes repaired copies of
  unfinalized tracks (whole frames, new name, original untouched). `delete_audio` and
  `delete_meeting` remove the meeting's tracked files and any other regular file in its folder, and
  refuse while the meeting is recording. Nothing outside the meeting's folder is touched.
- `audio_position` maps transcript time to file time through the timing index, as `stt.rs` does.
- Revision ordering: every transition increments `revision` and publishes `recording_state` with the
  full state. Events are notifications only. Commands always return the authoritative state.

Deliberate differences from the Rust app:

- **System track includes all output, including OpenMeet's own playback.** PyAudioWPatch loopback
  records everything the chosen output plays. The Rust app excludes OpenMeet's own output. The
  Python build cannot exclude it with this library. The device label says so:
  `"<device> (all audio, includes OpenMeet playback)"`. Anything OpenMeet plays (for example a
  future playback feature) would be recorded as "Others" speech. The user must know this.
- **Device ids are not stable across hardware changes.** An id is built from the device name, with
  the PortAudio index only as a tiebreaker for duplicate names (`mic:USB Mic#4`). If two identical
  devices are swapped, or the driver renames a device, the saved id no longer matches, and start
  fails visibly with "unavailable". It never substitutes another device. Ids are re-resolved at
  every start and resume.
- **Timestamps come from counted frames.** Each stream run is anchored once to the host clock at its
  first callback, minus that block's duration. Later blocks advance by their frame count, so jitter
  cannot make them overlap. A new run never starts before the previous block ends. The device's own
  clock is not used. Clock accuracy is unverified.
- **Allocation.** Each callback copies the device buffer into a new `bytes` object (PyAudio already
  makes one; the peak computation makes a float array). The Rust app uses a preallocated ring. The
  callback is therefore not allocation-free. Its real-time behaviour is unmeasured.
- **Pause drops queued audio.** Blocks already queued but not yet written when pause starts are
  discarded, as in the Rust app. The last block or two before a pause may be lost.
- **Window close during recording** finalizes the files and marks the meeting `stopped` with no
  error. A process crash leaves `interrupted`, recoverable with `recover_audio`.
- Not ported: the Rust "timestamps moved backwards" fault (monotonic host time is used instead), the
  macOS capture path, and `live_audio` (live transcription is phase 4).
- Automatic processing after recording (session workflow) is phase 5. `processing_notice` is always
  null.

## Command status

Counts from `openmeet_py.commands` after phase 3: 55 implemented, 23 answer HTTP 501, 78 in total,
matching `src/lib/api.ts`. `py/tests/test_commands.py` fails if the UI invokes a command the registry
lacks.

| Status | Commands | Planned phase |
| --- | --- | --- |
| Implemented | list_meetings, get_meeting, create_note, save_notes, rename_meeting, set_meeting_tags, delete_meeting, search_meetings, export_meeting, choose_vault_folder, close_application, get_settings, save_export_options, save_setup_done | 1 |
| Implemented (phase 2) | save_api_connection, delete_api_connection, api_connection_key_status, save_provider_assignment, list_api_connection_models, provider_key_status, list_summaries, generate_summary, save_summary_edit, save_summary_instructions, save_summary_template, delete_summary_template, save_summary_default, save_processing_default, save_recipe, delete_recipe, save_speaker_names, ask_meeting, delete_question_thread, ask_library, list_library_answers, delete_library_answer, rewrite_text, save_action_item, delete_action_item, import_action_items | 2 |
| Implemented (phase 3, unqualified: fake backend only) | get_recording_state, list_audio_devices, save_default_devices, start_recording, pause_recording, resume_recording, stop_recording, delete_audio, recover_audio, audio_position, audio_usage. Also `audio_health` and `recording_state` events, track rows in get_meeting, and owned-folder deletion in delete_meeting | 3 |
| Implemented, empty or unchanged (honest, not faked) | get_startup_warning, detection_supported, stt_status (not supported), get_session_processing (null) | 1 |
| 501: transcript editing and history (need transcripts) | edit_segment, get_transcript_version | 4 |
| 501: local and cloud speech, local models, downloads, server detection | save_stt_mode, save_stt_settings, stt_install, transcribe_meeting, cancel_transcription, choose_model_folder, scan_local_models, import_local_model, search/list/download hf and cancel_model_download, detect_local_servers | 4 |
| 501: shortcuts, detection, taskbar attention | save_settings, save_detection, set_detection_ignored, request_attention | 5 |
| 501: session processing workflow | acknowledge_processing_notes, retry_session_processing, cancel_session_processing | 5 |

Only the 23 commands in the 501 rows answer HTTP 501. Each one names its feature in the message.

## Phases

1. **Notes, shell, exe.** Notes CRUD, autosave with revisions, tags, search, settings that need no
   native features, Markdown export to a chosen folder, the window, `--smoke`, and the exe.
2. **AI connections, summaries, questions, tasks, library (done).** OpenAI-compatible HTTP through
   httpx. Keys in Windows Credential Manager through `keyring`. Speaker names, which need no
   transcript to save. Transcript-dependent paths (chunking, excerpts, staleness) are tested only
   with segment rows inserted directly, since no transcript can be created before phase 4.
3. **Microphone and system audio (built; unqualified).** PyAudioWPatch 0.2.12.9 for both tracks.
   Files and indexes as above. Fake-backend tests cover writer, queue overflow, pause boundaries,
   WAV and index rules, failures and file handling. `py/tests/test_hardware_audio.py` is an opt-in
   real-device test that has **not been run**.
4. **Local transcription and cloud STT.** Evaluate faster-whisper and sherpa-onnx wheels. Cloud
   STT over the same HTTP client as phase 2. Also `edit_segment` and `get_transcript_version`.
5. **Session workflow, meeting detection, tray, global shortcuts.** Detection only offers a prompt,
   as AGENTS.md requires.
6. **Frontend reorganisation.** Feature-Sliced Design as a separate, pure-move change.
7. **Hardware qualification.** Recording and transcription stay unqualified until this phase
   passes on real hardware. Nothing below has been run.

### Phase 7 manual qualification protocol

Run only with the owner's explicit authorization, on the target Windows machine, with the Python
build from `py/dist/OpenMeet-py.exe`. Record each result with date, device names and the file
evidence.

1. **Device enumeration.** Microphones and output loopbacks list with the expected names. The
   loopback labels carry the "includes OpenMeet playback" text.
2. **Hardware test.** `py\.venv\Scripts\python.exe -m pytest -m hardware` with
   `OPENMEET_PY_HARDWARE_AUDIO=1` set. It records about 3 seconds from the first microphone and the
   first output. A missing device fails the test. It does not prove audibility.
3. **Distinct tracks.** Speak into the microphone while playing a known tone or speech through the
   output. Open each WAV in an audio editor. Confirm that the microphone file has the voice and not
   the tone, and that the system file has the tone and not the voice.
4. **Pause privacy.** Record with a distinct sound during a pause. Confirm the sound is absent from
   both files and that the timing index skips the pause.
5. **Device loss and switch.** Unplug or disable the microphone mid-recording. Confirm the recording
   pauses with the device error and the files are kept. Confirm the saved id does not silently switch
   to another device on resume.
6. **Sleep and wake.** Suspend the machine mid-recording and wake it. Confirm the recording pauses
   with the sleep message and the files finalize on stop.
7. **Long run.** Record 60 minutes with a steady tone on both tracks. Measure the drift between the
   track clocks and the wall clock against the 100 ms target, using the timing index and the start and
   stop times. Record the measured value, even if it fails.
8. **Recovery.** Kill the process mid-recording. Restart. Confirm the meeting shows `interrupted`, and
   that `recover_audio` writes a playable copy with whole frames and leaves the original unchanged.

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
- Recording (phase 3): see "Recording (phase 3): behaviour and limits" above for the loopback
  limitation, the id weakness, the timing source, the allocation and pause-drop behaviour.
- Recording unqualified: the fake-backend tests do not establish audible content, pause privacy with
  real callbacks, device behaviour, or clock accuracy. The browser check used synthetic tones only.
- `websockets` was missing from the first phase-3 build, so events never reached the page. It is now
  pinned and collected. The exe was not run end-to-end in a window; its WebSocket path is checked
  only by the venv server run.

## Notes for Python-build users

These notes are for this build only. `docs/user-guide.md` describes the Rust app and is not changed.

- Recording is **unqualified**. Do not rely on it for an important meeting until phase 7 passes.
- The system track records **everything the chosen output plays, including OpenMeet itself.**
  Choose an output that carries only the meeting audio, or mute other sounds during a recording.
- If a microphone or output is unplugged, renamed, or replaced, the recording cannot start with
  the old selection. Refresh devices and choose again. The build never switches devices by itself.
- Paused audio is not saved. Audio captured in the moment just before a pause may be lost.
- Recordings live in `%APPDATA%\OpenMeetPy\audio\<meeting>\`. Deleting a meeting deletes those files.
- Transcription is not available in this build until phase 4.
