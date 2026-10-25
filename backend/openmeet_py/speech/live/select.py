"""Chooses the live engine from Settings and lists what can run now.

Three sources: the Transcription model (whisper.cpp or an offline sherpa-onnx model behind the
Silero VAD, or the cloud connection when Transcription is cloud), a streaming ONNX model, or the
cloud connection directly. Every refusal is one sentence that names the click that fixes it, and
nothing here downloads anything.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Callable, Optional

import numpy as np

from openmeet_py.api.errors import AppError
from openmeet_py.speech import sherpa_models, stt, streaming_models
from openmeet_py.speech.live.contract import TARGET_RATE, Resolved
from openmeet_py.speech.live.decoders import (
    CloudBudget,
    CloudDecoder,
    FakeDecoder,
    LevelGate,
    SileroGate,
    StreamingDecoder,
    VadDecoder,
)
from openmeet_py.speech.transcription.engine import WhisperCppEngine

CLOUD = "cloud"
SAME_LABEL = "Same as Transcription"
CLOUD_LABEL = "Cloud connection"
FAKE_LABEL = "Test speech engine"
CLOUD_REASON = "Save a cloud transcription connection in Settings first."
SAME_CLOUD_REASON = (
    "Same as Transcription is unavailable while Transcription is cloud, so nothing uploads. "
    "Choose the explicit Cloud connection live model to send live audio to the cloud, or a local model."
)
CHOOSE_REASON = "Choose a live transcript model in Settings."
DOWNLOAD_REASON = "Download the Transcription model in Settings first."
MISSING_ENGINE = "The speech engine is missing from this build. Reinstall OpenMeet."
SHERPA_LABELS = {
    "sherpa:parakeet-v3": "Parakeet v3",
    "sherpa:moonshine-base-en": "Moonshine base",
    "sherpa:sense-voice": "SenseVoice",
}


class OfflineSherpa:
    """One offline sherpa-onnx recognizer, loaded on first use and shared by every lane."""

    def __init__(self, spec: sherpa_models.Spec, language: str):
        self._spec = spec
        self._language = language
        self._recognizer: Any = None

    def _load(self) -> Any:
        if self._recognizer is None:
            import sherpa_onnx  # lazy: the native library loads only for a real live transcript

            paths = {role: str(path) for role, path in self._spec.paths.items()}
            factory = sherpa_onnx.OfflineRecognizer
            if self._spec.family == "transducer":
                self._recognizer = factory.from_transducer(
                    encoder=paths["encoder"], decoder=paths["decoder"], joiner=paths["joiner"],
                    tokens=paths["tokens"], num_threads=2, model_type=self._spec.model_type,
                )
            elif self._spec.family == "moonshine":
                self._recognizer = factory.from_moonshine_v2(
                    encoder=paths["encoder"], decoder=paths["decoder"], tokens=paths["tokens"], num_threads=2
                )
            else:
                self._recognizer = factory.from_sense_voice(
                    model=paths["model"], tokens=paths["tokens"], num_threads=2,
                    language=sherpa_models.sense_voice_language(self._language),
                    use_itn=True,
                )
        return self._recognizer

    def __call__(self, samples16k: np.ndarray) -> str:
        recognizer = self._load()
        stream = recognizer.create_stream()
        stream.accept_waveform(TARGET_RATE, np.ascontiguousarray(samples16k, dtype=np.float32))
        recognizer.decode_stream(stream)
        return str(stream.result.text).strip()


class WhisperOffline:
    """The whisper.cpp model behind the live VAD, loaded once and reused for every decode."""

    def __init__(self, model_path: Path, language: str, prompt: str):
        self._engine = WhisperCppEngine(Path(model_path), None)
        self._language = language
        self._prompt = prompt

    def __call__(self, samples16k: np.ndarray) -> str:
        segments = self._engine.transcribe(
            np.ascontiguousarray(samples16k, dtype=np.float32),
            self._language,
            self._prompt,
            threading.Event(),
            lambda _segment: None,
            lambda _percent: None,
        )
        return " ".join(item.text.strip() for item in segments if item.text.strip())


def selected(settings: dict) -> str:
    """The saved Settings.live_model value; "" means the Transcription model."""
    value = settings.get("live_model")
    return value if isinstance(value, str) else ""


def _gate(root: Path) -> Any:
    """Silero when its ONNX file is installed, otherwise the level gate used for whisper."""
    vad = sherpa_models.vad_path(root)
    if vad is not None and sherpa_models.engine_available():
        return SileroGate(vad)
    return LevelGate()


def _cloud_label(settings: dict) -> str:
    connection = settings.get("cloud_stt")
    model = connection.get("model") if isinstance(connection, dict) else None
    return f"Cloud transcription ({model})" if isinstance(model, str) and model.strip() else "Cloud transcription"


def _cloud(settings: dict, cloud_transcribe: Optional[Callable[[np.ndarray], str]], root: Path) -> Resolved:
    if cloud_transcribe is None:
        raise AppError("live_model", CLOUD_REASON)
    budget = CloudBudget()  # one per recording: both lanes draw from the same requests and bytes
    return Resolved(
        _cloud_label(settings),
        True,
        lambda: CloudDecoder(cloud_transcribe, gate=_gate(root), budget=budget),
    )


def _sherpa_label(model_id: str) -> str:
    if model_id in SHERPA_LABELS:
        return SHERPA_LABELS[model_id]
    if model_id.startswith(sherpa_models.CUSTOM_PREFIX):
        return model_id[len(sherpa_models.CUSTOM_PREFIX):]
    return model_id.split(":", 1)[-1]


def _same(root: Path, settings: dict) -> Resolved:
    if str(settings.get("stt_mode") or "local") == CLOUD:
        # Same as Transcription never uploads: cloud live audio needs the explicit Cloud connection model.
        raise AppError("live_model", SAME_CLOUD_REASON)
    model_id = str(settings.get("stt_model") or "")
    language = str(settings.get("stt_language") or "auto")
    if not model_id:
        raise AppError("live_model", DOWNLOAD_REASON)
    if sherpa_models.is_sherpa(model_id):
        spec = sherpa_models.spec_for(root, model_id)
        if sherpa_models.vad_path(root) is None:
            raise AppError("live_model", DOWNLOAD_REASON)
        decode = OfflineSherpa(spec, language)
        return Resolved(f"{_sherpa_label(model_id)} (on this PC)", False,
                        lambda: VadDecoder(_gate(root), decode))
    path = stt.selected_model_path(root, model_id)
    name = f"Whisper {model_id}" if not Path(model_id).is_absolute() else "Whisper model file"
    decode = WhisperOffline(path, language, str(settings.get("stt_prompt") or ""))
    return Resolved(f"{name} (on this PC)", False, lambda: VadDecoder(_gate(root), decode))


def _shared(factory: Callable[[], Any]) -> Callable[[], Any]:
    """One loaded model for every lane; the first lane's decoder loads it."""
    box: list[Any] = []
    lock = threading.Lock()

    def get() -> Any:
        with lock:
            if not box:
                box.append(factory())
            return box[0]

    return get


