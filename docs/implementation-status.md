# Implementation status

Version 0.9.0 is a Python-only rebuild and is not released. This page says what exists in the code, what the automated tests actually exercise, and what is still unqualified. It is the honest boundary, not a feature wish list.

## Current boundary

The application is a FastAPI backend (`backend/openmeet_py`, split into `api`, `audio`, `domain`, `infra`, `platform` and `speech`) serving a React 19 UI from `backend/web` inside a pywebview window, packaged as one unsigned `OpenMeet.exe`. Storage is SQLite with 29 append-only migrations in `backend/openmeet_py/migrations`. Every command the UI calls is implemented; the placeholder 501 table is empty.

The qualification gap is unchanged and is the important part: **audio capture, local and cloud transcription, global shortcuts, meeting detection and Windows credential storage have been exercised only with fakes, stubs, synthetic audio and stub HTTP servers.** None of them has been qualified on real hardware in this build. [Phase 7](phase-7-hardware-qualification.md) is the checklist for closing that, and it has not been run.

## Status by area

| Area | Built | Exercised by | Qualification |
| --- | --- | --- | --- |
| Notes, rename, autosave (400 ms, serialized, revision checks), draft preservation | Yes | Backend tests with a temp data folder; frontend tests | Unqualified in the packaged window |
| Search: title filter, FTS5 over notes/transcript/summary, tags | Yes | Backend tests on real SQLite | Unqualified on a large library |
| Two-track capture (microphone + system loopback), WAV + timing index | Yes, WASAPI through PortAudio | Fake capture backend only | **Unqualified**: no real device run; distinct tracks, pause privacy, device loss, sleep/wake and the 60-minute drift gate are open |
| Pause/resume/stop, level meters, device refresh | Yes | Fake backend; unit tests reject samples from an earlier pause generation | **Unqualified** on real hardware |
| Interrupted-recording recovery | Yes | Backend tests with synthetic partial WAVs and timing | Unqualified on real interrupted captures |
| Local Whisper transcription | Yes, in-process through `pywhispercpp` | Synthetic audio; the `real_model` marker is excluded by default | **Unqualified**: no real model run recorded |
| sherpa-onnx transcription (Parakeet v3, Moonshine, SenseVoice, downloaded folders) | Yes | Stub/fixture tests; `real_model` excluded by default | **Unqualified**: no real sherpa transcription recorded |
| Cloud transcription (bounded WAV chunks, untimed results) | Yes | Stub HTTP servers | **Unqualified**: no live provider call |
| Model library: folder scan, hash import, Hugging Face search/download | Yes | Stub HTTP; no real Hub download | **Unqualified**: Hub search, large downloads and folder verification unproven live |
| Provider connections, masked key entry, Credential Manager storage | Yes, `keyring` → `WinVaultKeyring`, service `OpenMeetPy` | In-memory keyring backend in tests | **Unqualified**: no real key saved, replaced or removed on this machine |
| Summaries: three templates, custom templates, saved instructions, chunking, version history, edits | Yes | Stub HTTP servers | **Unqualified** against real models |
| Questions: per-meeting threads, follow-ups, library scope, saved answers, recipes, keyword retrieval | Yes | Stub HTTP servers; retrieval unit tests | **Unqualified** on long real meetings |
| Rewrite selected notes | Yes | Stub HTTP servers | Unqualified against real models |
| Tasks: manual entry, import from summary, export | Yes | Backend tests | Low risk; unqualified in the window |
| Markdown export with optional TXT/SRT/VTT, non-overwriting snapshots | Yes | Backend tests with temp folders | Unqualified against a real export folder |
| First-run setup and local server detection | Yes | Stub HTTP on loopback | **Unqualified** against real local servers |
| Automatic processing default (live/final/summary) and retry | Yes | Fake capture + stub HTTP, stepped by tests | **Unqualified** end to end |
| Global shortcuts (pause `Ctrl+Shift+F9`, stop `Ctrl+Shift+F10`) | Yes, `RegisterHotKey` | Fake Win32 message pump | **Unqualified**: registration on a real desktop, chord conflicts and behaviour while another app is focused are open |
| Meeting detection (Windows microphone privacy store, 3 s poll, two-poll debounce) | Yes | Fake consent registry | **Unqualified** on a real call |
| Import of an earlier build's data folder (`--import-from`) | Yes: `backend/openmeet_py/infra/importer.py`, invoked from `app.py` | Backend tests with synthetic data; one run from a copy of a real earlier folder into a scratch destination (16 meetings, 46 audio files, schema 28 to 29) | **Not run into the real `%APPDATA%\OpenMeetPy`**; the source is read-only, refusals, secret blanking and rollback are tested |
| Local server boundary: loopback bind, per-run token, `Host` check, `/files` scoping | Yes | Backend tests, including token and `Host` refusal and the `/files` database refusal | Needs an independent end-to-end boundary review; not an audit |
| One-file `OpenMeet.exe` build (`packaging/build.ps1`) | Yes | Build script only | Not installed or launched on a clean machine |

## What a passing test run means

The backend suite runs with `pytest` from `backend/`, with `hardware` and `real_model` tests excluded by default:

```
backend\.venv\Scripts\python.exe -m pytest
```

Those tests use a fake capture backend, a fake Win32 layer, an in-memory keyring, temporary data folders and stub HTTP servers. They prove the code paths, the validation, the limits and the error handling; they prove nothing about a real microphone, a real model, a real provider, a real shortcut or the Credential Manager. A green run, a `--smoke` start, or a browser check is not a hardware result.

## Known limits carried into this build

- Audio and exports are unencrypted, and deletion is not secure erasure.
- Live and final automatic processing can send the same audio twice, and the 256 MiB upload limit is reached after roughly 20 minutes with the 48 kHz stereo system track.
- Untimed cloud results cannot produce timestamp links.
- Keyword retrieval for long meetings is lexical, not semantic.
- No auto-updater, no installer, no signing, no tray icon, no macOS support.

## Supporting records

[Phase 7 hardware qualification](phase-7-hardware-qualification.md) is the checklist to run before any claim of reliability. [Dependencies](dependencies.md) lists what ships. [Privacy](privacy.md) lists what leaves the device. [v1 release plan](v1-release-plan.md) lists what remains before 1.0.
