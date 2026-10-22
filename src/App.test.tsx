import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import {
  api,
  type AudioHealth,
  type ExportResult,
  type MeetingDetail,
  type Settings,
  type SttProgress,
  type SessionProcessingPlan,
  type SessionProcessingSnapshot,
} from "./lib/api";

vi.mock("./lib/api", async (original) => {
  const actual = await original<typeof import("./lib/api")>();
  return {
    ...actual,
    api: {
      isDesktop: vi.fn(),
      listMeetings: vi.fn(),
      getMeeting: vi.fn(),
      getRecordingState: vi.fn(),
      getSessionProcessing: vi.fn(),
      cancelSessionProcessing: vi.fn(),
      acknowledgeProcessingNotes: vi.fn(),
      retrySessionProcessing: vi.fn(),
      onSessionProcessingChanged: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      saveNotes: vi.fn(),
      getSettings: vi.fn(),
      providerKeyStatus: vi.fn(),
      saveApiConnection: vi.fn(),
      apiConnectionKeyStatus: vi.fn(),
      deleteApiConnection: vi.fn(),
      onModelLibraryProgress: vi.fn(),
      scanLocalModels: vi.fn(),
      cancelModelDownload: vi.fn(),
      listApiConnectionModels: vi.fn(),
      saveProviderAssignment: vi.fn(),
      saveSttMode: vi.fn(),
      planTranscription: vi.fn(),
      planQuestion: vi.fn(),
      sttStatus: vi.fn(),
      sttInstall: vi.fn(),
      transcribeMeeting: vi.fn(),
      generateSummary: vi.fn(),
      onSttProgress: vi.fn(),
      getStartupWarning: vi.fn(),
      listDevices: vi.fn(),
      startCapture: vi.fn(),
      onAudioHealth: vi.fn(),
      saveSettings: vi.fn(),
      chooseVaultFolder: vi.fn(),
      exportMeeting: vi.fn(),
      close: vi.fn(),
      onRecordingState: vi.fn(),
      onMeetingUpdated: vi.fn(),
      onCloseRequested: vi.fn(),
      onError: vi.fn(),
      createNote: vi.fn(),
      audioUsage: vi.fn(),
      deleteAudio: vi.fn(),
      deleteMeeting: vi.fn(),
      searchMeetings: vi.fn(),
      planSummary: vi.fn(),
      listSummaries: vi.fn(),
      saveSummaryEdit: vi.fn(),
      editSegment: vi.fn(),
      getTranscriptVersion: vi.fn(),
      askMeeting: vi.fn(),
      planLibraryQuestion: vi.fn(),
      askLibrary: vi.fn(),
      listLibraryAnswers: vi.fn(),
      deleteQuestionThread: vi.fn(),
      renameMeeting: vi.fn(),
      saveExportOptions: vi.fn(),
      saveProcessingDefault: vi.fn(),
      saveSummaryDefault: vi.fn(),
      saveDefaultDevices: vi.fn(),
      onMicrophoneApps: vi.fn(),
      saveDetection: vi.fn(),
      setDetectionIgnored: vi.fn(),
      detectionSupported: vi.fn(),
      requestAttention: vi.fn(),
      recoverAudio: vi.fn(),
      cancelTranscription: vi.fn(),
      saveSttSettings: vi.fn(),
      audioPosition: vi.fn(),
      audioSrc: vi.fn(),
    },
  };
});

const sample: MeetingDetail = {
  meeting: {
    id: "sample",
    title: "Sample sync",
    started_at: "2026-10-09T10:00:00Z",
    ended_at: null,
    status: "stopped",
    source: "fixture",
    capture_error: null,
    tags: [],
  },
  user_markdown: "Original notes",
  notes_revision: 0,
  summary: "A fictional summary.",
  summary_provider: "fixture",
  summary_model: "hand-written",
  segments: [],
  tracks: [],
  summary_template: "fixture",
  transcript_provider: null,
  transcript_model: null,
  action_items: [],
  summary_edited: false,
  summary_stale: false,
  speaker_names: { you: null, others: null },
  segment_meta: [],
  transcript_versions: [],
  question_threads: [],
};

const textPlan = {
  base_url: "https://provider.example/v1",
  model: "test-chat",
};
const sessionPlan: SessionProcessingPlan = {
  id: "session-plan",
  meeting_id: null,

  configuration_revision: 1,

  scope: {
    kind: "final",
    live: true,
    speech: { kind: "local_whisper", model: "small" },
    summary: {
      destination: {
        kind: "compatible_api",
        base_url: "https://summary.example/v1",
        model: "chat",
        connection_id: "chat",
        connection_revision: 1,
        assignment_revision: 1,
      },
      template: "general-v1",
    },
  },
  language: "auto",
  tracks: ["microphone", "system"],
  limits: {
    duration_seconds: 3600,
    post_stop_seconds: 14400,
    upload_bytes: 5000,
    requests: 20,
    text_bytes: 10000,
  },
};
function sessionSnapshot(
  revision: number,
  stage: NonNullable<SessionProcessingSnapshot["workflow"]>["stage"] = "live",
): SessionProcessingSnapshot {
  return {
    meeting_id: "sample",
    revision,
    state: "prepared",
    plan: sessionPlan,
    started_at: 1,
    authorized_until: 4_000_000_000,
    workflow: {
      run_id: "run",
      attempt: 1,
      stage,
      error: null,
      live_incomplete: false,
      transcript_done: false,
      notes_revision: null,
      notes_barrier: null,
      requests_used: 0,
      upload_bytes_used: 0,
      text_bytes_used: 0,
      provisional: [],
    },
  };
}

const initialSettings: Settings = {
  saved_connections: [],
  provider_assignments: { llm: null, cloud_stt: null },
  vault_folder: null,
  pause_shortcut: "CommandOrControl+Shift+Space",
  microphone_id: null,
  output_id: null,
  llm: null,
  cloud_stt: null,
  stt_mode: "local",
  export: {
    transcript: true,
    summary: true,
    filename: "title",
    transcript_formats: [],
  },
  stt_language: "auto",
  stt_prompt: "",
  stt_model: "small",
  stop_shortcut: null,
  summary_instructions: "",
  summary_templates: [],
  recipes: [],
  processing_mode: "recording",
  processing_summary: null,
  summary_default: "general-v1",
  detection_enabled: false,
  detection_ignored: [],
  setup_done: true,
};

const notInstalled = {
  engine: false,
  model: false,
  vad: false,
  installed: false,
  missing_bytes: 496_000_000,
  supported: true,
  models: [
    { id: "base", size: 147_951_465, installed: false },
    { id: "small", size: 487_601_967, installed: false },
  ],
  languages: ["auto", "de", "en"],
};
const installed = {
  engine: true,
  model: true,
  vad: true,
  installed: true,
  missing_bytes: 0,
  supported: true,
  models: [
    { id: "base", size: 147_951_465, installed: false },
    { id: "small", size: 487_601_967, installed: true },
  ],
  languages: ["auto", "de", "en"],
};

async function chooseProcessing(mode: string, summary?: string) {
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  await userEvent.click(screen.getByRole("tab", { name: "AI notes" }));
  await userEvent.selectOptions(
    screen.getByLabelText("Automatic processing"),
    mode,
  );
  if (summary)
    await userEvent.selectOptions(
      screen.getByLabelText("Automatic summary"),
      summary,
    );
}

beforeEach(() => {
  localStorage.removeItem("openmeet.automaticProcessing");
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(api.isDesktop).mockReturnValue(true);
  vi.mocked(api.getSessionProcessing).mockResolvedValue(null);
  vi.mocked(api.listMeetings).mockResolvedValue([sample.meeting]);
  vi.mocked(api.listLibraryAnswers).mockResolvedValue([]);
  vi.mocked(api.saveProcessingDefault).mockImplementation(
    async (mode, summary) => ({
      ...initialSettings,
      processing_mode: mode,
      processing_summary: summary,
    }),
  );
  vi.mocked(api.getMeeting).mockResolvedValue(sample);
  vi.mocked(api.getRecordingState).mockResolvedValue({
    revision: 0,
    status: "idle",
    meeting_id: null,
    source: null,
    error: null,
    recording_offset_ms: null,
  });
  vi.mocked(api.onModelLibraryProgress).mockResolvedValue(() => {});
  vi.mocked(api.apiConnectionKeyStatus).mockResolvedValue("present");
  vi.mocked(api.getSettings).mockResolvedValue(initialSettings);
  vi.mocked(api.chooseVaultFolder).mockResolvedValue({
    ...initialSettings,
    vault_folder: "C:/notes",
  });
  vi.mocked(api.listDevices).mockResolvedValue({
    capture_supported: true,
    microphones: [{ id: "mic", name: "Microphone" }],
    outputs: [{ id: "out", name: "Speakers" }],
  });
  vi.mocked(api.getStartupWarning).mockResolvedValue(null);
  vi.mocked(api.saveNotes).mockResolvedValue(1);
  vi.mocked(api.providerKeyStatus).mockResolvedValue("missing");
  vi.mocked(api.sttStatus).mockResolvedValue(notInstalled);
  vi.mocked(api.audioUsage).mockResolvedValue(0);
  vi.mocked(api.detectionSupported).mockResolvedValue(true);
  vi.mocked(api.requestAttention).mockResolvedValue();
  vi.mocked(api.searchMeetings).mockResolvedValue([]);
  vi.mocked(api.listSummaries).mockResolvedValue([]);
  for (const method of [
    api.onRecordingState,
    api.onSessionProcessingChanged,
    api.onMeetingUpdated,
    api.onCloseRequested,
    api.onError,
    api.onAudioHealth,
    api.onSttProgress,
    api.onMicrophoneApps,
  ]) {
    vi.mocked(method).mockResolvedValue(vi.fn());
  }
});

async function ready() {
  render(<App />);
  await screen.findByDisplayValue("Original notes");
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Save notes now",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
}

