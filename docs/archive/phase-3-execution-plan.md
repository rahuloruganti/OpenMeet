> **Archived: describes the retired Rust/Tauri app (git tag rust-final). Not current. Do not use as a reference for the Python build.**

# Phase 3 execution plan

## Outcome and scope

Deliver the live-to-finished meeting workflow tracked by issues #19 through #25. During recording, show provisional transcripts. After stop, finalize audio, publish a final transcript, and generate a summary when the user has authorized those actions. Failures must preserve audio, notes, and earlier successful output.

This document preserves the delivery plan. The integrated implementation now exists; its acceptance and qualification gates remain open. See [workflow implementation and qualification](phase-3-workflow-verification.md). Merged PR #49 supplies timing and recovery prerequisites. Foundation hardware qualification remains open. Live provider qualification under #12 and the unexpected-exit investigation under #13 remain deferred by the user.

Keep local Whisper as the default. Reuse compatible HTTP transcription requests for optional cloud live chunks. Do not add a provider-specific streaming protocol, model server, diarization, calendar detection, bots, or automatic exports in this phase.

## Current implementation

The integrated source now has reviewed session controls, a shared processing owner, accepted-sample bounded live chunks, provisional storage/UI, shared-stop final processing, saved-note acknowledgement, optional automatic summaries, request accounting, cancellation, and explicit retry. Schema 14 preserves existing notes and final output and requires renewed consent for old grants. Restart interrupts unfinished work without replay.

`live_audio.rs`, `processing_control.rs`, `session_processing.rs`, `session_workflow.rs`, and `session_runtime.rs` hold the new Rust boundaries. Existing capture, local/cloud transcription, summary, storage, and frontend callers use them. Manual action confirmations remain separate. See [architecture](architecture.md) for current data flow and exact limits.

## Delivery order

Delivery units 1 through 4 now have integrated implementations. Unit 5 qualification is incomplete. Checked items below mean implemented and covered by source/synthetic checks. They do not establish native, hardware, real-engine, or external-provider qualification. Mixed and external gates remain unchecked with their missing evidence named. No issue is closed by this document or a successful compile.

| Unit | Issues        | Deliverable                                  | Required proof before the next unit                                                                          |
| ---- | ------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1    | #19, #24      | Session consent and durable processing state | Consent invalidation, upgrade preservation, duplicate-start prevention, restart without network activity     |
| 2    | #20           | Bounded live chunk worker                    | Synthetic audio, pause races, queue saturation, cancellation, and capture surviving worker failure           |
| 3    | #21           | Provisional transcript UI                    | Stable segment identities, revision ordering, reconnect, meeting switching, and visible degradation          |
| 4    | #22, #23, #24 | Final reconciliation and automatic summary   | Every stop entry point, finalization failure, atomic replacement, summary cancellation, and restart recovery |
| 5    | #25           | Combined qualification and evidence          | Synthetic end-to-end pass, native workflow checks, separately recorded hardware/provider limits              |

Deliver one focused PR per unit. Unit 1 establishes the recovery structure needed by later work; do not postpone durability until the final PR. Link partial issues without automatic closure. Close each issue only after its complete acceptance criteria pass.

## 1. Establish consent and processing ownership

- [x] Add a Rust-owned session plan with independent choices for live transcription, final transcription, and automatic summary. Recording-only remains available. Recording consent does not authorize cloud processing.
- [x] Before start, show each selected destination and model, microphone/system track scope, whether audio or text leaves the device, and that live chunks plus final transcription can incur separate charges.
- [x] Define finite session duration, upload-byte, request-count, and text-input budgets. Display concrete limits before consent. Reaching a limit stops that processing stage visibly while capture continues. Do not silently increase a budget or switch providers.
- [x] Bind a grant to one recording, connection and credential revisions, models, language, prompt/template, allowed stages, and budgets. The scope covers future audio from this recording, and, if selected, its final transcript and saved notes at stop. Explain this future-content scope explicitly.
- [x] Freeze and hash each actual payload before dispatch, then check it against that grant. Existing manual actions continue using their current exact-content confirmation. Session grants must not become reusable bypass tokens for other meetings or manual requests.
- [x] Relevant configuration changes or revocation invalidate unsent work and require renewed consent. Cancel in-flight requests best-effort and prevent further dispatch/publication after cancellation wins. Audio already transmitted cannot be recalled; disclose that behavior.
- [x] Introduce one processing owner in Rust. Replace conflicting global job control as callers migrate, rather than layering another busy flag over it. Keep the existing single-heavy-inference limit. A new recording may continue without live inference while the worker is occupied, with a visible reason.
- [x] Add an ordered migration for processing runs and stage status. Store identifiers, revisions, stage, attempt, consent scope, and sanitized errors. Never store keys or duplicate private payloads in logs. Give every run and operation an identity that stale completions cannot overwrite.

Use explicit stages: awaiting consent, live, finalizing audio, final transcription, summary, completed, failed, cancelled, and interrupted. Persist transitions that survive restart. Keep recording state independent so a failed inference job cannot claim capture stopped.

Implemented commands prepare session processing, fetch processing snapshots, acknowledge saved notes, cancel processing, and prepare/confirm explicit retry. Use a revisioned processing-change notification; consumers fetch authoritative state after reconnect. Final names and payloads should follow existing command conventions.

Tests must cover omitted consent, changed key/destination/model, expired or exhausted grants, wrong meeting, concurrent start/cancel, stale publication, and upgrading a populated schema-v12 database. Restart must mark uncertain work interrupted and make zero provider requests.

## 2. Build a bounded live worker

