# Third-party license inventory

OpenMeet source is [MIT licensed](LICENSE). This inventory records direct dependency licenses and selected bundled, downloaded, and transitive components. It is not a complete redistribution notice bundle or legal clearance for a release.

Exact direct versions and purposes are in [dependencies](docs/dependencies.md). Full resolution is in `pnpm-lock.yaml` and `src-tauri/Cargo.lock`. Package license labels were checked against installed package metadata and cached crate manifests. Collect required license texts, copyright notices, model attribution, and notices from platform binaries before distributing a release.

## JavaScript packages

| Component                                               | License           | Source                                                                                              |
| ------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------- |
| `@tauri-apps/api`, `@tauri-apps/cli`                    | Apache-2.0 OR MIT | [Tauri](https://github.com/tauri-apps/tauri)                                                        |
| `react`, `react-dom`                                    | MIT               | [React](https://github.com/facebook/react)                                                          |
| `vite`, `@vitejs/plugin-react`                          | MIT               | [Vite](https://github.com/vitejs/vite), [React plugin](https://github.com/vitejs/vite-plugin-react) |
| `vitest`                                                | MIT               | [Vitest](https://github.com/vitest-dev/vitest)                                                      |
| `typescript`                                            | Apache-2.0        | [TypeScript](https://github.com/microsoft/TypeScript)                                               |
| `@types/react`, `@types/react-dom`                      | MIT               | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped)                               |
| `@testing-library/react`, `@testing-library/user-event` | MIT               | [Testing Library](https://github.com/testing-library)                                               |
| `eslint`, `@eslint/js`                                  | MIT               | [ESLint](https://github.com/eslint/eslint)                                                          |
| `typescript-eslint`                                     | MIT               | [typescript-eslint](https://github.com/typescript-eslint/typescript-eslint)                         |
| `prettier`                                              | MIT               | [Prettier](https://github.com/prettier/prettier)                                                    |
| `jsdom`                                                 | MIT               | [jsdom](https://github.com/jsdom/jsdom)                                                             |

## Rust and native components

| Component                                                                       | License           | Source                                                                             |
| ------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------- |
| `tauri`, `tauri-build`, official dialog/global-shortcut/single-instance plugins | Apache-2.0 OR MIT | [Tauri](https://github.com/tauri-apps)                                             |
| `rusqlite`                                                                      | MIT               | [rusqlite](https://github.com/rusqlite/rusqlite)                                   |
| Bundled SQLite                                                                  | Public domain     | [SQLite copyright statement](https://www.sqlite.org/copyright.html)                |
| `serde`, `serde_json`, `thiserror`, `uuid`, `time`, `tempfile`                  | MIT OR Apache-2.0 | Respective crate manifests and license files in the Cargo registry.                |
| `cpal`                                                                          | Apache-2.0        | [cpal](https://github.com/RustAudio/cpal)                                          |
| `ringbuf`                                                                       | MIT OR Apache-2.0 | [ringbuf](https://github.com/agerasev/ringbuf)                                     |
| `hound`                                                                         | Apache-2.0        | [hound](https://github.com/ruuda/hound)                                            |
| `reqwest` and native TLS dependencies                                           | MIT OR Apache-2.0 | [reqwest](https://github.com/seanmonstar/reqwest) and respective package licenses. |
| `keyring` and native store adapters                                             | MIT OR Apache-2.0 | [keyring-rs](https://github.com/open-source-cooperative/keyring-rs)                |
| `sha2`                                                                          | MIT OR Apache-2.0 | [RustCrypto hashes](https://github.com/RustCrypto/hashes)                          |
| `zip`                                                                           | MIT               | [zip](https://github.com/zip-rs/zip2)                                              |
| `winreg` (Windows only; reads the microphone privacy store for meeting detection) | MIT             | [winreg-rs](https://github.com/gentoo90/winreg-rs)                                 |
| `http-range`, transitive through Tauri playback support                         | MIT               | [http-range](https://github.com/bancek/rust-http-range)                            |
| `tokio`, transitive runtime dependency                                          | MIT               | [Tokio](https://github.com/tokio-rs/tokio)                                         |

Rust license checks use [deny.toml](deny.toml). An allowed SPDX identifier does not remove the need to include the appropriate notice text. OS runtimes and build tools have their own distribution terms.

## Optional speech downloads

| Artifact                                                       | License                                                                     | Source                                                                                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| whisper.cpp Windows binary, release `b5454`                    | MIT for whisper.cpp; review packaged binary contents before redistribution. | [whisper.cpp](https://github.com/ggml-org/whisper.cpp)                                                                       |
| Whisper base, small, and large-v3-turbo weights in ggml format | MIT                                                                         | [OpenAI Whisper](https://github.com/openai/whisper), [ggml model distribution](https://huggingface.co/ggerganov/whisper.cpp) |
| Silero VAD v5.1.2 in ggml format                               | MIT                                                                         | [Silero VAD](https://github.com/snakers4/silero-vad), [ggml distribution](https://huggingface.co/ggml-org/whisper-vad)       |

No speech engine or model weights are embedded by the application build. They download only on an explicit Settings action. Their pinned URLs, sizes, and checksums live in `src-tauri/src/stt.rs`.

## Development tools and other material

[just](https://github.com/casey/just) is CC0-1.0 and installed separately. Other system/build tools and optional agent skills are development tooling, not bundled application features. Agent-skill licenses belong to their installed packages and are outside this application dependency inventory.

User-selected OpenAI-compatible services are governed by their provider terms, not a bundled software license. The reqwest multipart feature additionally resolves `mime_guess` 2.0.5 under MIT and `unicase` 2.10.0 under MIT OR Apache-2.0. This feature update is not a complete transitive release audit.

The fictional meeting fixture and app icon were authored for this project under its MIT license. Meetily was reviewed as a reference; its source was not copied. Diarization and LLM weights are neither bundled nor downloaded by the current app.

## User-selected model-library downloads

Phase 2 adds no bundled models or dependencies. Public Hugging Face downloads display repository license metadata and retain it in a local provenance manifest. Generic GGUF models carry their own repository terms; discovery or a download entry is not a completed license audit. The existing pinned Whisper catalog remains the only directly importable speech-model catalog.