describe("desktop foundation", () => {
  it.each([
    ["New recording", "Settings"],
    ["Settings", "New recording"],
  ])(
    "returns focus to %s → %s's actual trigger when switching panels",
    async (first, second) => {
      await ready();
      await userEvent.click(screen.getByRole("button", { name: first }));
      const trigger = screen.getByRole("button", { name: second });
      await userEvent.click(trigger);
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Close panel" }),
      );
      await userEvent.keyboard("{Escape}");
      expect(document.activeElement).toBe(trigger);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(api.startCapture).not.toHaveBeenCalled();
    },
  );

  it("keeps track paths in secondary transcript details", async () => {
    vi.mocked(api.getMeeting).mockResolvedValue({
      ...sample,
      tracks: [
        {
          kind: "microphone",
          path: "fictional-mic.wav",
          device_name: "Fictional microphone",
          sample_rate: 48000,
          frames: 48000,
          dropped_frames: 0,
          finalized: true,
          size_bytes: null,
        },
      ],
    });
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    const details = screen.getByText("Audio track details").closest("details");
    expect(details).toBeTruthy();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("fictional-mic.wav");
    await userEvent.click(screen.getByText("Audio track details"));
    expect(details?.open).toBe(true);
    expect(screen.getByText(/No transcript/)).toBeTruthy();
  });

  it("says which finalized track captured nothing", async () => {
    const track = {
      path: "fictional.wav",
      device_name: "Fictional device",
      sample_rate: 48000,
      dropped_frames: 0,
      finalized: true,
      size_bytes: 44,
    };
    vi.mocked(api.getMeeting).mockResolvedValue({
      ...sample,
      tracks: [
        { ...track, kind: "mic", frames: 48000 },
        { ...track, kind: "system", frames: 0 },
      ],
    });
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    expect(screen.getByText(/system track is empty/)).toBeTruthy();
    expect(screen.queryByText(/microphone track is empty/)).toBeNull();
  });

  it("does not steal quit-confirmation focus when a settings panel is open", async () => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    act(() => vi.mocked(api.onCloseRequested).mock.calls[0][0]());
    const quit = await screen.findByRole("button", { name: "Save and quit" });
    expect(document.activeElement).toBe(quit);
    await userEvent.click(screen.getByRole("button", { name: "Keep working" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  });

  it.each(["devices", "keychain", "speech"])(
    "opens saved notes while %s discovery is still pending",
    async (pending) => {
      if (pending === "devices")
        vi.mocked(api.listDevices).mockReturnValue(new Promise(() => {}));
      else if (pending === "keychain")
        vi.mocked(api.providerKeyStatus).mockReturnValue(new Promise(() => {}));
      else vi.mocked(api.sttStatus).mockReturnValue(new Promise(() => {}));
      await ready();
      await userEvent.type(
        screen.getByRole("textbox", { name: /My notes/ }),
        " Still editable",
      );
      expect(
        screen.getByDisplayValue("Original notes Still editable"),
      ).toBeTruthy();
    },
  );

  it("opens saved notes when audio-device discovery fails", async () => {
    vi.mocked(api.listDevices).mockRejectedValue(
      new Error("Device discovery failed"),
    );
    await ready();
    expect(await screen.findByText(/Device discovery failed/)).toBeTruthy();
    expect(screen.getByDisplayValue("Original notes")).toBeTruthy();
  });

  it("ignores startup engine status after transcription settings refresh it", async () => {
    let deliver: (status: typeof notInstalled) => void = () => {};
    vi.mocked(api.sttStatus)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          deliver = resolve;
        }),
      )
      .mockResolvedValue(installed);
    vi.mocked(api.saveSttSettings).mockResolvedValue(initialSettings);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      screen.queryByRole("button", { name: "Save transcription settings" }),
    ).toBeNull();
    await userEvent.type(screen.getByLabelText(/Vocabulary hint/), "Okta");
    expect(
      screen.getByRole("tab", { name: /Transcription.*unsaved changes/ }),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Save transcription settings" }),
    );
    await screen.findByRole("button", { name: "Speech engine installed" });
    await act(async () => deliver(notInstalled));
    expect(
      screen.getByRole("button", { name: "Speech engine installed" }),
    ).toBeTruthy();
  });

  it("supports arrow, Home and End keys across settings sections", async () => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const transcription = screen.getByRole("tab", { name: "Transcription" });
    expect(transcription.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(transcription, { key: "ArrowDown" });
    const ai = screen.getByRole("tab", { name: "AI notes" });
    expect(document.activeElement).toBe(ai);
    expect(ai.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "AI notes" })).toBeTruthy();
    fireEvent.keyDown(ai, { key: "End" });
    const about = screen.getByRole("tab", { name: "Privacy & about" });
    expect(document.activeElement).toBe(about);
    expect(screen.getByText(/Version 0\.1\.0/)).toBeTruthy();
    fireEvent.keyDown(about, { key: "Home" });
    const recording = screen.getByRole("tab", { name: "Recording" });
    expect(document.activeElement).toBe(recording);
    expect(transcription.getAttribute("tabindex")).toBe("-1");
    fireEvent.keyDown(recording, { key: "End", ctrlKey: true });
    expect(recording.getAttribute("aria-selected")).toBe("true");
  });

  it("does not enable capture or silently replace an unavailable saved microphone", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({
      ...initialSettings,
      microphone_id: "missing-mic",
    });
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "New recording" }),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Start recording",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("combobox", {
          name: "Microphone",
        }) as HTMLSelectElement
      ).value,
    ).toBe("missing-mic");
    expect(screen.getByText(/Selected microphone is unavailable/)).toBeTruthy();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Microphone" }),
      "mic",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Start recording",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(api.startCapture).not.toHaveBeenCalled();
  });

  it("guards opening the active meeting when another meeting has an unsaved draft", async () => {
    vi.mocked(api.getRecordingState).mockResolvedValue({
      revision: 1,
      status: "recording",
      meeting_id: "active",
      source: "desktop",
      error: null,
      recording_offset_ms: null,
    });
    vi.mocked(api.getMeeting).mockImplementation(async (id) =>
      id === "active"
        ? {
            ...sample,
            meeting: {
              ...sample.meeting,
              id: "active",
              title: "Active capture",
              source: "desktop",
              status: "recording",
            },
            user_markdown: "Active notes",
          }
        : sample,
    );
    await ready();
    vi.mocked(api.saveNotes).mockRejectedValue(new Error("Write failed"));
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Do not lose this draft" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Open active meeting" }),
    );
    await screen.findByText(/Notes not saved: Write failed/);
    expect(api.getMeeting).not.toHaveBeenCalledWith("active");
    expect(screen.getByDisplayValue("Do not lose this draft")).toBeTruthy();
    vi.mocked(api.saveNotes).mockResolvedValue(1);
    await userEvent.click(
      screen.getByRole("button", { name: "Open active meeting" }),
    );
    await screen.findByDisplayValue("Active notes");
    expect(
      screen.getByRole("heading", { name: "Active capture" }),
    ).toBeTruthy();
  });

  it("starts narrow windows with navigation collapsed and notes visible", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    await ready();
    const toggle = screen.getByRole("button", { name: "Toggle meetings" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByRole("complementary", { name: "Meeting navigation" }),
    ).toBeNull();
    expect(screen.getByRole("textbox", { name: /My notes/ }).textContent).toBe(
      "Original notes",
    );
    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: "New recording" })).toBeTruthy();
  });

  it("collapses meeting navigation without hiding content or discarding the draft", async () => {
    await ready();
    const toggle = screen.getByRole("button", { name: "Toggle meetings" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Draft with sidebar closed" },
    });
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByRole("complementary", { name: "Meeting navigation" }),
    ).toBeNull();
    expect(screen.getByRole("textbox", { name: /My notes/ }).textContent).toBe(
      "Draft with sidebar closed",
    );
    await userEvent.click(toggle);
    expect(
      screen.getByRole("complementary", { name: "Meeting navigation" }),
    ).toBeTruthy();
    expect(api.getMeeting).toHaveBeenCalledOnce();
  });

  it("keeps stop and failed drafts reachable while settings are open", async () => {
    vi.mocked(api.getRecordingState).mockResolvedValue({
      revision: 1,
      status: "recording",
      meeting_id: "sample",
      source: "desktop",
      error: null,
      recording_offset_ms: null,
    });
    vi.mocked(api.stop).mockResolvedValue({
      revision: 2,
      status: "stopped",
      meeting_id: "sample",
      source: "desktop",
      error: null,
      recording_offset_ms: null,
    });
    await ready();
    vi.mocked(api.saveNotes).mockRejectedValue(new Error("Disk full"));
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Keep my draft through settings" },
    });
    const trigger = screen.getByRole("button", { name: "Settings" });
    await userEvent.click(trigger);
    expect(
      screen
        .getByRole("dialog", { name: "Settings" })
        .getAttribute("aria-modal"),
    ).toBe("false");
    expect(
      screen.getByRole("tab", { name: "Transcription", selected: true }),
    ).toBeTruthy();
    expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
    expect(api.listApiConnectionModels).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText(/Notes not saved: Disk full/);
    expect(api.stop).toHaveBeenCalledOnce();
    expect(
      screen.getByDisplayValue("Keep my draft through settings"),
    ).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByRole("textbox", { name: /My notes/ }).textContent).toBe(
      "Keep my draft through settings",
    );
  });

  it("opens recording setup without capture and with no consent checkbox", async () => {
    await ready();
    const trigger = screen.getByRole("button", { name: "New recording" });
    expect(screen.queryByRole("textbox", { name: "Meeting title" })).toBeNull();
    expect(screen.getByText("Not recording")).toBeTruthy();
    await userEvent.click(trigger);
    expect(
      screen
        .getByRole("dialog", { name: "New recording" })
        .getAttribute("aria-modal"),
    ).toBe("false");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close panel" }),
    );
    expect(api.startCapture).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Start simulation" }),
    ).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Start recording",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "New recording" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(api.startCapture).not.toHaveBeenCalled();
  });

  it("navigates content tabs by keyboard without losing or replacing typed notes", async () => {
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "My draft stays mine" },
    });
    const notesTab = screen.getByRole("tab", { name: "My notes" });
    const summaryTab = screen.getByRole("tab", { name: "Summary" });
    const transcriptTab = screen.getByRole("tab", { name: "Transcript" });
    notesTab.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(summaryTab);
    expect(summaryTab.getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByRole("tabpanel", { name: "Summary" }).textContent,
    ).toContain("Sample summary (hand-written)");
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(transcriptTab);
    expect(
      screen.getByRole("tabpanel", { name: "Transcript" }).textContent,
    ).toContain("no recorded audio");
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(notesTab);
    expect(screen.getByRole("textbox", { name: /My notes/ }).textContent).toBe(
      "My draft stays mine",
    );
    expect(api.getMeeting).toHaveBeenCalledOnce();
  });

  it("filters meeting navigation without replacing the selected draft", async () => {
    vi.mocked(api.listMeetings).mockResolvedValue([
      sample.meeting,
      { ...sample.meeting, id: "second", title: "Planning review" },
    ]);
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Still editing my notes" },
    });
    const search = screen.getByRole("searchbox", { name: "Search meetings" });
    await userEvent.type(search, "PLANNING");
    expect(screen.queryByRole("button", { name: /Sample sync/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: /Planning review/ }),
    ).toBeTruthy();
    expect(screen.getByDisplayValue("Still editing my notes")).toBeTruthy();
    expect(api.getMeeting).toHaveBeenCalledOnce();
    await userEvent.clear(search);
    await userEvent.type(search, "no matching title");
    expect(screen.getByText("No matching meetings.")).toBeTruthy();
    expect(screen.getByDisplayValue("Still editing my notes")).toBeTruthy();
  });

  it("starts a recording from setup with the chosen devices", async () => {
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "New recording" }),
    );
    const start = screen.getByRole("button", {
      name: "Start recording",
    }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    vi.mocked(api.startCapture).mockResolvedValue({
      revision: 1,
      status: "recording",
      meeting_id: "sample",
      source: "desktop",
      error: null,
      recording_offset_ms: null,
    });
    await userEvent.click(start);
    await waitFor(() =>
      expect(api.startCapture).toHaveBeenCalledWith("Untitled meeting", {
        microphoneId: "mic",
        outputId: "out",
      }),
    );
    await screen.findByText("Recording: recording");
  });

  it("lists a microphone connected after startup when New recording opens", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({
      ...initialSettings,
      microphone_id: null,
    });
    vi.mocked(api.listDevices)
      .mockResolvedValueOnce({
        capture_supported: true,
        microphones: [],
        outputs: [{ id: "out", name: "Speakers" }],
      })
      .mockResolvedValue({
        capture_supported: true,
        microphones: [{ id: "headset", name: "Headset" }],
        outputs: [{ id: "out", name: "Speakers" }],
      });
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "New recording" }),
    );
    expect(await screen.findByRole("option", { name: "Headset" })).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Start recording" }),
      ).toHaveProperty("disabled", false),
    );
  });

  it("shows a rejected capture request without claiming recording", async () => {
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "New recording" }),
    );
    vi.mocked(api.startCapture).mockRejectedValue({
      code: "audio_devices",
      message: "Selected microphone is unavailable",
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Start recording" }),
    );
    await screen.findByText(/Selected microphone is unavailable/);
    expect(screen.getByText("Not recording")).toBeTruthy();
  });

  it("stops before saving notes and retains a failed draft", async () => {
    vi.mocked(api.getRecordingState).mockResolvedValue({
      revision: 1,
      status: "recording",
      meeting_id: "sample",
      source: "desktop",
      error: null,
      recording_offset_ms: null,
    });
    vi.mocked(api.stop).mockResolvedValue({
      revision: 2,
      status: "stopped",
      meeting_id: "sample",
      source: "desktop",
      error: null,
      recording_offset_ms: null,
    });
    await ready();
    vi.mocked(api.saveNotes).mockRejectedValue(new Error("Disk full"));
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Keep this unsaved draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText(/Notes not saved: Disk full/);
    expect(api.stop).toHaveBeenCalledOnce();
    expect(vi.mocked(api.stop).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.saveNotes).mock.invocationCallOrder[0],
    );
    expect(screen.getByText("Recording: stopped")).toBeTruthy();
    expect(screen.getByDisplayValue("Keep this unsaved draft")).toBeTruthy();
    vi.mocked(api.saveNotes).mockResolvedValue(1);
    await userEvent.click(
      screen.getByRole("button", { name: "Save notes now" }),
    );
    await waitFor(() =>
      expect(screen.queryByText(/Notes not saved:/)).toBeNull(),
    );
  });

  it("stops while a note save is still pending", async () => {
    vi.mocked(api.getRecordingState).mockResolvedValue({
      revision: 1,
      status: "recording",
      meeting_id: "sample",
      source: "desktop",
      error: null,
      recording_offset_ms: null,
    });
    vi.mocked(api.stop).mockResolvedValue({
      revision: 2,
      status: "stopped",
      meeting_id: "sample",
      source: "desktop",
      error: null,
      recording_offset_ms: null,
    });
    let finishSave!: (revision: number) => void;
    vi.mocked(api.saveNotes).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Pending save" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Save notes now" }),
    );
    await waitFor(() => expect(api.saveNotes).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText("Recording: stopped");
    expect(api.stop).toHaveBeenCalledOnce();
    expect(screen.getByDisplayValue("Pending save")).toBeTruthy();
    await act(async () => finishSave(1));
  });

  it("keeps pause and stop available while an unrelated operation is waiting", async () => {
    vi.mocked(api.getRecordingState).mockResolvedValue({
      revision: 1,
      status: "recording",
      meeting_id: "sample",
      source: "desktop",
      error: null,
      recording_offset_ms: null,
    });
    let finishExport!: (result: ExportResult) => void;
    vi.mocked(api.exportMeeting).mockImplementation(
      () =>
        new Promise<ExportResult>((resolve) => {
          finishExport = resolve;
        }),
    );
    vi.mocked(api.pause).mockResolvedValue({
      revision: 2,
      status: "paused",
      meeting_id: "sample",
      source: "desktop",
      error: "Device stopped responding",
      recording_offset_ms: 0,
    });
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "Export Markdown" }),
    );
    await waitFor(() => expect(api.exportMeeting).toHaveBeenCalledOnce());
    expect(
      (screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    await screen.findByText("Recording: paused");
    await screen.findByText("Capture: Device stopped responding");
    await act(async () =>
      finishExport({
        path: "sample.md",
        created_copy: false,
        transcript_paths: [],
      }),
    );
  });

  it("flushes typed notes before export", async () => {
    await ready();
    vi.mocked(api.exportMeeting).mockResolvedValue({
      path: "C:/notes/sample.md",
      created_copy: false,
      transcript_paths: [],
    });
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Unsaved edits" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Export Markdown" }),
    );
    await waitFor(() =>
      expect(api.exportMeeting).toHaveBeenCalledWith("sample"),
    );
    expect(api.saveNotes).toHaveBeenCalledWith("sample", "Unsaved edits", 0);
    expect(vi.mocked(api.saveNotes).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.exportMeeting).mock.invocationCallOrder[0],
    );
  });

  it("cancels the first export cleanly when no folder is chosen", async () => {
    vi.mocked(api.chooseVaultFolder).mockResolvedValue(initialSettings);
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "Export Markdown" }),
    );
    await waitFor(() => expect(api.chooseVaultFolder).toHaveBeenCalledOnce());
    expect(api.exportMeeting).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByDisplayValue("Original notes")).toBeTruthy();
  });

  it("uses an existing export folder without asking again", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({
      ...initialSettings,
      vault_folder: "C:/notes",
    });
    vi.mocked(api.exportMeeting).mockResolvedValue({
      path: "C:/notes/sample.md",
      created_copy: false,
      transcript_paths: [],
    });
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "Export Markdown" }),
    );
    await screen.findByText("Exported: C:/notes/sample.md");
    expect(api.chooseVaultFolder).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );
    expect(screen.queryByText("Exported: C:/notes/sample.md")).toBeNull();
  });

  it("keeps the draft mounted while settings replace the document", async () => {
    await ready();
    const editor = screen.getByRole("textbox", { name: /My notes/ });
    fireEvent.change(editor, { target: { value: "Draft to preserve" } });
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(editor.closest("article")?.hidden).toBe(true);
    expect(screen.queryByRole("tab", { name: "My notes" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(screen.getByDisplayValue("Draft to preserve")).toBe(editor);
    expect(editor.closest("article")?.hidden).toBe(false);
  });

  it("does not close or discard notes when saving fails", async () => {
    await ready();
    vi.mocked(api.saveNotes).mockRejectedValue({
      code: "database",
      message: "Disk full",
    });
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Keep these edits" },
    });
    act(() => vi.mocked(api.onCloseRequested).mock.calls[0][0]());
    await userEvent.click(
      await screen.findByRole("button", { name: "Save and quit" }),
    );
    await screen.findByText(/Notes not saved: Disk full/);
    expect(api.close).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Keep these edits")).toBeTruthy();
  });

  it("does not switch meetings when the current notes cannot be saved", async () => {
    vi.mocked(api.listMeetings).mockResolvedValue([
      sample.meeting,
      { ...sample.meeting, id: "second", title: "Second meeting" },
    ]);
    await ready();
    vi.mocked(api.saveNotes).mockRejectedValue(new Error("Write failed"));
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Unflushed" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: /Second meeting/ }),
    );
    await screen.findByText(/Notes not saved: Write failed/);
    expect(api.getMeeting).not.toHaveBeenCalledWith("second");
    expect(screen.getByDisplayValue("Unflushed")).toBeTruthy();
  });

  it("flushes notes before graceful shutdown", async () => {
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Last edit before quitting" },
    });
    act(() => vi.mocked(api.onCloseRequested).mock.calls[0][0]());
    await userEvent.click(
      await screen.findByRole("button", { name: "Save and quit" }),
    );
    await waitFor(() => expect(api.close).toHaveBeenCalledOnce());
    expect(api.saveNotes).toHaveBeenCalledWith(
      "sample",
      "Last edit before quitting",
      0,
    );
    expect(vi.mocked(api.saveNotes).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.close).mock.invocationCallOrder[0],
    );
  });

  it("ignores stale recording notifications after a newer tray update", async () => {
    await ready();
    const notify = vi.mocked(api.onRecordingState).mock.calls[0][0];
    act(() => {
      notify({
        revision: 2,
        status: "paused",
        meeting_id: "sample",
        source: "simulation",
        error: null,
        recording_offset_ms: null,
      });
      notify({
        revision: 1,
        status: "recording",
        meeting_id: "sample",
        source: "simulation",
        error: null,
        recording_offset_ms: null,
      });
    });
    expect(screen.getByText("Simulation: paused")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  });

  it("surfaces audio gaps without stopping or hiding the recording controls", async () => {
    let publish: (health: AudioHealth) => void = () => {};
    vi.mocked(api.onAudioHealth).mockImplementation(async (callback) => {
      publish = callback;
      return () => {};
    });
    vi.mocked(api.getRecordingState).mockResolvedValue({
      revision: 1,
      status: "recording",
      meeting_id: "sample",
      source: "desktop",
      error: null,
      recording_offset_ms: null,
    });
    await ready();
    expect(screen.queryByText(/Audio gaps detected/)).toBeNull();
    act(() =>
      publish({
        error: null,
        tracks: [
          {
            kind: "mic",
            frames: 100,
            dropped_frames: 0,
            gaps: 3,
            peak: 0.2,
            callback_age_ms: 5,
          },
          {
            kind: "system",
            frames: 100,
            dropped_frames: 0,
            gaps: 0,
            peak: 0.1,
            callback_age_ms: 5,
          },
        ],
      }),
    );
    expect(
      (await screen.findByText(/Audio gaps detected/)).textContent,
    ).toContain("mic: 3");
    expect(screen.getByText("Recording: recording")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.queryByText(/stopped responding/)).toBeNull();
  });

  it("clears obsolete audio health after stop and before a new meeting", async () => {
    await ready();
    const publishState = vi.mocked(api.onRecordingState).mock.calls[0][0];
    const publishHealth = vi.mocked(api.onAudioHealth).mock.calls[0][0];
    act(() =>
      publishState({
        revision: 1,
        status: "recording",
        meeting_id: "first",
        source: "desktop",
        error: null,
        recording_offset_ms: 0,
      }),
    );
    act(() => publishHealth({ error: "Previous device failure", tracks: [] }));
    expect(screen.getByText("Audio: Previous device failure")).toBeTruthy();
    act(() =>
      publishState({
        revision: 2,
        status: "stopped",
        meeting_id: "first",
        source: "desktop",
        error: "Previous device failure",
        recording_offset_ms: null,
      }),
    );
    expect(screen.queryByText("Audio: Previous device failure")).toBeNull();
    expect(screen.getByText("Capture: Previous device failure")).toBeTruthy();
    act(() =>
      publishState({
        revision: 3,
        status: "recording",
        meeting_id: "second",
        source: "desktop",
        error: null,
        recording_offset_ms: 0,
      }),
    );
    expect(screen.queryByText(/Previous device failure/)).toBeNull();
  });

  it("downloads the speech engine only on request and reports verified status", async () => {
    let progress: (value: SttProgress) => void = () => {};
    vi.mocked(api.onSttProgress).mockImplementation(async (callback) => {
      progress = callback;
      return () => {};
    });
    let finish: (value: typeof installed) => void = () => {};
    vi.mocked(api.sttInstall).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await ready();
    expect(api.sttInstall).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("Not installed")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Download speech engine and models/ }),
    );
    act(() =>
      progress({
        stage: "model",
        downloaded: 100 * 1024 * 1024,
        total: 465 * 1024 * 1024,
      }),
    );
    expect(
      await screen.findByText(/Downloading model: 100\.0 MB \/ 465\.0 MB/),
    ).toBeTruthy();
    await act(async () => finish(installed));
    await screen.findByText("Installed and verified");
    expect(
      (
        screen.getByRole("button", {
          name: "Speech engine installed",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("transcribes a finished recording locally and shows the result", async () => {
    const recorded: MeetingDetail = {
      ...sample,
      meeting: { ...sample.meeting, source: "desktop" },
      summary: null,
      summary_provider: null,
      summary_model: null,
      tracks: [
        {
          kind: "system",
          path: "system.wav",
          device_name: "Speakers",
          sample_rate: 44100,
          frames: 44100,
          dropped_frames: 0,
          finalized: true,
          size_bytes: null,
        },
      ],
    };
    vi.mocked(api.sttStatus).mockResolvedValue(installed);
    vi.mocked(api.getMeeting)
      .mockResolvedValueOnce(recorded)
      .mockResolvedValue({
        ...recorded,
        segments: [
          {
            speaker: "Others",
            timing: { kind: "timed", start_ms: 1000, end_ms: 2000 },
            text: "Hello from the call",
          },
        ],
      });
    vi.mocked(api.transcribeMeeting).mockResolvedValue(undefined);
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    expect(api.transcribeMeeting).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Transcribe audio" }),
    );
    expect(await screen.findByText(/Hello from the call/)).toBeTruthy();
    expect(api.transcribeMeeting).toHaveBeenCalledWith("sample");
    expect(
      screen.getByRole("button", { name: "Re-transcribe audio" }),
    ).toBeTruthy();
  });

  it("refreshes finalized tracks after a tray stop without replacing a draft", async () => {
    const live: MeetingDetail = {
      ...sample,
      meeting: { ...sample.meeting, source: "desktop", status: "recording" },
      tracks: [
        {
          kind: "mic",
          path: "mic.wav",
          device_name: "Synthetic",
          sample_rate: 16000,
          frames: 0,
          dropped_frames: 0,
          finalized: false,
          size_bytes: null,
        },
      ],
    };
    vi.mocked(api.sttStatus).mockResolvedValue(installed);
    vi.mocked(api.getRecordingState).mockResolvedValue({
      revision: 1,
      status: "recording",
      meeting_id: "sample",
      source: "desktop",
      error: null,
      recording_offset_ms: 0,
    });
    vi.mocked(api.getMeeting)
      .mockResolvedValueOnce(live)
      .mockResolvedValue({
        ...live,
        meeting: { ...live.meeting, status: "stopped" },
        tracks: live.tracks.map((track) => ({
          ...track,
          finalized: true,
          frames: 16000,
        })),
      });
    await ready();
    fireEvent.change(screen.getByDisplayValue("Original notes"), {
      target: { value: "Draft kept through tray stop" },
    });
    act(() =>
      vi.mocked(api.onRecordingState).mock.calls[0][0]({
        revision: 2,
        status: "stopped",
        meeting_id: "sample",
        source: "desktop",
        error: null,
        recording_offset_ms: null,
      }),
    );
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Transcribe audio" }),
      ).toHaveProperty("disabled", false),
    );
    expect(
      screen.getByDisplayValue("Draft kept through tray stop"),
    ).toBeTruthy();
  });

  it("keeps edits made while refreshed processing results are loading", async () => {
    const recorded: MeetingDetail = {
      ...sample,
      meeting: { ...sample.meeting, source: "desktop" },
      tracks: [
        {
          kind: "mic",
          path: "mic.wav",
          device_name: "Synthetic",
          sample_rate: 16000,
          frames: 16000,
          dropped_frames: 0,
          finalized: true,
          size_bytes: null,
        },
      ],
    };
    let deliver: (detail: MeetingDetail) => void = () => {};
    vi.mocked(api.sttStatus).mockResolvedValue(installed);
    vi.mocked(api.getMeeting)
      .mockResolvedValueOnce(recorded)
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            deliver = resolve;
          }),
      );
    vi.mocked(api.transcribeMeeting).mockResolvedValue(undefined);
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Transcribe audio" }),
    );
    await waitFor(() => expect(api.getMeeting).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole("tab", { name: "My notes" }));
    fireEvent.change(screen.getByDisplayValue("Original notes"), {
      target: { value: "Typed while results were loading" },
    });
    await act(async () => deliver(recorded));
    expect(
      screen.getByDisplayValue("Typed while results were loading"),
    ).toBeTruthy();
  });

  it("cannot transcribe before the speech engine is installed", async () => {
    vi.mocked(api.getMeeting).mockResolvedValue({
      ...sample,
      meeting: { ...sample.meeting, source: "desktop" },
      tracks: [
        {
          kind: "mic",
          path: "mic.wav",
          device_name: "Mic",
          sample_rate: 16000,
          frames: 16000,
          dropped_frames: 0,
          finalized: true,
          size_bytes: null,
        },
      ],
    });
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    expect(
      (
        screen.getByRole("button", {
          name: "Transcribe audio",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText(/Download the speech engine in Settings/),
    ).toBeTruthy();
  });

  it("sends notes and transcript text on Enhance notes, then shows provenance", async () => {
    const model = "anthropic/claude-haiku-5-5";
    vi.mocked(api.providerKeyStatus).mockResolvedValue("present");
    vi.mocked(api.getSettings).mockResolvedValue({
      ...initialSettings,
      llm: { base_url: textPlan.base_url, model, revision: 1 },
    });
    vi.mocked(api.getMeeting)
      .mockResolvedValueOnce({
        ...sample,
        summary: null,
        summary_provider: null,
        summary_model: null,
      })
      .mockResolvedValue({
        ...sample,
        summary: "## Summary\nA real summary.",
        summary_provider: "merge",
        summary_model: model,
      });
    vi.mocked(api.generateSummary).mockResolvedValue(undefined);
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Enhance notes" }),
    );
    await screen.findByText(`Summary · generated by ${model} via merge`);
    expect(api.generateSummary).toHaveBeenCalledWith("sample", "general-v1");
    expect(screen.getByText(/A real summary\./)).toBeTruthy();
    expect(screen.getByDisplayValue("Original notes")).toBeTruthy();
  });

  const providerReady = () => {
    vi.mocked(api.providerKeyStatus).mockResolvedValue("present");
    vi.mocked(api.getSettings).mockResolvedValue({
      ...initialSettings,
      llm: { base_url: textPlan.base_url, model: "openai/gpt-x", revision: 1 },
    });
  };

  it.each([
    ["Stand-up", "standup-v1"],
    ["Retro", "custom-retro"],
  ])("sends the chosen %s template", async (label, id) => {
    vi.mocked(api.providerKeyStatus).mockResolvedValue("present");
    vi.mocked(api.getSettings).mockResolvedValue({
      ...initialSettings,
      llm: { base_url: textPlan.base_url, model: "openai/gpt-x", revision: 1 },
      summary_templates: [
        { id: "custom-retro", name: "Retro", instructions: "## Went well" },
      ],
    });
    vi.mocked(api.generateSummary).mockResolvedValue(undefined);
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Template" }),
      label,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Enhance notes" }),
    );
    await waitFor(() =>
      expect(api.generateSummary).toHaveBeenCalledWith("sample", id),
    );
  });

  it("shows a refused summary as an error", async () => {
    providerReady();
    vi.mocked(api.generateSummary).mockRejectedValue({
      code: "summary_too_long",
      message: "This meeting would need 12 summary requests; the limit is 9.",
    });
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Enhance notes" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "the limit is 9",
    );
  });

  it("switches summary versions without touching notes and copies sections", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    vi.mocked(api.getMeeting).mockResolvedValue({
      ...sample,
      summary: "## Summary\nNewest.\n## Action items\n- Ship it",
      summary_provider: "merge",
      summary_model: "m3",
    });
    vi.mocked(api.listSummaries).mockResolvedValue([
      {
        id: 3,
        provider: "merge",
        model: "m3",
        template: "standup-v1",
        markdown: "## Summary\nNewest.\n## Action items\n- Ship it",
        edited_from: null,
        stale: false,
      },
      {
        id: 2,
        provider: "merge",
        model: "m2",
        template: "general-v1",
        markdown: "## Summary\nOlder.",
        edited_from: null,
        stale: false,
      },
      {
        id: 1,
        provider: "fixture",
        model: "hand-written",
        template: "fixture",
        markdown: "A fictional summary.",
        edited_from: null,
        stale: false,
      },
    ]);
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    const picker = await screen.findByRole("combobox", { name: "Version" });
    expect(
      Array.from((picker as HTMLSelectElement).options).map((o) => o.text),
    ).toEqual([
      "Version 3 · m3 · Stand-up",
      "Version 2 · m2 · General",
      "Version 1 · hand-written · Sample",
    ]);
    await userEvent.click(
      screen.getByRole("button", { name: "Copy action items" }),
    );
    expect(writeText).toHaveBeenLastCalledWith("- Ship it");
    await userEvent.selectOptions(picker, "Version 2 · m2 · General");
    expect(screen.getByText("Older.")).toBeTruthy();
    expect(screen.queryByText("Newest.")).toBeNull();
    expect(
      screen.getByText("Summary · generated by m2 via merge"),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Copy action items",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Copy summary" }));
    expect(writeText).toHaveBeenLastCalledWith("## Summary\nOlder.");
    expect(screen.getByText("Copied summary.")).toBeTruthy();
    expect(api.saveNotes).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Original notes")).toBeTruthy();
  });

  const editableVersions = () => {
    vi.mocked(api.getMeeting).mockResolvedValue({
      ...sample,
      summary: "## Summary\nGenerated.",
      summary_provider: "merge",
      summary_model: "m1",
    });
    vi.mocked(api.listSummaries).mockResolvedValue([
      {
        id: 4,
        provider: "merge",
        model: "m1",
        template: "general-v1",
        markdown: "## Summary\nGenerated.",
        edited_from: null,
        stale: false,
      },
    ]);
  };

  it("saves a summary edit as a new version and keeps the draft on conflict or quit", async () => {
    editableVersions();
    vi.mocked(api.saveSummaryEdit).mockRejectedValueOnce({
      code: "summary_conflict",
      message: "A newer summary version was saved while you were editing.",
    });
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Edit summary" }),
    );
    const editor = screen.getByRole("textbox", { name: "Edit summary" });
    await userEvent.type(editor, " Corrected.");
    // An automatic summary lands while the user is editing.
    vi.mocked(api.listSummaries).mockResolvedValue([
      {
        id: 6,
        provider: "merge",
        model: "m2",
        template: "general-v1",
        markdown: "Newer generated text.",
        edited_from: null,
        stale: false,
      },
    ]);
    await userEvent.click(
      screen.getByRole("button", { name: "Save edited summary" }),
    );
    expect(api.saveSummaryEdit).toHaveBeenCalledWith(
      "sample",
      4,
      4,
      "## Summary\nGenerated. Corrected.",
    );
    expect(await screen.findByText(/newer summary version/)).toBeTruthy();
    expect(
      (
        screen.getByRole("textbox", {
          name: "Edit summary",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("## Summary\nGenerated. Corrected.");
    act(() => vi.mocked(api.onCloseRequested).mock.calls[0][0]());
    expect(
      await screen.findByRole("button", {
        name: "Discard unsaved edits and quit",
      }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Keep working" }));
    vi.mocked(api.saveSummaryEdit).mockResolvedValue(undefined);
    await userEvent.click(
      screen.getByRole("button", { name: "Save edited summary" }),
    );
    expect(api.saveSummaryEdit).toHaveBeenLastCalledWith(
      "sample",
      4,
      6,
      "## Summary\nGenerated. Corrected.",
    );
    await screen.findByText(/Edited summary saved as a new version/);
    expect(screen.queryByRole("textbox", { name: "Edit summary" })).toBeNull();
    expect(api.saveNotes).not.toHaveBeenCalled();
  });

  const transcribed = {
    ...sample,
    segments: [
      {
        speaker: "You" as const,
        timing: { kind: "timed" as const, start_ms: 1000, end_ms: 2000 },
        text: "Persimon budget",
      },
      {
        speaker: "Others" as const,
        timing: { kind: "untimed" as const },
        text: "Agreed",
      },
    ],
    segment_meta: [
      { id: 11, original_text: null },
      { id: 12, original_text: "Agred" },
    ],
    transcript_versions: [
      {
        id: 3,
        provider: "whisper",
        model: "small",
        edited: true,
        segment_count: 1,
      },
    ],
  };

  it("edits, reverts, and guards transcript segments and shows earlier transcripts", async () => {
    vi.mocked(api.getMeeting).mockResolvedValue(transcribed);
    vi.mocked(api.editSegment).mockRejectedValueOnce({
      code: "segment_conflict",
      message: "This transcript segment changed or no longer exists.",
    });
    vi.mocked(api.getTranscriptVersion).mockResolvedValue([
      {
        speaker: "You",
        timing: { kind: "untimed" },
        text: "Kept earlier words",
      },
    ]);
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    expect(screen.getByText("(edited)")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit segment at 1.0s" }),
    );
    const input = screen.getByRole("textbox", { name: "Edit segment at 1.0s" });
    await userEvent.clear(input);
    await userEvent.type(input, "Persimmon budget");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(api.editSegment).toHaveBeenCalledWith(
      "sample",
      11,
      "Persimon budget",
      "Persimmon budget",
    );
    expect(await screen.findByText(/changed or no longer exists/)).toBeTruthy();
    expect(screen.getByDisplayValue("Persimmon budget")).toBeTruthy();
    act(() => vi.mocked(api.onCloseRequested).mock.calls[0][0]());
    expect(
      await screen.findByRole("button", {
        name: "Discard unsaved edits and quit",
      }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Keep working" }));
    vi.mocked(api.editSegment).mockResolvedValue(undefined);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Edit segment at 1.0s" }),
      ).toBeNull(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Revert segment at Untimed" }),
    );
    expect(api.editSegment).toHaveBeenLastCalledWith(
      "sample",
      12,
      "Agreed",
      "Agred",
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Earlier transcripts" }),
      "3",
    );
    expect(api.getTranscriptVersion).toHaveBeenCalledWith("sample", 3);
    expect(await screen.findByText(/Kept earlier words/)).toBeTruthy();
  });

  it("says when a summary is older than the transcript", async () => {
    editableVersions();
    vi.mocked(api.listSummaries).mockResolvedValue([
      {
        id: 4,
        provider: "merge",
        model: "m1",
        template: "general-v1",
        markdown: "## Summary\nGenerated.",
        edited_from: null,
        stale: true,
      },
    ]);
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    expect(
      await screen.findByText(/changed after this summary was made/),
    ).toBeTruthy();
  });

  it("keeps an unsaved summary edit when switching meetings", async () => {
    editableVersions();
    const second = { ...sample.meeting, id: "second", title: "Second meeting" };
    vi.mocked(api.listMeetings).mockResolvedValue([sample.meeting, second]);
    vi.mocked(api.getMeeting).mockImplementation(async (id) =>
      id === "second"
        ? { ...sample, meeting: second, summary: null }
        : {
            ...sample,
            summary: "## Summary\nGenerated.",
            summary_provider: "merge",
            summary_model: "m1",
          },
    );
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Edit summary" }),
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "Edit summary" }),
      " Draft.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Second meeting/ }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Edit summary" }),
      ).toBeNull(),
    );
    await userEvent.click(screen.getByRole("button", { name: /Sample sync/ }));
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    expect(
      (
        (await screen.findByRole("textbox", {
          name: "Edit summary",
        })) as HTMLTextAreaElement
      ).value,
    ).toBe("## Summary\nGenerated. Draft.");
  });

  it("labels edited versions", async () => {
    providerReady();
    vi.mocked(api.getMeeting).mockResolvedValue({
      ...sample,
      summary: "## Summary\nMine.",
      summary_provider: "merge",
      summary_model: "m1",
      summary_edited: true,
    });
    vi.mocked(api.listSummaries).mockResolvedValue([
      {
        id: 5,
        provider: "merge",
        model: "m1",
        template: "general-v1",
        markdown: "## Summary\nMine.",
        edited_from: 4,
        stale: false,
      },
      {
        id: 4,
        provider: "merge",
        model: "m1",
        template: "general-v1",
        markdown: "## Summary\nGenerated.",
        edited_from: null,
        stale: false,
      },
    ]);
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    expect(
      await screen.findByText("Summary · edited by you, based on version 1"),
    ).toBeTruthy();
    expect(screen.getByText(/Edited by you from AI output/)).toBeTruthy();
    expect(
      Array.from(
        (screen.getByRole("combobox", { name: "Version" }) as HTMLSelectElement)
          .options,
      ).map((option) => option.text)[0],
    ).toBe("Version 2 · m1 · General · edited");
  });

  const turn = (id: number, question: string, answer: string) => ({
    id,
    question,
    answer,
    provider: "https://provider.example/v1",
    model: "test-chat",
  });

  it("asks a question and shows the saved thread", async () => {
    providerReady();
    vi.mocked(api.askMeeting).mockResolvedValue({
      id: 4,
      turns: [turn(1, "What is the budget?", "The **budget** is 40k [1:05].")],
    });
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Ask this meeting" }),
      "What is the budget?",
    );
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(api.askMeeting).toHaveBeenCalledWith(
      "sample",
      "What is the budget?",
      null,
    );
    expect((await screen.findByText("budget")).tagName).toBe("STRONG");
    expect(screen.getByText("Q: What is the budget?")).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Question threads" }),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("textbox", {
          name: "Ask a follow-up",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("");
    expect(api.generateSummary).not.toHaveBeenCalled();
    expect(api.saveNotes).not.toHaveBeenCalled();
  });

  it("shows a question with no matching passages as a status message", async () => {
    providerReady();
    const message =
      "No passages in the selected content matched your question. Nothing was sent.";
    vi.mocked(api.askMeeting).mockRejectedValue({
      code: "insufficient_evidence",
      message,
    });
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Ask this meeting" }),
      "What about zucchini?",
    );
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));
    const shown = await screen.findByText(message);
    expect(shown.closest("[role=status]")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends a follow-up within the active thread", async () => {
    providerReady();
    vi.mocked(api.getMeeting).mockResolvedValue({
      ...sample,
      question_threads: [
        { id: 4, turns: [turn(1, "What is the budget?", "It is 40k.")] },
      ],
    });
    vi.mocked(api.askMeeting).mockResolvedValue({
      id: 4,
      turns: [
        turn(1, "What is the budget?", "It is 40k."),
        turn(2, "Who approved it?", "Not stated."),
      ],
    });
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    expect(screen.getByText("It is 40k.")).toBeTruthy();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Ask a follow-up" }),
      "Who approved it?",
    );
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(api.askMeeting).toHaveBeenCalledWith(
      "sample",
      "Who approved it?",
      4,
    );
    expect(await screen.findByText("Not stated.")).toBeTruthy();
    expect(screen.getByText("It is 40k.")).toBeTruthy();
  });

  it("switches between threads, starts a new question, and confirms before deleting", async () => {
    providerReady();
    vi.mocked(api.getMeeting).mockResolvedValue({
      ...sample,
      question_threads: [
        { id: 9, turns: [turn(3, "Who owns launch?", "Dana.")] },
        { id: 4, turns: [turn(1, "What is the budget?", "It is 40k.")] },
      ],
    });
    vi.mocked(api.askMeeting).mockResolvedValue({
      id: 4,
      turns: [turn(1, "What is the budget?", "It is 40k.")],
    });
    vi.mocked(api.deleteQuestionThread).mockResolvedValue([
      { id: 4, turns: [turn(1, "What is the budget?", "It is 40k.")] },
    ]);
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    expect(screen.getByText("Dana.")).toBeTruthy();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Question threads" }),
      "4",
    );
    expect(screen.getByText("It is 40k.")).toBeTruthy();
    expect(screen.queryByText("Dana.")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "New question" }));
    expect(screen.queryByText("It is 40k.")).toBeNull();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Ask this meeting" }),
      "Anything else?",
    );
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(api.askMeeting).toHaveBeenLastCalledWith(
      "sample",
      "Anything else?",
      null,
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Question threads" }),
      "9",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Delete thread" }),
    );
    expect(api.deleteQuestionThread).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(api.deleteQuestionThread).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Delete thread" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Delete thread permanently" }),
    );
    expect(api.deleteQuestionThread).toHaveBeenCalledWith("sample", 9);
    expect(await screen.findByText("It is 40k.")).toBeTruthy();
    expect(screen.queryByText("Dana.")).toBeNull();
  });

  it("does not pretend the web preview can persist meetings", () => {
    vi.mocked(api.isDesktop).mockReturnValue(false);
    render(<App />);
    expect(screen.getByRole("alert").textContent).toContain(
      "browser preview cannot access",
    );
    expect(api.listMeetings).not.toHaveBeenCalled();
  });
});

