# Implementation status

## Current boundary

OpenMeet has a notes-first desktop workspace, SQLite persistence, Windows capture, local Windows transcription, and optional user-configured OpenAI-compatible LLM/cloud-STT connections. Schema v14 adds durable automatic-processing runs, bounded provisional transcripts, and request accounting to the session-consent records. Schema v15 adds custom summary templates and saved summary instructions. Schema v16 adds editable tasks. Schema v17 records user-edited summary versions. Schemas v18–v20 add speaker names, transcript edits with earlier transcripts, and summary freshness. Schema v22 adds saved question threads, v23 stores the optional transcript file formats, v24 adds recipes and saved answers across meetings, v25 stores the automatic-processing default (previously in webview storage) and the default summary template, v26 adds opt-in meeting detection on Windows, extended to macOS 14.2+ through CoreAudio process objects with v27 keeping ignored apps' names: a prompt when another app holds the microphone for two polls, once per microphone session, with a per-app ignore list. A prompt only opens recording setup. It is unqualified on a real call; the macOS path was type-checked for aarch64-apple-darwin but never run. New recording and Settings can refresh the device list without replacing a chosen device. This is a preview with open qualification gates, not a complete MVP.

## Phase 3 workflow implemented, qualification open

The UI defaults to recording only. Before starting an enabled workflow, users review live-only, final-only, or live plus final transcription and an optional final summary. Participant recording permission remains independent. Reviews name destinations, models, both tracks, future audio and saved-note scope, and finite processing budgets.

Rust now owns the accepted-sample live handoff, a shared operation owner for manual and automatic processing, durable workflow stages, cancellation, per-request accounting, atomic final transcript replacement, and saved-note acknowledgement before automatic summaries. The UI displays at most 200 provisional segments, preserves note drafts during notifications, and requires a fresh review for retry. Restart interrupts unfinished work without replaying requests. Schema-v13 grants require renewed review after migration.

Implementation is present for issues #19 through #24. Their complete acceptance gates and combined qualification under #25 are not declared passed. Integrated Windows checks passed with 121 frontend tests and 125 Rust tests; two native tests remained ignored. Formatting, typecheck, lint, frontend build, all-target Clippy, Cargo build, and standalone Tauri debug build passed. See [workflow implementation and qualification](phase-3-workflow-verification.md), [the execution plan](phase-3-execution-plan.md), and [the historical consent increment](phase-3-consent-verification.md). No hardware or external provider result is inferred from the implementation.

No platform has passed the full two-track capture gate. An earlier Windows attempt was blocked by a missing microphone. A later authorized two-second smoke test was recorded as passing in [log.md](../log.md), but it did not establish audible-content quality, pause privacy, device-failure behavior, or long-run drift. No recording was made during the recent UI and installation work.

macOS capture is an unqualified preview on Apple Silicon, macOS 14.2 or newer. Its local speech engine requires the separately pinned local whisper.cpp build. Permission denial and the integrated macOS workflow remain unqualified. Cloud STT processes finalized recording tracks or finalized temporary live chunks. Notes, audio, transcripts, summaries, and exports remain unencrypted. Production simulation/sample creation is removed; historical fictional records remain labeled and accessible.

## Implemented features

