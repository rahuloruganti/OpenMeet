import { beforeEach, expect, it, vi } from "vitest";
import { convertFileSrc, invoke, listen } from "./transport";
import type { Event } from "./transport";
import { api, type RecordingState } from "./api";

vi.mock("./transport", () => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  convertFileSrc: vi.fn(),
  isBackendConnected: vi.fn(),
}));

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
  await api.askLibrary(null, "What changed?", { kind: "folder", id: "f1" });
  expect(invoke).toHaveBeenLastCalledWith("ask_library", {
    meetingIds: null,
    question: "What changed?",
    scope: { kind: "folder", id: "f1" },
  });
  await api.listFolders();
  expect(invoke).toHaveBeenLastCalledWith("list_folders");
  await api.createFolder("Client");
  expect(invoke).toHaveBeenLastCalledWith("create_folder", { name: "Client" });
  await api.renameFolder("f1", "Clients");
  expect(invoke).toHaveBeenLastCalledWith("rename_folder", {
    id: "f1",
    name: "Clients",
  });
  await api.deleteFolder("f1");
  expect(invoke).toHaveBeenLastCalledWith("delete_folder", { id: "f1" });
  await api.moveMeetingToFolder("m", null);
  expect(invoke).toHaveBeenLastCalledWith("move_meeting_to_folder", {
    meetingId: "m",
    folderId: null,
  });
  await api.reorderFolders(["f2", "f1"]);
  expect(invoke).toHaveBeenLastCalledWith("reorder_folders", {
    ids: ["f2", "f1"],
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

it("routes audio and events through the transport", async () => {
  vi.mocked(convertFileSrc).mockReturnValue("/files?path=audio.wav");
  expect(api.audioSrc("audio.wav")).toBe("/files?path=audio.wav");
  expect(convertFileSrc).toHaveBeenLastCalledWith("audio.wav");

  const state: RecordingState = {
    revision: 3,
    status: "paused",
    meeting_id: "meeting",
    source: null,
    error: null,
    recording_offset_ms: 1200,
  };
  const received: RecordingState[] = [];
  await api.onRecordingState((next) => received.push(next));
  expect(listen).toHaveBeenLastCalledWith(
    "recording_state",
    expect.any(Function),
  );
  const handler = vi.mocked(listen).mock.calls.at(-1)![1] as (
    event: Event<RecordingState>,
  ) => void;
  handler({ event: "recording_state", id: 1, payload: state });
  expect(received).toEqual([state]);
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
