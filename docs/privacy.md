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
| `meetings.db`                        | Meeting metadata, notes, transcripts, summaries, settings, full-text search copies, processing grants, request digests/counters, provisional text, and frozen saved-note snapshots. |
| `meetings.db-wal`, `meetings.db-shm` | SQLite sidecar files that can exist while WAL mode is active.                           |
| `audio/<meeting ID>/`                | Microphone/system WAV files, timing indexes, and any repaired copies.                   |
| `stt/engine/`                        | Downloaded local speech engine and its release marker.                                  |
| `stt/sherpa/custom/<folder>/`        | Verified sherpa-onnx model folders from Hugging Face, with `openmeet-source.json` provenance. |
| `stt/models/`                        | Selected speech models (pinned downloads, verified Hugging Face Whisper `ggml` files with `.openmeet.json` manifests) and VAD model. |

Markdown exports are separate files under the chosen destination's `Meetings` directory. The database, recordings, timing files, transcripts, models, and exports are unencrypted. Device administrators, backups, and sync software may access them. Choosing a cloud-synced export folder can move content off-device without an OpenMeet upload request.

Desktop capture writes the selected microphone and system audio locally. On Windows the system track records every app except OpenMeet, so it can contain unrelated application audio such as music or notifications. On macOS the system track uses an output-only process tap; outputs with their own input are refused. Permission denial remains untested. Sample and simulation creation is removed; historical fictional entries remain labeled and accessible to preserve edited notes. Tests use synthetic fixtures.

## Network actions

| Explicit action                   | Destination                                                       | Sent or downloaded                                                                            |
| --------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Download speech engine and models | GitHub and Hugging Face, including their artifact delivery hosts. | Downloads pinned engine/model files. Meeting audio and notes are not uploaded.                |
| Search Hugging Face / list files  | Public Hugging Face API.                                          | Search query or repository identifier; no meeting content or provider credentials.            |
| Download selected public model    | Hugging Face and approved HTTPS artifact hosts.                   | Revision-pinned file and local provenance manifest; no meeting uploads.                       |
| Refresh provider models           | Saved API base plus `/models` (HTTPS or local loopback HTTP).     | Credentials only; no meeting content. Saving a model makes no request.                        |
| Enhance notes                     | Saved LLM base plus `/chat/completions`.                          | Notes/transcript with speaker names, model, prompt/template, saved instructions. No audio.    |
| Ask this meeting                  | Same saved LLM chat-completions route.                            | The question and the meeting's notes/transcript and speaker names; a follow-up also sends up to the latest 6 earlier questions and answers of its thread. If the whole meeting does not fit one request, only transcript excerpts selected on this device by keyword match are sent, plus your notes (only their matching paragraphs if the notes are long) when they mention a keyword. No audio or other meetings. |
| Ask across meetings               | Same saved LLM chat-completions route.                            | The question plus the notes, transcript text, speaker names, titles and start dates of only the 1 to 20 meetings you selected, in one request; the answer is saved locally with its scope until you delete it or any of those meetings. If the selected meetings do not fit one request, only locally selected transcript excerpts are sent, plus each meeting's notes (only their matching paragraphs if long) when they mention a keyword, and each meeting's title and start date still go with them. No audio, other meetings, or tag lists. |
| Rewrite selection                 | Same saved LLM chat-completions route.                            | Only the selected note text (up to 20,000 characters) and your rewrite request. No other notes, transcript, audio or meeting metadata. The result is shown, not stored, until you replace the selection with it. |
| First-run setup server detection  | `http://127.0.0.1` ports 11434, 1234, 8888, 8000 and 8080 only. | `GET /v1/models` with no key and no meeting content, while setup is open. A key typed for a detected server goes to the OS keychain like any connection. |
| Meeting detection (opt-in)        | Nothing leaves the device.                                      | Every 3 seconds while on, reads which apps are using the microphone: on Windows from the microphone privacy store (app identifiers and usage times), on macOS 14.2+ from CoreAudio process objects (bundle identifier, process path and whether input is running). Never audio. Ignored apps are stored locally. A detection only shows a prompt and flashes the taskbar entry; it never starts recording. |
| Cloud transcription               | Independently saved speech base plus `/audio/transcriptions`.     | Finalized microphone/system audio as bounded WAV chunks, model, language and vocabulary hint. |
| Automatic processing (Settings default) | Speech engine and optional AI notes connection set in Settings when the recording starts. | Accepted audio in finalized live chunks and/or final tracks; saved notes and final transcript only if an automatic summary is chosen. |
| Retry processing | Current speech and summary settings, for the existing stopped recording. | Remaining final audio/text work, with new finite budgets; earlier requests may already have been billed. |

