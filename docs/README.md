# OpenMeet documentation

OpenMeet is a local-first Windows meeting notetaker: a Python backend, a `pywebview` window and a React interface, packaged as one executable. This documentation describes the current source tree, not a qualified production release.

## Start here

| Goal | Document |
| --- | --- |
| Build, launch and troubleshoot the app | [README](../README.md) |
| Take notes, transcribe, summarize, and export | [User guide](user-guide.md) |
| Understand which features are ready | [Implementation status](implementation-status.md) |
| See the agreed v1 release scope and order | [v1 release plan](v1-release-plan.md) |
| Understand data storage and network requests | [Privacy](privacy.md) |
| Prepare for a recording | [Privacy](privacy.md) and [user guide](user-guide.md) |
| See what shipped in 0.9.0 | [Release notes 0.9.0](release-notes-0.9.0.md) |
| Understand the code and data flow | [Architecture](architecture.md) |
| Find dependencies, versions, and their purposes | [Dependencies](dependencies.md) |
| Develop, test, and build the app | [Development guide](development.md) |
| Review license obligations | [Third-party inventory](../THIRD_PARTY_LICENSES.md) and [project license](../LICENSE) |

## Platform boundary

Windows 11 is the only supported platform. The build is a single unsigned `OpenMeet.exe` with no installer, and its data folder is `%APPDATA%\OpenMeetPy`.

Real-hardware qualification is open. Audio capture (microphone and system loopback), local whisper.cpp and sherpa-onnx transcription, global shortcuts, opt-in meeting detection and the Windows credential store are implemented but have been tested only with fakes and stubs. Builds, `just smoke` runs and mocked tests do not establish recording reliability, pause privacy, drift, transcript accuracy or live summary quality. [Phase 7 hardware qualification](phase-7-hardware-qualification.md) is the checklist that removes those labels, and only a recorded PASS does.

Notes, audio, transcripts and exports are unencrypted. Audio and transcripts stay on this PC unless you assign a cloud connection and trigger an action, or choose automatic processing in Settings. API keys live only in Windows Credential Manager. See [privacy](privacy.md).

## Plans and evidence

[Rebuild status](rebuild-status.md) describes the Python rebuild: what replaced what, which stages are complete, and the limits of the ported behavior.

[The v1 release plan](v1-release-plan.md) is the agreed public Windows release scope and order; it supersedes the retired planning documents.

[Implementation status](implementation-status.md) records implemented behavior and open gates. [Phase 7 hardware qualification](phase-7-hardware-qualification.md) is the owner's step-by-step real-hardware checklist for this build.

For exact behavior, use the source and tests. For dependency versions, use [package.json](../package.json), [backend/pyproject.toml](../backend/pyproject.toml) and both lockfiles. [log.md](../log.md) preserves the work history; it is not the current feature reference.

`docs/archive/` holds retired records from the earlier implementation, including its verification notes. They are historical evidence only: they are not a source of truth for the current app, and their commands and file paths no longer apply.

