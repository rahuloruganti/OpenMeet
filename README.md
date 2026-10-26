# OpenMeet

A local-first meeting notetaker for Windows: notes, microphone and system-audio recording, transcription on this PC, and optional AI summaries from a connection you choose, on this PC or a remote provider.

**Status:** Windows 11 only, version 0.9.0, shipped as one file (`OpenMeet.exe`) with no installer. Real-hardware qualification is **not** finished: audio capture, local transcription, global shortcuts, meeting detection and the Windows credential store have been exercised only with fakes and stubs. Nothing here claims verified recording reliability, transcript accuracy or live model quality. See the [Phase 7 checklist](docs/phase-7-hardware-qualification.md).

See the [documentation index](docs/README.md) for [dependencies and versions](docs/dependencies.md), [privacy](docs/privacy.md) and the [development guide](docs/development.md).

## Install on Windows

`just build` produces a single executable at `packaging/dist/OpenMeet.exe`. There is no installer: copy that file anywhere you like (for example `%LOCALAPPDATA%\Programs\OpenMeet\`) and run it. Administrator rights are not needed, and nothing is written outside the data folder described under [Data and privacy](#data-and-privacy).

- **Unsigned:** Windows SmartScreen may show "Windows protected your PC". Click **More info**, then **Run anyway** — only for an executable you built yourself from this repository.
- **WebView2:** OpenMeet draws its window with the Microsoft Edge WebView2 Runtime, which ships with Windows 11. If it is missing, install it from Microsoft.
- **Updates:** there is no updater. Quit the app, replace the `.exe` with a newer build, start it again. Your data stays in the data folder.
- **Recording consent:** you are responsible for the recording-consent laws that apply to your meetings.

## Build and run from source

### 1. Install the tools once

| Tool | What to install |
| --- | --- |
| [Node.js 24](https://nodejs.org/dist/latest-v24.x/) | Windows x64 installer. pnpm comes from `corepack`. |
| [uv](https://docs.astral.sh/uv/getting-started/installation/) | Provides Python 3.13 and the backend environment. Do not install Python separately. |
| [just](https://just.systems/man/en/packages.html) | `winget install --id Casey.Just --exact` |
| [Git](https://git-scm.com/downloads/win) | Needed to clone this repository. |
| [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) | Already present on Windows 11; install it if the window fails to open. |

No C++ toolchain, Windows SDK or Visual Studio is required: the backend and its audio and speech dependencies install from prebuilt wheels.

Close PowerShell and open it again so the new tools are on `PATH`.

### 2. Get the project

```powershell
git clone https://github.com/rahuloruganti/OpenMeet.git
cd OpenMeet
```

If you already have the repository, open PowerShell in its folder instead. Cloning requires access if the repository is private.

### 3. Set up and launch

```powershell
just setup
just dev
```

`just setup` installs the pinned Python environment with `uv` and the JavaScript dependencies with the pinned pnpm version. It needs internet access on the first run and does not download speech models. `just dev` builds the UI into the backend, starts the local server and opens the **OpenMeet** window; keep the terminal open.

## Use the app

On first launch, **Set up OpenMeet** walks through importing an earlier data folder when one is found, transcription (a speech model on this computer, a local speech server, or an online API), AI notes (an online API service), and default devices. It finds speech models and local speech servers already installed. Setup does not offer a model on this PC for AI notes; the **Local AI** group in **Settings → AI notes** does that. Skip setup or run it again from **Settings → Privacy & about**.

- **Meetings** is the home page, with the library in the sidebar. **Settings** and **Ask** open as full pages; **← Meetings** or **Escape** goes back. Settings shows all six sections on one scrolling page, with an **On this page** index and a **Search settings** field that hides groups which do not match; a dot in the index marks a section that needs you.
- **Ctrl+K** opens a command palette for actions and meeting titles. Other shortcuts: **Ctrl+N** new recording, **Ctrl+Shift+N** new note, **Ctrl+Shift+A** Ask, **Ctrl+,** Settings, **Ctrl+E** export, **F2** rename, **Ctrl+I** inspector.
- The meeting inspector holds details, tasks and device names; tasks live only there.
- **Settings → General → Theme** switches **System**, **Dark** or **Light**; settings save as you change them.

### Write a note

1. Click **New note**.
2. Click **Rename**, enter a title, and press **Enter**.
3. Write in **My notes**. The **Saved** label shows when the text is stored; closing the window saves pending text too.
4. Click **Export Markdown**. Choose a folder on your first export.

Exported files appear in the chosen folder's `Meetings` directory. Export creates a new snapshot when a differing file exists, preserving external edits. Export options are in **Settings**.

### Record and transcribe

1. Click **New recording** and enter a title.
2. Choose your microphone. On Windows the system track records **all audio, including OpenMeet's own playback** (the device label reads `(all audio, includes OpenMeet playback)`), whichever speaker or headset plays it, including Bluetooth headsets in call mode. Play some audio if you want to check the system track.
3. Click **Start recording**. You are responsible for telling participants and following the recording-consent laws that apply to you.
4. Use **Pause**, **Resume**, and **Stop** in the bottom bar. Check the microphone meter for a signal.
5. Open **Settings → Transcription** and click **Download** on the **Speech model** row, or pick another under **Other models**.
6. Open the meeting's **Transcript** tab and click **Transcribe audio**.

While you record, the **Transcript** tab shows live text. **Settings → Recording → Live transcript** turns it on (it is on by default) and picks the model: **Same as Transcription**, **Streaming English (Zipformer)** (57 MB), **Streaming English (NeMo)** (103 MB) or **Cloud connection**. **Same as Transcription** never uploads: when Transcription is **Cloud**, it is unavailable, and live audio leaves this device only when you pick **Cloud connection**. A streaming model downloads only when you click **Download**. Live text runs only when its model is ready. Finished lines are kept with the meeting and labelled **Provisional** until a final transcript exists.

On-this-computer transcription (Whisper or the sherpa-onnx models) keeps audio and transcription on your computer. Downloads are verified against pinned checksums. **You** labels the microphone track; **Others** labels system audio. These labels do not identify individual speakers. Review names and numbers in the transcript.

For cloud transcription, choose **Cloud** under **Settings → Transcription** and add the connection in **Cloud speech**: pick OpenAI or Groq, or **Custom** for another OpenAI-compatible API, then a model. **Test** checks the address and key by listing that provider's models, without sending audio. Transcribing uploads the audio to that connection. Text-only results have no fabricated timestamps or playback links. Provider retention and charges apply, and cancellation cannot recall audio already uploaded.

### Set up optional AI summaries

Notes, recording, and local transcription work without a cloud key. Summaries and **Ask this meeting** use the OpenAI-compatible chat API of the connection you assign, remote or on this PC.

1. Open **Settings → AI notes** and use the **Connection** group, then pick a provider: OpenAI, Claude (Anthropic), Gemini (Google), Mistral, Groq, Grok (xAI), DeepSeek, OpenRouter, or **Custom** for any other OpenAI-compatible API. The listed providers are remote, so the connection is tagged **Leaves this device**.
2. The provider fills in its base URL and a name; paste its key into the masked field and **Save**. **Custom** asks for the base URL instead, and loopback HTTP keeps the key optional.
3. **Test** beside the key lists that provider's models, which proves the URL answers and the key is accepted without a billable request. A key you type is used for that one check and not stored; otherwise the saved key is used, and only for the URL it was saved with.
4. The **Model** list fills from that check, or by itself when you save a new connection without a model. Pick one and **Save**; **Other…** takes a model ID the provider does not list.

Keys pass briefly through the password field into the backend and are stored in Windows Credential Manager. They are never read back into Settings, the database, logs or exports. Changing the URL requires entering a key for that destination. Summary and speech assignments are independent and can share a saved connection with different model IDs. Saving settings makes no content request; **Test** sends only the key, to list models. Opening Settings contacts no provider.

Open **Summary**, choose General, Stand-up or One-to-one, and click **Create summary**. It sends notes and transcript text only. Questions send directly too, and earlier summaries remain available in the version picker.

Every provider is reached through its OpenAI-compatible API: Claude uses `https://api.anthropic.com/v1`, Gemini uses `https://generativelanguage.googleapis.com/v1beta/openai`, and each preset fills in its own base URL. For Claude, the model list sends the key in Anthropic's `x-api-key` header; chat requests use the Bearer header like every other provider. Compatible endpoints must implement the operation you select; a model list does not prove chat or transcription support. No automatic model or provider fallback occurs. The provider list is covered by mocked HTTP tests only, not tested against the live services.

### Run AI notes on this PC (Local AI)

**Settings → AI notes → Local AI** runs a model on this PC instead of a remote provider. **Set up for me** downloads the pinned llama.cpp build for your graphics and one model from a seven-model catalog, then assigns AI notes to it. You can also install the engine and download a model one step at a time; **Use** saves a connection named **Local AI** and assigns AI notes to it.

The group reads this PC's GPU, VRAM and RAM, labels each model **Fits your GPU**, **Uses system RAM** or **Too big**, and marks the best model that fits as **Recommended**. The catalog is Qwen3 30B A3B, Qwen3 14B, Gemma 3 12B, Qwen3 8B, Qwen3 4B, Gemma 3 4B and Llama 3.2 3B, from 17.28 GB down to 1.88 GB. `.gguf` files found on this PC are listed under **On this PC** and used where they are.

The engine is a pinned llama.cpp build b11671: CUDA on NVIDIA (about 540 MB, including its CUDA runtime), Vulkan on AMD or Intel (32 MB), CPU otherwise (20 MB). The server listens on `127.0.0.1` on port 39281 or a free port, starts by itself before a summary, a question, a rewrite or an automatic summary, and is stopped when the app closes; a Windows Job object also kills it if the app crashes. Nothing leaves this device, and files go to `%APPDATA%\OpenMeetPy\local-ai\`.

No engine or model has been downloaded or run in this build: real llama-server behaviour, GPU offload, the Job-object kill and model quality are untested, and only fakes exercise them in the test suite.

## Import data from the earlier app

The retired build kept its data in a different folder. First-run setup offers **Import** when it finds that folder and this library is empty. To carry it over later, run once from a command prompt:

```powershell
.\OpenMeet.exe --import-from "%APPDATA%\dev.openmeet.preview"
```

This copies `meetings.db` and the `audio` folder into `%APPDATA%\OpenMeetPy`. The source is read-only, the destination must be empty (or absent), and API keys are never copied — reconnect any cloud connection in Settings afterwards. Do not run the old app against the new folder, or the new app against the old one.

## Commands

Run these from the repository folder:

| Command | Result |
| --- | --- |
| `just` | List commands. |
| `just setup` | Install the pinned Python environment and JavaScript dependencies. |
| `just dev` | Build the UI, then open the Python app window. |
| `just ui` | Vite dev server for the UI on `127.0.0.1:1420` with no backend attached: the page shows the not-connected notice and every command fails. There is no mock layer, so nothing records or persists. |
| `just check` | Typecheck, lint, format check, frontend tests, UI build, then the pytest suite. |
| `just build` | Build `packaging/dist/OpenMeet.exe`. |
| `just smoke` | Start `OpenMeet.exe --smoke`, which checks the server and one command, prints `OK` and exits. |
| `just hardware` | Opt-in real-hardware tests. Only run when you mean to use real devices. |

Close a running `OpenMeet.exe` before rebuilding it.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `just`, `node`, `uv` or `git` is not found | Install the tool, then reopen PowerShell so `PATH` is refreshed. |
| `corepack` is not found | Run `corepack enable`, then reopen PowerShell. |
| The window does not open | Check that the WebView2 Runtime is installed. Run `just smoke` to see whether the backend starts. |
| Port 1420 is already in use | Stop the earlier `just ui` or `just dev` process. |
| The window stays blank after launch | Keep the terminal open while startup finishes; stop with **Ctrl+C** and start again. |
| Pause shortcut is unavailable | Another app owns it. Choose a different shortcut in Settings; the on-screen buttons still work. |
| Microphone or output is unavailable | Pick an available device in the recording setup. OpenMeet never substitutes a device on its own. |
| No microphone signal | Check the selected input, the Windows microphone permission for desktop apps, headset mode and mute state. |
| Export opens a folder picker | Choose the destination once; later exports reuse it. Cancel to leave the meeting unchanged. |
| Notes are not saved | Keep the app open and copy your text before retrying; closing the window waits for notes. Never delete the database to fix a save error. |
| Local AI will not start | Read `%APPDATA%\OpenMeetPy\local-ai\server.log`, then turn it off and on in **Settings → AI notes → Local AI**, or choose a smaller model. |
| SmartScreen blocks the exe | **More info → Run anyway** for an executable you built yourself; otherwise rebuild it. |

## Data and privacy

The data folder is `%APPDATA%\OpenMeetPy\`:

| Path | Contents |
| --- | --- |
| `meetings.db` | Meetings, notes, transcripts, summaries, settings, search index, processing records. |
| `audio/<meeting ID>/` | Microphone and system WAV tracks plus timing indexes. |
| `stt/` | Downloaded speech engine, the Whisper and sherpa-onnx model files, and live transcript streaming models under `stt/streaming/`. |
| `local-ai/` | The downloaded llama.cpp engine, the GGUF models, and `server.log`. |

Files are **unencrypted**. OS backups and cloud-synced folders may copy them elsewhere.

There is no telemetry and no automatic cloud processing. Downloads and model discovery require explicit actions. Text and cloud audio are sent only when you trigger a transcription, summary, question or rewrite, choose automatic processing in Settings, or set **Cloud connection** as the live transcript model. **Local AI** keeps summaries and questions on this PC; its engine and model downloads contact github.com and huggingface.co only when you click, and nothing is uploaded. API keys live only in Windows Credential Manager. **Delete audio** and **Delete meeting** are under the meeting's **•••** menu and require the title to confirm; exported snapshots are never touched. **Recover audio** writes repaired copies of unfinished recordings and keeps the originals.

See [privacy](docs/privacy.md) for the full boundary and the [Phase 7 checklist](docs/phase-7-hardware-qualification.md) for open qualification work.

## License

MIT. See [LICENSE](LICENSE) and [third-party inventory](THIRD_PARTY_LICENSES.md).
