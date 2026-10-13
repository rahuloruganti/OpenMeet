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
| `stt/models/`                        | Selected speech models and VAD model.                                                   |

Markdown exports are separate files under the chosen destination's `Meetings` directory. The database, recordings, timing files, transcripts, models, and exports are unencrypted. Device administrators, backups, and sync software may access them. Choosing a cloud-synced export folder can move content off-device without an OpenMeet upload request.

Simulation opens no audio devices. The fictional sample is authored test content. Desktop capture writes the selected microphone and system output locally. System output can contain audio from unrelated applications. On macOS that system track is an output-only process tap; an output that also has an input is refused. Permission denial has not been tested.

## Network actions

| Explicit action                                       | Destination                                                       | Sent or downloaded                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Download speech engine and models                     | GitHub and Hugging Face, including their artifact delivery hosts. | Downloads pinned engine/model files. Meeting audio and notes are not uploaded.    |
| Connect/refresh Merge models or save a selected model | `https://api-gateway.merge.dev/v1/models`                         | Authenticated, bounded, paginated model discovery. No meeting content.            |
| Confirm Enhance notes                                 | `https://api-gateway.merge.dev/v1/chat/completions`               | Selected meeting notes and transcript text, model, and prompt/template. No audio. |
| Confirm Ask this meeting                              | Same chat-completions route.                                      | The question and that meeting's notes/transcript. No audio or other meetings.     |

There is no telemetry, automatic cloud processing, or updater. Development mode uses a Vite server on localhost. Dependency installation and builds can also contact package registries; those development tools are separate from application content submission.

Model installation checks pinned sizes and SHA-256 hashes. Downloads occur only on an explicit action. Changing a selected model retains existing downloads. Local transcription runs whisper.cpp as a subprocess, with paths and settings passed locally. Output text is parsed from temporary JSON, not emitted to the app's console. Cancelling or failing transcription keeps the previous transcript.

## Credentials and cloud consent

Rust imports `OPENMEET_LLM_API_KEY` only when **Import key from environment** is clicked. The backend stores the key in the OS keychain under service `dev.openmeet.preview`, account `merge-gateway-api-key`. The frontend receives key presence, not its value. The app does not parse `.env` for this credential. Remove the environment variable from the launching shell after use; keychain import does not clear the shell or process environment.

Each summary and question requires its own confirmation. The UI identifies destination, model, content scope, and summary request count. Merge and the model provider's terms apply after submission. OpenMeet cannot retract a submitted request or guarantee provider retention behavior.

Long summaries split transcript segments into bounded requests, then combine the partial results with the user's notes. The maximum plan is eight chunks plus one combination request. Oversized input is refused rather than truncated. The backend refuses if the required request count has changed since confirmation; it does not compare a hash of every confirmed character.

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
