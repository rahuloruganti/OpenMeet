# OpenMeet compared with Granola and Otter

Checked on October 14, 2026. Scope: the core workflow before, during, and after a meeting.

Use the [implementation checklist](implementation-checklist.md) to track the remaining work.

## Update: October 20, 2026

Most gaps in the table below have since been implemented (implemented, not qualified): live transcript previews and automatic post-stop processing (Phase 3), You/Others speaker names, transcript editing with earlier transcripts, editable summary versions, custom templates and saved instructions, structured tasks, validated `[m:ss]` source links, tags, saved question threads with follow-ups, questions across 1 to 20 meetings with keyword retrieval for long content, and TXT/SRT/VTT transcript files. The "OpenMeet today" column reflects October 14 and is kept for history.

Granola's current help-center index (`docs.granola.ai/llms.txt`, read October 20) also lists Recipes, follow-up email drafts, profile context, pre-meeting briefs, People and Companies, deleted-note restore, CSV export, screen snapshots, an API/MCP server, Zapier/CRM/Slack/Notion integrations, workspaces, and mobile/Apple Watch clients. This update added:

- **Recipes**: five built-in saved questions (including a follow-up email draft) plus user-saved ones, usable in both question boxes. Choosing one only fills the box; review and consent are unchanged.
- **Saved answers across meetings**: stored with their ordered scope and deleted with any source meeting.
- **Selected-text rewrite** in notes: only the selection and request are sent after consent; the result replaces the selection only when accepted.

