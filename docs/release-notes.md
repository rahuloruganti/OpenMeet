# OpenMeet 0.9.0

A local-first meeting notetaker for Windows 11. One file, no installer.

## What you get

- **Record** your microphone and system audio as two separate tracks. Pause stops audio from being saved.
- **Transcribe on this PC** with whisper.cpp or sherpa-onnx, or use an online speech API. A live transcript shows while you record.
- **Transcript tab:** speaker turns, a player that plays both tracks together, click-to-edit text, find, copy, speaker names, re-transcribe and version history.
- **AI notes:** summaries from templates, enhanced notes that link back to the transcript, tasks and rewrite selection. Use any OpenAI-compatible connection, or run a model on this PC with **Local AI**.
- **Organise:** folders, tags, search, a command palette (Ctrl+K) and a calendar feed for meeting context.
- **Export** to Markdown. Your own notes and external edits are never overwritten.
- **Import** an earlier data folder on first run. The importer only reads it.

## What changed since the earlier build

- New Transcript tab with a player and in-place editing.
- Local AI with Hugging Face model search and a one-click engine install.
- One-page Settings with search.
- Warm light and dark themes that follow Windows.
- The Ask feature is removed. Old Ask data stays in the database but nothing reads it.

## Before you install

- **Not tested on real hardware.** Audio capture, local transcription, shortcuts and meeting detection have only run with fakes and stubs. Do not rely on it for a meeting you cannot repeat.
- **Unsigned.** SmartScreen will warn. Click **More info**, then **Run anyway**.
- **No updater.** To update, close the app and replace the `.exe`. Your data stays in `%APPDATA%\OpenMeetPy`.
- **Unencrypted data.** Files are plain on disk. There is no telemetry. API keys live in Windows Credential Manager.
- You are responsible for recording-consent laws that apply to your meetings.

## Download

`OpenMeet.exe` is attached to the GitHub release `v0.9.0`.

SHA256: `7beee173b624013076f035deecda7793959c423cb0490b09d042f2e388d4a246`

Check it in PowerShell with `Get-FileHash .\OpenMeet.exe`.
