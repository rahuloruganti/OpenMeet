# Use OpenMeet

Install the prerequisites and run `just setup`, then `just dev`, as described in the [README](../README.md#install-and-run-on-windows). The native desktop app provides storage and recording. A browser-only preview disables desktop actions.

## First-run setup

OpenMeet opens **Set up OpenMeet** until you finish or skip it. **Settings → Privacy & about → Run setup again** shows it again. Every step can be skipped.

1. **Welcome** says where data is kept and that recording consent is your responsibility.
2. **Transcription**: choose **On this computer** or **Online API**. On this computer, OpenMeet lists Whisper `ggml` files it finds in the usual folders (its own, `~/.cache/whisper`, the Hugging Face cache, Ollama and LM Studio folders); **Use** keeps the file where it is, labelled "matches pinned …" when its name and size match a pinned download, otherwise "custom". You can instead download Whisper `base.en-q5_1` (English) or `small` (any language), or a sherpa-onnx model (Windows x64): Parakeet TDT 0.6B v3 (English and European languages), Moonshine base (English, small and fast), or SenseVoice small (Chinese, Japanese, Korean, Cantonese, English). Setup recommends Parakeet v3 for English, auto-detect, and European languages, and Whisper small for others. Speech servers running on this computer, such as speaches or LocalAI, are offered too. Online API asks for a base URL and key, lists the provider's models with speech models first, and has **Show all models** and a field for any model ID.
3. **AI notes**: choose an AI server found on this computer (Ollama, LM Studio, Unsloth Studio, LocalAI), the transcription connection, or another online connection, then a chat model. Unsloth Studio needs its `sk-unsloth` key. Without a local server, install Ollama or LM Studio and run setup again. Change the connection and model later under **Settings → AI notes**.
4. **Devices**: choose the default microphone and system audio, and whether every recording is transcribed (and summarized, when AI notes are set) when it stops. This is off by default.

Detection only asks `GET /v1/models` of `127.0.0.1` ports 11434, 8888, 1234, 8000 and 8080, while setup is open. A server on another port can be added under **Settings → Connections**.

After setup is skipped or finished, the empty workspace (no meeting selected) shows **Setup status** whenever transcription or AI notes is not ready. Each row reads **Ready** or **Not set up**; **Open Settings** opens the section that fixes it. The list is hidden while OpenMeet is starting or a task is busy, and when both rows are ready.

## Write and find notes

1. Click **New note**. This creates a note without opening audio devices.
2. Click **Rename**, enter a title, and press **Enter**. **Escape** cancels a rename.
3. Write Markdown in **My notes**.
4. Wait for **Saved** before closing. Use **Save notes now** to retry a failed save.

Opening a plain note always shows **My notes**, even when the Transcript tab was selected for the previous meeting, because a note has no audio or transcript. Search and library links still open the tab they point to.

Notes autosave after 400 ms without another edit. Saves run in order, and the backend rejects stale revisions. Switching meetings, exporting, and graceful close flush pending changes. A failed save keeps the draft on screen, shows **Not saved** in red and a notes banner, and blocks switching meetings and quitting until a retry succeeds; the quit dialog says so. Copy your text if the save keeps failing. Forced termination can lose unsaved text.

Use the sidebar search to find meeting titles. Queries of at least two characters also search notes, transcript segments, and summaries. Selecting a content match opens the corresponding tab. Settings and setup preserve the mounted note draft.

Add tags in the box under the meeting title (comma-separated, up to 20 per meeting, 40 characters each, case-insensitive) and click **Save tags**. Once any meeting has a tag, the sidebar **Filter by tag** menu limits both the meeting list and content matches to that tag. Tags are listed in the sidebar and in the exported Markdown frontmatter after `meeting`.

The **Meetings** button collapses or opens the sidebar. While the sidebar is collapsed, the toolbar next to it shows **New recording**, **New note**, and **Settings**. Narrow windows (800 px wide or less) collapse the sidebar on their own, and it also closes after you open a meeting, start a note, or pick a search match so the content is visible. Widening the window does not reopen it. Use **Tab** to move between controls. When a content tab has focus, **Left**, **Right**, **Home**, and **End** navigate the tabs.

## Distinguish meeting sources

| Label            | Meaning                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Note             | A notes-only entry with no capture.                                                                               |
| Desktop capture  | An entry created through real capture. Its status and errors still determine whether recording completed. |
| Simulation       | A recording-state demonstration that opens no audio devices.                                                      |
| Fictional sample | Test notes, transcript, and a hand-written summary.                                                               |

Sample and simulation creation has been removed. Those labels describe preserved historical records only; edited notes remain accessible. Use **New note** for writing without capture.

## Record

Recording is still being tested on more computers. Try a short test meeting first. On Apple Silicon macOS 14.2 or newer, choose an output-only device. A device that also has an input is refused. Permission denial has not been tested. Apple Silicon transcription requires the separately pinned local whisper.cpp build; its integrated workflow remains unqualified. Inform participants and follow the recording-consent laws that apply before starting. System audio can include unrelated applications.

1. Click **New recording** and enter a title.
2. Choose the microphone and system audio device you intend to capture.
3. Choose the default **Automatic processing** under **Settings → Recording**, using **When a recording stops** (**Recording only** by default; it is saved in the database). The New recording panel shows it, and every new recording runs it.
4. Click **Start recording**. Telling participants and following recording-consent law is your responsibility; see [privacy](privacy.md).
5. Use the microphone and system meters to check for incoming signals.
6. Use **Pause**, **Resume**, and **Stop** in the bottom recording bar.

Saved device choices are not silently replaced when a device is unavailable. A missing device or capture failure must be resolved before trying again. On Windows the system track records all app audio except OpenMeet (process loopback), so it follows audio to any output, including a Bluetooth headset that switches to its hands-free endpoint during a call. Saved output choices from earlier versions are read as this source. When no app plays audio the system track can stay empty; a finalized empty track is named on the meeting's Transcript tab, and the live meter warns when the microphone has no signal for 10 seconds.

The New recording panel warns before you start when the selected speech engine cannot run: a local engine that is not downloaded, or a cloud speech connection missing either a stored key (or loopback destination) or a model. The warning does not block recording; the audio is kept and transcription fails visibly until the engine is set up in Settings.

In **My notes**, **Insert timestamp** adds the current backend recording offset, on its own line when the cursor is in the middle of a line. **Ctrl+Shift+T** performs the same action while the editor has focus and no other task is running. Settings provide a pause/resume shortcut (default **Ctrl+Shift+F9**) and an optional stop shortcut (default **Ctrl+Shift+F10** for new installs; existing saved settings are kept). There is no global start shortcut. Settings refuses a stop shortcut that matches the pause shortcut, ignoring case and spacing, and disables **Save shortcuts** until they differ. When you press keys to record a shortcut, a press without Ctrl or Alt that is not an F-key is refused with a hint instead of being taken. If registration fails, use the on-screen controls and choose another shortcut.

If a microphone or system audio device is not listed, for example a headset connected after OpenMeet started or a device you just allowed in your privacy settings, press **Refresh devices** in New recording or **Settings → Recording**. A refresh lists the devices again but never replaces a device you already chose; an unavailable choice stays marked until you pick another one.

The code excludes paused audio, but real-device pause privacy, device failures, and long-run timing remain unqualified. A meter signal or two WAV files does not establish a successful recording.

### Meeting detection (opt-in)

Turn on **Settings → Recording → Meeting detection** to be offered a recording when another app, such as Zoom, Teams or a browser, starts using your microphone. OpenMeet then asks the system every 3 seconds which apps are using the microphone: on Windows it reads the microphone privacy store, and on macOS 14.2 or newer (Apple Silicon) it asks CoreAudio which processes are running audio input. It reads app names only, never audio, and nothing leaves this device. On macOS, browsers are named after the browser even when a helper process holds the microphone, and processes without an app bundle are not reported. An app must hold the microphone for two checks in a row before a prompt appears, and OpenMeet's own recording is ignored.

The prompt names the app and offers **Set up recording**, **Not now**, or **Never for** that app. **Set up recording** only opens New recording with the title prefilled: nothing is captured until you click **Start recording**. Each app prompts once per microphone session and again the next time it starts using the microphone. Prompts are not shown while OpenMeet is recording. Ignored apps are listed in Settings with **Prompt again**. The prompt flashes the taskbar entry but does not open a hidden window, so it is only visible once you switch to OpenMeet. Dictation and captioning tools that hold the microphone also trigger it; choose **Never for** them. Detection is not available on Intel Macs or macOS before 14.2, and has not been qualified on a real call on either platform.

## Choose automatic processing

1. In **Settings → Recording**, under **Automatic processing**, set **When a recording stops** to **Live transcription only**, **Final transcription after stop**, or **Live and final transcription**.
2. For either final option, optionally choose an **Automatic summary** template.
3. Start recordings as usual. Each new recording runs the saved choice with the engines and connections set in Settings at that moment. If they are not ready, for example a summary with no model assigned, the recording still starts and a notice says processing is off for it.

Local Whisper stays on this device. An online speech connection receives audio. An online AI notes connection receives saved notes and final transcript text. Live plus final transcription uses separate requests and can incur separate charges. Starting a recording does not install a missing model.

Automatic processing allows up to 14,400 seconds (4 hours) of recording with local Whisper, 14,400 seconds of processing after stop, 256 MiB of uploaded audio, 1,000 requests, and 800,000 UTF-8 text bytes. Exceeding a limit does not stop recording or send more requests. Longer recordings are not processed automatically; use **Transcribe audio** on the Transcript tab. With an API speech connection the 256 MiB upload limit is reached after roughly 20 minutes, because the system track is 48 kHz stereo; longer recordings then stop with a budget error.

Live text is provisional. The latest 200 segments appear with track labels and incomplete-coverage warnings. Provisional text is excluded from search, summaries, and exports. If the live queue fills or a processing operation cannot run, capture continues and the preview can have gaps. Accepted audio captured before a pause may finish processing while paused. Paused audio is excluded by the implementation; hardware privacy remains unqualified.

Stop finalizes audio through the shared UI, tray, or shortcut path. Final transcription replaces the saved transcript atomically and removes provisional text only after success. A live-only session retains its provisional preview without creating a final transcript or summary.

An automatic summary waits for the capture meeting's saved notes. A failed save keeps your draft and displays **Save notes and continue processing**. Retry that action after resolving the save failure. Changes to notes or the transcript during summary generation prevent publication of a stale summary and preserve previous output.

Use **Cancel session processing** to stop further work without stopping capture or deleting output. Submitted content cannot be recalled, and a remote request may still be billed. **Retry processing** runs again for the existing stopped recording with the current settings, fresh limits and a new processing deadline. A previous request may already have been billed. Retry keeps a successfully completed transcript and can continue with the summary. It starts no recording. A stopped live-only preview cannot restart; use manual final transcription instead.

**Save and quit** first saves notes, then stops capture and interrupts unfinished processing. Restart displays interrupted work and makes no automatic retry. Recover incomplete recording files before retrying final processing. Native, hardware, and real-provider qualification remain open; see [workflow evidence](phase-3-workflow-verification.md).

## Transcribe and play audio

1. Open **Settings → Transcription** and choose **On this computer**.
2. Choose a speech model, language, and optional vocabulary hint. **Save transcription settings** appears once something differs from the saved values, and the section is marked as having unsaved changes until you save.
3. Click **Download speech engine and models** if the selected model is missing.
4. Stop the recording, open its **Transcript** tab, and click **Transcribe audio**.
5. Monitor progress or click **Cancel transcription**.

After a stopped recording has audio but no transcript, a **Next steps** card above the tabs says so and offers **Transcribe audio**, or **Open Settings** when the speech engine is not ready, and **Go to Summary** when the notes have text. The card is not repeated on the Transcript tab, which already has the same action. It stays hidden while automatic processing is running or waiting, and after a run that was cancelled, interrupted or needs attention, where the processing panel offers **Retry processing** instead. Dismissing a cancelled run's status with **Dismiss processing status** brings the card back, and it reappears after a failed run. It disappears once a transcript exists.

The engine and models download only on an explicit action. The selected model runs locally on finalized, nonempty tracks. Failed or cancelled runs keep the previous transcript. Changing models preserves existing downloads. See [downloaded components](dependencies.md#speech-engine-and-model-downloads) for versions and sizes.

**You** identifies the microphone track and **Others** identifies system audio. These labels do not identify individual people. Review names, numbers, and decisions before using a transcript.

Under the transcript's **Speaker names**, you can name the two labels for this meeting, for example "Rahul" for You. The transcript, export, and the text sent for summaries and questions then show "Rahul (You)". Others covers all system audio, so one name applies to everyone heard through it. Clearing a name restores the label. Renaming while a summary or question is running stops that result from being saved.

Click **Edit** beside a transcript segment to correct its text, then **Save**. Edited segments show "(edited)"; hover to see the original, or click **Revert** to restore it. Search, summaries, questions, and export use the corrected text, and export marks the transcript with `transcript_edited: true`. An open segment edit is kept while you switch meetings, and quitting warns before discarding it. Editing is unavailable while a transcription or summary you started from this screen runs. If the segment changed since you started, for example after re-transcription, the save is refused and your text stays open. Re-transcribing never discards your edits: the current transcript, including edits, is kept under **Earlier transcripts**, where you can read it but not restore it. Once a transcript exists, **Re-transcribe audio** first asks for confirmation. The question says the audio is uploaded and may be billed again when the speech connection is online, or that it runs on your computer and can take about as long as the recording. **Cancel** leaves the transcript as it is; the first transcription still runs on one click.

When the transcript or speaker names change after a summary was made, the Summary tab says the summary is out of date. Generate a new summary to include the changes; reverting the change clears the notice. Summaries made before this check existed are never flagged.

The Transcript tab provides one player for each playable track. Select a transcript timestamp to seek the corresponding track. Timestamp links inserted in notes can jump to audio; system-track seeking is approximate. Leaving the Transcript tab or opening settings pauses playback. Missing or incomplete files produce a visible error.

For API transcription, create a named connection under **Settings → Connections**, then choose **API connection** under **Settings → Transcription**, select the connection and a model for the **Speech API** task and save. Local loopback HTTP permits optional keys; remote APIs require HTTPS. The connection form checks the base URL as you type: it must be an https URL, or http only for localhost or 127.0.0.1, without credentials, query parameters or a fragment, and **Save connection** stays disabled until it passes. A remote connection can be saved without a key, but its models cannot be refreshed and it cannot be used until a key is saved; changing a saved connection's URL to a remote address needs a new key. **Save connection**, **Refresh models** and **Remove key** say why they are unavailable. Explicit refresh lists model IDs; custom IDs also work. Local engine downloads are not needed for cloud mode. Language/vocabulary settings remain available, but a provider may reject unsupported options visibly.

**Transcribe audio** in cloud mode uploads the finalized tracks in bounded chunks to the speech connection. Cancelling an active run prevents further chunks and preserves the old transcript, but audio already uploaded cannot be recalled and in-flight work may still be billed. JSON results without timing are explicitly untimed and grouped by track; their text supports search, summaries, and export, without timestamp links.

## Find and download local models

Open **Settings → Models**. The **Local model library** section is always visible there and scans common folders when you open the Models tab. Scan common folders or choose a folder explicitly. The scan reports examined folders and truncation; it reads file headers within limits of 4,096 entries, six levels, and 200 files. Discovery alone does not verify or activate a model. Import matching Whisper catalog candidates to verify their full hash and copy them into managed storage; the source remains untouched. Select and save the Whisper model separately.

Search Hugging Face explicitly to see up to 20 public speech-recognition results. Each result is labelled Whisper ggml, sherpa-onnx, or Other; Other results are not downloadable. For a Whisper ggml file, the download is verified against the Hub SHA-256 and saved in the speech models folder, then listed under Found speech models; choose it there with **Use this file in place** and save transcription settings. A sherpa-onnx folder downloads as a whole: every file is checked, and none are kept if any check fails. After the download, **Use this model** selects it; save transcription settings to use it. Downloaded folders then appear in the model list as "`<folder>` (downloaded sherpa-onnx model)". The layout is read from the file names: a transducer (encoder, decoder, joiner, tokens), a Moonshine folder (encoder, merged decoder, tokens), or a single `model*.onnx` with `tokens.txt`. A single-model folder is run as SenseVoice only; other single-file models are not checked and will fail in the engine. Transducer folders are run with the engine's own model-type detection. Running downloaded folders is not verified on real hardware. Only the shared engine and VAD are needed on top of a downloaded folder. Review the repository, revision, size, and license before downloading. Cancel stops transfer and prevents publication at the cancellation boundary. GGUF (LLM) files are not downloaded here; use a separately managed server. Private/gated repositories and split models are unsupported.

## Generate summaries and ask questions

Set up AI notes under **Settings → AI notes**: choose a connection and a chat model. A server on this computer needs no key; a remote one needs its key, which you add under **Settings → Connections**. Keys are saved in the OS keychain and not read back into the form. Model discovery is optional; the chosen model must support the chat endpoint. For background, see the [README setup](../README.md#set-up-optional-ai-summaries).

1. Open **Summary** and choose **General**, **Stand-up**, **One-to-one**, or one of your custom templates.
2. Click **Create summary**. Notes and transcript text, with your saved instructions and template, go to the AI notes connection.

When AI notes are not ready, **Create summary**, **Rewrite with AI…** and **Ask across meetings** stay disabled, show why, and offer **Open Settings** to the section that fixes it.

Add custom templates and saved summary instructions in **Settings → AI notes → Summary templates**. **Default summary template** there sets the template the Summary tab starts at. A custom template describes the sections you want. Saved instructions, such as "Write in British English", are sent with every manual and automatic summary request. Built-in rules still apply: the model must not invent facts or follow instructions found inside notes or transcripts. Automatic summaries offer only the three built-in templates, and include the saved instructions as they were when the recording started. Deleting a template keeps earlier summaries; their history shows "Deleted custom template".

Notes and transcript text leave the device when you click **Create summary**. Audio is never included. Longer transcripts can require several requests, including a final combination request. Inputs above the implementation's limits are refused rather than silently shortened. A failed request does not remove your notes or the last saved summary.

Use the version picker to read earlier summaries. **Copy summary** and **Copy action items** write to the system clipboard, where other apps may read the text. Markdown export always uses the latest saved summary, regardless of the viewed version.

### Source links

Summaries are asked to end key points, decisions, and action items with the `[m:ss]` time of a supporting transcript line; this instruction is shared by every template. Answers and imported tasks can carry the same times. A time becomes a link only when a stored timed segment starts in that second. Clicking it opens the Transcript tab, highlights the segment, and plays its track from there when the audio is available. Times with no matching segment show "(unverified)". When both tracks have a segment in the same second, both are highlighted and the first is played. A link proves only that the segment exists, not that it supports the claim, so read the segment. Untimed transcripts cannot be cited. Links always point to the current transcript, including after edits or re-transcription.

### Edit a summary

Click **Edit summary** to change the summary on screen. **Save edited summary** adds your text as a new version; the generated version and every earlier one stay in the version picker. Edited versions are labelled "edited by you", and Markdown export marks the summary with `summary_edited: true`. An unsaved edit stays open while you switch meetings. If you quit, OpenMeet warns you and asks before discarding it. If a newer summary arrived while you were editing, the first save is refused and your edit stays open, so neither version replaces the other silently. Review the newer version; saving again puts your edit on top of it. The version picker is locked while an edit is open, and deleting a meeting discards its unsaved edit. Generating a summary when the current version is your edit tells you that the new summary becomes current while your edit stays in history. Editing a summary sends nothing.

### Tasks

The **Tasks** list below the summary holds editable action items. Add a task by hand, or click **Add from summary** to copy the bullets in the shown summary version's "Action items" section. Importing skips bullets that an existing task of this meeting was imported from, from any summary version and even if you edited the task since. A deleted task can be imported again. If a bullet is too long or the meeting would exceed 200 tasks, nothing is added. Owners and due dates are never guessed; they stay "Unassigned" and empty until you set them. Tick a task to mark it done. Tasks are stored on this device and are included in every Markdown export as a "Tasks" checklist, whatever the summary option is set to.

**Ask this meeting** sends your question and that meeting's notes and transcript. The question and answer are saved with the meeting on this device (unencrypted) as a thread, and are not exported. Use **Ask a follow-up** to continue the thread: its latest 6 earlier questions and answers are sent too. Choose **New question** for a separate thread, pick earlier threads from **Question threads**, or **Delete thread** (after confirming) to remove one. A thread whose earlier answers are too long to send is refused; start a new question. If the meeting is too long for one request, OpenMeet picks the transcript lines that match your question's keywords (with a few lines of context around each) and your notes when they mention a keyword (only the matching paragraphs if the notes are long) on your device and sends only those; the answer notes that transcript excerpts were selected on this device by keyword match. The match is by words, not meaning, so rephrase with words used in the meeting if nothing is found. If nothing matches, nothing is sent: you see "No passages in the selected content matched your question. Nothing was sent." and no question is saved. The model is told to say "Insufficient evidence in the provided excerpts" when the excerpts do not support an answer. Check AI output before relying on it. Live summary quality and long-meeting behavior remain unqualified.

**Ask across meetings** (sidebar) answers one question over meetings you choose: tick up to 20 meetings, or pick a tag to select every meeting with it. Press **Ask** to send one request that includes the titles of the meetings whose notes and transcript text (with speaker names) are selected. The answer cites sources as `[M2 1:01]` (meeting 2 at that transcript time) or `[M2]` (notes or untimed text). A citation becomes a link only if that meeting was in the scope you reviewed and a timed transcript line starts at that second; the link opens the meeting and jumps to that line. Anything else shows "(unverified)". A link shows that a line exists at that time, not that it supports the claim, so check it. Each answer is saved on this device (unencrypted) with its question, model and the meetings it was asked about, in the order sent. Pick an earlier one from **Saved answers**; its links are checked against those meetings' current transcripts. **Delete answer** removes one after confirming. Deleting any of its meetings deletes the answer too. Saved answers are not exported and cannot be followed up. If the selected meetings are too long for one request, only transcript excerpts that match your question's keywords, plus each meeting's notes when they mention a keyword, are sent from them (the card says how many excerpts from how many meetings; every selected meeting's title and start date still go with them). If nothing matches, you see "No passages in the selected content matched your question. Nothing was sent." instead of a card.

### Recipes

Recipes are saved questions. Both question boxes show them as buttons: **Catch me up**, **Follow-up email**, **Action items**, **Decisions** and **Open questions** are built in, and you can add, edit or delete your own under **Settings → AI notes → Recipes**. Choosing a recipe only fills the question box; you can edit it, and nothing is sent until you press the question button.

### Rewrite selected notes

Select text in **My notes** and click **Rewrite with AI…**. The card says the selected text goes to your AI notes connection. Choose a preset (shorter, clearer, bullet points, fix spelling and grammar, more formal) or describe the change, then **Rewrite**. Only the selected characters and your request are sent, not the rest of your notes, the transcript or audio. The rewrite is shown beside the original and changes nothing until you click **Replace selection**. If your notes changed around the selection meanwhile, nothing is replaced; use **Copy** instead. The rewrite is not saved anywhere else.

## Export Markdown and transcripts

1. Click **Export Markdown**.
2. On the first export, a notice explains the choice, then the folder picker opens. Choose a destination folder. Cancel to leave the destination unset.
3. Read the notification for the saved file path.

Files are written under the destination's `Meetings` directory. **Settings → Export & storage → Markdown export** controls transcript inclusion, summary inclusion, and title or date-and-title filenames. The date prefix uses the stored UTC start date.

**Settings → Export & storage → Transcript files** can also write **.txt**, **.srt**, or **.vtt** beside the snapshot, with the same file name. The plain-text file keeps one line per segment with its start time and speaker. SRT and VTT need engine timestamps: if any segment is untimed while SRT or VTT is selected, the whole export is refused and nothing is written (any earlier snapshot is left alone); turn those formats off to export that meeting with the text file only. Line breaks inside a segment are joined into one line, and a meeting without a transcript gets no transcript files. The notification after an export says how many transcript files were written.

Exports contain source metadata, user notes, and the selected sections. They do not include audio. An identical existing snapshot is reused. A differing file produces a new snapshot instead of overwriting external edits. Renaming a meeting does not rename older exports. Exported files are not synchronized back into the database.

## Recover or delete data

An interrupted desktop recording may offer **Recover audio**. Recovery writes repaired WAV copies beside the original partial files, preserving the originals. It needs additional disk space and cannot recreate missing audio. Each attempt uses a fresh filename so a database failure can be retried without overwriting a retained copy. Failed attempts can therefore use additional space. A playable recovered WAV does not establish valid pause timing: local/cloud transcription and transcript timestamp seeking refuse missing or damaged timing indexes instead of guessing.

Open the meeting's **•••** menu for **Delete audio** or **Delete meeting**. Both require the meeting title as confirmation, except that an empty note (no text, transcript, summary, tasks, questions or audio) deletes after one confirmation. Both refuse an active recording. Delete audio retains notes, transcripts, and summaries. Delete meeting removes the local meeting and its associated data. Exported snapshots remain unchanged. There is no undo or secure erasure guarantee.

See [data retention and backups](privacy.md#retention-deletion-and-backups) before deleting or moving data, and [troubleshooting](../README.md#troubleshooting) for startup, saving, device, and export problems.
