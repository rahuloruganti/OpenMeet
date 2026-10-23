# Dependencies

This inventory describes direct dependencies in the current checkout. It is not a list of packages proposed in the original plan, and it is not a complete redistribution notice bundle.

JavaScript versions come from [package.json](../package.json) and [pnpm-lock.yaml](../pnpm-lock.yaml). Rust requirements come from [Cargo.toml](../src-tauri/Cargo.toml), with resolved versions from [Cargo.lock](../src-tauri/Cargo.lock). License labels are in [THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md).

## Build and system tools

| Tool                                  | Project requirement                                     | Purpose                                                            |
| ------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| Node.js                               | 24 for development and CI; manifest allows 24 or newer. | Run package tools, frontend development, and builds.               |
| pnpm                                  | 12.10.1, pinned in `packageManager`.                    | Install JavaScript dependencies from the lockfile.                 |
| Corepack                              | Separately installed if absent.                         | Select the project's pinned pnpm version.                          |
| Rust                                  | 1.99.0, pinned in `rust-toolchain.toml`.                | Build the native backend.                                          |
| rustfmt and Clippy                    | Components pinned with the Rust toolchain.              | Format and lint Rust.                                              |
| just                                  | Separately installed; commands verified with 1.58.0.    | Run setup, development, checks, and release build recipes.         |
| Git                                   | Required to clone and contribute.                       | Source control.                                                    |
| MSVC C++ tools, Windows SDK, WebView2 | Windows x64 prerequisites.                              | Native compilation and the Windows webview.                        |
| Xcode command-line tools              | Apple Silicon development prerequisite.                 | macOS shell compilation; does not enable capture or transcription. |
| cargo-deny                            | Optional locally; installed by dependency-hygiene CI.   | Check Rust advisories, allowed licenses, and dependency sources.   |

The current downloaded speech engine is prebuilt. Building OpenMeet does not require compiling whisper.cpp or installing Python, CMake, Ollama, or a separate SQLite server.

## Frontend runtime packages

| Package           | Version | Use                                                              |
| ----------------- | ------- | ---------------------------------------------------------------- |
| `@tauri-apps/api` | 2.12.2  | Commands, events, runtime detection, and local audio asset URLs. |
| `react`           | 19.3.0  | Components, state, and effects.                                  |
| `react-dom`       | 19.3.0  | Mount the workspace into the webview document.                   |

Styling uses plain CSS. Notes use a textarea. Markdown rendering is implemented in the project. Tailwind, Tiptap, shadcn/ui, Radix, and a global state library are not dependencies.

## Frontend development packages

| Package                       | Version | Use                                                      |
| ----------------------------- | ------- | -------------------------------------------------------- |
| `@tauri-apps/cli`             | 2.12.1  | Native development commands.                             |
| `vite`                        | 8.3.4   | Local frontend server and production assets.             |
| `@vitejs/plugin-react`        | 6.1.2   | React integration with Vite.                             |
| `typescript`                  | 5.9.3   | Static type checking.                                    |
| `@types/react`                | 19.3.0  | React type declarations.                                 |
| `@types/react-dom`            | 19.3.0  | React DOM type declarations.                             |
| `eslint`                      | 10.12.0 | Frontend linting.                                        |
| `@eslint/js`                  | 10.0.1  | Base JavaScript lint configuration.                      |
| `typescript-eslint`           | 8.71.1  | TypeScript lint integration.                             |
| `prettier`                    | 3.9.9   | Source and Markdown formatting.                          |
| `vitest`                      | 5.0.3   | Frontend test runner.                                    |
| `jsdom`                       | 30.1.2  | DOM environment for frontend tests.                      |
| `@testing-library/react`      | 16.3.3  | Render and query components as users interact with them. |
| `@testing-library/user-event` | 14.6.7  | Simulate keyboard and pointer interactions in tests.     |

These packages support development; they are not additional native services required on a user's machine.

## Rust packages

The requirement column is the manifest's version constraint. `=` pins an exact version; other requirements can resolve to compatible versions in the lockfile.

| Crate                          | Requirement | Locked version | Use and selected features                                                                                                          |
| ------------------------------ | ----------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `tauri`                        | `=2.12.2`   | 2.12.2         | Desktop shell, IPC, tray icon, and scoped audio asset protocol.                                                                    |
| `tauri-build`                  | `2`         | 2.7.1          | Build dependency for Tauri configuration and resources.                                                                            |
| `tauri-plugin-dialog`          | `2`         | 2.8.1          | Native export-folder picker.                                                                                                       |
| `tauri-plugin-global-shortcut` | `2`         | 2.4.0          | Pause/resume and optional stop shortcuts.                                                                                          |
| `tauri-plugin-single-instance` | `2`         | 2.5.2          | Focus the existing app instead of opening a second backend.                                                                        |
| `rusqlite`                     | `=0.40.2`   | 0.40.2         | SQLite access, with `bundled` SQLite and FTS5 search.                                                                              |
| `serde`                        | `1`         | 1.0.229        | Payload serialization and deserialization with `derive`.                                                                           |
| `serde_json`                   | `1`         | 1.0.151        | Engine output, fixtures, timing indexes, and HTTP payloads.                                                                        |
| `thiserror`                    | `2`         | 2.0.21         | Backend error definitions.                                                                                                         |
| `uuid`                         | `1`         | 1.27.0         | Version-4 meeting IDs and export filename identity.                                                                                |
| `time`                         | `0.3`       | 0.3.55         | RFC 3339 timestamps, with `formatting`.                                                                                            |
| `tempfile`                     | `3`         | 3.27.0         | Temporary downloads, inference output, export publication, and tests.                                                              |
| `cpal`                         | `=0.18.2`   | 0.18.2         | Native audio devices, microphone capture, and Windows output loopback.                                                             |
| `ringbuf`                      | `0.5.2`     | 0.5.3          | Bounded audio sample buffers.                                                                                                      |
| `hound`                        | `3.5`       | 3.5.1          | WAV writing, reading, and recovery.                                                                                                |
| `reqwest`                      | `=0.13.5`   | 0.13.5         | Backend downloads/provider HTTP and multipart audio uploads; defaults disabled, `blocking`, `native-tls`, and `multipart` enabled. |
| `keyring`                      | `4`         | 4.2.0          | API key storage through native OS credential stores.                                                                               |
| `sha2`                         | `0.11`      | 0.11.0         | SHA-256 verification of downloaded artifacts.                                                                                      |
| `zip`                          | `9`         | 9.0.1          | Extract the speech engine; defaults disabled, `deflate` enabled.                                                                   |

