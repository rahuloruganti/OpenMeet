import { expect, it } from "vitest";
import { modelsFor, recommendedSpeechModels, speechModelLabel } from "./models";

const ids = (list: { id: string }[]) => list.map(({ id }) => id);
const mixed = [
  "gpt-x",
  "whisper-1",
  "gpt-x-transcribe",
  "gemini-flash-tts",
  "text-embedding-3",
  "llama3",
].map((id) => ({ id }));

it("splits speech and chat models by name and can show everything", () => {
  expect(ids(modelsFor(mixed, "cloud_stt"))).toEqual([
    "whisper-1",
    "gpt-x-transcribe",
  ]);
  expect(ids(modelsFor(mixed, "llm"))).toEqual(["gpt-x", "llama3"]);
  expect(modelsFor(mixed, "llm", true)).toHaveLength(6);
  expect(ids(modelsFor([{ id: "custom" }], "cloud_stt"))).toEqual(["custom"]);
});

it("drops only the Windows long-path prefix", async () => {
  const { displayPath } = await import("./meeting-labels");
  expect(displayPath(String.raw`\\?\C:\Users\me\ggml-small.bin`)).toBe(
    String.raw`C:\Users\me\ggml-small.bin`,
  );
  expect(displayPath(String.raw`C:\plain`)).toBe(String.raw`C:\plain`);
});

it("names speech models and recommends Parakeet for English and European languages", () => {
  expect(speechModelLabel("sherpa:moonshine-base-en")).toBe(
    "Moonshine base (English, small and fast)",
  );
  expect(speechModelLabel("small")).toBe("Whisper small");
  expect(speechModelLabel("sherpa-dir:csukuangfj--model")).toBe(
    "csukuangfj--model (downloaded sherpa-onnx model)",
  );
  expect(speechModelLabel(String.raw`C:\models\ggml-base.bin`)).toBe(
    "ggml-base.bin",
  );
  expect(recommendedSpeechModels("de")).toEqual([
    "sherpa:parakeet-v3",
    "small",
  ]);
  expect(recommendedSpeechModels("auto")[0]).toBe("sherpa:parakeet-v3");
  expect(recommendedSpeechModels("ja")).toEqual(["small"]);
});
