# OpenMeet notes-first redesign plan

## Status and scope

**Status: notes-first UI implemented; native interaction qualification incomplete.** `src/App.tsx` and `src/styles.css` now provide the searchable/collapsible sidebar, notes canvas, mounted keyboard-accessible content tabs, setup/settings panels, and persistent recording controls. The existing Windows development window was visually inspected showing the new layout with existing fictional/stopped-simulation records. No Merge connection or AI generation command exists.

The user first requested a plan, then authorized implementation with “implement.” This authorizes the UI work, not hardware recording or cloud content submission. The frontend implementation and browser preview are verified separately from native interactive flows and unfinished processing/provider work.

### Executed evidence

- Node 24.21.0 with pinned Corepack/pnpm: typecheck, ESLint, formatting, 31 Vitest tests in 3 files, and production frontend build passed. `git diff --check` passed (Git emitted existing CRLF conversion warnings).
- Fictional preview: Chromium checks at 1100×780 and 720×580 exercised title search, draft retention across tabs, setup/settings, Escape focus restoration, collapsed navigation, unobstructed toggle/Close buttons, long title wrapping, 200% text/editor focus, and persistent controls. Runtime exception collection was empty; only local file requests occurred. Capture/simulation/save/export/model actions are disabled; demo text is memory-only.
- Visual checks found and repaired panel headers covered by capability banners, navigation covering its toggle, a duplicate status glyph, and focus scrolling the app shell at 200% text. Panels now reserve a scrollable side column; the error stack and recording controls retain dedicated rows.
- Independent read-only review reported the three earlier layout faults and panel-switch focus restoration. The layout faults were already fixed; added a 720×580/200% text simultaneous synthetic-error check verifying Stop stays inside the viewport and hit-tests to itself while feedback scrolls. Added two failing-then-passing React tests for setup→settings and settings→setup focus restoration, and repaired the equivalent preview path. Opening handlers capture the actual trigger; switching panels no longer restores the previous trigger before capturing the next.
- Native Windows window: app-scoped screenshots verified the actual redesigned shell, existing saved fictional notes, stopped-simulation source labels, idle indicator, and shortcut-unavailable warning. No fixture was created and no recording was started. A native Settings click approval timed out and was not retried; native editing/restart persistence, settings, export, full keyboard traversal, and native minimum-size/zoom qualification remain unchecked.
- No Rust/schema/command/dependency changes in this UI slice. No new native build/Rust suite, hardware result, Merge connection, or generated output is claimed.
- Design self-audit: 0/10 listed generic-design tells; original left-aligned editing workspace, deliberately chosen native Segoe UI, restrained green, no hero/metric cards/gradients/remote fonts. This is a visual assessment, not accessibility certification.

Build an original OpenMeet interface inspired by the notes-first posture of Granola's public product example, which presents a simple note canvas, personal/enhanced notes, and a compact status control.[1] Use OpenMeet branding and original styling; do not copy Granola logos, proprietary assets, example meeting content, or exact branded screens. The public page was inspected in a browser; the private Granola desktop app was not inspected. This is a design direction, not a pixel-exact recreation.

**Primary surface: Command / Inspect.** Selecting and editing one meeting dominates. Configuration and recording setup are secondary surfaces, not permanent full-width forms.

A fixture-backed visual redesign can proceed independently of hardware qualification. It must not bypass the recorder stabilization or capture/transcription gates in `execution-plan.md`. Merge connection/settings and real summarization are separate milestones.

## 1. Proposed workspace

```text
+------------------------+---------------------------------------------+
| OpenMeet               | Meeting title           Export   Recording |
| New recording          | Date   Source badge   Notes save status     |
| Search meetings        |                                             |
|                        | My notes | Summary | Transcript             |
| Recent meetings        | ------------------------------------------- |
|   Meeting title        |                                             |
|   Date / source        | Spacious writing or reading canvas          |
|   Selected meeting     |                                             |
|                        |                                             |
|                        |                                             |
| Settings               | Persistent compact recording controls      |
+------------------------+---------------------------------------------+
```

