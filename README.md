# OpenMeet

A local-first meeting notetaker for Windows 11 and Apple silicon Macs. It records your microphone and system audio, transcribes on this PC, and writes AI notes from a model you choose. Version 0.9.0, unsigned, no installer: one `OpenMeet.exe` on Windows, one `.dmg` on macOS.

Audio capture, local transcription, shortcuts and meeting detection have not been tested on real hardware yet. The macOS build has not run on a Mac at all; see [macOS](docs/macos.md) for what that means.

## Install

**Quickest:** download `OpenMeet.exe` from the [latest release](https://github.com/rahuloruganti/OpenMeet/releases/latest) and run it. Check it against the SHA256 in the [release notes](docs/release-notes.md).

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

## On a Mac

Apple silicon and macOS 14.2 or newer. There is no Intel build.

1. Download `OpenMeet-0.9.0-arm64.dmg` from the [latest release](https://github.com/rahuloruganti/OpenMeet/releases/latest), open it and drag **OpenMeet** to **Applications**.
2. The build is unsigned and not notarized, so the first open is a right-click, **Open**, **Open** again. To skip that step: `xattr -dr com.apple.quarantine /Applications/OpenMeet.app`.
3. To build it yourself, install Xcode command line tools (`xcode-select --install`), [uv](https://docs.astral.sh/uv/getting-started/installation/), Node.js 24 with Corepack and Git, then run `just build`. That writes `packaging/dist/OpenMeet-<version>-arm64.dmg`.

Allow Microphone and System Audio Recording when macOS asks. [macOS notes](docs/macos.md) covers permissions, data location, shortcuts and what is still untested.

## Set up

The first launch opens **Set up OpenMeet**:

1. Import an earlier data folder, if one is found. A Mac never has one, so the step does not appear there.
2. Pick transcription: a speech model on this PC, a local speech server, or an online API.
3. Pick AI notes (optional): an online API connection, or **Settings → AI notes → Local AI** to run a model on this PC.
4. Pick your default microphone and output device.

API keys go to the OS credential store (Windows Credential Manager, or Keychain on macOS) and are never shown again. You can change everything later in **Settings**. Nothing downloads until you click.

Your data lives in `%APPDATA%\OpenMeetPy\` on Windows and `~/Library/Application Support/OpenMeetPy/` on a Mac, unencrypted. There is no telemetry. See [privacy](docs/privacy.md).

## Develop

```powershell
just dev     # run from source
just check   # typecheck, lint, format, tests, build
```

On a Mac the same recipes run in bash: `just dev` for a source run and `just check` for the full set.

See the [docs](docs/README.md) and [dependencies](docs/dependencies.md).

## License

MIT. See [LICENSE](LICENSE) and [third-party licenses](THIRD_PARTY_LICENSES.md).
