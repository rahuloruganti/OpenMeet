# Phase 3 consent foundation

> Historical report for the schema-v13 consent foundation. The integrated schema-v14 runtime and UI supersede its unfinished-work statements. See [workflow implementation and qualification](phase-3-workflow-verification.md).

## Implemented boundary

This increment starts issues #19 and #24 without enabling live or automatic processing. It builds on commit `3cb42ef` from merged PR #49 and was developed on `codex/phase-three-session-consent`.

`prepare_session_processing` creates one in-memory review, superseding an older review even if preparation fails. The request supports live-only transcription or final transcription with optional live processing and a summary template. Local Whisper remains the default. API destinations come from the existing independent speech and text assignments. Review preparation reads settings but does not access devices, inspect credentials, install models, or contact any server. A review does not prove engine/model readiness or provider compatibility.

The review returns destinations/models, both track kinds, language, and proposed limits of one hour, 256 MiB uploaded audio, 1,000 requests, and 800,000 text characters. These limits are consent metadata for the future worker. Request accounting and dispatch enforcement do not yet exist. They must be implemented before session consent can authorize any request. Future-content disclosure and selectable controls are also not yet in the UI.

The existing recording command accepts an optional processing confirmation. A matching unexpired review is validated before native device access and again before database publication. Its consent record is inserted in the same transaction as the new meeting/tracks. Participant consent is still required independently. The current UI supplies no processing confirmation and continues to record without automation.

Reviews expire after five minutes. A stored configuration revision prevents reuse after speech/provider changes, including edit-and-revert and key replacement. The current policy conservatively invalidates plans when any saved connection is edited or deleted, even if that connection was not selected. Shortcut and export changes leave reviews valid. No secrets, vocabulary prompt, notes, or transcripts enter the plan JSON.

Attached records expose revisioned snapshots and idempotent cancellation. Cancelling consent does not stop recording or change saved content. A snapshot invalidates prepared consent after its authorization deadline or if the clock moves before its recorded start. Startup marks prepared records interrupted once and restores no in-memory reviews. No automatic network or inference work runs on startup. Existing manual processing still uses its current busy/cancellation guards.

## Verification

The backend tests use temporary SQLite databases and fictional records. None starts native audio capture or calls a live provider. They cover:

- Independent local/cloud destinations, summary templates, serialized scope, and absence of credential references.
- Expired, superseded, stale, and denied reviews, with rejection before device access.
- Unknown request fields, failed review preparation, and consent isolation from participant permission.
- Transaction rollback, duplicate consent publication, and refusal to attach consent to existing note records.
- Revision conflicts, repeated cancellation, expiry, and unchanged saved notes.
- Provider key-reference replacement and speech edit-and-revert invalidation.
- Restart interruption without replay, preserving notes and stable revisions across repeated opens.
- Populated schema-v12 upgrade, preserving notes, transcript text, summary, search results, provider references, and foreign keys.

An older v11 migration test failed because it built the current schema and partially downgraded it. It now creates a genuine v11 fixture by executing historical migrations. The new v12 test reuses that fixture and applies migration 12 before exercising the current upgrader.

The full local `just check` passed with 106 frontend tests and 109 Rust tests. Two native tests remained ignored. Typecheck, lint, formatting, frontend build, Rust formatting, Clippy with warnings denied, and native debug build passed. The log is retained locally at `.audit/phase-three-session-consent/final-checks.log` in the original checkout. These checks did not open the app, upgrade a normal profile, or access real audio hardware.

The normal-identifier standalone Tauri debug build also passed. Its log is `.audit/phase-three-session-consent/standalone-build.log`. The executable was not launched, so this is a packaging/build result rather than native workflow qualification.

## Remaining work

This is the consent-storage portion of delivery unit 1. Durable processing jobs, exclusive worker ownership, payload snapshots and dispatch budgets, consent controls and complete invalidation notifications remain before that unit is complete. Delivery units 2 through 5 remain unimplemented. No Phase 3 issue is closed by this increment.

Native consent UI, real capture, real-engine live inference, cloud compatibility, and macOS behavior remain unverified. Provider qualification and unexpected-exit investigation remain deferred by the user. No earlier short recording permission is treated as authorization for a new capture.