This is a wireframe, not a screenshot or implemented UI.

### Sidebar

- Approximately 240 px wide at the current 1100 px desktop width; soft neutral background, fine divider, restrained selected-row highlight.
- OpenMeet wordmark, **New recording**, a local title-search field, and the existing meeting list. Search filters the list without changing the selected meeting or losing its draft.
- Group by meeting date if useful; derive dates from existing timestamps, never invented calendar events. Preserve clear `Fictional sample`, `Simulation`, and `Desktop capture` source labels.
- Settings at the bottom. Put **Load fictional sample** in a secondary, clearly labeled action rather than the primary workspace header.
- Do not add folders, favorites, calendars, share links, delete actions, or account management in this redesign.
- Use **New recording**, not an unsupported note-only creation flow. There is no existing API for creating a blank notes-only meeting.

### Meeting workspace

- Compact header with title, timestamp/source, export action, and explicit save state: `Saving`, `Saved`, or `Not saved`.
- Selected meeting titles remain read-only for this batch; the current API has no rename command. Title entry belongs to new-recording setup.
- Three accessible tabs: **My notes**, **Summary**, **Transcript**. My notes is the initial tab. Use arrow-key tab navigation and associated tab panels.
- Broad, border-light writing area with a comfortable text measure. Keep the existing controlled Markdown textarea and note writer; no rich-text editor migration.
- Switching tabs must not unmount/dispose the note writer, discard unsaved text, or substitute generated text for user notes.
- Summary uses existing data only. For fixture content show **Hand-written fictional sample**, not a generated-success state. For other meetings without output show **Summary generation is not available yet**.
- Transcript renders existing `segments`, track labels, and timestamps. Empty desktop meetings say transcription is not available yet. Fictional segments remain visibly fictional.
- Preserve Markdown as safely escaped text with whitespace until a reviewed, sanitized renderer is explicitly included. Do not render meeting content with raw HTML or `dangerouslySetInnerHTML`.
- Track paths/diagnostics move into a secondary details section, not the central writing surface.

### Recording controls and setup

- Idle: one **New recording** entry point opens a setup sheet with title, microphone, system output, participant-consent acknowledgement, and explicit start action.
- Simulation remains a separate secondary action named **Start simulation**; never make it a fallback when capture fails.
- Active or paused: persistent compact control bar with source/status, **Pause/Resume**, and **Stop**. This remains visible while switching tabs, meetings, or opening settings.
- Recording indicator always describes the active backend session, even when viewing a different meeting. Offer **Open active meeting**, using the existing guarded meeting-switch path.
- Avoid fake live waveforms, timers, transcription, or progress. A duration display is optional only when derived from reliable backend timing, not an assumed UI-start clock.
- Start remains disabled without consent, both selected devices, a title, readiness, and capture support. Never auto-check consent or automatically start capture when opening a panel.
- Keep capture errors and note-save errors distinct. Backend recording failures remain persistent, not a dismissible toast. Shortcuts, missing devices, and unsupported macOS capture must have visible explanations.
- Stop initiates backend shutdown before awaiting note saving. Pause/Stop must remain usable during unrelated pending saves, exports, or future network requests.
- A setup/settings dialog must not trap the user away from stopping active capture: close-on-Escape, focus restoration, and a reachable Stop control are acceptance requirements. Prefer a nonmodal settings panel during recording.

### Settings

- Replace the bottom inline settings block with a focused settings panel: **Recording**, **Models**, **Export**, **Shortcuts & privacy**.
- Move existing settings/actions unchanged first: export folder and pause shortcut.
- Model settings identify **Merge Gateway — not connected / integration pending** until real backend support exists. Do not display a fake connection indicator, invented catalog, enabled Test button, or usable API-key field before its backend is implemented.
- Selecting Merge must not imply data has been uploaded. (The unused local Ollama selector was later removed.)
- Update privacy wording by actual capability: currently no cloud requests; after integration, local capture/transcription versus remote summarization must be distinct. A cloud-synced export folder can move files off-device.

## 2. Visual direction