There is no telemetry or updater. Automatic processing is off (recording only) by default; when chosen in Settings it runs for every new recording. Development mode uses a Vite server on localhost. Dependency installation and builds can also contact package registries; those development tools are separate from application content submission.

Explicit local scans read bounded directory entries and model headers; candidate import reads and hashes the selected file. Scan results are not uploaded. Hugging Face search sends the entered query, and listing files sends the selected repository ID. Hugging Face downloads are limited to Whisper `ggml` files and complete sherpa-onnx folders; LLM GGUF files are not downloaded. Downloads keep repository license metadata in a local manifest.

Model installation checks pinned sizes and SHA-256 hashes. Downloads occur only on an explicit action. Changing a selected model retains existing downloads. Local transcription runs whisper.cpp or the sherpa-onnx engine as a subprocess, with paths and settings passed locally. The sherpa-onnx engine and its speech models download from github.com and huggingface.co, each file checked against pinned SHA-256 hashes. Output text is parsed from temporary JSON, not emitted to the app's console. Cancelling or failing transcription keeps the previous transcript. Local transcription, cloud preparation, and mapped timestamp seeking reject missing or damaged recording timing. No transcript is published from that failed run, and original audio/index files are preserved.

## Credentials and cloud processing

There are no per-request confirmation cards or processing reviews (removed 2026-10-22). Each new recording attaches a plan built from the saved automatic-processing default; if it cannot be built, the recording continues with processing off and a notice. Retry builds a new plan for an existing stopped recording and starts no capture.

The plan stored in SQLite contains nonsecret destination/model metadata, scope, limits, and revisions. It contains no API keys, keychain account references, vocabulary prompt, or meeting content. Separate workflow tables persist stage, attempt/run identity, sanitized failures, dispatch digests and byte counters, provisional text, and the saved-note snapshot acknowledged for a summary. These records are unencrypted and cascade with meeting deletion. Provisional text is excluded from search, exports, and summary input.

Plans limit recording to 14,400 seconds and post-stop processing to 14,400 seconds, with 256 MiB of uploaded audio, 1,000 requests, and 800,000 UTF-8 text bytes. Text request accounting uses the serialized request body in UTF-8 bytes, including generated combination requests. Cloud audio accounting reserves each actual request's frozen audio bytes and digest before sending. Uncertain request outcomes do not refund budget. Speech or provider changes during a run, the processing deadline, cancellation, or exhaustion prevent further dispatch and stale publication. Live and final processing may send the same recorded interval separately and incur separate charges.

The recording worker copies only samples accepted for the saved track into a bounded live queue. Overload drops the live copy and marks the preview incomplete without dropping the saved recording for that reason. Pausing blocks new live dispatch. Work already submitted from accepted pre-pause audio may finish. Temporary live WAVs and timing files are unencrypted and removed when their owner releases them. Native pause privacy remains an open hardware gate.

Final transcription publishes atomically. Automatic summaries use the final transcript and a saved-note revision acknowledged after stop. A failed note save blocks that summary and retains the editor draft. Later note or transcript changes reject stale summary publication. Graceful quit saves notes, stops capture, and interrupts processing. Restart never replays requests. Explicit retry creates a fresh run with finite budgets and can resume after a successful final transcript. It can repeat a remotely billed request.

Settings accepts a masked API key for each reusable saved API connection. Independent summary and speech assignments can share that connection. The key exists briefly in an uncontrolled password field and Tauri IPC, then Rust stores it in the OS keychain under service `dev.openmeet.preview` with a revision-specific account. The field clears after a save attempt, profile change, tab change, and unmount. No key is returned to the UI or stored in React state, browser storage, SQLite, logs, or exports. JavaScript cannot guarantee memory zeroization. Environment import and `.env` parsing are not used. Legacy Merge keys remain dormant; they are not forwarded to a new provider.

Changing a remote provider URL requires entering a key for that destination. Local loopback HTTP allows an optional key; changing its destination discards the old credential reference. Editing a shared connection affects all assignments using it. Key replacement stores a new credential before publishing its reference in SQLite, then retires the previous credential. A failed publication keeps the old working connection. A cleanup error reports partial success and reloads Settings; crashes can leave unused credentials in the OS keychain.

