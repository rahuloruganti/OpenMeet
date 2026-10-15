# Personal API keys, speech models, and removal of demo features

Status: implemented in source on 2026-10-13. This document records the agreed design; see [implementation status](implementation-status.md) for executed checks and remaining qualification gates.

## Agreed scope

1. Replace Merge-specific setup with a user-supplied OpenAI-compatible base URL, API key, and model in Settings. Use this connection for summaries and meeting questions.
2. Support both local Whisper and cloud speech-to-text. Select the mode and model from dropdowns. Cloud speech uses its own base URL and API key, independent of the summary connection.
3. Remove simulation and fictional-sample features from the shipped application. Keep synthetic test data in tests and preserve existing stored records.

The smallest version has one saved LLM connection and one saved cloud-STT connection. It does not add a provider-account manager or native adapters for other API formats.

## Current behavior and affected paths

| Flow                    | Existing implementation                                                                                                                                 | Required change                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| LLM setup               | `SettingsPanel.tsx` → `api.ts` → Tauri commands in `lib.rs` → `merge.rs` and `storage.rs`                                                               | Replace environment-only key import, Merge model discovery, and fixed gateway routes with generic connection settings.        |
| Summaries and questions | `MeetingWorkspace.tsx` → `App.tsx` → consented commands → `merge.rs` → SQLite summary history                                                           | Keep templates, chunking, history, and notes protection; bind consent and provenance to the selected destination and model.   |
| Local STT               | Settings → `save_stt_settings` → `stt.rs`; `transcribe_meeting` processes finalized tracks and commits after success                                    | Keep current engine, verified downloads, model selection, language, vocabulary hints, cancellation, and timing-index mapping. |
| Transcript storage      | `domain.rs`, `storage.rs`, `api.ts`, meeting workspace, Markdown export, and FTS triggers                                                               | Add cloud provenance and explicit support for untimed text. Preserve local timestamps and existing search behavior.           |
| Demo features           | Sidebar sample loader, setup simulation controls, `start_recording` simulation argument, fixture command, storage creation paths, tray text, and styles | Remove production creation paths and prompts. Retain only historical-data interpretation and test helpers.                    |

Local STT already has a dropdown for `base`, `small`, and `large-v3-turbo`. This work extends that flow rather than replacing it. Merge model discovery currently expects Merge-specific fields, so changing the URL alone is insufficient. Transcript storage currently permits only `fixture` and `whisper` sources and requires timestamps.

## Settings experience

### Summaries and questions

- Show **API base URL**, a masked **API key** input, and a **Model** combobox.
- Provide Save connection, Refresh models, Replace key, and Remove key actions. Show only whether a key is saved; never read it back into the form.
- Fetch model IDs on an explicit refresh. Allow a custom model ID when a provider does not expose a usable model list. Mark a manually entered model as unverified rather than presenting it as tested.
- Saving settings does not submit meeting content or make a paid inference request. Explain that refreshing models sends credentials to the configured destination.
- Keep summary templates and question behavior, with consent showing the actual provider destination and model instead of fixed Merge wording.

### Speech-to-text

- Add a **Transcription mode** dropdown with **Local Whisper** and **Cloud API**. Keep local mode as the default and preserve the selected local model when switching modes.
- Local mode keeps the existing model dropdown, installed/download status, language, vocabulary hints, and explicit download button.
- Cloud mode shows its own base URL, masked key input, model combobox, and model refresh action. It does not require local engine or model downloads.
- Display **Audio stays on this device** for local mode and **Audio is uploaded to your selected provider after confirmation** for cloud mode.
- Do not switch providers, select a substitute model, or fall back between local and cloud after a failure.

## Backend shape and security

Rust continues to own credentials, HTTP, audio processing, and persistence. React submits settings and renders status.

Conceptual types, not implementation code:

```text
AiRole = Llm | CloudStt
Connection = { validated_base_url, credential_status, revision }
CredentialStatus = Present | Missing | Unavailable
ModelSelection = Unselected | Selected(model_id)
TranscriptionMode = Local { local_model_id } | Cloud
KeyChange = Keep | Replace(secret) | Remove
Timing = Timed { start_ms, end_ms } | Untimed
TranscriptEntry = { speaker, text, timing, stable_order }

save_connection(role, config, key_change) -> public settings
save_model(role, model_id) -> public settings
list_models(role, expected_connection_revision) -> model choices
plan_cloud_transcription(meeting_id) -> destination, model, tracks, bytes, request_count, revision
transcribe_meeting(meeting_id, optional_cloud_confirmation) -> completion events
```

