# OpenMeet implementation checklist

Based on the [Granola/Otter comparison](granola-otter-comparison.md) and the [settings and processing design](local-model-settings-design.md), reviewed October 14, 2026.

Unchecked items are remaining work, not instructions to start recording, upload content, or publish changes. Keep implementation and verification separate. Check an item only when its stated result has evidence in the implementation status or linked work record.

GitHub tracker: [#6](https://github.com/rahuloruganti/OpenMeet/issues/6). Each checkbox links to its issue.

## 1. Verify the existing foundation

These features have implementations. Finish their qualification before claiming a dependable meeting workflow.

Work has started. See [Phase 1 verification results](phase-1-foundation-verification.md) for fixes, executed checks, and the remaining gates. The items remain unchecked until their full acceptance criteria pass.

- [ ] Qualify Windows microphone and system-audio capture with distinct audible signals and the selected devices. Real recording requires explicit authorization. ([#7](https://github.com/rahuloruganti/OpenMeet/issues/7))
- [ ] Verify pause privacy across queued callbacks, in-flight work, and resume boundaries. Paused audio must not be saved, transcribed, or uploaded. ([#8](https://github.com/rahuloruganti/OpenMeet/issues/8))
- [ ] Verify device loss/switching, sleep/wake, disk-full/overflow failures, interrupted recording, and recovery without losing original artifacts. ([#9](https://github.com/rahuloruganti/OpenMeet/issues/9))
- [ ] Complete an authorized 60-minute capture with measured relative track drift below 100 ms. ([#10](https://github.com/rahuloruganti/OpenMeet/issues/10))
- [x] Verify notes survive switching, export, quit, restart, and save failures. Preserve external Markdown edits and cancelled export behavior. ([#11](https://github.com/rahuloruganti/OpenMeet/issues/11))
- [ ] Verify real provider compatibility and native keychain save/replace/remove behavior, cancellation, and long-meeting coverage with explicitly authorized test content. ([#12](https://github.com/rahuloruganti/OpenMeet/issues/12))
- [ ] Resolve the pause-shortcut warning and verify native cold starts, playback/clipboard permissions, keyboard access, minimum window size, and visible failures. ([#13](https://github.com/rahuloruganti/OpenMeet/issues/13))

## 2. Complete settings and model selection

Follow the existing [chosen settings design](local-model-settings-design.md#chosen-settings-design). Generic cloud and local compatible-server connections already exist.

- [x] Add separate Cloud API and Local settings tabs with reusable saved connections and independent speech/text assignments. Switching tabs or providers must preserve saved configurations. ([#14](https://github.com/rahuloruganti/OpenMeet/issues/14))
- [x] Migrate existing provider references, credentials, selected Whisper model, notes, and transcript provenance without resetting data. ([#15](https://github.com/rahuloruganti/OpenMeet/issues/15))
- [x] Discover model files in bounded common-folder and user-selected-folder scans. Show examined locations, format, compatibility, and whether an external server is required. ([#16](https://github.com/rahuloruganti/OpenMeet/issues/16))
- [x] Add explicit Hugging Face search and verified downloads for supported public single-file models. Show size/license, pin revision and hash, and preserve existing files. ([#17](https://github.com/rahuloruganti/OpenMeet/issues/17))
- [ ] Verify connection/model discovery, unavailable servers, failed downloads, cancellation, and configuration persistence. A discovered model file must not be shown as a ready inference server. ([#18](https://github.com/rahuloruganti/OpenMeet/issues/18))

## 3. Deliver the live-to-finished meeting workflow

The automatic workflow implementation is now present. The acceptance items below remain unchecked until their complete evidence is recorded. Source review and synthetic tests do not establish native usability, hardware privacy, or provider compatibility. See [workflow implementation and qualification](phase-3-workflow-verification.md).

| Issue | Implementation present | Acceptance still open |
| --- | --- | --- |
| #19 | Reviewed future-content scope, independent participant consent, revisions, limits, and exact request accounting. | Integrated native consent/invalidation workflow. |
| #20 | Bounded accepted-sample chunks, shared owner, local/API helper reuse, and incomplete-coverage reporting. | Real-engine live compatibility, native overload/failure behavior, hardware pause privacy. |
| #21 | Stable provisional IDs, timestamps, labels, bounded rendering, selection/reconnect guards, and draft preservation. | Full native reconnect, switching, and keyboard workflow. |
| #22 | Atomic final transcript/provenance replacement and provisional retirement. | Combined native stop/finalization/failure workflow. |
| #23 | Shared-stop final transcription and optional summary behind saved-note acknowledgement. | Native sequencing and explicitly authorized provider compatibility. |
| #24 | Scoped cancellation, fresh reviewed retry, preserved completed stages, and restart interruption without replay. | Complete native cancellation/restart/failure qualification. |
| #25 | Synthetic sample, database, owner, HTTP, and frontend tests exist. | Final integrated evidence, combined end-to-end scenario, native and separate external qualification. |

- [ ] Define and test explicit session consent for live audio, final audio, and automatic text processing before enabling automatic cloud calls. Bind destination and scope, invalidate consent on relevant changes, and retain existing per-action safeguards until the replacement is verified. ([#19](https://github.com/rahuloruganti/OpenMeet/issues/19))
- [ ] Add a bounded Rust transcription worker that processes audio during recording without blocking capture callbacks or accepting paused audio. ([#20](https://github.com/rahuloruganti/OpenMeet/issues/20))
- [ ] Display live transcript segments with stable identities, timestamps, track labels, and visibly provisional text. ([#21](https://github.com/rahuloruganti/OpenMeet/issues/21))
- [ ] Reconcile provisional text with the final transcript after stop without duplicates or changes to user notes. ([#22](https://github.com/rahuloruganti/OpenMeet/issues/22))
- [ ] Automatically sequence stop, final transcription, and summary generation after the required consent. Show progress and a clear completed/failed state. ([#23](https://github.com/rahuloruganti/OpenMeet/issues/23))
- [ ] Support cancellation and restart recovery for processing. Preserve previous successful transcripts/summaries and require explicit action for another billable request. ([#24](https://github.com/rahuloruganti/OpenMeet/issues/24))
- [ ] Verify synthetic streaming, queue limits, pause/resume, cancellation, restart, and visible UI updates. Keep real-device and live-provider results separate from synthetic checks. ([#25](https://github.com/rahuloruganti/OpenMeet/issues/25))

## 4. Make notes and follow-ups trustworthy

- [ ] Separate remote speakers rather than labeling everyone `Others`. Preserve unknown labels and timing when attribution is uncertain. ([#26](https://github.com/rahuloruganti/OpenMeet/issues/26))
- [ ] Add speaker-name corrections and transcript editing. Keep transcript versions, summary freshness, search, and export consistent with edits. ([#27](https://github.com/rahuloruganti/OpenMeet/issues/27))
- [ ] Add validated source references to summaries, answers, and action items. Clicking a reference must open the matching stored segment or audio time. ([#28](https://github.com/rahuloruganti/OpenMeet/issues/28))
- [ ] Allow editing generated notes and regeneration without silently replacing user edits. Preserve previous versions. ([#29](https://github.com/rahuloruganti/OpenMeet/issues/29))
- [ ] Add user-defined summary templates and saved instructions while retaining the three existing templates. ([#30](https://github.com/rahuloruganti/OpenMeet/issues/30))
- [ ] Store action items as editable tasks with owner, completion state, source, and optional established due date. Keep unknown ownership/dates explicit and Markdown export consistent. ([#31](https://github.com/rahuloruganti/OpenMeet/issues/31))

## 5. Add organization and meeting memory

- [ ] Add user-created folders or tags to organize meetings while retaining existing full-text search. ([#32](https://github.com/rahuloruganti/OpenMeet/issues/32))
- [ ] Save question/answer threads with contextual follow-ups instead of discarding each answer. ([#33](https://github.com/rahuloruganti/OpenMeet/issues/33))
- [ ] Answer questions over selected meetings or folders with source links. Respect the selected scope and obtain consent for any cloud text submission. ([#34](https://github.com/rahuloruganti/OpenMeet/issues/34))
- [ ] Retrieve relevant content for long meetings and libraries instead of rejecting every question that exceeds one request. Show insufficient evidence rather than inventing an answer. ([#35](https://github.com/rahuloruganti/OpenMeet/issues/35))

## 6. Finish supported-platform delivery

- [ ] Complete and qualify the macOS capture and local transcription preview if macOS remains a supported target. Verify permissions and real two-track capture independently on macOS. ([#36](https://github.com/rahuloruganti/OpenMeet/issues/36))
- [ ] Complete installer packaging, install/upgrade/uninstall checks, release-license review, and signing/notarization requirements for each release target. ([#37](https://github.com/rahuloruganti/OpenMeet/issues/37))
- [x] Recheck fresh-checkout builds and current CI on supported platforms. Record executed results and keep hardware/provider gates open until actually passed. ([#38](https://github.com/rahuloruganti/OpenMeet/issues/38))

## Later-phase options

These are broader parity gaps, not prerequisites for the personal desktop workflow. Keep them deferred until their planned phase is selected.

- [ ] Calendar-linked meetings, titles, participants, and opt-in recording reminders/detection. Detection alone must not authorize recording. Opt-in microphone-use detection prompts are implemented on Windows and macOS 14.2+ (schemas v26–v27) and not yet qualified on a real call; calendar work is still open. ([#39](https://github.com/rahuloruganti/OpenMeet/issues/39))
- [ ] Existing audio/video file import, primarily for Otter-style use cases. ([#40](https://github.com/rahuloruganti/OpenMeet/issues/40))
- [ ] Additional transcript exports such as TXT, SRT, and VTT. Keep the current safe Markdown snapshots. ([#41](https://github.com/rahuloruganti/OpenMeet/issues/41))
- [ ] Selected-text AI rewrites, pre-meeting briefs, and follow-up email drafts. ([#42](https://github.com/rahuloruganti/OpenMeet/issues/42))
- [ ] Optional encrypted local storage and a tested backup/restore design. Current artifacts remain unencrypted until implemented. ([#43](https://github.com/rahuloruganti/OpenMeet/issues/43))
- [ ] Shared links, permissions, collaborative notes, team workspaces, and synchronization. ([#44](https://github.com/rahuloruganti/OpenMeet/issues/44))
- [ ] Joining bots, external task/CRM/Slack integrations, and the separately planned SharePoint delivery workflow. ([#45](https://github.com/rahuloruganti/OpenMeet/issues/45))
- [ ] Mobile clients, browser extensions, and automatic application updates if product scope expands to require them. ([#46](https://github.com/rahuloruganti/OpenMeet/issues/46))

## Reuse these existing features

Do not rebuild SQLite persistence, protected note autosave, separate Windows audio tracks, pause/resume controls, local Whisper/VAD downloads, generic provider connections including loopback servers, transcription progress/cancellation, playback/seeking, full-text search, the three summary templates, summary history, per-meeting questions, recovery, or non-overwriting Markdown snapshots.

Their presence does not close the qualification checks above. Use [implementation status](implementation-status.md) for executed evidence and [the comparison report](granola-otter-comparison.md) for source locations and competitor references.

Phase 2 settings and model-library code is merged in PR #48; native qualification remains partial. See [executed checks and remaining gates](phase-2-settings-verification.md). Feature issues #14–#17 are closed as implemented; qualification issue #18 remains open. The [foundation follow-up](foundation-qualification-follow-up.md) records completed native note/export checks for #11 and remaining qualification work.
