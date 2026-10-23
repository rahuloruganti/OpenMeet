# Python desktop build: plan

Status: Phases 1 (notes, shell, exe) and 2 (AI connections, summaries, questions, tasks, library,
rewrite) are built and checked on this PC. Phase 3 (microphone and system-audio recording, WAV and
timing files, pause, recovery, audio deletion) is **built in code and checked with a fake backend
only. It is UNQUALIFIED.** Phase 4a (whisper.cpp transcription, cloud STT, transcript editing and
history, model library) is **built in code and checked with a fake engine, stub servers and
synthetic audio only. It is UNQUALIFIED: no real model has been loaded, no real speech has been
transcribed, and transcription quality, speed and parity with the Rust app are unverified.** Phase 7
still gates real use. Nothing in this build is a replacement for the Rust app yet.

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
  - **Phase 4a speech (built; unqualified):**
    - `stt_catalog.py` is generated from `src-tauri/src/stt/stt_models.rs` (33 whisper.cpp model
      entries pinned to Hugging Face commit `5359861c`), the sherpa-onnx sizes from `stt/sherpa.rs`,
      and the Silero VAD entry from `stt.rs`. The VAD URL names branch `main`; its SHA-256 is pinned.
    - `stt.py` holds status, settings validation (language, prompt of at most 500 characters with no
      control characters, model id), the explicit install (downloads only the VAD file and the
      selected model), and the speech command handlers. "Engine installed" means pywhispercpp imports;
      this build has no engine download.
    - `model_library.py` holds scan (Rust bounds: 4,096 entries, six levels, 200 models), import
      (source hashed before copying, the copy hashed again), Hugging Face search and listing (parsed
      defensively), and verified downloads. A download streams to a temporary file in the target
      folder, checks size and SHA-256, fsyncs, and publishes with `os.link`, so it never overwrites.
      HTTPS only to huggingface.co, *.huggingface.co or *.hf.co; no credentials; no environment
      proxies; redirects followed by hand (at most five), every hop checked. `OPENMEET_PY_TEST_HOSTS`
      replaces the host list (and allows plain HTTP) only when it is set, for stub-server tests.
    - `cloud_stt.py` ports `cloud_stt.rs`: 16-bit WAV chunks of at most 16 MiB (plus header) and 300
      seconds, split at pauses and generation changes, at most 200 requests, 4 MiB response cap, 120 s
      timeout, one multipart POST per chunk to `{base}/audio/transcriptions` with model,
      response_format, language (omitted when auto) and prompt. Each chunk is hashed before upload; a
      refused or changed request is never sent; nothing is retried.
    - `transcription/audio_read.py` reads the float32 WAV tracks (format tag 3, 32-bit, data size must
      match the recorded frames; truncated and unfinalized files are refused), mixes to mono, and
      resamples to 16 kHz with a numpy windowed-sinc (Kaiser) filter. Five-minute windows are read one
      at a time.
    - `transcription/engine.py` defines the `Engine` protocol, `WhisperCppEngine` (pywhispercpp,
      imported only inside its methods, constructed only from an existing absolute file path, VAD when
      the pinned file is present, `abort_callback` tied to the cancel event) and `FakeEngine` (selected
      by `OPENMEET_PY_FAKE_STT=1`).
    - `transcription/pipeline.py` ports the session-time mapping (`stt.rs` `session_ms`, same end-flag
      rule), marker filtering, per-track windows, merge and sort. `transcription/jobs.py` runs one
      transcription at a time on a worker thread; the request waits for it, so the UI's await resolves
      when the transcript is saved or the job fails. The transcript is replaced in one database
      transaction, and only if the settings are unchanged.
    - `transcript_edits.py` ports `transcript_edits.rs`: the previous transcript (edits included) is
      copied into `transcript_versions` before a replacement; `edit_segment` keeps the engine text in
      `original_text`, refuses a changed base text, and clears the edit on revert. Summaries become
      stale through the existing transcript hash.
  - `server.py` serves the API, events, files and the UI. Every API route needs a per-launch token
    that the server injects into `index.html`. Requests must come to `127.0.0.1` or `localhost`,
    which blocks DNS rebinding. Shutdown finalizes an active recording before the database closes.
  - `app.py` runs uvicorn in a thread on a free loopback port and opens a pywebview window titled
    "OpenMeet", 1100x780, minimum 720x580. `--smoke` checks `/health` and `list_meetings`, prints
    OK and exits. `--check-audio-import` imports PyAudioWPatch and prints its version. It never
    creates a PyAudio object, so no device is opened. `--check-stt-import` imports pywhispercpp and
    prints its version; it loads no model. `--data-dir` overrides the data folder.
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

