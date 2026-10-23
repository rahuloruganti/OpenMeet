# OpenMeet 0.9.0 (Windows 11)

A preview of the rebuilt, Python-only OpenMeet. It is not a stability claim: recording, transcription, shortcuts, meeting detection and credential storage have been exercised with fakes, stubs and synthetic audio, not on real hardware. Read **What is not yet qualified** before using it for a meeting that matters.

## What this build is

The application has been rebuilt without its previous native shell. Everything now runs on Python 3.13 and ships as a single windowed `OpenMeet.exe`:

- a FastAPI backend served on `127.0.0.1` with a per-run token, inside a pywebview (WebView2) window;
- a React 19 + TypeScript UI built by Vite and bundled into the executable;
- SQLite storage with 29 append-only migrations;
- microphone and system-audio capture through WASAPI (PortAudio via `PyAudioWPatch`);
- local transcription in-process through whisper.cpp (`pywhispercpp`) or sherpa-onnx, plus optional OpenAI-compatible cloud speech;
- API keys in the Windows Credential Manager through `keyring`.

The previous implementation is kept for reference at the tag `rust-final`. It is not built, shipped or supported.

## Install

- `OpenMeet.exe` is one file and needs no installer and no admin rights.
- It is unsigned, so Windows SmartScreen warns the first time: choose **More info → Run anyway**.
- Windows 11 includes the WebView2 runtime the window needs.
- Data goes to `%APPDATA%\OpenMeetPy\`, never next to the executable.
- To remove it, delete the exe, then delete that data folder. Deletion is not secure erasure.

There is no auto-updater in this version; check for a new file yourself.

## Bring your existing data across

The earlier build kept its data elsewhere. Import it once:

```
OpenMeet.exe --import-from "C:\path\to\the\earlier\data\folder"
```

The source folder is read-only, the import refuses a destination that already holds data, and API keys are not copied — re-enter them under **Settings → Connections**. Speech models are not copied either. The importer has been run once against a copy of a real earlier folder into a scratch destination, not into `%APPDATA%\OpenMeetPy`; check the meeting count and keep the source until you have.

## What it does

- Notes in Markdown with 400 ms autosave, revision checks, tags, and full-text search over notes, transcripts and summaries.
- Records the microphone and all app audio, including OpenMeet's own playback, as two tracks, on this device, with pause/resume and recovery for interrupted recordings.
- Transcribes locally with Whisper (`ggml` models, verified downloads) or sherpa-onnx (Parakeet TDT 0.6B v3, Moonshine base, SenseVoice small, plus downloaded folders), or with a cloud speech connection you configure.
- Summaries from three built-in templates or your own, with saved instructions, version history and editing; per-meeting question threads; questions across up to 20 meetings; note rewriting; editable tasks; recipes.
- Exports Markdown snapshots with optional TXT/SRT/VTT transcripts, and never overwrites an existing different snapshot.
- First-run setup: pick a local model or an API, find local AI servers on loopback, choose devices and the automatic-processing default.
- Meeting detection (opt-in) that only offers to start recording, reads app names and never audio, and never starts capture itself.
- Default shortcuts for new installs: pause `Ctrl+Shift+F9`, stop `Ctrl+Shift+F10`.
- No telemetry, no account, no cloud dependency unless you add one.

## What is not yet qualified

Keep the warnings in view:

- **Capture on real hardware.** Distinct audible tracks, exclusion of paused audio, device loss or switch, sleep/wake, disk-full behavior and a 60-minute drift run are unchecked. The [Phase 7 checklist](phase-7-hardware-qualification.md) is what closes this.
- **Real transcription.** No real Whisper or sherpa-onnx run has been recorded in this build; the test suite uses synthetic audio and excludes `real_model` tests by default.
- **Real providers.** Cloud transcription, summaries, questions and rewrites have only been exercised against stub HTTP servers.
- **Shortcuts, detection, credentials.** `RegisterHotKey` behavior on a real desktop, meeting detection during a real call, and storing, replacing and removing a real key in the Credential Manager are untested.
- **Import and packaging.** The one-file exe has not been installed or launched on a clean machine, and `--import-from` has not been run into the real `%APPDATA%\OpenMeetPy` folder (one run went into a scratch destination from a copy of a real earlier folder).
- **The local server boundary** (loopback bind, `Host` check, per-run token, `/files` scoping) has backend tests, including token and `Host` refusal on `/api/invoke` and the `/files` database refusal, but no independent end-to-end review. It is not an audit.

## Known limits

- You are responsible for recording-consent law where you are. The app does not check consent.
- Data, recordings and exports are unencrypted, and deletion leaves copies to OS backups and sync tools.
- With a cloud speech connection, the 256 MiB upload limit is reached after roughly 20 minutes because the system track is 48 kHz stereo.
- Live and final automatic processing can send the same audio twice and be billed twice.
- Long-meeting questions use keyword retrieval (lexical, not semantic) when the content does not fit one request; when nothing matches, nothing is sent.
- Untimed cloud results cannot produce timestamp links.
- Windows 11 only. No installer, no signing, no updater, no tray icon, no macOS build.