| Area                    | Current implementation                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace               | Collapsible meeting library, source labels, notes/summary/transcript tabs, dedicated setup/settings panels, and persistent recording controls.                             |
| Notes                   | Notes-only entries, rename, Markdown textarea, 400 ms serialized autosave, revision checks, save-before-switch/export/quit, and failed-draft preservation.                 |
| Search                  | Title filtering and SQLite FTS5 matches across notes, transcript segments, and summaries; user tags filter both and export in frontmatter.                                                                                  |
| Capture                 | Windows selected microphone and output loopback, separate WAVs, timing JSONL, bounded queues, pause/resume/stop, tray controls, level meters, and configurable shortcuts.  |
| Local transcription     | Explicit verified downloads of whisper.cpp, selected Whisper model, and Silero VAD; language/vocabulary settings, progress/cancel, stored segments, and timing conversion. |
| Automatic processing    | Reviewed session scopes, bounded live previews, final transcription, optional summary, saved-note acknowledgement, cancellation, and explicit retry.                       |
| Playback                | Per-track players, transcript seeking, note timestamps, and visible playback errors.                                                                                       |
| Transcript corrections  | Per-meeting speaker names, segment edits with revert, read-only earlier transcripts kept on re-transcription, and out-of-date summary notices.                          |
| Provider settings       | Reusable cloud/local API connections, OS-keychain credentials, independent summary/speech assignments, optional discovery/custom IDs, and revision-bound consent.          |
| Cloud transcription     | Explicit audio confirmation, frozen bounded WAV chunks, pause-aware timing, timed/untimed results, cancellation and atomic transcript/provenance replacement.              |
| Summaries and questions | Configured chat API, three built-in templates plus custom templates and saved instructions, history/copy, user edits saved as labelled versions, bounded chunked summaries, and per-meeting questions saved as threads with contextual follow-ups (schema v22). Ask across meetings answers one question over 1 to 20 chosen meetings (or a tag's meetings) in a single consented request with validated `[M2 1:01]` source links; answers are saved with their scope and deleted with any of their meetings (schema v24). Recipes (five built in plus saved ones) fill either question box. Selected note text can be rewritten after a consent card that sends only the selection and request; the result replaces the selection only when accepted. Content too long for one request is not refused: local lexical (FTS5 keyword) retrieval sends only matching transcript excerpts and notes, disclosed on the consent card, and a question with no match sends nothing and shows "insufficient evidence" (#35). Retrieval is keyword-based, not semantic; its quality on real long meetings is unverified. |
| Tasks                   | Editable tasks with owner, done state, source, and optional due date; manual entry or explicit import from a summary's Action items; exported as a checklist.              |
| Export                  | Folder picker, source-aware Markdown, optional transcript/summary, filename preferences, optional TXT/SRT/VTT transcript files, and non-overwriting snapshots.               |
| Recovery and retention  | Interrupted-recording detection, repaired copies preserving originals, typed-confirmation delete audio/meeting, and disk usage.                                            |
| Development             | Pinned toolchains and lockfiles, just recipes, automated frontend/Rust checks, and CI definitions.                                                                         |

Implemented does not mean qualified. See [the user guide](user-guide.md), [architecture](architecture.md), and [privacy](privacy.md) for behavior and limits.

## Phase 2 settings and model library (2026-10-14)

Cloud API, Local, and General tabs, reusable connections, schema-v12 migration, bounded local model discovery, verified catalog import, and explicit public Hugging Face search/download are implemented. Routine checks passed with 104 frontend tests and 87 Rust tests; two native tests remained ignored. Native checks confirmed tabs, draft preservation, keyboard navigation, and opening the folder picker in an isolated empty profile. Completing folder selection was blocked by the Windows helper. Provider/keychain workflows and model-library end-to-end qualification remain open. See [Phase 2 verification](phase-2-settings-verification.md). Live transcription and automatic processing were deferred in that Phase 2 increment; the Phase 3 implementation is described above.

## Feature batch (2026-10-12)

The feature-plan M0–M5 implementation added summary history/templates/copy, rename, meters and stop shortcut, note-only entries, guarded deletion, FTS5 search, playback/seek, timestamps, speech settings/progress/cancel, chunked summaries, questions, export options, and interrupted-audio recovery. Deferred items include webview key entry, compression, encryption, local LLMs, and M6 release work. No milestone's complete native, hardware, and provider exit gate is claimed.

The subsequent UI polish added a quieter workspace, dedicated settings/setup layouts, a first-export folder flow, dismissible notices, preserved drafts while panels are open, and playback failure handling. Installation documentation and just commands were added afterward.

## Provider settings checks (2026-10-13)

`just check` passed on Windows after restoring the missing Windows SDK. It ran frontend typecheck, lint, formatting, 88 tests and production build, then Rust formatting, Clippy with warnings denied, 67 passing tests and native debug build. The hardware test remained ignored. Additional synthetic SQLite upgrade checks covered populated v0/v2/v5/v9 databases and FTS/foreign-key preservation. Synthetic API servers do not establish live provider compatibility.

`just build` produced a standalone release executable. The prior app closed through Save and quit, and the temporary Vite server was stopped. The rebuilt app loaded from `http://tauri.localhost/` with the existing library and Saved/Not recording states visible. Native Settings showed independent LLM fields, local model choices, and cloud speech fields/disclosure after switching modes. Switching back preserved the existing `small` local model. Local mode was restored, and the app was left running. The pause-shortcut warning remains. No real key was entered, content uploaded, or recording started; successful native key save/replace/remove and live provider compatibility remain unqualified.

Provider settings use independent role revisions and OS-keychain references, not stored API keys. Cloud cancellation covers chunk preparation and final publication; settings changes before upload invalidate the plan. Local/cloud reruns replace generated transcript rows atomically, including untimed and empty results. Production fixture/simulation creators and their UI/IPC are absent; historical source interpretation and test fixtures remain.

## Previous installation checks

The installation work in this conversation ran the following on Windows against the current application code. These are executed results, not results inferred from this documentation edit.

| Check                                             | Result                                                                                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `just setup`                                      | Passed using Rust 1.99.0 and pnpm 12.10.1.                                                                                        |
| TypeScript, ESLint, frontend formatting and build | Passed through `just check`.                                                                                                      |
| Vitest                                            | 76 tests passed across 5 files.                                                                                                   |
| Rust formatting and Clippy with warnings denied   | Passed through `just check`.                                                                                                      |
| Rust tests                                        | 57 passed; 1 hardware test deliberately ignored.                                                                                  |
| Native debug build                                | Passed with `--locked`.                                                                                                           |
| `just build`                                      | Passed; Windows release executable produced. It was not launched.                                                                 |
| `just dev` native startup                         | Vite and the app started; the window initially stayed blank, then loaded the saved library and notes workspace. Delay unresolved. |
| Shortcut registration                             | Pause shortcut reported unavailable; alternate shortcut registration was not checked.                                             |

Checks used Node 24.21.0, installed Visual Studio 2022 C++ tools, and an existing temporary Rust installation. Fresh-machine setup and macOS were not tested. No real capture, playback, in-app transcription, live summary, question submission, recovery, deletion, or export was performed in that installation smoke check.

Previous work recorded cargo-deny checks, a local engine spot check, and broader fixture-based UI checks. Those are historical evidence in [log.md](../log.md), not new qualification results. Current remote CI has not been rechecked here.

On 2026-10-13, launching the earlier release executable reproduced `ERR_CONNECTION_REFUSED` at the development URL. The release recipe used plain Cargo without Tauri's production asset protocol. `just build` now invokes the Tauri CLI, but the rebuild was blocked by missing Windows SDK headers and libraries on this machine. The existing executable was relaunched with a local Vite preview server serving `dist/`; its saved library and notes workspace loaded. This verifies the temporary server-backed launch, not a rebuilt standalone executable. The pause-shortcut warning remains.

## Foundation qualification follow-up

[The follow-up report](foundation-qualification-follow-up.md) records a timing-write failure that could mark an incomplete track finalized, the correction and regression tests, an authorized short two-file capture, and partial native note/export checks. Further fixes reject damaged local timing, correct segment endpoints at pause boundaries, and allow recovery retries after failed SQLite publication while retaining all copies. Final full local checks passed with 105 frontend tests and 97 Rust tests, with two native tests ignored. Hardware privacy, failure scenarios, drift, complete shortcut/playback qualification, and providers remain open. Subsequent native note/export checks passed, closing #11. The earlier self-closing windows remain an unresolved report under #13; monitored retries have not reproduced it.

## Open work

The October 14 [Phase 1 foundation verification](phase-1-foundation-verification.md) records startup, draft-refresh, audio-health, and capture-worker fixes. `just check` passed with 98 frontend tests and 74 Rust tests, with two native tests ignored by the routine suite. Separately selected short hardware and synthetic Windows keychain tests each passed once. These results do not complete hardware, native UI, or provider qualification.

### Stabilization and native UI

- The startup pause-shortcut warning comes from another application owning CommandOrControl+Shift+Space (Windows error 1409). The warning now names every failing shortcut and chord; choose another shortcut in Settings. The default is unchanged.
- Verify repeated native cold starts after removing optional discovery from the saved-notes startup dependency.
- Qualify native failures after bounding worker control waits and testing stalled workers, late finalization, and SQLite publication failure/retry.
- Qualify audio-health cleanup and draft-preserving finalized metadata refresh in the native app; regression tests pass.
- Exercise note persistence across restart, first export and cancelled folder selection, history/copy, settings, recovery, and guarded deletion in the native app.
- Verify keyboard-only operation, 720×580 minimum size, 200% zoom, error visibility, and playback failure handling in the webview.
- Validate clipboard permissions, asset-protocol refusal outside the audio folder, global stop registration, and filesystem symlink deletion bounds on a suitable Windows machine.
- Check a fresh checkout and current Windows/macOS/dependency-hygiene CI. LF enforcement exists; a green remote workflow is not implied.

### Windows capture qualification

Use an explicitly authorized recording with identifiable synthetic signals. Verify distinct audible tracks, absence of audio from paused intervals including queued callbacks and resume boundaries, correct device selection, unavailable devices, permission denial, silent loopback, startup rollback, device loss/switch, sample-rate changes, sleep/wake, disk full, overflow, and recovery after interruption.

Run a 60-minute two-track test with markers near both ends, recording device/driver details, offsets, drift, and dropped frames. Required relative drift is below 100 ms. Two finalized WAV files or a passing build cannot substitute for this gate.

### Transcription and summaries

- Qualify real-engine progress, cancellation, silence handling, accuracy, and performance across selected models/languages using licensed or consented audio.
- Test the complete in-app record/transcribe/summarize/export path after a fresh install and restart.
- Validate each configured provider/model combination with explicit content consent, including chat templates/questions, long-input chunking, audio limits, formats, failures, and request costs.
- Qualify preservation of the last good transcript/summary through failed retries in the native app. Durable workflow state and explicit reviewed retry are implemented; restart never replays inference or provider requests.
- Qualify native Settings key entry, replacement/removal, OS-keychain failures, and publication/cleanup failures. The password field is transient; keys are not returned to frontend state or logs.

### Platform, privacy, and release

- Qualify the Apple Silicon tap path: audible distinct tracks, permission denial, duplex refusal on a real device, and the same 60-minute drift gate as Windows. Minimum OS is 14.2. The separately pinned local transcription path remains unqualified.
- Run an egress-blocked local workflow and a separate cloud opt-in check. Complete end-to-end pause and privacy qualification.
- Keep snapshot exports until a tested external-edit merge implementation exists.
- Complete transitive license notices and model attribution before distribution.
- Deliver installers, signing/notarization, and release validation. Bundling remains disabled; no updater is implemented.

Compression, encryption, managed local LLMs, diarization, bots, automatic meeting detection, and SharePoint integration are not delivered. See [feature-plan.md](feature-plan.md) for acceptance criteria and deferred scope.
