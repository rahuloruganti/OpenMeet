> **Archived: describes the retired Rust/Tauri app (git tag rust-final). Not current. Do not use as a reference for the Python build.**

# Open-source meeting notetaker: development plan and tool inventory

Oct 9, 2026 · @rahul oruganti

This is the original design and tool proposal, not the current dependency inventory. Several providers, libraries, and integrations below were not implemented. See [current documentation](docs/README.md), [dependencies actually used](docs/dependencies.md), and [implementation status](docs/implementation-status.md).

## Goal and scope

Build a macOS and Windows desktop app that records meetings without a bot, transcribes and summarizes them locally by default, and can send a bot into meetings that cannot be captured on the device. Nothing leaves the machine unless the user picks a cloud model or turns on the SharePoint webhook.

| # | Requirement | Approach | Covered in |
| --- | --- | --- | --- |
| 1 | Transcribe like Otter, identify speakers | Two-track capture, offline diarization, bot adapter for join-by-link | Diarization, Bot mode |
| 2 | Template-based summaries | Markdown templates with variables, run through the chosen LLM | LLM layer |
| 3 | Windows and Mac, local storage | Tauri app, Rust core, SQLite plus Markdown files | Architecture, Storage |
| 4 | Switchable STT and LLM | Engine traits; local and cloud providers behind one interface | STT, LLM layer |
| 5 | Send transcripts to SharePoint | Webhook to a Power Automate HTTP-trigger flow, with a local retry outbox | SharePoint |
| 6 | Auto-detect like Granola, bot like Otter | Per-meeting mode: Auto, Desktop only, Bot only | Capture, Bot mode |

Non-goals for v1: mobile apps, Linux builds, cloud sync, live coaching during calls, and running our own bot infrastructure.

Principles:

- Local first: audio, transcripts and summaries stay on disk in open formats (SQLite, Markdown, WAV or Opus).
- No bot by default: the bot is an optional backend, never required.
- Swappable engines: every model sits behind a trait, so a new STT or LLM is a config change.
- Consent is visible: a recording indicator, a pause hotkey and a consent reminder ship in v1.
- Open licensing: MIT or Apache-2.0 for our code; every model and dependency license is tracked in the inventory below.

## Architecture

One Rust process owns the whole path from audio to note; the React interface only sends commands and listens to events.

&#91;embedded content: architecture · 5 stages, 3 inputs, 4 outputs\]

Audio and meeting signals enter on the left and move down the five stages. The finished meeting fans out to SQLite, a Markdown note and the SharePoint outbox, and a bot server, when used, delivers a ready transcript that skips the first four stages.

## Stack at a glance

A Rust core inside a Tauri 2 shell does the real-time work (capture, STT, diarization); a React frontend draws the notes. Versions marked "checked" were read from docs.rs or crates.io on 9 Oct 2026; the rest are pinned when the repo is created.

Every package, model, service and tool, with versions and licenses, is in the tab Package inventory.

