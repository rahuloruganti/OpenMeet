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
  type AudioHealth,
  type ExportResult,
  type MeetingDetail,
  type RecordingState,
} from "../shared/api/api";
import {
  sample,
  initialSettings,
  installed,
  ready,
  installDefaultMocks,
} from "../shared/test/app-harness";

vi.mock("../shared/api/api", async (original) =>
  mockApiModule(await original<typeof import("../shared/api/api")>()),
);

beforeEach(installDefaultMocks);

describe("recording, capture and devices", () => {
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
    expect(screen.getByText(/System track is empty/)).toBeTruthy();
    expect(screen.queryByText(/Microphone track is empty/)).toBeNull();
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
    expect(screen.getByText(/That microphone is unavailable/)).toBeTruthy();
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

  it("opens recording setup without capture and with no consent checkbox", async () => {
    await ready();
    const trigger = screen.getByRole("button", { name: "New recording" });
    const bar = screen.getByRole("region", { name: "Recording controls" });
    // Nothing is being recorded, and the bar says so rather than claiming a recording.
    expect(within(bar).getByRole("status").textContent).toBe("Ready");
    expect(within(bar).queryByText("Recording")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Meeting title" })).toBeNull();
    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "New recording" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // Focus starts inside the dialog, on its first control.
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close" }),
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
    await screen.findByText("Recording");
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
    const bar = screen.getByRole("region", { name: "Recording controls" });
    expect(within(bar).getByRole("status").textContent).toBe("Ready");
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
    const bar = screen.getByRole("region", { name: "Recording controls" });
    expect(await within(bar).findByText("Paused")).toBeTruthy();
    await screen.findByText("Capture: Device stopped responding");
    await act(async () =>
      finishExport({
        path: "sample.md",
        created_copy: false,
        transcript_paths: [],
      }),
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
    expect(screen.getByText("Simulation · Paused")).toBeTruthy();
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
            gaps: 1,
            peak: 0.1,
            callback_age_ms: 5,
          },
        ],
      }),
    );
    expect(
      (await screen.findByText(/Audio gaps detected/)).textContent,
    ).toContain("Microphone: 3, System audio: 1");
    expect(screen.getByText("Recording")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.queryByText(/stopped responding/)).toBeNull();
  });

  it("dismisses the audio gap notice until its counts change", async () => {
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
    const gaps = (count: number): AudioHealth => ({
      error: null,
      tracks: [
        {
          kind: "mic",
          frames: 100,
          dropped_frames: 0,
          gaps: count,
          peak: 0.2,
          callback_age_ms: 5,
        },
      ],
    });
    act(() => publish(gaps(3)));
    await userEvent.click(
      await screen.findByRole("button", { name: "Dismiss audio gap notice" }),
    );
    expect(screen.queryByText(/Audio gaps detected/)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("main"));
    act(() => publish(gaps(3)));
    expect(screen.queryByText(/Audio gaps detected/)).toBeNull();
    act(() => publish(gaps(4)));
    expect(
      (await screen.findByText(/Audio gaps detected/)).textContent,
    ).toContain("Microphone: 4");
  });

  it("dismisses a capture error for its recording only", async () => {
    await ready();
    const publishState = vi.mocked(api.onRecordingState).mock.calls[0][0];
    const stopped = (
      revision: number,
      meetingId: string,
      error: string,
    ): RecordingState => ({
      revision,
      status: "stopped",
      meeting_id: meetingId,
      source: "desktop",
      error,
      recording_offset_ms: null,
    });
    act(() => publishState(stopped(1, "sample", "Device lost")));
    await userEvent.click(
      await screen.findByRole("button", { name: "Dismiss capture error" }),
    );
    expect(screen.queryByText("Capture: Device lost")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("main"));
    // A changed message is shown again.
    act(() => publishState(stopped(2, "sample", "Device lost twice")));
    expect(screen.getByText("Capture: Device lost twice")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Dismiss capture error" }),
    );
    // The same text from a different recording is shown again.
    act(() => publishState(stopped(3, "other", "Device lost twice")));
    expect(screen.getByText("Capture: Device lost twice")).toBeTruthy();
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

  describe("notes-first polish", () => {
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
      expect(screen.getByLabelText("Mic: quiet")).toBeTruthy();
      expect(screen.getByLabelText("System: signal")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
      clock.mockReturnValue(12_500);
      act(() => publish(health(0)));
      expect(screen.getByLabelText("Mic: no signal for 11 s")).toBeTruthy();
      expect(screen.getByRole("alert").textContent).toContain(
        "No microphone signal",
      );
      act(() => publish(health(0.2)));
      expect(screen.getByLabelText("Mic: signal")).toBeTruthy();
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
      await screen.findByText(/originals are unchanged/);
      expect(
        screen.queryByRole("button", { name: "Recover audio" }),
      ).toBeNull();
      expect(screen.getByDisplayValue("Original notes")).toBeTruthy();
    });
  });

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
    await screen.findByText(/Refreshed:/);
    expect(
      (
        screen.getByRole("combobox", {
          name: "Microphone",
        }) as HTMLSelectElement
      ).value,
    ).toBe("missing-mic");
    expect(screen.getByText(/That microphone is unavailable/)).toBeTruthy();
  });
});
