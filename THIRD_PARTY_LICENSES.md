# Third-party license inventory

OpenMeet's own source is [MIT licensed](LICENSE). This page lists what the Python-only build actually ships or downloads, with the license label recorded for each. It is an inventory, not legal clearance: collect the notice texts, keep them with the released executable, and re-check anything marked **unverified** before distributing.

Labels for Python packages were read from installed package metadata (`METADATA`, `License-Expression` or `License` field) in `backend/.venv`, and for JavaScript packages from `license` in each `node_modules/*/package.json`. Versions and purposes are in [dependencies](docs/dependencies.md).

## Python runtime packages bundled into OpenMeet.exe

| Component | Version | License | Notes |
| --- | --- | --- | --- |
| `fastapi` | 0.161.1 | MIT | |
| `uvicorn` | 0.54.0 | BSD-3-Clause | |
| `pywebview` | 6.2.1 | BSD-3-Clause | Window host |
| `httpx` | 0.28.1 | BSD-3-Clause | |
| `keyring` | 25.7.0 | MIT | Credential Manager access |
| `jaraco.classes` | 3.4.0 | MIT | `keyring` dependency |
| `jaraco.context` | 6.1.2 | MIT | `keyring` dependency |
| `jaraco.functools` | 4.6.0 | MIT | `keyring` dependency |
| `more-itertools` | 11.2.1 | MIT | `keyring` dependency |
| `pywin32-ctypes` | 0.2.3 | BSD-3-Clause | |
| `PyAudioWPatch` | 0.2.12.9 | Apache-2.0 (wheel metadata) | Bundles PortAudio; see below |
| `pywhispercpp` | 1.5.1 | MIT (wheel metadata) | Bundles whisper.cpp and ggml binaries; see below |
| `numpy` | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | Wheel ships its own LICENSE files; keep them |
| `sherpa-onnx` | 1.13.8 | Apache-2.0 | Python API over ONNX Runtime |
| `sherpa-onnx-core` | 1.13.8 | Apache-2.0 | Native runtime; bundles `onnxruntime.dll` |
| `websockets` | 15.0.1 | BSD-3-Clause | |
| `starlette` | 1.9.0 | BSD-3-Clause | via `fastapi` |
| `pydantic` | 2.14.1 | MIT | via `fastapi` |
| `pydantic-core` | 2.50.1 | MIT | via `pydantic` |
| `annotated-doc` | 0.0.5 | MIT | via `fastapi` |
| `annotated-types` | 0.8.0 | MIT | via `pydantic` |
| `typing-inspection` | 0.4.4 | MIT | via `fastapi` |
| `typing_extensions` | 4.16.0 | PSF-2.0 | |
| `anyio` | 4.15.1 | MIT | via `fastapi`, `httpx` |
| `h11` | 0.16.0 | MIT | via `uvicorn` |
| `click` | 8.5.0 | BSD-3-Clause | via `uvicorn` |
| `opentelemetry-api` | 1.45.1 | Apache-2.0 | Declared by `fastapi`; no exporter is configured and nothing is sent |
| `certifi` | 2026.10.23 | MPL-2.0 | via `httpx` |
| `idna` | 3.20 | BSD-3-Clause | via `httpx` |
| `httpcore` | 1.0.9 | BSD-3-Clause | via `httpx` |
| `requests` | 2.34.2 | Apache-2.0 | via `pywhispercpp` |
| `urllib3` | 2.8.0 | MIT | via `requests` |
| `charset-normalizer` | 3.5.2 | MIT | via `requests` |
| `tqdm` | 4.70.1 | MPL-2.0 AND MIT | via `pywhispercpp` |
| `platformdirs` | 4.13.5 | MIT | via `pywhispercpp` |
| `bottle` | 0.13.4 | MIT | via `pywebview` |
| `pythonnet` | 3.2.1 | MIT | via `pywebview` |
| `clr_loader` | 0.3.1 | **unverified** — the installed metadata carries no license field | via `pythonnet` |
| `proxy_tools` | 0.1.0 | MIT | via `pywebview` |
| `packaging` | 26.3 | Apache-2.0 OR BSD-2-Clause | via `pywhispercpp` |
| `icalendar` | 6.3.2 | BSD-2-Clause | Calendar feed parsing (ICS) |
| `python-dateutil` | 2.9.0.post0 | Apache-2.0 OR BSD-3-Clause (metadata: "Dual License") | Recurrence rules (RRULE/RDATE/EXDATE) |
| `six` | 1.17.0 | MIT | via `python-dateutil` |
| `tzdata` | 2026.5 | Apache-2.0 (IANA time zone data is public domain) | Time zone data for `zoneinfo` on Windows |

## Native components inside those wheels

