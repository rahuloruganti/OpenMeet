# Dependencies

This inventory describes the direct dependencies of the Python-only build (version 0.9.0, Windows 11 x64). It is not a complete redistribution notice bundle; the license labels are in [THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md).

Python versions are pinned in [backend/pyproject.toml](../backend/pyproject.toml) with resolutions in `backend/uv.lock`. JavaScript versions come from [package.json](../package.json) and `pnpm-lock.yaml`. License labels were read from installed package metadata in `backend/.venv` and `node_modules`, not from a legal review.

"Network" says when a package or artifact talks to the network during normal use. Nothing here sends telemetry.

## Build and system tools

| Tool | Requirement | Purpose | Network |
| --- | --- | --- | --- |
| Windows 11 x64 | Only supported platform | WebView2, WASAPI capture, `RegisterHotKey`, Credential Manager | — |
| Python | 3.13 (`>=3.13,<3.14` in `pyproject.toml`) | Run the backend, tests and the packaging build | — |
| pip | Not required | Environment creation and installs go through `uv`; no `pip install` step exists | — |
| uv | Required to build; `uv sync --locked` from `backend/uv.lock` fills `backend/.venv` and `uv run` invokes PyInstaller | Reproduce the exact pinned environment | Package index during sync only |
| Node.js | 24 or newer | Build the React UI, run frontend tests and lint | — |
| pnpm | 12.10.1, pinned in `packageManager`; run through Corepack | Install JavaScript dependencies from the lockfile | Registry during install only |
| WebView2 Runtime | Present on Windows 11 (ships with Edge) | Render the UI inside the app window | — |
| PowerShell | 5.1 or newer, run with `-ExecutionPolicy Bypass` | Run `packaging/build.ps1` | — |
| PyInstaller | 6.22.3 (dev group) | Build the one-file `OpenMeet.exe` | — |
| pytest | 9.1.1 (dev group) | Backend test suite, including the `hardware` and `real_model` markers | — |
| Git | Required to clone and contribute | Source control | — |

The build needs no C compiler, Visual Studio, Windows SDK, CMake or language toolchain: every native piece arrives as a prebuilt wheel, and no speech engine is compiled during the build.

## Python runtime dependencies

Pinned in `[project].dependencies` in [backend/pyproject.toml](../backend/pyproject.toml). All are installed from wheels and bundled into `OpenMeet.exe` by PyInstaller.

| Package | Version | License | Purpose | Network |
| --- | --- | --- | --- | --- |
| `fastapi` | 0.161.1 | MIT | HTTP command API and the `/ws` event stream | Loopback only |
| `uvicorn` | 0.54.0 | BSD-3-Clause | ASGI server bound to `127.0.0.1` on a free port | Loopback only |
| `pywebview` | 6.2.1 | BSD-3-Clause | Desktop window and native folder picker (WebView2 on Windows) | None |
| `httpx` | 0.28.1 | BSD-3-Clause | Outbound HTTPS to model hosts and to configured API connections, with the system proxy ignored so loopback traffic never leaves the machine | Outbound on explicit actions |
| `keyring` | 25.7.0 | MIT | API keys in the Windows Credential Manager (`WinVaultKeyring`) | None |
| `jaraco.classes` | 3.4.0 | MIT | `keyring` support package | None |
| `jaraco.context` | 6.1.2 | MIT | `keyring` support package | None |
| `jaraco.functools` | 4.6.0 | MIT | `keyring` support package | None |
| `more-itertools` | 11.2.1 | MIT | `keyring` support package | None |
| `pywin32-ctypes` | 0.2.3 | BSD-3-Clause | Win32 bindings `keyring` uses for the Credential Manager | None |
| `PyAudioWPatch` | 0.2.12.9 | Apache-2.0 (wheel); bundles PortAudio | WASAPI microphone capture and system-audio loopback as separate streams | None |
| `pywhispercpp` | 1.5.1 | MIT; bundles whisper.cpp and ggml libraries | Local Whisper transcription in-process | None |
| `numpy` | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | Sample buffers, resampling and level meters | None |
| `sherpa-onnx` | 1.13.8 | Apache-2.0 | Second local speech engine (Python API over ONNX Runtime) | None |
| `sherpa-onnx-core` | 1.13.8 | Apache-2.0 | Native runtime shipped with `sherpa-onnx` (`onnxruntime.dll`) | None |
| `websockets` | 15.0.1 | BSD-3-Clause | WebSocket protocol for the event stream; pinned explicitly because `uvicorn` runs without its `standard` extra | Loopback only |

