# Data and privacy

This page describes the implemented preview. It is not a claim that hardware pause privacy, local-only network behavior, or the complete release security boundary has passed qualification. See [implementation status](implementation-status.md).

## Local storage

The app-data root uses the identifier `dev.openmeet.preview`:

| Platform | App-data root                                         |
| -------- | ----------------------------------------------------- |
| Windows  | `%APPDATA%/dev.openmeet.preview/`                     |
| macOS    | `~/Library/Application Support/dev.openmeet.preview/` |

| Path within the root                 | Contents                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `meetings.db`                        | Meeting metadata, notes, transcripts, summaries, settings, and full-text search copies. |
| `meetings.db-wal`, `meetings.db-shm` | SQLite sidecar files that can exist while WAL mode is active.                           |
| `audio/<meeting ID>/`                | Microphone/system WAV files, timing indexes, and any repaired copies.                   |
| `stt/engine/`                        | Downloaded local speech engine and its release marker.                                  |
| `stt/library/<revision>/`            | Downloaded GGUF files and `.openmeet.json` provenance manifests.                        |
| `stt/models/`                        | Selected speech models and VAD model.                                                   |

Markdown exports are separate files under the chosen destination's `Meetings` directory. The database, recordings, timing files, transcripts, models, and exports are unencrypted. Device administrators, backups, and sync software may access them. Choosing a cloud-synced export folder can move content off-device without an OpenMeet upload request.

Desktop capture writes the selected microphone and system output locally. System output can contain unrelated application audio. On macOS the system track uses an output-only process tap; outputs with their own input are refused. Permission denial remains untested. Sample and simulation creation is removed; historical fictional entries remain labeled and accessible to preserve edited notes. Tests use synthetic fixtures.

## Network actions

| Explicit action                   | Destination                                                       | Sent or downloaded                                                                            |
| --------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Download speech engine and models | GitHub and Hugging Face, including their artifact delivery hosts. | Downloads pinned engine/model files. Meeting audio and notes are not uploaded.                |
| Search Hugging Face / list files  | Public Hugging Face API.                                          | Search query or repository identifier; no meeting content or provider credentials.            |
| Download selected public model    | Hugging Face and approved HTTPS artifact hosts.                   | Revision-pinned file and local provenance manifest; no meeting uploads.                       |
| Refresh provider models           | Saved API base plus `/models` (HTTPS or local loopback HTTP).     | Credentials only; no meeting content. Saving a model makes no request.                        |
| Confirm Enhance notes             | Saved LLM base plus `/chat/completions`.                          | Selected notes/transcript text, model, and prompt/template. No audio.                         |
| Confirm Ask this meeting          | Same saved LLM chat-completions route.                            | The question and that meeting's notes/transcript. No audio or other meetings.                 |
| Confirm cloud transcription       | Independently saved speech base plus `/audio/transcriptions`.     | Finalized microphone/system audio as bounded WAV chunks, model, language and vocabulary hint. |

There is no telemetry, automatic cloud processing, or updater. Development mode uses a Vite server on localhost. Dependency installation and builds can also contact package registries; those development tools are separate from application content submission.

Explicit local scans read bounded directory entries and model headers; candidate import reads and hashes the selected file. Scan results are not uploaded. Hugging Face search sends the entered query, and listing files sends the selected repository ID. Generic GGUF downloads retain repository license metadata in a local manifest and require an external server.

Model installation checks pinned sizes and SHA-256 hashes. Downloads occur only on an explicit action. Changing a selected model retains existing downloads. Local transcription runs whisper.cpp as a subprocess, with paths and settings passed locally. Output text is parsed from temporary JSON, not emitted to the app's console. Cancelling or failing transcription keeps the previous transcript. Local transcription, cloud preparation, and mapped timestamp seeking reject missing or damaged recording timing. No transcript is published from that failed run, and original audio/index files are preserved.

## Credentials and cloud consent

