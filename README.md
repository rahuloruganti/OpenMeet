# OpenMeet

A desktop meeting notetaker with local notes, Windows audio capture, local or cloud transcription, and optional summaries through your OpenAI-compatible provider.

**Preview:** Windows capture has not passed full hardware qualification. Apple Silicon macOS 14.2 or newer can start a capture preview; it is not qualified, and permission denial has not been tested. Windows downloads its speech engine. Apple Silicon requires a separately pinned local whisper.cpp build. There is no installer yet; run the app from source using the steps below.

See the [documentation index](docs/README.md) for the [user guide](docs/user-guide.md), [architecture](docs/architecture.md), [dependencies and versions](docs/dependencies.md), and [development guide](docs/development.md).

## Install and run on Windows

### 1. Install the tools once

| Tool                                                                                    | What to install                                                                                  |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Node.js 24](https://nodejs.org/dist/latest-v24.x/)                                     | The Windows x64 installer. Use version 24.                                                       |
| [Rust](https://rustup.rs/)                                                              | Run `rustup-init.exe` with the default MSVC toolchain. The project selects its own Rust version. |
| [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) | Select **Desktop development with C++**, including the MSVC x64 tools and Windows SDK.           |
| [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)            | Usually already installed on Windows 11. Install it if missing.                                  |
| [Git](https://git-scm.com/downloads/win)                                                | Needed to clone this repository.                                                                 |
| [just](https://just.systems/man/en/packages.html)                                       | Install with the command below.                                                                  |

Open PowerShell and run:

```powershell
winget install --id Casey.Just --exact
npm install --global corepack
```

Close PowerShell and open it again so the installed tools are on `PATH`.

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

`just setup` installs the Rust version from `rust-toolchain.toml` and JavaScript dependencies using the pinned pnpm version. It needs internet access on the first run. It does not install the system tools above or download speech models.

`just dev` builds Rust, starts the local frontend, and opens **OpenMeet Preview**. Keep the terminal open. The first native build can take several minutes. For later launches, run `just dev` from the same project folder.

## Use the app

### Write a note

1. Click **New note**.
2. Click **Rename**, enter a title, and press **Enter**.
3. Write in **My notes**. Wait for **Saved** before closing the app.
4. Click **Export Markdown**. Choose a folder on your first export.

Exported files appear in the chosen folder's `Meetings` directory. Export creates a new snapshot when a differing file exists, preserving external edits. Export options are in **Settings**.

### Record and transcribe

1. Click **New recording** and enter a title.
2. Choose your microphone and system output. Start some output audio if you want to check the system track.
3. Inform participants and acknowledge consent, then click **Start recording**.
4. Use **Pause**, **Resume**, and **Stop** in the bottom bar. Check the microphone meter for a signal.
5. Open **Settings**, choose a speech model, and download the speech engine and models if needed.
6. Open the meeting's **Transcript** tab and click **Transcribe audio**.

Local Whisper keeps audio and transcription on your computer. Downloads are verified against pinned checksums. **You** labels the microphone track; **Others** labels system audio. These labels do not identify individual speakers. Review names and numbers in the transcript.

For cloud transcription, choose **Settings → Speech to text → Cloud API**. Save its own HTTPS API base URL/key, then select a discovered model or enter a custom model ID. Each transcription asks before uploading audio and shows the destination, model, tracks, bytes, and request count. Text-only model results have no fabricated timestamps or playback links. Provider retention and charges apply; cancellation cannot recall audio already uploaded.

Sample and simulation creation has been removed. Existing historical samples remain labeled and accessible to preserve edited notes. Use **New note** without opening audio devices.

### Set up optional AI summaries

Notes, recording, and local transcription work without a cloud key. Summaries and **Ask this meeting** use your provider's OpenAI-compatible chat API.

1. Open **Settings → Summaries and questions**.
2. Enter the provider's HTTPS API base URL, including its API path, and paste your API key into the masked field. Save the connection.
3. Refresh models and choose one from the dropdown, or enter a custom model ID if discovery is unavailable. Save the model.

Keys pass briefly through the password field and IPC to Rust, then live in the OS keychain. They are not read back into Settings. Changing the URL requires entering a key for that destination. The LLM and cloud-speech connections are independent. Saving settings makes no content request; refreshing models sends credentials only. Environment-key import has been removed.

Open **Summary**, choose General, Stand-up, or One-to-one, and click **Enhance notes**. Review the destination, model, content, and request count before confirming. These calls send notes and transcript text only. Questions have their own confirmation, and earlier summaries remain available in the version picker.

Compatible endpoints must implement the operation you select; a model list does not prove chat or transcription support. No automatic model/provider fallback occurs. Live provider quality has not yet been qualified.

## Commands

Run these from the repository folder:

| Command      | Result                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `just`       | List commands.                                                                                 |
| `just setup` | Install the project's pinned toolchain and dependencies.                                       |
| `just dev`   | Start the native desktop app.                                                                  |
| `just check` | Run frontend and Rust checks. The hardware recording test stays ignored.                       |
| `just build` | Build a standalone release executable with frontend assets embedded. No installer is produced. |

On Windows, `just build` writes `src-tauri/target/release/openmeet.exe`. Close a running release executable before rebuilding it.

Without `just`, use `rustup toolchain install` and `corepack pnpm install --frozen-lockfile` for setup, then `corepack pnpm tauri dev` to launch. `corepack pnpm dev` starts a browser-only preview with desktop actions disabled.

## Troubleshooting

| Problem                                               | What to do                                                                                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `just`, `node`, `rustup`, or `cargo` is not found     | Install the corresponding tool, then reopen PowerShell. Rust normally lives under `%USERPROFILE%/.cargo/bin`.                                                               |
| `corepack` is not found                               | Run `npm install --global corepack`, then reopen PowerShell.                                                                                                                |
| The linker, MSVC, or Windows SDK is missing           | Add the C++ workload in Visual Studio Installer. Try **Developer PowerShell for VS 2022**.                                                                                  |
| Port 1420 is already in use                           | Stop the earlier Vite or `just dev` process before starting another.                                                                                                        |
| A manually opened debug executable has a blank window | Launch with `just dev`, which starts the frontend it needs. Use `just build` for a standalone executable.                                                                   |
| The development window stays blank after launch       | Keep the terminal open while startup completes. If it persists, stop `just dev` with **Ctrl+C** and restart it. A delayed blank startup has occurred in local smoke checks. |
| Pause shortcut is unavailable                         | Another app may own it. Choose a different shortcut in Settings; on-screen controls remain available.                                                                       |
| Microphone or output is unavailable                   | Select an available device in recording setup. OpenMeet does not substitute a different device.                                                                             |
| No microphone signal                                  | Check the selected input, OS microphone permission, headset mode, and mute state.                                                                                           |
| Export opens a folder picker                          | Choose the destination once; later exports reuse it. Cancel to leave the meeting unchanged.                                                                                 |
| Notes are not saved                                   | Keep the app open and copy your text before retrying. Do not delete the database to fix a save error.                                                                       |

## macOS development

Apple Silicon and Xcode command-line tools are required. Install Node 24, Rust, Corepack, and `just` (`brew install just` if you use Homebrew). Run `xcode-select --install`, then use the same `just setup` and `just dev` commands.

The shell can build. Apple Silicon on macOS 14.2 or newer can start a preview recording: the microphone plus an output-only system tap. A device that also has an input is refused. Grant Microphone and System Audio Recording to `target/debug/openmeet`; a rebuild can drop that grant. Permission denial has not been tested. Apple Silicon transcription requires the separately pinned local whisper.cpp build; the integrated macOS workflow remains unqualified. See [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/) for native build setup.

## Data and privacy

The local database is `meetings.db` in:

- Windows: `%APPDATA%/dev.openmeet.preview/`
- macOS: `~/Library/Application Support/dev.openmeet.preview/`

Audio and timing files are under `audio/<meeting ID>/` in the same directory. Files are **unencrypted**. OS backups and cloud-synced export folders may copy them off-device.

There is no telemetry or automatic cloud processing. Downloads, model discovery, text submission, and cloud audio upload each require explicit actions. **Delete audio** and **Delete meeting** are under the meeting's **•••** menu and require the title to confirm. Exported snapshots remain untouched. **Recover audio** writes repaired copies of unfinished recordings and keeps the originals.

Full capture qualification, long-run drift measurements, macOS support, and installers remain open. See [implementation status](docs/implementation-status.md), [feature plan](docs/feature-plan.md), [privacy](docs/privacy.md), and [consent](docs/consent.md).

## License

MIT. See [LICENSE](LICENSE) and [third-party inventory](THIRD_PARTY_LICENSES.md).