Notes:

- `uvicorn` is installed bare, not with the `standard` extra, so `httptools`, `watchfiles`, `uvloop` and `python-dotenv` are not part of the build. No `.env` file is read.
- `opentelemetry-api` (Apache-2.0) is installed because FastAPI 0.161.1 declares it. OpenMeet configures no tracer, exporter or endpoint; nothing is sent.
- `torch`, a separately packaged `onnxruntime`, `ffmpeg`, SQLite server packages and provider SDKs are not dependencies. SQLite comes from Python's standard library, with FTS5.

## Python transitive packages bundled by the one-file build

Installed in `backend/.venv` and collected by PyInstaller. Listed because they ship inside the executable.

| Package | Version | License | Pulled in by |
| --- | --- | --- | --- |
| `starlette` | 1.9.0 | BSD-3-Clause | `fastapi` |
| `pydantic` | 2.14.1 | MIT | `fastapi` |
| `pydantic-core` | 2.50.1 | MIT | `pydantic` |
| `annotated-doc` | 0.0.5 | MIT | `fastapi` |
| `annotated-types` | 0.8.0 | MIT | `pydantic` |
| `typing-inspection` | 0.4.4 | MIT | `fastapi` |
| `typing_extensions` | 4.16.0 | PSF-2.0 | `fastapi`, `pywebview` |
| `anyio` | 4.15.1 | MIT | `fastapi`, `httpx` |
| `h11` | 0.16.0 | MIT | `uvicorn` |
| `click` | 8.5.0 | BSD-3-Clause | `uvicorn` |
| `opentelemetry-api` | 1.45.1 | Apache-2.0 | `fastapi` (unused; no exporter) |
| `certifi` | 2026.10.23 | MPL-2.0 | `httpx` |
| `idna` | 3.20 | BSD-3-Clause | `httpx` |
| `httpcore` | 1.0.9 | BSD-3-Clause | `httpx` |
| `requests` | 2.34.2 | Apache-2.0 | `pywhispercpp` |
| `urllib3` | 2.8.0 | MIT | `requests` |
| `charset-normalizer` | 3.5.2 | MIT | `requests` |
| `tqdm` | 4.70.1 | MPL-2.0 AND MIT | `pywhispercpp` |
| `platformdirs` | 4.13.5 | MIT | `pywhispercpp` |
| `bottle` | 0.13.4 | MIT | `pywebview` |
| `pythonnet` | 3.2.1 | MIT | `pywebview` (WebView2 host) |
| `clr_loader` | 0.3.1 | unverified (no license field in installed metadata) | `pythonnet` |
| `proxy_tools` | 0.1.0 | MIT | `pywebview` |
| `packaging` | 26.3 | Apache-2.0 OR BSD-2-Clause | `pywhispercpp` |

Build-only packages (PyInstaller, `altgraph` MIT, `pefile` MIT, `pyinstaller-hooks-contrib` Apache-2.0/GPLv2 with the PyInstaller exception, `setuptools` MIT) belong to the build environment, not to the shipped application code.

## Frontend runtime packages

Bundled into the UI the backend serves from `backend/web`, built by Vite.

| Package | Version | License | Use |
| --- | --- | --- | --- |
| `react` | 19.3.0 | MIT | Components, state and effects |
| `react-dom` | 19.3.0 | MIT | Mount the workspace into the document |

Styling is plain CSS. Notes use a textarea, Markdown rendering is implemented in the project, and there is no Tailwind, Tiptap, shadcn/ui, Radix or global state library.

## Frontend development packages

Not shipped to users; they build, check and test the UI.

