import { expect, it } from "vitest";
import { modelsFor } from "./models";

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