Backend-only Phase 3 preparation can store an explicitly attached session plan in SQLite. It records model/destination metadata, track scope, a consent fingerprint, limits, and revisioned state. It contains no API keys, keychain account references, transcript, note text, or vocabulary prompt. These records are unencrypted like the rest of the database and are removed with their meeting. No live or automatic requests are enabled by this preparation API. The existing UI continues to require the manual confirmations described below.

Settings accepts a masked API key for each reusable saved API connection. Independent summary and speech assignments can share that connection. The key exists briefly in an uncontrolled password field and Tauri IPC, then Rust stores it in the OS keychain under service `dev.openmeet.preview` with a revision-specific account. The field clears after a save attempt, profile change, tab change, and unmount. No key is returned to the UI or stored in React state, browser storage, SQLite, logs, or exports. JavaScript cannot guarantee memory zeroization. Environment import and `.env` parsing are not used. Legacy Merge keys remain dormant; they are not forwarded to a new provider.

Changing a remote provider URL requires entering a key for that destination. Local loopback HTTP allows an optional key; changing its destination discards the old credential reference. Editing a shared connection affects all assignments using it. Key replacement stores a new credential before publishing its reference in SQLite, then retires the previous credential. A failed publication keeps the old working connection. A cleanup error reports partial success and reloads Settings; crashes can leave unused credentials in the OS keychain.

Each summary, question, and cloud transcription requires its own confirmation. The UI identifies the destination, model, content scope, and request count; audio confirmation also lists tracks and bytes. Provider terms and billing apply after submission. Local Whisper remains the default and does not upload audio. OpenMeet cannot retract uploaded audio or guarantee provider retention behavior. Cancellation prevents later uploads and publication, but an in-flight request can finish remotely and be billed.

Long summaries split transcript segments into bounded requests, then combine the partial results with the user's notes. The maximum plan is eight chunks plus one combination request. Oversized input is refused rather than truncated. Consent fingerprints bind the exact destination/configuration revision, selected model, content, action, and request plan. Cloud audio is prepared as frozen temporary PCM WAV chunks whose content and timing hashes enter the plan. These scratch files are unencrypted and removed when preparation or execution ends. No automatic capability-probing upload or billable retry occurs.

Summary results are saved separately from user notes with provider, model, and template metadata. Older versions remain available; export uses the latest. Question answers are shown in the interface and are not persisted. Summary copy buttons place text on the system clipboard, which other software may read.

## Webview boundary

Rust owns filesystem access, model execution, HTTP requests, native dialogs, shortcuts, and credentials. The webview receives specific commands and events. It can play files under the app-data `audio/` directory through a scoped Tauri asset protocol. The packaged content-security policy restricts network access from the frontend. These controls need native boundary tests and a release review; they are not a completed security audit.

## Retention, deletion, and backups

There is no automatic retention cleanup. Audio, including partial artifacts, remains until explicitly deleted. **Recover audio** writes repaired copies beside original partial WAVs. The originals remain, so recovery needs additional disk space.

**Delete audio** removes tracked audio/timing files and other regular files directly within that meeting's audio folder, including recovery originals. Notes, transcripts, and summaries remain. **Delete meeting** also removes the meeting and associated database rows, including search entries. The UI requires the title for confirmation; the backend refuses deletion of the active meeting. The app has no undo.

Deletion is not secure erasure. OS backups, sync copies, and unreclaimed database or disk space may retain content. Exported snapshots are never deleted by these operations. Links and paths are guarded, but the symlink case remains part of native qualification.

Before a backup, wait for **Saved**, close the app normally, and copy the complete app-data directory plus exports separately. Do not copy or replace only an active `meetings.db` and assume it contains every committed WAL write. Do not reset or delete the database as troubleshooting.

## Saving and recording limits

Autosave waits 400 ms and serializes writes. Graceful close flushes notes and refuses to quit on save failure. A forced termination or power loss may lose unsaved text. Stop requests capture shutdown without waiting for a note save; a failed draft remains on screen.

Real recording requires consent acknowledgement and available device access. The code has pause controls and tests that reject queued samples from old pause generations. Real-machine exclusion of paused audio, failure behavior, timing, and local-only egress still require qualification. Use authorized synthetic content for those checks. See [recording consent](consent.md).
