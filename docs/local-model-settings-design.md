# Settings and processing changes

## Requested behavior

- Separate **Cloud API** and **Local** settings tabs. Keep storage/export and keyboard settings accessible separately.
- Cloud API settings identify the provider, API base URL, and API key. After an explicit connection/model refresh, choose a model for speech transcription or text summaries/questions. Keep the two tools independently configurable.
- Local settings scan common model folders and a user-selected folder. Show discovered files, their formats, and whether OpenMeet can use them directly or needs an external local model server.
- Search Hugging Face and download selected public models explicitly. Display model size and license information. Preserve existing files and verify downloads before activation.
- Allow user-managed local OpenAI-compatible model servers, including loopback HTTP and optional keys. A downloaded text model does not start a server or imply inference readiness.
- During recording, process and display the transcript as audio arrives so the user can check it. Distinguish provisional text from the final saved transcript.
- After the meeting ends, automatically finish transcription and generate the summary. Retain previous successful output if either processing step fails.
- Obtain explicit session consent before cloud streaming or automatic cloud summaries begin. Show destination and scope before recording starts. Paused audio must never enter the streaming transcription queue or provider requests.

## Current implementation boundary

The existing primary checkout has generic provider configuration, user-entered keys, local final transcription, and explicit post-meeting cloud transcription and summary actions. Live transcription and automatic post-meeting summary processing are new requirements, not implemented behavior.

## Work checklist

- [x] Trace current settings, provider validation, model installation, and final processing.
- [x] Compare settings/local-library designs and choose one.
- [ ] Implement Cloud API and Local tabs, discovery, verified model import/download, and local-server connections.
- [ ] Verify the settings and model-library flow.
- [ ] Implement a bounded streaming transcription worker with pause-safe audio ownership and provisional/final text.
- [ ] Implement post-meeting finalization and automatic summary sequencing with session consent and failure recovery.
- [ ] Verify synthetic streaming, pause boundaries, cancellation/restart, and live UI behavior. Record separate hardware/provider gates honestly.

## Chosen settings design

Keep reusable saved API connections, with independent active speech and text assignments. Cloud and local tabs filter those saved connections; configuring one must not overwrite the other. The backend remains the only credential owner. A versioned migration must preserve the existing schema-v11 connection references, notes, transcript provenance, FTS, and selected Whisper model.

Use one local-model inventory for explicit scans and Hugging Face downloads. Reuse the single Whisper catalog and existing managed speech-model paths. Show scan limits and examined folders. Download public complete single-file models with a pinned revision, exact size, and SHA-256; keep original files and distinguish file discovery from a running model server. Private/gated repositories and split model sets need separate support before they can be offered as usable downloads.

Compared `.audit/settings-design-a.md` and `.audit/settings-design-b.md`; the review in `.audit/settings-design-judgment.md` selected B, with A's managed manifest, shared artifact-operation owner, and per-folder scan reporting. Implementation of this design is pending. The earlier per-role provider plan is superseded where it would overwrite a saved cloud/local setup.

## Overlooked work found during audit

- [ ] Bring the uncommitted generic-provider, demo-removal, standalone-build fix, and local-server work onto current main without losing its macOS capture changes, then deliver the requested changes through a PR when publication is authorized.
- [ ] Fix main's Windows Clippy failures in platform-specific permission helpers and the macOS probe-tone test helper. The latest macOS CI and dependency-hygiene jobs passed; neither proves hardware capture.
- [ ] Review the existing local cleanup commit that stops tracking four `.claude/worktrees` entries. It has not reached main. Preserve all checkouts and inspect their changes before any cleanup.
- [ ] Recheck the existing pause-shortcut registration warning and the hardware/provider qualification gates. They are not covered by passing synthetic tests.

See [unfinished-work audit](unfinished-work-audit.md) for evidence and scope.
