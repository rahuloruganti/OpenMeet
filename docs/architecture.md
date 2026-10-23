# OpenMeet architecture

OpenMeet runs a React interface inside a Tauri 2 desktop app. Rust owns the database, audio capture, model files, transcription subprocess, network requests, and credentials. React renders state and issues typed commands.

## Runtime flow

```mermaid
flowchart LR
    UI[React workspace] -->|Tauri commands| Backend[Rust command handlers]
    Backend --> Core[Core and SQLite]
    Backend --> Capture[Windows capture worker]
    Capture --> Files[Local WAV and timing files]
    Backend --> STT[Local speech subprocess (whisper.cpp or sherpa-onnx)]
    Files --> STT
    STT --> Core
    Backend -->|Meeting text| LLM[Configured LLM API]
    LLM --> Core
    Backend -->|Audio chunks| Cloud[Configured speech API]
    Files --> Cloud
    Cloud --> Core
    Backend --> Export[Markdown snapshots]
    Backend -->|Events| UI
```

Model downloads are separate explicit network actions. Cloud transcription uploads audio when you transcribe or when the saved automatic-processing default runs; local Whisper remains the default. Summary/question calls send text only. The diagram does not establish hardware or provider qualification.

## Code ownership

The React code in `src/` is organised as Feature-Sliced Design layers: `app`, `widgets`, `features`, `entities` and `shared`. Each widget, feature and entity exports a public `index.ts`. The layer map and the remaining cross-layer imports are in [python-port-plan.md](python-port-plan.md#frontend-layout-phase-6-behaviour-and-limits).

| File or directory                                          | Responsibility                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/app/App.tsx`                                              | Selection, settings/setup panels, command orchestration, operation guards, and note lifecycle.          |
| `src/widgets/meeting-sidebar/MeetingSidebar.tsx`                        | Meeting library, source labels, title and content search.                                               |
| `src/widgets/meeting-workspace/MeetingWorkspace.tsx`                      | Notes, transcript, playback, summaries, questions, export, and deletion confirmations.                  |
| `src/widgets/library-question/LibraryQuestion.tsx`                       | Ask across meetings: scope picker, recipes, saved answers with validated `[M2 1:01]` source links. |
| `src/features/recipes/Recipes.tsx` | Built-in and saved recipes: question-box chips and the Settings editor. |
| `src/features/rewrite-selection/RewriteSelection.tsx` | Rewrite selected note text: presets and accept-to-replace result. |
| `src/widgets/setup-panel/SetupPanel.tsx`                              | Device selection and the automatic-processing default shown before start.                                                                           |
| `src/widgets/settings-panel/SettingsPanel.tsx` | Settings left navigation and sections: recording defaults, automatic processing and shortcut capture, AI notes, the local model library, export and storage, privacy and about. |
| `src/features/transcription-settings/TranscriptionSettings.tsx` | Engine choice cards (On this computer, API connection), local Whisper or sherpa-onnx setup and downloads, speech API assignment, language and vocabulary. |
| `src/features/provider-settings/ProviderSettings.tsx` | One list of saved connections (badged This device / Leaves this device) and the per-task `Assignment`. |
| `src/widgets/recording-controls/RecordingControls.tsx`                     | Backend capture state, pause/resume/stop, and audio meters.                                             |
| `src/shared/api/api.ts`                                           | TypeScript command bindings, response types, events, and asset URLs.                                    |
| `src/features/note-writer/note-writer.ts`                                   | Debounced and serialized note writes with flush and error handling.                                     |
| `src/shared/lib/markdown.tsx`, `timestamps.ts`                    | Supported Markdown rendering and timestamp parsing.                                                     |
| `src-tauri/src/lib.rs`                                     | Tauri handlers, shared state, worker dispatch, events, tray, shortcuts, and graceful exit.              |
| `src-tauri/src/domain.rs`                                  | Rust payloads, settings, recording state, and error codes.                                              |
| `src-tauri/src/storage.rs`                                 | `Core`, SQLite migrations, persistence, search, capture lifecycle, deletion, and recovery metadata.     |
| `src-tauri/src/audio.rs`                                   | Device enumeration, bounded sample queues, capture worker, WAV writers, timing indexes, and WAV repair. |
| `src-tauri/src/live_audio.rs`                              | Bounded accepted-sample live chunks and owned finalized temporary tracks. |
| `src-tauri/src/processing_control.rs`                      | Shared manual/automatic operation ownership, cancellation, and publication gate. |
| `src-tauri/src/session_processing.rs`, `session_workflow.rs` | Plans from the saved default, durable runs/stages, provisional text, accounting, notes acknowledgement, and retry. |
| `src-tauri/src/session_runtime.rs`                         | Rust live/final/summary runner outside the Core lock. |
| `src-tauri/src/stt.rs`                                     | Pinned artifact downloads, local engine execution, progress/cancel, and time mapping.                   |
| `src-tauri/src/providers.rs`                               | URL/model validation, keychain access, frozen credentials, model discovery, and bounded HTTP.           |
| `src-tauri/src/llm.rs`                                     | Summary/question/library prompts, input limits, and chunked text requests.                              |
| `src-tauri/src/retrieval.rs`                               | Pure keyword retrieval for questions over content too long for one request: terms, quoted FTS5 query, excerpt selection. |
| `src-tauri/src/cloud_stt.rs`                               | Frozen bounded WAV preparation, pause-aware chunks, multipart uploads, and timed/untimed parsing.       |
| `src-tauri/src/export.rs`                                  | Markdown rendering, optional TXT/SRT/VTT transcripts, safe filenames, and non-overwriting publication.  |
| `src-tauri/src/action_items.rs`                            | Editable meeting tasks, validation, and explicit imports from a summary's Action items section.         |
| `src-tauri/src/meeting_detection.rs` | Opt-in meeting detection: reads the Windows microphone privacy store, or on macOS the CoreAudio process objects (`kAudioHardwarePropertyProcessObjectList`, running input, PID, bundle ID, via direct FFI), every 3 s on a thread gated by an `AtomicBool`, debounces over two polls, and emits `microphone_apps`. Never starts capture. |
| `src-tauri/src/question_threads.rs` | Saved question threads and turns: store, append, list, and delete. |
| `src-tauri/src/library_answers.rs` | Saved answers across meetings: store with ordered scope, list, and delete. |
| `src-tauri/src/recipes.rs` | Saved question recipes: validate, store, edit, and delete. |
| `src-tauri/migrations/`                                    | Ordered SQLite upgrades through schema v27.                                                             |
| `fixtures/`                                                | Fictional test resources, excluded from production creation paths.                                      |

## State and concurrency

`AppState` owns a mutex-protected `Core`. `with_core` runs database and lifecycle operations on a blocking worker. Other blocking operations, such as inference and HTTP requests, also run outside the webview thread.

The backend's `RecordingState` contains a monotonically increasing revision, status, meeting ID, source, error, and optional audio-derived offset. The frontend uses revisions to avoid replacing newer state with an older response. Commands return authoritative state; events notify the frontend to refresh.

Capture status is `idle`, `recording`, `paused`, or `stopped`. A persisted meeting can also be `interrupted`. New meetings are `note` or `desktop`; legacy `simulation` and `fixture` sources stay readable and honestly labeled. Their creation commands and production fixture loading are removed.

There is one active capture. `Core` owns a cloneable `processing_control::Owner` shared by manual transcription, summaries, questions, and automatic operations. Each heavy operation gets a cancellation guard. Cancellation and publication share the owner gate, followed by Core revalidation. The lock order is Owner then Core at publication; the runner clones Owner under Core and releases Core before taking the owner lock. Inference and HTTP run outside Core. A busy operation can leave live coverage incomplete while capture continues. Final-stage contention fails visibly and requires explicit retry. Durable workflow stages survive restart as interrupted records; startup does not resume inference or replay HTTP.

## Notes and close behavior

`createNoteWriter` debounces edits for 400 ms and serializes saves. The database updates notes only when the supplied revision matches the saved revision. A stale write fails instead of replacing newer text.

Meeting switches, exports, and graceful close flush notes. A failed flush preserves the draft and prevents graceful quit. Stop requests capture shutdown before waiting for note saving, so a save failure does not keep recording intentionally active.

## Capture and transcription

Windows capture opens the explicitly selected microphone and, for the system track, a process-loopback client (`app_loopback.rs`, `wasapi` crate) that records every app except OpenMeet's own process tree at 48 kHz stereo on its own reader thread, independent of the render endpoint. Callbacks enqueue samples into bounded buffers. A worker writes separate native-rate WAV files and timing JSONL. Pause generations reject queued samples from an earlier recording interval. Queue overflow and device failures are visible errors, not a fallback to one track.

Control acknowledgements and real-device timing remain stabilization work. Synthetic pause tests do not qualify hardware pause privacy. Process loopback may deliver no frames while no app plays audio. Device packet timestamps jitter by about ±11 ms; the shared timing reader lays packets within 30 ms end to end and keeps larger gaps.

Local transcription runs the downloaded Windows x64 CPU build of whisper.cpp with the selected model, Silero VAD, language, and vocabulary hint. Selecting a sherpa-onnx model (`sherpa:parakeet-v3`, `sherpa:moonshine-base-en`, `sherpa:sense-voice`) runs the pinned sherpa-onnx Windows x64 runtime with that model and its own pinned Silero VAD file. Those paths are wired and unit-tested; real-engine transcription is not yet verified. A downloaded sherpa-onnx folder under `sherpa/custom/<name>` is selected as `sherpa-dir:<name>`; the name is validated as one plain folder name, and its engine flags come from the same layout rules that offered it (`model_library::sherpa_layout`). Only a single-model folder is passed as SenseVoice. Running it is also unverified. Cloud mode independently selects a compatible endpoint/key/model and uploads frozen PCM16 WAV chunks after confirmation. Chunk boundaries respect pause generations and timing discontinuities. Both modes preserve `You` and `Others` track labels.

The `audio_timing` module validates bounded timing indexes for local transcription, cloud preparation, and mapped seeking. Local processing rejects incomplete timing before engine setup. Segment starts and ends map to opposite sides of a pause boundary, so a pre-pause segment does not extend through the gap. Damaged indexes produce visible errors instead of file-time guesses.

The transcription run guard covers preparation, processing, and publication. Cancellation and final publication share a gate. A successful transaction replaces prior local/cloud generated segments and stores provider/model provenance, including successful empty results. Failure/cancellation preserves the previous transcript and notes. Valid timestamps map through the original timing index. JSON text without timestamps is explicitly untimed, grouped by track, and has no seek link or fabricated time citation.

## Live and final processing

After successful track writing and generation validation, `audio.rs` copies accepted samples into `live_audio` accumulators. Callbacks retain their existing allocation-light queues and do no inference or filesystem work. Live chunks target ten seconds, with a 1,000,000-sample cap and a 4,096-entry timing cap per accumulator. A fixed recording packet bounds the input granularity. Chunks seal on pause, generation changes, discontinuities, and stop. A nonblocking channel holds at most three sealed chunks across both tracks. Saturation discards the live copy and marks incomplete coverage; it does not backpressure capture.

The runner materializes a chunk as an owned temporary finalized WAV and timing index. It reuses local/cloud transcription and original session timing. Pausing blocks new dispatch; already submitted accepted pre-pause audio may finish. Stop cancels in-flight live ownership and drops pending live work before final processing. Live-only stop marks completion while retaining explicitly provisional output.

Provisional IDs include run, track, chunk, and segment index. SQLite retains at most 200 rows and rejects growth beyond its bounded preview byte allowance. The UI also deduplicates and limits rendering to 200, with timed or untimed track labels. Snapshots carry a revision, and selection/reconnect fetch authoritative state. Processing notifications never replace the note editor or its writer.

All stop entry points converge on Core's durable stop transaction. Valid finalized tracks advance to final transcription. A successful transaction replaces authoritative segments/provenance, removes provisional rows, and records final completion together. Failure preserves earlier authoritative output and original audio.

Automatic summary waits for `acknowledge_processing_notes`. The frontend flushes only the writer belonging to the stopped capture meeting, then sends its persisted revision with the run ID and stop/retry barrier. An unselected meeting uses its saved revision. Failed saves preserve drafts and require explicit acknowledgement retry. The backend freezes saved notes, requires the final transcript, and refuses summary publication if either notes or transcript changed during the request. Summary history survives failure and cancellation. Graceful quit flushes notes before stopping capture and durably interrupting processing.

## Provider requests

The Phase 3 modules implement automatic processing and workflow execution. `start_desktop` turns the saved default into a plan with `prepare_session_processing`: live-only or final transcription, optional live processing and summary, independent destinations, two tracks, language, and finite limits. The plan is attached atomically with recording publication; if it cannot be built, the recording starts without it and `RecordingState.processing_notice` says why. There is no review or participant-consent step (removed 2026-10-22). The default is recording only.

Default limits are a 14,400-second recording horizon, 14,400 seconds after stop, 256 MiB uploaded audio, 1,000 requests, and 800,000 UTF-8 text bytes. The initial deadline covers the recording horizon plus the post-stop allowance. Shared stop publication reduces it to the actual stop plus that allowance. Longer recordings are not processed automatically. Retry rejects recorded durations beyond the plan horizon, builds a plan from current settings, identifies the existing stopped meeting, creates a fresh run/attempt and notes barrier, and receives fresh finite limits. A completed final transcript can be retained while retry resumes summary work. A stopped live-only preview uses manual transcription rather than live replay.

Before each operation and actual HTTP send, the runner revalidates run, stage, configuration revision, deadline, and scope. Cloud speech reserves the frozen audio digest and byte count before each send. Chat requests reserve the exact serialized JSON body's digest and UTF-8 byte count, including combination requests. Reservation and counters commit before dispatch, with no refund for an uncertain remote result. Cancellation or changed configuration prevents later dispatch/publication. There is no automatic billable retry or model fallback.

Speech settings and provider edits invalidate unsent work, including edit-and-revert and key replacement. Schema 14 invalidates older prepared plans rather than reinterpreting their historical character budgets as byte budgets. Startup marks unfinished stages interrupted, preserves completed output, and starts no request. The plan metadata excludes secrets and meeting content; separate workflow rows include provisional text and the saved-note snapshot used by a summary.

Reusable saved connections supply independent summary/question and speech task assignments. Each assignment keeps its own model ID and revision; changing a shared connection invalidates unsent work for every role using it. Assigned connections cannot be deleted. Rust appends `models`, `chat/completions`, or `audio/transcriptions` to a validated user-supplied HTTPS API base, preserving its path prefix. Redirects are disabled. Credentials and response bodies do not enter diagnostics. Local servers may use loopback HTTP with an optional key. Remote endpoints require HTTPS and a destination-bound key.

Settings submits a transient password input through IPC to the OS keychain. Read responses contain key status only. Saving connection/model settings makes no network request; explicit refresh fetches generic `data[].id` model lists. Custom IDs work without discovery or catalog membership. A model list proves neither chat nor audio capability. Legacy Merge configuration is not automatically activated or converted.

The summary planner chooses a single request or transcript chunks followed by a combination request. Each request binds the configuration revision and destination, model, exact content, action, the fully resolved summary prompt (including custom template and saved instructions) or question, and request plan; a change before dispatch stops it. Automatic summary plans freeze saved instructions when the recording starts. Oversized inputs are refused. Summary versions persist with destination, model, and template ID. Questions use only the selected meeting. When the full notes and transcript (or the full library scope) exceed `MAX_SUMMARY_INPUT_CHARS`, `question_content` and `library_scope` switch to excerpt mode instead of refusing. `retrieval::terms` lowercases letter/digit words and drops words under 3 characters, stopwords and duplicates (at most 12). `fts_query` quotes every term, doubling embedded quotes, into `body : ("a" OR "b")`. `Core::transcript_hits` queries the `search` FTS5 table for kind `transcript` rows of the in-scope meetings ordered by bm25 (at most 100; rowids are segment ids, mapped through `segment_meta`). `retrieval::select` fills hits in rank order with two neighbouring lines per side until the byte budget, skipping any window that does not fit so no line is cut, and `excerpt_lines` restores transcript order with a `…` gap marker. Notes are sent whole if they fit a quarter of the budget, otherwise only matching paragraphs, and only when they mention a term. With no transcript hit and no notes match the command returns `insufficient_evidence` before any request; the UI shows it as a status message and no turn is stored. The request digest binds the selected notes and lines (not the unselected remainder), the excerpt summary gives the segment and meeting counts, and the same selection is recomputed from stored data at send time. The prompt gains an excerpts note before `RULES`. Retrieval is lexical only. `plan_library_question` and `ask_library` answer one question over an explicit, deduplicated list of 1 to 20 meeting ids (a tag is resolved to ids in the UI): each meeting is sent as a `<meeting ref="M1" title=...>` block with its notes and speaker-named transcript lines under `LIBRARY_PROMPT` (cite `[M2 1:01]` or `[M2]`, say when evidence is insufficient). The request digest binds the question, the ids in order, and each meeting's title, start date, notes revision, notes and transcript lines; any change before sending or before returning the answer yields `processing_plan_changed`. It is one request under the single-request budget. Answers are stored in `library_answers` with their ordered meeting ids in `library_answer_meetings` (schema v24); a trigger deletes an answer when any of its meetings is deleted. `plan_rewrite` and `rewrite_text` send only selected note text (at most 20,000 characters) and a request under `REWRITE_PROMPT`; the request digest covers both, and the result is returned for the UI to apply, never stored. Recipes (`recipes`, schema v24) are saved question text returned in `Settings`; built-in recipes live in `src/features/recipes/Recipes.tsx`. The UI links `[M2 1:01]` only when M2 was in the scope sent and a timed segment of that meeting starts in that second. Each answered question is stored in `question_threads` and `question_turns` (schema v22, cascading with the meeting). A follow-up names a thread of that meeting and sends its latest 6 turns, within a character budget, as untrusted `<previous>` context; those turns are part of the request digest, so a turn added after the request is prepared invalidates it, and oversized context is refused instead of truncated. The turn is stored only after a successful answer is published; failures and cancellations store nothing. Cloud audio requests additionally bind frozen chunk content/timing hashes. Automatic uploads use the plan attached when the recording started. Manual cloud transcription sends when you trigger it. No provider fallback or automatic billable retry is performed.

The Rust `model_library` module owns bounded scans, verified catalog imports, public Hugging Face metadata, pinned downloads, and provenance manifests. It shares an artifact-operation guard and cancellation/publication gate with the existing speech installer. Discovery does not activate a model or start inference. `model_library_progress` reports transfer bytes. A scan canonicalizes each selected root and follows a linked directory only while it resolves inside that root, so a selected junctioned folder and a junction inside it are read, while a link that leaves the root is refused; a link loop is bounded by the depth and entry limits and a file reached twice is reported once. See [Phase 2 verification](phase-2-settings-verification.md) for limits.

## Storage and migrations

| Table                      | Contents                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `meetings`                 | Title, source, timestamps, persisted status, and capture error.                       |
| `notes`                    | User Markdown and optimistic revision.                                                |
| `tracks`                   | Paths, audio format, frame counts, dropped frames, and finalization.                  |
| `segments`                 | Track label, paired nullable times, text, source, and final pass.                     |
| `summaries`                | Versions with provider, model, template ID, edited-from version, and transcript hash. |
| `settings`                 | Devices, shortcuts, local speech settings, speech mode, export, summary instructions. |
| `summary_templates`        | Custom summary template names and structure text; IDs are `custom-<uuid>`.            |
| `transcript_versions`      | Read-only copies of replaced transcripts, including edits, with engine provenance.    |
| `speaker_names`            | Optional per-meeting display names for the You/Others labels.                         |
| `meeting_tags`             | User-created tags per meeting, case-insensitive, cascading with the meeting.          |
| `action_items`             | Tasks with nullable owner/due date, done state, source, and original summary bullet.  |
| `saved_connections`        | Named nonsecret endpoint/revision and OS-keychain account reference.                  |
| `provider_assignments`     | Independent task connection/model selection and monotonic revision.                   |
| `processing_configuration` | Revision that stops running work after speech/provider edits.                         |
| `processing_sessions`      | Recording-bound processing plan, deadlines, state, and revision.                      |
| `processing_runs`          | Run/attempt/stage, completeness, completed transcript flag, saved-note barrier/snapshot, and counters. |
| `processing_requests`      | Reserved request digests and audio/text byte accounting. |
| `processing_provisional`   | Bounded live segments, separate from authoritative transcript/search/export tables. |
| `meeting_transcriptions`   | Last successful provider/model provenance per meeting.                                |
| `search`                   | FTS5 copies of titles, notes, transcript text, and summaries.                         |
| `capture_events`           | Historical schema table; current capture no longer writes lifecycle events here.      |

`Core::open` enables WAL and applies numbered migrations using `PRAGMA user_version`. Table rebuilds that need foreign keys disabled perform a foreign-key check before committing. Migration 011 preserves segment IDs and restores FTS triggers while adding cloud/untimed entries. Migration 012 copies existing provider profiles and credential references into saved connections and assignments without reading secrets. Populated upgrade tests cover notes, transcripts, search, and foreign keys. Existing user databases are upgraded without resetting them. After migrating, it builds the expected schema in memory and fails with `schema_inconsistent`, naming every missing table or column, when a database's version claims migrations that never ran. Extra leftover columns are allowed. Legacy `local_model`/`merge_model` columns remain unused.

Migration 014 adds workflow, request, and provisional tables without resetting existing notes or transcripts.

Search triggers maintain the FTS5 index as notes, segments, titles, and summaries change. Recovery attempts publish to fresh recovered-copy filenames so a failed database update does not block retry or overwrite an earlier copy. Audio and models are separate files, not database blobs. See [privacy](privacy.md) for paths and backup boundaries.

## IPC and permissions

The complete command signatures are in [api.ts](../src/shared/api/api.ts), with matching handlers registered in [lib.rs](../src-tauri/src/lib.rs). Keep nested field names and nullability consistent with [domain.rs](../src-tauri/src/domain.rs).

| Event             | Purpose                                   |
| ----------------- | ----------------------------------------- |
| `recording_state` | Capture-state notification with revision. |
| `meeting_updated` | Refresh persisted library or detail data. |
| `session_processing_changed` | Revisioned notification; fetch authoritative processing state. |
| `audio_health`    | Capture metrics and level-meter input.    |
| `stt_progress`    | Model download or transcription progress. |
| `backend_error`   | Visible backend failure message.          |
| `request_close`   | Request note flush before backend exit.   |

[The capability file](../src-tauri/capabilities/main.json) permits event subscriptions. Native filesystem, dialog, shortcut, and exit operations remain Rust commands. [Tauri configuration](../src-tauri/tauri.conf.json) restricts playback assets to the app-data audio folder and limits network access from the webview. This is an implementation boundary, not a completed security audit.

Exports use temporary files in the selected destination, path validation, and non-clobbering publication. The `%%ai-start%%` markers delimit summary text in a snapshot; they do not implement merging with external edits.
