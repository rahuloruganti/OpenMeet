import { mockApiModule } from "./test/api-mock";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./lib/api";
import {
  initialSettings,
  chooseProcessing,
  ready,
  installDefaultMocks,
} from "./test/app-harness";

vi.mock("./lib/api", async (original) =>
  mockApiModule(await original<typeof import("./lib/api")>()),
);

beforeEach(installDefaultMocks);

describe("settings and meeting detection", () => {
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
    expect(screen.getByText(/Version 0.9.0/)).toBeTruthy();
    fireEvent.keyDown(about, { key: "Home" });
    const recording = screen.getByRole("tab", { name: "Recording" });
    expect(document.activeElement).toBe(recording);
    expect(transcription.getAttribute("tabindex")).toBe("-1");
    fireEvent.keyDown(recording, { key: "End", ctrlKey: true });
    expect(recording.getAttribute("aria-selected")).toBe("true");
  });

  describe("transcript and audio", () => {
    beforeEach(() => {
      vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);

      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
        () => {},
      );

      vi.mocked(api.audioSrc).mockImplementation((path) => `asset://${path}`);
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
      expect(
        screen.queryByRole("button", { name: "Save shortcuts" }),
      ).toBeNull();
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

  it("scans for local models only once Models is selected, and shows a failed scan", async () => {
    vi.mocked(api.scanLocalModels).mockRejectedValue(
      new Error("Model folder unreadable"),
    );
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(api.scanLocalModels).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("tab", { name: "Models" }));
    expect(
      screen.getByRole("heading", { name: "Local model library" }),
    ).toBeTruthy();
    expect(await screen.findByText("Model folder unreadable")).toBeTruthy();
    expect(api.scanLocalModels).toHaveBeenCalledWith(null);
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
      const card = await screen.findByRole("group", {
        name: "Meeting detected",
      });
      expect(card.textContent).toContain("Zoom is using your microphone");
      expect(api.requestAttention).toHaveBeenCalled();
      await userEvent.click(
        within(card).getByRole("button", { name: "Set up recording" }),
      );
      expect(
        screen.getByRole("dialog", { name: "New recording" }),
      ).toBeTruthy();
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
      expect(api.setDetectionIgnored).toHaveBeenCalledWith(
        zoom.id,
        "Zoom",
        true,
      );
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
});
