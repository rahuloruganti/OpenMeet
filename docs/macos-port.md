# macOS port: build guide for agents

Goal: an Apple Silicon build of OpenMeet next to the Windows one. Same app, same UI, same data model. This file is the single source of truth for every agent working on the port. Read it fully, then read `AGENTS.md`, then do only your lane.

## Scope and hard limits

- Target: macOS 14.2 or newer, Apple Silicon (arm64) only. No Intel, no universal2 builds.
- No Apple Developer account. The app is unsigned (ad-hoc signed at most). Users open it with right-click, Open, or `xattr -dr com.apple.quarantine OpenMeet.app`. Do not write notarization steps.
- CI is out of scope. Do not touch `.github/`.
- **Nobody can run macOS code here.** This is a Windows PC. Every macOS code path is written against documented APIs and tested only with fakes. Never claim it works on a Mac. Say "written, unit-tested with fakes, unqualified on a Mac". The owner qualifies it on a real M3 Mac later.
- The Windows build must not change behaviour. All existing Windows tests must keep passing.
- Version stays 0.9.0.

## Rules for every agent

- You own only the files listed in your lane. Do not edit any other file. If you need a change elsewhere, say so in your report; do not make it.
- Only the parent edits `AGENTS.md`, `CLAUDE.md`, `backend/pyproject.toml`, `backend/uv.lock`, `docs/` (except where your lane lists a doc), and `conftest.py`.
- Do not run git add, commit, stash, checkout, restore, reset, mv or rm. Do not delete files you did not create.
- Do not download anything, install packages, start a recording, open an audio device, or touch `%APPDATA%\OpenMeetPy` or `%APPDATA%\dev.openmeet.preview`. Use temp folders in tests.
- No mention of Rust or Tauri anywhere. No em dashes (U+2014) in code, comments, docs or UI text.
- Comments explain why, not what. Match the surrounding style. Smallest complete change: reuse existing helpers and the standard library.
- Catch specific exceptions only. Never swallow errors. A macOS capability that is missing must fail visibly with a short user-facing message, never fall back silently (for example never fall back to one-track capture).
- Keep the privacy rules in `AGENTS.md`: no telemetry, keys only in the OS credential store and never read back to the UI, paused audio is never saved, detection never starts capture.
- UI copy: short, plain, human sentences. No marketing.

## How to write and test macOS code on Windows

- Dispatch on `sys.platform == "darwin"`. Put macOS-only code in new modules named `*_mac.py` (or `macos.py`) next to the code they replace, and import them lazily from the dispatcher.
- Never import `objc`, `AppKit`, `Foundation`, `CoreAudio`, `sounddevice`, `catap`, `ctypes.cdll` of a mac framework or anything macOS-only at module top level. Import inside the function that needs it, so importing your module on Windows and in tests never fails.
- Load native frameworks lazily, for example `ctypes.CDLL("/System/Library/Frameworks/Carbon.framework/Carbon")` inside a method, and take the library handle through a small injectable parameter so tests can pass a fake.
- Tests: use `monkeypatch.setattr(sys, "platform", "darwin")` and fake modules in `sys.modules` (`monkeypatch.setitem(sys.modules, "sounddevice", fake)`). Test your logic (id building, validation, mapping tables, error messages, lifecycle), not the OS.
- Never mock our own modules. Fakes belong only at the OS or library boundary.
- Run only your own tests while working, then run the whole suite once at the end.
  - Backend: `cd backend && env -u PYTHONPATH .venv/Scripts/python.exe -m pytest -p no:warnings`. Baseline is 836 passed, 4 deselected.
  - Frontend (only if your lane has frontend files): from the repo root, `node node_modules/typescript/bin/tsc --noEmit`, `node node_modules/eslint/bin/eslint.js src`, `node node_modules/prettier/bin/prettier.cjs --check src`, and `node node_modules/vitest/vitest.mjs run < /dev/null`. Baseline is 561 tests in 51 files (plus 2 in `src/shared/lib/platform.test.ts`). `corepack` is broken here, so call node directly.
- Shell is bash on Windows: use `env -u PYTHONPATH`, use forward slashes, use the `workdir` argument, never run bare `python -`.

