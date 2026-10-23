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

/** Speech models to offer first for a spoken language, best first. */
export function recommendedSpeechModels(language: string): string[] {
  return language === "auto" || parakeetLanguages.includes(language)
    ? ["sherpa:parakeet-v3", "small"]
    : ["small"];
}
