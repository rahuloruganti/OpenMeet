# OpenMeet documentation

OpenMeet is a local-first meeting notetaker for Windows 11 and Apple silicon Macs: a Python backend, a `pywebview` window and a React interface, packaged as one executable or app bundle. This documentation describes the current source tree, not a qualified production release.

The product direction is an open-source, local-first meeting assistant in the style of Granola, driven by models you choose (local or your own API connections). It is an original implementation; it does not use Granola code, assets, prompts or services.

## Start here

| Goal                                            | Document                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| Build, launch and troubleshoot the app          | [README](../README.md)                                                                |
| Install, permissions and limits on a Mac        | [macOS](macos.md)                                                                     |
| See what is in this version                     | [Release notes](release-notes.md)                                                     |
| Understand data storage and network requests    | [Privacy](privacy.md)                                                                 |
| Find dependencies, versions, and their purposes | [Dependencies](dependencies.md)                                                       |
| Develop, test, and build the app                | [Development guide](development.md)                                                   |
| Review license obligations                      | [Third-party inventory](../THIRD_PARTY_LICENSES.md) and [project license](../LICENSE) |

Architecture and user guidance are rewritten from implemented behavior as the reset lands. Until then the source and tests are the reference.

## Platform boundary

Windows 11 x64 and Apple silicon macOS 14.2 or newer are the supported platforms. The Windows build is a single unsigned `OpenMeet.exe` with no installer and the data folder `%APPDATA%\OpenMeetPy`; the Mac build is an unsigned, ad-hoc signed `OpenMeet.app` in a DMG with the data folder `~/Library/Application Support/OpenMeetPy`. There is no Intel Mac build.

Real-hardware qualification is open. Audio capture (microphone and system loopback), local whisper.cpp and sherpa-onnx transcription, global shortcuts, opt-in meeting detection and the OS credential store are implemented but have been tested only with fakes and stubs. Builds, `just smoke` runs and mocked tests do not establish recording reliability, pause privacy, drift, transcript accuracy or live summary quality. Only a recorded real-device pass removes those labels.

The macOS port is further behind: its code is written and unit-tested with fakes on a Windows PC and has not run on a Mac at all. [macOS](macos.md) lists what the first real run must check.

Notes, audio, transcripts and exports are unencrypted. Audio and transcripts stay on this PC unless you assign a cloud connection and trigger an action, or choose automatic processing in Settings. API keys live only in the OS credential store, which is Windows Credential Manager or the Keychain. See [privacy](privacy.md).

## Evidence

For exact behavior, use the source and tests. For dependency versions, use [package.json](../package.json), [backend/pyproject.toml](../backend/pyproject.toml) and both lockfiles. `log.md` is a local, Git-ignored work history; it is not the current feature reference. Earlier product, status and planning documents were retired in the reset and remain in Git history only.