## Final report format (keep it under 300 words)

1. Files created or changed (exact paths).
2. Tests added, and the exact pass counts from the last full run of your checks.
3. What is written but unverifiable without a Mac.
4. Anything another lane or the parent must do.

## Verified facts about macOS (use these, do not guess)

- Python 3.13 arm64 wheels exist for `pywhispercpp==1.5.1` (CPU only; no Metal in the prebuilt wheel), `sherpa-onnx==1.13.8` and `sherpa-onnx-core==1.13.8`, `numpy`, `sounddevice==0.5.6` (bundles PortAudio), `catap==0.6.0` (macOS 14+, depends on `pyobjc-framework-coreaudio`). `pywebview==6.2.1` pulls pyobjc Cocoa/WebKit on darwin by itself.
- `keyring.backends.macOS.Keyring` is a pure ctypes wrapper over Security.framework. Construct it explicitly (as `keys.py` does for Windows), because entry-point discovery can fail in a frozen app.
- llama.cpp pin `b11671` ships `llama-b11671-bin-macos-arm64.tar.gz`, size 12201717 bytes, sha256 `0f9c093f77b9c194f2f097df6204d9f5f8758968815e7db0374e98b0485ef9df` (from the GitHub release asset digest), URL `https://github.com/ggml-org/llama.cpp/releases/download/b11671/llama-b11671-bin-macos-arm64.tar.gz`. It is a tarball, the server binary is `llama-server` with no extension, Metal is on by default on Apple Silicon.
- TCC permissions: microphone needs `NSMicrophoneUsageDescription`; system audio capture through a Core Audio process tap needs the "System Audio Recording" permission and `NSAudioCaptureUsageDescription` (macOS 14.2+); both are granted per app bundle identity. Carbon `RegisterEventHotKey` needs no permission.
- Core Audio per-process objects (macOS 14.2+) give "which app is using the microphone": `kAudioHardwarePropertyProcessObjectList` (FourCC `prs#`), `kAudioProcessPropertyPID` (`ppid`), `kAudioProcessPropertyBundleID` (`pbid`), `kAudioProcessPropertyIsRunningInput` (`piri`). Verify FourCCs against Apple's `AudioHardware.h` documentation before relying on them.
- Data folder: `~/Library/Application Support/OpenMeetPy`. There is no previous macOS OpenMeet, so `old_data_dir()` has nothing to import on a Mac.
- APFS is case-insensitive by default.
- A one-file PyInstaller bundle is not a good macOS GUI app. Build `--windowed --onedir`, which PyInstaller wraps in `OpenMeet.app`.

## Architecture seams (already in the code)

| Seam         | Where                                                                                                                                                                                                                                                                        | Contract                                                                                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture      | `audio/audio_backend.py`: `CaptureBackend` protocol, `DeviceInfo(id, name, index, rate, channels)`, `AudioCallback = (bytes, frames, gap) -> None`, float32 interleaved samples, `Stream.stop()` returns only after no callback can run, `Stream.error()` is None after stop | The recorder needs two devices: one from `input_devices()` and one from `output_devices()` (the "system" track). Ids are stable strings, `mic:<name>` and `loopback:<name>` on Windows. |
| Desktop      | `platform/win32.py`: `Win32` protocol (`threaded`, `register_hotkey`, `unregister_hotkey`, `pump`, `wake`, `quit_pump`, `flash_window`), `win32_from_env()`                                                                                                                  | `HotkeyService` and the server only use this protocol. The macOS object implements the same protocol.                                                                                   |
| Detection    | `platform/detection.py`: `ConsentRegistry.entries() -> list[ConsentEntry]`, `consent_from_env`, `supported()`                                                                                                                                                                | The macOS source yields the same entries shape, so `DetectionService` is unchanged.                                                                                                     |
| Credentials  | `platform/keys.py`: `_backend()`                                                                                                                                                                                                                                             | Same functions, macOS backend class.                                                                                                                                                    |
| Paths        | `paths.py`                                                                                                                                                                                                                                                                   | `default_data_dir()`, `old_data_dir()`.                                                                                                                                                 |
| Engine       | `local_ai/catalog.json` backends, `local_ai/engine.py`, `local_ai/hardware.py` returns a dict with `backend`, `vram_bytes`, RAM fields                                                                                                                                       | A new backend key `metal`.                                                                                                                                                              |
| Speech gates | `speech/stt.py`, `sherpa_models.py`, `streaming_models.py` `supported()`                                                                                                                                                                                                     | Currently Windows x64 only.                                                                                                                                                             |

