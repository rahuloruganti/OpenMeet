> **Archived: describes the retired Rust/Tauri app (git tag rust-final). Not current. Do not use as a reference for the Python build.**

# Phase 2 settings and model-library verification

## Implemented scope

This change implements the settings/model-library work for issues #14–#18. It does not implement live transcription or automatic post-meeting processing. The linked issues remain open pending their remaining qualification gates.

- Cloud API, Local, and General settings tabs preserve connection drafts. Password inputs clear on save attempts, profile changes, tab changes, and unmount.
- Reusable saved connections supply independent summary/question and Speech API assignments. Model discovery is explicit and custom model IDs remain supported. Changing a shared profile updates the revisions of its assigned tasks; unrelated profiles leave those tasks unchanged.
- Schema 12 migrates existing per-role profiles and OS-keychain account references without reading keys. Assignment counters remain monotonic through unassignment and reassignment. Assigned profiles cannot be deleted. Populated upgrade tests preserve notes, transcripts, FTS entries, and foreign keys.
- Local loopback HTTP servers allow optional keys. Remote destinations require HTTPS and a destination-bound key. Rust remains the credential and processing owner. Existing per-action content/audio consent remains required.
- Local scans inspect managed and common cache folders or a user-selected folder. Bounds are 4,096 directory entries, six levels, and 200 discovered model files; folder status and truncation are visible. Directory links are not traversed. File links must resolve inside the scanned root. Four-byte headers identify GGUF/GGML; discovery is not verification or inference readiness.
- Import copies matching pinned Whisper catalog files into managed storage after full size/hash verification, preserving the source. Users separately select and save the model.
- Explicit public Hugging Face search returns up to 20 repositories. Downloads support verified catalog Whisper files and complete single-file GGUF models with pinned revisions, sizes, and SHA-256. Private/gated repositories, missing hashes, and split models are excluded. GGUF files require an external compatible server.
- Downloads revalidate metadata before transfer, restrict HTTPS redirects to approved Hugging Face hosts, stream through temporary files, and publish without overwriting. Provenance records repository, revision, filename, size, hash, and license. Artifact operations share cancellation and publication guards. A stalled blocking operation times out after 15 seconds; the timeout renews per read, so it is not a total download deadline.

## Executed checks

The full Windows `just check` passed with 103 frontend tests, 87 Rust tests, and two ignored native tests, including typecheck, lint, formatting, frontend build, Rust formatting, Clippy with warnings denied, Rust tests, and native debug build. Subsequent frontend regression additions and layout changes passed typecheck, lint, formatting, and all 104 tests. The normal-identifier standalone debug build also passed through the Tauri CLI after these changes.

Synthetic tests cover saved-profile/assignment persistence and stale writes, destination-bound credentials, migration rollback and populated upgrades, draft preservation, password clearing, keyboard tabs, model selection, scan bounds, verified import, checksum mismatch, cancellation, existing-file preservation, pinned metadata revalidation, provenance, and stalled-body cancellation. Synthetic HTTP tests send no authorization header to model-library endpoints. The path-link refusal test is Unix-only and was not executed on Windows. Later synthetic additions cover refused connections and HTTP 500 during provider model discovery, and an unreachable model service plus a download whose size differs from pinned metadata; none publishes a file or exposes credentials. All 127 Rust tests passed with two native tests ignored.

A single explicit GET of public `ggerganov/whisper.cpp` repository metadata confirmed the expected revision/LFS/license wire shape. No real model payload was downloaded. See the official [Hub API documentation](https://huggingface.co/docs/hub/api) and [Hub client API reference](https://huggingface.co/docs/huggingface_hub/package_reference/hf_api).

Local audit artifacts remain outside this worktree under the original checkout's `.audit/`: `phase-2-full-checks.log`, `phase-2-frontend-final-3.log`, `phase-2-native-build.log`, `phase-2-native-verification.json`, and `phase-2-normal-build.log`.

## Native qualification and remaining gates

A separately identified OpenMeet Settings Qualification build used an isolated profile. Read-only inspection confirmed schema 12 and zero meetings, notes, recordings, or saved connections. Native checks confirmed all settings tabs, preservation of a fictional unsaved connection name across tabs, keyboard navigation, and opening the Windows folder picker. A synthetic GGUF fixture was prepared, but the Windows helper rejected the final folder selection with unavailable coordinate geometry. End-to-end native folder scanning therefore remains unverified. A modifier-key navigation correction made afterward has frontend regression coverage but was not repeated natively.

The user closed the qualification window through Save and quit. Its isolated database and synthetic fixture were retained. The normal build is restored without launching or migrating the primary user's app profile.

No recording, real credential entry, live model-server inference, provider-content request, or real model payload download occurred. Native key save/replace/remove, full download/import/cancel interaction, Windows link/junction behavior, real provider compatibility, macOS native settings, and complete hardware qualification remain open. Issues are not closed by passing synthetic tests. Local Whisper remains the default; file discovery does not activate a model or launch a server.