These are proposed OpenMeet tokens, not values copied from Granola. Validate contrast before accepting them.

| Token | Proposed value / rule |
| --- | --- |
| Workspace | Warm white `#FAFAF7` |
| Sidebar | Soft stone `#F1F2EC` |
| Editor / dialogs | White `#FFFFFF` |
| Main text | Near-black `#20251F` |
| Secondary text | Muted olive-gray `#596252` |
| Divider | `#DDE1D6` |
| Accent | Restrained forest green `#315C3C`; white action text |
| Typography | Deliberately use Segoe UI on Windows, native system fallback elsewhere; no remote font requests |
| Type scale | 13–14 px navigation, 16 px notes, 26–28 px meeting title |
| Spacing | 4/8/12/16/24/32 px rhythm |
| Corners | 6–10 px controls; pill shape reserved for source/status indicators |
| Elevation | Fine dividers; shadow only for an elevated sheet or dialog |
| Motion | Short nonessential transitions; respect reduced-motion preference |

No gradients, decorative metric cards, marketing hero, heavy card grid, or copied botanical artwork. Use a few original inline icons only where they improve recognition, with visible labels or accessible names. No remote icon/font dependency by default.

At 1100×780, keep the header and recording controls visible while the note canvas scrolls. At the existing 720×580 minimum, collapse navigation behind a toggle and keep My notes + controls usable without horizontal scrolling. Test 200% text zoom and long titles/device names. Status must use text, not color alone; target WCAG AA text contrast and visible focus with adequate control hit areas.

## 3. Implementation batches and exit gates

### Batch 0 — first visual preview

**Purpose:** show the design before modifying the functioning app.

- [x] Create a local, self-contained preview using the existing fictional fixture and an original second fictional sample. (The static preview file was later removed; `src/App.tsx` is the source of truth.)
- [x] Include a visible **Design preview — fictional data, no recording or persistence** label. No Tauri calls, backend access, cloud requests, or API credentials.
- [x] Make sidebar selection, note/summary/transcript tabs, and setup/settings panels clickable. Recording/simulation/save/export/model actions stay disabled and explain why; no fake generation action is offered.
- [x] Use only memory-backed demo editing; do not persist user text in browser storage or suggest it was saved to SQLite.
- [x] Capture and inspect desktop, narrow-window, panels, and 200% text views in an isolated headless Chromium. The user can open the self-contained file directly; no interactive browser window was opened by this check.

**Exit gate:** the user can see and inspect the notes-first composition. Review this single requested direction before live-app layout changes; no generic three-option marketing exploration is needed.

### Batch 1 — workspace shell on real existing data

**Existing files:** `src/App.tsx`, `src/styles.css`, `src/App.test.tsx`.

- [x] Establish CSS variables and sidebar/workspace layout. Replace the oversized product heading and permanent recorder form without suppressing capability/qualification disclosures.
- [x] Move meeting navigation, selection state, source labels, export, and saved-note status into the shell.
- [x] Add local title search and appropriate empty/no-match states.
- [x] Reuse the current backend initialization, subscriptions, revision filtering, `run`/`runControl` guards, and `openMeeting` save-before-switch path.
- [x] Extract presentational components using typed props/callbacks; lifecycle state stays owned once in `App`. Components live in `src/components/`: `MeetingSidebar`, `MeetingWorkspace`, `RecordingControls`, `SetupPanel`, `SettingsPanel`. Extraction changed no behavior: the pre-existing 31 tests pass unmodified.
- [x] Polish pass on existing data only (`src/lib/group-meetings.ts`): sidebar grouped Today / Yesterday / Earlier by local calendar day; "Start your first note" empty state (copy only, starts nothing); disabled **Enhance notes** slot in Summary explaining it needs a transcript and a model; slimmer recording bar and slightly wider notes measure. The recording bar is still a full-width row, not a floating pill, to keep the validated grid layout. Visual and native re-inspection of these tweaks is unchecked.

**Exit gate:** real meeting navigation and notes render in the redesigned Tauri shell; no persistence/state behavior regression. No Rust/schema change is necessary for a pure layout slice.