Shared names that several lanes rely on (do not rename): `src/shared/lib/platform.ts` exports `isMac()` and `credentialStoreName()`. The frontend learns the platform from the user agent only; there is no backend platform field.

## Lanes

Each lane is one agent. Files listed are the only files you may touch (plus new test files named in the lane).

### A1. Capture backend dispatch and microphone

Files: `backend/openmeet_py/audio/audio_backend.py` (only `make_backend` and a small import), new `audio/audio_backend_mac.py`, `audio/recorder.py` (only if a message or check is Windows-specific), new `backend/tests/test_audio_backend_mac.py`.

- `make_backend()` returns `MacBackend` on darwin, `PortAudioBackend` on win32, `FakeBackend` when `OPENMEET_PY_FAKE_AUDIO=1` (unchanged).
- `MacBackend` implements `CaptureBackend`. `name = "coreaudio"`.
- `input_devices()`: real input devices through `sounddevice` (lazy import). Ids `mic:<name>` with the same duplicate-name rule as `_with_stable_ids`. Use the device's default sample rate and its input channel count (cap at what the recorder accepts: check `recorder.py` limits).
- `open_stream` for mic ids opens a `sounddevice.InputStream` (dtype float32, callback copies to bytes and calls `on_audio(bytes, frames, gap)` where gap is true when the status reports an overflow). `stop()` waits for the callback, closes, never raises twice. `error()` reports a stream that died by itself.
- Map PortAudio errors, including a denied microphone, to `BackendError` with a short message: "OpenMeet does not have microphone access. Allow it in System Settings, Privacy & Security, Microphone."
- System audio comes from lane A2. Use only this interface from `audio/system_tap_mac.py` (A2 writes it): `tap_unavailable_reason() -> Optional[str]` (None when usable), `default_format() -> tuple[int, int]` (rate, channels), `open_tap(on_audio: AudioCallback) -> Stream`. Until A2 lands, code against that interface and test it with a fake module in `sys.modules`.
- `output_devices()` returns one synthetic `DeviceInfo(id="loopback:system", name="System audio (all apps, includes OpenMeet playback)", index=0, rate=<from default_format()>, channels=<from default_format()>)` when `tap_unavailable_reason()` is None, else an empty list. `open_stream` for that id calls `open_tap`.
- `supported()` is true on darwin when `sounddevice` imports.
- Tests: ids, duplicate names, the synthetic system device, error mapping, stop and error semantics, the callback gap flag. Fakes only.

### A2. System audio tap

Files: new `backend/openmeet_py/audio/system_tap_mac.py`, new `backend/tests/test_system_tap_mac.py`.

- Capture everything the Mac plays (all processes) through a Core Audio process tap, using `catap` 0.6.0. Read the `catap` README and source on PyPI and GitHub first and code against its real API; cite what you used in the module docstring. If `catap` cannot give a stream of PCM to a callback, implement the tap with `ctypes` over `AudioHardwareCreateProcessTap` and an aggregate device instead, and say so in your report.
- Interface (exactly these names, A1 depends on them): `tap_unavailable_reason() -> Optional[str]`, `default_format() -> tuple[int, int]`, `open_tap(on_audio) -> Stream` where `Stream` has `stop()` and `error()` as in `audio_backend.py`.
- `tap_unavailable_reason()` returns a short user-facing string when the OS is older than 14.2 (use `platform.mac_ver()`), when `catap` cannot be imported, or when the platform is not darwin. Otherwise None.
- Output to the callback: float32 interleaved at `default_format()` rate and channels. If the tap delivers another format, convert it in the module (numpy is available) and document it. Never block in the audio callback: copy and hand off.
- Permission denied or tap creation failure raises `BackendError` (import it from `audio_backend`) with: "OpenMeet could not capture system audio. Allow it in System Settings, Privacy & Security, System Audio Recording."
- `stop()` returns only after no callback can run again and tears down the tap and aggregate device. `error()` is None after stop.
- The tap must not include a "mute" behaviour: capture must be unmuted passthrough, so the user still hears the audio.
- Tests: fake `catap` in `sys.modules`; test unavailable reasons, format conversion, stop ordering, error reporting.