describe("automatic session processing", () => {
  it("warns before recording when the chosen speech engine is not ready", async () => {
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "New recording" }),
    );
    expect(screen.queryByText(/speech engine is not downloaded/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Close panel" }));
    await chooseProcessing("final");
    await userEvent.click(
      screen.getByRole("button", { name: "New recording" }),
    );
    expect(
      (await screen.findByText(/speech engine is not downloaded/)).textContent,
    ).toContain("The recording itself is still kept.");
  });

  it.each([
    "failed",
    "completed",
    "cancelled",
    "interrupted",
    "consent_required",
  ] satisfies NonNullable<SessionProcessingSnapshot["workflow"]>["stage"][])(
    "does not acknowledge or wait for notes in terminal stage %s",
    async (stage) => {
      const snapshot = sessionSnapshot(5, stage);
      if (!snapshot.workflow) throw new Error("Missing workflow");
      snapshot.workflow.notes_barrier = "terminal-barrier";
      vi.mocked(api.getSessionProcessing).mockResolvedValue(snapshot);
      await ready();
      await screen.findByRole("region", { name: "Session processing" });
      expect(api.acknowledgeProcessingNotes).not.toHaveBeenCalled();
      expect(
        screen.queryByText(/Automatic summary waits for saved notes/),
      ).toBeNull();
      expect(
        screen.queryByRole("button", {
          name: "Save notes and continue processing",
        }),
      ).toBeNull();
    },
  );

  it("does not freeze notes or show summary waiting for final transcription without summary consent", async () => {
    const snapshot = sessionSnapshot(5, "transcribing");
    snapshot.plan = {
      ...sessionPlan,
      scope: {
        kind: "final",
        live: false,
        speech: sessionPlan.scope.speech,
        summary: null,
      },
    };
    if (!snapshot.workflow) throw new Error("Missing workflow");
    snapshot.workflow.notes_barrier = "speech-only-barrier";
    vi.mocked(api.getSessionProcessing).mockResolvedValue(snapshot);
    await ready();
    await screen.findByRole("region", { name: "Session processing" });
    expect(api.acknowledgeProcessingNotes).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/Automatic summary waits for saved notes/),
    ).toBeNull();
  });

  it("acknowledges a tray stop without flushing another meeting's editor", async () => {
    const other = {
      ...sample,
      meeting: { ...sample.meeting, id: "other", title: "Another note" },
      user_markdown: "Other notes",
      notes_revision: 4,
    };
    vi.mocked(api.listMeetings).mockResolvedValue([
      sample.meeting,
      other.meeting,
    ]);
    vi.mocked(api.getMeeting).mockImplementation(async (id) =>
      id === "other" ? other : { ...sample, notes_revision: 9 },
    );
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /Another note/ }));
    await screen.findByDisplayValue("Other notes");
    const awaiting = sessionSnapshot(2, "awaiting_notes");
    if (!awaiting.workflow) throw new Error("Missing workflow");
    awaiting.workflow.notes_barrier = "tray-stop";
    vi.mocked(api.getSessionProcessing).mockImplementation(async (id) =>
      id === "sample" ? awaiting : null,
    );
    vi.mocked(api.acknowledgeProcessingNotes).mockImplementation(async () => {
      expect(api.saveNotes).not.toHaveBeenCalled();
      return {
        ...awaiting,
        revision: 3,
        workflow: awaiting.workflow && {
          ...awaiting.workflow,
          notes_revision: 9,
        },
      };
    });
    fireEvent.change(screen.getByDisplayValue("Other notes"), {
      target: { value: "Keep this draft" },
    });
    act(() =>
      vi.mocked(api.onRecordingState).mock.calls[0]?.[0]({
        revision: 5,
        status: "stopped",
        meeting_id: "sample",
        source: "desktop",
        error: null,
        recording_offset_ms: 1000,
      }),
    );
    await waitFor(() =>
      expect(api.acknowledgeProcessingNotes).toHaveBeenCalledWith(
        "sample",
        "run",
        "tray-stop",
        9,
      ),
    );
    expect(screen.getByDisplayValue("Keep this draft")).toBeTruthy();
  });

  it("starts with the saved processing default and shows a skipped-processing notice", async () => {
    vi.mocked(api.startCapture).mockResolvedValue({
      revision: 1,
      status: "recording",
      meeting_id: "sample",
      source: "desktop",
      error: null,
      recording_offset_ms: 0,
      processing_notice:
        "Automatic processing is off for this recording: Choose and save a model first.",
    });
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "New recording" }),
    );
    expect(screen.getByText(/Recording only/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Change in Settings" }),
    );
    expect(
      screen
        .getByRole("tab", { name: "AI notes" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    await chooseProcessing("both", "general-v1");
    await userEvent.click(
      screen.getByRole("button", { name: "New recording" }),
    );
    expect(screen.getByText(/Live and final transcription/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Review processing" }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Start recording" }),
    );
    await waitFor(() =>
      expect(api.startCapture).toHaveBeenCalledWith("Untitled meeting", {
        microphoneId: "mic",
        outputId: "out",
      }),
    );
    expect(
      await screen.findByText(/Automatic processing is off for this recording/),
    ).toBeTruthy();
  });

  it("keeps failed note drafts and acknowledges the saved revision only on explicit retry", async () => {
    const awaiting = sessionSnapshot(2, "awaiting_notes");
    if (!awaiting.workflow) throw new Error("Missing workflow");
    awaiting.workflow.notes_barrier = "stop-barrier";
    vi.mocked(api.saveNotes).mockRejectedValue(new Error("disk full"));
    vi.mocked(api.acknowledgeProcessingNotes).mockResolvedValue({
      ...awaiting,
      revision: 3,
      workflow: { ...awaiting.workflow, notes_revision: 7 },
    });
    await ready();
    fireEvent.change(screen.getByDisplayValue("Original notes"), {
      target: { value: "Unsaved private draft" },
    });
    vi.mocked(api.getSessionProcessing).mockResolvedValue(awaiting);
    act(() =>
      vi.mocked(api.onSessionProcessingChanged).mock.calls[0]?.[0](awaiting),
    );
    await screen.findByText(/Notes acknowledgement failed: disk full/);
    expect(api.acknowledgeProcessingNotes).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Unsaved private draft")).toBeTruthy();
    vi.mocked(api.saveNotes).mockResolvedValue(7);
    await userEvent.click(
      screen.getByRole("button", {
        name: "Save notes and continue processing",
      }),
    );
    await waitFor(() =>
      expect(api.acknowledgeProcessingNotes).toHaveBeenCalledWith(
        "sample",
        "run",
        "stop-barrier",
        7,
      ),
    );
    expect(screen.getByDisplayValue("Unsaved private draft")).toBeTruthy();
  });

  it("rejects stale and other-meeting live snapshots, deduplicates and bounds provisional rows", async () => {
    const current = sessionSnapshot(5);
    if (!current.workflow) throw new Error("Missing workflow");
    current.workflow.provisional = Array.from({ length: 205 }, (_, index) => ({
      id: `run:mic:${index}`,
      chunk_id: index,
      segment: {
        speaker: "You",
        timing: { kind: "untimed" },
        text: `Live word ${index}`,
      },
    }));
    current.workflow.provisional[204].segment.timing = {
      kind: "timed",
      start_ms: 123000,
      end_ms: 124000,
    };
    current.workflow.provisional.push(current.workflow.provisional[204]);
    vi.mocked(api.getSessionProcessing).mockResolvedValue(current);
    await ready();
    await screen.findByText("Live word 204");
    expect(screen.queryByText("Live word 0")).toBeNull();
    expect(screen.getAllByText("Live word 204")).toHaveLength(1);
    expect(
      screen.getByText("Live word 204").parentElement?.textContent,
    ).toContain("[02:03] You: Live word 204");
    expect(
      screen.getByText("Live word 203").parentElement?.textContent,
    ).toContain("[Untimed]");
    const stale = sessionSnapshot(3, "failed");
    vi.mocked(api.getSessionProcessing).mockResolvedValue(stale);
    act(() =>
      vi.mocked(api.onSessionProcessingChanged).mock.calls[0]?.[0](stale),
    );
    await waitFor(() =>
      expect(api.getSessionProcessing).toHaveBeenCalledTimes(2),
    );
    expect(screen.getByText("Live word 204")).toBeTruthy();
    const other = { ...sessionSnapshot(9, "completed"), meeting_id: "other" };
    vi.mocked(api.getSessionProcessing).mockResolvedValue(other);
    act(() =>
      vi.mocked(api.onSessionProcessingChanged).mock.calls[0]?.[0](other),
    );
    await waitFor(() =>
      expect(api.getSessionProcessing).toHaveBeenCalledWith("other"),
    );
    expect(screen.getByText("Live word 204")).toBeTruthy();
  });

  it("cancels the exact revision and retries in one step", async () => {
    const current = sessionSnapshot(5);
    const cancelled = {
      ...sessionSnapshot(6, "cancelled"),
      state: "cancelled" as const,
    };
    vi.mocked(api.getSessionProcessing).mockResolvedValue(current);
    vi.mocked(api.cancelSessionProcessing).mockResolvedValue(cancelled);
    vi.mocked(api.retrySessionProcessing).mockResolvedValue(
      sessionSnapshot(7, "transcribing"),
    );
    await ready();
    await userEvent.click(
      await screen.findByRole("button", { name: "Cancel session processing" }),
    );
    expect(api.cancelSessionProcessing).toHaveBeenCalledWith("sample", 5);
    vi.mocked(api.getSessionProcessing).mockResolvedValue(
      sessionSnapshot(7, "transcribing"),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Retry processing" }),
    );
    await waitFor(() =>
      expect(api.retrySessionProcessing).toHaveBeenCalledWith("sample"),
    );
    expect(api.startCapture).not.toHaveBeenCalled();
  });
});

