# v1 release plan

Agreed with the user on 2026-10-22. These decisions supersede earlier plans and AGENTS.md rules where they conflict.

## Goal

A public GitHub release of OpenMeet for Windows. macOS stays labelled as a preview. Features are frozen apart from the items below until the core loop (record → transcribe → summarize → export) works in a real meeting.

## Decisions

| # | Decision |
| --- | --- |
| Audience | Public GitHub release is the end goal. The repository stays private until v1 is ready; the user changes visibility, not an agent. |
| Platform | Windows only for v1. macOS remains a labelled preview. |
| Consent | Remove all four consent steps: per-request text confirmation cards (summary, question, rewrite, ask across meetings), cloud audio upload confirmation, the automatic-processing review, and the per-recording participant checkbox. Delete the consent records, fingerprints, and frozen plans behind them. Saved cloud connections keep their "Leaves this device" badge. The README states that users are responsible for local recording-consent laws. The tray recording indicator stays. |
| Safety limits | Keep hard bounds (bytes, chunk counts, timeouts); stop displaying request counts and budgets. |
| Automatic processing | Enabled during setup by default: after Stop, transcribe with the selected route, then summarize if AI notes are configured. Live transcription off by default. API failures show an error with Retry; never retry automatically. |
| First-run setup | Skippable steps, rerunnable from Settings: (1) welcome and data location; (2) transcription: Local or API; (3) AI notes: API connection, reuse step 2's, local server, or skip; (4) default microphone and output with live meters. |
| Local speech models | Scan for installed models and use them in place (store the path; no copy). Files matching a pinned list are checked once and labelled **Verified**; other runnable models are **Custom**. A missing file shows "Model missing, choose again" and never falls back. Models found but not runnable stay hidden. |
| Speech engines | whisper.cpp (any Whisper `ggml`) plus **sherpa-onnx** as a second downloadable engine. Pinned sherpa models: Parakeet TDT 0.6B v3, Moonshine base, SenseVoice small. Detected sherpa folders (`.onnx` + `tokens.txt` in a known layout) appear as Custom. |
| Default local model | Setup recommends Parakeet v3 for English/European languages and Whisper small for others, with download sizes; one click to pick. |
| Local servers | When Local is chosen, probe loopback only, and only while setup or Settings is open: Ollama `:11434`, LM Studio `:1234`, Unsloth Studio `:8888` (needs an `sk-unsloth` key; a 401 reads "Unsloth Studio found, paste its key"), and OpenAI-compatible speech servers such as speaches `:8000` and LocalAI `:8080`. One click creates a "This device" connection with a model selected. No server: "No local AI server found" with install links. |
| API route | After base URL and key, fetch `/models` automatically. Filter speech models (`whisper`, `transcribe`, `stt` in the ID) for transcription and the rest for AI notes, with "Show all" and a custom ID field. |
| Hugging Face | Keep and fix. Search only `automatic-speech-recognition` models. Allow any Whisper `ggml` file from any repository and complete sherpa-onnx model folders (each file checksummed), labelled Custom. Drop LLM `.gguf` downloads. |
| Shortcuts | New defaults: pause `Ctrl+Shift+F9`, stop `Ctrl+Shift+F10`. Saved shortcuts are unchanged. |
| Name and version | Product name **OpenMeet**, window title without "foundation preview", version `0.9.0`. Keep the identifier `dev.openmeet.preview` so existing data does not move. |
| Installer | Unsigned NSIS `-setup.exe`; README documents the SmartScreen "More info → Run anyway" steps. Signing later if downloads justify it. |
| Updater | None in v1; add in v1.1. |
| Release builds | Built locally with `just build` until the repository is public; then a `tauri-action` workflow builds releases on tags. |

## Order

Each step is its own commit to `main`.

1. Hands-on run of the native app, including one short authorized test recording with the user present → bug list.
2. Remove the consent steps.
3. First-run setup plus model and server detection.
   - 3b. sherpa-onnx engine and its pinned models.
4. Fix Hugging Face search and download.
5. Rename, new shortcut defaults, NSIS installer.
6. Docs, third-party license notices, release notes → `v0.9.0`, built locally.

## Still required before calling v1 done

The capture qualification in AGENTS.md (distinct audible tracks, paused audio excluded, device loss/switch, sleep/wake, a 60-minute run with drift below 100 ms) and a fresh-machine install of the NSIS build. Record unmet gates in the release notes rather than claiming them.

## Hands-on findings (2026-10-22)

Native run of `just dev` with two authorized test recordings on a SoundCore 2 Bluetooth device (microphone and output). Driven through WebView2 remote debugging because desktop automation cannot send input into the webview.

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | P0 | Dev window stayed blank: Vite scanned and watched the 21 GB `src-tauri/target`. | Fixed `147fdd1` |
| 2 | P0 | Transcription refused every recording on this machine: device packet stamps jitter up to ±11 ms against a 2 ms tolerance. | Fixed `ea753a6` |
| 3 | P0 | With the SoundCore 2, the system track is always empty. Opening its microphone switches it to hands-free mode; playback then goes to a "Hands-Free" render endpoint that cpal does not enumerate, and loopback of "Headphones (SoundCore 2)" receives nothing. A Noise THREE headset did capture system audio. Closing `voice-jev` did not change the result. | Fixed `531b79e`: Windows now records all app audio by process loopback; an in-app chime test captured it. Capture of a real meeting app is unverified. |
| 4 | P0 | No warning when a track records nothing or near-silence, during recording or after stop. | Fixed `531b79e`: empty finalized tracks are named on the Transcript tab; the live 10 s microphone-silence warning already existed. |
| 5 | P1 | Quiet Bluetooth microphone (−50 to −57 dBFS while speaking) gave 2 short segments from about 10 s of speech. | Open |
| 6 | P1 | About 1.3 s of microphone audio is lost at start while the Bluetooth profile switches. | Open |
| 7 | P1 | After a no-speech transcription the UI shows "Transcript generated and saved" above "No transcript yet." | Fixed `531b79e` |
| 8 | P1 | Settings shows no warning that both API tasks use `merge-api`, which has no key, or that the speech model ID is a text-to-speech model. | Open (setup work) |
| 9 | P2 | Export folder is shown with the `\?\` prefix. | Open |
| 10 | P2 | Window size and position are not remembered. | Open |
| 11 | P2 | Most library entries read "Untitled meeting"; a default title with date and time would be scannable. | Open |
| 12 | P2 | "Save notes now" duplicates autosave. | Open |
| 14 | P1 | Automatic API transcription stops after about 20 minutes: chunks are 16-bit at the native rate, so the 48 kHz stereo system track alone uses about 192 kB/s against the 256 MiB plan budget. Downmix to 16 kHz mono in `cloud_stt::prepare` or scale the budget. | Open |
| 13 | P1 | New recording listed only a stale "Saved microphone (unavailable)" until **Refresh devices**, although the SoundCore microphone was connected. | Open |

Pause exclusion held on the microphone track: the timing index has no blocks for the paused 10.5 s and the WAV length matches. Local transcription with Whisper `small` runs end to end. Summaries were not exercised because no connection has a key.