Manual summaries, questions (per meeting or across meetings), rewrites and cloud transcription send when you use them, to the connection assigned in Settings; Settings marks each connection "This device" or "Leaves this device". Provider terms and billing apply after submission. Local Whisper remains the default and does not upload audio. OpenMeet cannot retract uploaded audio or guarantee provider retention behavior. Cancellation prevents later uploads and publication, but an in-flight request can finish remotely and be billed.

Long summaries split transcript segments into bounded requests, then combine the partial results with the user's notes. The maximum plan is eight chunks plus one combination request. Oversized input is refused rather than truncated. Sending more requests than the plan allows is refused. Cloud audio is prepared as frozen temporary PCM WAV chunks, and preparation fails if the source file changes meanwhile. These scratch files are unencrypted and removed when preparation or execution ends. No automatic capability-probing upload or billable retry occurs.

Summary results are saved separately from user notes with provider, model, and template metadata. Older versions remain available; export uses the latest. Tasks are stored locally, unencrypted, and are included in Markdown exports. Importing tasks from a summary sends nothing. Editing a summary sends nothing; edits are stored locally as new versions. Transcript edits and earlier transcripts are also stored locally, unencrypted; corrected text is what later summaries, questions, and exports use. When a question's content is too long for one request (a long meeting or a large library scope), OpenMeet does not refuse it: it searches the selected transcripts and notes on this device for the question's keywords (a lexical match, not a semantic one) and sends only the matching transcript lines with up to two neighbouring lines on each side, plus the notes or the matching notes paragraphs, within the request budget. Editing an excerpted line while the answer is pending stops it from being saved. When nothing matches, nothing is sent and no provider is contacted: the app shows "No passages in the selected content matched your question. Nothing was sent." and stores no question turn. The model is told that only excerpts are included and to answer "Insufficient evidence in the provided excerpts" rather than guess. Content that fits one request is sent in full, as before. Questions and their answers are saved in question threads with the meeting, with provider and model, locally and unencrypted; they are not included in exports. A follow-up sends up to the latest 6 earlier questions and answers of that thread as untrusted context; a turn added while the answer is pending stops it from being saved, and a thread too long to send is refused rather than truncated. Failed or cancelled questions store nothing. Deleting a thread (after a confirmation) or the meeting removes its saved questions and answers. Answers across meetings are saved the same way with the ids of the meetings sent; deleting the answer or any one of those meetings deletes it. Recipes are question text stored locally; choosing one sends nothing. Summary copy buttons place text on the system clipboard, which other software may read.

## Webview boundary

Rust owns filesystem access, model execution, HTTP requests, native dialogs, shortcuts, and credentials. The webview receives specific commands and events. It can play files under the app-data `audio/` directory through a scoped Tauri asset protocol. The packaged content-security policy restricts network access from the frontend. These controls need native boundary tests and a release review; they are not a completed security audit.

## Retention, deletion, and backups

There is no automatic retention cleanup. Audio, including partial artifacts, remains until explicitly deleted. **Recover audio** writes repaired copies beside original partial WAVs. The originals remain, so recovery needs additional disk space.

**Delete audio** removes tracked audio/timing files and other regular files directly within that meeting's audio folder, including recovery originals. Notes, transcripts, and summaries remain. **Delete meeting** also removes the meeting and associated database rows, including search entries. The UI requires the title for confirmation; the backend refuses deletion of the active meeting. The app has no undo.

Deletion is not secure erasure. OS backups, sync copies, and unreclaimed database or disk space may retain content. Exported snapshots are never deleted by these operations. Links and paths are guarded, but the symlink case remains part of native qualification.

Before a backup, wait for **Saved**, close the app normally, and copy the complete app-data directory plus exports separately. Do not copy or replace only an active `meetings.db` and assume it contains every committed WAL write. Do not reset or delete the database as troubleshooting.

## Saving and recording limits

Autosave waits 400 ms and serializes writes. Graceful close flushes notes and refuses to quit on save failure. A forced termination or power loss may lose unsaved text. Stop requests capture shutdown without waiting for a note save; a failed draft remains on screen.

Real recording requires available device access; telling participants is the user's responsibility. The code has pause controls and tests that reject queued samples from old pause generations. Real-machine exclusion of paused audio, failure behavior, timing, and local-only egress still require qualification. Use authorized synthetic content for those checks. See [recording consent](consent.md).
