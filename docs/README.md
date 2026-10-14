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

Windows x64 has capture and local transcription implementations. Apple Silicon macOS 14.2 or newer has a capture preview only. Full capture qualification remains open, and macOS permission denial has not been tested. Apple Silicon transcription requires a separately pinned local whisper.cpp build and remains unqualified. Builds and mocked tests do not establish recording reliability, transcript accuracy, or live summary quality.

Notes, audio, transcripts, and exports are unencrypted. Configured LLM summaries/questions send text only after confirmation. Local Whisper keeps audio on-device; optional cloud STT requires separate audio-upload confirmation. See [privacy](privacy.md).

## Plans and evidence

[The implementation checklist](implementation-checklist.md) separates missing features from qualification work and lists the suggested delivery order. [The Granola/Otter comparison](granola-otter-comparison.md) records its source and product evidence.

[Phase 2 settings verification](phase-2-settings-verification.md) records saved connections, model discovery/downloads, executed checks, and partial native qualification for issues #14–#18.

[The foundation qualification follow-up](foundation-qualification-follow-up.md) records the subsequent timing-write recovery fix and partial checks for #7–#13.

[Phase 1 foundation verification](phase-1-foundation-verification.md) records the current fixes, executed tests, and open hardware/provider/native UI gates for issues #7–#13.

[Implementation status](implementation-status.md) records implemented behavior, executed checks, and open gates. [The feature plan](feature-plan.md) tracks milestone acceptance criteria. [The phase plan](phase-1-implementation-plan.md) and [original development plan](../Open-source%20meeting%20notetaker%20development%20plan%20and%20tool%20inventory.md) contain proposed designs, including dependencies that were never added.

[The provider-settings plan](provider-settings-plan.md) records the design for personal API keys, local/cloud speech-model selection, and removal of shipped demo features. [Implementation status](implementation-status.md) records executed checks and remaining qualification gates.

For exact behavior, use the source and tests. For dependency versions, use [package.json](../package.json), [Cargo.toml](../src-tauri/Cargo.toml), and both lockfiles. [log.md](../log.md) preserves the work history; it is not the current feature reference.