describe("notes-first polish", () => {
  const at = (days: number) => ({
    ...sample.meeting,
    id: `m${days}`,
    title: `Meeting ${days}`,
    started_at: new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      new Date().getDate() - days,
      12,
    ).toISOString(),
  });

  it("groups the sidebar by day and keeps search filtering inside groups", async () => {
    vi.mocked(api.listMeetings).mockResolvedValue([at(0), at(1), at(5)]);
    await ready();
    const sidebar = screen.getByRole("complementary", {
      name: "Meeting navigation",
    });
    const headings = Array.from(sidebar.querySelectorAll("h3")).map(
      (heading) => heading.textContent,
    );
    expect(headings).toEqual(["Today", "Yesterday", "Earlier"]);
    await userEvent.type(screen.getByRole("searchbox"), "Meeting 5");
    expect(
      Array.from(sidebar.querySelectorAll("h3")).map((h) => h.textContent),
    ).toEqual(["Earlier"]);
  });

  it("shows a first-note empty state without starting anything", async () => {
    vi.mocked(api.listMeetings).mockResolvedValue([]);
    render(<App />);
    await screen.findByText("Start your first note");
    expect(api.startCapture).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Start simulation" }),
    ).toBeNull();
  });

  it("offers a disabled Enhance notes slot that explains why", async () => {
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    const button = screen.getByRole("button", {
      name: "Enhance notes",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(
      screen.getByText(/Save a summary API key in Settings first/),
    ).toBeTruthy();
    expect(screen.getByText("A fictional summary.")).toBeTruthy();
  });

  it("renames on Enter and restores the title on Escape", async () => {
    vi.mocked(api.renameMeeting).mockResolvedValue("Planning review");
    await ready();
    await userEvent.click(screen.getByRole("heading", { name: "Sample sync" }));
    const input = screen.getByRole("textbox", { name: "Meeting title" });
    await userEvent.clear(input);
    await userEvent.type(input, "Discarded edit{Escape}");
    expect(screen.getByRole("heading", { name: "Sample sync" })).toBeTruthy();
    expect(api.renameMeeting).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    const again = screen.getByRole("textbox", { name: "Meeting title" });
    expect((again as HTMLInputElement).value).toBe("Sample sync");
    await userEvent.clear(again);
    await userEvent.type(again, "  Planning review {Enter}");
    expect(api.renameMeeting).toHaveBeenCalledWith(
      "sample",
      "  Planning review ",
    );
    expect(
      await screen.findByRole("heading", { name: "Planning review" }),
    ).toBeTruthy();
    expect(screen.getByDisplayValue("Original notes")).toBeTruthy();
  });

  it("keeps the old title and shows the error when a rename is rejected", async () => {
    vi.mocked(api.renameMeeting).mockRejectedValue({
      code: "invalid_title",
      message: "Use a meeting title between 1 and 160 characters.",
    });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    await userEvent.clear(
      screen.getByRole("textbox", { name: "Meeting title" }),
    );
    await userEvent.keyboard("{Enter}");
    await screen.findByText(/between 1 and 160 characters/);
    expect(screen.getByRole("heading", { name: "Sample sync" })).toBeTruthy();
  });

  it("shows labelled level meters and warns after sustained mic silence", async () => {
    let publish: (health: AudioHealth) => void = () => {};
    vi.mocked(api.onAudioHealth).mockImplementation(async (callback) => {
      publish = callback;
      return () => {};
    });
    vi.mocked(api.getRecordingState).mockResolvedValue({
      revision: 1,
      status: "recording",
      meeting_id: "sample",
      source: "desktop",
      error: null,
      recording_offset_ms: null,
    });
    const health = (mic: number): AudioHealth => ({
      error: null,
      tracks: [
        {
          kind: "mic",
          frames: 1,
          dropped_frames: 0,
          gaps: 0,
          peak: mic,
          callback_age_ms: 5,
        },
        {
          kind: "system",
          frames: 1,
          dropped_frames: 0,
          gaps: 0,
          peak: 0.3,
          callback_age_ms: 5,
        },
      ],
    });
    await ready();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    act(() => publish(health(0)));
    expect(screen.getByText("Mic: quiet")).toBeTruthy();
    expect(screen.getByText("System: signal")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    clock.mockReturnValue(12_500);
    act(() => publish(health(0)));
    expect(screen.getByText("Mic: no signal for 11 s")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "no signal for at least 10 seconds",
    );
    act(() => publish(health(0.2)));
    expect(screen.getByText("Mic: signal")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    clock.mockRestore();
  });

  it("hides level meters for simulations", async () => {
    let publish: (health: AudioHealth) => void = () => {};
    vi.mocked(api.onAudioHealth).mockImplementation(async (callback) => {
      publish = callback;
      return () => {};
    });
    vi.mocked(api.getRecordingState).mockResolvedValue({
      revision: 1,
      status: "recording",
      meeting_id: "sample",
      source: "simulation",
      error: null,
      recording_offset_ms: null,
    });
    await ready();
    act(() => publish({ error: null, tracks: [] }));
    expect(screen.queryByText(/^Mic:/)).toBeNull();
  });

  it("saves export options from Settings", async () => {
    vi.mocked(api.saveExportOptions).mockImplementation(async (options) => ({
      ...initialSettings,
      export: options,
    }));
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(
      screen.getByRole("tab", { name: "Export & storage" }),
    );
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Include transcript" }),
    );
    expect(api.saveExportOptions).toHaveBeenLastCalledWith({
      transcript: false,
      summary: true,
      filename: "title",
      transcript_formats: [],
    });
    await waitFor(() =>
      expect(
        (
          screen.getByRole("checkbox", {
            name: "Include transcript",
          }) as HTMLInputElement
        ).checked,
      ).toBe(false),
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "File name" }),
      "date_title",
    );
    expect(api.saveExportOptions).toHaveBeenLastCalledWith({
      transcript: false,
      summary: true,
      filename: "date_title",
      transcript_formats: [],
    });
  });

  it("saves transcript file formats and reports them after an export", async () => {
    vi.mocked(api.saveExportOptions).mockImplementation(async (options) => ({
      ...initialSettings,
      export: options,
    }));
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(
      screen.getByRole("tab", { name: "Export & storage" }),
    );
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Subtitles (.srt)" }),
    );
    expect(api.saveExportOptions).toHaveBeenLastCalledWith({
      transcript: true,
      summary: true,
      filename: "title",
      transcript_formats: ["srt"],
    });
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Plain text (.txt)" }),
    );
    expect(api.saveExportOptions).toHaveBeenLastCalledWith({
      transcript: true,
      summary: true,
      filename: "title",
      transcript_formats: ["srt", "txt"],
    });
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Subtitles (.srt)" }),
    );
    expect(api.saveExportOptions).toHaveBeenLastCalledWith({
      transcript: true,
      summary: true,
      filename: "title",
      transcript_formats: ["txt"],
    });
  });

  it("offers audio recovery only for interrupted recordings with unfinished tracks", async () => {
    const interrupted: MeetingDetail = {
      ...sample,
      meeting: {
        ...sample.meeting,
        source: "desktop",
        status: "interrupted",
      },
      tracks: [
        {
          kind: "mic",
          path: "fictional-mic.wav",
          size_bytes: null,
          device_name: "Fictional microphone",
          sample_rate: 48000,
          frames: 0,
          dropped_frames: 0,
          finalized: false,
        },
      ],
    };
    vi.mocked(api.getMeeting).mockResolvedValue(interrupted);
    vi.mocked(api.recoverAudio).mockImplementation(async () => {
      vi.mocked(api.getMeeting).mockResolvedValue({
        ...interrupted,
        tracks: [{ ...interrupted.tracks[0], frames: 480, finalized: true }],
      });
    });
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "Recover audio" }),
    );
    expect(api.recoverAudio).toHaveBeenCalledWith("sample");
    await screen.findByText(/original files were left unchanged/);
    expect(screen.queryByRole("button", { name: "Recover audio" })).toBeNull();
    expect(screen.getByDisplayValue("Original notes")).toBeTruthy();
  });
});