def _streaming(root: Path, model_id: str) -> Resolved:
    reason = streaming_models.unavailable_reason()
    if reason is not None:
        raise AppError("live_model", reason)
    model = streaming_models.pinned(model_id)
    if model is not None and not streaming_models.installed(root, model_id):
        raise AppError("live_model", f"Download {model.label} in Settings first.")
    label = model.label if model is not None else model_id[len(streaming_models.CUSTOM_PREFIX):]
    if model is None and not streaming_models.installed(root, model_id):
        raise AppError("live_model", "That streaming model folder is missing. Choose another live model.")
    recognizer = _shared(lambda: streaming_models.recognizer(root, model_id))
    return Resolved(label, False, lambda: StreamingDecoder(recognizer()))


def resolve(root: Path, settings: dict,
            cloud_transcribe: Optional[Callable[[np.ndarray], str]] = None) -> Resolved:
    """The live engine for these settings. Raises AppError when the selection cannot run now."""
    if stt.fake_engine():
        return Resolved(FAKE_LABEL, False, lambda: FakeDecoder())
    model_id = selected(settings)
    if model_id == CLOUD:
        return _cloud(settings, cloud_transcribe, root)
    if model_id == "":
        return _same(root, settings)
    if streaming_models.is_streaming(model_id):
        return _streaming(root, model_id)
    raise AppError("live_model", CHOOSE_REASON)