These signatures describe the boundaries. Exact Rust and TypeScript payloads must be kept in agreement during implementation. No public settings type contains an API key.

- Use a short-lived password field, not persisted React state or browser storage. On Save, pass the key through Tauri IPC, clear the field, and store the credential in the OS keychain. Do not include secrets in logs, errors, SQLite, exports, or events.
- Keep credentials separate by role and configured destination. Changing the base URL must not silently forward a previously saved key to another destination. Require a new key or an explicit decision to reuse it for the new destination.
- Validate HTTPS URLs, reject embedded credentials, query strings, and fragments, and preserve custom API path prefixes. Join relative endpoint paths without duplicating or dropping `/v1`.
- Reuse the existing HTTP client protections: disabled redirects, bounded responses, connection/request timeouts, and sanitized errors. Do not hold the storage/recording mutex during network requests.
- Handle keychain and database failures without discarding the prior working connection. Write a new revision-specific keychain entry first, publish its reference and configuration in SQLite, and only then retire the prior entry. Failed publication leaves the previous connection working; a crash may leave an unused credential to clean up later. Distinguish a missing key from an unavailable keychain. Test each failure boundary because the two stores cannot share one transaction.
- Allow saving a connection before selecting its model so discovery can run. Model selection is a separate local save and does not require catalog membership. Discard stale discovery results after a connection edit.
- Move reusable credential/HTTP code into one small `providers.rs` module and rename the remaining summary/question implementation to `llm.rs`. Keep local STT in `stt.rs`; add a small cloud-STT module for upload and response parsing. Avoid a general plugin or provider framework.