describe("meeting library", () => {
  const note: MeetingDetail = {
    ...sample,
    meeting: {
      ...sample.meeting,
      id: "note",
      title: "Untitled note",
      source: "note",
    },
    user_markdown: "",
    summary: null,
    summary_provider: null,
    summary_model: null,
  };

  it("creates a notes-only meeting without touching recording", async () => {
    await ready();
    vi.mocked(api.createNote).mockResolvedValue("note");
    vi.mocked(api.listMeetings).mockResolvedValue([
      note.meeting,
      sample.meeting,
    ]);
    vi.mocked(api.getMeeting).mockResolvedValue(note);
    await userEvent.click(screen.getByRole("button", { name: "New note" }));
    await screen.findByRole("heading", { name: "Untitled note" });
    expect(api.createNote).toHaveBeenCalledWith("Untitled note");
    expect(
      screen.queryByRole("button", { name: "Start simulation" }),
    ).toBeNull();
    expect(api.startCapture).not.toHaveBeenCalled();
    expect(
      screen.getByText("Note", { selector: ".source-badge" }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    expect(
      screen.getByText("No transcript. Notes have no recorded audio."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Transcribe/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete audio…" })).toBeNull();
  });

  it("deletes a meeting only after its exact title is typed", async () => {
    await ready();
    await userEvent.click(screen.getByLabelText("More meeting actions"));
    await userEvent.click(
      screen.getByRole("button", { name: "Delete meeting…" }),
    );
    const confirm = screen.getByRole("button", {
      name: "Delete meeting",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(
      screen.getByText(/Exported Markdown snapshots are not touched/),
    ).toBeTruthy();
    const input = screen.getByRole("textbox", {
      name: "Type the meeting title to confirm",
    });
    await userEvent.type(input, "Sample syn");
    expect(confirm.disabled).toBe(true);
    await userEvent.type(input, "c");
    expect(confirm.disabled).toBe(false);
    vi.mocked(api.listMeetings).mockResolvedValue([]);
    vi.mocked(api.deleteMeeting).mockResolvedValue();
    await userEvent.click(confirm);
    await screen.findByText(/Meeting deleted from this device/);
    expect(api.deleteMeeting).toHaveBeenCalledWith("sample");
    expect(api.deleteAudio).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue("Original notes")).toBeNull();
  });

  it("refuses deletion controls for the meeting being recorded", async () => {
    vi.mocked(api.getRecordingState).mockResolvedValue({
      revision: 1,
      status: "recording",
      meeting_id: "sample",
      source: "simulation",
      error: null,
      recording_offset_ms: null,
    });
    await ready();
    expect(
      (
        screen.getByRole("button", {
          name: "Delete meeting…",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("shows full-text matches and opens the meeting on the matching tab", async () => {
    const second = {
      ...sample.meeting,
      id: "second",
      title: "Planning review",
    };
    vi.mocked(api.listMeetings).mockResolvedValue([sample.meeting, second]);
    vi.mocked(api.searchMeetings).mockResolvedValue([
      { meeting_id: "second", kind: "transcript", snippet: "roadmap slipped" },
      { meeting_id: "second", kind: "title", snippet: "Planning review" },
    ]);
    await ready();
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Search meetings" }),
      "roadmap",
    );
    const hit = await screen.findByRole("button", { name: /roadmap slipped/ });
    expect(api.searchMeetings).toHaveBeenLastCalledWith("roadmap");
    expect(api.searchMeetings).not.toHaveBeenCalledWith("r");
    expect(screen.queryByText("No matching meetings.")).toBeNull();
    vi.mocked(api.getMeeting).mockResolvedValue({ ...sample, meeting: second });
    await userEvent.click(hit);
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: "Transcript" })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
    expect(api.getMeeting).toHaveBeenLastCalledWith("second");
  });
});

describe("transcript and audio", () => {
  const recorded: MeetingDetail = {
    ...sample,
    meeting: { ...sample.meeting, source: "desktop" },
    summary: null,
    summary_provider: null,
    summary_model: null,
    segments: [
      {
        speaker: "Others",
        timing: { kind: "timed", start_ms: 8250, end_ms: 9000 },
        text: "After pause",
      },
    ],
    tracks: [
      {
        kind: "mic",
        path: "mic.wav",
        device_name: "Microphone",
        sample_rate: 16000,
        frames: 48000,
        dropped_frames: 0,
        finalized: true,
        size_bytes: null,
      },
      {
        kind: "system",
        path: "system.wav",
        device_name: "Speakers",
        sample_rate: 16000,
        frames: 48000,
        dropped_frames: 0,
        finalized: true,
        size_bytes: null,
      },
    ],
  };

  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.mocked(api.audioSrc).mockImplementation((path) => `asset://${path}`);
  });

  it("links only summary and task times that match a stored segment, then opens and plays it", async () => {
    vi.mocked(api.getMeeting).mockResolvedValue({
      ...recorded,
      summary: "## Decisions\n- Moved the launch [0:08], budget [9:59]",
      summary_provider: "merge",
      summary_model: "m1",
      segment_meta: [{ id: 21, original_text: null }],
      action_items: [
        {
          id: 1,
          text: "Confirm launch [0:08]",
          owner: null,
          due_date: null,
          done: false,
          source: "summary",
          summary_id: 4,
        },
      ],
    });
    vi.mocked(api.audioPosition).mockResolvedValue(2250);
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    expect(screen.getByText("(unverified)")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Open transcript at 9:59" }),
    ).toBeNull();
    const links = screen.getAllByRole("button", {
      name: "Open transcript at 0:08",
    });
    expect(links).toHaveLength(2);
    await userEvent.click(links[0]);
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: "Transcript" })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
    await waitFor(() =>
      expect(api.audioPosition).toHaveBeenCalledWith("sample", "system", 8250),
    );
    const segment = document.getElementById("segment-21");
    expect(segment?.className).toContain("highlighted-segment");
    expect(document.activeElement).toBe(segment);
  });

  it("opens a cited library-answer time in its meeting on the transcript", async () => {
    const other = {
      ...recorded,
      meeting: { ...recorded.meeting, id: "rec", title: "Recorded sync" },
    };
    const withMeta = {
      ...other,
      segment_meta: [{ id: 31, original_text: null }],
    };
    vi.mocked(api.listMeetings).mockResolvedValue([
      sample.meeting,
      other.meeting,
    ]);
    vi.mocked(api.getMeeting).mockImplementation(async (id) =>
      id === "rec" ? withMeta : sample,
    );
    vi.mocked(api.askLibrary).mockResolvedValue({
      id: 1,
      question: "What moved?",
      answer: "Moved [M1 0:08] and [M2 0:08].",
      provider: "https://provider.example/v1",
      model: "test-chat",
      meeting_ids: ["rec"],
    });
    vi.mocked(api.audioPosition).mockResolvedValue(2250);
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "Ask across meetings" }),
    );
    await userEvent.click(screen.getByLabelText(/Recorded sync/));
    await userEvent.type(screen.getByLabelText("Question"), "What moved?");
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(api.askLibrary).toHaveBeenCalledWith(["rec"], "What moved?");
    expect(await screen.findByText("(unverified)")).toBeTruthy();
    await userEvent.click(
      await screen.findByRole("button", { name: "Open Recorded sync at 0:08" }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: "Transcript" })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
    expect(api.getMeeting).toHaveBeenLastCalledWith("rec");
    await waitFor(() =>
      expect(api.audioPosition).toHaveBeenCalledWith("rec", "system", 8250),
    );
    const segment = document.getElementById("segment-31");
    expect(segment?.className).toContain("highlighted-segment");
    expect(document.activeElement).toBe(segment);
    await userEvent.click(
      screen.getByRole("button", { name: "Ask across meetings" }),
    );
    expect(screen.getByLabelText("Library answer")).toBeTruthy();
  });

  it("seeks the speaker's track to the backend-mapped file time", async () => {
    vi.mocked(api.getMeeting).mockResolvedValue(recorded);
    vi.mocked(api.audioPosition).mockResolvedValue(2250);
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    const system = screen.getByLabelText(
      "Others (system audio)",
    ) as HTMLAudioElement;
    expect(system.getAttribute("src")).toBe("asset://system.wav");
    await userEvent.click(
      screen.getByRole("button", { name: "Play Others from 8.3s" }),
    );
    expect(api.audioPosition).toHaveBeenCalledWith("sample", "system", 8250);
    await waitFor(() => expect(system.currentTime).toBe(2.25));
    expect(
      (screen.getByLabelText("You (microphone)") as HTMLAudioElement)
        .currentTime,
    ).toBe(0);
  });

  it("shows rejected timing and never plays a guessed timestamp", async () => {
    vi.mocked(api.getMeeting).mockResolvedValue(recorded);
    vi.mocked(api.audioPosition).mockRejectedValue({
      code: "audio_timing",
      message:
        "The audio timing index is incomplete. Originals and previous transcripts are unchanged.",
    });
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Play Others from 8.3s" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The audio timing index is incomplete. Originals and previous transcripts are unchanged.",
    );
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    const player = screen.getByLabelText("Others (system audio)");
    expect(player).toBeInstanceOf(HTMLAudioElement);
    if (!(player instanceof HTMLAudioElement))
      throw new Error("Expected an audio player");
    expect(player.currentTime).toBe(0);
  });

  it("reports a playback failure and pauses audio when leaving the transcript", async () => {
    vi.mocked(api.getMeeting).mockResolvedValue(recorded);
    vi.mocked(api.audioPosition).mockResolvedValue(2250);
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(
      new Error("Output unavailable"),
    );
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Play Others from 8.3s" }),
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Audio could not play. Check your output device and try again.",
    );
    vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(2);
  });

  it("reports missing audio without a silent playback failure", async () => {
    vi.mocked(api.getMeeting).mockResolvedValue(recorded);
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    fireEvent.error(screen.getByLabelText("You (microphone)"));
    expect(screen.getByRole("alert").textContent).toBe(
      "An audio file could not be opened. It may have been moved or is incomplete.",
    );
  });

  it("jumps from a [mm:ss] note line to the audio", async () => {
    vi.mocked(api.getMeeting).mockResolvedValue({
      ...recorded,
      user_markdown: "Original notes\n[00:12] decision",
    });
    render(<App />);
    const editor = (await screen.findByDisplayValue(
      /\[00:12\] decision/,
    )) as HTMLTextAreaElement;
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Jump to audio",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    editor.setSelectionRange(0, 0);
    await userEvent.click(
      screen.getByRole("button", { name: "Jump to audio" }),
    );
    expect(screen.getByText(/Put the cursor on a line/)).toBeTruthy();
    editor.setSelectionRange(editor.value.length, editor.value.length);
    await userEvent.click(
      screen.getByRole("button", { name: "Jump to audio" }),
    );
    expect(
      screen
        .getByRole("tab", { name: "Transcript" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      (screen.getByLabelText("You (microphone)") as HTMLAudioElement)
        .currentTime,
    ).toBe(12);
    expect(api.audioPosition).not.toHaveBeenCalled();
  });

  it("inserts a backend-derived timestamp at the caret while recording", async () => {
    const live = {
      revision: 1,
      status: "recording" as const,
      meeting_id: "sample",
      source: "desktop",
      error: null,
      recording_offset_ms: 1000,
    };
    vi.mocked(api.getRecordingState)
      .mockResolvedValueOnce(live)
      .mockResolvedValue({ ...live, recording_offset_ms: 65_400 });
    await ready();
    const editor = screen.getByDisplayValue(
      "Original notes",
    ) as HTMLTextAreaElement;
    editor.setSelectionRange(0, 0);
    await userEvent.click(
      screen.getByRole("button", { name: "Insert timestamp" }),
    );
    await waitFor(() => expect(editor.value).toBe("[01:05] Original notes"));
    expect(screen.queryByRole("button", { name: "Jump to audio" })).toBeNull();
  });

  it("shows per-track progress and cancels without replacing the transcript", async () => {
    let progress: (value: SttProgress) => void = () => {};
    vi.mocked(api.onSttProgress).mockImplementation(async (callback) => {
      progress = callback;
      return () => {};
    });
    let fail!: (reason: unknown) => void;
    vi.mocked(api.transcribeMeeting).mockReturnValue(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    vi.mocked(api.cancelTranscription).mockResolvedValue(true);
    vi.mocked(api.sttStatus).mockResolvedValue(installed);
    vi.mocked(api.getMeeting).mockResolvedValue(recorded);
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Re-transcribe audio" }),
    );
    expect(
      screen
        .getByRole("button", { name: "Cancel transcription" })
        .getAttribute("disabled"),
    ).toBe("");
    act(() => progress({ stage: "transcribing", track: "mic", percent: 40 }));
    expect(
      await screen.findByText(/Transcribing You \(microphone\): 40%/),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel transcription" }),
    );
    expect(api.cancelTranscription).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(api.getMeeting).mock.calls.length;
    await act(async () =>
      fail({
        code: "stt_cancelled",
        message: "Transcription was cancelled. Nothing was saved.",
      }),
    );
    expect(
      await screen.findByText(
        "Transcription was cancelled. Nothing was saved.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Transcribing You/)).toBeNull();
    expect(screen.getByText(/After pause/)).toBeTruthy();
    expect(vi.mocked(api.getMeeting).mock.calls.length).toBe(calls);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("saves transcription settings and an optional stop shortcut", async () => {
    vi.mocked(api.saveSttSettings).mockResolvedValue({
      ...initialSettings,
      stt_language: "de",
      stt_prompt: "Okta",
      stt_model: "base",
    });
    vi.mocked(api.saveSettings).mockResolvedValue({
      ...initialSettings,
      stop_shortcut: "Alt+Shift+S",
    });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.selectOptions(
      screen.getByLabelText("Available speech models"),
      "base",
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Spoken language"),
      "de",
    );
    await userEvent.type(screen.getByLabelText(/Vocabulary hint/), "Okta");
    await userEvent.click(
      screen.getByRole("button", { name: "Save transcription settings" }),
    );
    expect(api.saveSttSettings).toHaveBeenCalledWith("de", "Okta", "base");
    await userEvent.click(screen.getByRole("tab", { name: "Recording" }));
    expect(screen.queryByRole("button", { name: "Save shortcuts" })).toBeNull();
    await userEvent.type(
      screen.getByLabelText("Stop recording shortcut (optional)"),
      "Alt+Shift+S",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save shortcuts" }),
    );
    expect(api.saveSettings).toHaveBeenCalledWith(
      "CommandOrControl+Shift+Space",
      "Alt+Shift+S",
    );
    expect(screen.getByText(/no shortcut to start recording/)).toBeTruthy();
  });
});

describe("saved connections settings tabs", () => {
  it("can cancel the explicit speech installer while other settings are busy", async () => {
    vi.mocked(api.sttInstall).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.cancelModelDownload).mockResolvedValue();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(
      screen.getByRole("button", { name: /Download speech engine and models/ }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Cancel speech download" }),
    );
    expect(api.cancelModelDownload).toHaveBeenCalledOnce();
  });
  it("ignores startup key status that arrives after saving a reusable connection", async () => {
    let deliver: (status: "missing") => void = () => {};
    vi.mocked(api.providerKeyStatus)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          deliver = resolve;
        }),
      )
      .mockResolvedValue("present");
    const saved = {
      id: "remote",
      name: "Remote",
      base_url: textPlan.base_url,
      revision: 1,
    };
    const connected: Settings = {
      ...initialSettings,
      saved_connections: [saved],
      provider_assignments: {
        llm: { connection_id: saved.id, model: "chat", revision: 1 },
        cloud_stt: null,
      },
      llm: { base_url: saved.base_url, model: "chat", revision: 1 },
    };
    vi.mocked(api.getSettings).mockResolvedValue(connected);
    vi.mocked(api.saveApiConnection).mockResolvedValue({
      ...connected,
      saved_connections: [{ ...saved, revision: 2 }],
    });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("tab", { name: "Connections" }));
    await userEvent.selectOptions(
      screen.getAllByLabelText("Saved connection")[0],
      "remote",
    );
    const key = screen.getAllByLabelText("API key")[0];
    await userEvent.type(key, "synthetic-key");
    await userEvent.click(
      screen.getByRole("button", { name: "Save connection" }),
    );
    await waitFor(() => expect(api.providerKeyStatus).toHaveBeenCalledTimes(4));
    expect(key).toHaveProperty("value", "");
    await act(async () => deliver("missing"));
    await userEvent.click(screen.getByRole("button", { name: "Close panel" }));
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    expect(
      screen.getByRole("button", { name: "Enhance notes" }),
    ).toHaveProperty("disabled", false);
  });
  it("keeps a connection draft across sections but clears its key", async () => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("tab", { name: "Connections" }));
    await userEvent.type(screen.getByLabelText("Connection name"), "Draft");
    await userEvent.type(screen.getByLabelText("API key"), "draft-key");
    await userEvent.click(screen.getByRole("tab", { name: "Recording" }));
    await userEvent.click(screen.getByRole("tab", { name: "Connections" }));
    expect(screen.getByLabelText("Connection name")).toHaveProperty(
      "value",
      "Draft",
    );
    expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
    expect(api.saveApiConnection).not.toHaveBeenCalled();
    expect(api.saveSttMode).not.toHaveBeenCalled();
    expect(api.listApiConnectionModels).not.toHaveBeenCalled();
  });
});