# ---- listing -----------------------------------------------------------------------------


def _languages(settings: dict) -> list[str]:
    language = str(settings.get("stt_language") or "auto")
    return [language] if language in stt.LANGUAGES and language != "auto" else []


def _row(model_id: str, label: str, kind: str, installed: bool, download_bytes: Optional[int],
         leaves_device: bool, languages: list[str], reason: Optional[str]) -> dict[str, Any]:
    return {
        "id": model_id,
        "label": label,
        "kind": kind,
        "installed": bool(installed),
        "download_bytes": download_bytes if not installed else None,
        "leaves_device": bool(leaves_device),
        "languages": list(languages),
        "reason": None if installed else reason,
    }


def _same_state(root: Path, settings: dict) -> tuple[bool, Optional[str], bool]:
    """(installed, reason, leaves_device) for the "same as Transcription" row."""
    if stt.fake_engine():
        return True, None, False
    if str(settings.get("stt_mode") or "local") == CLOUD:
        return False, SAME_CLOUD_REASON, False
    model_id = str(settings.get("stt_model") or "")
    if not model_id:
        return False, DOWNLOAD_REASON, False
    if sherpa_models.is_sherpa(model_id):
        state = sherpa_models.installed(root, model_id)
        reason = sherpa_models.unavailable_reason()
        if reason is not None:
            return False, reason, False
        if not (state.engine and state.model and state.vad):
            return False, DOWNLOAD_REASON, False
        return True, None, False
    status = stt.status(root, model_id)
    if not status["engine"]:
        return False, MISSING_ENGINE, False
    if not status["model"]:
        return False, DOWNLOAD_REASON, False
    return True, None, False


def listing(root: Path, settings: dict, cloud_ready: bool, installing: Optional[str] = None) -> dict[str, Any]:
    """The LiveModels shape: every choice with its installed state and one-sentence reason."""
    chosen = selected(settings)
    fake = stt.fake_engine()
    same_ready, same_reason, same_leaves = _same_state(root, settings)
    rows: list[dict[str, Any]] = [
        _row("", SAME_LABEL, "same", same_ready, None, same_leaves, _languages(settings), same_reason)
    ]
    engine_reason = streaming_models.unavailable_reason()
    for entry in streaming_models.models(root):
        installed = True if fake else entry.installed
        reason = None if installed else (engine_reason or f"Download {entry.label} in Settings first.")
        rows.append(
            _row(entry.id, entry.label, "custom" if entry.custom else "streaming", installed,
                 entry.download_bytes, False, list(entry.languages), reason)
        )
    rows.append(
        _row(CLOUD, CLOUD_LABEL, "cloud", True if fake else bool(cloud_ready), None, True, [],
             None if (fake or cloud_ready) else CLOUD_REASON)
    )
    match = next((row for row in rows if row["id"] == chosen), None)
    ready = bool(match and match["installed"])
    reason = None if ready else (match["reason"] if match else CHOOSE_REASON)
    return {
        "models": rows,
        "selected": chosen,
        "ready": ready,
        "reason": reason,
        "installing": installing,
    }