### B. Global shortcuts and Dock attention

Files: `backend/openmeet_py/platform/win32.py` (only `win32_from_env`, plus a one-line docstring change), new `platform/macos.py`, `platform/hotkeys.py`, `backend/tests/test_hotkeys*.py` and a new `backend/tests/test_macos_desktop.py`.

- New `NativeMacOS` in `platform/macos.py` implements the `Win32` protocol (same method names, `threaded = False`). `win32_from_env()` returns it on darwin (keep the fake switch `OPENMEET_PY_FAKE_HOTKEYS=1` and the non-win32 fake behaviour for every other platform).
- Hotkeys: Carbon `RegisterEventHotKey` / `UnregisterEventHotKey` plus `InstallEventHandler` on the application event target, through `ctypes` against `Carbon.framework` (no extra pyobjc needed; do not use `pynput`, it needs Accessibility). The handler is a ctypes callback; when a hotkey fires, post a `Message` to whatever `HotkeyService` expects for non-threaded mode (read `HotkeyService` and `Message`). pywebview already runs the Cocoa main loop on the main thread, which is what delivers Carbon events. Marshal register and unregister calls onto the main thread (`PyObjCTools.AppHelper.callAfter`, or `dispatch_async` via ctypes) and wait for the result with a timeout.
- `register_hotkey(hotkey_id, modifiers, vk)` keeps the existing signature. Keep `MOD_*` as platform-neutral bits in `hotkeys.py` and translate to Carbon modifier masks (cmdKey 0x100, shiftKey 0x200, optionKey 0x800, controlKey 0x1000) inside `macos.py`. Translate the existing key tokens to macOS virtual key codes (kVK_ANSI_*, kVK_Space, arrows, F-keys) with a table in `macos.py`; unknown tokens make `register_hotkey` return False.
- In `hotkeys.py`: `CommandOrControl` means Command on macOS and Control on Windows. The validation message must say "Add Command, Control or Option" on macOS and keep today's Ctrl or Alt text on Windows. Saved accelerator strings stay in the same format so settings stay portable.
- `flash_window(title)`: Dock bounce through `NSApp.requestUserAttention_(NSInformationalRequest)` (lazy `AppKit` import, on the main thread). Return False when unavailable.
- Tests: parse and validate on both platforms (monkeypatch `sys.platform`), the modifier and key-code tables, `win32_from_env` dispatch, and `NativeMacOS` with a fake Carbon library object passed in.

### C. Meeting detection

Files: `backend/openmeet_py/platform/detection.py`, new `platform/detection_mac.py`, `backend/tests/test_detection*.py`, new `backend/tests/test_detection_mac.py`.

- New `MacConsentRegistry` (name it that, it implements `ConsentRegistry`) in `detection_mac.py`: which processes are using the microphone right now, from Core Audio process objects (see verified facts). Use `ctypes` against `CoreAudio.framework` (`AudioObjectGetPropertyData`, `AudioObjectGetPropertyDataSize`) with the library handle injectable. Entries must map onto `ConsentEntry` so `DetectionService.tick` works unchanged; read how `in_use(start, stop)` and `ConsentEntry` work and choose values so an active input counts as in use (for example start=now, stop=0) and an idle one does not.
- Skip OpenMeet's own bundle id (see `own_file_name()` and `DetectionService(own=...)`; add a macOS own-id that resolves to the app bundle id `dev.openmeet.app`, constant in `detection_mac.py`).
- Display name: use the bundle id's last meaningful component or `NSWorkspace` through a lazy import; keep `display_name(key)` behaviour for Windows keys unchanged.
- `consent_from_env` returns `MacConsentRegistry()` on darwin; `supported()` is true on darwin. If the OS is older than 14.2, `supported()` is false.
- Detection reads nothing but "which app uses the microphone". No screen, camera or audio content access.
- Tests: fake CoreAudio handle returning two process objects (one using input, one idle), own-app skipping, bundle id naming, `supported()` on both platforms.