describe("provider workflows", () => {
  const recorded: MeetingDetail = {
    ...sample,
    meeting: { ...sample.meeting, source: "desktop" },
    summary: null,
    tracks: [
      {
        kind: "mic",
        path: "mic.wav",
        device_name: "Mic",
        sample_rate: 16000,
        frames: 16000,
        dropped_frames: 0,
        finalized: true,
        size_bytes: 32044,
      },
    ],
  };
  const cloudSettings: Settings = {
    ...initialSettings,
    llm: {
      base_url: "https://chat.example/v1",
      model: "chat-model",
      revision: 4,
    },
    cloud_stt: {
      base_url: "https://speech.example/v1",
      model: "speech-model",
      revision: 2,
    },
    stt_mode: "cloud",
  };
  it("uploads audio in cloud mode without requiring local downloads", async () => {
    vi.mocked(api.getSettings).mockResolvedValue(cloudSettings);
    vi.mocked(api.providerKeyStatus).mockResolvedValue("present");
    vi.mocked(api.getMeeting).mockResolvedValue(recorded);
    vi.mocked(api.transcribeMeeting).mockResolvedValue(undefined);
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Transcribe audio" }),
    );
    await waitFor(() =>
      expect(api.transcribeMeeting).toHaveBeenCalledWith("sample"),
    );
    expect(api.sttInstall).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Original notes")).toBeTruthy();
  });

  it("renders untimed cloud text without fabricated timestamps or seek controls", async () => {
    vi.mocked(api.getMeeting).mockResolvedValue({
      ...recorded,
      transcript_provider: "https://speech.example/v1",
      transcript_model: "speech-model",
      segments: [
        {
          speaker: "You",
          timing: { kind: "untimed" },
          text: "A text-only transcript.",
        },
      ],
    });
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    expect(screen.getByText("Untimed")).toBeTruthy();
    expect(screen.getByText(/A text-only transcript/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Play You from/ })).toBeNull();
    expect(screen.queryByText("0.0s")).toBeNull();
    expect(
      screen.getByText(
        /Generated with https:\/\/speech.example\/v1 \/ speech-model/,
      ),
    ).toBeTruthy();
    expect(api.audioPosition).not.toHaveBeenCalled();
  });

  it("removes sample and simulation creation while retaining historical labels", async () => {
    await ready();
    expect(
      screen.queryByRole("button", { name: "Load fictional sample" }),
    ).toBeNull();
    expect(screen.getAllByText("Fictional sample").length).toBeGreaterThan(0);
    await userEvent.click(
      screen.getByRole("button", { name: "New recording" }),
    );
    expect(screen.queryByText("Try a simulation instead")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Start simulation" }),
    ).toBeNull();
  });
});