The first protocol boundary is `/models`, `/chat/completions`, and `/audio/transcriptions`, relative to the entered API base. A provider must support the endpoint needed for its role. A compatible chat endpoint does not establish transcription support. Model lists provide basic identifiers, not a portable task-capability catalogue. Do not infer STT support solely from a model name. See the [official model-list reference](https://developers.openai.com/api/reference/resources/models/methods/list).

## Cloud transcription and consent

1. Read only finalized audio tracks for a stopped recording. Snapshot the connection, selected model, track identity, and transcription settings.
2. Plan bounded WAV chunks using existing audio/timing data and WAV helpers. Split at pause discontinuities and reject invalid timing indexes instead of guessing alignment. Preserve the original files. Upload microphone and system audio separately so `You` and `Others` keep their current meaning.
3. Show a confirmation with the destination, model, tracks, amount of audio, and planned request count. Cloud selection or a saved key alone never authorizes an upload.
4. Bind confirmation to the exact connection and content snapshot. If the destination, model, tracks, or request plan changes, require a fresh review. Apply the same destination-binding rule to summaries and questions.
5. Send bounded multipart requests from Rust with progress and cancellation. Do not automatically re-upload to probe model capabilities or silently retry a potentially billable request.
6. Reject nonfinite, negative, reversed, or out-of-range provider timestamps. Map valid timestamps through chunk offsets and each track's timing index. Never upload audio from paused intervals or fabricate time ranges for returned text.
7. Publish the replacement transcript and its provider/model provenance in one transaction only after the full run succeeds. Failure or cancellation preserves the previous transcript and original audio.

Reuse one transcription run guard across local and cloud modes. Cancellation must target that run, including chunk preparation and the final commit check. Replacement removes previous generated local/cloud entries together, avoiding duplicate transcripts after switching engines. Keep successful-run provenance even when a valid response contains no speech.

Cancellation prevents further chunks and suppresses late result publication. It cannot retract audio already received by a provider; an in-flight request may finish remotely. The UI must describe this honestly.

Providers and models differ in response formats and upload limits. For example, the [official transcription reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create) restricts some models to JSON text, while timestamp granularities require a supported verbose response. The [file-transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text) documents a 25 MB input limit for OpenAI; that is not a universal limit for every compatible provider.

Use JSON text as the initial cloud baseline. Accept timestamps only when the response actually supplies valid segments. Untimed text remains useful for reading, search, summaries, and export, but has no timestamp-based playback link. Group untimed entries by track and chunk order without claiming chronological ordering across tracks. Update transcript retrieval ordering, Markdown export, and the `meeting_text` summary/question formatter to handle absent timing. Summary/question prompts must not invent time citations. Additional timestamp formats can be added after a provider's contract is verified, without making an extra capability-detection upload.

## Persistence and removal of mock features

- Add versioned migrations after schema v9 for connection settings, transcription mode, transcript timing/provenance, and configuration revisions. Preserve existing local model settings and every meeting, note, transcript, summary, and audio reference.
- When rebuilding `segments` to allow cloud entries and absent timing, preserve row IDs, validate timing as a pair, and recreate the FTS triggers introduced in migration 007. Test inserts, updates, replacement, deletion, and search after upgrade and restart.
- Store the actual provider destination and model on newly generated results. Retain historical `merge`, `whisper`, and fixture provenance; do not relabel old results as outputs of a new provider.
- Start the new LLM connection unconfigured. Do not guess a compatible model ID from an old Merge selection or send the old key to a new destination. Preserve the dormant old key until the user explicitly removes or reuses it.
- Remove **Load fictional sample**, **Try a simulation instead**, simulation start commands/arguments, fixture-creation Tauri registration, production fixture embedding, simulation tray behavior, unused handlers, and associated CSS.
- Put retained fixture builders and synthetic capture helpers behind test-only compilation or in test support. Remove browser/demo fallback data if any is found during the full caller audit. Empty and error states must show actual state rather than manufactured meetings or successful results.
- Existing fictional/simulated records stay readable and exportable with honest historical labels, because users may have edited their notes. Removing an application feature does not authorize deleting stored records. Optional removal can use the existing explicit meeting-delete flow; there is no automatic purge or source relabeling.

## Delivery order and exit checks

| Stage                                      | Deliverable                                                                                                             | Exit check                                                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Remove shipped demo features            | Clean real-recording/notes-only UI and production command surface; test-only helpers                                    | No sample/simulation creation entry points in the production build; existing notes and legacy exports still work.                                       |
| 2. Add connection settings and generic LLM | Key entry, destination validation, dropdown/custom model selection, keychain storage, summary/question caller migration | Restart restores nonsecret settings; secrets never return to the UI; summaries/history and consent use the selected destination.                        |
| 3. Prepare transcript storage              | Cloud provenance and timed/untimed entries; updated UI, export, and FTS                                                 | Populated-v9 migration preserves data and search; untimed entries never produce fake timestamps or playback links.                                      |
| 4. Add cloud STT                           | Local/cloud mode, model selection, planned uploads, consent, progress/cancel, atomic publication                        | Synthetic audio proves chunk boundaries, timing mapping, track labels, failure preservation, and no upload without confirmation. Local STT still works. |
| 5. Verify and document                     | Updated README, user guide, privacy/consent, architecture, status, dependency/license inventory where needed            | Full frontend/Rust checks, native restart/settings walkthrough, and separately authorized provider smoke checks.                                        |

Tests should cover invalid URLs/keys, unavailable model lists, manual IDs, changed-destination consent, keychain/SQLite failures, unauthorized/rate-limited/oversized/malformed responses, cancellation between chunks and immediately before commit, late responses, and transcript/search preservation. Include local → cloud → local reruns, mixed timed/untimed results, and successful empty results with retained provenance. Local test HTTP servers and synthetic audio remain appropriate test tools even though production demo features are removed.

Reuse `reqwest`, `keyring`, `hound`, and existing SQLite/UI code. Cloud uploads may need the existing `reqwest` dependency's multipart feature and corresponding lockfile changes. Do not add an SDK, audio codec, or provider catalogue unless the implementation proves it necessary.

Run the full cross-layer check set from `AGENTS.md` after implementation. Build the frontend before Cargo checks. Verify the real native UI, not just the browser preview. Actual recording tests still require explicit authorization; cloud smoke tests require consent for the particular content and destination. Compatibility is qualified per tested provider/model combination, never inferred for every provider.

## Decisions and current limits

Choose independent LLM and cloud-STT slots over a saved-connections manager. This meets the requested setup without profile CRUD, shared-key ownership, or cross-role reconfiguration. Reuse only the validation, credential, and HTTP code that both roles actually need.

The independent-slot candidate is the base design, also preferred by the independent review. Retain the reusable-connection candidate's endpoint-bound credential revisions, explicit untimed results, and transcript replacement protections. Reject saved-profile management and a generic action-plan registry because they add lifecycle/state machinery that these two fixed roles do not require. Consent can validate an immutable snapshot without a persisted job system. The review's recovery-order, timing-validation, and caller-coverage findings are incorporated above; execution checks remain future work.

Keep native provider-specific APIs, realtime transcription, diarization, automatic uploads, automatic provider fallback, and new local model families outside this change. The Windows SDK was restored during implementation. Capture hardware qualification, live provider qualification, and macOS capture support remain separate open work.
