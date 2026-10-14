# Phase 3 execution plan

## Outcome and scope

Deliver the live-to-finished meeting workflow tracked by issues #19 through #25. During recording, show provisional transcripts. After stop, finalize audio, publish a final transcript, and generate a summary when the user has authorized those actions. Failures must preserve audio, notes, and earlier successful output.

This is a plan, not an implemented or qualified feature. Merged PR #49 supplies timing and recovery prerequisites. Foundation hardware qualification remains open. Live provider qualification under #12 and the unexpected-exit investigation under #13 remain deferred by the user.

Keep local Whisper as the default. Reuse compatible HTTP transcription requests for optional cloud live chunks. Do not add a provider-specific streaming protocol, model server, diarization, calendar detection, bots, or automatic exports in this phase.

## Current flow and affected code

- `lib.rs` recording commands call `Core` lifecycle methods. Stop currently finalizes capture without scheduling processing. Trace tray, shortcuts, failure stops, and guarded quit as well as the command before changing this boundary.
- `audio.rs` owns native queues, generation checks, accepted-packet draining, and track writers. Its callbacks must remain nonblocking and free of inference or file operations.
- `stt.rs` runs local inference on finalized tracks and owns global busy, cancellation, and publication guards. `cloud_stt.rs` prepares frozen bounded WAV uploads. Neither currently provides a live worker.
- `lib.rs` binds existing cloud action confirmation to frozen settings/content fingerprints. `llm.rs` performs bounded summary requests. Existing manual actions must retain their safeguards.
- `storage.rs` owns transcript replacement, summaries, recording recovery, and SQLite. Additive migrations must preserve existing notes, segments, provenance, search indexes, and foreign keys.
- `src/lib/api.ts`, `App.tsx`, and meeting components expose processing actions, events, and progress. React renders backend snapshots and saves notes independently.

## Delivery order

Implementation has started with the backend consent-storage portion of unit 1. Review preparation, recording-transaction attachment, configuration invalidation, snapshots, cancellation, and restart interruption exist locally. The UI, job owner, and dispatch accounting remain unfinished. See [the first-increment verification](phase-3-consent-verification.md). No issue is complete from this increment alone.

| Unit | Issues        | Deliverable                                  | Required proof before the next unit                                                                          |
| ---- | ------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1    | #19, #24      | Session consent and durable processing state | Consent invalidation, upgrade preservation, duplicate-start prevention, restart without network activity     |
| 2    | #20           | Bounded live chunk worker                    | Synthetic audio, pause races, queue saturation, cancellation, and capture surviving worker failure           |
| 3    | #21           | Provisional transcript UI                    | Stable segment identities, revision ordering, reconnect, meeting switching, and visible degradation          |
| 4    | #22, #23, #24 | Final reconciliation and automatic summary   | Every stop entry point, finalization failure, atomic replacement, summary cancellation, and restart recovery |
| 5    | #25           | Combined qualification and evidence          | Synthetic end-to-end pass, native workflow checks, separately recorded hardware/provider limits              |

Deliver one focused PR per unit. Unit 1 establishes the recovery structure needed by later work; do not postpone durability until the final PR. Link partial issues without automatic closure. Close each issue only after its complete acceptance criteria pass.

## 1. Establish consent and processing ownership

- [ ] Add a Rust-owned session plan with independent choices for live transcription, final transcription, and automatic summary. Recording-only remains available. Recording consent does not authorize cloud processing.
- [ ] Before start, show each selected destination and model, microphone/system track scope, whether audio or text leaves the device, and that live chunks plus final transcription can incur separate charges.
- [ ] Define finite session duration, upload-byte, request-count, and text-input budgets. Display concrete limits before consent. Reaching a limit stops that processing stage visibly while capture continues. Do not silently increase a budget or switch providers.
- [ ] Bind a grant to one recording, connection and credential revisions, models, language, prompt/template, allowed stages, and budgets. The scope covers future audio from this recording, and, if selected, its final transcript and saved notes at stop. Explain this future-content scope explicitly.
- [ ] Freeze and hash each actual payload before dispatch, then check it against that grant. Existing manual actions continue using their current exact-content confirmation. Session grants must not become reusable bypass tokens for other meetings or manual requests.
- [ ] Relevant configuration changes or revocation invalidate unsent work and require renewed consent. Cancel in-flight requests best-effort and prevent further dispatch/publication after cancellation wins. Audio already transmitted cannot be recalled; disclose that behavior.
- [ ] Introduce one processing owner in Rust. Replace conflicting global job control as callers migrate, rather than layering another busy flag over it. Keep the existing single-heavy-inference limit. A new recording may continue without live inference while the worker is occupied, with a visible reason.
- [ ] Add an ordered migration for processing runs and stage status. Store identifiers, revisions, stage, attempt, consent scope, and sanitized errors. Never store keys or duplicate private payloads in logs. Give every run and operation an identity that stale completions cannot overwrite.

Use explicit stages: awaiting consent, live, finalizing audio, final transcription, summary, completed, failed, cancelled, and interrupted. Persist transitions that survive restart. Keep recording state independent so a failed inference job cannot claim capture stopped.

Proposed commands are prepare/confirm session processing, fetch processing snapshot, cancel processing, and explicitly retry a failed stage. Use a revisioned processing-change notification; consumers fetch authoritative state after reconnect. Final names and payloads should follow existing command conventions.

Tests must cover omitted consent, changed key/destination/model, expired or exhausted grants, wrong meeting, concurrent start/cancel, stale publication, and upgrading a populated schema-v12 database. Restart must mark uncertain work interrupted and make zero provider requests.

## 2. Build a bounded live worker