describe("settings defaults", () => {
  it("saves the automatic-processing default and imports the old browser value once", async () => {
    localStorage.setItem(
      "openmeet.automaticProcessing",
      JSON.stringify({ mode: "final", summary: "standup-v1" }),
    );
    await ready();
    await waitFor(() =>
      expect(api.saveProcessingDefault).toHaveBeenCalledWith(
        "final",
        "standup-v1",
      ),
    );
    await waitFor(() =>
      expect(localStorage.getItem("openmeet.automaticProcessing")).toBeNull(),
    );
    await chooseProcessing("live");
    expect(api.saveProcessingDefault).toHaveBeenLastCalledWith("live", null);
  });

  it("saves default devices only when both are chosen and keeps a missing one visible", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({
      ...initialSettings,
      microphone_id: "missing-mic",
    });
    vi.mocked(api.saveDefaultDevices).mockImplementation(async (mic, out) => ({
      ...initialSettings,
      microphone_id: mic,
      output_id: out,
    }));
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("tab", { name: "Recording" }));
    const microphone = screen.getByLabelText(
      "Default microphone",
    ) as HTMLSelectElement;
    expect(microphone.value).toBe("missing-mic");
    expect(
      within(microphone).getByRole("option", { name: "Not connected" }),
    ).toBeTruthy();
    expect(api.saveDefaultDevices).not.toHaveBeenCalled();
    const real = within(microphone).getAllByRole(
      "option",
    )[1] as HTMLOptionElement;
    await userEvent.selectOptions(microphone, real.value);
    const output = (
      screen.getByLabelText("Default system output") as HTMLSelectElement
    ).value;
    expect(api.saveDefaultDevices).toHaveBeenCalledWith(real.value, output);
  });

  it("records a shortcut from a key press", async () => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("tab", { name: "Recording" }));
    const capture = screen.getByRole("button", {
      name: "Press keys for stop recording shortcut (optional)",
    });
    await userEvent.click(capture);
    fireEvent.keyDown(capture, {
      key: "Shift",
      code: "ShiftLeft",
      shiftKey: true,
    });
    fireEvent.keyDown(capture, {
      key: "S",
      code: "KeyS",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(
      screen.getByLabelText("Stop recording shortcut (optional)"),
    ).toHaveProperty("value", "CommandOrControl+Shift+S");
    expect(screen.getByRole("button", { name: "Save shortcuts" })).toBeTruthy();
    expect(screen.queryByText("Other engines (not supported yet)")).toBeNull();
    // Tab still moves focus, and a key without a modifier is not taken.
    await userEvent.click(capture);
    expect(fireEvent.keyDown(capture, { key: "Tab", code: "Tab" })).toBe(true);
    fireEvent.keyDown(capture, { key: "s", code: "KeyS" });
    expect(
      screen.getByLabelText("Stop recording shortcut (optional)"),
    ).toHaveProperty("value", "CommandOrControl+Shift+S");
  });

  it("keeps the old processing default when saving it fails", async () => {
    localStorage.setItem(
      "openmeet.automaticProcessing",
      JSON.stringify({ mode: "both", summary: null }),
    );
    vi.mocked(api.saveProcessingDefault).mockRejectedValue(
      new Error("Database busy"),
    );
    await ready();
    await waitFor(() => expect(api.saveProcessingDefault).toHaveBeenCalled());
    expect(localStorage.getItem("openmeet.automaticProcessing")).not.toBeNull();
  });

  it("scans for local models only once Models is expanded, and shows a failed scan", async () => {
    vi.mocked(api.scanLocalModels).mockRejectedValue(
      new Error("Model folder unreadable"),
    );
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("tab", { name: "Models" }));
    expect(api.scanLocalModels).not.toHaveBeenCalled();
    const details = screen
      .getByText("Advanced: local model library")
      .closest("details") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(await screen.findByText("Model folder unreadable")).toBeTruthy();
    expect(api.scanLocalModels).toHaveBeenCalledWith(null);
  });
});