### Batch 2 — focused editor and content tabs

**Existing files:** `src/App.tsx`, `src/styles.css`, `src/App.test.tsx`, `src/lib/note-writer.ts` and its tests (read/reuse; change only if needed).

- [x] Implement keyboard-accessible My notes/Summary/Transcript tabs and safely escaped content.
- [x] Preserve the note writer's serialized debounced saves, revision expectations, retry, explicit save action, and failure-draft retention (automated regressions).
- [x] Preserve export flush and non-overwriting snapshot behavior; no export backend change or AI-block merging. Native export requalification remains unchecked below.
- [x] Add empty/loading/unavailable/error states and persistent source disclosures. Feature-unavailable copy does not look like a loading job.

**Exit gate:** tab changes and panel navigation never overwrite or discard an edited draft; fixture summary is not presented as generated output.

### Batch 3 — compact recorder and settings

**Existing files:** `src/App.tsx`, `src/styles.css`, `src/App.test.tsx`; consult `src/lib/api.ts`, `src-tauri/src/lib.rs`, and recording types before changing any command contract.

- [x] Move title/devices/consent into setup, without changing submitted payloads.
- [x] Keep active recording controls persistently visible and independent of unrelated busy state (automated controls regressions, fictional visual checks; not hardware capture).
- [x] Move existing export/shortcut settings into a panel with keyboard/focus behavior.
- [x] Preserve backend/capture/save/shortcut error displays; note-save and active recording failures remain separate. Remaining backend health cleanup is still tracked in the execution plan.
- [x] Show Merge as an honest pending integration, not a working connection.

**Exit gate:** all existing recorder/privacy/note-saving regression behaviors pass in the new layout. No real audio is recorded during routine UI validation.

### Batch 4 — Merge configuration, separately gated

This is not required to view or approve the redesign. Follow recorder stabilization rules before network/model integration; do not implement summary generation to make a button look complete.

- [x] Inspect the native client, settings migrations, command boundaries, and manifest before selecting dependencies. Authenticated network work lives in `src-tauri/src/merge.rs`; the webview never sees the key. Added `keyring` 4 and reqwest's `native-tls` feature (HTTPS had no TLS backend before).
- [x] (Import flow only; no entry field) Store the key in the OS credential store: the backend imports `OPENMEET_LLM_API_KEY` from the process environment on explicit action. A user-facing entry flow is still future work. Original requirement: store the key in the OS credential store through a native credential-entry flow. Do not put the key in React state, SQLite, Markdown, logs, or frontend/Vite environment variables. Return only credential-presence/status to the UI; do not read unrelated Hermes credentials or reuse them silently.
- [x] Add explicit model refresh and connection test (the authenticated, content-free models request; no inference). The documented OpenAI-compatible base URL is `https://api-gateway.merge.dev/v1/openai`; the native models catalog is `GET https://api-gateway.merge.dev/v1/models`.[2][3]
- [x] Paginate the models catalog until complete, bound response size/time/pages, detect repeated IDs/cursors, and display unavailable/access-required states without silently selecting a substitute. Merge documents canonical model IDs and route-specific access controls; listed models can still require additional provider access.[3]
- [x] Test connection only after a user action; use a disclosed, content-free test request if inference is needed. Never include the current notes/transcript in a connection test.
- [x] Persist model metadata with an additive migration (`merge_model`, schema v4); synchronize Rust and TypeScript payloads. The model remains unchosen until the user explicitly selects one.
- [ ] Make remote/cost disclosures explicit. Use the OpenAI-compatible path consistently; Merge's native `/v1/responses` is a different wire format from OpenAI Responses.[3]
- [x] (Mock HTTP only; keychain-failure path untested) Add mock HTTP/credential-store tests for unauthorized, access-required, timeout, oversized/paginated responses, redirects, keychain failure, removed model, and zero secret exposure. Disable unsafe redirects; sanitize provider errors rather than echoing bodies containing sensitive content.