### D1 and D2. Credentials, paths, importer and the window

Two agents. D1 owns `platform/keys.py`, `paths.py`, `infra/importer.py` and their tests. D2 owns `app.py` and its tests. Files: `backend/openmeet_py/platform/keys.py`, `paths.py`, `infra/importer.py` (only the case-insensitivity helper and its docstring), `app.py`, and their tests (`test_keys*.py`, `test_paths*.py`, importer tests, `test_app*.py`), plus new tests as needed.

- `keys.py`: on darwin construct `keyring.backends.macOS.Keyring()` explicitly; Windows unchanged. Update the docstrings that say "Windows Credential Manager" to "the OS credential store" where they are generic. `use_backend` keeps working.
- `paths.py`: `default_data_dir()` returns `~/Library/Application Support/OpenMeetPy` on darwin. `old_data_dir()` on darwin returns a path that never exists (`<data>/../OpenMeetPy-no-previous-app`) unless `OPENMEET_OLD_DATA_DIR` is set, so the first-run importer shows nothing on a Mac. Also make `_bundle_root()` and `migrations_dir()` correct inside a PyInstaller `--onedir` macOS bundle (`sys._MEIPASS` still applies; check `Contents/Frameworks` vs `Contents/Resources` for PyInstaller 6 onedir and say what you found).
- `infra/importer.py`: treat darwin like Windows for case-insensitive relative-path matching.
- `app.py`: keep it working on macOS. The window: title "OpenMeet", sensible min size, the close-guard hook (`window.events.closing`) tested for how pywebview reports it on Cocoa; add a standard app menu with Quit (Cmd+Q) and Settings (Cmd+,) only through pywebview's own menu API if it supports them in 6.2.1 (read its source in `backend/.venv` first), otherwise skip the menu and say so. The icon comes from the bundle on macOS, so do not pass one. `--smoke` and `--data-dir` keep working. No Windows-only imports at module top level.
- Update the user-facing text in these files that says Windows when it should say the platform (for example the closing-save message, if any).
- Tests: key backend selection on both platforms, data dirs on both platforms, importer case matching.

### E1. Local AI engine install and catalog

Files: `backend/openmeet_py/local_ai/engine.py`, `catalog.py`, `catalog.json`, their tests (`test_local_ai*.py` that touch them), plus new tests.

- Add backend `metal` to `catalog.json` with the single tarball pin from the verified facts (url, size, sha256). Keep the Windows backends exactly as they are. Update the provenance note in the catalog without mentioning Rust or Tauri.
- `engine.py`: support `.tar.gz` next to `.zip`. Extraction must be as safe as the zip path: no absolute paths, no `..`, no links that point outside the destination, member and total size caps, no device files, reject duplicates. Symlinks inside the archive (shared library names) are allowed only when relative and resolving inside the destination. Keep the executable bit (`chmod 0o755` on `llama-server` and on `.dylib` files). Find the server binary by basename `llama-server` (the tarball may nest one top-level directory). The program name is `llama-server.exe` on Windows and `llama-server` on macOS; centralise it in one function.
- Replace any hard-coded `.zip` assumption in URL validation with a check for the two allowed suffixes.
- `catalog.fit` and `offload_layers` stay as they are (E2 makes the hardware probe report unified memory as `vram_bytes`). Only add a docstring line saying so.
- Tests: tar extraction (good archive, traversal, absolute path, escaping symlink, oversize), program name per platform, catalog loads with the `metal` entry and its hash check.

### E2. Local AI server and hardware

Files: `backend/openmeet_py/local_ai/server.py`, `hardware.py`, `service.py` (only platform-specific lines), and their tests.

