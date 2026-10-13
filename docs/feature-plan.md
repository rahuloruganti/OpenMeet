# Feature plan: from preview to a daily-use notetaker

Status (2026-10-12): **M0–M5 implemented and unit/mock-tested; no milestone exit gate is passed.** Every native, hardware and live-Merge exit check below is still open; see [implementation-status.md](implementation-status.md#feature-batch-2026-10-12). Dropped/deferred: 4.1, 5.3, encryption, local LLM. M6 remains gated. It sequences the feature list from the 2026-10-11 codebase review. It does not replace the capture/processing gates in [implementation-status.md](implementation-status.md#open-work); a feature shipping here never marks a hardware gate passed.

## Ground rules for every milestone

- One milestone = one reviewable change set. Finish, check, and update `implementation-status.md` and `log.md` before starting the next.
- Schema changes are additive, numbered migrations (`006_…` onward, appended to the loop in `storage.rs::open`). Each gets an upgrade test from a **populated v5** database (notes, segments, summaries, tracks, foreign keys).
- Rust `domain.rs` and TypeScript `api.ts` change together; add a serde test when a payload changes shape.
- Anything that sends meeting content off-device keeps the existing per-send consent and shows destination, model and content scope.
- No real recording during routine work. Features that need a device (level meter, mic test, playback of a real file) get one explicitly authorized manual check, recorded as such.
- Run the full check set from `AGENTS.md` for every cross-layer milestone.
- No new dependency unless the milestone says so; each one goes into `THIRD_PARTY_LICENSES.md` and through `cargo deny`.

## Milestone 0 — housekeeping (prerequisite, ~½ day)

| Task | Files | Done when |
| --- | --- | --- |
| Commit the hardware-test fix (resume after `prepare`, default endpoints) | `audio.rs` | Committed with the user's go-ahead |
| Fix stale README claims (Ollama is gone; Whisper and Merge summaries exist) | `README.md`, `docs/privacy.md` | Text matches code |
| Source-aware export banner: drop "No audio was recorded" for `desktop` meetings | `export.rs` + test for each source | Execution item A5 closed |

M0 matters because M5 rewrites the export renderer, and the README is what the next contributor reads.

## Milestone 1 — quick wins on existing data (no schema change, ~2–3 days)

### 1.1 Summary history picker — S
- `storage.rs`: add `list_summaries(id) -> Vec<SummaryVersion { id, provider, model, template, markdown }>` (newest first). Keep `MeetingDetail.summary` as the latest so nothing else changes.
- New command `list_summaries`; `api.ts` type + call.
- `MeetingWorkspace.tsx`: a `<select>` above the summary ("Version 3 · gpt-x · Stand-up"). Selecting is view-only; export keeps using the latest.
- Limitation: `summaries` has no timestamp column, so versions are ordered by id. Add `created_at` only if users ask for dates.
- Test: storage test with three versions; UI test switches version without touching notes.

### 1.2 Summary templates (General / Stand-up / One-to-one) — S
- `merge.rs`: replace `SUMMARY_SYSTEM_PROMPT` with `fn system_prompt(template: Template) -> &'static str`. Keep the shared untrusted-data and no-invention lines in one constant that every template includes.
- `generate_summary(id, consent, template)`; persist `template_hash` as a versioned id (`general-v1`, `standup-v1`, `one-to-one-v1`). The column exists; only the hard-coded `'summary-v1'` changes. Existing rows stay readable.
- UI: template `<select>` next to **Enhance notes**; the consent dialog names the template.
- Test: mock-server test asserts the stand-up prompt is sent; rejects unknown template strings at the serde boundary.

### 1.3 Copy summary / action items — S
- Buttons in the Summary tab: **Copy summary**, **Copy action items** (extract the `## Action items` section by heading; the prompt guarantees the heading).
- Use `navigator.clipboard.writeText` first. Add `tauri-plugin-clipboard-manager` only if the native webview rejects it (verify in the running app).
- Test: unit test for the section extractor (missing section, last section, CRLF).

### 1.4 Rename meeting — S
- Extract the 1–160 character title check out of `Core::begin` into `validate_title`; reuse it in a new `rename_meeting(id, title)`.
- UI: click-to-edit title in the meeting header; Enter saves, Escape cancels; the sidebar refreshes via `meeting_updated`.
- Renaming does not rename exported snapshots, since they are immutable.
- Test: storage rejects empty/oversized titles; UI test for Escape restoring the title.

### 1.5 Live level meters while recording — S
- `audio_health` already carries `peak` per track every poll. Render two small meters (mic / system) in `RecordingControls.tsx` with text labels ("Mic: no signal for 10 s") so status is not colour-only.
- Warn when the mic peak stays ~0 for N seconds. That is exactly the "both mic tracks contain no speech" failure seen earlier.
- Test: UI test feeding synthetic health events. Manual check needs an authorized recording.

### 1.6 Global "stop recording" shortcut — S
- Reuse the pause-shortcut registration path in `save_settings`; add a second setting **only for stop**. Use another migration column, or fold it into M3's settings migration to avoid an extra schema bump.
- Deliberately **no start-recording shortcut**: starting must go through setup and consent. A "new recording" shortcut may only focus the window and open setup.
- Test: settings round-trip; rejects a stop shortcut equal to the pause shortcut.

**M1 exit:** all checks green, and a native smoke test of history/templates/copy/rename on the fictional fixture plus a mocked summary. No live Merge call is required, but if one is made it needs the user's consent.

## Milestone 2 — meeting library (schema v6–v7, ~1 week)

### 2.1 Notes-only meetings ("New note") — M
- `006_note_meetings.sql`: rebuild `meetings` to allow `source = 'note'`. `notes`, `tracks`, `segments` and `summaries` reference `meetings`, so follow the **002 pattern** (foreign keys OFF outside the transaction, `foreign_key_check` before commit). Extend the migration loop to support that mode instead of copying the 002 special case.
- `Core::create_note(title)`: inserts the meeting with status `stopped` and an empty note. It does not touch `RecordingState` and is allowed while a recording is active.
- UI: **New note** beside **New recording**; source label "Note". Transcribe is hidden (no tracks); Enhance works on notes alone.
- Test: populated-v5 upgrade keeps every row and foreign key; a note meeting never appears as a recording.

### 2.2 Delete meeting / delete audio only, with disk usage — M (approved 2026-10-11)
- `get_meeting` reports per-track file size (`fs::metadata`); the sidebar footer shows total audio size.
- `delete_audio(id)`: refused for the active meeting. Removes only files whose canonical path is inside `audio_root/<uuid>/`, then clears `tracks` rows. Notes, transcript and summaries stay.
- `delete_meeting(id)`: same path guard, then `DELETE FROM meetings` (cascade). Exported snapshots are never touched, and the dialog says so.
- Both require a typed confirmation dialog naming the meeting; no bulk delete, no undo. This is the first user-facing deletion: update `privacy.md` retention text.
- Test: path-escape attempt (symlink / `..` in stored path) is refused; the active meeting is refused; cascade leaves other meetings intact.

### 2.3 Full-text search across notes, transcripts and summaries — M
- `007_search.sql`: `CREATE VIRTUAL TABLE search USING fts5(meeting_id UNINDEXED, kind UNINDEXED, body)` plus triggers on `meetings.title`, `notes`, `segments`, `summaries` (insert/update/delete), and a one-time backfill. FTS5 ships with rusqlite's `bundled` SQLite; confirm with a test, no new dependency.
- `search_meetings(query) -> Vec<{ meeting_id, kind, snippet }>` using `snippet()`. Escape user input as an FTS phrase so `"`, `*` and `NEAR` cannot break the query.
- Sidebar: the existing title filter stays instant; typing ≥2 characters adds a "Matches in notes/transcripts" section. Clicking opens the meeting on the matching tab through the guarded `openMeeting` path.
- Test: triggers keep the index right after note save, transcript replace, summary insert and meeting delete; hostile query strings return results, not errors.

**M2 exit:** upgrade tests from populated v5, a native check of create/rename/delete on fictional data, and deletion wording reviewed.

## Milestone 3 — transcript and audio (schema v8, ~1–1½ weeks)

### 3.1 Audio playback with click-to-seek — M
- Enable Tauri's asset protocol: `tauri` feature `protocol-asset` (feature flag, not a new crate), `app.security.assetProtocol` scoped to `$APPDATA/audio/**` only, CSP `media-src asset: http://asset.localhost`.
- Transcript tab: one native `<audio>` element per track (mic / system) using `convertFileSrc(track.path)`. Clicking a segment seeks that speaker's track.
- **Time mapping:** segment times are session time (pauses excluded via the timing index); file time is audio-frame time. Expose the existing `stt::session_ms` inverse (`file_seconds(session_ms)`) as part of `MeetingDetail.tracks` or a small command, rather than reimplementing the index in TypeScript.
- Test: Rust test for the inverse mapping across a pause; UI test that clicking a segment sets `currentTime`. One authorized manual playback check.

### 3.2 Timestamped notes — S/M
- While recording, **Insert timestamp** (button + shortcut while the editor has focus) writes `[mm:ss]` at the caret. Time comes from a new `recording_offset_ms` in `RecordingState`, derived in Rust from frames written, not a UI clock (the plan forbids assumed clocks).
- After recording, with the caret on a `[mm:ss]` line, **Jump to audio** seeks the player (3.1). The notes stay a plain textarea.
- Test: offset excludes paused time; timestamp parser handles `[1:02:03]`.

### 3.3 Transcription settings: language, vocabulary, model — M
- `008_stt_settings.sql`: `settings.stt_language` (default `auto`), `stt_prompt` (≤ 500 chars), `stt_model` (default `small`), and the M1.6 stop shortcut if not yet added.
- `stt.rs`: `-l <lang>` from a fixed allowlist; `--prompt` for names and jargon; the `MODEL` const becomes a small table (`base`, `small`, `large-v3-turbo`) with pinned URL, size and SHA-256 each. Downloads remain explicit, with the same checksum/atomic-activation path. Changing the model never deletes the old one automatically.
- Test: argument construction per setting; unknown language rejected; status reports per-model install state.

### 3.4 Transcription progress and cancel — M
- Run whisper with progress output (`-pp`) to stderr, parse percentages line by line, and emit `stt_progress { stage: "transcribing", track, percent }`.
- `cancel_transcription`: keep the `Child` handle behind the existing `BUSY` guard and `kill()` it. Cancel saves nothing; the previous transcript stays (already true because `replace_transcript` runs only on success).
- UI: progress bar per track and a **Cancel** button.
- Test: progress-line parser; a fake engine script proves cancel leaves old segments intact.

**M3 exit:** inverse time mapping tested across pauses, the asset scope verified to refuse files outside `audio/`, and one authorized record → transcribe → play → seek run on synthetic speech.

## Milestone 4 — AI features (no schema change unless noted, ~1½ weeks)

### 4.1 In-app API key entry — dropped
- Decided (2026-10-11): keys never pass through the webview. The `OPENMEET_LLM_API_KEY` import into the OS keychain stays the only path; Settings may explain how to set the variable, nothing more.

### 4.2 Long-meeting summaries (chunk, then merge) — M
- Replace the 120k-character refusal: split the transcript on segment boundaries into chunks under a budget, summarize each with a "partial notes" prompt, then run one merge pass over the partials plus the user's notes. Cap the number of chunks; refuse visibly above the cap.
- The consent dialog shows the number of requests that will be sent (a cost signal).
- Test: mock server verifies chunk count and that a fact planted in the **last** chunk reaches the final summary (the Phase E acceptance test).

### 4.3 Ask this meeting — M
- A Q&A box under the Summary tab. Each question is a separate consented send of notes + transcript + question; the answer is shown, not stored (no schema). Persist only if users want history.
- Same untrusted-data system prompt rules; answers cite `[mm:ss]` where possible, which link to playback (3.1).
- Scope stays to one meeting. Cross-meeting chat is out of scope.
- Test: mock server receives exactly one meeting's content; a consent=false call sends nothing.

### 4.4 Rendered summary Markdown — S
- A ~60-line renderer for the subset the prompts emit (`##` headings, `-`/`1.` lists, `**bold**`, `` `code` ``, paragraphs) that **returns React elements**, never HTML strings. That makes it safe by construction, with no `dangerouslySetInnerHTML` and no sanitizer dependency. Anything unrecognised renders as plain text.
- Test: table of inputs, including `<script>` and `[x](javascript:…)`, rendering as literal text.

**M4 exit:** mock-tested; one live Merge call per feature only with the user's explicit consent, reported as such.

## Milestone 5 — export and storage (~1 week)

### 5.1 Export options — S
- Frontmatter already exists. Add settings: include transcript (default on), include summary (default on), filename pattern from a fixed set (`date title`, `title`).
- Add `duration`, `template` and `model` frontmatter fields when known.
- Test: render snapshots for each combination.

### 5.2 Recover interrupted recordings — M
- On startup, meetings marked `interrupted` with non-finalized tracks get a **Recover audio** action: rewrite the WAV header from the actual file length (hound cannot open a truncated header, so fix the RIFF/data sizes directly), mark the track finalized and recoverable, and keep the original bytes (write a repaired copy, never edit in place).
- Test: truncate a synthetic WAV at several offsets; the repaired copy plays and frame counts match.

### 5.3 Compress audio after transcription — deferred
- Decided (2026-10-11): not now. Revisit only if disk usage from 2.2 shows WAV size is a real problem. If revived, write FLAC next to the WAV and delete the WAV only after a decode-compare check; needs a FLAC encoder crate and a license review.

**M5 exit:** export snapshots re-verified in the native app; recovery tested on synthetic truncated files only.

## Milestone 6 — platform and release (gated, size L each)

| Item | Gate / note |
| --- | --- |
| Encryption at rest | Deferred (2026-10-11). If revived: rusqlite `bundled-sqlcipher`, key in the OS keychain, migrate via `sqlcipher_export` to a new file and keep the plaintext original until verified; audio needs separate handling. |
| Local LLM provider | Dropped (2026-10-11): Merge-only. |
| macOS capture | Preview on Apple Silicon, macOS 14.2+. Output-only tap. Permission denial untested. |
| Installers, signing, updater | Phase F; `bundle.active` is `false` today. |

## Explicitly not planned

These stay out of scope per `AGENTS.md` until their phase: live transcription, automatic meeting detection, meeting bots, speaker separation beyond You/Others, calendar integration, cross-meeting chat, sharing links, and team/cloud sync.

## Order and dependencies

```text
M0 ─▶ M1 ─▶ M2 ─▶ M3 ─▶ M4 ─▶ M5 ─▶ M6
            │      │      ▲
            │      └─ 3.1 playback ─▶ 3.2 timestamps, 4.3 answer citations
            └─ 2.3 search must index note-only meetings (2.1 first)
```

M1 items are independent and can land in any order.

## Decisions (user, 2026-10-11)

1. **API key entry:** keys never pass through the webview; env-var import into the keychain only. 4.1 dropped.
2. **Deletion:** approved, with typed confirmation (2.2).
3. **FLAC compression and encryption at rest:** deferred.
4. **Local LLM option:** dropped; Merge-only.
