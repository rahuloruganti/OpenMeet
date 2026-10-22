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

it("sends cloud actions directly, with no review fingerprint", async () => {
  await api.generateSummary("m", "standup-v1");
  expect(invoke).toHaveBeenLastCalledWith("generate_summary", {
    id: "m",
    template: "standup-v1",
  });
  await api.askMeeting("m", "What changed?", 7);
  expect(invoke).toHaveBeenLastCalledWith("ask_meeting", {
    id: "m",
    question: "What changed?",
    threadId: 7,
  });
  await api.askLibrary(["a", "b"], "What changed?");
  expect(invoke).toHaveBeenLastCalledWith("ask_library", {
    meetingIds: ["a", "b"],
    question: "What changed?",
  });
  await api.deleteQuestionThread("m", 7);
  expect(invoke).toHaveBeenLastCalledWith("delete_question_thread", {
    meetingId: "m",
    threadId: 7,
  });
  await api.transcribeMeeting("m");
  expect(invoke).toHaveBeenLastCalledWith("transcribe_meeting", { id: "m" });
});

it("starts real recordings with no consent or review argument", async () => {
  await api.startCapture("Meeting", { microphoneId: "mic", outputId: "out" });
  expect(invoke).toHaveBeenLastCalledWith("start_recording", {
    title: "Meeting",
    devices: { microphoneId: "mic", outputId: "out" },
  });
  expect(Object.keys(api)).not.toContain("start");
  expect(Object.keys(api)).not.toContain("createFixture");
  expect(Object.keys(api)).not.toContain("prepareSessionProcessing");
});

it("binds automatic processing controls", async () => {
  await api.cancelSessionProcessing("meeting", 3);
  expect(invoke).toHaveBeenLastCalledWith("cancel_session_processing", {
    id: "meeting",
    expectedRevision: 3,
  });
  await api.getSessionProcessing("meeting");
  expect(invoke).toHaveBeenLastCalledWith("get_session_processing", {
    id: "meeting",
  });
  await api.acknowledgeProcessingNotes("meeting", "run", "barrier", 7);
  expect(invoke).toHaveBeenLastCalledWith("acknowledge_processing_notes", {
    id: "meeting",
    runId: "run",
    notesBarrier: "barrier",
    expectedNotesRevision: 7,
  });
  await api.retrySessionProcessing("meeting");
  expect(invoke).toHaveBeenLastCalledWith("retry_session_processing", {
    id: "meeting",
  });
});