- `hardware.detect()` on darwin arm64: `backend="metal"`, GPU name "Apple GPU" (or the chip name from `sysctl -n machdep.cpu.brand_string`), total RAM from `sysctl -n hw.memsize`, available RAM from `vm_stat` (free + inactive + speculative pages times page size). Because memory is unified, report `vram_bytes = int(0.65 * total_ram)` and say why in a comment. Keep all Windows behaviour and tests. The probes stay injectable like the existing `memory=` and `adapters=` parameters.
- `server.py`: on darwin start `llama-server` with `start_new_session=True`, kill the whole process group on stop, and also register an `atexit` and SIGTERM handler. macOS has no Job object, so a hard kill of OpenMeet can orphan the server: write a pid file in the Local AI data folder and, on the next start, kill a stale pid only after confirming the process command name is `llama-server`. Windows Job-object code stays untouched and unreachable on darwin. No console-window flags on darwin.
- Anything in `service.py` that builds the `llama-server.exe` path or assumes `.exe` must use the helper E1 adds (`engine.server_program()` or whatever E1 names it). To avoid a clash, in `service.py` only touch `sys.platform` branches; if a rename is needed, report it.
- Tests: hardware parse for darwin with fake sysctl and vm_stat output, server argv and process-group kill with a fake `subprocess`, stale pid handling.

### F. Local speech gates

Files: `backend/openmeet_py/speech/stt.py`, `sherpa_models.py`, `streaming_models.py`, `model_library.py`, `safe_archive.py` (only if they have a platform or Windows assumption), and their tests.

- Replace each "Windows x64 only" gate with a shared check for the two supported targets: `sys.platform == "win32"` with amd64, or `sys.platform == "darwin"` with arm64. Put the helper in one place (`stt.py`, imported by the others) and keep the current error messages for unsupported platforms, reworded to "needs Windows x64 or a Mac with Apple silicon".
- Check the engines for other Windows assumptions: DLL or path handling, `.exe` names, `os.add_dll_directory`, backslashes, `CREATE_NO_WINDOW`, archive formats (sherpa model archives are `.tar.bz2`: confirm `safe_archive.py` handles them with the same safety on any OS).
- Whisper on macOS is the CPU `pywhispercpp` wheel. Thread count and any GPU flag must not assume CUDA or Vulkan.
- Tests: the gate on both platforms and on x64 macOS (unsupported), model install paths on a posix layout.

### G1 and G2. Frontend

Two agents. G2 owns only `src/widgets/setup-panel/SetupPanel.tsx`, `src/features/calendar/CalendarSettings.tsx`, `src/shared/api/api.ts` (comments only) and their tests. G1 owns every other file below. Files: `src/shared/lib/shortcut-label.ts` (+test), `src/app/App.tsx` (only the shortcut handler and its comment), `src/widgets/command-palette/CommandPalette.tsx`, `src/widgets/meeting-sidebar/MeetingSidebar.tsx`, `src/widgets/meeting-workspace/MeetingWorkspace.tsx` (only key-hint and title strings), `src/widgets/settings-panel/SettingsPanel.tsx`, `src/widgets/setup-panel/SetupPanel.tsx`, `src/features/calendar/CalendarSettings.tsx`, `src/shared/api/api.ts` (comments only), and the tests of those files.

- Use `isMac()` and `credentialStoreName()` from `src/shared/lib/platform.ts` (already exists; import by relative path from `shared/lib`, respecting the FSD rules in `AGENTS.md`).
- Key labels: Mac shows `⌘` for Command, `⌥` for Option, `⌃` for Control, `⇧` for Shift; Windows keeps `Ctrl`, `Alt`, `Shift`. `shortcut-label.ts` renders `CommandOrControl` as `⌘` on Mac and `Ctrl` on Windows; `Meta`/`Command` as `⌘` on Mac and `Win` on Windows.
- Hint strings that say `Ctrl K`, `Ctrl+I`, `Ctrl+Shift+T` and the command-palette key lists become platform-aware (a tiny helper in `shortcut-label.ts` is fine).
- Keyboard handlers: on Mac the app shortcuts fire on `metaKey` (Cmd), not `ctrlKey`; on Windows on `ctrlKey`. Do not let Ctrl+K also fire on Mac, and do not break text-field shortcuts (Cmd+C, Cmd+V, Cmd+A, Cmd+Z must reach text fields).
- Settings shortcut recorder: on Mac, `metaKey` records `CommandOrControl` (that is what the backend expects for Command), `ctrlKey` records `Control`, `altKey` `Alt`, and the "needs a modifier" hint says "Add Command, Control or Option" on Mac.
- Replace "Windows Credential Manager", "Recording needs Windows." and "system follows Windows" wording with platform-neutral or platform-aware text.
- Tests must stub `navigator.userAgent` for both platforms (see `platform.test.ts`).
- Run the full frontend checks at the end.

