> **Archived: describes the retired Rust/Tauri app (git tag rust-final). Not current. Do not use as a reference for the Python build.**

# Phase 1 implementation plan: desktop MVP

## 1. Goal and scope

Deliver a macOS and Windows desktop app that lets a user manually record a meeting, pause/resume it, obtain a local final transcript, generate a template-based summary, and save an editable Markdown note to a chosen folder.

Source: `Open-source meeting notetaker development plan and tool inventory.md`, especially Roadmap → Phase 1 MVP.

**Execution model:** five gate-driven implementation subphases (1A–1E), not a calendar schedule. Begin after the relevant Phase 0 build, capture, and inference spikes have passed. Missing prerequisites must be completed explicitly. Advance only when the current subphase's exit gate passes.

**Planning reference:** This document preserves the original phase design and proposed contracts. Windows transcription, Merge summaries, and later library features now have implementations, but qualification gates remain open. Some proposed dependencies, commands, and provider choices below were superseded. Use [implementation-status.md](implementation-status.md) for current behavior and evidence, and [dependencies.md](dependencies.md) for packages actually used.

### Included

- Tauri 2, React, TypeScript, Vite, and a Rust-owned processing pipeline.
- Manual start, stop, pause, and resume; tray controls, recording indicator, pause hotkey.
- Separate microphone and system-audio capture on both operating systems.
- Local VAD and offline Whisper transcription with track-based `You` / `Others` labels.
- Ollama native adapter and one cloud adapter: OpenAI.
- Three built-in Markdown templates: General, Stand-up, and One-to-one.
- SQLite persistence, typed user notes, summary history, and safe Markdown export.
- Settings, explicit model downloads, model verification, and processing progress.
- Recovery and retry paths for interrupted recording, transcription, summary, and export.

### Explicitly excluded

Automatic meeting detection; live STT; diarization and named speakers; Parakeet; calendar integration; voiceprints; template editor; provider-switch regeneration UI; SharePoint/outbox; bots; updater; public-release signing/notarization; Windows ARM; Intel Mac builds.

Phase 1 supports retrying failed processing. Rich regeneration with a different model/template belongs to Phase 2, although summary history is built now.