**Exit gate:** native credentials, model discovery, selection persistence, and a user-triggered connection test are verified without uploading meeting content. This is not evidence of working transcription or summarization.

### Batch 5 — real summary workflow, after processing prerequisites

Maps to Phase 1D/Execution Phase E; not part of the first UI preview.

- [ ] Implement the backend summary job, context budgeting, long-input reduction, templates, retained history, and retry behavior after the required upstream gates.
- [x] Add **Generate summary** only when backed by a real command (`generate_summary`). Missing key/model/transcript or unfinished processing should explain why generation cannot run.
- [x] (Notes and transcript text; never audio) Confirm each submission: destination Merge plus selected model, exact content scope (notes/transcript), and potential cost. Do not upload original audio as part of LLM summarization.
- [x] (Prior summaries are kept as older versions) On success show real output with provider/model provenance; on failure retain user notes and the prior successful summary. Do not populate success with fixtures.
- [ ] No automatic background generation, uploads, cross-meeting chat, provider-switch regeneration, or live transcription in this redesign.

**Exit gate:** authorized real generation and mocked privacy/recovery tests demonstrate the workflow; do not claim it from screenshots or compilation.

## 4. Regression and visual acceptance checklist

Write a failing test before each new nontrivial behavior; keep existing safety tests and adapt only selectors necessitated by accessible navigation changes.

- [ ] New navigation/search does not bypass save-before-switch or accidentally change the selected meeting when filtered out.
- [ ] Failed note saving retains the draft through tabs/settings and prevents unsafe meeting-switch/export/quit; retry is available.
- [ ] Stop reaches the backend before note flushing and remains enabled during unrelated slow work; Pause/Resume remains usable.
- [ ] Stale recording notifications cannot replace newer backend state.
- [ ] Opening setup never records; denied/missing consent and invalid devices never enable real start. Capture rejection cannot show success.
- [ ] Fictional fixture, simulation, real capture, paused/interrupted/failed, and idle states are unambiguous. Idle must not imply a simulation session exists.
- [ ] Keyboard-only use covers search, meetings, tabs, settings, setup, export, pause/stop, and quit. Sheets restore focus and Escape cannot discard an unsaved draft.
- [ ] Persistent errors are not hidden by a collapsed sidebar, closed settings panel, modal, or small window.
- [ ] Merge placeholder is visibly unavailable, not silently mocked. Opening the workspace makes no model/cloud request.
- [ ] No-note, no-meeting, no-transcript, no-summary, long-title, large-list, missing-device, shortcut warning, saving, and failure states are inspected.
- [ ] Screenshot/inspect at 1100×780 and 720×580; test 200% text zoom, focus visibility, contrast, overflow, and reduced motion.
- [ ] Open the actual Tauri app to verify native meeting data/notes/settings/export flows. A browser-only preview is not native persistence validation.

For frontend batches run:

```sh
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
corepack pnpm test
corepack pnpm build
```

For any Rust, command, schema, credential, or dependency change, also run the cross-layer checks in `AGENTS.md`, with frontend assets built before standalone Cargo checks. Never run ignored audio-device tests or start recording without explicit authorization.

Update `docs/implementation-status.md`, privacy/consent documentation as applicable, and `log.md` with executed evidence. Do not commit/push, delete data, or mark MVP/hardware gates complete as part of redesign work.

## 5. Completion definition and next action

The preview and native frontend implementation of Batches 0–3 exist. Next qualify the native interactive paths without recording: meeting navigation, note saving across restart, export snapshots, setup dismissal, settings, keyboard-only controls, minimum window size, and zoom. The unqualified paths above and hardware/processing gates are not silently waived. Model selection, credentials, Merge connection, and real summaries remain separate future batches.

The redesign is complete only when the native workspace is visually inspected and existing functional/privacy regression checks pass. Merge and summary milestones retain their own exit gates. No deadline estimate is made before the visual direction and necessary backend scope are established.

## Sources

[1] https://www.granola.ai
[2] https://docs.merge.dev/merge-gateway/get-started
[3] https://docs.merge.dev/merge-gateway/api-overview