### H1 and H2. Packaging

Two agents. H1 owns `packaging/build.sh`, `packaging/macos/entitlements.plist` and `justfile`. H2 owns `packaging/macos/make-icns.py` and `packaging/openmeet.icns`. The plist keys go into the build script through PyInstaller's `--osx-bundle-identifier` and a post-build `plutil` or `PlistBuddy` step.

- `packaging/build.sh` (bash, `set -euo pipefail`, runs on the Mac): same steps as `packaging/build.ps1` (read it): build the UI into `backend/web` with `pnpm exec vite build`, create or reuse the backend venv with `uv sync --project backend --locked`, then run PyInstaller `--windowed --onedir --name OpenMeet --osx-bundle-identifier dev.openmeet.app` with the same data and hidden-import collection flags as the Windows script, minus `pyaudiowpatch`, plus `--collect-all sounddevice`, `--collect-all catap` and `--collect-submodules` for what the mac code imports lazily (list them from the `*_mac.py` modules and `platform/macos.py`; PyInstaller cannot see lazy imports). Add the plist keys `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`, `LSMinimumSystemVersion` 14.2, `NSHighResolutionCapable` true, `LSApplicationCategoryType` public.app-category.productivity.
- Ad-hoc sign the bundle (`codesign --force --deep --sign - --entitlements packaging/macos/entitlements.plist --options runtime`), with entitlement `com.apple.security.device.audio-input`. Say in comments that ad-hoc signing makes permissions per-build, so a rebuilt app may need microphone and system-audio permission granted again, and that there is no notarization.
- Create `packaging/dist/OpenMeet-<version>-arm64.dmg` with `hdiutil create -srcfolder`; read the version from `backend/pyproject.toml`.
- Smoke step at the end: run `OpenMeet.app/Contents/MacOS/OpenMeet --smoke --data-dir <tmp>` and grep the build log for `Failed to collect submodules for 'pydantic'`, like the Windows flow documents. Exit non-zero on failure.
- `make-icns.py`: render `packaging/openmeet-icon.svg` to a 1024 px PNG with the headless Chromium at `C:/Users/Rahul/AppData/Local/hermes/tools/chromium-1208/chrome-win64/chrome.exe` (`--headless --screenshot --window-size=1024,1024 --default-background-color=00000000`), then write `packaging/openmeet.icns` with Pillow's ICNS writer. Generate the file now and report its size. The script must also work on a Mac with Pillow.
- `justfile`: add `[macos]` recipes `build` and `smoke` for `build.sh` and the `.app`, keep the `[windows]` shell setting and existing recipes working on Windows (`just --fmt --check`). Use `[windows]` and `[macos]` attributes so the same recipe names exist for both.
- You cannot run `build.sh` here. Check it with `bash -n` and read it twice. Say so in your report.

### I. Documentation

Files: new `docs/macos.md`, `docs/development.md`, `docs/privacy.md`, `docs/dependencies.md`, `docs/README.md`, `README.md`, `THIRD_PARTY_LICENSES.md`. Do this lane only after the code lanes have reported (the parent starts it).

- `docs/macos.md`: what works, what is unqualified, install (download the DMG, drag to Applications, right-click Open the first time, or `xattr -dr com.apple.quarantine`), permissions (Microphone, System Audio Recording, and that a rebuilt unsigned app may ask again), where data lives, shortcuts, how to build on a Mac, Local AI on 8 GB.
- README: add a short macOS install and build section. `docs/privacy.md`: Keychain wording. `docs/dependencies.md` and `THIRD_PARTY_LICENSES.md`: `sounddevice`, `catap`, `pyobjc-framework-Carbon`, `pyobjc-framework-CoreAudio`, with real licences from PyPI metadata.
- Keep every claim honest: written and unit-tested with fakes, not run on a Mac.
