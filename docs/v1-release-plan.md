# v1 release plan

Version 0.9.0 is a Python-only rebuild that has not been released and is not qualified on real hardware. This page records the decisions already taken and what still stands between this build and a 1.0 release.

## Decided

| Decision | Value |
| --- | --- |
| Platform | Windows 11 x64 only. No macOS build, and no promise of one. |
| Packaging | One unsigned file, `OpenMeet.exe`, built by `packaging/build.ps1` into `packaging/dist/`. No installer. |
| Signing and installer | Deferred. Revisit only if download numbers justify the certificate and the installer maintenance. Until then the release notes must say the file is unsigned and Windows SmartScreen will warn. |
| Updater | None in 1.0. An updater is a 1.1 candidate; there is no network check at startup. |
| Data location | `%APPDATA%\OpenMeetPy\`. Data from the earlier build is brought across with `OpenMeet.exe --import-from <folder>`, never by pointing this build at that folder. |
| Telemetry | None, and none planned. |
| Request handling | Hard limits stay (14,400 s recording, 14,400 s post-stop, 256 MiB upload, 1,000 requests, 800,000 text bytes). No request-count or budget display, and no per-request confirmation cards. |
| Consent | The app enforces no consent checkbox. The user guide and release notes state that recording-consent law is the user's responsibility. |
| Local speech | whisper.cpp and sherpa-onnx run in-process; local Whisper is the default. Model downloads happen only on an explicit Settings action, verified against pinned sizes and SHA-256. |
| Networking | Loopback-only server with a per-run token, and outbound requests only to hosts you configure or to the pinned model hosts. |

## Required before 1.0

1. **Phase 7 hardware qualification, run by the owner on this PC.** Nothing else can substitute for it. [The checklist](phase-7-hardware-qualification.md) covers the gates that decide whether the app can be called reliable:
   - two distinct, audible tracks from a real meeting and a real meeting app;
   - no audio from paused intervals, including queued buffers and resume boundaries;
   - device loss, device switch, sleep/wake, disk full and recovery behavior;
   - a 60-minute two-track run with markers at both ends and relative drift under 100 ms;
   - a real local transcription (Whisper and sherpa-onnx), including progress, cancel and silence;
   - global pause and stop shortcuts on a real desktop, including a chord already owned by another app;
   - meeting detection during a real call;
   - saving, replacing and removing a real API key in the Credential Manager, including a failure case;
   - deletion, recovery and export against real files.
2. **At least one live provider round trip** for cloud transcription and one for AI notes, with content you are allowed to send, recording the request sizes and the result.
3. **Import verification.** Run `--import-from` against the real earlier data folder in place of the copy already exercised, and confirm the meeting, transcript, summary and task counts match. The importer is implemented and was run once from a copy of that folder (16 meetings, 46 audio files, schema 28 to 29) into a scratch destination, not into `%APPDATA%\OpenMeetPy`, and its path from the installed exe is unverified.
4. **Clean-machine check.** Copy `OpenMeet.exe` to a Windows 11 machine without the dev environment: SmartScreen warning, first-run setup, device list, one short recording, one export.
5. **License notices.** Finish [THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md): confirm the ONNX Runtime notice bundled inside `sherpa-onnx-core`, the PortAudio license inside `PyAudioWPatch`, the whisper.cpp version inside `pywhispercpp`, and the model licenses (Parakeet v3 is CC-BY-4.0 and needs attribution; SenseVoice is not confirmed).
6. **Release mechanics.** Version bump, release notes, SHA-256 of the exe published with it, and a tag. Repository visibility is the owner's decision, not an agent's.

## Order

1. Phase 7 sections A–H (capture, pause, failure, sleep, drift).
2. Phase 7 sections I–J (real models, automatic processing and summaries).
3. Phase 7 sections K–N (shortcuts, detection, credentials, data safety).
4. Import verification, then the clean-machine check, on the same exe that would ship.
5. License notices and release notes, then build and publish.

Each step is a separate commit. A failing gate is recorded as unqualified in the release notes rather than papered over.

## Deliberately not in 1.0

- Installer, code signing, notarization, auto-updater, tray icon.
- macOS or Linux builds.
- Encryption at rest, compression of audio, secure erasure.
- Diarization, meeting bots, calendar or SharePoint integration.
- Managed local LLM downloads (GGUF is not downloaded by the app).
- Remote or multi-user access: the server stays bound to loopback.

## Definition of done

1.0 means: the Phase 7 checklist is complete with every gate either passing or explicitly recorded as unqualified in the release notes; the documented loop of record → transcribe → summarize → export works on a clean Windows 11 machine with an exe that a stranger can download and run; the license notices are complete; and no page in `docs/` claims a qualification that has not been run.
