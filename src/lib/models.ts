import type { ProviderModel, ProviderRole } from "./api";

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
