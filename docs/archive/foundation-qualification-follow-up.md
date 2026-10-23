> **Archived: describes the retired Rust/Tauri app (git tag rust-final). Not current. Do not use as a reference for the Python build.**

# Foundation qualification follow-up

Work against issues #7–#13 uses the merged Phase 2 baseline from PR #48. This follow-up records completed note/export qualification for #11 and partial progress on the remaining issues.

## Capture failure correction

A synthetic read-only timing sink reproduced a bug: a timing-index write failed after audio samples reached the WAV, but stop marked the track finalized because its last timing flush and WAV-header finalization succeeded. That could exclude the incomplete track from recovery candidates.

The track writer now retains write/checkpoint failure state through finalization. A later successful flush cannot mark the track complete. Existing audio and timing artifacts are retained. The public Track payload and database schema are unchanged. Tests inspect actual WAV samples, unchanged timing data, frame counters, and the incomplete flag.

A separate deterministic test delays an old-generation packet at the queue-publication boundary until after pause and resume. It verifies that both microphone and system WAVs and timing indexes contain only accepted pre-pause and resumed samples. This tests the packet-publication interleaving; it does not simulate every native callback instruction or qualify hardware privacy.

## Checks executed

The full Windows `just check` passed: typecheck, lint, formatting, frontend production build, 104 frontend tests, Rust formatting, Clippy with warnings denied, 90 Rust tests, and native debug build. Two native tests remained ignored in this routine suite. The timing-write regression failed before the correction and passed afterward. Removing the generation check temporarily made the delayed-packet regression fail as expected; restoring it returned all 14 routine audio tests to passing, with the hardware test ignored. The normal-identifier standalone Tauri debug build also passed after the final source restoration.

Local logs are retained in the original checkout under `.audit/foundation-qualification/`: `full-checks.log`, `timing-failure-before.log`, `timing-failure-after.log`, and `pause-interleaving.log`, `pause-mutation.log`, `audio-final.log`, `native-profile-results.json`, and `normal-final-build.log`.

## Further pause and recovery corrections

Two local-transcription regressions were reproduced before fixing them. A missing timing index still reached engine setup, and a segment ending at the last pre-pause frame was extended to the resumed timestamp. Local transcription, cloud preparation, and transcript-to-audio seeking now share the existing strict timing-index validation. Missing, malformed, incomplete, oversized, overflowing, or backwards indexes fail visibly. Previous transcripts and original files remain unchanged. Validation runs before the local engine command is created and freezes that track's timing for result mapping.

Start and end positions use different sides of a pause boundary. In the regression fixture, a pre-pause segment now ends at 2 seconds instead of 8 seconds, while the next segment starts at 8 seconds. Extreme seek inputs clamp within a valid file without overflowing. The frontend test verifies that a rejected timing request displays its error and never calls playback with a guessed position.

A synthetic capture-to-processing test writes both track WAVs through the real sample queues and writers, then prepares and sends four WAV chunks to a loopback mock server. Inspection of every PCM sample proves that queued/paused marker samples are absent and the two track signals remain separate. The mock response maps resumed segments to 8–9 seconds. This uses no microphone, real provider, or external upload and does not establish hardware pause privacy.

A separate recovery regression reproduced a failed SQLite publication after a repaired WAV had already been created. Reusing the fixed recovered filename prevented another attempt. Each attempt now chooses a fresh `kind.recovered-<UUID>.wav` path. The test injects the publication failure, retries successfully, checks both repaired copies byte-for-byte, and preserves the interrupted original. Failed attempts can retain additional copies and require additional disk space; nothing is automatically deleted.

Evidence is retained locally in `local-timing-before.log`, `local-boundary-before.log`, `shared-timing-tests.log`, `pause-processing-test.log`, `recovery-retry-before.log`, and `recovery-retry-after.log`. The final combined `just check` passed with 105 frontend tests and 97 Rust tests, with two native tests ignored, plus typecheck, lint, formatting, frontend build, Rust formatting, Clippy with warnings denied, and native debug build. Results are recorded in `final-checks.log`. The standalone Tauri debug build also passed after these changes; its log is `final-standalone-build.log`. No new native or hardware qualification is inferred from that build.

## Authorized short hardware check

The user explicitly authorized a short local recording test up to 30 seconds, including microphone/system audio and pause/resume. Only the named ignored test `audio::tests::windows_devices_open_and_stop_writes_both_wavs` was selected. It passed once, using the SoundCore 2 microphone and output. It recorded approximately 1.3 seconds of active audio with a 300 ms pause, finalized both WAVs, and checked frame counts against WAV metadata. Its temporary artifacts were removed by the existing test. No upload occurred.

