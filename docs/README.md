# OpenMeet documentation

OpenMeet is a desktop meeting notetaker built with Tauri, Rust, React, and TypeScript. This documentation describes the current source tree, not a qualified production release.

## Start here

| Goal                                            | Document                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| Install and launch the app                      | [Installation and troubleshooting](../README.md#install-and-run-on-windows)           |
| Take notes, transcribe, summarize, and export   | [User guide](user-guide.md)                                                           |
| Understand which features are ready             | [Implementation status](implementation-status.md)                                     |
| See the agreed v1 release scope and order       | [v1 release plan](v1-release-plan.md)                                                 |
| Understand data storage and network requests    | [Privacy](privacy.md)                                                                 |
| Prepare for a recording                         | [Privacy](privacy.md) and [user guide](user-guide.md)                                 |
| See what shipped in 0.9.0                       | [Release notes 0.9.0](release-notes-0.9.0.md)                                         |
| Understand the code and data flow               | [Architecture](architecture.md)                                                       |
| Find dependencies, versions, and their purposes | [Dependencies](dependencies.md)                                                       |
| Develop, test, and build the app                | [Development guide](development.md)                                                   |
| Review license obligations                      | [Third-party inventory](../THIRD_PARTY_LICENSES.md) and [project license](../LICENSE) |

## Platform boundary

Windows x64 has capture and local transcription implementations. Apple Silicon macOS 14.2 or newer has a capture preview only. Full capture qualification remains open, and macOS permission denial has not been tested. Apple Silicon transcription requires a separately pinned local whisper.cpp build and remains unqualified. Builds and mocked tests do not establish recording reliability, transcript accuracy, or live summary quality.

Notes, audio, transcripts, and exports are unencrypted. Configured LLM summaries, questions, and rewrites send text when you trigger them or when automatic processing is chosen in Settings. Local Whisper keeps audio on-device; cloud STT uploads audio on the same triggers and is labelled Leaves this device. Recording-only is the default. See [privacy](privacy.md).

## Plans and evidence

[The v1 release plan](v1-release-plan.md) is the agreed public Windows release scope and order; it supersedes the earlier planning documents, which were removed.

[The Phase 1 implementation plan](phase-1-implementation-plan.md) holds the original Phase 1 designs and acceptance checklist. [The Phase 3 execution plan](phase-3-execution-plan.md) sequences live transcription, final processing, recovery, and qualification for issues #19 through #25.

[Phase 3 workflow verification](phase-3-workflow-verification.md) describes the integrated automatic workflow and its open qualification gates.

[Phase 2 settings verification](phase-2-settings-verification.md) records saved connections, model discovery/downloads, executed checks, and partial native qualification for issues #14–#18.

[The foundation qualification follow-up](foundation-qualification-follow-up.md) records the subsequent timing-write recovery fix and partial checks for #7–#13.

[Phase 1 foundation verification](phase-1-foundation-verification.md) records the current fixes, executed tests, and open hardware/provider/native UI gates for issues #7–#13.

[Phase 7 hardware qualification](phase-7-hardware-qualification.md) is the owner's step-by-step checklist for the Python build on real hardware (devices, pause privacy, failures, sleep, the 60-minute drift run, real models, shortcuts, detection and credentials). Only a PASS table removes the "unqualified" labels; the Rust app is out of its scope.

[Implementation status](implementation-status.md) records implemented behavior, executed checks, and open gates. The [original development plan](../Open-source%20meeting%20notetaker%20development%20plan%20and%20tool%20inventory.md) contains proposed designs, including dependencies that were never added.

For exact behavior, use the source and tests. For dependency versions, use [package.json](../package.json), [Cargo.toml](../src-tauri/Cargo.toml), and both lockfiles. [log.md](../log.md) preserves the work history; it is not the current feature reference.