**Current provider decision:** Users supply an OpenAI-compatible HTTPS base URL, API key, and model in Settings, independently for LLM and cloud STT. This supersedes Merge-specific/environment-import setup. Local Whisper remains the transcription default. Keys pass transiently through password input/IPC to the OS keychain, never into persistent frontend state. Text and audio submissions each require per-action consent. See [provider architecture](architecture.md#provider-requests) and the superseded provider-settings design (removed; see [v1 release plan](v1-release-plan.md)); live provider qualification remains open.

## 2. Prerequisites and decisions

Complete or confirm these before starting subphase 1A:

| Decision/check             | Required outcome                                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh build or reuse       | Inspect Meetily's current capture code, platform support, and license; record the reuse decision. Do not assume an existing codebase.                                                                           |
| Toolchain and shell        | A minimal Tauri 2 app builds on Windows x64 and Apple Silicon CI. Document Rust, Node/pnpm, CMake/Clang, Windows SDK, and Xcode prerequisites.                                                                  |
| Dependency versions        | Verify actual available versions, APIs, native-library compatibility, and licenses. The source document's version claims are inputs to verify, not guaranteed pins. Commit Cargo and pnpm lockfiles.            |
| Two-track capture          | Prove mic plus system capture on real machines; 60-minute run with under 100 ms relative drift. Validate cpal loopback before selecting OS fallbacks.                                                           |
| macOS compatibility        | Prefer Core Audio taps where supported; validate the runtime minimum. Supporting macOS 13–14.5 requires a proven ScreenCaptureKit fallback, otherwise explicitly narrow MVP support rather than claim coverage. |
| Native inference           | Whisper and sherpa-onnx VAD compile on both platforms. Select one Whisper model that meets the target laptop's runtime and accuracy budget.                                                                     |
| LLM context                | A one-hour fixture's final ten minutes survive the Ollama summarization path.                                                                                                                                   |
| License and fixture rights | Choose MIT or Apache-2.0; record model/dependency attribution and use redistributable or internally consented test recordings.                                                                                  |

Windows detection, Power Automate, and bot spikes do not block Phase 1. Diarization benchmarks can wait; sherpa-onnx buildability still matters because this phase uses its VAD.

**Recommended simplifications:** WAV-only recording, no post-meeting compression; CPU inference baseline with macOS Metal and Windows Vulkan enabled only after validation; Ollama installed and managed by the user; plain Markdown editor/textarea rather than Tiptap for this phase. Use the OS app-data path provided by Tauri and a user-selected export folder.

## 3. Architecture and implementation contracts

### Suggested repository layout

```text
src/                         React application
  features/                  meetings, recorder, notes, settings, models
  lib/                       typed commands/events and frontend state
src-tauri/src/
  commands/                  thin Tauri command handlers
  domain/                    meeting types and lifecycle
  audio/                     capture traits, platform adapters, buffers, WAV
  processing/                resampling, VAD, jobs, transcript merge
  stt/                       SttEngine and Whisper adapter
  llm/                       LlmProvider, Ollama, OpenAI, context budgeting
  models/                    manifest, downloader, verification
  storage/                   SQLite, repositories, settings
  export/                    Markdown renderer and safe writer
src-tauri/migrations/
templates/                   three built-in templates
models.toml                  approved artifacts, hashes, licenses, requirements
fixtures/                    manifests, expected results, small test fixtures
.github/workflows/           frontend/core checks and native build matrix
docs/                        setup, privacy/consent basics, manual test results
```

Keep audio callbacks and native inference off the UI and async runtime threads. Tauri commands delegate to Rust services; React never accesses audio, model files, API keys, or arbitrary filesystem paths directly. Restrict Tauri capabilities to the permissions actually needed.

### Recording and processing lifecycle

- Capture: `idle → starting → recording ↔ paused → stopping → stopped`.
- Persist independent job states for transcription, summary, and export: `pending/running/succeeded/failed/cancelled`.
- Support only one active recording and one heavyweight inference job initially.
- Start succeeds only when both tracks are ready. On partial startup failure, close opened devices and present a useful error; never silently claim two-track capture.
- Stop is idempotent: drain buffers, finalize WAV headers, commit track metadata, and schedule transcription.
- A summary failure must not discard audio, transcript, or typed notes. An export failure must not discard database results.
- On startup, detect interrupted recordings/jobs, validate available WAV data, mark recovery state, and offer processing retry rather than pretend the meeting completed.

### Commands and events

Phase 1 commands:

`start_recording`, `stop_recording`, `pause_recording`, `resume_recording`, `get_recording_state`, `list_meetings`, `get_meeting`, `save_notes`, `save_settings`, `get_settings`, `choose_vault_folder`, `list_models`, `download_model`, `cancel_model_download`, `test_llm_connection`, `retry_processing`, `export_meeting`.

Phase 1 events:

`recording_state`, `audio_health`, `model_download_progress`, `processing_progress`, `transcript_final`, `summary_progress`, `meeting_updated`.

Define shared request/response schemas, stable error codes, meeting IDs, and job IDs before wiring screens. Subscribe before starting operations and query current state on reconnect; events are notifications, not the source of truth. Streaming LLM progress is optional; streamed STT is not part of this phase.

### Storage

Use bundled SQLite with WAL, foreign keys, and versioned migrations. Implement `meetings`, `tracks`, `segments`, `speakers`, `notes`, `summaries`, plus processing-job state. Add export path and last-written-content hash metadata. Defer `people` and `outbox` until their phases.

- Store track kind, sample rate, channels, sample count, timing anchors, and dropped-frame diagnostics.
- Keep transcript source and pass fields compatible with future bot/live input.
- Save typed notes independently from AI output, with debounce and a flush before closing.
- Store summary provider/model/template hash and previous successful versions.
- Persist ordinary settings locally; API keys only in the OS keychain. Never return keys to the frontend after saving.
- Do not delete original audio as a side effect of processing. Document retention; implement automatic cleanup separately if needed before release.

## 4. Phase-wise execution sequence

Subphases 1A–1E all belong to **Roadmap Phase 1: MVP**. They do not replace Roadmap Phases 2–5. Each subphase produces a testable deliverable and ends with an acceptance gate, rather than a fixed deadline.

| Subphase                  | Deliverable                                                | Prerequisite                      |
| ------------------------- | ---------------------------------------------------------- | --------------------------------- |
| 1A — Foundation           | Persistent desktop shell with a simulated recording flow   | Section 2 prerequisites confirmed |
| 1B — Capture              | Reliable two-track recording on both operating systems     | 1A gate passed                    |
| 1C — Transcription        | Verified model downloads and local final transcripts       | 1B gate passed                    |
| 1D — Summaries and export | Context-safe summaries and edit-preserving Markdown output | 1C gate passed                    |
| 1E — MVP validation       | Integrated, recoverable MVP and internal installers        | 1D gate passed                    |

Automated tests accompany each subphase; 1E validates the integrated system rather than introducing testing for the first time.

### Phase 1A — foundation and a persistent vertical slice

1. Initialize repository, license, lockfiles, Tauri shell, frontend, Rust modules, and CI.
2. Add SQLite migrations and repositories; use fixtures to create/list/open a meeting and save user notes.
3. Build meeting list, detail/editor, settings shell, and typed command/event boundary.
4. Implement recording state controller with a fake audio source, including duplicate-start, pause/resume, and stop tests.
5. Add tray states, visible recording status, single-instance protection, and configurable pause/resume shortcut.
6. Implement export-folder selection and a fixture-based Markdown renderer.

**Gate:** both native apps build; a fixture meeting and typed notes survive restart; UI and tray share one backend-owned recording state; CI tests/lints pass.

### Phase 1B — real two-track recording

1. Implement microphone capture and platform-specific system-output capture behind `AudioSource`.
2. Use bounded ring buffers and worker threads; never perform blocking writes, allocation-heavy work, or inference in capture callbacks.
3. Record separate native-rate WAV files and resample worker output to 16 kHz mono for later processing.
4. Anchor both tracks to one session clock, retain sample counters, and handle gaps/drift explicitly.
5. Implement pause semantics: do not persist or transcribe audio captured during a pause; discard queued paused samples and persist pause intervals. On resume, preserve the common timeline with gap metadata or equivalent silence padding.
6. Add a manual-start consent reminder, permission/preflight checks, no-device errors, stream-health warnings, and buffer-overrun diagnostics. Automatic detection-triggered consent prompts remain in Roadmap Phase 2.
7. Handle device loss/switch and sleep/wake: reopen where proven safe; otherwise pause with a visible error. Never silently capture from a different microphone or claim uninterrupted audio.

**Gate:** real mic and system tracks play back on both OSes; pause content is absent; a 60-minute test stays under 100 ms relative drift; denied permissions and stream failure are visible and recoverable.

### Phase 1C — model management, VAD, and final transcript

1. Add approved Whisper and Silero VAD artifacts to `models.toml`: source, expected hash, size, license, attribution, and memory guidance.
2. Implement explicit download consent, progress/cancellation, temporary files, SHA-256 verification, and atomic activation. Never load an incomplete or unverified artifact.
3. Add sherpa-onnx Silero VAD with configurable minimum speech and boundary padding; retain utterance-to-meeting timestamp mapping.
4. Implement `SttEngine` with Whisper; process each track separately, split long utterances, and translate timestamps to the meeting timeline.
5. Label mic segments `You`, system segments `Others`; merge by start time without discarding overlaps. Explain these are track labels, not speaker identification. Speakerphone echo may duplicate voices; recommend a headset rather than dropping overlapping mic speech heuristically.
6. Add silence/repetition guards, progress, cancellation, persisted final segments, and restartable jobs.
7. Test explicit language selection; offer automatic language detection only if validated.

**Gate:** a recorded meeting produces a persisted, chronological final transcript on both machines; silence does not generate obvious invented paragraphs; selected default Whisper runs below real time on the agreed Windows benchmark; model corruption produces an actionable error.

### Phase 1D — summaries and safe Markdown output

1. Implement `LlmProvider`, Ollama native chat, and OpenAI chat; add connection tests and keychain-backed credentials.
2. Show explicit disclosure and require confirmation before the first cloud submission. Treat non-loopback custom endpoints as remote, not automatically local.
3. Add three built-in templates using MiniJinja, with strict variable validation and stable template hashes. Include typed notes and label transcript content as untrusted input.
4. Budget prompt plus output tokens; characters/4 is only an estimate, so use conservative margins, model limits, and provider usage where available. Set Ollama `num_ctx` explicitly.
5. Use chunk-then-merge for oversized transcripts with approximately ten-minute chunks and overlap. Bound merge input too, using additional reduction passes when necessary. Show direct versus chunked processing.
6. Keep AI Markdown separate from user Markdown; store successful summary versions. If structured action items are requested, validate JSON, retry once, then fall back without inventing owners or due dates.
7. Export quoted YAML frontmatter, summary, user notes, action items, and transcript; sanitize Windows filenames including reserved names/trailing dots and enforce path containment and collision handling.
8. Write temporary files in the destination directory and use tested platform-safe replacement. Compare last-written hashes before updates; replace only valid AI blocks in externally edited files, otherwise offer a conflict copy. Never overwrite unknown content. Recheck before committing the replacement to reduce race risk.

**Gate:** both providers work; the one-hour fixture's ending facts appear in the summary; three templates render; keys never appear in settings/logs; exported notes preserve typed and externally edited content.

### Phase 1E — integration, recovery, and MVP validation

1. Complete settings: microphone, system-output device where supported, vault folder, Whisper/language selection, Ollama endpoint/model/context, cloud credentials, and shortcut.
2. Complete empty/loading/error states, processing progress, retry actions, and summary/transcript display.
3. Test interrupted recording, application restart, disk full, disconnected devices, invalid model, unavailable Ollama, cloud timeout, keychain failure, and unwritable export folder.
4. Run native capture tests across Zoom, Teams, and Meet, with wired/Bluetooth headsets and speakerphone; include pause/resume, device switch, and sleep/wake.
5. Run and extend the automated privacy, note-preservation, migration, model-verification, context-budgeting, and job-retry regression suites built in earlier subphases.
6. Record limitations, basic consent guidance, privacy behavior, setup steps, benchmark results, and dependency/model license inventory.
7. Produce internal test installers. Public signing, notarization, updater, and full release qualification remain Roadmap Phase 5.

**Gate:** the end-to-end acceptance checklist below passes on both target machines, or unsupported cases are explicitly cut and documented before Roadmap Phase 2. Core privacy and data-preservation requirements cannot be waived.

## 5. Acceptance checklist

- [ ] User can select a folder and input device, download a verified model, and test an LLM connection.
- [ ] Manual start captures separate mic and system WAV files on Windows x64 and Apple Silicon.
- [ ] Manual start displays a consent reminder; app and tray indicate recording/paused/error state; shortcut and UI pause/resume control the same session.
- [ ] Paused audio is neither persisted nor transcribed; resumed tracks retain their shared timeline.
- [ ] Stop flushes audio and asynchronously produces a final `You` / `Others` transcript; UI remains responsive.
- [ ] Typed notes survive recording, processing, restart, and export without model-driven modification.
- [ ] General, Stand-up, and One-to-one work with Ollama and OpenAI.
- [ ] Long input triggers a visible context-safe chunk/reduction path and retains ending facts.
- [ ] SQLite meeting, transcript, notes, and summary history survive restart.
- [ ] Markdown opens correctly in a plain editor and Obsidian; filenames work on Windows.
- [ ] Existing note edits are preserved; export conflicts produce a safe alternative rather than data loss.
- [ ] Failed processing can be retried without duplicating final segments or losing the last good summary.
- [ ] Interrupted sessions are flagged and recoverable where valid audio exists.
- [ ] After explicit model acquisition, local mode uses only a verified loopback Ollama endpoint and makes no external requests; telemetry and cloud submission are off by default.
- [ ] A 60-minute capture meets the drift target; STT benchmark meets the selected hardware budget; quality results and known echo limitations are recorded.
- [ ] Native CI builds succeed on both platforms; unit/UI tests, formatting, lint, advisory, and license checks pass or have documented reviewed exceptions.

## 6. Test strategy and ordering

**Automated:** Rust unit/integration tests for state transitions, clock mapping, resampling/VAD boundaries, transcript merging, SQLite migrations, retry idempotency, model integrity, template rendering, context budgeting, and safe note updates. Mock Ollama/OpenAI with an HTTP test server. Frontend tests mock typed Tauri commands/events. Use fixture-driven pipeline tests without physical audio devices.

**Manual hardware:** log OS, device, driver, app, sample rates, durations, drift, dropout counts, processing time, and pass/fail. CI builds cannot prove capture works. Require access to both target machines throughout implementation, not only in Phase 1E.

**Privacy:** pre-provision fixtures/models, enforce an egress-blocking test environment, allow only the local Ollama address, and exercise record → transcript → summary → export. Test explicit cloud consent separately. Disable automatic updater/model checks in local-only operation.

**Critical path:** shell/storage → two-track capture → validated models/VAD → final STT → context-safe summary → safe export → hardware/recovery gate.

If a subphase exceeds the available effort budget, reduce editor polish, optional acceleration, rich structured action items, and advanced settings first. Do not trade away dual-track validation, visible recording/consent controls, model verification, note preservation, local-only privacy, or recoverable failures. Any OS-version support reduction must be stated explicitly.
