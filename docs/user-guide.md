# Use OpenMeet

Install the prerequisites and run `just setup`, then `just dev`, as described in the [README](../README.md#install-and-run-on-windows). The native desktop app provides storage and recording. A browser-only preview disables desktop actions.

## Write and find notes

1. Click **New note**. This creates a note without opening audio devices.
2. Click **Rename**, enter a title, and press **Enter**. **Escape** cancels a rename.
3. Write Markdown in **My notes**.
4. Wait for **Saved** before closing. Use **Save notes now** to retry a failed save.

Notes autosave after 400 ms without another edit. Saves run in order, and the backend rejects stale revisions. Switching meetings, exporting, and graceful close flush pending changes. A failed save keeps the draft on screen and prevents a safe close. Forced termination can lose unsaved text.

Use the sidebar search to find meeting titles. Queries of at least two characters also search notes, transcript segments, and summaries. Selecting a content match opens the corresponding tab. Settings and setup preserve the mounted note draft.

Add tags in the box under the meeting title (comma-separated, up to 20 per meeting, 40 characters each, case-insensitive) and click **Save tags**. Once any meeting has a tag, the sidebar **Filter by tag** menu limits both the meeting list and content matches to that tag. Tags are listed in the sidebar and in the exported Markdown frontmatter after `meeting`.

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
3. Choose the default **Automatic processing** under Settings → General (**Recording only** by default). The New recording panel shows it and still requires a reviewed, confirmed plan before any processing starts.
4. Acknowledge participant recording consent, then click **Start recording**.
5. Use the microphone and system meters to check for incoming signals.
6. Use **Pause**, **Resume**, and **Stop** in the bottom recording bar.

Saved device choices are not silently replaced when a device is unavailable. A missing device or capture failure must be resolved before trying again. A silent output can produce no loopback frames; the two track files can therefore have different lengths.

In **My notes**, **Insert timestamp** adds the current backend recording offset. **Ctrl+Shift+T** performs the same action while the editor has focus. Settings provide a pause/resume shortcut and an optional stop shortcut. There is no global start shortcut. If registration fails, use the on-screen controls and choose another shortcut.

The code excludes paused audio, but real-device pause privacy, device failures, and long-run timing remain unqualified. A meter signal or two WAV files does not establish a successful recording.

## Choose automatic processing

1. In **New recording**, choose **Live transcription only**, **Final transcription after stop**, or **Live and final transcription**.
2. For either final option, optionally choose an **Automatic summary** template.
3. Click **Review processing**. Check the speech and summary destinations, models, tracks, language, and limits.
4. Acknowledge the processing scope, destinations, and limits. This covers future recorded audio and, when a summary is enabled, saved notes and the final transcript.
5. Acknowledge participant recording consent independently, then start recording. Changing the scope or relevant settings requires another review.

Local Whisper stays on this device. An API speech destination receives audio. An API summary destination receives saved notes and final transcript text. Live plus final transcription uses separate requests and can incur separate charges. Review preparation makes no provider request and does not install a missing model.

The review currently allows up to 3,600 seconds of recording, 14,400 seconds of processing after stop, 256 MiB of uploaded audio, 1,000 requests, and 800,000 UTF-8 text bytes. The screen shows the authoritative limits. Exceeding a processing limit does not stop recording or authorize more requests. Recordings beyond the reviewed duration are refused for automatic processing and retry under that plan.

Live text is provisional. The latest 200 segments appear with track labels and incomplete-coverage warnings. Provisional text is excluded from search, summaries, and exports. If the live queue fills or a processing operation cannot run, capture continues and the preview can have gaps. Accepted audio captured before a pause may finish processing while paused. Paused audio is excluded by the implementation; hardware privacy remains unqualified.

Stop finalizes audio through the shared UI, tray, or shortcut path. Final transcription replaces the saved transcript atomically and removes provisional text only after success. A live-only session retains its provisional preview without creating a final transcript or summary.

An automatic summary waits for the capture meeting's saved notes. A failed save keeps your draft and displays **Save notes and continue processing**. Retry that action after resolving the save failure. Changes to notes or the transcript during summary generation prevent publication of a stale summary and preserve previous output.

Use **Cancel session processing** to stop further work without stopping capture or deleting output. Submitted content cannot be recalled, and a remote request may still be billed. **Review processing retry** requires a new confirmation for the existing stopped recording, with fresh limits and a processing deadline. Retry keeps a successfully completed transcript and can continue with the summary. It starts no recording. A stopped live-only preview cannot restart; use manual final transcription instead.

**Save and quit** first saves notes, then stops capture and interrupts unfinished processing. Restart displays interrupted work and makes no automatic retry. Recover incomplete recording files before retrying final processing. Native, hardware, and real-provider qualification remain open; see [workflow evidence](phase-3-workflow-verification.md).

## Transcribe and play audio

1. Open **Settings → Local → Speech to text** and choose **Local Whisper**.
2. Choose a speech model, language, and optional vocabulary hint. Click **Save transcription settings**.
3. Click **Download speech engine and models** if the selected model is missing.
4. Stop the recording, open its **Transcript** tab, and click **Transcribe audio**.
5. Monitor progress or click **Cancel transcription**.

The engine and models download only on an explicit action. The selected model runs locally on finalized, nonempty tracks. Failed or cancelled runs keep the previous transcript. Changing models preserves existing downloads. See [downloaded components](dependencies.md#speech-engine-and-model-downloads) for versions and sizes.

**You** identifies the microphone track and **Others** identifies system audio. These labels do not identify individual people. Review names, numbers, and decisions before using a transcript.

Under the transcript's **Speaker names**, you can name the two labels for this meeting, for example "Rahul" for You. The transcript, export, and the text sent for summaries and questions then show "Rahul (You)". Others covers all system audio, so one name applies to everyone heard through it. Clearing a name restores the label. Renaming after reviewing a summary or question requires a new review.

Click **Edit** beside a transcript segment to correct its text, then **Save**. Edited segments show "(edited)"; hover to see the original, or click **Revert** to restore it. Search, summaries, questions, and export use the corrected text, and export marks the transcript with `transcript_edited: true`. An open segment edit is kept while you switch meetings, and quitting warns before discarding it. Editing is unavailable while a transcription or summary you started from this screen runs. If the segment changed since you started, for example after re-transcription, the save is refused and your text stays open. Re-transcribing never discards your edits: the current transcript, including edits, is kept under **Earlier transcripts**, where you can read it but not restore it.

When the transcript or speaker names change after a summary was made, the Summary tab says the summary is out of date. Generate a new summary to include the changes; reverting the change clears the notice. Summaries made before this check existed are never flagged.

The Transcript tab provides one player for each playable track. Select a transcript timestamp to seek the corresponding track. Timestamp links inserted in notes can jump to audio; system-track seeking is approximate. Leaving the Transcript tab or opening settings pauses playback. Missing or incomplete files produce a visible error.

For API transcription, choose **API connection** as the transcription mode. Create a named connection under **Cloud API** or **Local**, then select it and a model under the **Speech API** assignment and save. Local loopback HTTP permits optional keys; remote APIs require HTTPS and a key. Explicit refresh lists model IDs; custom IDs also work. Local engine downloads are not needed for cloud mode. Language/vocabulary settings remain available, but a provider may reject unsupported options visibly.

**Transcribe audio** in cloud mode first shows an audio-upload confirmation with destination, model, tracks, bytes, and request count. Cancelling the review sends nothing. Cancelling an active run prevents further chunks and preserves the old transcript, but audio already uploaded cannot be recalled and in-flight work may still be billed. JSON results without timing are explicitly untimed and grouped by track; their text supports search, summaries, and export, without timestamp links.

## Find and download local models

Open **Settings → Local**. Scan common folders or choose a folder explicitly. The scan reports examined folders and truncation; it reads file headers within limits of 4,096 entries, six levels, and 200 files. Discovery alone does not verify or activate a model. Import matching Whisper catalog candidates to verify their full hash and copy them into managed storage; the source remains untouched. Select and save the Whisper model separately.

Search Hugging Face explicitly to see up to 20 public results. Review the repository, revision, size, and license before downloading a supported file. Downloads verify the pinned size and SHA-256 and preserve existing files. Cancel stops transfer and prevents publication at the cancellation boundary. Complete single-file GGUF models require a separately managed compatible server; downloading does not launch one. Private/gated repositories and split models are unsupported.

## Generate summaries and ask questions

Configure your independent LLM base URL, key, and model using the [README setup](../README.md#set-up-optional-ai-summaries). Keys are saved in the OS keychain and not read back into the form. Model discovery is optional; the chosen model must support the chat endpoint.

1. Open **Summary** and choose **General**, **Stand-up**, **One-to-one**, or one of your custom templates.
2. Click **Enhance notes**.
3. Review the destination, model, template, saved-instructions notice, text scope, and request count.
4. Confirm the send, or cancel to send nothing.

Add custom templates and saved summary instructions in **Settings → General → Summary templates**. A custom template describes the sections you want. Saved instructions, such as "Write in British English", are sent with every manual and automatic summary request. Built-in rules still apply: the model must not invent facts or follow instructions found inside notes or transcripts. Editing a template or the instructions after reviewing a summary requires a new review. Automatic summaries offer only the three built-in templates, but they include the saved instructions frozen at review. Deleting a template keeps earlier summaries; their history shows "Deleted custom template".

Notes and transcript text leave the device after confirmation. Audio is never included. Longer transcripts can require several requests, including a final combination request. Inputs above the implementation's limits are refused rather than silently shortened. A failed request does not remove your notes or the last saved summary.

Use the version picker to read earlier summaries. **Copy summary** and **Copy action items** write to the system clipboard, where other apps may read the text. Markdown export always uses the latest saved summary, regardless of the viewed version.

### Source links

Summaries are asked to end key points, decisions, and action items with the `[m:ss]` time of a supporting transcript line; this instruction is shared by every template. Answers and imported tasks can carry the same times. A time becomes a link only when a stored timed segment starts in that second. Clicking it opens the Transcript tab, highlights the segment, and plays its track from there when the audio is available. Times with no matching segment show "(unverified)". When both tracks have a segment in the same second, both are highlighted and the first is played. A link proves only that the segment exists, not that it supports the claim, so read the segment. Untimed transcripts cannot be cited. Links always point to the current transcript, including after edits or re-transcription.

### Edit a summary

Click **Edit summary** to change the summary on screen. **Save edited summary** adds your text as a new version; the generated version and every earlier one stay in the version picker. Edited versions are labelled "edited by you", and Markdown export marks the summary with `summary_edited: true`. An unsaved edit stays open while you switch meetings. If you quit, OpenMeet warns you and asks before discarding it. If a newer summary arrived while you were editing, the first save is refused and your edit stays open, so neither version replaces the other silently. Review the newer version; saving again puts your edit on top of it. The version picker is locked while an edit is open, and deleting a meeting discards its unsaved edit. Generating a summary when the current version is your edit tells you that the new summary becomes current while your edit stays in history. Editing a summary sends nothing.

### Tasks

The **Tasks** list below the summary holds editable action items. Add a task by hand, or click **Add from summary** to copy the bullets in the shown summary version's "Action items" section. Importing skips bullets that an existing task of this meeting was imported from, from any summary version and even if you edited the task since. A deleted task can be imported again. If a bullet is too long or the meeting would exceed 200 tasks, nothing is added. Owners and due dates are never guessed; they stay "Unassigned" and empty until you set them. Tick a task to mark it done. Tasks are stored on this device and are included in every Markdown export as a "Tasks" checklist, whatever the summary option is set to.

**Ask this meeting** sends your question and that meeting's notes and transcript after a separate confirmation. The question and answer are saved with the meeting on this device (unencrypted) as a thread, and are not exported. Use **Ask a follow-up** to continue the thread: its latest 6 earlier questions and answers are sent too, as the confirmation card states. Choose **New question** for a separate thread, pick earlier threads from **Question threads**, or **Delete thread** (after confirming) to remove one. A thread whose earlier answers are too long to send is refused; start a new question. If the meeting is too long for one request, OpenMeet picks the transcript lines that match your question's keywords (with a few lines of context around each) and any matching notes on your device and sends only those; the confirmation card says "transcript excerpts selected on this device by keyword match" instead of listing the whole transcript. The match is by words, not meaning, so rephrase with words used in the meeting if nothing is found. If nothing matches, nothing is sent: you see "No passages in the selected content matched your question. Nothing was sent." and no question is saved. The model is told to say "Insufficient evidence in the provided excerpts" when the excerpts do not support an answer. Check AI output before relying on it. Live summary quality and long-meeting behavior remain unqualified.

**Ask across meetings** (sidebar) answers one question over meetings you choose: tick up to 20 meetings, or pick a tag to select every meeting with it. Press **Review** to see the destination, model, and the titles of the meetings whose notes and transcript text (with speaker names) will be sent in a single request; nothing is sent until you press **Send question**. Changing the meetings or the question discards the review. The answer cites sources as `[M2 1:01]` (meeting 2 at that transcript time) or `[M2]` (notes or untimed text). A citation becomes a link only if that meeting was in the scope you reviewed and a timed transcript line starts at that second; the link opens the meeting and jumps to that line. Anything else shows "(unverified)". A link shows that a line exists at that time, not that it supports the claim, so check it. The answer stays in the panel until you ask again or quit, and is never saved. If the selected meetings are too long for one request, only transcript excerpts and notes that match your question's keywords are sent from them (the card says how many excerpts from how many meetings; every selected meeting's title and start date still go with them). If nothing matches, you see "No passages in the selected content matched your question. Nothing was sent." instead of a card.

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