Still not built: separate remote speakers (#26), calendar sync, reminders and detection (#39), pre-meeting briefs, deleted-meeting restore, a local API/MCP server, sharing/workspaces (#44), and integrations or bots (#45). The first two remain deferred under AGENTS.md rule 8; the rest are later-phase product decisions. A separate profile field was not added because saved summary instructions already carry user context for summaries; questions do not use them. The desktop app was not decompiled for this update; REA was not rerun.

OpenMeet already implements a substantial personal meeting notebook. The largest gaps are live transcription, automatic post-meeting processing, named speakers, editable AI notes, and questions across multiple meetings. Capture reliability remains an unfinished qualification requirement.

## Evidence and limits

- OpenMeet findings come from the current working tree, including unpublished changes. Source was inspected alongside the implementation status, Phase 1 plan, and original development plan. This was not a new runtime or hardware test.
- Granola and Otter capabilities below are documented in their current official help centers. Availability can depend on platform, meeting app, plan, and rollout.
- REA also analyzed three selected public web JavaScript bundles from each product. These corroborate client-side schemas and code paths. They do not establish server implementation, desktop capture behavior, model architecture, or actual accuracy.
- No matching installed desktop app was found in the usual Windows program locations, uninstall records, or running processes. Desktop executables were not decompiled. No account was created, private account accessed, recording started, or meeting content uploaded.

The comparison distinguishes **implemented**, **partial**, **missing**, and **unqualified**. An implementation or passing synthetic test is not proof that a real meeting works.

## Core workflow comparison

| Capability                           | Granola                                                                                           | Otter                                                                             | OpenMeet today                                                                                                              | Remaining work                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture without a meeting bot        | Microphone and system audio on desktop [G1]                                                       | Desktop capture on Windows and macOS, alongside its joining bot [O1]              | Implemented on Windows, with consent, selected devices, separate WAV tracks, meters, pause/resume, tray, and shortcuts [L1] | Qualify actual capture. Current main adds an unqualified macOS preview, integrated after this comparison.                                                                                                          |
| Live transcript during the meeting   | Live transcript panel [G1]                                                                        | Live transcript and outline [O2]                                                  | Missing. Backend refuses transcription while recording or paused [L2]                                                       | Incremental speech processing, stable partial/final segments, live UI, and pause-safe boundaries.                                                          |
| Stop and receive finished notes      | Automatically enhances notes after the meeting [G2]                                               | Automatic summary and action items [O2]                                           | Partial. Stop finalizes audio. Transcription and summary are separate manual actions [L2, L3]                               | An explicit processing workflow that advances through final transcription and summary, with recovery and previously granted consent for cloud submissions. |
| Name the people speaking             | Participant display-name tags for supported Zoom, Meet, and Teams meetings; Me/Them fallback [G1] | Speaker identification and profiles [O3]                                          | Partial. Microphone is `You`; all system audio is `Others` [L4]                                                             | Separate remote speakers, support corrections, and retain honest unknown labels. Two audio tracks do not distinguish several remote people.                |
| Personal notes influence the summary | Combines personal notes, transcript, and meeting context [G2]                                     | Transcript-driven summary plus note and collaboration tools [O2]                  | Implemented. Summary input includes user notes and transcript [L3]                                                          | Preserve this behavior. It does not need to be rebuilt.                                                                                                    |
| Edit and refine generated notes      | Editable and regenerable enhanced notes, with source drilldown [G2]                               | Editable transcript and interactive conversation content [O2]                     | Partial. Personal Markdown notes are editable; generated summaries are separate read-only output with history [L5]          | Edit generated notes without losing provenance or user edits; add selected-text AI refinement if needed.                                                   |
| Choose the note structure            | Built-in and custom templates [G3]                                                                | Automated summary structure; additional insight features vary by plan [O2]        | Partial. General, Stand-up, and One-to-one templates exist [L3]                                                             | Custom templates and saved personal instructions. Do not count the existing three templates as absent.                                                     |
| Ask questions later                  | Chat over a single meeting, selected meetings, folders, or the full library [G4]                  | Chat across conversations and selected organizational context [O4]                | Partial. One question about one meeting, with an unsaved answer and no conversation history [L6]                            | Saved threads, follow-up context, multi-meeting retrieval, and support for meetings too long for one request.                                              |
| Verify an AI claim                   | Source context for enhanced-note points [G2]                                                      | Action items link to transcript [O2]                                              | Partial. Transcript timestamps can seek audio, but AI timestamps are prose rather than validated references [L6, L7]        | Source references tied to stored segments, rendered as links to the relevant transcript or audio.                                                          |
| Track follow-up work                 | Generated action items and follow-up workflows [G2]                                               | Assigned action items with completion state and source links [O2]                 | Partial. An Action items Markdown section can be copied [L3, L5]                                                            | Structured tasks, editable owner and status, and source references. Due dates must remain unknown unless established by the meeting or user.               |
| Find and organize meetings           | Folders, spaces, and meeting-scoped chat [G4, G5]                                                 | Folders, channels, and workspaces [O5]                                            | Partial. Rename, date grouping, title filtering, and full-text search across notes/transcripts/summaries [L8]               | User-created folders or tags, then participant and calendar filters if useful.                                                                             |
| Calendar and meeting reminders       | Calendar-linked notes and microphone-use detection prompts [G6]                                   | Calendar scheduling, desktop detection prompts, optional automatic recording [O1] | Missing [L9]                                                                                                                | Calendar metadata and opt-in reminders. Detection does not authorize recording by itself.                                                                  |
| Playback and transcript correction   | Live transcript search/copy/delete; no retained meeting audio [G1]                                | Editable transcript with synchronized audio playback [O2]                         | Partial. Per-track playback and timestamp seeking exist; transcript correction does not [L7]                                | Transcript editing and speaker correction. Stored local playback is already an OpenMeet capability that Granola intentionally lacks.                       |
| Import an existing recording         | Prerecorded audio import is not supported [G1]                                                    | Audio/video import [O6]                                                           | Missing from the user-facing command/UI flow [L9]                                                                           | File import is an Otter-oriented addition, rather than a Granola parity requirement.                                                                       |
| Export or share the result           | Sharing roles, Markdown copy, historical export [G5, G7]                                          | Controlled sharing and richer document/subtitle/audio exports [O7]                | Partial. Local non-overwriting Markdown snapshots exist [L10]                                                               | Portable transcript formats if wanted. Shared links, permissions, and collaboration require a larger product decision.                                     |

Granola's web interface views and edits existing notes; its desktop or mobile app performs capture. Public web code is therefore not evidence of desktop capture implementation. Otter currently offers both bot-free desktop recording and a joining bot. Treating Otter as bot-only would give the wrong comparison.

## What OpenMeet already has

Keep the existing SQLite storage, note autosave and draft protection, recovery, separate local audio tracks, playback, full-text search, three summary templates, summary history, and Markdown snapshots.

Local Whisper and VAD downloads, progress/cancellation, optional compatible cloud speech, and user-configured text providers are implemented. Current source also accepts HTTP loopback connections with optional credentials for user-managed OpenAI-compatible servers [L11]. This means a local text-provider connection is already possible. A bundled local LLM runtime, local LLM download manager, and dedicated Ollama adapter are separate features that are not implemented.

The requested Cloud/Local settings redesign and model discovery/import work in `docs/local-model-settings-design.md` remain a design rather than proof that every proposed control exists. The already requested live transcripts and automatic summaries are still missing from the executed application flow.

## Finish these before claiming a dependable meeting app

These are qualification gaps, not reasons to recreate implemented features:

- Complete the Windows capture checks for audible and distinct tracks, queued/in-flight pause privacy, device failure/switching, sleep/wake, recovery, and a 60-minute run with measured relative drift below 100 ms. A historical two-second smoke test does not establish these properties.
- Verify real provider and native credential-store behavior, cancellation, compatibility, long-meeting coverage, and failure recovery. Synthetic API tests are narrower evidence.
- Verify native startup, shortcuts, note persistence, export cancellation, clipboard/playback permissions, keyboard operation, and errors on the target machine.
- Add and qualify macOS capture if macOS is a supported product target. The compared checkout was Windows-only; current main adds an unqualified Apple Silicon preview, preserved in the integration.
- Finish release packaging and distribution. Installer bundling is disabled in the current Tauri configuration [L12].

The current implementation status records these limits [L13]. Notes, audio, transcripts, summaries, and exports are presently unencrypted. A local export folder can itself be cloud-synced.

## Suggested implementation order

1. **Qualify the existing Windows meeting path.** Record, pause, resume, stop, transcribe, summarize, export, reopen. Close the hardware and data-preservation gates before claiming reliability.
2. **Connect the core processing workflow.** Add live transcript output, then final reconciliation and automatic post-stop summaries. Use explicit session consent bound to provider and content scope before any automatic cloud submission. Preserve paused-audio exclusion and visible failures.
3. **Make the output easier to trust and use.** Add named/correctable speakers, transcript corrections, source-linked AI claims, and editable generated notes. Custom templates and structured tasks belong here.
4. **Add meeting memory.** Introduce folders or tags and saved, source-linked questions across selected meetings. Reuse existing full-text search where it serves retrieval before introducing another storage system.
5. **Reduce manual setup.** Add calendar-linked titles/participants and opt-in meeting reminders after the core pipeline is dependable. Native provider/model usability can proceed alongside this work.

For the personal desktop product, live transcription and automatic notes offer more immediate value than team infrastructure. Bot attendance, CRM/Slack integrations, SharePoint delivery, mobile clients, and shared workspaces are valid broader gaps, but remain later-phase work under the current project scope.

## Local source evidence

Paths refer to the inspected working tree and can move as implementation continues.

| ID  | Evidence                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | `src-tauri/src/storage.rs:154`, `src-tauri/src/audio.rs:262` and `:363`: capture lifecycle and platform boundary.                                                                             |
| L2  | `src-tauri/src/lib.rs:202` and `:432`, `src-tauri/src/storage.rs:303`: stop behavior and recording/paused transcription rejection.                                                            |
| L3  | `src-tauri/src/llm.rs:25`, `:47`, `:90`, `:134`; `src-tauri/src/lib.rs:641` and `:658`: fixed templates, notes/transcript inputs, chunking, and manual consented summary commands.            |
| L4  | `src-tauri/src/stt.rs:576`, `src-tauri/migrations/011_cloud_transcripts.sql:5`, `src-tauri/src/llm.rs:21`: track labels and multiple-speaker limitation.                                      |
| L5  | `src/components/MeetingWorkspace.tsx:455`, `:628`; `src-tauri/src/storage.rs:480`; `src/lib/note-writer.ts:14`: editing, action-section copying, history, autosave.                           |
| L6  | `src-tauri/src/llm.rs:69`, `:193`, `:219`; `src/components/MeetingWorkspace.tsx:698`; `src/lib/markdown.tsx:3`: single-meeting questions, length limit, unsaved answers, rendering.           |
| L7  | `src/components/MeetingWorkspace.tsx:478` and `:922`: note timestamps and transcript/audio seeking.                                                                                           |
| L8  | `src/components/MeetingSidebar.tsx:31`, `src/lib/group-meetings.ts:3`, `src-tauri/src/storage.rs:860`: grouping and search.                                                                   |
| L9  | `src-tauri/src/lib.rs:999` command inventory, frontend command bindings, components, and migrations: no implemented calendar/detection/bot/import workflow found within this search boundary. |
| L10 | `src-tauri/src/export.rs:128`: Markdown snapshot export.                                                                                                                                      |
| L11 | `src-tauri/src/providers.rs:59` and `:166`, `src/components/ProviderSettings.tsx:100`: compatible endpoints, loopback, optional local credentials.                                            |
| L12 | `src-tauri/tauri.conf.json:21`: `bundle.active` is false.                                                                                                                                     |
| L13 | `docs/implementation-status.md:7` and its Open work section: historical checks and unqualified hardware/provider/native behavior.                                                             |

## Official product references

- G1: [Granola transcription](https://docs.granola.ai/help-center/taking-notes/transcription).
- G2: [Granola AI-enhanced notes](https://docs.granola.ai/help-center/taking-notes/ai-enhanced-notes).
- G3: [Granola templates](https://docs.granola.ai/help-center/taking-notes/customise-notes-with-templates).
- G4: [Granola Chat](https://docs.granola.ai/help-center/getting-more-from-your-notes/chatting-with-your-meetings).
- G5: [Granola sharing](https://docs.granola.ai/help-center/sharing/sharing-notes).
- G6: [Granola notifications](https://docs.granola.ai/help-center/taking-notes/notifications).
- G7: [Granola historical export](https://docs.granola.ai/help-center/sharing/exporting-notes).
- O1: [Otter desktop app](https://help.otter.ai/hc/en-us/articles/35973988280215-Otter-Desktop-App-Mac-Windows).
- O2: [Otter conversation page](https://help.otter.ai/hc/en-us/articles/5093228433687-Conversation-Page-Overview).
- O3: [Otter speaker identification](https://help.otter.ai/hc/en-us/articles/21665587209367-Speaker-Identification-Overview).
- O4: [Otter AI Chat FAQ](https://help.otter.ai/hc/en-us/articles/17016733191703-Otter-AI-Chat-FAQs).
- O5: [Otter feature overview](https://help.otter.ai/hc/en-us/articles/360047872833-Otter-ai-features).
- O6: [Otter recording imports](https://help.otter.ai/hc/en-us/articles/360059448294-Transcribe-an-existing-conversation-recording).
- O7: [Otter exports](https://help.otter.ai/hc/en-us/articles/360047733634-Export-conversations).

## REA artifact evidence

The evidence directory is `C:\Users\Rahul\AppData\Local\Temp\openmeet-competitor-evidence-28745fce`. It contains downloaded public bundles, URL/hash manifests, and `rea-evidence.json`. These temporary files are outside the repository and may eventually be removed by system cleanup. No competitor code was incorporated into OpenMeet.

Granola analysis used three selected bundles served by `https://notes.granola.ai/download`. The subset digest is `bc34b60b748a3565a8d55a7596856d28dbb97e8638370af3745a4ec71101eeeb`. Parent Evidence is `ev_5fbfca0b611dee3aa7c0a86664ae2c59a117ef4e1d624ac5806794c7ea863803`. The endpoint/module view is `ev_2e745710e55c66f2e624110c972c5e6a58e83c48a1a1cbf7f0dcd9f76c59bca4`.

Observed inert syntax includes a `panel-generation-start` discriminated schema with a panel, optional HTTPS stream URL, and expiry; sharing roles `OWNER`, `COLLABORATOR`, and `VIEWER`; and endpoint mappings for templates, transcript chunks, folders, and meeting briefs. These establish shipped client structures, not invocation, server behavior, or availability to a particular account. REA parsed all three selected files, but semantic coverage is unknown with unresolved dynamic relationships. This is not complete Granola coverage.

Otter analysis used three selected bundles served by `https://otter.ai/home`. The subset digest is `099ac5d9e2bae9eef65770110068f1f6135b625a00e76c11d9107fca24cce78d`. Parent Evidence is `ev_aa67270d206abcb837eb440433ec20fca9696d045dfcd7115b1e7b87c4d4fb3e`. Module inventory Evidence is `ev_5bc85567720415b4248e5a9195e0e6964de7af671333ddda8fec87d069d46d54`.

Observed inert syntax includes completed/uncompleted task collections, a mutation calling `updatePersonalActionItem` with UUID/text/completion/assignee fields, and export controls for speaker names and summary sections. These support the distinction between structured tasks and OpenMeet's Markdown action section. Analysis is partial because the semantic graph reached its node ceiling. No complete execution path or runtime result is claimed.

Unresolved questions include both products' desktop audio internals, backend models and prompts, diarization algorithms, latency, transcription accuracy, and behavior with this user's devices and accounts. The missing-feature comparison does not depend on inventing answers to those questions.