| Layer | Choice | Alternative kept in reserve | Why |
| --- | --- | --- | --- |
| App shell | [Tauri 2.12.2](https://docs.rs/crate/tauri/latest) (checked) | Electron | Small binary, Rust core next to the audio code. Tauri 3 is still alpha, so stay on 2.x |
| UI | React, TypeScript, Vite, Tailwind | Svelte | Largest editor and component ecosystem |
| Audio capture | [cpal 0.18.2](https://docs.rs/crate/cpal/latest) (checked) | [screencapturekit 10.0.3](https://crates.io/crates/screencapturekit) on macOS, `wasapi` crate on Windows | One API for mic and system loopback; per-OS fallbacks for permission and version gaps |
| STT | [whisper-rs 0.16.0](https://docs.rs/crate/whisper-rs/latest) (checked), plus Parakeet through [sherpa-onnx 1.13.8](https://crates.io/crates/sherpa-onnx) | [transcribe-rs](https://docs.rs/crate/transcribe-rs/latest/source/README.md), [ort 2.0.0-rc.13](https://docs.rs/crate/ort/latest) | Whisper for 99 languages, Parakeet for fast European-language work |
| Diarization | sherpa-onnx: pyannote segmentation 3.0 plus a speaker-embedding model | [polyvoice](https://docs.rs/crate/polyvoice/latest) (pure Rust, lower accuracy) | One runtime for ASR, VAD and diarization; MIT-licensed segmentation weights |
| LLM | One OpenAI-compatible client plus a native Anthropic client, both over `reqwest` | A gateway such as LiteLLM | Ollama speaks the OpenAI chat format, so local and cloud share one path |
| Storage | [rusqlite 0.40.2](https://docs.rs/crate/rusqlite/latest) (checked, `bundled` feature) plus Markdown files | sqlx | Bundled SQLite 3.53.2 avoids Windows linking trouble |
| Bot mode | [Vexa](https://github.com/vexa-ai/vexa) or [Attendee](https://github.com/attendee-labs/attendee) over REST | Own Playwright bot | Do not rebuild Zoom, Teams and Meet joining |
| Release | `tauri-action` on GitHub Actions, Apple notarization, Windows code signing | Unsigned builds with install notes | Gatekeeper and SmartScreen block unsigned apps |

## Desktop shell and UI

The app is one Tauri 2 process: a Rust backend owns audio, models and storage, and a webview renders four surfaces: a tray menu, a meeting list, a note editor with a live transcript pane, and settings. The webview never touches audio; it sends commands and receives events.

| Package | Role | Notes |
| --- | --- | --- |
| `tauri` 2.12 (Rust) and `@tauri-apps/api`, `@tauri-apps/cli` | Shell, commands, events | Keep Rust and JS packages on the same 2.x line; do not move to the 3.0 alphas |
| Tauri plugins: `global-shortcut`, `notification`, `autostart`, `updater`, `single-instance`, `dialog`, `opener`, `window-state` | Pause hotkey, consent prompt, start at login, signed updates, one running copy, vault folder picker, window memory | Official v2 plugin names from memory; confirm each at v2.tauri.app/plugin before adding |
| Built-in tray (`tray-icon` feature) | Idle, recording and paused states | Tauri's own dependency list includes the tray crate as an optional feature |
| `react`, `react-dom`, `typescript`, `vite` | UI foundation | Vite is the default Tauri frontend path |
| `tailwindcss` plus a small component set (shadcn/ui or Radix primitives) | Styling | Copy-in components, no heavy design-system dependency |
| `@tiptap/react` and `@tiptap/starter-kit`, with a Markdown serializer | Granola-style notes editor | Notes the user types stay plain Markdown on disk; decide Tiptap versus CodeMirror 6 in the first UI spike |
| `zustand` | Client state | Meeting list, recording state, settings mirror |
| `tauri-specta` (optional) | Typed command bindings from Rust to TypeScript | Tauri lists `specta` as an optional dependency; check `tauri-specta` compatibility with 2.12 before adopting |
| `vitest`, `@testing-library/react`, `eslint`, `prettier` | Frontend tests and lint |  |

Command and event contract (the only coupling between UI and core):

- Commands: `start_recording`, `stop_recording`, `pause_recording`, `list_meetings`, `get_meeting`, `regenerate_summary(template, model)`, `save_settings`, `test_webhook`.
- Events: `recording_state`, `transcript_partial`, `transcript_final`, `diarization_updated`, `summary_progress`, `outbox_status`.

Rust-side utility crates used everywhere: `tokio` (async runtime, already a Tauri dependency), `serde` and `serde_json`, `thiserror` and `anyhow`, `tracing` with `tracing-subscriber`, `uuid`, `time` or `jiff` for timestamps.

## Audio capture and meeting detection

Capture two separate tracks, the microphone and the system output, behind one `AudioSource` trait; detection watches which app is using the mic. cpal 0.18 covers both tracks on both OSes, and platform crates fill the gaps.

### Capture by platform

|  | macOS | Windows |
| --- | --- | --- |
| Mic | cpal (Core Audio) | cpal (WASAPI) |
| System audio | cpal loopback, built on a Core Audio process tap plus a private aggregate device; the tapped audio still plays through the speakers ([cpal source](https://docs.rs/crate/cpal/latest/source/src/host/coreaudio/macos/loopback.rs)) | WASAPI loopback, which works whether or not the sound card has a loopback pin ([Microsoft](https://learn.microsoft.com/windows/win32/coreaudio/loopback-recording)); confirm cpal's Windows loopback API in the spike, else use the `wasapi` crate |
| Minimum OS | cpal lists macOS 14.2, and loopback needs 14.6 or later ([cpal docs](https://docs.rs/crate/cpal/latest)); other crates cite 14.4 for taps | Windows 8 for WASAPI; per-process capture needs a recent Windows 10 build ([Microsoft sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)) |
| Fallback | `screencapturekit` 10.0.3: system audio from macOS 13, microphone from macOS 15 ([crates.io](https://crates.io/crates/screencapturekit)) | Per-process loopback to capture only the meeting app, through `flexaudio-os-windows` (0.2.0, young) or the Microsoft sample ported to Rust |
| User permission | Core Audio taps: an audio-capture prompt, no Screen Recording permission, no orange recording dot. ScreenCaptureKit: Screen Recording permission and the orange indicator ([scrybe docs](https://docs.rs/scrybe-meeting-capture-mac/latest/scrybe_capture_mac/)) | No prompt by default; handle a silent stream if the user switched mic access off |

Prefer the tap path on macOS: fewer scary permissions. Keep ScreenCaptureKit only for macOS 13 to 14.5.

### Pipeline

1. Each source writes native-rate float samples into a lock-free ring buffer (`ringbuf`), stamped from one monotonic clock.
2. A worker thread resamples to 16 kHz mono (`rubato`) for STT and diarization, and writes the original audio to disk (WAV through `hound` while recording, compressed after the meeting; codec chosen in the spike).
3. Voice-activity detection (Silero VAD, run through sherpa-onnx) cuts the stream into utterances before they reach the STT engine.

Known traps to test:

- **Echo.** On speakers, the mic re-records the remote voices. Recommend headsets, and test a simple rule that drops mic audio overlapping loud system audio.
- **Device changes mid-call.** Bluetooth headsets and docks change sample rate or device. The source must reopen without losing the clock.
- **Windows on ARM.** Microsoft's own Q&A says loopback behavior on ARM64 is undocumented ([Q&A](https://learn.microsoft.com/en-us/answers/questions/5694431/coreaudio-wasapi-loopback-on-windows-11-arm-iaudio)). Ship x64 first.
- **Sleep and wake.** Timestamps must survive a suspend.

### Meeting detection

A detector emits `MeetingDetected` and `MeetingEnded`; the mode setting decides whether that starts recording or just asks.

- **macOS:** poll Core Audio process objects and read which process has input running. The open-source `side-huddle` does this every 300 ms and needs the mic held for 2 seconds before it fires ([PyPI](https://pypi.org/project/side-huddle)). Detection alone needs no permissions.
- **Windows:** no open reference exists; `side-huddle`'s Windows side is a stub. Plan: enumerate WASAPI audio sessions for processes with an active capture session, cross-check with the window title of known meeting apps, and treat the registry's microphone-usage records as a second signal. This design is mine and unverified; prove it in the first spike.
- **Filters that matter:** Zoom opens the mic on its pre-join screen, so require a real meeting window ([side-huddle source](https://docs.rs/crate/side-huddle/0.2.1/source/src/platform/darwin/detect.rs)). Dictation apps trigger naive detectors, so match the process holding the mic, not just any running meeting app ([OpenOats issue](https://github.com/yazinsai/OpenOats/issues/726)).
- **Muted is not silent.** A mic-in-use signal cannot tell whether the user is muted inside the call ([Recorder.ai](https://recorder.ai/articles/mute-detection-for-desktop-recording-apps)). Ship a visible indicator and a pause hotkey.
- **Calendar signal (optional):** read ICS or Google and Microsoft calendars to name the meeting and list attendees; never required.

### Packages

| Package | Use |
| --- | --- |
| `cpal` 0.18.2 | Mic and loopback capture |
| `screencapturekit` 10.0.3 | macOS fallback |
| `objc2-core-audio` and `objc2-core-foundation` (already cpal dependencies) | Process-object queries for macOS detection |
| `windows` 0.62 (cpal's own version) | Audio sessions, registry and window queries on Windows |
| `ringbuf`, `rubato`, `hound` | Buffers, resampling, WAV |
| `flexaudio` family (reference only) | Per-process capture code to study before writing our own |

## Speech-to-text

Use a fast streaming model for the live view and an accurate offline model for the final transcript, both behind one `SttEngine` trait so users can swap models in settings. No single model wins on every axis.

| Engine | Mode | Languages | Strength | Watch out for |
| --- | --- | --- | --- | --- |
| Whisper large-v3-turbo through `whisper-rs` | Offline | 99 | Broadest language reach, MIT license ([comparison](https://openvoxai.com/blog/best-local-stt-transcription-models-2026)) | No native streaming; known to hallucinate on silence ([overview](https://www.onresonant.com/resources/local-stt-models-2026)) |
| Parakeet TDT 0.6B v3 through sherpa-onnx | Offline, chunked streaming possible | 25 European | Lower published error rate than Whisper Turbo on English: 6.34% versus 7.83% ([comparison](https://openvoxai.com/blog/best-local-stt-transcription-models-2026)) | Fewer languages; sources disagree on its license, so read the model card before bundling |
| Nemotron 3.5 streaming through sherpa-onnx | Streaming, 80 ms to 1.12 s chunks | Check model card | Built for live captions ([comparison](https://openvoxai.com/blog/best-local-stt-transcription-models-2026)); sherpa-onnx added multilingual support ([changelog](https://github.com/k2-fsa/sherpa-onnx/blob/master/CHANGELOG.md)) | Young; verify language coverage and accuracy on our test audio |
| Moonshine streaming through sherpa-onnx | Streaming | Mostly English models | Small and efficient ([overview](https://www.onresonant.com/resources/local-stt-models-2026)) | Test on noisy meeting audio |
| Cloud STT with the user's own key (optional) | Streaming | Wide | No local compute | Audio leaves the device; label it clearly |

### Runtime packages

- [`whisper-rs` 0.16.0](https://docs.rs/crate/whisper-rs/latest): Rust bindings to whisper.cpp. GPU features are compile-time flags (`cuda`, `metal`, `vulkan`, `openblas`), so builds differ per hardware.
- [`sherpa-onnx` 1.13.8](https://crates.io/crates/sherpa-onnx): the official Rust crate wraps the C API with streaming and offline recognizers, VAD, speaker embeddings and diarization, and links statically by default ([docs](https://docs.rs/sherpa-onnx/latest/sherpa_onnx/)). The older `sherpa-rs` bindings last released in October 2025; do not start on them.
- [`ort` 2.0.0-rc.13](https://docs.rs/crate/ort/latest): ONNX Runtime 1.28 wrapper, still a release candidate. Use it only if sherpa-onnx cannot run a model we need.
- [`transcribe-rs`](https://docs.rs/crate/transcribe-rs/latest/source/README.md): worth reading as a design reference. It puts Parakeet, Whisper and Moonshine behind one trait, with Metal, Vulkan, DirectML and CoreML options.

### Behavior

1. **Live pass:** VAD cuts utterances; a streaming model emits partial text, shown greyed in the UI.
2. **Final pass:** when the meeting ends, the offline model re-transcribes each track with word timestamps. Final text replaces live text; the user's typed notes are never touched.
3. **Hallucination guards:** skip VAD-silent spans, reject repeated n-grams, and cap segment length.
4. **Language:** auto-detect per meeting, with a manual override and a per-template default.
5. **Models are downloaded, never bundled:** first use fetches from Hugging Face with a checksum (`reqwest` and `sha2`), stores in the app data folder, and shows size and memory needs before download.

### Hardware builds

Because `whisper-rs` acceleration is chosen at compile time, ship three builds: macOS with Metal, Windows with Vulkan plus CPU, and an optional Windows CUDA build for NVIDIA users. ONNX models run on CPU by default and can use CoreML or DirectML through `ort` once measured.

### Benchmark gate

Before picking defaults, run a 10-minute fixture set (two speakers, one noisy, one accented, one German, one with overlap) on one Apple Silicon Mac and one mid-range Windows laptop. Record word error rate and real-time factor per engine. The default is whichever model runs under real time on the Windows laptop without a GPU.

## Diarization and speaker identification

The mic track gives "You" for free, so only the system track needs diarization; run it offline after the meeting, with an approximate live label during it. Naming speakers is a separate step from separating them.

| Stage | Component | Notes |
| --- | --- | --- |
| Voice activity | Silero VAD through sherpa-onnx | Cuts speech spans; also gates the STT engine |
| Segmentation | pyannote segmentation 3.0 (ONNX) | MIT license; the original Hugging Face page asks users to accept terms, but redistribution of the ONNX export is MIT ([model card](https://huggingface.co/42ailab/Speaker-Diarization-Models)) |
| Embeddings | WeSpeaker ResNet34 or CAM++ (3D-Speaker) | Benchmark both on our fixtures; the LocalAI example uses a Chinese-trained CAM++ file, which may not suit multilingual calls ([LocalAI](https://localai.io/features/audio-diarization/index.html)) |
| Clustering | Agglomerative, built into sherpa-onnx | Input must be 16 kHz mono |
| Runtime | [`sherpa-onnx` 1.13.8](https://crates.io/crates/sherpa-onnx) Rust crate | Has diarization and speaker-embedding APIs; added in its Rust API per the [changelog](https://github.com/k2-fsa/sherpa-onnx/blob/master/CHANGELOG.md) |
| Reference app | [OpenWhispr](https://openwhispr.com/blog/local-speaker-diarization) | Same pipeline, fully local, voice fingerprints in a local SQLite file |

### How speakers get labels

1. **Align:** give each transcript word to the diarization segment it overlaps most.
2. **Live labels:** every 30 seconds or so, re-diarize a rolling window and match new clusters to earlier ones by embedding distance. A benchmark project found per-segment online diarization with sherpa a dead end and used periodic offline re-diarization instead ([vocal-helper](https://pypi.org/project/vocal-helper/)).
3. **Final labels:** re-run on the full system track when the meeting ends; labels may change, and the UI says so.
4. **Names:** offer calendar attendees as one-click names for "Speaker 2". Diarization IDs are local to each recording ([LocalAI](https://localai.io/features/audio-diarization/index.html)), so cross-meeting recognition needs our own embedding store.
5. **Voiceprints (opt-in):** store each named person's average embedding in SQLite and suggest names in later meetings by cosine similarity, with a threshold tuned on our own test set. Keep it local, deletable, and off by default; a voiceprint is biometric data in many jurisdictions, so get a legal read before shipping it.

### What accuracy to expect

- Published numbers differ by setup. One pure-Rust, ungated engine scores 18.5% diarization error against 11.3% for pyannote 3.1 on the same test ([polyvoice](https://docs.rs/crate/polyvoice/latest)); use pyannote-class models as the default.
- Offline beats streaming for accuracy ([AssemblyAI](https://www.assemblyai.com/blog/top-speaker-diarization-libraries-and-apis)), which is why the final pass matters.
- Speed varies by hardware: one local build runs about 1.9x real time on plain CPU and about 380x on Apple silicon with CoreML ([model card](https://huggingface.co/42ailab/Speaker-Diarization-Models)). A one-hour meeting is therefore fine after the call on a Mac, and slower on a CPU-only laptop.
- Overlapping speech stays the main error source. Mark low-confidence spans instead of guessing.
- Embedding weights trained on VoxCeleb data may carry CC-BY-4.0, which requires attribution when redistributed ([model listing](https://huggingface.co/Transcripta/sherpa-onnx-speaker-diarization-wasm)). Track every model's license in the repo.

### Bot mode skips this

Attendee can return per-participant audio segments or the platform's own captions, so speaker names come from the meeting itself ([Attendee docs](https://docsearch.algolia.com/mcp/docs/repo/attendee-labs/attendee)). Both paths write the same transcript schema: speaker, start, end, text, confidence, source.

### Fallbacks

`polyvoice` (pure Rust, MIT) if sherpa-onnx proves hard to build on Windows; `pyannote.audio` in a sidecar process only as a last resort, since it needs Python and a Hugging Face token.

## LLM layer and summary templates

One `LlmProvider` trait with three adapters covers local and cloud models; summaries come from editable Markdown templates. The most likely failure is not the model but the context window: a local server can silently cut the transcript.

| Adapter | Talks to | Notes |
| --- | --- | --- |
| OpenAI-compatible | `llama-server` from llama.cpp, LM Studio, vLLM, OpenAI and similar, by changing the base URL | llama.cpp's server exposes `/v1/chat/completions`, with compatibility described as good enough for many apps rather than complete ([llama.cpp server README](https://git.peisongxiao.com/CS348Project/llama.cpp/commit/9ad4d273e11deb2ebed201d846bb97ae0129320e)) |
| Ollama native | Ollama's own chat endpoint | Ollama also offers an OpenAI-compatible endpoint covering part of the API ([docs](https://docs.ollama.com/openai.md)); use the native one so we can set the context size per request |
| Anthropic native | The Messages API | Separate request format, so its own adapter |

API keys live in the OS keychain (the `keyring` crate), never in SQLite or the Markdown files. First use of any cloud provider shows a one-time notice that the transcript leaves the device.

### The context-window trap

Ollama's default context is 4,096 tokens, and it truncates a longer prompt without an error ([guide](https://fast.io/resources/ollama-context-window/); the older Modelfile docs list 2,048 ([docs](https://github.com/jmorganca/ollama/blob/31f0551dab9a10412ec6af804445e02a70a25fc2/docs/modelfile.md))). A one-hour meeting is roughly 9,000 spoken words at 150 words a minute, so about 12,000 tokens before speaker labels (my estimate). Rules:

1. Count tokens before every call (characters divided by 4 as an estimate, corrected by the provider's reported usage).
2. Set the context size explicitly per request, and warn when the model cannot fit the transcript.
3. If the transcript uses more than about 70% of the context, switch to chunk-then-merge: summarize each 10-minute chunk (about 10% overlap) into structured notes, then run the template over the merged notes.
4. Show the user which path ran.

### Templates

A template is a Markdown file with YAML settings on top, stored in a `templates/` folder the user can edit. Variables use a Jinja-style engine (`minijinja`, version pinned at init): `{{ transcript }}`, `{{ notes }}` (what the user typed), `{{ attendees }}`, `{{ title }}`, `{{ date }}`, `{{ language }}`. Built-ins: General, One-to-one, Stand-up, Interview, Sales call, Project status, Retro.

```markdown
---
name: Stand-up
description: Per-person yesterday, today, blockers
temperature: 0.2
max_output_tokens: 800
---
You summarize a team stand-up. Keep the user's own notes verbatim
where they exist; add only what the transcript supports.

## Notes typed by the user
{{ notes }}

## Transcript
{{ transcript }}

Return Markdown with these sections: Summary, Per person, Blockers,
Action items (owner, task, due date if said).
```

### Granola-style notes merge

The user's typed bullets are the skeleton; the model expands under them and adds missing points. AI-written passages sit between `%%ai-start%%` and `%%ai-end%%` markers (hidden in Obsidian), so a regenerate replaces only those blocks.

### Reliability rules

- Ask for action items and decisions as JSON, validate with `serde_json`, retry once, then fall back to plain text. Constraint features differ between servers, so do not rely on them.
- Every summary is stored with its template hash, model name and provider, so "regenerate with another model" never loses the earlier version.
- Pick default local models after a rubric test: each template over five fixture transcripts, scored by hand. The model picker shows memory needs before download.

### Packages

`reqwest` (rustls, streaming), `tokio-stream` with a small SSE parser, `serde`, `serde_json`, `minijinja`, `keyring`, `sha2` (template hashes).

## Storage and Obsidian output

SQLite holds the structured truth; a Markdown note per meeting is the output users read, in a vault folder they choose. The note can always be rebuilt from the database, but never at the cost of the user's own edits.

### Folders

- **App data folder** (OS default, resolved with the `dirs` crate): `meetings.db`, `audio/<meeting-id>/mic` and `system` files, `models/`, `templates/`, `settings.toml`.
- **Vault folder** (user-chosen, any Obsidian vault or plain folder): `Meetings/2026-10-08 Weekly sync.md`, and optionally `Meetings/Transcripts/<id>.md` linked from the note when transcripts are long.

### Database

Open SQLite with write-ahead logging and foreign keys on; run migrations at start (`refinery` or `rusqlite_migration`, chosen at init). Full-text search is a nice-to-have; confirm in the spike that the bundled SQLite build includes it.

| Table | Key columns | Purpose |
| --- | --- | --- |
| `meetings` | id, title, started\_at, ended\_at, source (desktop or bot), platform, calendar\_event\_id, status, vault\_path | One row per meeting |
| `tracks` | meeting\_id, kind (mic or system), path, sample\_rate | Audio files on disk |
| `segments` | meeting\_id, track, speaker\_id, start\_ms, end\_ms, text, confidence, pass (live or final) | Transcript, word timing kept in a side column |
| `speakers` | meeting\_id, label, person\_id (nullable) | "Speaker 2" and who it turned out to be |
| `people` | id, name, email, voiceprint (nullable, opt-in) | Cross-meeting identity |
| `notes` | meeting\_id, user\_markdown | What the user typed |
| `summaries` | meeting\_id, template\_hash, model, provider, markdown, is\_current | Every version, never overwritten |
| `outbox` | meeting\_id, kind, payload\_hash, status, attempts, next\_attempt\_at, last\_error | Retry queue for SharePoint |

### The note

```markdown
---
title: "Weekly sync"
date: 2026-10-08
start: 2026-10-08T10:00
duration: 42
attendees: ["[[Alex]]", "[[Sam]]"]
tags: [meeting]
meeting_id: 01J9Z3
template: Stand-up
model: ollama/qwen
---

## Summary
%%ai-start%%
...
%%ai-end%%

## My notes
- typed by the user

## Action items
- [ ] Owner: task, due date

> [!note]- Transcript
> **You:** ...
> **Speaker 2:** ...
```

Obsidian rules we follow ([property and syntax summary](https://deepwiki.com/kepano/obsidian-skills/2.6-properties-and-frontmatter); confirm against Obsidian's own help before release):

- Properties are YAML frontmatter at the top of the file, one block only.
- Internal links in a property must be quoted.
- Frontmatter tags are plain words, no `#`.
- Use `[[wikilinks]]` for notes inside the vault and normal links for web addresses.

### Writing safely

1. **Atomic writes:** write a temporary file in the same folder, then rename, so sync tools never see half a note.
2. **File names:** strip the characters Windows forbids (`< > : " / \ | ? *`), cap the length, and add a short id on collisions.
3. **Never overwrite edits:** keep a hash of the last written note and watch the vault file (`notify` crate). If the user changed it, a regenerate replaces only the text between the AI markers.
4. **Attendee links:** link `[[Name]]` only when a note with that name already exists in the vault.
5. **Delete means delete:** removing a meeting deletes its rows and audio, and asks whether to delete the note.

### Packages

`rusqlite` 0.40.2 with `bundled`, a migrations crate, `dirs`, `notify`, `sha2`, `time` or `jiff`, `serde`, `toml`. For frontmatter, emit YAML by hand with every string quoted; check the maintenance status of YAML crates before depending on one.

## SharePoint through Power Automate

The app posts one JSON payload per meeting to a Power Automate flow that starts with "When an HTTP request is received" and saves a file into SharePoint. It works, with three constraints: a premium license, an auth choice, and a 100 MB message limit.

### Constraints

- **License:** the Request trigger is a premium connector and needs extra licensing ([Microsoft Learn](https://learn.microsoft.com/en-us/sharepoint/dev/declarative-customization/site-design-trigger-flow-tutorial)). A community answer says only the flow's owner needs the premium license, not the callers ([forum thread](https://community.powerplatform.com/forums/thread/details/?threadid=a79f81f2-0051-4aff-8652-92202f4c31b1)); ask the tenant admin to confirm.
- **Size:** messages are capped at 100 MB, which becomes roughly 70 to 80 MB once Base64-encoded, and the SharePoint Create file action is stricter at about 90 MB ([reference](https://manueltgomes.com/microsoft/power-platform/powerautomate/handling-large-files-in-power-automate/); [Microsoft limits](https://learn.microsoft.com/en-us/power-automate/limits-and-config)). We send text only, never audio, so this stays far away.
- **Auth:** see the table.

| Option | How it works | Trade-off |
| --- | --- | --- |
| Anyone with the URL | The flow URL carries its own key | Simplest. Treat the URL as a password: store it in the OS keychain, never in a note or log, rotate on leaks ([walkthrough](https://www.inogic.com/blog/2025/03/how-to-secure-http-requests-using-oauth-authentication-in-power-automate/)) |
| Entra sign-in | New flows default to "any user in my tenant"; the request must carry a valid token with the right claims ([Microsoft Learn](https://learn.microsoft.com/en-us/power-automate/oauth-authentication)) | Safer, but needs an app registration and a sign-in flow in the desktop app; Microsoft's page notes the feature was still rolling out by region |

Plan: v1 supports the URL option; v1.1 adds Entra sign-in (authorization code with PKCE, `oauth2` crate) once a test tenant is available.

### Payload contract

```json
{
  "schema_version": 1,
  "idempotency_key": "01J9Z3-final",
  "test": false,
  "meeting": {
    "id": "01J9Z3",
    "title": "Weekly sync",
    "started_at": "2026-10-08T10:00:00+02:00",
    "duration_min": 42,
    "source": "desktop",
    "attendees": [{ "name": "Alex", "email": "alex@example.com" }]
  },
  "summary_markdown": "...",
  "notes_markdown": "...",
  "transcript_markdown": "...",
  "file_name": "2026-10-08 Weekly sync - 01J9Z3.md",
  "template": "Stand-up",
  "model": "ollama/qwen"
}
```

The repo ships this as a JSON Schema (the same file pasted into the trigger and used in our tests).

### Flow design

1. **Trigger:** HTTP request with the schema above.
2. **Check:** reject unknown `schema_version`; if `test` is true, answer success without saving.
3. **Save:** look up the file by path; update it if it exists, create it if not. The meeting id in the name makes a re-send harmless.
4. **Index (optional):** add a SharePoint list item with title, date, attendees and a link.
5. **Respond:** return JSON with `ok` and the file URL, or an error code. Without a Response action the caller cannot tell success from failure.

Ship an exportable solution and a README under `integrations/power-automate/` so admins import rather than rebuild.

### Delivery in the app

- **Outbox:** the summary step writes an `outbox` row and a payload file; a background worker sends it with `reqwest`.
- **Retries:** exponential backoff (for example 1 minute, 5 minutes, 30 minutes, 2 hours, 12 hours), then a visible "needs attention" state with a manual "send again".
- **Test button:** sends a payload with `test: true` and shows the response.
- **Offline:** meetings finish normally; the outbox drains when the network returns.

### Risks specific to Microsoft tenants

Organizations can restrict connectors or outside HTTP calls through data policies, and trigger URLs can change (one reference page lists a November 2025 URL migration), so keep the URL a setting and re-test after admin changes. Both need confirming in the target tenant.

### Packages

`reqwest`, `serde_json`, `jsonschema` (validate payloads in tests), `wiremock` (fake flow endpoint in tests), `keyring`, `oauth2` (v1.1).

## Bot mode

The bot is an optional backend behind a `BotBackend` trait, not code we write ourselves. v1 connects to a Vexa or Attendee server the user hosts; when a bot cannot get in, the app falls back to local capture. This is the riskiest feature, and it cannot honestly be called "all local on a laptop".

### Backends

|  | Vexa | Attendee |
| --- | --- | --- |
| License | Apache-2.0 ([repo](https://github.com/vexa-ai/vexa)) | Open source ([repo](https://github.com/attendee-labs/attendee)) |
| Platforms | Meet, Teams, Zoom (Zoom support called experimental; needs Zoom app setup and approval), plus Jitsi | Zoom, Meet, Teams |
| Hosting | Docker Compose on a Linux host; forks describe a single-container "lite" build ([README](https://github.com/jbschooley/vexa)) | Self-hostable with PostgreSQL or MariaDB |
| Transcript | Real-time over REST and WebSocket, speaker-attributed | Per-participant audio segments, or the platform's own captions; third-party STT providers selectable ([docs](https://docsearch.algolia.com/mcp/docs/repo/attendee-labs/attendee)) |
| Catch | Mid-call bot control returns 404 in the open-core build | Zoom needs OAuth credentials |

The interface the app needs is small: `join(url, name)`, `status(id)`, `leave(id)`, `transcript(id)` (stream or fetch), `artifacts(id)`. Map results into our `segments` table with `source = bot`. Check which STT the backend uses: an "all local" setup needs a local engine on the server, or must pull the audio and re-transcribe on the device.

### Platform constraints

| Platform | Main constraint | Our answer |
| --- | --- | --- |
| Zoom | Meeting SDK apps need Zoom's review to join meetings outside their own account ([Zoom docs](https://developers.zoom.us/docs/distribute/sdk-feature-review-requirements/)); a bot joining only the owner's meetings skips marketplace approval ([Recall.ai](https://www.recall.ai/blog/zoom-sdk-compliance-requirements)). The SDK session also ends when the authorizing user leaves ([Zoom forum](https://devforum.zoom.us/t/updates-to-meeting-sdk-authorization-faq/139269)), and hosts can switch off local recording ([Recall.ai](https://docs.recall.ai/docs/zoom-oauth-faqs)) | v1: user brings their own Zoom credentials and uses the bot for their own meetings |
| Teams | Admins can turn off unverified anonymous join per organizer, and require a CAPTCHA ([Microsoft Learn](https://learn.microsoft.com/en-us/microsoftteams/anonymous-users-in-meetings)); one admin guide reports third-party bots being labeled in the lobby and admitted one by one from May 2026 ([guide](https://support.meetingdecisions.com/en/how-to-disable-anonymous-bots-from-joining-microsoft-teams-meetings)) | Expect many corporate meetings to refuse; fall back to local capture |
| Meet | Google blocks headless browsers; guest bots need a display and the host must admit them ([meeto](https://pypi.org/project/meeto/)); some organizations block guest joins ([Apify actor](https://apify.com/lexis-solutions/google-meet-transcription-bot)) | Use a signed-in bot account where possible |

A bot running on the user's own laptop is possible in principle (a visible Chrome window plus a virtual audio device), but one open-source notetaker reports that screen recording then needs window focus and falls back to audio only ([project README](https://github.com/aqeeljundiy/open-source-meeting-app)). A virtual audio driver also means a Windows install step. Do not build this in v1.

### Mode logic

| Mode | What records | Needs |
| --- | --- | --- |
| Desktop only | Local capture when a meeting is detected | Nothing else |
| Bot only | A bot joins at the start time; nothing is captured locally | A meeting URL and a configured bot server |
| Auto (default) | Local capture if a meeting app is detected within 2 minutes of the start; otherwise offer "send a bot" | Calendar or pasted URL for the bot path |

Rules:

1. Never run both on the same meeting unless the user picks "both" (useful when the bot's speaker names help diarization).
2. If a bot is not admitted within a timeout (default 5 minutes), notify the user and, if they are in the meeting, start local capture.
3. The bot always joins under a clear name such as "\<Name>'s notetaker" and posts a recording notice in chat where the platform allows it. Zoom's SDK rules require its native recording indicator.
4. Calendar input in v1 is a pasted URL or an ICS feed; Google and Microsoft calendar sign-in comes in v1.1.

### Packages

`reqwest` (REST), `tokio-tungstenite` (WebSocket transcripts), `url`, `serde`, `icalendar` or a similar ICS parser. Server side, for users: Docker and Docker Compose, with an example under `integrations/bot/`.

## Build, CI, signing and testing

Builds are the second-hardest part after capture: native audio and ML libraries compile differently per OS, and unsigned apps are blocked or flagged on both. Budget about $100 to $700 a year for signing, and test capture by hand because CI machines have no audio devices.

### Toolchain per developer machine

| Tool | Why | Notes |
| --- | --- | --- |
| Rust stable via `rustup` | Core | cpal needs Rust 1.85 or newer on most backends ([cpal docs](https://docs.rs/crate/cpal/latest)) |
| Node LTS and `pnpm` | Frontend |  |
| Xcode command-line tools | macOS builds, Swift bridging used by Tauri |  |
| Visual Studio Build Tools (C++ workload) and the Windows SDK | Windows builds | WebView2 runtime is needed at run time |
| CMake and LLVM/Clang | `whisper-rs` builds whisper.cpp and generates bindings | See its [BUILDING.md](https://docs.rs/crate/whisper-rs/latest) for Windows and Apple silicon |
| Vulkan SDK or CUDA Toolkit | Only for the Vulkan or CUDA Windows builds | Separate release artifacts |
| Docker | Run Vexa or Attendee for bot-mode tests |  |

### CI and release

- **GitHub Actions matrix:** macOS on Apple silicon, Windows x64. Add Intel macOS only if users ask. Cache Cargo builds (`Swatinem/rust-cache`).
- **`tauri-action`** builds the installers and publishes a GitHub release.
- **macOS:** a Developer ID certificate plus notarization; the Apple Developer Program is $99 a year ([Tauri docs](https://v2.tauri.app/distribute/sign/macos/)). Signing is required on most platforms, and distributing outside the App Store also requires notarization ([Tauri docs](https://v2.tauri.app/distribute/)).
- **Windows:** an OV certificate costs roughly $200 to $400 a year and an EV certificate $300 to $600; SmartScreen reputation builds per certificate over downloads, and EV clears it at once ([one project's write-up](https://github.com/adamgreenwell/flume/wiki/Signing-and-Distribution)). A cloud signing service called from CI is an alternative ([example issue](https://github.com/BearlySleeping/aikami/issues/104)).
- **Updater:** Tauri's updater uses its own signing key, separate from OS signing. Keep both keys in CI secrets.
- **Fallback:** if signing is not affordable at launch, ship unsigned with clear install notes, as some open-source apps do.

### macOS entitlements and strings

Direct distribution, not the App Store sandbox. Add usage-description strings for microphone and system-audio capture and the hardened-runtime audio-input entitlement; confirm the exact key names in Apple's documentation when wiring the first build.

### Test strategy

| Layer | What | Tool |
| --- | --- | --- |
| Unit | Alignment of words to speakers, template rendering, note writer, outbox backoff | `cargo test`, `proptest` |
| Fixtures | A 10-minute licensed-for-reuse audio set with reference transcripts and speaker labels | Download script or Git LFS |
| Quality | Word error rate per STT engine; diarization error rate per pipeline | Nightly job, results in the repo |
| Webhook | Payload against the JSON Schema; fake endpoint | `jsonschema`, `wiremock` |
| UI | Screens with mocked Tauri commands | `vitest`, Playwright against the Vite build |
| Privacy | In local-only mode the app makes no outside requests | A test proxy that fails on any non-local call |
| Hygiene | Lints, advisories, dependency licenses | `cargo clippy -D warnings`, `cargo fmt`, `cargo deny`, `cargo about` for the third-party license file |

Capture cannot run in CI, so each release runs a manual matrix:

| Axis | Cases |
| --- | --- |
| OS | macOS 14.6 or newer, macOS 13 to 14.5 (fallback path), Windows 10 and 11 |
| Meeting app | Zoom, Teams, Meet in Chrome, Meet in Edge |
| Audio gear | Speakers plus laptop mic, wired headset, Bluetooth headset |
| Events | Mid-call device switch, sleep and wake, 60-minute run, mic muted in app |

Repository hygiene: `LICENSE`, `THIRD_PARTY_LICENSES`, a `models.toml` that records each model's license, attribution text, source URL and checksum, `CONTRIBUTING.md`, and `docs/privacy.md` plus `docs/consent.md` explaining what is recorded, where it is stored and the recording-consent duties of the user.

## Roadmap

The desktop notetaker is usable after about six weeks; bot mode comes last because it carries the most risk.

&#91;embedded content: roadmap · 6 phases, 6 exit gates\]

A phase ends only when its gate passes; if a gate fails, fix it or cut scope before starting the next phase. The total is about 18 weeks for one full-time developer (my estimate), and a second developer could take phases 3 and 4 in parallel once phase 2 is done.

Deliverables per phase:

- **0 Spikes (1 week):** the seven spikes listed under risks, the fork-or-fresh decision, and a repo skeleton whose CI builds on macOS and Windows.
- **1 MVP (5 weeks):** manual start and stop; two-track capture on both OSes; voice-activity detection; a Whisper final transcript labeled "You" and "Others"; Ollama plus one cloud provider; three built-in templates; SQLite; a Markdown note written to the chosen folder; tray icon, pause hotkey and recording indicator; settings screen; model downloader.
- **2 Detect (4 weeks):** meeting detection on both OSes; consent prompt; Desktop-only and Auto modes; sherpa-onnx diarization with live "Speaker N" labels and calendar-based naming; Parakeet and a streaming engine; STT switching in settings; template editor; regenerate with another model.
- **3 Webhook (2 weeks):** outbox with retries, test button, JSON Schema, Power Automate solution and admin README. Entra sign-in waits for v1.1.
- **4 Bot (3 weeks):** the `BotBackend` trait; Vexa adapter first and Attendee second; pasted-URL input; admit timeout with fallback to local capture; Bot-only and full Auto modes.
- **5 Release (3 weeks):** signing and notarization, updater, the manual capture matrix, privacy and consent docs, a license audit, and the first public release.

## Risks, open decisions and first checks

The three biggest risks are Windows meeting detection, silent context truncation in local LLMs, and bot mode being refused by organizations. Seven one-week spikes settle most of the unknowns before any feature work.

### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Windows meeting detection has no open reference | High | Manual start always works; prototype session and window heuristics in the first spike |
| Local LLM silently drops transcript text | High | Count tokens, set context per request, chunk-then-merge, tell the user which path ran |
| Bot refused by Teams, Meet or Zoom policies | High | Bot stays optional; fall back to local capture; never promise it joins everything |
| Recording consent and voiceprints are legally sensitive | High | Visible indicator, pause hotkey, consent docs; voiceprints off by default; legal read before release |
| Scope: three products in one | High | Phase gates; bot mode last |
| macOS version gaps (taps need 14.2 to 14.6 depending on source; ScreenCaptureKit from 13) | Medium | Version check at start, fallback capture, clear message |
| Diarization labels change after the meeting | Medium | Say so in the UI; mark low-confidence spans; named speakers can be corrected |
| STT errors on accents, noise and non-European languages | Medium | VAD gating, per-language model choice, benchmark gate |
| Power Automate license, data policies or auth blocks the flow | Medium | Test tenant early; URL option in v1; admin README |
| Young dependencies: `ort` is a release candidate, `flexaudio` is 0.2, sherpa-onnx moves fast | Medium | Pin versions, hide each behind a trait, run `cargo deny` |
| Signing cost and SmartScreen warnings | Medium | Budget it, or ship unsigned with notes |
| Bot join steps break when platforms change their UI | Medium | Use maintained backends instead of our own bot |

### Open decisions (recommended default first)

1. **Fork or start fresh:** study Meetily, an MIT-licensed Rust project listed as a bot-free alternative (confirm its current Windows support first) ([AlternativeTo](https://alternativeto.net/software/granola-1/?p=2)), and reuse its capture code if it holds up; the car-voice crate already ports its Core Audio tap code ([docs.rs](https://docs.rs/crate/car-voice/latest/source/src/system_audio_capture.rs)). Decide at the end of week 1.
2. **Our license:** MIT or Apache-2.0 (Apache adds a patent grant); avoid AGPL so companies can adopt it.
3. **Default STT:** whichever model runs under real time on the Windows test laptop without a GPU.
4. **Audio retention:** delete raw audio 30 days after the final transcript, user-adjustable; keep forever as an option.
5. **Voiceprints in v1:** no; ship after the consent and legal review.
6. **Intel Macs:** no in v1.
7. **Product name and branding:** open; avoid names close to Granola or Otter.
8. **Telemetry:** none, including crash reports, unless the user opts in.

### Spikes (one week in total)

| # | Question | Pass condition |
| --- | --- | --- |
| 1 | Does cpal capture mic and system audio for 60 minutes on both OSes? | Two tracks, drift under 100 ms at the end |
| 2 | Can we detect a Zoom, Teams or Meet call on Windows without false starts? | Fewer than one false prompt per day of normal use |
| 3 | Does sherpa-onnx build on both OSes and diarize the fixture set? | Builds in CI; error rate recorded |
| 4 | Which STT model runs under real time on the Windows laptop? | Real-time factor below 1.0 on CPU or Vulkan |
| 5 | Does a one-hour transcript survive the local LLM path? | Summary mentions facts from the last 10 minutes |
| 6 | Does the Power Automate flow save a file end to end in a test tenant? | File appears; re-send does not duplicate |
| 7 | Does a self-hosted bot backend join a Meet and a Teams test meeting? | Transcript arrives with speaker names, or a clean failure reason |

## Sources

Package versions were read from the five pages opened in full on 9 Oct 2026. Everything else was read from search excerpts of the linked pages, so re-check a claim at its source before building on it.

**Opened in full (versions as of 9 Oct 2026)**

- [tauri 2.12.2](https://docs.rs/crate/tauri/latest)
- [cpal 0.18.2](https://docs.rs/crate/cpal/latest)
- [whisper-rs 0.16.0](https://docs.rs/crate/whisper-rs/latest)
- [ort 2.0.0-rc.13](https://docs.rs/crate/ort/latest)
- [rusqlite 0.40.2](https://docs.rs/crate/rusqlite/latest)

**Capture and detection**

- [cpal macOS loopback source](https://docs.rs/crate/cpal/latest/source/src/host/coreaudio/macos/loopback.rs), [scrybe macOS capture](https://docs.rs/scrybe-meeting-capture-mac/latest/scrybe_capture_mac/), [screencapturekit](https://crates.io/crates/screencapturekit), [flexaudio-os-macos](https://docs.rs/crate/flexaudio-os-macos/latest)
- [Microsoft: loopback recording](https://learn.microsoft.com/windows/win32/coreaudio/loopback-recording), [application loopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/), [ARM64 loopback question](https://learn.microsoft.com/en-us/answers/questions/5694431/coreaudio-wasapi-loopback-on-windows-11-arm-iaudio)
- [side-huddle](https://pypi.org/project/side-huddle), [OpenOats detection issue](https://github.com/yazinsai/OpenOats/issues/726), [Recorder.ai on mute detection](https://recorder.ai/articles/mute-detection-for-desktop-recording-apps)

**Speech-to-text and diarization**

- [Local STT comparison](https://openvoxai.com/blog/best-local-stt-transcription-models-2026), [Moonshine, Parakeet and Whisper](https://www.onresonant.com/resources/local-stt-models-2026), [transcribe-rs](https://docs.rs/crate/transcribe-rs/latest/source/README.md)
- [sherpa-onnx crate](https://crates.io/crates/sherpa-onnx), [Rust API docs](https://docs.rs/sherpa-onnx/latest/sherpa_onnx/), [changelog](https://github.com/k2-fsa/sherpa-onnx/blob/master/CHANGELOG.md), [sherpa-rs](https://lib.rs/crates/sherpa-rs)
- [LocalAI diarization guide](https://localai.io/features/audio-diarization/index.html), [vocal-helper benchmarks](https://pypi.org/project/vocal-helper/), [polyvoice](https://docs.rs/crate/polyvoice/latest), [OpenWhispr pipeline](https://openwhispr.com/blog/local-speaker-diarization), [AssemblyAI overview](https://www.assemblyai.com/blog/top-speaker-diarization-libraries-and-apis)
- [Diarization model build and licenses](https://huggingface.co/42ailab/Speaker-Diarization-Models), [sherpa-onnx WASM licenses](https://huggingface.co/Transcripta/sherpa-onnx-speaker-diarization-wasm)

**LLM and Obsidian**

- [Ollama OpenAI compatibility](https://docs.ollama.com/openai.md), [Ollama context window](https://fast.io/resources/ollama-context-window/), [llama.cpp server README](https://git.peisongxiao.com/CS348Project/llama.cpp/commit/9ad4d273e11deb2ebed201d846bb97ae0129320e)
- [Obsidian properties and syntax summary](https://deepwiki.com/kepano/obsidian-skills/2.6-properties-and-frontmatter)

**Power Automate**

- [Microsoft: Request trigger is premium](https://learn.microsoft.com/en-us/sharepoint/dev/declarative-customization/site-design-trigger-flow-tutorial), [OAuth for HTTP triggers](https://learn.microsoft.com/en-us/power-automate/oauth-authentication), [flow limits](https://learn.microsoft.com/en-us/power-automate/limits-and-config)
- [Licensing thread](https://community.powerplatform.com/forums/thread/details/?threadid=a79f81f2-0051-4aff-8652-92202f4c31b1), [large files](https://manueltgomes.com/microsoft/power-platform/powerautomate/handling-large-files-in-power-automate/), [trigger reference](https://manueltgomes.com/reference/power-automate-trigger-reference/when-an-http-request-is-received-trigger/), [securing with OAuth](https://www.inogic.com/blog/2025/03/how-to-secure-http-requests-using-oauth-authentication-in-power-automate/)

**Bot mode**

- [Vexa](https://github.com/vexa-ai/vexa), [Attendee](https://github.com/attendee-labs/attendee), [Attendee docs](https://docsearch.algolia.com/mcp/docs/repo/attendee-labs/attendee)
- [Zoom SDK review rules](https://developers.zoom.us/docs/distribute/sdk-feature-review-requirements/), [Zoom compliance](https://www.recall.ai/blog/zoom-sdk-compliance-requirements), [SDK authorization FAQ](https://devforum.zoom.us/t/updates-to-meeting-sdk-authorization-faq/139269), [Zoom OAuth FAQ](https://docs.recall.ai/docs/zoom-oauth-faqs)
- [Teams anonymous join](https://learn.microsoft.com/en-us/microsoftteams/anonymous-users-in-meetings), [admin guide on bot labeling](https://support.meetingdecisions.com/en/how-to-disable-anonymous-bots-from-joining-microsoft-teams-meetings)
- [meeto (Meet bot)](https://pypi.org/project/meeto/), [Apify Meet bot](https://apify.com/lexis-solutions/google-meet-transcription-bot), [open-source notetaker](https://github.com/aqeeljundiy/open-source-meeting-app)

**Release and reuse**

- [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/), [Tauri distribution](https://v2.tauri.app/distribute/), [Windows signing costs](https://github.com/adamgreenwell/flume/wiki/Signing-and-Distribution), [cloud signing example](https://github.com/BearlySleeping/aikami/issues/104)
- [Meetily listing](https://alternativeto.net/software/granola-1/?p=2), [car-voice Core Audio port](https://docs.rs/crate/car-voice/latest/source/src/system_audio_capture.rs)
