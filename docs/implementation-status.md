# Implementation status

## Current boundary

OpenMeet has a notes-first desktop workspace, SQLite persistence, Windows capture, local Windows transcription, and optional Merge summaries and questions. Schema v9 is implemented. This is a preview with open qualification gates, not a complete MVP.

No platform has passed the full two-track capture gate. An earlier Windows attempt was blocked by a missing microphone. A later authorized two-second smoke test was recorded as passing in [log.md](../log.md), but it did not establish audible-content quality, pause privacy, device-failure behavior, or long-run drift. No recording was made during the recent UI and installation work.

macOS capture is a preview on Apple Silicon, macOS 14.2 or newer. It is not hardware-qualified, and permission denial has not been tested. Transcription remains Windows-only. Notes, audio, transcripts, summaries, and exports remain unencrypted. Simulations and fictional samples are visibly separate from desktop recordings and notes-only entries.

## Implemented features

| Area                   | Current implementation                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace              | Collapsible meeting library, source labels, notes/summary/transcript tabs, dedicated setup/settings panels, and persistent recording controls.                             |
| Notes                  | Notes-only entries, rename, Markdown textarea, 400 ms serialized autosave, revision checks, save-before-switch/export/quit, and failed-draft preservation.                 |
| Search                 | Title filtering and SQLite FTS5 matches across notes, transcript segments, and summaries.                                                                                  |
| Capture                | Windows selected microphone and output loopback, separate WAVs, timing JSONL, bounded queues, pause/resume/stop, tray controls, level meters, and configurable shortcuts.  |
| Local transcription    | Explicit verified downloads of whisper.cpp, selected Whisper model, and Silero VAD; language/vocabulary settings, progress/cancel, stored segments, and timing conversion. |
| Playback               | Per-track players, transcript seeking, note timestamps, and visible playback errors.                                                                                       |
| Merge                  | Backend keychain import, model discovery/selection, consented summaries, three templates, summary history/copy, bounded chunked summaries, and per-meeting questions.      |
| Export                 | Folder picker, source-aware Markdown, optional transcript/summary, filename preferences, and non-overwriting snapshots.                                                    |
| Recovery and retention | Interrupted-recording detection, repaired copies preserving originals, typed-confirmation delete audio/meeting, and disk usage.                                            |
| Development            | Pinned toolchains and lockfiles, just recipes, automated frontend/Rust checks, and CI definitions.                                                                         |

Implemented does not mean qualified. See [the user guide](user-guide.md), [architecture](architecture.md), and [privacy](privacy.md) for behavior and limits.

## Feature batch (2026-10-12)

The feature-plan M0–M5 implementation added summary history/templates/copy, rename, meters and stop shortcut, note-only entries, guarded deletion, FTS5 search, playback/seek, timestamps, speech settings/progress/cancel, chunked summaries, questions, export options, and interrupted-audio recovery. Deferred items include webview key entry, compression, encryption, local LLMs, and M6 release work. No milestone's complete native, hardware, and provider exit gate is claimed.

The subsequent UI polish added a quieter workspace, dedicated settings/setup layouts, a first-export folder flow, dismissible notices, preserved drafts while panels are open, and playback failure handling. Installation documentation and just commands were added afterward.

## Latest executed local checks

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

## Open work

### Stabilization and native UI

- Diagnose delayed or blank development startup, and verify repeated cold starts.
- Bound capture-worker control acknowledgements and test stalled/crashed workers and SQLite failures during state changes.
- Verify obsolete audio-health cleanup and finalized metadata refresh without replacing edited drafts.
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
- Validate live Merge chat completions and questions with explicit content consent, including each template, long-input chunking, provider failures, and request costs.
- Preserve the last good transcript/summary on failed retries. A durable processing queue and restartable inference jobs are not implemented.
- Any future API-key entry must keep credentials out of frontend state and logs. The current supported flow remains environment import into the OS keychain.

### Platform, privacy, and release

- Qualify the Apple Silicon tap path: audible distinct tracks, permission denial, duplex refusal on a real device, and the same 60-minute drift gate as Windows. Minimum OS is 14.2. Transcription on macOS is still unimplemented.
- Run an egress-blocked local workflow and a separate cloud opt-in check. Complete end-to-end pause and privacy qualification.
- Keep snapshot exports until a tested external-edit merge implementation exists.
- Complete transitive license notices and model attribution before distribution.
- Deliver installers, signing/notarization, and release validation. Bundling remains disabled; no updater is implemented.

Compression, encryption, local LLMs, live STT, diarization, bots, automatic meeting detection, and SharePoint integration are not delivered. See [feature-plan.md](feature-plan.md) for acceptance criteria and deferred scope.