| Package | Version | License | Use |
| --- | --- | --- | --- |
| `vite` | 8.3.4 | MIT | Production bundle; development server on `127.0.0.1` |
| `@vitejs/plugin-react` | 6.1.2 | MIT | React integration with Vite |
| `typescript` | 5.9.3 | Apache-2.0 | Static type checking |
| `@types/react` | 19.3.0 | MIT | React type declarations |
| `@types/react-dom` | 19.3.0 | MIT | React DOM type declarations |
| `eslint` | 10.12.0 | MIT | Linting |
| `@eslint/js` | 10.0.1 | MIT | Base lint configuration |
| `typescript-eslint` | 8.71.1 | MIT | TypeScript lint integration |
| `prettier` | 3.9.9 | MIT | Source formatting |
| `vitest` | 5.0.3 | MIT | Frontend test runner |
| `jsdom` | 30.1.2 | MIT | DOM environment for tests |
| `@testing-library/react` | 16.3.3 | MIT | Render and query components as a user would |
| `@testing-library/user-event` | 14.6.7 | MIT | Simulate keyboard and pointer input in tests |

## Speech engine and model downloads

Nothing in this table is bundled. Each artifact is downloaded only from **Settings**, and each is checked against a pinned size and SHA-256 before use. The authoritative URLs, sizes and hashes are in `backend/openmeet_py/speech/stt_catalog.py`.

| Artifact | Pinned file | Size (bytes) | Source and role |
| --- | --- | --- | --- |
| Whisper base (English, q5_1) | `ggml-base.en-q5_1.bin` | 59,721,011 | [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp) at commit `5359861c…`; smallest English model |
| Whisper small | `ggml-small.bin` | 487,601,967 | Same repository; default multilingual model |
| Whisper large-v3-turbo | `ggml-large-v3-turbo.bin` | 1,624,555,275 | Same repository; largest selectable model |
| Silero VAD (whisper.cpp) | `ggml-silero-v5.1.2.bin` | 885,098 | [ggml-org/whisper-vad](https://huggingface.co/ggml-org/whisper-vad); voice-activity gate |
| sherpa-onnx Silero VAD | `silero_vad.onnx` | 643,854 | [sherpa-onnx `asr-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models) |
| Parakeet TDT 0.6B v3 (int8) | `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2` | 487,170,055 | Same release; English and European languages |
| Moonshine base (English, quantized) | `sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2` | 111,266,225 | Same release; English only, small and fast |
| SenseVoice small (int8) | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2` | 165,783,878 | Same release; Chinese, Japanese, Korean, Cantonese, English |

The whole Whisper catalog is selectable (tiny through large-v3, including `.en` and quantized variants); the table lists the ones the UI recommends. Model archives come only from `github.com`, `objects.githubusercontent.com` and `release-assets.githubusercontent.com`; Hugging Face files come from `huggingface.co` and its `.hf.co` download hosts. A downloaded sherpa-onnx folder is fetched file by file from the Hub, checked against the Hub's SHA-256, and kept only if every file passes.

Download size is not a performance guarantee: extraction space, inference memory and audio storage are separate.

## External services

Speech and AI are OpenAI-compatible endpoints you configure; no provider SDK is bundled. Credentials live in the Windows Credential Manager. Meeting text and cloud audio go to a connection once you assign it, both for actions you trigger and for the always-on processing after every recording. Provider costs, limits, model support and retention are outside OpenMeet. Local Whisper and sherpa-onnx stay on the device and remain the default. See [privacy](privacy.md#network-actions).

Local servers (Ollama, LM Studio, Unsloth Studio, speaches, LocalAI) are detected over loopback only; OpenMeet installs and starts none of them. Diarization, bots, SharePoint, telemetry, auto-updaters and compression libraries are not integrated.

## Inspect or update the inventory

- Installed Python packages: `backend/.venv/Scripts/python.exe -c "import importlib.metadata as m; print(sorted(d.metadata['Name'] for d in m.distributions()))"`.
- Direct JavaScript packages: `corepack pnpm list --depth 0`; why a package is present: `corepack pnpm why <name>`.
- Frontend bundle contents: `corepack pnpm build`, then inspect `backend/web` (the Vite build output; `vite.config.ts` sets `build.outDir` to it).

When a pin, artifact or lockfile changes, update this page and [THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md) together. Environment setup and checks are in the [development guide](development.md); no license check replaces a release notice audit.