- [x] Feed the worker only packets accepted after the recording generation check. Reuse conversion, timing validation, model selection, and subprocess/HTTP helpers; do not copy the final transcription command into a second independent pipeline.
- [x] Compare a bounded accepted-sample handoff with reading committed writer ranges. Choose after a synthetic vertical slice demonstrates stable snapshot boundaries, bounded memory, and no dependence on a growing WAV header. Reject any path that reads an unfinalized WAV through the finalized-track API.
- [x] As a starting configuration, use non-overlapping ten-second chunks, independently bounded by bytes, with at most three pending chunks total and one inference request in flight. These are implemented caps, not measured performance claims. Record the chosen caps in code and tests before enabling live processing.
- [x] Seal chunks at pause, resume-generation changes, stop, and discontinuities. Never combine audio across a pause. Preserve session timestamps. Paused samples must never enter storage, inference, or upload buffers.
- [x] Reject delayed packets from earlier generations at every handoff. An already submitted chunk containing only accepted pre-pause audio may finish while paused. Make that UI behavior explicit. Pausing must not start new requests until resume.
- [x] If live work falls behind, stop enqueueing excess chunks and show that the live transcript is incomplete. Preserve final audio for the final pass. Never backpressure capture, create an unbounded backlog, or silently retry cloud requests.
- [x] Stage temporary chunks in app-owned bounded storage. Clean up only owned temporary artifacts after readers release them. Preserve original recording files. Cancellation must terminate local children, stop new HTTP dispatches, and discard stale results.

Use synthetic samples and fake engines/loopback providers to prove both track signals survive and paused markers are absent. Exercise delayed callbacks, partial chunks, silence, unavailable engines, HTTP failures, queue saturation, and stop during an in-flight job. Add a licensed or explicitly consented real-engine fixture before claiming inference compatibility.

## 3. Display provisional text

- [x] Give each live segment a stable identity derived from its processing run, track, chunk, and segment position. Include session timing and revision, and retain `You` and `Others` labels.
- [x] Keep provisional text separate from authoritative final segments. Do not insert provisional text into final transcript search, summaries, or exports. Persist completed live chunks only if needed for restart display, with explicit provisional provenance.
- [x] Show provisional, paused, catching up, unavailable, finalizing, cancelled, and failed states using accessible text. Partial coverage must remain visible.
- [x] Subscribe before starting work, fetch snapshots on selection/reconnect, and ignore events for older revisions or different meetings. Note drafts must survive progress updates and transcript refreshes.
- [x] Add frontend behavioral tests for duplicates, reordered snapshots, other-meeting isolation, cancellation/retry, saved-note failures, timestamps, and bounded rendering.
- [ ] Qualify the complete selection/reconnect and keyboard workflow in an isolated native profile. Focus/online refresh and accessible controls exist; native acceptance evidence remains open.

## 4. Finish the meeting safely

- [x] Schedule final work from the shared backend stop transition used by the UI, tray, and shortcuts. Duplicate stop requests must converge on one run. A capture failure must not trigger a successful-meeting pipeline on incomplete tracks.
- [x] Stop capture and validate/publish finalized tracks before final transcription. Cancel or join live work with a bounded wait. Late live completions cannot mutate the final run.
- [x] Run a full final transcription using the existing validated timing path. Publish its segment set atomically and retire provisional text. Do not append the final transcript to live text or use fuzzy text matching to hide duplicates. Preserve existing authoritative output if the final pass fails.
- [x] After successful final publication, generate a summary only if its stage is enabled and consent remains valid. Freeze the successful transcript and saved note revision first. If note saving fails, show the failure and wait rather than summarizing an unsaved draft. Never replace the editor draft during processing.
- [x] Add cancellation checks between summary chunks and at publication. Discard late output after cancellation. Preserve previous summary history and the final transcript if summary generation fails.
- [x] On restart, retain completed stages and mark in-flight work interrupted. Offer explicit retry of the failed stage. Do not restart cloud requests, fallback models, or billable retries automatically. A request with an uncertain remote outcome must say so before another submission.
- [x] Save and quit must preserve notes and durably mark unfinished processing. Do not imply a background service will continue after app exit. Interrupted capture still uses the existing recovery path before final processing can run.

Synthetic tests cover durable stages, stale/cancelled publication, atomic final replacement, saved-note barriers/conflicts, retry, counters, migration preservation, accepted samples, and owner races. Complete combined dispatch/commit/notification failure injection and every native stop path remain qualification work under unit 5.

## 5. Verify and document the result

- [ ] Build one repeatable synthetic end-to-end scenario: start, accepted speech, pause markers, resume, stop, final transcript, summary, export inspection, cancellation, and restart. Assert samples and stored output, not only progress labels.
- [ ] Run the full repository checks for these cross-layer changes, including populated migration tests, frontend build, Rust formatting, Clippy, tests, and native build. Run Windows and macOS CI without treating builds as capture qualification.
- [ ] Use an isolated native profile to verify provisional updates, note preservation, all stop entry points, failure messages, keyboard operation, and restart. Native recording needs specific authorization for its actual duration and scope; earlier short-test permission is not a blanket authorization for new tests.
- [ ] Qualify audible tracks, hardware pause privacy, and inference behavior separately. The 60-minute drift gate remains separate and requires its own authorization. Do not close #7 through #10 from synthetic results.
- [x] Keep real provider calls deferred until the user supplies non-secret settings and authorizes concrete content, destinations, and request counts. Mock evidence can complete implementation checks but cannot establish real provider compatibility.
- [x] Update architecture, privacy, user guide, implementation status, checklist, and `log.md`. Record reproducible steps and separate synthetic, native, hardware, and provider results. Keep #25 open for any unmet acceptance check.

The integrated workflow can be checked with synthetic samples and loopback providers without opening recording devices or contacting external providers. Native behavior and provider compatibility remain separate open gates. The original first-increment report is historical evidence, not the current feature boundary.
