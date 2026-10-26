import { mockApiModule } from "../shared/test/api-mock";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  type MeetingDetail,
  type SttProgress,
  type SessionProcessingSnapshot,
} from "../shared/api/api";
import {
  sample,
  sessionPlan,
  sessionSnapshot,
  initialSettings,
  installed,
  settingsIndex,
  ready,
  installDefaultMocks,
} from "../shared/test/app-harness";

vi.mock("../shared/api/api", async (original) =>
  mockApiModule(await original<typeof import("../shared/api/api")>()),
);

beforeEach(installDefaultMocks);

/** One Settings section; every section renders at once, so queries must be scoped. */
function settingsSection(name: string) {
  return within(screen.getByRole("region", { name }));
}

describe("speech engine and automatic processing", () => {
  it("refreshes the engine status after transcription settings change the model", async () => {
    const partial = {
      ...installed,
      installed: false,
      models: [
        { id: "base", size: 147_951_465, installed: true },
        { id: "small", size: 487_601_967, installed: false },
      ],
    };
    const both = {
      ...installed,
      models: [
        { id: "base", size: 147_951_465, installed: true },
        { id: "small", size: 487_601_967, installed: true },
      ],
    };
    vi.mocked(api.sttStatus)
      .mockResolvedValueOnce(partial)
      .mockResolvedValue(both);
    vi.mocked(api.saveSttSettings).mockImplementation(
      async (language, prompt, model) => ({
        ...initialSettings,
        stt_language: language,
        stt_prompt: prompt,
        stt_model: model,
      }),
    );
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(settingsIndex("Transcription"));
    expect(settingsIndex("Transcription").getAttribute("aria-current")).toBe(
      "location",
    );
    const transcription = settingsSection("Transcription");
    expect(await transcription.findByText(/Not downloaded/)).toBeTruthy();
    // Choosing a model saves it and re-reads what the engine can now do.
    await userEvent.selectOptions(
      transcription.getByRole("combobox", { name: "Speech model" }),
      "base",
    );
    expect(await transcription.findByText("Ready")).toBeTruthy();
    expect(api.saveSttSettings).toHaveBeenCalledWith("auto", "", "base");
    expect(transcription.queryByText(/Not downloaded/)).toBeNull();
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
    await userEvent.click(settingsIndex("Transcription"));
    const transcription = settingsSection("Transcription");
    expect(await transcription.findByText(/Not downloaded/)).toBeTruthy();
    await userEvent.click(
      transcription.getByRole("button", { name: "Download" }),
    );
    act(() =>
      progress({
        stage: "model",
        downloaded: 100 * 1024 * 1024,
        total: 465 * 1024 * 1024,
      }),
    );
    expect(await transcription.findByText("Downloading 22%")).toBeTruthy();
    await act(async () => finish(installed));
    await transcription.findByText("Ready");
    // Nothing is left to download, so the request is not offered again.
    expect(
      transcription.queryByRole("button", { name: "Download" }),
    ).toBeNull();
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

  it("warns before recording when the chosen speech engine is not ready", async () => {
    await ready();
    const openRecording = async () => {
      await userEvent.click(
        screen.getByRole("button", { name: "New recording" }),
      );
      const dialog = screen.getByRole("dialog", { name: "New recording" });
      // The warning is a detail, so it sits behind More options.
      await userEvent.click(within(dialog).getByText("More options"));
      return dialog;
    };
    const dialog = await openRecording();
    expect(
      (await within(dialog).findByText(/speech engine is not downloaded/))
        .textContent,
    ).toContain("Recording is kept");
  });

  it.each([
    "failed",
    "completed",
    "cancelled",
    "interrupted",
    "needs_attention",
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

  it.each(["completed", "cancelled"] as const)(
    "dismisses a %s processing panel until its state changes",
    async (stage) => {
      vi.mocked(api.getSessionProcessing).mockResolvedValue(
        sessionSnapshot(5, stage),
      );
      await ready();
      await screen.findByRole("region", { name: "Session processing" });
      await userEvent.click(
        screen.getByRole("button", { name: "Dismiss processing status" }),
      );
      expect(
        screen.queryByRole("region", { name: "Session processing" }),
      ).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("main"));
      // A newer revision of the same meeting shows the panel again.
      const next = sessionSnapshot(6, stage);
      vi.mocked(api.getSessionProcessing).mockResolvedValue(next);
      act(() =>
        vi.mocked(api.onSessionProcessingChanged).mock.calls[0]?.[0](next),
      );
      await screen.findByRole("region", { name: "Session processing" });
    },
  );

  it("offers no dismiss for a failed run, which still needs attention", async () => {
    vi.mocked(api.getSessionProcessing).mockResolvedValue(
      sessionSnapshot(5, "failed"),
    );
    await ready();
    await screen.findByRole("region", { name: "Session processing" });
    expect(
      screen.queryByRole("button", { name: "Dismiss processing status" }),
    ).toBeNull();
  });

  it.each([
    [1, "request"],
    [3, "requests"],
  ])(
    "shows %i %s with readable sizes and a stage label",
    async (requests, noun) => {
      const snapshot = sessionSnapshot(5, "finalizing_audio");
      if (!snapshot.workflow) throw new Error("Missing workflow");
      snapshot.workflow.requests_used = requests;
      snapshot.workflow.upload_bytes_used = 2_200_000;
      snapshot.workflow.text_bytes_used = 4096;
      vi.mocked(api.getSessionProcessing).mockResolvedValue(snapshot);
      await ready();
      const status = await screen.findByRole("region", {
        name: "Session processing",
      });
      expect(within(status).getByRole("status").textContent).toBe(
        "Finishing audio",
      );
      // Sizes and counts are detail: a muted line beside the status, no icon to open.
      expect(
        screen.getByText(
          `Used ${requests} ${noun}, 2.1 MB of audio and 4 KB of text.`,
        ),
      ).toBeTruthy();
    },
  );

  it("hides the usage line when nothing was used", async () => {
    const snapshot = sessionSnapshot(5, "finalizing_audio");
    if (!snapshot.workflow) throw new Error("Missing workflow");
    snapshot.workflow.requests_used = 0;
    snapshot.workflow.upload_bytes_used = 0;
    snapshot.workflow.text_bytes_used = 0;
    vi.mocked(api.getSessionProcessing).mockResolvedValue(snapshot);
    await ready();
    await screen.findByRole("region", { name: "Session processing" });
    expect(screen.queryByLabelText(/^Used /)).toBeNull();
    expect(screen.queryByText(/^Used /)).toBeNull();
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
    const dialog = screen.getByRole("dialog", { name: "New recording" });
    await userEvent.click(within(dialog).getByText("More options"));
    // The saved default is the fullest mode: transcribe after stop, then summarize.
    expect(within(dialog).getByText(/Transcribe after stop/)).toBeTruthy();
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
    const status = await screen.findByRole("region", {
      name: "Session processing",
    });
    await within(status).findByText(/disk full/);
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

  it("shows live lines on the Transcript tab of the meeting being recorded", async () => {
    vi.mocked(api.getRecordingState).mockResolvedValue({
      revision: 1,
      status: "recording",
      meeting_id: "sample",
      source: "desktop",
      error: null,
      recording_offset_ms: 65_400,
    });
    vi.mocked(api.getMeeting).mockResolvedValue({
      ...sample,
      meeting: { ...sample.meeting, status: "recording", source: "desktop" },
    });
    vi.mocked(api.liveTranscript).mockResolvedValue({
      meeting_id: "sample",
      lines: [
        {
          id: "mic:1",
          lane: "mic",
          speaker: "You",
          start_ms: 61_000,
          end_ms: 64_000,
          text: "Live words.",
          final: true,
        },
      ],
      partials: [
        {
          id: "sys:1",
          lane: "system",
          speaker: "Others",
          start_ms: 66_000,
          end_ms: 66_500,
          text: "Still being",
          final: false,
        },
      ],
      state: "running",
      engine: "Streaming English (NeMo)",
      leaves_device: false,
      notice: null,
    });
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));

    expect(await screen.findByText(/Live words\./)).toBeTruthy();
    expect(screen.getByText("Streaming English (NeMo)")).toBeTruthy();
    expect(screen.getByText("Still being")).toBeTruthy();
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

      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
        () => {},
      );

      vi.mocked(api.audioSrc).mockImplementation((path) => `asset://${path}`);
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
      const confirm = screen.getByRole("group", {
        name: "Confirm re-transcription",
      });
      await userEvent.click(
        within(confirm).getByRole("button", { name: "Re-transcribe audio" }),
      );
      expect(
        screen.getByRole("button", { name: "Cancel" }).getAttribute("disabled"),
      ).toBe("");
      act(() => progress({ stage: "transcribing", track: "mic", percent: 40 }));
      expect(await screen.findByText(/You \(microphone\): 40%/)).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
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
  });

  it("can cancel the explicit speech installer while other settings are busy", async () => {
    vi.mocked(api.sttInstall).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.cancelModelDownload).mockResolvedValue();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(settingsIndex("Transcription"));
    const transcription = settingsSection("Transcription");
    await userEvent.click(
      transcription.getByRole("button", { name: "Download" }),
    );
    await userEvent.click(
      await transcription.findByRole("button", { name: "Cancel" }),
    );
    expect(api.cancelModelDownload).toHaveBeenCalledOnce();
  });
});
