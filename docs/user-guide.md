# Use OpenMeet

Install the prerequisites and run `just setup`, then `just dev`, as described in the [README](../README.md#install-and-run-on-windows). The native desktop app provides storage and recording. A browser-only preview disables desktop actions.

## Write and find notes

1. Click **New note**. This creates a note without opening audio devices.
2. Click **Rename**, enter a title, and press **Enter**. **Escape** cancels a rename.
3. Write Markdown in **My notes**.
4. Wait for **Saved** before closing. Use **Save notes now** to retry a failed save.

Notes autosave after 400 ms without another edit. Saves run in order, and the backend rejects stale revisions. Switching meetings, exporting, and graceful close flush pending changes. A failed save keeps the draft on screen and prevents a safe close. Forced termination can lose unsaved text.

Use the sidebar search to find meeting titles. Queries of at least two characters also search notes, transcript segments, and summaries. Selecting a content match opens the corresponding tab. Settings and setup preserve the mounted note draft.

The **Meetings** button collapses or opens the sidebar. Use **Tab** to move between controls. When a content tab has focus, **Left**, **Right**, **Home**, and **End** navigate the tabs.

## Distinguish meeting sources

| Label            | Meaning                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Note             | A notes-only entry with no capture.                                                                               |
| Desktop capture  | An entry created through real capture. Its status and errors still determine whether recording completed. |
| Simulation       | A recording-state demonstration that opens no audio devices.                                                      |
| Fictional sample | Test notes, transcript, and a hand-written summary.                                                               |

Sample and simulation creation has been removed. Those labels describe preserved historical records only; edited notes remain accessible. Use **New note** for writing without capture.

## Record

Capture remains a preview. On Apple Silicon macOS 14.2 or newer, choose an output-only device. A device that also has an input is refused. Permission denial has not been tested. Apple Silicon transcription requires the separately pinned local whisper.cpp build; its integrated workflow remains unqualified. Read [recording consent](consent.md) and inform participants before starting. System audio can include unrelated applications.

1. Click **New recording** and enter a title.
2. Choose the microphone and system-output device you intend to capture.
3. Acknowledge consent, then click **Start recording**.
4. Use the microphone and system meters to check for incoming signals.
5. Use **Pause**, **Resume**, and **Stop** in the bottom recording bar.

Saved device choices are not silently replaced when a device is unavailable. A missing device or capture failure must be resolved before trying again. A silent output can produce no loopback frames; the two track files can therefore have different lengths.

In **My notes**, **Insert timestamp** adds the current backend recording offset. **Ctrl+Shift+T** performs the same action while the editor has focus. Settings provide a pause/resume shortcut and an optional stop shortcut. There is no global start shortcut. If registration fails, use the on-screen controls and choose another shortcut.

The code excludes paused audio, but real-device pause privacy, device failures, and long-run timing remain unqualified. A meter signal or two WAV files does not establish a successful recording.

## Transcribe and play audio

1. Open **Settings → Local → Speech to text** and choose **Local Whisper**.
2. Choose a speech model, language, and optional vocabulary hint. Click **Save transcription settings**.
3. Click **Download speech engine and models** if the selected model is missing.
4. Stop the recording, open its **Transcript** tab, and click **Transcribe audio**.
5. Monitor progress or click **Cancel transcription**.

The engine and models download only on an explicit action. The selected model runs locally on finalized, nonempty tracks. Failed or cancelled runs keep the previous transcript. Changing models preserves existing downloads. See [downloaded components](dependencies.md#speech-engine-and-model-downloads) for versions and sizes.

**You** identifies the microphone track and **Others** identifies system audio. These labels do not identify individual people. Review names, numbers, and decisions before using a transcript.

The Transcript tab provides one player for each playable track. Select a transcript timestamp to seek the corresponding track. Timestamp links inserted in notes can jump to audio; system-track seeking is approximate. Leaving the Transcript tab or opening settings pauses playback. Missing or incomplete files produce a visible error.

For API transcription, choose **API connection** as the transcription mode. Create a named connection under **Cloud API** or **Local**, then select it and a model under the **Speech API** assignment and save. Local loopback HTTP permits optional keys; remote APIs require HTTPS and a key. Explicit refresh lists model IDs; custom IDs also work. Local engine downloads are not needed for cloud mode. Language/vocabulary settings remain available, but a provider may reject unsupported options visibly.

**Transcribe audio** in cloud mode first shows an audio-upload confirmation with destination, model, tracks, bytes, and request count. Cancelling the review sends nothing. Cancelling an active run prevents further chunks and preserves the old transcript, but audio already uploaded cannot be recalled and in-flight work may still be billed. JSON results without timing are explicitly untimed and grouped by track; their text supports search, summaries, and export, without timestamp links.

## Find and download local models

Open **Settings → Local**. Scan common folders or choose a folder explicitly. The scan reports examined folders and truncation; it reads file headers within limits of 4,096 entries, six levels, and 200 files. Discovery alone does not verify or activate a model. Import matching Whisper catalog candidates to verify their full hash and copy them into managed storage; the source remains untouched. Select and save the Whisper model separately.

Search Hugging Face explicitly to see up to 20 public results. Review the repository, revision, size, and license before downloading a supported file. Downloads verify the pinned size and SHA-256 and preserve existing files. Cancel stops transfer and prevents publication at the cancellation boundary. Complete single-file GGUF models require a separately managed compatible server; downloading does not launch one. Private/gated repositories and split models are unsupported.

## Generate summaries and ask questions

Configure your independent LLM base URL, key, and model using the [README setup](../README.md#set-up-optional-ai-summaries). Keys are saved in the OS keychain and not read back into the form. Model discovery is optional; the chosen model must support the chat endpoint.

1. Open **Summary** and choose **General**, **Stand-up**, or **One-to-one**.
2. Click **Enhance notes**.
3. Review the destination, model, template, text scope, and request count.
4. Confirm the send, or cancel to send nothing.

Notes and transcript text leave the device after confirmation. Audio is never included. Longer transcripts can require several requests, including a final combination request. Inputs above the implementation's limits are refused rather than silently shortened. A failed request does not remove your notes or the last saved summary.

Use the version picker to read earlier summaries. **Copy summary** and **Copy action items** write to the system clipboard, where other apps may read the text. Markdown export always uses the latest saved summary, regardless of the viewed version.

**Ask this meeting** sends your question and that meeting's notes and transcript after a separate confirmation. The answer appears in the interface and is not saved or exported. Check AI output before relying on it. Live summary quality and long-meeting behavior remain unqualified.

## Export Markdown

1. Click **Export Markdown**.
2. On the first export, choose a destination folder. Cancel to leave the destination unset.
3. Read the notification for the saved file path.

Files are written under the destination's `Meetings` directory. **Settings → General → Markdown export** controls transcript inclusion, summary inclusion, and title or date-and-title filenames. The date prefix uses the stored UTC start date.

Exports contain source metadata, user notes, and the selected sections. They do not include audio. An identical existing snapshot is reused. A differing file produces a new snapshot instead of overwriting external edits. Renaming a meeting does not rename older exports. Exported files are not synchronized back into the database.

## Recover or delete data

An interrupted desktop recording may offer **Recover audio**. Recovery writes repaired WAV copies beside the original partial files, preserving the originals. It needs additional disk space and cannot recreate missing audio. Each attempt uses a fresh filename so a database failure can be retried without overwriting a retained copy. Failed attempts can therefore use additional space. A playable recovered WAV does not establish valid pause timing: local/cloud transcription and transcript timestamp seeking refuse missing or damaged timing indexes instead of guessing.

Open the meeting's **•••** menu for **Delete audio** or **Delete meeting**. Both require the meeting title as confirmation and refuse an active recording. Delete audio retains notes, transcripts, and summaries. Delete meeting removes the local meeting and its associated data. Exported snapshots remain unchanged. There is no undo or secure erasure guarantee.

See [data retention and backups](privacy.md#retention-deletion-and-backups) before deleting or moving data, and [troubleshooting](../README.md#troubleshooting) for startup, saving, device, and export problems.
