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

## Unverified, in one list

1. `clr_loader` — no license field in installed metadata.
2. ONNX Runtime — bundled version and notice text inside `sherpa-onnx-core`.
3. PortAudio — license text not present in the `PyAudioWPatch` wheel.
4. whisper.cpp — version bundled by `pywhispercpp` is not stated.
5. SenseVoice small, Moonshine base, and the sherpa Silero VAD — model licenses not confirmed from a local or pinned card.
6. Whether the React MIT notice survives minification.

## Before distributing a build

1. Decide the distribution form (single exe plus a `THIRD_PARTY_NOTICES` file is the simplest).
2. Collect license texts for every row above, with the resolved versions from `backend/uv.lock` and `pnpm-lock.yaml`.
3. Confirm or drop the unverified rows; drop the artifact rather than ship an unlicensed one.
4. Include the Python PSF license and the model attribution (Parakeet is CC-BY-4.0).
5. Publish the SHA-256 of the exe alongside the notes.

Nothing here is a substitute for a legal review.
