# Third-party inventory — foundation preview

This is an initial direct-dependency inventory, **not a complete redistribution notice bundle**. `pnpm-lock.yaml` and `src-tauri/Cargo.lock` contain exact resolved dependencies. CI checks Rust licenses against `deny.toml`; collect the complete transitive license texts before distributing an installer.

| Component                                                                          | License / source                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Tauri, tauri-build, official dialog/global-shortcut/single-instance plugins        | MIT OR Apache-2.0; https://github.com/tauri-apps                 |
| React, React DOM                                                                   | MIT; https://github.com/facebook/react                           |
| Vite, Vitest, React Vite plugin                                                    | MIT; https://github.com/vitejs and https://github.com/vitest-dev |
| TypeScript                                                                         | Apache-2.0; https://github.com/microsoft/TypeScript              |
| Testing Library, ESLint, typescript-eslint, Prettier, jsdom, DefinitelyTyped types | MIT; respective package manifests and license files              |
| rusqlite                                                                           | MIT; https://github.com/rusqlite/rusqlite                        |
| | col1 | col2 | col3 |
| ---- | ---- | ---- |
|      |      |      |
|      |      |      |

Bundled SQLite                                         | Public domain; https://www.sqlite.org/copyright.html             |
| serde, serde_json, thiserror, uuid, time, tempfile                                 | MIT OR Apache-2.0; respective crate manifests and license files  |
| cpal                                                                               | Apache-2.0; https://github.com/RustAudio/cpal                    |
| ringbuf (0.5.2 or newer)                                                           | MIT OR Apache-2.0; https://github.com/agerasev/ringbuf           |
| hound                                                                              | Apache-2.0; https://github.com/ruuda/hound                       |
| keyring (+ keyring-core, windows-native-keyring-store, apple-native-keyring-store) | MIT OR Apache-2.0; https://github.com/open-source-cooperative/keyring-rs |
| whisper.cpp (downloaded binary, release b5454) | MIT; https://github.com/ggml-org/whisper.cpp |
| OpenAI Whisper "small" weights in ggml format (downloaded) | MIT; https://github.com/openai/whisper , https://huggingface.co/ggerganov/whisper.cpp |
| Silero VAD v5.1.2 ggml model (downloaded) | MIT; https://github.com/snakers4/silero-vad , https://huggingface.co/ggml-org/whisper-vad |
| zip | MIT; https://github.com/zip-rs/zip2 |
| sha2 | MIT OR Apache-2.0; https://github.com/RustCrypto/hashes |
| reqwest `native-tls` feature (native-tls, hyper-tls, tokio-native-tls; Windows SChannel / macOS Security.framework) | MIT OR Apache-2.0; https://github.com/seanmonstar/reqwest |
| tokio                                                                              | MIT; https://github.com/tokio-rs/tokio                           |

Ponytail skills are local development tools, ignored under `.pi/`; they are not bundled with the app.

No STT, VAD, diarization, or LLM weights are bundled or downloaded by this build. The fictional meeting fixture and app icon were authored for this project under its MIT license. Meetily was reviewed as a reference; its source was not copied.
