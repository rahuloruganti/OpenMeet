# OpenMeet documentation

OpenMeet is a local-first Windows meeting notetaker: a Python backend, a `pywebview` window and a React interface, packaged as one executable. This documentation describes the current source tree, not a qualified production release.

The product direction is an open-source, local-first meeting assistant in the style of Granola, driven by models you choose (local or your own API connections). It is an original implementation; it does not use Granola code, assets, prompts or services.

## Start here

| Goal | Document |
| --- | --- |
| Build, launch and troubleshoot the app | [README](../README.md) |
| See what is in this version | [Release notes](release-notes.md) |
| Understand data storage and network requests | [Privacy](privacy.md) |
| Find dependencies, versions, and their purposes | [Dependencies](dependencies.md) |
| Develop, test, and build the app | [Development guide](development.md) |
| Review license obligations | [Third-party inventory](../THIRD_PARTY_LICENSES.md) and [project license](../LICENSE) |

Architecture and user guidance are rewritten from implemented behavior as the reset lands. Until then the source and tests are the reference.

## Platform boundary

Windows 11 is the only supported platform. The build is a single unsigned `OpenMeet.exe` with no installer, and its data folder is `%APPDATA%\OpenMeetPy`.

Real-hardware qualification is open. Audio capture (microphone and system loopback), local whisper.cpp and sherpa-onnx transcription, global shortcuts, opt-in meeting detection and the Windows credential store are implemented but have been tested only with fakes and stubs. Builds, `just smoke` runs and mocked tests do not establish recording reliability, pause privacy, drift, transcript accuracy or live summary quality. Only a recorded real-device pass removes those labels.

Notes, audio, transcripts and exports are unencrypted. Audio and transcripts stay on this PC unless you assign a cloud connection and trigger an action, or choose automatic processing in Settings. API keys live only in Windows Credential Manager. See [privacy](privacy.md).

## Evidence

For exact behavior, use the source and tests. For dependency versions, use [package.json](../package.json), [backend/pyproject.toml](../backend/pyproject.toml) and both lockfiles. `log.md` is a local, Git-ignored work history; it is not the current feature reference. Earlier product, status and planning documents were retired in the reset and remain in Git history only.
