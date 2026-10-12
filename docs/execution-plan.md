# Execution plan: finish the Phase 1 MVP

Tracking issue: [OpenMeet #1](https://github.com/rahuloruganti/OpenMeet/issues/1).

This is the actionable work order from the current codebase. It supplements `phase-1-implementation-plan.md`; it does not replace the overall roadmap. Execution phases below are gate-driven, not week-based. Unchecked tasks are planned work, not completed features.

## Starting point

- Desktop foundation and Windows capture code exist.
- Last local results: 11 frontend tests and 10 Rust tests passed; native Windows compilation and Clippy passed.
- The macOS desktop CI job passed. macOS audio capture is still unsupported.
- Windows CI failed at `pnpm format:check`; dependency hygiene failed on a ringbuf security advisory.
- Hardware capture is unverified: the last device test found no microphone endpoint.
- `.pi/` untracking is staged, its ignore rule is modified, and `AGENTS.md` is untracked. Preserve these existing changes; do not reset, commit, or push them without authorization.

Evidence: [CI run 37965318206](https://github.com/rahuloruganti/OpenMeet/actions/runs/37965318206), source files, and `implementation-status.md`. Some status documentation is stale and needs reconciliation.

## First execution batch — verified locally

- `ringbuf` now resolves to 0.5.3 with a manifest minimum of 0.5.2; no queue API changes were needed. `cargo deny` advisories, licenses, and sources pass without suppressions (two unused-license-allowance warnings remain).
- The frontend-shaped camelCase device payload deserializes correctly. Regression tests reject missing/malformed fields, empty IDs, and denied consent before capture. UI tests expose a rejected capture request without claiming recording.
- Stop invokes capture shutdown before note saving, including when a save is already pending. Failed drafts remain on screen with a separate note-save error; quit still requires saving. Pause/stop have their own UI-operation guard. `RecordingState.error` is displayed persistently.
- Current local checks: 15 frontend tests, 12 Rust tests; typecheck, lint, frontend formatting/build, Rust formatting, Windows native build, and Clippy pass. The hardware test was deliberately not run.
- The temporary Cargo cache had incomplete extracted crate sources; restoring its cached archives fixed native validation. No project dependency workaround was added.
- Phase A is **not complete**. Remaining A3 work includes health/session cleanup, finalized metadata refresh, bounded worker controls, and storage-failure tests. Fresh-checkout Windows formatting, green remote CI, source-aware export wording, and hardware qualification remain open. No commit or push was performed.

## User-requested local model selector — preparatory settings only

**Superseded:** this Ollama selector (schema-v3 `local_model` column kept for migration order) was removed after the user chose Merge Gateway; nothing consumed the selection. The notes below are historical.

The user confirmed local-only LLM use (no cloud API/key) with UI model selection. Added a scoped Ollama discovery/settings slice without claiming to advance past the recording gates:

- Explicit refresh of installed model names from fixed loopback `127.0.0.1:11434/api/tags`; no proxy, redirects, prompts, inference, or downloads.
- Models marked remote/cloud and models reported as embedding-only are excluded. Older tags responses may omit capabilities; verify text support before any future generation.
- Model choice is persisted by additive schema-v3 migration. Save rechecks availability outside the recording/storage mutex; missing saved choices are never silently replaced.
- 19 frontend and 18 Rust tests pass, including mock HTTP failures/timeouts/redirects/body limits and populated-schema migration/persistence. Windows build, Clippy, formatting, and cargo-deny pass.
- Ollama was not reachable in the local preflight. No real model discovery/inference or audio qualification is claimed. Whisper and summary generation remain blocked/unimplemented; cloud-provider milestones remain deferred for the selected local-only mode.

## Execution rules

### UI redesign workstream

The user requested and authorized implementation of a Granola-inspired notes-first interface and selected Merge Gateway for API-backed LLM use; the model is not chosen. The notes-first React/Tauri workspace and self-contained fictional preview are now implemented; 31 frontend regression tests and frontend checks pass. The running Windows native layout was visually inspected; native interactive persistence/settings/export flows remain unqualified. Follow [granola-style-redesign-plan.md](granola-style-redesign-plan.md) for exact evidence and remaining checks. UI-only work does not require cloud credentials or hardware access and does not complete any capture/processing gate. Merge configuration and real summary generation remain separately gated; the earlier local-only preference above is historical, not the current provider decision.

- Complete phases in order. Fixture-based work may prepare the next phase, but cannot substitute for its predecessor's hardware gate.
- Use one focused change set per task group. Commit/push and update GitHub checkboxes only when authorized and supported by evidence.
- Fix the shared cause and update callers, schemas, tests, and user-facing wording together.
- Do not install more dependencies until the feature needs them; do not bypass security checks to obtain green CI.
- Hardware recordings require explicit permission. Use synthetic test speech/tones, not a private meeting, for qualification.
- If a Mac or usable microphone is unavailable, mark the gate blocked. A Windows-only milestone requires an explicit scope decision; it is not completion of the cross-platform MVP.

## Execution Phase A — fix integration, safety, and CI

Maps to: foundation/capture stabilization, before completing Phase 1B.

### A1. Remove the vulnerable ring buffer dependency

**Files:** `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/src/audio.rs`, `THIRD_PARTY_LICENSES.md`.

- [x] Upgrade `ringbuf` from 0.4.8 to a verified fixed release at or above 0.5.2; update the manifest constraint as well as the lockfile.
- [x] Verify producer/consumer API compatibility without introducing callback allocations or unbounded buffers (no adaptation needed).
- [x] Rerun overflow, generation, and pause tests plus dependency checks.

**Evidence:** CI reports RUSTSEC-2026-0293: double-free/use-after-free if an element destructor panics during `Consumer::skip`/`clear`. Licenses and sources passed in that run; the failure was the advisory, not a reason to broaden the license allowlist. Application-level reachability has not been established, so do not claim an exploit or dismiss the dependency finding.

**Done when:** the resolved version is outside the affected range and `cargo deny ... check advisories licenses sources` passes without suppressing the advisory.

### A2. Repair the real-recording command contract

**Files:** `src/lib/api.ts`, `src-tauri/src/audio.rs`, `src-tauri/src/lib.rs`, corresponding tests.

- [x] Keep the existing frontend `microphoneId` / `outputId` payload and explicitly map `CaptureOptions` with Serde camelCase, or consistently change both sides. Prefer the smallest compatible change.
- [x] Add a Rust deserialization test using the exact JSON emitted by the frontend; assert both IDs survive.
- [ ] Test missing/invalid device IDs and denied consent without opening hardware.
- [x] Verify that UI errors expose argument/device failures instead of presenting a successful recording (mocked rejection; not a native-device test).

**Done when:** a frontend-shaped request reaches device validation, not a nested-field deserialization error. Mocked `api.startCapture` tests alone do not satisfy this gate.

### A3. Make stop and failure states trustworthy

**Files:** `src/App.tsx`, `src-tauri/src/lib.rs`, `src-tauri/src/storage.rs`, `src-tauri/src/audio.rs`, tests.

- [x] Remove the dependency of stopping audio on successfully saving notes. Stop now invokes the backend before waiting for `writer.flush()`.
- [x] Stop capture first, retain unsaved notes on screen, and report note-save errors separately. Quitting still requires successful note saving.
- [ ] Keep pause/stop usable during unrelated slow UI operations; verify tray and shortcut behavior too.
- [ ] Display `RecordingState.error` persistently, clear obsolete health data between sessions, and refresh finalized track metadata without overwriting an edited note draft.
- [ ] Bound control acknowledgements and handle worker failures. A stalled worker must not leave the UI claiming normal capture or successful shutdown.
- [ ] Verify startup, pause, resume, and stop failures preserve actual capture state even when SQLite updates fail.

**Done when:** regression tests show a note-save failure cannot keep recording against the user's stop request, and capture failures are visible with retained data.

### A4. Make CI reproducible across operating systems

**Files:** `.gitattributes` (new if needed), formatting configuration, `.github/workflows/ci.yml`.

- [ ] Reproduce the Windows formatting failure from a fresh checkout. CI reported style issues in 14 files; line endings are a likely cause, not yet a confirmed diagnosis.
- [ ] If confirmed, enforce LF for text via repository attributes, preserving binary icons; normalize only intended files and make Prettier's policy explicit if needed.
- [ ] Run checks from a fresh Windows checkout as well as the current working tree.
- [ ] Obtain a green Windows, Apple Silicon, and dependency-hygiene workflow after an authorized push.

**Done when:** all CI jobs pass without weakening formatting, license, or advisory checks.

### A5. Correct outdated claims

**Files:** `README.md`, `docs/implementation-status.md`, `docs/phase-1-implementation-plan.md`, `docs/privacy.md`, `docs/consent.md`, `src/App.tsx`, `src-tauri/src/export.rs`.

- [ ] Distinguish fictional fixtures, simulation, desktop capture code, and hardware-verified recordings.
- [ ] Make Markdown export wording depend on the meeting source; remove the unconditional claim that no audio was recorded.
- [ ] Update status counts, GitHub/CI state, audio storage/retention behavior, and dependency notices.
- [ ] Add export tests covering both simulated and desktop meeting metadata.

**Phase A exit gate:** secure dependency resolution, correct command contract, reliable stop/error handling, truthful UI/export text, and green automated checks. No hardware pass is implied.

## Execution Phase B — qualify Windows capture

Maps to: Windows portion of Phase 1B.

### B1. Prepare hardware and the smoke test

- [ ] Provide a locally attached microphone or explicitly enable remote microphone redirection and Windows microphone access. Confirm cpal sees both an input and a render endpoint.
- [ ] Add device refresh and clear unavailable-device messages; never silently replace a missing saved selection.
- [ ] Correct the smoke-test sequence: `Session::prepare()` leaves capture gated, so call `resume()` before the initial recording interval.
- [ ] Use identifiable synthetic speech/tones on both paths. Silent system output may legitimately produce no loopback frames, so arrange a known output signal during the test.
- [ ] Verify partial startup failure closes every opened device and never creates a falsely successful meeting.

### B2. Verify files, privacy, and recovery

- [ ] Record, pause, resume, and stop; inspect WAV formats, playback, channel counts, timing indexes, and database metadata.
- [ ] Put a distinct signal only in the paused interval and verify it is absent from both files, including delayed packets after resume.
- [ ] Test device disconnect, sample-rate changes, denied permissions, silent input, disk full, and queue overflow.
- [ ] Test app restart and partial WAV/timing files. Reconcile actual data with SQLite and retain recoverable artifacts; do not claim interrupted recordings are complete.
- [ ] Test upgrading a populated schema-v1 database to schema v2, preserving notes, fixtures, settings, and foreign keys.

### B3. Add downstream audio normalization and measure timing

- [ ] Resample a derived copy to 16 kHz mono with a proven resampler, preserving original WAVs.
- [ ] Maintain mappings from normalized samples back to session time, including pause gaps and channel conversion.
- [ ] Test 44.1/48 kHz conversion, stereo downmix, output length, segment boundaries, and bounded memory.
- [ ] Run a 60-minute two-track recording. Measure common reference markers near the beginning and end; distinguish initial offset from accumulated drift.
- [ ] Record device/driver versions, sample rates, offsets, drift, dropped frames, and sleep/wake behavior. Add clock correction only if measurements require it.

**Phase B exit gate:** audible, distinct tracks; no paused content; recoverable failures; correct normalized audio/timestamps; and measured relative drift below 100 ms at the end. Unit tests or non-empty files alone are insufficient.

## Execution Phase C — implement and qualify macOS capture

Maps to: remaining Phase 1B and cross-platform capture gate.

- [ ] Obtain an Apple Silicon test machine and choose an explicit minimum supported macOS version.
- [ ] Validate microphone permission and a real system-output tap. Do not treat a duplex output device's input stream as proven system loopback.
- [ ] Add the required usage descriptions/entitlements and clear permission-denial handling.
- [ ] Implement the platform adapter with the existing queue, writer, state, and timing pipeline where compatible.
- [ ] Add ScreenCaptureKit fallback only if older macOS support is required and tested; otherwise document the supported minimum.
- [ ] Repeat Phase B's playback, pause, failure, and 60-minute drift checks on the Mac.

**Phase C exit gate:** both target operating systems pass the capture matrix. Phase 1B is complete only now, unless scope is explicitly revised.

## Execution Phase D — models and final transcription

Maps to: Phase 1C.

Implement in this order:

1. **Native-runtime check:** prove Whisper and the selected VAD runtime build on Windows and Mac before expanding settings/UI.
2. **Approved artifacts:** create `models.toml` with source URLs, expected hashes, sizes, memory requirements, licenses, and attribution; verify model cards.
3. **Downloader:** explicit consent, progress, cancellation, temporary files, checksum verification, and atomic activation. Test corruption, disk-full, and interrupted downloads.
4. **VAD:** segment normalized audio with boundary padding; retain exact mappings to meeting time.
5. **Whisper:** transcribe each track after stop, preserving overlap and chronological `You` / `Others` labels. These are track labels, not diarization.
6. **Persistence/jobs:** add migrations for real final segments and restartable processing; retries must not duplicate segments or overwrite typed notes.
7. **Quality:** silence/repetition guards, explicit language selection, progress/cancellation, and licensed reference fixtures.

**Exit gate:** recorded audio produces persisted final transcripts on both platforms; retries are safe; quality results are recorded; the selected model meets the agreed Windows real-time-factor budget.

## Execution Phase E — summaries and safe note updates

Maps to: Phase 1D.

Implement in this order:

1. **Ollama first:** native chat, explicit context size, connection test, timeouts, and useful errors. Treat non-loopback endpoints as remote.
2. **Templates:** General, Stand-up, and One-to-one; strict variables, template hashes, and isolated user-authored notes.
3. **Long input:** conservative prompt/output budgeting, chunk-then-merge, and bounded repeated reduction. Test facts from the last ten minutes of a one-hour fixture.
4. **OpenAI:** keychain-backed credentials and explicit cloud consent before submitting meeting content; never return stored keys to the frontend.
5. **History:** store provider/model/template metadata and prior successful summaries; retain the last good version when a retry fails.
6. **Exports:** add tracked hashes and validated AI-block replacement. Ambiguous markers or concurrent external edits must produce a conflict copy, not destructive replacement.

**Exit gate:** all three templates work with both providers, ending facts survive long-input processing, secrets stay out of logs/files, and user/external note edits are preserved.

## Execution Phase F — integrated MVP qualification

Maps to: Phase 1E.

- [ ] Finish settings, progress, cancellation, retry, empty/error states, and recovery actions.
- [ ] Run recording → transcript → summary → export from a fresh install and after restart.
- [ ] Repeat failure injection for storage, device changes, models, providers, keychain, and export permissions.
- [ ] Validate Zoom, Teams, and Meet with speakerphone, wired, and Bluetooth setups on both operating systems.
- [ ] Pre-provision models and enforce local-only network egress during an end-to-end privacy test; separately test cloud opt-in.
- [ ] Complete dependency/model attribution, retention/deletion guidance, consent documentation, and setup instructions.
- [ ] Build internal installers. Public signing, notarization, and updater remain outside this MVP milestone.

**Exit gate:** the acceptance checklist in `phase-1-implementation-plan.md` passes with reproducible evidence. Do not waive note preservation, consent, or paused-audio privacy.

## Validation and evidence for every phase

Use the commands in root `AGENTS.md`; build `dist/` before standalone Cargo checks. Also run `cargo deny --manifest-path src-tauri/Cargo.toml check advisories licenses sources` for dependency changes.

For each completed task, record:

- Changed files and the behavior they implement.
- Commands actually run and their results.
- Native platform/hardware tested; separate synthetic and device results.
- Remaining limitations and blocked tests.
- CI run URL and commit ID when available.

Update `docs/implementation-status.md` as evidence changes. Keep prompt context in `log.md`; never put recorded content or credentials there. Update issue #1 only for verified completions.

## First execution batch

Start with **A1–A3**: upgrade ringbuf, repair the device payload, and decouple stopping audio from saving notes. Then complete **A4–A5** and get green CI. Do not begin Whisper or LLM integration while the recorder's contract and stop behavior remain unsafe or unverified.
