import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
  convertFileSrc: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

it("sends revision-bound provider settings with the agreed IPC argument casing", async () => {
  await api.saveProviderConnection(
    "cloud_stt",
    "https://speech.example/v1",
    { kind: "replace", key: "synthetic-key" },
    4,
  );
  expect(invoke).toHaveBeenLastCalledWith("save_provider_connection", {
    role: "cloud_stt",
    baseUrl: "https://speech.example/v1",
    keyChange: { kind: "replace", key: "synthetic-key" },
    expectedRevision: 4,
  });
  await api.listProviderModels("cloud_stt", 5);
  expect(invoke).toHaveBeenLastCalledWith("list_provider_models", {
    role: "cloud_stt",
    expectedRevision: 5,
  });
  await api.saveProviderModel("llm", "custom-chat", 2);
  expect(invoke).toHaveBeenLastCalledWith("save_provider_model", {
    role: "llm",
    model: "custom-chat",
    expectedRevision: 2,
  });
});

it("uses reviewed fingerprints for cloud actions and null for local transcription", async () => {
  await api.planSummary("m", "standup-v1");
  expect(invoke).toHaveBeenLastCalledWith("plan_summary", {
    id: "m",
    template: "standup-v1",
  });
  await api.generateSummary("m", "standup-v1", "reviewed-summary");
  expect(invoke).toHaveBeenLastCalledWith("generate_summary", {
    id: "m",
    template: "standup-v1",
    confirmation: "reviewed-summary",
  });
  await api.planQuestion("m", "What changed?");
  expect(invoke).toHaveBeenLastCalledWith("plan_question", {
    id: "m",
    question: "What changed?",
  });
  await api.askMeeting("m", "What changed?", "reviewed-question");
  expect(invoke).toHaveBeenLastCalledWith("ask_meeting", {
    id: "m",
    question: "What changed?",
    confirmation: "reviewed-question",
  });
  await api.transcribeMeeting("m", null);
  expect(invoke).toHaveBeenLastCalledWith("transcribe_meeting", {
    id: "m",
    confirmation: null,
  });
  await api.transcribeMeeting("m", "reviewed-audio");
  expect(invoke).toHaveBeenLastCalledWith("transcribe_meeting", {
    id: "m",
    confirmation: "reviewed-audio",
  });
});

it("exposes real recording only and omits the retired simulation argument", async () => {
  await api.startCapture("Meeting", true, {
    microphoneId: "mic",
    outputId: "out",
  });
  expect(invoke).toHaveBeenLastCalledWith("start_recording", {
    title: "Meeting",
    consent: true,
    devices: { microphoneId: "mic", outputId: "out" },
  });
  expect(Object.keys(api)).not.toContain("start");
  expect(Object.keys(api)).not.toContain("createFixture");
});
