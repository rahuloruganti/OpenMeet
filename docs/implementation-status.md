# Implementation status

## Current boundary

Phase 1A foundation and Phase 1B Windows capture code exist. **No platform has passed the two-track hardware gate.** The previous Windows hardware attempt found no microphone endpoint (only Remote Audio output); no recording was produced. macOS capture is unsupported. VAD, resampling for STT, Whisper, model downloads, LLM summaries, and Phases 1C–1E remain unfinished.

This is provisional work while prerequisite gates remain open, not a complete MVP. Meetings are explicitly labeled `simulation`, `fixture`, or `desktop`. Simulation and fictional fixtures are never evidence of real capture or generated summaries.

The user-requested original Granola-inspired notes-first workspace is implemented in the React/Tauri shell: searchable/collapsible meeting navigation, a spacious notes canvas, keyboard-accessible notes/summary/transcript tabs, nonmodal setup/settings panels, and persistent recording controls. The running Windows development window was visually inspected on existing fictional/stopped-simulation data. Native interaction qualification is not complete; a Settings click approval timed out and was not retried. The remaining native-qualification checks are listed under Open work below.

## Implemented

- Tauri/React desktop shell, Rust-owned SQLite with WAL, foreign keys, and migrations.
- Notes-first workspace with title search that preserves selection/drafts, mounted tab panels, source labels, guarded open-active-meeting action, and available-device validation without silently replacing saved choices. Settings/setup reserve their own column so alerts and recording controls are not covered.
- Notes with optimistic revisions and serialized/debounced autosave; save-before-switch/export/quit, preserving failed drafts.
- Simulation, fictional meeting fixture, tray controls, configurable shortcut, and single-instance protection.
- Windows cpal two-track capture code: selected microphone/system output, bounded queues, separate native-rate WAVs, timing JSONL, pause generation gates, and capture diagnostics.
- Consent acknowledgement for desktop capture; explicit camelCase device payload deserialization.
- Stop requests shutdown before waiting for note saving, even if a save is pending or fails. Note-save errors remain separate from capture errors. Pause/stop have an independent UI-operation guard.
- Persistent display of backend recording errors; remaining session-health/metadata cleanup is tracked below.
- Additive schema-v3 local-model setting migration, tested against a populated v2 database.
- Native folder selection and immutable Markdown snapshots that never overwrite differing external files.
- MIT source license, dependency lockfiles, regression tests, and Windows/Apple Silicon CI definitions.

## Current local verification

| Check                                                        | Result                                                                                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend typecheck, ESLint, formatting, production build     | Passed                                                                                                                                                      |
| Vitest                                                       | 31 passed in 3 files: includes search/sidebar/tab draft retention, panel switching/quit focus/consent, missing saved microphone, guarded active-meeting navigation, secondary track details, existing local-model cases, recording controls and note protections |
| Fictional preview browser checks | Passed at 1100×780 and 720×580, with 200% text, long title wrapping, panel/toggle reachability, panel-switch focus restoration, editor focus without moving the toolbar offscreen, and Stop hit-testing with simultaneous synthetic errors; no runtime exceptions or remote/native requests. This is not native persistence/hardware validation. |
| Rust formatting                                              | Passed                                                                                                                                                      |
| Windows Rust tests                                           | 18 passed; 1 hardware test deliberately ignored. Includes mock Merge HTTP errors/redirects/timeouts/body limits, merge model selection persistence, and populated-v2 migration.                                                                                                             |
| Windows `cargo clippy --locked --all-targets -- -D warnings` | Passed                                                                                                                                                      |
| Windows `cargo build --locked`                               | Passed                                                                                                                                                      |
| `cargo deny` advisories, licenses, sources                   | Passed; two unused-license-allowance warnings, no suppressions                                                                                              |
| Ringbuf security fix                                         | Manifest minimum 0.5.2; lockfile resolves 0.5.3, outside the reported affected range                                                                        |
| Fresh Windows checkout formatting                            | Not rerun; current-tree pass does not resolve the previous CI failure                                                                                       |
| Real audio / tray / shortcut qualification                   | Not run in this batch                                                                                                                                       |
| macOS native checks                                          | Previous GitHub CI shell/build job passed; not rerun locally, no Mac available                                                                              |

