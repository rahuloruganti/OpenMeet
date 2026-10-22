# Phase 3 workflow implementation and qualification

## Implemented boundary

The integrated source implements the automatic meeting workflow for issues #19 through #24. This report describes the source and separates implementation from qualification. Integrated Windows checks passed: 121 frontend tests and 125 Rust tests, with two native tests deliberately ignored. No native recording or external provider request was made for this documentation pass.

Recording-only is the UI default. Users can review live-only transcription, final transcription, or live plus final transcription, with an optional automatic summary for final workflows. A separate acknowledgement still grants participant recording permission. Reviews disclose local/API destinations and models, both tracks, future recorded audio, optional saved notes/final transcript, separate live/final charges, finite budgets, and cancellation limits. Preparing a review makes no provider call and proves no engine readiness.

Reviews expire after five minutes. Default grants allow 3,600 seconds of recording, 14,400 seconds of post-stop processing, 256 MiB of uploaded audio, 1,000 requests, and 800,000 UTF-8 text bytes. Shared stop publication reduces the deadline to actual stop plus the post-stop allowance. Relevant speech/provider/key changes invalidate unsent work. Longer recordings require the separate manual exact-audio workflow rather than silent expansion of automatic authorization.

## Live samples and provisional output

`audio.rs` offers copies only after successful track writing and recording-generation validation. Native callbacks retain the existing bounded queues. They do no inference, network work, or filesystem operations.

`live_audio.rs` targets ten-second chunks and caps each accumulator at 1,000,000 samples, with fixed capture-packet granularity and 4,096 timing entries. It seals at pause, generation changes, discontinuities, and stop. One nonblocking channel holds three sealed chunks across both tracks. Saturation discards a live copy, marks coverage incomplete, and preserves the saved recording. The worker creates an owned finalized temporary WAV/timing index for inference. It does not read a growing recording WAV through the finalized-track API.

Pausing blocks new dispatch. Already submitted accepted pre-pause audio may finish while paused. Stop cancels in-flight live work and drops its backlog before the final pass. Live failure does not stop capture. A busy shared owner can leave a visible live gap; final-stage contention fails visibly and requires review before retry.

Provisional IDs bind run, track, chunk, and segment index. SQLite retains at most 200 rows, with a 1 MiB preview-storage allowance. The UI deduplicates and bounds rendering to 200, with track labels and timed/untimed status. Provisional output does not enter final search, summary input, or export. Live-only stop retains this explicitly provisional preview and creates no final transcript.

## Final publication and saved notes

The UI, tray, shortcut, failure, and graceful-close paths use Core's shared stop lifecycle. The durable stop report schedules final processing only for an enabled scope and valid finalized tracks. Failed finalization cannot become a successful automatic meeting pipeline.

Final transcription reuses strict timing validation and atomically replaces the authoritative transcript/provenance, retires provisional rows, and records completion. It does not concatenate live and final output. Failure or cancellation preserves earlier successful output and original audio.

Automatic summary waits for a saved-note acknowledgement. The frontend flushes only the writer for the stopped capture meeting and sends its persisted revision, run ID, and stop/retry barrier. For an unselected meeting, it reads the saved revision. Save failure preserves the draft and exposes explicit acknowledgement retry. The backend freezes the acknowledged notes, uses the final transcript, and refuses publication if notes or transcript change during generation. Previous summary history remains intact on failure.

## Ownership, consent, and retries

`processing_control::Owner` serializes heavy manual and automatic operations. Each guard owns its cancellation flag. Cancellation and publication share a gate, followed by Core validation. The runner performs inference and HTTP outside the Core lock.

Before operations and actual HTTP sends, the backend checks run, stage, grant scope, configuration revision, and deadline. Each cloud speech send reserves the frozen audio digest/bytes. Each chat send reserves the exact serialized JSON body digest and UTF-8 byte count, including combination requests. Counters commit before dispatch and do not refund uncertain outcomes. No automatic fallback or billable retry occurs.

