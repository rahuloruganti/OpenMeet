# Settings revamp plan

Status: implemented October 21, 2026, except section search (deferred by the user). The left navigation and a collapsed Models section were chosen. Steps 1–5 landed together because they rewrite the same panel and tests. Native visual inspection is still open.

## Why

Settings is one 550-line panel (`src/components/SettingsPanel.tsx`) with three tabs grouped by where the work runs, not by what the user wants to change:

- **Cloud API** and **Local** render the same `ProviderSettings` component twice, filtered by destination. To set up summaries, the user has to know whether their server counts as "cloud" or "local".
- The **Transcription mode** select sits above all the tabs, apart from the speech settings it controls.
- **General** has seven unrelated sections: automatic processing, summary templates, recipes, export folder, shortcuts, Markdown export and transcript files. The export folder and the export options sit in separate sections.
- Saving is inconsistent. Export options save on change, while speech, shortcuts, instructions and provider assignments each have their own Save button with no unsaved-changes indicator.
- The automatic-processing default lives in browser `localStorage` (`src/lib/processing.ts`). That breaks the "backend owns state" rule, and the default can be lost when the webview's storage is cleared.
- The automatic-summary picker offers only the three built-in templates and ignores custom ones.

## Target layout

Use a left-hand section list (vertical tabs, keyboard-navigable like the current tab bar) with one task per section:

| Section | Contents | Moves from |
| --- | --- | --- |
| **Recording** | Default microphone and system output; pause and stop shortcuts. | Shortcuts (General); defaults are currently chosen only in New recording. |
| **Transcription** | Local / API choice as two radio cards at the top. Local: engine status, download/cancel, model, language, vocabulary. API: the speech assignment (connection + model). | Mode select (top), Local tab, speech half of the Cloud tab. |
| **AI notes** | The summary-and-questions assignment, saved instructions, custom templates, recipes, and the automatic-processing default (mode + summary template). | Summary assignment (Cloud/Local tabs), General. |
| **Connections** | One list of saved OpenAI-compatible connections, each badged *This device* (loopback) or *Leaves this device*, plus key status, refresh models, add/edit/remove. | Both `ProviderSettings` renders. |
| **Models** | Local model library: scan, import, Hugging Face search/download. Collapsed under "Advanced" by default. | Local tab. |
| **Export & storage** | Export folder, Markdown options, transcript files and audio disk usage in one section. | Two General sections; usage from the sidebar. |
| **Privacy & about** | A short "what leaves this device" table built from `docs/privacy.md` wording, the unencrypted-storage notice, version (`tauri.conf.json`), and a link to `THIRD_PARTY_LICENSES.md`. | New; consolidates repeated muted notices. |

Each section keeps its existing aria labels and headings where tests rely on them, or the tests change in the same step.

## Remove

1. **The "Other engines (not supported yet)" optgroup**: 11 permanently disabled options naming other apps' engines (`otherEngines`). It informs nothing and clutters the model picker.
2. **The duplicate `ProviderSettings` mount and its `local` filter prop**: one Connections list replaces both.
3. **The top-level Transcription mode select**: it moves inside Transcription.
4. **Repeated explanatory paragraphs**: there are two Whisper descriptions ("keeps audio on this device" and "Audio stays here"), and the model-library scan limits and Cloud tab footer repeat each other. Keep one sentence per section; move details into the existing `help-details` disclosure or Privacy & about.
5. **Ad-hoc save buttons for selects and checkboxes**: selects and toggles save on change, as export options already do. Free-text fields (shortcuts, vocabulary, instructions, template and recipe bodies, model IDs) keep an explicit Save, shown only when the field differs from the saved value, with an "Unsaved changes" mark on the section in the section list.
6. **`localStorage` for the processing default**: replaced by a settings column (below). Keep reading the old key once to migrate, then delete it from storage.

## Add

Only items that reuse existing commands or data, or are a single small backend change:

