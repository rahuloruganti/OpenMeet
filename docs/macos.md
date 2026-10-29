# OpenMeet on macOS

OpenMeet runs on an Apple silicon Mac with macOS 14.2 or newer. It is the same app, the same interface and the same data model as the Windows build; only the platform code underneath differs. There is no Intel build and no universal build.

Every macOS code path was written and unit-tested on a Windows PC, with fakes at the OS and library boundary. None of it has run on a real Mac. The honest label is **written, unit-tested with fakes, unqualified on a Mac**, and the last section of this page lists what the first real run has to check.

## Install

1. There is no published download yet. Build the DMG with `just build`; see [Build on a Mac](#build-on-a-mac).
2. Open the DMG and drag **OpenMeet** to **Applications**.
3. Open it the first time with a right-click (or Control-click), then **Open**, then **Open** again. The other route is to remove the download flag:

```sh
xattr -dr com.apple.quarantine /Applications/OpenMeet.app
```

The app is unsigned, ad-hoc signed at most, and not notarized, so Gatekeeper refuses a plain double-click on the first open. Later opens behave normally. The build prints the DMG's SHA-256 when it finishes; compare it with the value published beside a release when one is given.

## Permissions

| Permission             | Asked when                                  | Why                                                        |
| ---------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| Microphone             | The first recording                         | The microphone track                                       |
| System Audio Recording | The first recording that has a system track | The Core Audio process tap that records what the Mac plays |

Both prompts name the app with the sentence in the bundle's `Info.plist`. Allow both; a denied microphone shows a message pointing at **System Settings, Privacy & Security, Microphone**, and a denied tap shows one pointing at **System Audio Recording**.

The build is ad-hoc signed, so its identity changes with every rebuild and macOS can ask for both permissions again after you install a new build. Grant them again rather than assuming the earlier grant still applies.

If macOS shows no prompt at all, the system track can come out silent. Check **System Settings, Privacy & Security, System Audio Recording** and turn OpenMeet on there, then record again. The microphone has its own switch on the same page.

## Recording on a Mac

- The microphone track comes from Core Audio through `sounddevice`. The app asks for the device's own sample rate and input channels.
- The system track is a Core Audio process tap, which records every app the Mac plays, OpenMeet's own playback included. The tap is an unmuted passthrough, so you still hear the audio while it records.
- Both tracks are written as on Windows, and paused audio is never written to either.
- Meeting detection reads the Core Audio process list, which says which app holds an active microphone input. It reads no audio, screen or camera content, and it only shows a prompt and bounces the Dock icon; it never starts a recording.
- There is no importer. The Mac never had an earlier OpenMeet, so first-run setup offers no import step.

## Where your data lives

| What                                                                | Where                                                                            |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Meetings, notes, transcripts, summaries, settings                   | `~/Library/Application Support/OpenMeetPy/meetings.db`                           |
| Recordings, timing files, speech models, Local AI engine and models | The same folder, in the subfolders listed in [privacy](privacy.md#local-storage) |
| API keys                                                            | The macOS Keychain, under the service `OpenMeetPy`                               |

The data folder is unencrypted, as it is on Windows. Keys are written to the Keychain and never read back into the page. The bundle declares `LSMinimumSystemVersion` 14.2, so macOS refuses to launch it on an older release rather than starting and failing later.

## Shortcuts

- Global shortcuts take **Command** where the Windows build takes Control, so `CommandOrControl+Shift+F9` registers Command, Shift and F9 here.
- The shortcut editor accepts Command, Control and Option, and refuses a bare key. Letters, digits, F1 to F20, arrows, Space, Tab, Escape, Home, End, Page Up, Page Down, Return, Backspace and Delete all work.
- **F21 to F24 and Insert do not exist on a Mac keyboard**, so a shortcut that names them is refused instead of failing quietly.
- There is no Cmd+, shortcut for Settings. Open **Settings** from the sidebar.
- **Quit** is **Cmd+Q** in the app's own menu. It runs the same close guard as the window's close button, so a pending note save is written before the app exits.

## Local AI on a Mac

The managed Local AI engine uses the Metal build of llama.cpp, which is on by default on Apple silicon. Memory is shared between the processor and the graphics cores, so there is no separate video memory to read; the app offers the GPU about 65 percent of the Mac's RAM and keeps the rest for macOS, the app and the window.

The Mac this port targets has 8 GB of RAM, so about 5 GB is offered for a model. The app marks a catalog entry too big when the model and its context do not fit, and on this machine the comfortable choices are the roughly 2 GB entries (Qwen3 4B, Gemma 3 4B, Llama 3.2 3B). An 8B model is borderline and the 12B and larger entries do not fit, so do not install one the app reports as too big.

## Speech on a Mac

Both local engines run on the CPU:

- whisper.cpp, as shipped in the prebuilt `pywhispercpp` wheel, has no Metal support, so a transcription uses the CPU only.
- sherpa-onnx runs on the CPU.

Transcription therefore runs on the processor rather than the graphics cores. No speed measurement has been taken on a Mac, so treat any expectation about it as unmeasured. Local speech is offered on Apple silicon only; an Intel Mac reports the engine as unsupported instead of failing later.

## Build on a Mac

Get Xcode command line tools (`xcode-select --install`), [uv](https://docs.astral.sh/uv/getting-started/installation/), [Node.js 24](https://nodejs.org/dist/latest-v24.x/) with Corepack, and Git. `just` is optional but the recipes below use it.

```sh
git clone https://github.com/rahuloruganti/OpenMeet.git
cd OpenMeet
just build
```

`just build` runs `packaging/build.sh`, which:

1. syncs the locked Python environment with `uv` and installs the JavaScript packages with pnpm;
2. builds the React UI into `backend/web`;
3. runs PyInstaller in `--windowed --onedir` mode, which produces `OpenMeet.app` with bundle id `dev.openmeet.app`;
4. writes the `Info.plist` keys, including the two permission sentences and `LSMinimumSystemVersion` 14.2;
5. ad-hoc signs the bundle with `packaging/macos/entitlements.plist`;
6. wraps `packaging/dist/OpenMeet-<version>-arm64.dmg` around the app;
7. runs the built app with `--smoke` in a temporary data folder and fails the build if the server or a command does not answer.

The script refuses to run off macOS and refuses an Intel Mac. It ends by printing the DMG path, its size and its SHA-256. `just smoke` repeats the serve-and-answer check on an existing build.

The app icon is `packaging/openmeet.icns`, rendered from `packaging/openmeet-icon.svg` by `packaging/macos/make-icns.py`; regenerate it there if you change the drawing. The build needs no Apple Developer account, no signing certificate and no notarization step.

## What the first Mac run must check

Nothing in this list has been observed on a Mac yet:

1. The microphone track records audible speech, and a denied permission shows the message and names the right settings pane.
2. The system track records what the Mac plays, matches the recording bar, and stays in step with the microphone track.
3. Pause excludes audio from both tracks, with nothing from a paused stretch in either file.
4. Global shortcuts register, fire while another app is in front, and release when changed.
5. Meeting detection shows a prompt for another app holding the microphone, skips OpenMeet itself, and bounces the Dock icon.
6. The Keychain stores a key, Settings shows it as saved, and the key never comes back to the page.
7. Local AI installs its engine, starts `llama-server`, answers a summary, and leaves no orphan server after a stop.
8. Closing the window saves a pending note before it exits, and Cmd+Q does the same.

Until those pass, treat this page as a description of the code, not of a working build.

## Known limits

- Apple silicon only, macOS 14.2 or newer. System audio capture needs 14.2 because Core Audio process taps start there.
- Unsigned and ad-hoc signed, with no notarization and no updater, so Gatekeeper steps in on the first open and a rebuilt app can ask for permissions again.
- Local speech runs on the CPU.
- Hardware qualification, real-device audio and the recording gates in [development](development.md) remain open on both platforms.
