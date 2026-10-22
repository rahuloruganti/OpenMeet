# OpenMeet 0.9.0 (Windows)

First public release. Windows 10/11 x64 is supported; macOS (Apple Silicon, 14.2+) is an unqualified preview.

## Install

Download `OpenMeet_0.9.0_x64-setup.exe`. It is unsigned, so Windows SmartScreen warns: choose **More info → Run anyway**. It installs per user (no admin) and downloads the WebView2 runtime if missing. There is no auto-updater in this version.

## What it does

- Records your microphone and all app audio (except OpenMeet) as separate tracks, on this device.
- Transcribes locally (Whisper, or sherpa-onnx with Parakeet v3, Moonshine base, SenseVoice small) or with an API connection you configure.
- Writes notes as Markdown; summaries and questions use an OpenAI-compatible model you choose (local or API).
- First-run setup finds installed speech models and local AI servers (Ollama, LM Studio, Unsloth Studio, speaches, LocalAI).
- Hugging Face search lists speech models only; downloads are checksummed.
- Default shortcuts for new installs: pause `Ctrl+Shift+F9`, stop `Ctrl+Shift+F10`.

## Known limits

- You are responsible for recording-consent law where you are.
- Capture was checked with a system chime and a headset, not with real meeting apps; a 60-minute drift run, sleep/wake and device-loss tests are not done.
- Real sherpa-onnx transcription and Hugging Face downloads have not been run against live services; custom sherpa folders assume SenseVoice for single-model layouts.
- Data and exports are unencrypted. Cloud actions show "Leaves this device".
- Cloud speech uploads are capped by a budget that long recordings can exceed (see `docs/v1-release-plan.md`, finding 14).
