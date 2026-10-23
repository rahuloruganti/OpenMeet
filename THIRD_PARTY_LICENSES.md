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
| `wasapi` (Windows only; process-loopback capture of all app audio)                | MIT             | [wasapi-rs](https://github.com/HEnquist/wasapi-rs)                                 |
| `http-range`, transitive through Tauri playback support                         | MIT               | [http-range](https://github.com/bancek/rust-http-range)                            |
| `tokio`, transitive runtime dependency                                          | MIT               | [Tokio](https://github.com/tokio-rs/tokio)                                         |
| `tar` 0.4.46, `filetime` 0.2.29, `xattr` 1.6.1 (archive extraction for the sherpa-onnx bundle) | MIT OR Apache-2.0 | [tar-rs](https://github.com/composefs/tar-rs), [filetime](https://github.com/alexcrichton/filetime), [xattr](https://github.com/Stebalien/xattr) |
| `bzip2` 0.6.1 (`.tar.bz2` decompression)                                        | MIT OR Apache-2.0 | [bzip2-rs](https://github.com/trifectatechfoundation/bzip2-rs)                     |
| `libbz2-rs-sys` 0.2.5, transitive under `bzip2`                                 | bzip2-1.0.6       | [libbzip2-rs](https://github.com/trifectatechfoundation/libbzip2-rs)               |

Rust license checks use [deny.toml](deny.toml). An allowed SPDX identifier does not remove the need to include the appropriate notice text. OS runtimes and build tools have their own distribution terms.

## Optional speech downloads

| Artifact                                                       | License                                                                     | Source                                                                                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| whisper.cpp Windows binary, release `b5454`                    | MIT for whisper.cpp; review packaged binary contents before redistribution. | [whisper.cpp](https://github.com/ggml-org/whisper.cpp)                                                                       |
| Whisper base, small, and large-v3-turbo weights in ggml format | MIT                                                                         | [OpenAI Whisper](https://github.com/openai/whisper), [ggml model distribution](https://huggingface.co/ggerganov/whisper.cpp) |
| Silero VAD v5.1.2 in ggml format                               | MIT                                                                         | [Silero VAD](https://github.com/snakers4/silero-vad), [ggml distribution](https://huggingface.co/ggml-org/whisper-vad)       |
| sherpa-onnx v1.13.8 Windows x64 shared runtime (`sherpa-onnx-v1.13.8-win-x64-shared-MT-Release-no-tts`) | Apache-2.0 | [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) |
| ONNX Runtime, as bundled inside the sherpa-onnx runtime archive | MIT | [ONNX Runtime](https://github.com/microsoft/onnxruntime). Verify the bundled version and notice text before release. |
| Silero VAD `silero_vad.onnx` for sherpa-onnx (sherpa-onnx `asr-models` release) | MIT | [Silero VAD](https://github.com/snakers4/silero-vad). Verify before release. |
| NVIDIA Parakeet TDT 0.6B v3, int8 sherpa-onnx export | CC-BY-4.0 | [NVIDIA model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3). Verify upstream attribution against the pinned repo card before release; the v2 repo card was recorded as CC-BY-4.0. |
| Moonshine base (English), quantized sherpa-onnx export | MIT (verify) | [Useful Sensors Moonshine](https://github.com/usefulsensors/moonshine). The Moonshine tiny English export's LICENSE file is MIT. Verify the base model's license before release. |
| SenseVoice small (zh/en/ja/ko/yue), int8 sherpa-onnx export | Verify before release | [FunASR SenseVoice](https://github.com/FunAudioLLM/SenseVoice). Expected FunASR Model Open Source License; not confirmed from a local model card. |

No speech engine or model weights are embedded by the application build. They download only on an explicit Settings action. Their pinned URLs, sizes, and checksums live in `src-tauri/src/stt.rs`.

## Development tools and other material

[just](https://github.com/casey/just) is CC0-1.0 and installed separately. Other system/build tools and optional agent skills are development tooling, not bundled application features. Agent-skill licenses belong to their installed packages and are outside this application dependency inventory.

User-selected OpenAI-compatible services are governed by their provider terms, not a bundled software license. The reqwest multipart feature additionally resolves `mime_guess` 2.0.5 under MIT and `unicase` 2.10.0 under MIT OR Apache-2.0. This feature update is not a complete transitive release audit.

The fictional meeting fixture and app icon were authored for this project under its MIT license. Meetily was reviewed as a reference; its source was not copied. Diarization and LLM weights are neither bundled nor downloaded by the current app.

## Python build credential storage

The Python desktop build (`py/`) stores provider API keys through `keyring` in the Windows Credential Manager. Pinned in `py/requirements.txt` with their Windows dependencies: keyring 25.7.0 (MIT), jaraco.classes 3.4.0, jaraco.context 6.1.2, jaraco.functools 4.6.0 and more-itertools 11.2.1 (MIT), and pywin32-ctypes 0.2.3 (BSD-3-Clause). Licenses are taken from upstream project metadata and are not yet audited against the installed wheels.

## Python build audio capture

The Python desktop build (`py/`) records microphone and WASAPI loopback audio through `PyAudioWPatch` 0.2.12.9, pinned in `py/requirements.txt` and installed from a prebuilt wheel only (`--only-binary=:all:`). Its license is Apache-2.0 (the `LICENSE.txt` in the wheel, copyright 2022 S0D3S). The wheel metadata says it is based on PyAudio v0.2.12, which its metadata describes as MIT licensed, and on PortAudio v19 at commit 8b6d16f26ad660e68a97743842ac29b939f3c0c1. The wheel bundles a PortAudio build (`_portaudiowpatch` extension). Neither the MIT text nor a PortAudio license text is in the wheel, so both must be collected from their upstream sources before any release. This entry is not a legal clearance.

## Python build speech (phase 4a)

The Python desktop build (`py/`) transcribes in-process through `pywhispercpp` 1.5.1, pinned with `numpy` 2.5.4 in `py/requirements.txt` and installed from wheels only. License labels below are the installed packages' metadata (`METADATA` in each `.dist-info`), not a legal review. `pywhispercpp` (MIT) bundles native whisper.cpp libraries (`_pywhispercpp` extension, `whisper` and `ggml` DLLs). Its metadata does not state the bundled whisper.cpp version, so it is not confirmed to match the Rust app's `b5454`. Bundled numpy metadata: `BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0`. The numpy wheel ships its own LICENSE files, which must be kept with any redistributed build. Transitive packages pulled in by `requests` are listed too.

| Component | License (package metadata) | Source |
| --- | --- | --- |
| `pywhispercpp` 1.5.1 | MIT | [pywhispercpp](https://github.com/absadiki/pywhispercpp), [whisper.cpp](https://github.com/ggml-org/whisper.cpp) |
| `numpy` 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | [NumPy](https://github.com/numpy/numpy) |
| `requests` 2.34.2 | Apache-2.0 | [Requests](https://github.com/psf/requests) |
| `tqdm` 4.70.1 | MPL-2.0 AND MIT | [tqdm](https://github.com/tqdm/tqdm) |
| `platformdirs` 4.13.5 | MIT | [platformdirs](https://github.com/tox-dev/platformdirs) |
| `charset-normalizer` 3.5.2, `urllib3` 2.8.0 (via `requests`) | MIT | [charset-normalizer](https://github.com/jawah/charset_normalizer), [urllib3](https://github.com/urllib3/urllib3) |
| `idna` 3.20 (via `requests`) | BSD-3-Clause | [idna](https://github.com/kjd/idna) |
| `certifi` 2026.10.23 (via `requests`) | MPL-2.0 | [certifi](https://github.com/certifi/python-certifi) |

Model files are downloaded only by an explicit Settings action and are checked against the pinned SHA-256 (see `py/openmeet_py/stt_catalog.py`, generated from `src-tauri/src/stt/stt_models.rs`). Their license entries are the existing ones above (Whisper ggml models and Silero VAD, MIT as recorded for the Rust app); this change did not re-verify them. The Silero VAD URL names the repository branch `main`, not a commit; the pinned SHA-256 is what guards its content. No model file is bundled in the executable.

## Python build speech, sherpa-onnx (phase 4b)

The Python desktop build (`py/`) runs sherpa-onnx in-process, pinned in `py/requirements.txt` to 1.13.8 and installed from wheels only. License labels are the installed wheels' metadata (`METADATA` and `licenses/LICENSE` in each `.dist-info`), not a legal review. The model rows repeat the Rust app's entries above; they were not re-verified from any installed file, and the Python build downloads them only through the pinned SHA-256 catalog (`py/openmeet_py/stt_catalog.py`).

| Component | License | Source |
| --- | --- | --- |
| `sherpa-onnx` 1.13.8 (Python package) | Apache-2.0 (`licenses/LICENSE` in the wheel is the Apache License 2.0 text) | [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) |
| `sherpa-onnx-core` 1.13.8 (native runtime, `sherpa_onnx/lib`) | Apache-2.0 (metadata only; the wheel has no license file) | [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) |
| ONNX Runtime, as bundled in `sherpa-onnx-core` (`onnxruntime.dll`) | Not confirmed from the wheel. Verify the bundled version and notice text before release. | [ONNX Runtime](https://github.com/microsoft/onnxruntime) |
| Silero VAD `silero_vad.onnx` (sherpa-onnx `asr-models` release) | MIT, as recorded for the Rust app. Verify before release. | [Silero VAD](https://github.com/snakers4/silero-vad) |
| NVIDIA Parakeet TDT 0.6B v3, int8 sherpa-onnx export | CC-BY-4.0 (attribution required), as recorded for the Rust app. Verify against the pinned repository card before release. | [NVIDIA model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) |
| Moonshine base (English), quantized sherpa-onnx export | MIT (verify), as recorded for the Rust app | [Useful Sensors Moonshine](https://github.com/usefulsensors/moonshine) |
| SenseVoice small (zh/en/ja/ko/yue), int8 sherpa-onnx export | **UNCONFIRMED.** The Rust app records "Verify before release"; a FunASR license is expected but not confirmed from a local model card. | [FunASR SenseVoice](https://github.com/FunAudioLLM/SenseVoice) |

The sherpa-onnx packages carry no model. Downloaded models are not bundled in `py/dist`. This is not a legal clearance.

## User-selected model-library downloads

Phase 2 adds no bundled models or dependencies. Public Hugging Face downloads display repository license metadata and retain it in a local provenance manifest. Generic GGUF models carry their own repository terms; discovery or a download entry is not a completed license audit. The existing pinned Whisper catalog remains the only directly importable speech-model catalog.