This hardware run preceded the timing-failure correction. It establishes device opening and short two-file capture, not intended audible signals, hardware pause exclusion, device-loss behavior, or clock accuracy. The separate 60-minute drift run was not authorized or started. See local `audio-short.log`.

## Native notes and export checks

A standalone app with identifier `dev.openmeet.foundationqualification.20261014` used an isolated profile. The normal application profile was not opened or changed. A copy of the qualification executable lives in a temporary folder, so it does not lock the normal build.

Native checks created two fictional notes, autosaved accented/Japanese text, reopened the profile, and switched back to the original note with the exact text preserved. Read-only inspection of the isolated SQLite database confirmed the text and revision. Export opened the native folder picker; cancellation returned to the note and left the destination unset.

## Completed native note/export qualification

A later monitored run completed the folder picker using the full-sized dialog screenshot. The helper had returned two 16 by 16 overlay images before the actual dialog; an earlier coordinate retry used the wrong image. The native app exported the exact fictional note. After an external edit, re-export preserved the original file's SHA-256 and created a separate snapshot.

A temporary SQLite trigger refused updates only to fictional note B. The native app displayed the save error, retained its edited draft, prevented switching to another note, and refused Save and quit. After removing only that trigger, retry saved the exact draft and exited with code 0. Relaunching showed the exact recovered text. The destination, earlier note, and externally edited snapshot were preserved. Issue #11 is closed and tracker #6 is updated.

The isolated profile also contains a clearly labeled fictional fixture with a generated one-second tone and hand-written summary. Copy summary succeeded, and pasting into the temporary search field verified the exact fictional text. The field was cleared afterward. Fictional-source audio is intentionally excluded from playback controls, so this did not qualify real recording playback or inference. No real clipboard contents were read.

Alternative pause and stop shortcuts, Control+Shift+F9 and Control+Shift+F10, registered and persisted in the test profile. A subsequent cold start showed Saved/Not recording without the shortcut warning. The primary profile's shortcuts were not changed. Sending the pause chord while idle did not start recording; active-recording shortcut actions remain unverified.

The native window enforced a 720 by 580 client minimum, observed as 722 by 612 outer pixels. Navigation, content tabs, scrolling, and the recording bar remained accessible. Runtime evidence is retained in `native-follow-up-results.json`, `native-export-record.json`, and the process-monitor JSON files under the local audit folder.

## Unexpected-exit investigation

The user confirmed that the earlier qualification windows closed by themselves. The cause remains unresolved. A fresh process monitor observed the application through native export, injected save failure/retry, clipboard, shortcut configuration, and window sizing. Two observed exits followed deliberate Save and quit actions and returned code 0. The second monitored session remained available for several minutes of interaction before that intentional exit. A subsequent cold start with the saved alternative shortcuts had no startup warning.

The earlier unexpected exits have not been reproduced under monitoring. No matching recent Windows Application Error event or OpenMeet crash dump was found. These observations do not disprove the reported exits or establish a crash fix. Issue #13 remains open, including the unexpected-exit report, active-recording hotkeys, playback, zoom, and remaining keyboard/accessibility checks. No process was forcibly terminated.

## Remaining issue gates

- #7: distinct audible track signals and the selected-device matrix.
- #8: real paused-audio exclusion. Synthetic capture-to-upload sample exclusion and local pause-boundary mapping pass; hardware and actual inference qualification remain open.
- #9: native device loss/switch, sleep/wake, disk-full/overflow, and recovery scenarios. Injected timing-write failure and database-publication recovery retries are covered; a real full disk was not used.
- #10: separately authorized 60-minute measurement below 100 ms relative drift.
- #11: completed on Windows in the isolated native profile; the issue is closed with the evidence above.
- #12: native credential UI and explicit live-provider/content qualification.
- #13: unexplained earlier exits, active-recording shortcut actions, real recording playback, zoom, and remaining keyboard/accessibility checks. Clipboard, alternative-shortcut registration/persistence, a subsequent warning-free start, and minimum-size checks passed.

Only #11 is closed by the completed note/export checks. The remaining issues stay open. No real keys, provider-content requests, or model downloads were used.

The user deferred live provider qualification under #12 and the unexpected-exit investigation under #13. Both remain open.
