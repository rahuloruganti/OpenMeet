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

it("sends saved connection and independent assignment revision arguments", async () => {
  const args = {
    id: "profile",
    name: "Speech",
    baseUrl: "https://speech.example/v1",
    keyChange: { kind: "replace", key: "synthetic-key" } as const,
    expectedRevision: 4,
  };
  await api.saveApiConnection(args);
  expect(invoke).toHaveBeenLastCalledWith("save_api_connection", args);
  await api.listApiConnectionModels("profile", 5);
  expect(invoke).toHaveBeenLastCalledWith("list_api_connection_models", {
    id: "profile",
    expectedRevision: 5,
  });
  const selection = {
    kind: "assigned",
    connection_id: "profile",
    model: "custom-chat",
  } as const;
  await api.saveProviderAssignment("llm", selection, 2);
  expect(invoke).toHaveBeenLastCalledWith("save_provider_assignment", {
    role: "llm",
    selection,
    expectedRevision: 2,
  });
  await api.scanLocalModels(null);
  expect(invoke).toHaveBeenLastCalledWith("scan_local_models", {
    folder: null,
  });
  await api.listHfFiles("public/model");
  expect(invoke).toHaveBeenLastCalledWith("list_hf_files", {
    repoId: "public/model",
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
    processingConfirmation: null,
  });
  expect(Object.keys(api)).not.toContain("start");
  expect(Object.keys(api)).not.toContain("createFixture");
});

it("keeps session consent separate from recording permission and manual action consent", async () => {
  await api.prepareSessionProcessing({
    kind: "final",
    live: true,
    summary: "standup-v1",
  });
  expect(invoke).toHaveBeenLastCalledWith("prepare_session_processing", {
    request: { kind: "final", live: true, summary: "standup-v1" },
  });
  await api.startCapture(
    "Meeting",
    true,
    { microphoneId: "mic", outputId: "out" },
    "reviewed-session",
  );
  expect(invoke).toHaveBeenLastCalledWith("start_recording", {
    title: "Meeting",
    consent: true,
    devices: { microphoneId: "mic", outputId: "out" },
    processingConfirmation: "reviewed-session",
  });
  await api.cancelSessionProcessing("meeting", 3);
  expect(invoke).toHaveBeenLastCalledWith("cancel_session_processing", {
    id: "meeting",
    expectedRevision: 3,
  });
  await api.getSessionProcessing("meeting");
  expect(invoke).toHaveBeenLastCalledWith("get_session_processing", {
    id: "meeting",
  });
});
