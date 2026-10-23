# OpenMeet

A local-first meeting notetaker for Windows: notes, microphone and system-audio recording, transcription on this PC, and optional AI summaries through a connection you choose.

**Status:** Windows 11 only, version 0.9.0, shipped as one file (`OpenMeet.exe`) with no installer. Real-hardware qualification is **not** finished: audio capture, local transcription, global shortcuts, meeting detection and the Windows credential store have been exercised only with fakes and stubs. Nothing here claims verified recording reliability, transcript accuracy or live model quality. See [implementation status](docs/implementation-status.md) and the [Phase 7 checklist](docs/phase-7-hardware-qualification.md).

See the [documentation index](docs/README.md) for the [user guide](docs/user-guide.md), [architecture](docs/architecture.md), [dependencies and versions](docs/dependencies.md), [privacy](docs/privacy.md) and [development guide](docs/development.md).

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

On first launch, **Set up OpenMeet** walks through transcription (a speech model on this computer, a local speech server, or an online API), AI notes (a local server such as Ollama, LM Studio or Unsloth Studio, or an online API), and default devices. It finds models and local servers already installed. Skip it or run it again from **Settings → Privacy & about**.

### Write a note

1. Click **New note**.
2. Click **Rename**, enter a title, and press **Enter**.
3. Write in **My notes**. Wait for **Saved** before closing the app.
4. Click **Export Markdown**. Choose a folder on your first export.

Exported files appear in the chosen folder's `Meetings` directory. Export creates a new snapshot when a differing file exists, preserving external edits. Export options are in **Settings**.

### Record and transcribe

1. Click **New recording** and enter a title.
2. Choose your microphone. On Windows the system track records **all audio, including OpenMeet's own playback** (the device label reads `(all audio, includes OpenMeet playback)`), whichever speaker or headset plays it, including Bluetooth headsets in call mode. Play some audio if you want to check the system track.
3. Click **Start recording**. You are responsible for telling participants and following the recording-consent laws that apply to you.
4. Use **Pause**, **Resume**, and **Stop** in the bottom bar. Check the microphone meter for a signal.
5. Open **Settings**, choose a speech model, and download the speech engine and models if needed.
6. Open the meeting's **Transcript** tab and click **Transcribe audio**.

On-this-computer transcription (Whisper or the sherpa-onnx models) keeps audio and transcription on your computer. Downloads are verified against pinned checksums. **You** labels the microphone track; **Others** labels system audio. These labels do not identify individual speakers. Review names and numbers in the transcript.

For cloud transcription, add a connection under **Settings → Connections**, then choose **API connection** under **Settings → Transcription** and assign that connection and a model ID. Transcribing uploads the audio to that connection. Text-only results have no fabricated timestamps or playback links. Provider retention and charges apply, and cancellation cannot recall audio already uploaded.

### Set up optional AI summaries

Notes, recording, and local transcription work without a cloud key. Summaries and **Ask this meeting** use your provider's OpenAI-compatible chat API.

1. Open **Settings → Connections**. Remote and local servers share one list; each is marked **This device** or **Leaves this device**.
2. Name the connection, enter its base URL including the API path, and paste its key into the masked field. Save the connection. Local loopback HTTP supports optional keys.
3. Under **Settings → AI notes**, select the saved connection and a discovered or custom model ID for summaries, then save. Use **Refresh models** in Connections to fetch model IDs when needed.

Keys pass briefly through the password field into the backend and are stored in Windows Credential Manager. They are never read back into Settings, the database, logs or exports. Changing the URL requires entering a key for that destination. Summary and speech assignments are independent and can share a saved connection with different model IDs. Saving settings makes no content request; refreshing models sends credentials only.

Open **Summary**, choose General, Stand-up or One-to-one, and click **Create summary**. It sends notes and transcript text only. Questions send directly too, and earlier summaries remain available in the version picker.

Compatible endpoints must implement the operation you select; a model list does not prove chat or transcription support. No automatic model or provider fallback occurs. Live provider quality has not been qualified.

## Import data from the earlier app

The retired build kept its data in a different folder. To carry it over once:

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
| Notes are not saved | Keep the app open and copy your text before retrying. Never delete the database to fix a save error. |
| SmartScreen blocks the exe | **More info → Run anyway** for an executable you built yourself; otherwise rebuild it. |

## Data and privacy

The data folder is `%APPDATA%\OpenMeetPy\`:

| Path | Contents |
| --- | --- |
| `meetings.db` | Meetings, notes, transcripts, summaries, settings, search index, processing records. |
| `audio/<meeting ID>/` | Microphone and system WAV tracks plus timing indexes. |
| `stt/` | Downloaded speech engine and the Whisper and sherpa-onnx model files. |

Files are **unencrypted**. OS backups and cloud-synced folders may copy them elsewhere.

There is no telemetry and no automatic cloud processing. Downloads and model discovery require explicit actions. Text and cloud audio are sent only when you trigger a transcription, summary, question or rewrite, or choose automatic processing in Settings. API keys live only in Windows Credential Manager. **Delete audio** and **Delete meeting** are under the meeting's **•••** menu and require the title to confirm; exported snapshots are never touched. **Recover audio** writes repaired copies of unfinished recordings and keeps the originals.

See [privacy](docs/privacy.md) for the full boundary and [implementation status](docs/implementation-status.md) for open work.

## License

MIT. See [LICENSE](LICENSE) and [third-party inventory](THIRD_PARTY_LICENSES.md).