Repository: [rahuloruganti/OpenMeet](https://github.com/rahuloruganti/OpenMeet) (private). [CI run 37965318206](https://github.com/rahuloruganti/OpenMeet/actions/runs/37965318206) failed on Windows formatting and the ringbuf advisory; its macOS shell/build job passed. These local fixes have **not been committed or pushed**, so no green remote workflow is claimed. [Issue #1](https://github.com/rahuloruganti/OpenMeet/issues/1) and the Open work section below track the remaining work.

## Environment

The UI redesign checks used Node 24.21.0 and the pinned Corepack/pnpm configuration. The existing development frontend at `http://127.0.0.1:1420` returned HTTP 200; its native Windows window displayed the new layout. No Rust source, command contract, schema, or dependency was changed by the UI redesign, and Rust checks were not rerun for it; the Rust results below remain from the previous backend batch. No recordings, fixture creation, native note edits, export, or cloud submission were initiated in this redesign validation.

Visual Studio Build Tools 2022 (17.14.41), C++ workload, and Windows SDK `10.0.26100.0` are installed. Checks used temporary Rust 1.99.0 under `%TEMP%/openmeet-rustup` and Cargo under `%TEMP%/openmeet-cargo`; PATH was changed only for check subprocesses. Incomplete extracted crate sources were restored from cached archives before native checks. Cargo-deny 0.20.2 was installed there for the dependency check. Install Rust permanently for normal development; temporary files may be cleaned by Windows.

The debug executable is `src-tauri/target/debug/openmeet.exe`. Compilation and mocked tests do not validate interactive desktop behavior or audio hardware.

## Remaining stabilization gate

Continue Phase A before capture qualification or model work (details under Open work):

1. Bound audio-worker control acknowledgements and handle stalled/crashed workers; test actual capture state when SQLite writes fail.
2. Clear obsolete audio health between sessions and refresh finalized track metadata without replacing edited note drafts.
3. Reproduce/fix Windows formatting from a fresh checkout and obtain green remote CI after an authorized push.
4. Correct source-aware Markdown export wording and test desktop/simulation exports. The existing unconditional no-audio sentence is still inaccurate for desktop meetings.
5. Qualify Windows recording with an explicitly authorized microphone and synthetic signals, then implement/qualify macOS capture. Include playback, excluded paused content, failure recovery, and 60-minute drift measurements.

## Open work

Carries the open items of the former execution and redesign plans; roadmap and acceptance checklist stay in [phase-1-implementation-plan.md](phase-1-implementation-plan.md). Complete phases in order: fixtures can prepare the next phase but never substitute for a hardware gate. Hardware recordings need explicit permission and synthetic signals, not private meetings. A blocked gate (no Mac, no microphone) stays blocked; a Windows-only milestone needs an explicit scope decision.

**Phase A — stabilization (items 1-5 above, plus):** test missing/invalid device IDs and denied consent without opening hardware; keep pause/stop usable during slow unrelated UI work, including tray and shortcut paths; add `.gitattributes` if line endings explain the Windows format failure; get green Windows, Apple Silicon and dependency-hygiene CI after an authorized push; correct stale counts and claims in the docs.

**Phase B — Windows capture qualification:** device refresh with clear unavailable messages; identifiable synthetic signal on both paths (a silent output legitimately yields no loopback frames); partial startup failure closes every opened device; a signal only in the paused interval must be absent from both files, including delayed packets after resume; disconnect, sample-rate change, denied permission, silent input, disk full, overflow, restart with partial files, and a populated v1 to v2 upgrade; a 60-minute two-track run with markers near both ends, recording driver versions, offsets, drift and dropped frames. Exit: audible distinct tracks, no paused content, recoverable failures, relative drift under 100 ms.

**Phase C — macOS capture:** Apple Silicon machine and an explicit minimum macOS; validate a real system-output tap (a duplex device's input stream is not proof); usage descriptions and denial handling; repeat the Phase B matrix.

**Phase D — transcription (partly done, see Decisions):** macOS engine runtime, silence/repetition guards, explicit language selection, progress and cancellation, restartable jobs that never duplicate segments or overwrite notes, licensed reference fixtures, and a Windows real-time-factor budget.

**Phase E — summaries (partly done):** General, Stand-up and One-to-one templates with template hashes; long-input chunk-then-merge (long inputs are currently refused); retained history with retry that keeps the last good summary; validated AI-block export replacement that writes a conflict copy on ambiguity; explicit remote and cost disclosure; a user-facing key-entry flow.

**Phase F — integrated MVP:** settings/progress/cancel/retry/empty/error states; recording to transcript to summary to export from a fresh install and after restart; failure injection for storage, devices, models, providers, keychain and export; Zoom, Teams and Meet with speakerphone, wired and Bluetooth on both systems; an egress-blocked local-only test plus a separate cloud opt-in test; attribution, retention and consent documentation; internal installers.

**Native UI qualification (no recording):** meeting navigation, note persistence across restart, export snapshots, setup dismissal, settings, keyboard-only use of every control, minimum window size (720×580) and 200% zoom, persistent errors not hidden by collapsed panels, and a real notes-only flow.

## Decisions and limits

- Fresh MIT implementation; Meetily was inspected as a reference, but no source was copied.
- Plain React state, CSS, and textarea; no speculative component/store/service frameworks.
- Rust owns capture, storage, and native integrations. Audio callbacks use bounded queues, not disk writes or inference.
- Classic WAV size is bounded; original and partial audio artifacts are retained. Files are local and unencrypted; no automatic cleanup or deletion UI exists.
- Markdown exports are non-overwriting snapshots, not AI-block merging. Full transitive license notices and model attribution are still release work.
- The user selected API-backed LLM use through Merge Gateway (`merge.dev`), superseding the earlier local-only preference. Implemented (Batch 4, mock-tested; the user's native run then imported a key to the keychain and saved a Merge model, which the backend only accepts after a fresh live catalog fetch lists it as available): backend-only key import from the `OPENMEET_LLM_API_KEY` environment variable into the OS keychain, key status/removal, a user-triggered paginated `GET /v1/models` that doubles as the content-free connection test, and persisted Merge model selection (schema v4). Not implemented: any inference, summary generation, or content submission. No user-facing key-entry field exists; the model is unchosen until the user selects one. The earlier Ollama model-selection slice was removed because nothing consumed it. Any future content submission needs explicit per-action consent; capture/processing gates remain open.
- Bundles, public signing, updater, transcription, AI processing, and end-to-end privacy qualification are not delivered.

- Speech-to-text and summaries (this batch): a pinned whisper.cpp engine plus Whisper small and Silero VAD models run locally on finalized tracks (`src-tauri/src/stt.rs`), segments are stored with `source='whisper'` (schema v5) and mapped to the session timeline through the timing index (pause gaps respected). Summaries go through Merge chat completions only after a per-send confirmation. Verified: pinned downloads' checksums, a manual engine run on the user's recordings (system track transcribed; both mic tracks contain no detectable speech), Rust/UI tests with mock servers and fixture JSON. Not verified: the in-app Transcribe/Enhance buttons on a live native run, transcription accuracy beyond that spot check, a live Merge chat completion, macOS, long-meeting reduction (refused instead), progress/cancel for transcription, and speaker separation beyond mic vs system.
