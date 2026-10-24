import type { ProviderModel, ProviderRole } from "../api/api";

const speech =
  /whisper|transcri|speech|stt|asr|parakeet|canary|moonshine|sensevoice/i;
const notForChat = /tts|embed|rerank|moderation|image|dall-e/i;

/** Model IDs that look right for a task, by name only; `all` turns the filter off. A list
 * where nothing matches is shown whole, so an unusual provider never looks empty. */
export function modelsFor(
  models: ProviderModel[],
  role: ProviderRole,
  all = false,
): ProviderModel[] {
  if (all) return models;
  const fits = models.filter(({ id }) =>
    role === "cloud_stt"
      ? speech.test(id) && !/tts/i.test(id)
      : !speech.test(id) && !notForChat.test(id),
  );
  return fits.length > 0 ? fits : models;
}

const speechNames: Record<string, string> = {
  "sherpa:parakeet-v3": "Parakeet TDT 0.6B v3 (English + European languages)",
  "sherpa:moonshine-base-en": "Moonshine base (English, small and fast)",
  "sherpa:sense-voice":
    "SenseVoice small (Chinese, Japanese, Korean, Cantonese, English)",
};

/** Friendly name for a speech model id. Whisper ids get a "Whisper" prefix; a file path
 * (a Whisper file used in place) shows only its file name; a `sherpa-dir:` id is a
 * sherpa-onnx folder downloaded from Hugging Face. */
export function speechModelLabel(id: string): string {
  if (speechNames[id]) return speechNames[id];
  if (id.startsWith("sherpa-dir:"))
    return `${id.slice("sherpa-dir:".length)} (downloaded sherpa-onnx model)`;
  if (/[\\/]/.test(id)) return id.split(/[\\/]/).pop() ?? id;
  return `Whisper ${id}`;
}

/** Parakeet v3 languages that the app also offers as Spoken language choices. */
const parakeetLanguages = [
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "fi",
  "fr",
  "hr",
  "hu",
  "it",
  "nl",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "sv",
  "uk",
];

const senseVoiceLanguages = ["zh", "ja", "ko", "yue", "en"];

/** Whether a local speech model can transcribe the chosen spoken language. "auto" fits
 * every model; a Whisper `.en` file and Moonshine are English only; downloaded sherpa-onnx
 * folders are unknown, so they are kept. */
export function speechModelFits(id: string, language: string): boolean {
  if (language === "auto") return true;
  if (id.startsWith("sherpa-dir:")) return true;
  if (id === "sherpa:parakeet-v3") return parakeetLanguages.includes(language);
  if (id === "sherpa:moonshine-base-en") return language === "en";
  if (id === "sherpa:sense-voice")
    return senseVoiceLanguages.includes(language);
  const name = (id.split(/[\\/]/).pop() ?? id).toLowerCase();
  if (/(^|[.\-_])en($|[.\-_])/.test(name)) return language === "en";
  return true;
}

/** Speech models to offer first for a spoken language, best first. */
export function recommendedSpeechModels(language: string): string[] {
  return language === "auto" || parakeetLanguages.includes(language)
    ? ["sherpa:parakeet-v3", "small"]
    : ["small"];
}