Explicit retry prepares a new review for the existing stopped recording. It creates a fresh run ID, attempt, notes barrier, finite budgets, and deadline without starting capture. A successful final transcript remains available if only summary work needs retry. The backend refuses recordings beyond the review horizon. Stopped live-only previews use manual final transcription instead.

Schema 14 adds workflow/request/provisional tables and requires renewed consent for older grants. Restart marks unfinished work interrupted and never replays a request. Save and quit flushes notes before stopping capture and interrupting processing. Request outcomes can remain uncertain remotely, so a retry may incur another charge.

## Qualification still required

Executed in the integrated worktree:

| Check                                                      | Result                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| Frontend typecheck, ESLint, formatting, production build   | Passed                                                         |
| Frontend tests                                             | 121 passed across 9 files                                      |
| Rust formatting and all-target Clippy with warnings denied | Passed                                                         |
| Rust tests                                                 | 125 passed; 2 native audio/keychain tests deliberately ignored |
| Native Cargo debug build                                   | Passed                                                         |
| Standalone Tauri debug build with embedded assets          | Passed; executable not launched                                |
| Diff whitespace and documentation local links              | Passed                                                         |

The synthetic checks cover accepted PCM samples and excluded paused markers, live queue saturation, provisional isolation, atomic final-publication rollback, exact request accounting, stale cancellation/run identities, saved-note barriers, explicit retry, restart preservation, and populated schema-v13 upgrades. A Windows-only loopback test failure exposed inherited nonblocking socket mode in the older model-download test helper; setting its accepted socket to blocking fixed the reproduced failure, and the full suite then passed.

Independent source review found and corrected attempt-adoption and stale-cancellation races, retry horizon bypass, unchanged note-wait event flooding, and an inaccessible SQLite finalization retry. Reviewers used the available model family; cross-family review was unavailable.

Focused checks can be repeated without recording devices or an external provider:

```sh
corepack pnpm build
corepack pnpm test
cargo test --locked --manifest-path src-tauri/Cargo.toml workflow_tests::
cargo test --locked --manifest-path src-tauri/Cargo.toml processing_control::
cargo test --locked --manifest-path src-tauri/Cargo.toml live_audio::
```

`actual_cloud_requests_from_saved_pcm_publish_final_summary_export_and_survive_restart` uses the real cloud/LLM helpers against a local loopback HTTP server. It inspects uploaded synthetic PCM samples, checks the saved-note/transcript summary body, publishes final output, exports, and reopens SQLite. Provisional rows in this scenario come from deterministic synthetic chunk markers. This is not a native runner or real-engine inference result.

`cancel_during_final_upload_survives_restart_and_reviewed_retry_completes` completes the combined synthetic scenario. It uses the same saved PCM and loopback server, publishes provisional rows, and cancels through the shared owner while the second final upload is pending. Only one upload is sent, one request stays counted, and the earlier transcript, notes, and audio survive. The test then reopens SQLite, which keeps the run cancelled without replaying anything. An explicit reviewed retry gets a new run identity, rejects the old run, clears the previews, and completes final transcription, summary, and export. Remaining acceptance work is isolated native workflow checks. Verify all stop paths, unavailable engines, save failures, selection/reconnect, cancellation races, keyboard access, and retained output. Keep #25 open for unmet checks. This report does not close #19 through #24 without their complete acceptance evidence.

Real-machine distinct audible tracks, queued/in-flight pause privacy, device loss/switch, sleep/wake, overflow/disk failures, and 60-minute relative drift below 100 ms remain separate gates. Earlier short recording permission does not authorize a new test. macOS and real-engine live inference remain unqualified. Real providers require separately authorized concrete content, destinations, and request limits. Provider qualification and the unexpected-exit investigation remain deferred as previously requested.

See [architecture](architecture.md), [user guide](user-guide.md), [privacy](privacy.md).