| Component | Where it comes from | License | Status |
| --- | --- | --- | --- |
| Python 3.13 runtime | Bundled by PyInstaller (DLLs and standard library) | PSF-2.0 | Include the Python license text in a release |
| SQLite | Python standard library (`sqlite3`, FTS5) | Public domain | [SQLite copyright](https://www.sqlite.org/copyright.html) |
| whisper.cpp and ggml | `_pywhispercpp` extension plus `whisper`/`ggml` DLLs inside the `pywhispercpp` wheel | MIT for whisper.cpp | The wheel does not state which whisper.cpp version it bundles; record it from the DLL and include its notice |
| PortAudio | `_portaudiowpatch` extension inside the `PyAudioWPatch` wheel | MIT | The wheel carries neither the MIT text nor a PortAudio notice; collect both from upstream before release |
| ONNX Runtime | `onnxruntime.dll` inside `sherpa-onnx-core` | MIT | **unverified**: the bundled version and its notice are not stated by the wheel |
| WebView2 (Microsoft Edge WebView2 Runtime) | System component on Windows 11, not redistributed | Microsoft terms | Do not bundle; state that it is required and normally already present |
| .NET Framework CLR | Loaded by `pythonnet` from the OS | Microsoft terms | Not redistributed |

## JavaScript bundled into the UI

The Vite build ships `react` and `react-dom` inside `backend/web` and then inside the executable.

| Component | Version | License |
| --- | --- | --- |
| `react`, `react-dom` | 19.3.0 | MIT |

The bundle is minified; check that the React MIT notice survives minification in the produced assets, and add it to the notices if it does not.

## Frontend build and test packages

Not shipped to users. Recorded for completeness; each is the license of a development tool.

| Component | Version | License |
| --- | --- | --- |
| `vite` | 8.3.4 | MIT |
| `@vitejs/plugin-react` | 6.1.2 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `@types/react`, `@types/react-dom` | 19.3.0 | MIT |
| `eslint`, `@eslint/js` | 10.12.0 / 10.0.1 | MIT |
| `typescript-eslint` | 8.71.1 | MIT |
| `prettier` | 3.9.9 | MIT |
| `vitest` | 5.0.3 | MIT |
| `jsdom` | 30.1.2 | MIT |
| `@testing-library/react`, `@testing-library/user-event` | 16.3.3 / 14.6.7 | MIT |

## Build-only Python packages

Not shipped in the executable; required to build or test it.

| Component | Version | License |
| --- | --- | --- |
| `pyinstaller` | 6.22.3 | GPLv2-or-later **with the PyInstaller exception**, which explicitly permits distributing executables built with it |
| `pyinstaller-hooks-contrib` | 2026.9 | Apache-2.0 / GPLv2 (as classified by the package) |
| `altgraph` | 0.17.5 | MIT |
| `pefile` | 2024.8.26 | MIT |
| `pytest` | 9.1.1 | MIT |
| `pluggy`, `iniconfig`, `Pygments` (via pytest) | 1.7.0 / 2.3.1 / 2.21.0 | MIT / MIT / BSD-2-Clause |
| `setuptools` | 84.2.1 | MIT |

## Downloaded speech artifacts (not bundled)

Downloaded only on an explicit Settings action, each checked against a pinned size and SHA-256 (see `backend/openmeet_py/speech/stt_catalog.py`). No model file is included in the executable.

| Artifact | License | Status |
| --- | --- | --- |
| Whisper `ggml` models (base, small, large-v3-turbo and the rest of the catalog) | MIT (OpenAI Whisper weights, `ggerganov/whisper.cpp` distribution) | Recorded; not re-verified in this rebuild |
| Silero VAD `ggml-silero-v5.1.2.bin` | MIT | Recorded; the URL names a branch, so the pinned SHA-256 is what guards content |
| sherpa-onnx Silero VAD `silero_vad.onnx` | MIT | **unverified** for this file |
| NVIDIA Parakeet TDT 0.6B v3 (int8 sherpa-onnx export) | CC-BY-4.0 — **attribution required** | Verify the pinned repository card and name NVIDIA in the release notices |
| Moonshine base (quantized, English) | MIT | **unverified** for the base model (the tiny export is MIT) |
| SenseVoice small (int8) | **unconfirmed** — a FunASR license is expected | Do not ship a claim until the model card is checked |

Hugging Face downloads keep the repository's license metadata in a local provenance manifest, which is information for the user, not a clearance for redistribution.

### Live transcript streaming models (not bundled)

Downloaded only when the user clicks **Download** in **Settings → Recording → Live transcript**, and each checked against a pinned size and SHA-256 (see `STREAMING_MODELS` in `backend/openmeet_py/speech/stt_catalog.py`). Both archives come from the sherpa-onnx model release host, `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/`. No streaming model is inside the executable.

| Artifact | Files wanted | License | Source | Status |
| --- | --- | --- | --- | --- |
| `sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06.tar.bz2`, 57,267,600 bytes | `encoder.onnx`, `decoder.onnx`, `joiner.onnx`, `tokens.txt` | CC-BY-SA as recorded in the catalogue | Community model, https://huggingface.co/Banafo/Kroko-ASR | **unverified**: the CC-BY-SA version and the attribution its model card asks for were not read. A distribution that includes this model must carry that attribution and the licence. |
| `sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-80ms-int8.tar.bz2`, 102,813,625 bytes | `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt` | CC-BY-4.0 (NVIDIA NeMo model) | Same release host; NVIDIA NeMo export | **unverified**: the pinned model card was not opened. CC-BY-4.0 requires attribution to NVIDIA. |

Custom streaming folders under `stt/streaming/custom/<name>` are placed there by the user and are outside this inventory.

## Downloaded Local AI artifacts (not bundled)

Downloaded only when you click **Install**, **Download** or **Set up for me** in **Settings → AI notes → Local AI**, and each checked against a pinned size and SHA-256 (see `backend/openmeet_py/local_ai/catalog.json`). None of it is inside the executable, and OpenMeet does not redistribute it.

| Artifact | Source | License | Status |
| --- | --- | --- | --- |
| llama.cpp build `b11671`, Windows x64 CPU, Vulkan and CUDA zips (`llama-server.exe` and its DLLs) | github.com/ggml-org/llama.cpp releases | MIT | Recorded for llama.cpp; include its notice with a build that downloads it |
| `cudart-llama-bin-win-cuda-13.4-x64.zip`, fetched with the CUDA build | Same llama.cpp release | NVIDIA CUDA runtime terms, not MIT | **unverified**: this is NVIDIA's CUDA runtime repackaged by llama.cpp; its redistribution terms were not read here |

| Model | Repository | Size | Catalog license label | Status |
| --- | --- | --- | --- | --- |
| Qwen3 30B A3B Instruct | `unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF` | 17.28 GB | `apache-2.0` | Recorded from the catalog; not re-verified against the model card |
| Qwen3 14B | `unsloth/Qwen3-14B-GGUF` | 8.38 GB | `apache-2.0` | Same |
| Gemma 3 12B | `unsloth/gemma-3-12b-it-GGUF` | 6.80 GB | `gemma` | Gemma Terms of Use, not an open-source license; use restrictions apply. **unverified** terms |
| Qwen3 8B | `unsloth/Qwen3-8B-GGUF` | 4.68 GB | `apache-2.0` | Recorded from the catalog; not re-verified against the model card |
| Qwen3 4B Instruct | `unsloth/Qwen3-4B-Instruct-2507-GGUF` | 2.33 GB | `apache-2.0` | Same |
| Gemma 3 4B | `unsloth/gemma-3-4b-it-GGUF` | 2.32 GB | `gemma` | Gemma Terms of Use. **unverified** terms |
| Llama 3.2 3B Instruct | `unsloth/Llama-3.2-3B-Instruct-GGUF` | 1.88 GB | `llama3.2` | Llama 3.2 Community License, not an open-source license; use restrictions apply. **unverified** terms |

The license labels are the strings in `catalog.json`; no model card was opened for this inventory. Gemma and Llama terms restrict some uses and require notices the download does not carry, so read the pinned model card before relying on a model commercially. A `.gguf` file found on the user's own PC is outside this inventory.

## Unverified, in one list

1. `clr_loader` — no license field in installed metadata.
2. ONNX Runtime — bundled version and notice text inside `sherpa-onnx-core`.
3. PortAudio — license text not present in the `PyAudioWPatch` wheel.
4. whisper.cpp — version bundled by `pywhispercpp` is not stated.
5. SenseVoice small, Moonshine base, and the sherpa Silero VAD — model licenses not confirmed from a local or pinned card.
6. Whether the React MIT notice survives minification.
7. The NVIDIA CUDA runtime (`cudart`) zip in the Local AI CUDA download: terms not read.
8. The Gemma Terms of Use and Llama 3.2 Community License behind the `gemma` and `llama3.2` catalog labels: terms not read.
9. The two live transcript streaming models: the CC-BY-SA version for Kroko, and the attribution text both model cards require.

## Before distributing a build

1. Decide the distribution form (single exe plus a `THIRD_PARTY_NOTICES` file is the simplest).
2. Collect license texts for every row above, with the resolved versions from `backend/uv.lock` and `pnpm-lock.yaml`.
3. Confirm or drop the unverified rows; drop the artifact rather than ship an unlicensed one.
4. Include the Python PSF license, the llama.cpp MIT notice for Local AI downloads, and the model attribution (Parakeet is CC-BY-4.0; the Kroko streaming model is CC-BY-SA and the NeMo streaming model is CC-BY-4.0).
5. Publish the SHA-256 of the exe alongside the notes.

Nothing here is a substitute for a legal review.