Counts from `openmeet_py.commands` after phase 4a: 69 implemented, 9 answer HTTP 501, 78 in total,
matching `src/lib/api.ts`. `py/tests/test_commands.py` fails if the UI invokes a command the registry
lacks.

| Status | Commands | Planned phase |
| --- | --- | --- |
| Implemented | list_meetings, get_meeting, create_note, save_notes, rename_meeting, set_meeting_tags, delete_meeting, search_meetings, export_meeting, choose_vault_folder, close_application, get_settings, save_export_options, save_setup_done | 1 |
| Implemented (phase 2) | save_api_connection, delete_api_connection, api_connection_key_status, save_provider_assignment, list_api_connection_models, provider_key_status, list_summaries, generate_summary, save_summary_edit, save_summary_instructions, save_summary_template, delete_summary_template, save_summary_default, save_processing_default, save_recipe, delete_recipe, save_speaker_names, ask_meeting, delete_question_thread, ask_library, list_library_answers, delete_library_answer, rewrite_text, save_action_item, delete_action_item, import_action_items | 2 |
| Implemented (phase 3, unqualified: fake backend only) | get_recording_state, list_audio_devices, save_default_devices, start_recording, pause_recording, resume_recording, stop_recording, delete_audio, recover_audio, audio_position, audio_usage. Also `audio_health` and `recording_state` events, track rows in get_meeting, and owned-folder deletion in delete_meeting | 3 |
| Implemented, empty or unchanged (honest, not faked) | get_startup_warning, detection_supported, get_session_processing (null) | 1 |
| Implemented (phase 4a, unqualified: fake engine and stub servers only) | stt_status, save_stt_mode, save_stt_settings, stt_install, transcribe_meeting, cancel_transcription, edit_segment, get_transcript_version, choose_model_folder, scan_local_models, import_local_model, search_hf_models, list_hf_files, download_hf_model, cancel_model_download. Also `stt_progress` and `model_library_progress` events, and transcript provenance and versions in get_meeting. `save_speaker_names` was already implemented in phase 2 | 4 |
| 501: sherpa-onnx folder downloads and local AI server detection (phase 4b) | download_hf_folder, detect_local_servers | 4b |
| 501: shortcuts, detection, taskbar attention | save_settings, save_detection, set_detection_ignored, request_attention | 5 |
| 501: session processing workflow | acknowledge_processing_notes, retry_session_processing, cancel_session_processing | 5 |

Only the 9 commands in the 501 rows answer HTTP 501. Each one names its feature in the message.
The sherpa-onnx entries in the model list show as not installed, with a reason. They are a phase 4b
feature, and `save_stt_settings` refuses to select one with a message saying so.

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
4. **Local transcription and cloud STT (4a built, unqualified).** whisper.cpp through pywhispercpp
   1.5.1 (wheels only), the pinned model catalog and VAD, the model library, cloud STT, transcript
   editing and versions. Checked with fake engines, stub servers, MockTransport and synthetic audio.
   Not checked: a real model, real speech, quality, speed, or parity with the Rust app's whisper.cpp
   `b5454` (the bundled version is not stated in the pywhispercpp metadata).
   4b (not started): sherpa-onnx, sherpa folder downloads, local AI server detection.
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
- Phase 4a: the Python engine is pywhispercpp in-process, not the Rust app's whisper-cli subprocess.
  Cancel is checked between five-minute windows and inside the engine's abort callback; the Rust
  process kill is not reproduced. Windows are cut at their edges, so a sentence that crosses a window
  boundary can be split. Segments are not deduplicated across windows.
- Phase 4a: the Markdown export still writes "No transcript generated." for every meeting. The
  transcript rendering and the txt, srt and vtt files of `export.rs` are not ported yet.
- Phase 4a: `stt_status` reports the speech files as installed, without creating any file, when
  `OPENMEET_PY_FAKE_STT=1`. That mode is for tests and the browser check only.
- Phase 4a: a corrupt file already at the destination blocks a re-download with "already exists", as
  in the Rust app. Downloads never resume.
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
- Transcription (phase 4a) is **unqualified**: no real model has been run, so results are not verified
  for accuracy, speed, or parity with the Rust app. Downloads need an explicit Settings action and the
  pinned checksums. The Silero VAD URL points at the repository's `main` branch.