describe("meeting detection", () => {
  const zoom = { id: "C:#Apps#zoom.exe", name: "Zoom" };
  const detecting = { ...initialSettings, detection_enabled: true };
  const deliver = (apps: { id: string; name: string }[]) =>
    act(() => vi.mocked(api.onMicrophoneApps).mock.calls[0][0](apps));

  it("prompts once per microphone session and only opens setup", async () => {
    vi.mocked(api.getSettings).mockResolvedValue(detecting);
    await ready();
    deliver([zoom]);
    const card = await screen.findByRole("group", { name: "Meeting detected" });
    expect(card.textContent).toContain("Zoom is using your microphone");
    expect(api.requestAttention).toHaveBeenCalled();
    await userEvent.click(
      within(card).getByRole("button", { name: "Set up recording" }),
    );
    expect(screen.getByRole("dialog", { name: "New recording" })).toBeTruthy();
    expect(screen.getByDisplayValue("Zoom meeting")).toBeTruthy();
    expect(api.startCapture).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("group", { name: "Meeting detected" }),
    ).toBeNull();
    // Still the same session: no second prompt. A new session prompts again.
    deliver([zoom]);
    expect(
      screen.queryByRole("group", { name: "Meeting detected" }),
    ).toBeNull();
    deliver([]);
    deliver([zoom]);
    expect(
      await screen.findByRole("group", { name: "Meeting detected" }),
    ).toBeTruthy();
  });

  it("stops prompting for an app the user chose to ignore", async () => {
    vi.mocked(api.getSettings).mockResolvedValue(detecting);
    vi.mocked(api.setDetectionIgnored).mockResolvedValue({
      ...detecting,
      detection_ignored: [zoom],
    });
    await ready();
    deliver([zoom]);
    await userEvent.click(
      await screen.findByRole("button", { name: "Never for Zoom" }),
    );
    expect(api.setDetectionIgnored).toHaveBeenCalledWith(zoom.id, "Zoom", true);
    deliver([]);
    deliver([zoom]);
    expect(
      screen.queryByRole("group", { name: "Meeting detected" }),
    ).toBeNull();
  });

  it("does not prompt while detection is off or OpenMeet is recording", async () => {
    await ready();
    deliver([zoom]);
    expect(
      screen.queryByRole("group", { name: "Meeting detected" }),
    ).toBeNull();
    vi.mocked(api.saveDetection).mockResolvedValue(detecting);
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("tab", { name: "Recording" }));
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: "Offer to record when another app uses the microphone",
      }),
    );
    expect(api.saveDetection).toHaveBeenCalledWith(true);
    await screen.findByRole("group", { name: "Meeting detected" });
    act(() =>
      vi.mocked(api.onRecordingState).mock.calls[0][0]({
        revision: 5,
        status: "recording",
        meeting_id: "sample",
        source: "desktop",
        error: null,
        recording_offset_ms: null,
      }),
    );
    expect(
      screen.queryByRole("group", { name: "Meeting detected" }),
    ).toBeNull();
  });
});

describe("device refresh", () => {
  it("lists a saved device connected after startup when New recording opens", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({
      ...initialSettings,
      microphone_id: "headset",
    });
    vi.mocked(api.listDevices)
      .mockResolvedValueOnce({
        capture_supported: true,
        microphones: [{ id: "mic", name: "Microphone" }],
        outputs: [{ id: "out", name: "Speakers" }],
      })
      .mockResolvedValue({
        capture_supported: true,
        microphones: [
          { id: "mic", name: "Microphone" },
          { id: "headset", name: "Headset" },
        ],
        outputs: [{ id: "out", name: "Speakers" }],
      });
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "New recording" }),
    );
    // Opening New recording lists devices again, so no manual refresh is needed.
    await waitFor(() =>
      expect(
        (
          screen.getByRole("combobox", {
            name: "Microphone",
          }) as HTMLSelectElement
        ).value,
      ).toBe("headset"),
    );
    await waitFor(() =>
      expect(
        screen.queryByText(/Selected microphone is unavailable/),
      ).toBeNull(),
    );
    expect(api.listDevices).toHaveBeenCalledTimes(2);
  });

  it("keeps an unavailable chosen microphone after a refresh that still lacks it", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({
      ...initialSettings,
      microphone_id: "missing-mic",
    });
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "New recording" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh devices" }),
    );
    await screen.findByText(/Devices refreshed/);
    expect(
      (
        screen.getByRole("combobox", {
          name: "Microphone",
        }) as HTMLSelectElement
      ).value,
    ).toBe("missing-mic");
    expect(screen.getByText(/Selected microphone is unavailable/)).toBeTruthy();
  });
});