1. **Default devices in Settings**: `microphone_id`/`output_id` already exist in `Settings` and are written by New recording. Show them in Recording using the existing `list_audio_devices`. Never switch a device silently: if a saved device is missing, show "Not connected" rather than picking another one.
2. **Shortcut capture**: a "Press keys…" button records the next key chord into the shortcut field. Validation stays with the existing backend `parse_shortcuts`, and conflicts are still reported as today.
3. **Automatic processing default in SQLite**: an additive migration adds `settings.processing_mode` and `settings.processing_summary`, with a `save_processing_default` command. The summary picker still lists only the three built-ins: automatic sessions take the closed `llm::Template` enum (`session_processing.rs`), and custom templates there would need their own consent-binding change.
4. **Default summary template**: the template preselected in the meeting's Enhance picker, stored with the setting above. Today the picker always starts at General.
5. **Storage overview**: total audio size (existing `audio_usage`) and the export folder path with a **Copy path** button. "Open folder" buttons are left out, because they need a new opener plugin. Nothing is deleted from Settings.
6. **Connection badges**: *This device* vs *Leaves this device*, computed with the existing `isLocalBase`.
7. **Section search**: a filter box above the section list that matches section titles and field labels. It is client-side only.

## Not in this revamp

- Theme or dark mode. The stylesheet is light-only (`color-scheme: light`), and adding a theme means a full token pass.
- Automatic deletion or retention of audio and transcripts. It deletes user data automatically and needs its own consent design.
- Profile and "about me" context for questions, calendar, meeting detection, speaker separation, integrations, and encryption, which follow the existing checklist and AGENTS.md rule 8.
- New provider types or bundled local LLMs.
- Custom templates for automatic summaries, which need a session-consent change.
- New dependencies, such as an opener plugin.

## Steps

Each step is one commit on `main` with the full check set from AGENTS.md.

1. **Remove.** Delete `otherEngines`, the duplicate notices and the top-level mode select, and move the mode select into the Local/speech area. Expected diff is mostly deletions; update `App.test.tsx` and `ProviderSettings.test.tsx` selectors.
2. **Restructure.** Split `SettingsPanel.tsx` into one small component per section (`settings/Recording.tsx`, `settings/Transcription.tsx`, `settings/AiNotes.tsx`, `settings/Connections.tsx`, `settings/ExportStorage.tsx`, `settings/About.tsx`), with the section list in `SettingsPanel.tsx`. Merge the two `ProviderSettings` uses into Connections, with assignments moved to Transcription and AI notes. No behaviour changes; existing tests pass with updated queries.
3. **Saving.** Save-on-change for selects and checkboxes; dirty markers for free text. Add a test that a dirty field survives switching sections and that closing Settings with unsaved text asks first, like the existing connection-edit confirm.
4. **Processing default to SQLite.** Migration, command, one-time `localStorage` import, and Rust tests for defaults, upgrade from v24 with data, and invalid values. Add a frontend test for the migrated value.
5. **Small additions.** Default devices, shortcut capture, default summary template, storage overview, connection badges, and section search. Each gets one focused test.
6. **Docs.** Update `user-guide.md` (Settings section), `architecture.md` (component map), `implementation-status.md`, and `log.md`.

## Acceptance

- Every current setting is reachable in at most two clicks from opening Settings, and none is lost. Check against the `Settings` struct field by field.
- No consent or privacy wording is removed without moving to Privacy & about or the relevant section.
- Keyboard: the section list works with arrow keys, Home and End; focus returns to the opener on close; it works at 720×580 and 200% text.
- No device, model or provider is switched without an explicit user action.
- Full checks pass. Native visual inspection of every section is still needed and is not covered by the automated tests.

## Open decisions

1. Section list on the left, or keep top tabs with seven entries? The plan assumes left, because seven tabs do not fit at 720 px.
2. Hide **Models** under "Advanced" by default? The plan assumes yes, because most users only need the built-in Whisper download.
3. Add section search now (step 5) or later? It is cheap but optional.
