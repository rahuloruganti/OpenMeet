# OpenMeet

A local-first meeting notetaker for Windows 11. It records your microphone and system audio, transcribes on this PC, and writes AI notes from a model you choose. Version 0.9.0, one unsigned `OpenMeet.exe`, no installer.

Audio capture, local transcription, shortcuts and meeting detection have not been tested on real hardware yet.

## Install

**Quickest:** download `OpenMeet.exe` from the [latest release](https://github.com/rahuloruganti/OpenMeet/releases/latest) (the repository is private, so sign in to GitHub first) and run it. Check it against the SHA256 in the [release notes](docs/release-notes.md).

**Or build it yourself:**

1. Install [Node.js 24](https://nodejs.org/dist/latest-v24.x/), [uv](https://docs.astral.sh/uv/getting-started/installation/), [just](https://just.systems/man/en/packages.html) and [Git](https://git-scm.com/downloads/win). Reopen PowerShell afterwards.
2. Build the app:

```powershell
git clone https://github.com/rahuloruganti/OpenMeet.git
cd OpenMeet
just setup
just build
```

3. Run `packaging\dist\OpenMeet.exe`. Copy it anywhere you like. If SmartScreen warns, click **More info**, then **Run anyway**. Windows 11 already includes the WebView2 runtime the window needs.

## Set up

The first launch opens **Set up OpenMeet**:

1. Import an earlier data folder, if one is found.
2. Pick transcription: a speech model on this PC, a local speech server, or an online API.
3. Pick AI notes (optional): an online API connection, or **Settings → AI notes → Local AI** to run a model on this PC.
4. Pick your default microphone and output device.

API keys go to Windows Credential Manager and are never shown again. You can change everything later in **Settings**. Nothing downloads until you click.

Your data lives in `%APPDATA%\OpenMeetPy\`, unencrypted. There is no telemetry. See [privacy](docs/privacy.md).

## Develop

```powershell
just dev     # run from source
just check   # typecheck, lint, format, tests, build
```

See the [docs](docs/README.md) and [dependencies](docs/dependencies.md).

## License

MIT. See [LICENSE](LICENSE) and [third-party licenses](THIRD_PARTY_LICENSES.md).
