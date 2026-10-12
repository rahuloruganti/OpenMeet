import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import {
  api,
  type AudioHealth,
  type MeetingDetail,
  type SttProgress,
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
      start: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      createFixture: vi.fn(),
      saveNotes: vi.fn(),
      getSettings: vi.fn(),
      mergeKeyStatus: vi.fn(),
      sttStatus: vi.fn(),
      sttInstall: vi.fn(),
      transcribeMeeting: vi.fn(),
      generateSummary: vi.fn(),
      onSttProgress: vi.fn(),
      importMergeKey: vi.fn(),
      deleteMergeKey: vi.fn(),
      listMergeModels: vi.fn(),
      saveMergeModel: vi.fn(),
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
      askMeeting: vi.fn(),
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
  },
  user_markdown: "Original notes",
  notes_revision: 0,
  summary: "A fictional summary.",
  summary_provider: "fixture",
  summary_model: "hand-written",
  segments: [],
  tracks: [],
};

const initialSettings = {
  vault_folder: null,
  pause_shortcut: "CommandOrControl+Shift+Space",
  microphone_id: null,
  output_id: null,
  merge_model: null,
};

const notInstalled = {
  engine: false,
  model: false,
  vad: false,
  installed: false,
  missing_bytes: 496_000_000,
  supported: true,
};
const installed = {
  engine: true,
  model: true,
  vad: true,
  installed: true,
  missing_bytes: 0,
  supported: true,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(api.isDesktop).mockReturnValue(true);
  vi.mocked(api.listMeetings).mockResolvedValue([sample.meeting]);
  vi.mocked(api.getMeeting).mockResolvedValue(sample);
  vi.mocked(api.getRecordingState).mockResolvedValue({
    revision: 0,
    status: "idle",
    meeting_id: null,
    source: null,
    error: null,
  });
  vi.mocked(api.getSettings).mockResolvedValue(initialSettings);
  vi.mocked(api.listDevices).mockResolvedValue({
    capture_supported: true,
    microphones: [{ id: "mic", name: "Microphone" }],
    outputs: [{ id: "out", name: "Speakers" }],
  });
  vi.mocked(api.getStartupWarning).mockResolvedValue(null);
  vi.mocked(api.saveNotes).mockResolvedValue(1);
  vi.mocked(api.mergeKeyStatus).mockResolvedValue(false);
  vi.mocked(api.sttStatus).mockResolvedValue(notInstalled);
  vi.mocked(api.audioUsage).mockResolvedValue(0);
  vi.mocked(api.searchMeetings).mockResolvedValue([]);
  vi.mocked(api.listSummaries).mockResolvedValue([]);
  vi.mocked(api.planSummary).mockResolvedValue(1);
  for (const method of [
    api.onRecordingState,
    api.onMeetingUpdated,
    api.onCloseRequested,
    api.onError,
    api.onAudioHealth,
    api.onSttProgress,
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

  it("does not steal quit-confirmation focus when a settings panel is open", async () => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    act(() => vi.mocked(api.onCloseRequested).mock.calls[0][0]());
    const quit = await screen.findByRole("button", { name: "Save and quit" });
    expect(document.activeElement).toBe(quit);
    await userEvent.click(screen.getByRole("button", { name: "Keep working" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
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
    await userEvent.click(screen.getByRole("checkbox"));
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
    });
    vi.mocked(api.stop).mockResolvedValue({
      revision: 2,
      status: "stopped",
      meeting_id: "sample",
      source: "desktop",
      error: null,
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
    expect(screen.getByText("No API key saved")).toBeTruthy();
    expect(screen.queryByLabelText(/API key/)).toBeNull();
    expect(api.listMergeModels).not.toHaveBeenCalled();
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

  it("opens recording setup without capture and resets consent when reopened", async () => {
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
    expect(api.start).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("checkbox"));
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
    await userEvent.click(trigger);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
      false,
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Start recording",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
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

  it("labels simulation clearly and requires acknowledgement before starting", async () => {
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "New recording" }),
    );
    const start = screen.getByRole("button", {
      name: "Start recording",
    }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(
      screen.getByText(/have consent to record microphone and system audio/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox"));
    expect(start.disabled).toBe(false);
    vi.mocked(api.startCapture).mockResolvedValue({
      revision: 1,
      status: "recording",
      meeting_id: "sample",
      source: "desktop",
      error: null,
    });
    await userEvent.click(start);
    await waitFor(() =>
      expect(api.startCapture).toHaveBeenCalledWith("Untitled meeting", true, {
        microphoneId: "mic",
        outputId: "out",
      }),
    );
    await screen.findByText("Recording: recording");
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
    await userEvent.click(screen.getByRole("checkbox"));
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
    });
    vi.mocked(api.stop).mockResolvedValue({
      revision: 2,
      status: "stopped",
      meeting_id: "sample",
      source: "desktop",
      error: null,
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
    expect(api.getMeeting).toHaveBeenCalledOnce();
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
    });
    vi.mocked(api.stop).mockResolvedValue({
      revision: 2,
      status: "stopped",
      meeting_id: "sample",
      source: "desktop",
      error: null,
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
    });
    let finishExport!: (result: {
      path: string;
      created_copy: boolean;
    }) => void;
    vi.mocked(api.exportMeeting).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishExport = resolve;
        }),
    );
    vi.mocked(api.pause).mockResolvedValue({
      revision: 2,
      status: "paused",
      meeting_id: "sample",
      source: "desktop",
      error: "Device stopped responding",
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
      finishExport({ path: "sample.md", created_copy: false }),
    );
  });

  it("flushes typed notes before export", async () => {
    await ready();
    vi.mocked(api.exportMeeting).mockResolvedValue({
      path: "C:/notes/sample.md",
      created_copy: false,
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
      });
      notify({
        revision: 1,
        status: "recording",
        meeting_id: "sample",
        source: "simulation",
        error: null,
      });
    });
    expect(screen.getByText("Simulation: paused")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  });

  it("imports the key backend-side, lists Merge models only on request, and saves an available one", async () => {
    vi.mocked(api.importMergeKey).mockResolvedValue(true);
    vi.mocked(api.listMergeModels).mockResolvedValue([
      {
        model: "openai/gpt-5.4",
        display_name: "GPT 5.4",
        available: true,
        unavailable_reason: null,
      },
      {
        model: "x/gated",
        display_name: null,
        available: false,
        unavailable_reason: "vendor_access_required",
      },
    ]);
    vi.mocked(api.saveMergeModel).mockResolvedValue({
      ...initialSettings,
      merge_model: "openai/gpt-5.4",
    });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(api.listMergeModels).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole("button", {
          name: "Connect / refresh Merge models",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await userEvent.click(
      screen.getByRole("button", { name: "Import key from environment" }),
    );
    await screen.findByText("API key saved in the OS keychain");
    // The import command takes no key argument: the webview never holds it.
    expect(api.importMergeKey).toHaveBeenCalledWith();
    await userEvent.click(
      screen.getByRole("button", { name: "Connect / refresh Merge models" }),
    );
    await screen.findByRole("option", { name: "GPT 5.4" });
    expect(
      (
        screen.getByRole("option", {
          name: "x/gated (unavailable: vendor_access_required)",
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);
    const save = screen.getByRole("button", {
      name: "Save Merge model",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.selectOptions(
      screen.getByLabelText("Merge model"),
      "openai/gpt-5.4",
    );
    await userEvent.click(save);
    await screen.findByText("Saved Merge model: openai/gpt-5.4");
    expect(api.saveMergeModel).toHaveBeenCalledWith("openai/gpt-5.4");
  });

  it("shows Merge failures, keeps the saved model, and does not block startup on a keychain error", async () => {
    vi.mocked(api.mergeKeyStatus).mockRejectedValue(new Error("keychain"));
    vi.mocked(api.getSettings).mockResolvedValue({
      ...initialSettings,
      merge_model: "saved/model",
    });
    vi.mocked(api.importMergeKey).mockResolvedValue(true);
    vi.mocked(api.listMergeModels).mockRejectedValue(
      new Error("Merge rejected the API key."),
    );
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("API key status unavailable")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Import key from environment" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Connect / refresh Merge models" }),
    );
    await screen.findByText(/Merge rejected the API key/);
    expect(screen.getByText("Saved Merge model: saved/model")).toBeTruthy();
    expect(api.saveMergeModel).not.toHaveBeenCalled();
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
      await screen.findByText(/Downloading model: 100 \/ 465 MB/),
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
            start_ms: 1000,
            end_ms: 2000,
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

  it("asks for explicit confirmation before sending text to Merge, then shows provenance", async () => {
    const model = "anthropic/claude-haiku-5-5";
    vi.mocked(api.mergeKeyStatus).mockResolvedValue(true);
    vi.mocked(api.getSettings).mockResolvedValue({
      ...initialSettings,
      merge_model: model,
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
    const enhance = screen.getByRole("button", { name: "Enhance notes" });
    await userEvent.click(enhance);
    expect(screen.getByText(/Not sent: audio recordings/)).toBeTruthy();
    expect(screen.getAllByText(model).length).toBeGreaterThan(0);
    expect(api.generateSummary).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/Not sent: audio recordings/)).toBeNull();
    expect(api.generateSummary).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Enhance notes" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Send and generate summary" }),
    );
    await screen.findByText(`Summary · generated by ${model} via merge`);
    expect(api.generateSummary).toHaveBeenCalledWith(
      "sample",
      true,
      "general-v1",
      1,
    );
    expect(screen.getByText(/A real summary\./)).toBeTruthy();
    expect(screen.getByDisplayValue("Original notes")).toBeTruthy();
  });

  const mergeReady = () => {
    vi.mocked(api.mergeKeyStatus).mockResolvedValue(true);
    vi.mocked(api.getSettings).mockResolvedValue({
      ...initialSettings,
      merge_model: "openai/gpt-x",
    });
  };

  it("names the template and request count before a long summary is sent", async () => {
    mergeReady();
    vi.mocked(api.planSummary).mockResolvedValue(4);
    vi.mocked(api.generateSummary).mockResolvedValue(undefined);
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Template" }),
      "Stand-up",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Enhance notes" }),
    );
    const card = screen.getByRole("group", { name: "Confirm sending" });
    expect(card.textContent).toContain("Template: Stand-up");
    expect(card.textContent).toContain("4 requests (the transcript in 3 parts");
    expect(api.generateSummary).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Send and generate summary" }),
    );
    await waitFor(() =>
      expect(api.generateSummary).toHaveBeenCalledWith(
        "sample",
        true,
        "standup-v1",
        4,
      ),
    );
  });

  it("shows a refused plan as an error and opens no consent card", async () => {
    mergeReady();
    vi.mocked(api.planSummary).mockRejectedValue({
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
    expect(screen.queryByRole("group", { name: "Confirm sending" })).toBeNull();
    expect(api.generateSummary).not.toHaveBeenCalled();
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
      },
      {
        id: 2,
        provider: "merge",
        model: "m2",
        template: "general-v1",
        markdown: "## Summary\nOlder.",
      },
      {
        id: 1,
        provider: "fixture",
        model: "hand-written",
        template: "fixture",
        markdown: "A fictional summary.",
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

  it("asks a question only after per-question consent and does not store the answer", async () => {
    mergeReady();
    vi.mocked(api.askMeeting).mockResolvedValue(
      "The **budget** is 40k [1:05].",
    );
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Ask this meeting" }),
      "What is the budget?",
    );
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));
    const card = screen.getByRole("group", {
      name: "Confirm sending question",
    });
    expect(card.textContent).toContain("of this meeting only");
    expect(card.textContent).toContain("not saved");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.askMeeting).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Send question" }),
    );
    expect(api.askMeeting).toHaveBeenCalledWith(
      "sample",
      "What is the budget?",
      true,
    );
    expect((await screen.findByText("budget")).tagName).toBe("STRONG");
    expect(api.generateSummary).not.toHaveBeenCalled();
    expect(api.saveNotes).not.toHaveBeenCalled();
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
    expect(api.start).not.toHaveBeenCalled();
  });

  it("offers a disabled Enhance notes slot that explains why", async () => {
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    const button = screen.getByRole("button", {
      name: "Enhance notes",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(
      screen.getByText(/Import a Merge API key in Settings first/),
    ).toBeTruthy();
    expect(screen.getByText("A fictional summary.")).toBeTruthy();
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
    expect(api.start).not.toHaveBeenCalled();
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