Platform adapters, TLS libraries, and async runtimes also appear transitively. For example, Tauri and reqwest bring runtime dependencies even though OpenMeet does not declare a direct Tokio dependency. Do not remove a transitive crate merely because the application does not import it.

## Speech engine and model downloads

These artifacts are downloaded only from **Settings**. They are not bundled with the executable or downloaded by `just setup`. The authoritative URLs, byte lengths, and SHA-256 hashes are in [stt.rs](../src-tauri/src/stt.rs).

| Artifact                           | Pinned release or file         | Download size in bytes | Source and role                                                                                       |
| ---------------------------------- | ------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| whisper.cpp Windows x64 CPU engine | `b5454`, `whisper-bin-x64.zip` | 8,928,640              | [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp), local subprocess.                    |
| Whisper base                       | `ggml-base.bin`                | 147,951,465            | [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp), selectable multilingual model. |
| Whisper small                      | `ggml-small.bin`               | 487,601,967            | Same model repository; default selection.                                                             |
| Whisper large-v3-turbo             | `ggml-large-v3-turbo.bin`      | 1,624,555,275          | Same model repository; selectable multilingual model.                                                 |
| Silero VAD                         | `ggml-silero-v5.1.2.bin`       | 885,098                | [ggml-org/whisper-vad](https://huggingface.co/ggml-org/whisper-vad), voice-activity detection.        |
| sherpa-onnx Windows x64 runtime    | `v1.13.8`, shared MT no-TTS `.tar.bz2` | 23,271,851     | [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), second local engine (Windows x64 only). |
| Silero VAD for sherpa-onnx         | `silero_vad.onnx`              | 643,854                | [sherpa-onnx asr-models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models), voice-activity detection for sherpa models. |
| Parakeet TDT 0.6B v3 (int8)        | sherpa `.tar.bz2` archive      | 487,170,055            | [sherpa-onnx asr-models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models); English and European languages. |
| Moonshine base (quantized, English) | sherpa `.tar.bz2` archive     | 111,266,225            | [sherpa-onnx asr-models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models); English only. |
| SenseVoice small (int8)            | sherpa `.tar.bz2` archive      | 165,783,878            | [sherpa-onnx asr-models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models); Chinese, Japanese, Korean, Cantonese, English. |

Installation fetches the engine, selected Whisper model, and VAD as needed. Switching models retains existing artifacts. Network transfers, extraction space, inference memory, and audio storage are separate from these download sizes. No measured performance guarantee is implied by model selection.

**Python desktop build (`py/`, phase 4b, unverified).** The sherpa-onnx engine is the pip package `sherpa-onnx` 1.13.8 with `sherpa-onnx-core` 1.13.8, pinned in `py/requirements.txt` and installed from wheels only; it is not downloaded. The Python build downloads only the Silero VAD and the selected sherpa archive, so its listed size is the VAD plus the archive (the Rust engine row above is not downloaded). Archives come from GitHub release hosts only (`github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`). A downloaded Hugging Face sherpa-onnx folder is fetched file by file, checked against the Hub SHA-256, and kept only if every file passes. Pinned sizes and hashes are in [py/openmeet_py/stt_catalog.py](../py/openmeet_py/stt_catalog.py). Licences are in [THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md#python-build-speech-sherpa-onnx-phase-4b).

## External service

Users configure independent OpenAI-compatible LLM and cloud-STT API services. No provider SDK is bundled. Credentials belong in the OS keychain; meeting text and cloud audio are sent when you trigger the action or choose automatic processing in Settings, and each cloud connection is labelled Leaves this device. Service costs, limits, supported models/formats, and retention are external to OpenMeet. Local Whisper stays the default. See [privacy](privacy.md#network-actions).

Ollama, diarization engines, bots, SharePoint, telemetry, auto-updaters, and compression libraries described in older plans are not implemented integrations.

## Inspect or update the inventory

Run `corepack pnpm list --depth 0` for installed JavaScript packages and `cargo tree --locked --manifest-path src-tauri/Cargo.toml --depth 1` for direct Rust dependencies. The full lockfiles include transitive packages and multiple versions of some crates.

When a manifest or artifact changes, update this page and the license inventory together. Review feature flags, platform support, artifact licenses, and both lockfiles. Run the relevant checks in the [development guide](development.md#run-checks). License checks do not replace a complete release notice audit.