- [ ] Feed the worker only packets accepted after the recording generation check. Reuse conversion, timing validation, model selection, and subprocess/HTTP helpers; do not copy the final transcription command into a second independent pipeline.
- [ ] Compare a bounded accepted-sample handoff with reading committed writer ranges. Choose after a synthetic vertical slice demonstrates stable snapshot boundaries, bounded memory, and no dependence on a growing WAV header. Reject any path that reads an unfinalized WAV through the finalized-track API.
- [ ] As a starting configuration, use non-overlapping ten-second chunks, independently bounded by bytes, with at most three pending chunks total and one inference request in flight. These are proposed limits, not measured performance claims. Record the chosen caps in code and tests before enabling live processing.
- [ ] Seal chunks at pause, resume-generation changes, stop, and discontinuities. Never combine audio across a pause. Preserve session timestamps. Paused samples must never enter storage, inference, or upload buffers.
- [ ] Reject delayed packets from earlier generations at every handoff. An already submitted chunk containing only accepted pre-pause audio may finish while paused. Make that UI behavior explicit. Pausing must not start new requests until resume.
- [ ] If live work falls behind, stop enqueueing excess chunks and show that the live transcript is incomplete. Preserve final audio for the final pass. Never backpressure capture, create an unbounded backlog, or silently retry cloud requests.
- [ ] Stage temporary chunks in app-owned bounded storage. Clean up only owned temporary artifacts after readers release them. Preserve original recording files. Cancellation must terminate local children, stop new HTTP dispatches, and discard stale results.

Use synthetic samples and fake engines/loopback providers to prove both track signals survive and paused markers are absent. Exercise delayed callbacks, partial chunks, silence, unavailable engines, HTTP failures, queue saturation, and stop during an in-flight job. Add a licensed or explicitly consented real-engine fixture before claiming inference compatibility.

## 3. Display provisional text

- [ ] Give each live segment a stable identity derived from its processing run, track, chunk, and segment position. Include session timing and revision, and retain `You` and `Others` labels.
- [ ] Keep provisional text separate from authoritative final segments. Do not insert provisional text into final transcript search, summaries, or exports. Persist completed live chunks only if needed for restart display, with explicit provisional provenance.
- [ ] Show provisional, paused, catching up, unavailable, finalizing, cancelled, and failed states using accessible text. Partial coverage must remain visible.
- [ ] Subscribe before starting work, fetch snapshots on selection/reconnect, and ignore events for older revisions or different meetings. Note drafts must survive progress updates and transcript refreshes.
- [ ] Add frontend behavioral tests for duplicates, reordered events, switching meetings, reconnect, cancellation, and keyboard access. Keep transcript rendering bounded for long sessions.

## 4. Finish the meeting safely

- [ ] Schedule final work from the shared backend stop transition used by the UI, tray, and shortcuts. Duplicate stop requests must converge on one run. A capture failure must not trigger a successful-meeting pipeline on incomplete tracks.
- [ ] Stop capture and validate/publish finalized tracks before final transcription. Cancel or join live work with a bounded wait. Late live completions cannot mutate the final run.
- [ ] Run a full final transcription using the existing validated timing path. Publish its segment set atomically and retire provisional text. Do not append the final transcript to live text or use fuzzy text matching to hide duplicates. Preserve existing authoritative output if the final pass fails.
- [ ] After successful final publication, generate a summary only if its stage is enabled and consent remains valid. Freeze the successful transcript and saved note revision first. If note saving fails, show the failure and wait rather than summarizing an unsaved draft. Never replace the editor draft during processing.
- [ ] Add cancellation checks between summary chunks and at publication. Discard late output after cancellation. Preserve previous summary history and the final transcript if summary generation fails.
- [ ] On restart, retain completed stages and mark in-flight work interrupted. Offer explicit retry of the failed stage. Do not restart cloud requests, fallback models, or billable retries automatically. A request with an uncertain remote outcome must say so before another submission.
- [ ] Save and quit must preserve notes and durably mark unfinished processing. Do not imply a background service will continue after app exit. Interrupted capture still uses the existing recovery path before final processing can run.

Test every transition with injected failures before dispatch, after remote success, before SQLite commit, and after commit but before notification. Assert literal final segments, preserved notes/history, one scheduled run, and zero automatic repeat requests.

## 5. Verify and document the result

- [ ] Build one repeatable synthetic end-to-end scenario: start, accepted speech, pause markers, resume, stop, final transcript, summary, export inspection, cancellation, and restart. Assert samples and stored output, not only progress labels.
- [ ] Run the full repository checks for these cross-layer changes, including populated migration tests, frontend build, Rust formatting, Clippy, tests, and native build. Run Windows and macOS CI without treating builds as capture qualification.
- [ ] Use an isolated native profile to verify provisional updates, note preservation, all stop entry points, failure messages, keyboard operation, and restart. Native recording needs specific authorization for its actual duration and scope; earlier short-test permission is not a blanket authorization for new tests.
- [ ] Qualify audible tracks, hardware pause privacy, and inference behavior separately. The 60-minute drift gate remains separate and requires its own authorization. Do not close #7 through #10 from synthetic results.
- [ ] Keep real provider calls deferred until the user supplies non-secret settings and authorizes concrete content, destinations, and request counts. Mock evidence can complete implementation checks but cannot establish real provider compatibility.
- [ ] Update architecture, privacy, user guide, implementation status, checklist, and `log.md`. Record reproducible steps and separate synthetic, native, hardware, and provider results. Keep #25 open for any unmet acceptance check.

The first executable unit is consent plus durable job ownership. It can be built and checked without recording or making external provider calls. Broader native and provider reliability remains subject to the existing open qualification issues, even after Phase 3 code is implemented.
