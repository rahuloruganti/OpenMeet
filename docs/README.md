# OpenMeet documentation

OpenMeet is a desktop meeting notetaker built with Tauri, Rust, React, and TypeScript. This documentation describes the current source tree, not a qualified production release.

## Start here

| Goal                                            | Document                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| Install and launch the app                      | [Installation and troubleshooting](../README.md#install-and-run-on-windows)           |
| Take notes, transcribe, summarize, and export   | [User guide](user-guide.md)                                                           |
| Understand which features are ready             | [Implementation status](implementation-status.md)                                     |
| Understand data storage and network requests    | [Privacy](privacy.md)                                                                 |
| Prepare for a recording                         | [Recording consent](consent.md)                                                       |
| Understand the code and data flow               | [Architecture](architecture.md)                                                       |
| Find dependencies, versions, and their purposes | [Dependencies](dependencies.md)                                                       |
| Develop, test, and build the app                | [Development guide](development.md)                                                   |
| Review license obligations                      | [Third-party inventory](../THIRD_PARTY_LICENSES.md) and [project license](../LICENSE) |

## Platform boundary

Windows x64 has capture and local transcription implementations. Apple Silicon macOS 14.2 or newer has a capture preview only. Full capture qualification remains open, and macOS permission denial has not been tested. macOS transcription is unavailable. Builds and mocked tests do not establish recording reliability, transcript accuracy, or live summary quality.

Notes, audio, transcripts, and exports are unencrypted. Merge summaries and questions send meeting text only after confirmation. Audio stays on the device. See [privacy](privacy.md) for the limits of these statements.

## Plans and evidence

[Implementation status](implementation-status.md) records implemented behavior, executed checks, and open gates. [The feature plan](feature-plan.md) tracks milestone acceptance criteria. [The phase plan](phase-1-implementation-plan.md) and [original development plan](../Open-source%20meeting%20notetaker%20development%20plan%20and%20tool%20inventory.md) contain proposed designs, including dependencies that were never added.

For exact behavior, use the source and tests. For dependency versions, use [package.json](../package.json), [Cargo.toml](../src-tauri/Cargo.toml), and both lockfiles. [log.md](../log.md) preserves the work history; it is not the current feature reference.
