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
import { api } from "../shared/api/api";
import {
  initialSettings,
  notInstalled,
  ready,
  installDefaultMocks,
  settingsIndex,
} from "../shared/test/app-harness";

vi.mock("../shared/api/api", async (original) =>
  mockApiModule(await original<typeof import("../shared/api/api")>()),
);

beforeEach(installDefaultMocks);

/** Shortcut saves that answer with the values they were given. */
function mockShortcutSaves() {
  vi.mocked(api.saveSettings).mockImplementation(async (pause, stop) => ({
    ...initialSettings,
    pause_shortcut: pause,
    stop_shortcut: stop,
  }));
}

describe("settings and meeting detection", () => {
  it("shows every section on one page and marks the index entry in view", async () => {
    await ready();
    // The meeting page's Settings button opens the page at the top, on General.
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const general = settingsIndex("General");
    expect(general.getAttribute("aria-current")).toBe("location");
    // All six sections are on the page at once; nothing is hidden behind a tab.
    const names = [
      "General",
      "Recording",
      "Transcription",
      "AI notes",
      "Export & storage",
      "Privacy & about",
    ];
    for (const name of names)
      expect(screen.getByRole("region", { name })).toBeTruthy();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    // Picking an entry moves the mark; the section it names is already on the page.
    await userEvent.click(settingsIndex("AI notes"));
    expect(settingsIndex("AI notes").getAttribute("aria-current")).toBe(
      "location",
    );
    expect(general.getAttribute("aria-current")).toBeNull();
    const aboutPane = within(
      screen.getByRole("region", { name: "Privacy & about" }),
    );
    expect(aboutPane.getByText("Version")).toBeTruthy();
    expect(aboutPane.getByText("0.9.0")).toBeTruthy();
    // Privacy prose is replaced by the short table of what leaves the device.
    expect(aboutPane.getByText("What leaves this device")).toBeTruthy();
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
      vi.mocked(api.saveSttSettings).mockImplementation(
        async (language, prompt, model) => ({
          ...initialSettings,
          stt_language: language,
          stt_prompt: prompt,
          stt_model: model,
        }),
      );
      vi.mocked(api.sttStatus).mockResolvedValue({
        ...notInstalled,
        models: [
          { id: "base", size: 147_951_465, installed: true },
          { id: "small", size: 487_601_967, installed: true },
        ],
      });
      mockShortcutSaves();
      await ready();
      await userEvent.click(screen.getByRole("button", { name: "Settings" }));
      // Each field saves as it changes; none of them is drafted behind a Save.
      await userEvent.selectOptions(
        screen.getByLabelText("Spoken language"),
        "de",
      );
      expect(api.saveSttSettings).toHaveBeenLastCalledWith("de", "", "small");
      const pane = within(
        screen.getByRole("region", { name: "Transcription" }),
      );
      await userEvent.click(
        pane.getByText("More options", { selector: "summary" }),
      );
      await userEvent.type(
        screen.getByRole("textbox", { name: "Vocabulary hint" }),
        "Okta",
      );
      await userEvent.tab();
      expect(api.saveSttSettings).toHaveBeenLastCalledWith(
        "de",
        "Okta",
        "small",
      );
      await userEvent.selectOptions(
        screen.getByRole("combobox", { name: "Speech model" }),
        "base",
      );
      expect(api.saveSttSettings).toHaveBeenLastCalledWith(
        "de",
        "Okta",
        "base",
      );
      await userEvent.click(settingsIndex("Recording"));
      expect(
        screen.queryByRole("button", { name: "Save shortcuts" }),
      ).toBeNull();
      const capture = screen.getByRole("button", {
        name: "Change stop recording shortcut",
      });
      await userEvent.click(capture);
      fireEvent.keyDown(capture, {
        key: "S",
        code: "KeyS",
        altKey: true,
        shiftKey: true,
      });
      expect(api.saveSettings).toHaveBeenCalledWith(
        "CommandOrControl+Shift+Space",
        "Alt+Shift+S",
      );
      await waitFor(() =>
        expect(
          screen.getByLabelText("Stop recording shortcut").textContent,
        ).toBe("AltShiftS"),
      );
      // An empty stop shortcut is cleared, and nothing can start a recording.
      await userEvent.click(
        screen.getByRole("button", { name: "Clear stop recording shortcut" }),
      );
      expect(api.saveSettings).toHaveBeenLastCalledWith(
        "CommandOrControl+Shift+Space",
        null,
      );
      // No info icon: the group explains itself in its rows.
      expect(screen.queryByRole("button", { name: /^More about/ })).toBeNull();
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
    // Turning automatic processing off saves the recording-only default.
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(settingsIndex("Recording"));
    await userEvent.click(
      screen.getByRole("switch", { name: "Automatic processing" }),
    );
    expect(api.saveProcessingDefault).toHaveBeenLastCalledWith(
      "recording",
      null,
    );
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
    await userEvent.click(settingsIndex("Recording"));
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
      screen.getByLabelText("Default system audio") as HTMLSelectElement
    ).value;
    expect(api.saveDefaultDevices).toHaveBeenCalledWith(real.value, output);
  });

  it("records a shortcut from a key press", async () => {
    mockShortcutSaves();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const engines = within(
      screen.getByRole("region", { name: "Transcription" }),
    );
    expect(engines.getByRole("group", { name: "Process audio" })).toBeTruthy();
    expect(screen.queryByText("Other engines (not supported yet)")).toBeNull();
    await userEvent.click(settingsIndex("Recording"));
    const capture = screen.getByRole("button", {
      name: "Change stop recording shortcut",
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
    expect(api.saveSettings).toHaveBeenCalledWith(
      "CommandOrControl+Shift+Space",
      "CommandOrControl+Shift+S",
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Stop recording shortcut").textContent).toBe(
        "CtrlShiftS",
      ),
    );
    // Only the two supported engines are offered; no list that does nothing.
    expect(screen.queryByText("Other engines (not supported yet)")).toBeNull();
    // Tab still moves focus, and a key without a modifier is not taken.
    await userEvent.click(capture);
    expect(fireEvent.keyDown(capture, { key: "Tab", code: "Tab" })).toBe(true);
    fireEvent.keyDown(capture, { key: "s", code: "KeyS" });
    expect(screen.getByLabelText("Stop recording shortcut").textContent).toBe(
      "CtrlShiftS",
    );
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("explains a key press refused for lacking a modifier until a chord is accepted", async () => {
    mockShortcutSaves();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(settingsIndex("Recording"));
    const capture = screen.getByRole("button", {
      name: "Change stop recording shortcut",
    });
    const hint = "Add Ctrl or Alt, or use an F-key.";
    const shown = () =>
      screen.getByLabelText("Stop recording shortcut").textContent;
    await userEvent.click(capture);
    // A lone modifier is part of a chord still being pressed, not a refusal.
    fireEvent.keyDown(capture, {
      key: "Shift",
      code: "ShiftLeft",
      shiftKey: true,
    });
    expect(screen.queryByText(hint)).toBeNull();
    fireEvent.keyDown(capture, { key: "s", code: "KeyS" });
    expect(screen.getByText(hint)).toBeTruthy();
    expect(shown()).toBe("None");
    fireEvent.keyDown(capture, { key: "F9", code: "F9" });
    expect(screen.queryByText(hint)).toBeNull();
    await waitFor(() => expect(shown()).toBe("F9"));
    // An accepted chord ends capture, so the next refused press needs a new click.
    await userEvent.click(capture);
    fireEvent.keyDown(capture, { key: "s", code: "KeyS" });
    expect(screen.getByText(hint)).toBeTruthy();
    act(() => capture.blur());
    expect(screen.queryByText(hint)).toBeNull();
  });

  it("refuses a stop shortcut that matches pause, ignoring case and spacing", async () => {
    mockShortcutSaves();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(settingsIndex("Recording"));
    const capture = screen.getByRole("button", {
      name: "Change stop recording shortcut",
    });
    await userEvent.click(capture);
    // Ctrl+Shift+Space yields the pause chord, so the same chord is refused.
    fireEvent.keyDown(capture, {
      key: " ",
      code: "Space",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(
      screen.getByText("Pause and stop can't use the same shortcut."),
    ).toBeTruthy();
    expect(api.saveSettings).not.toHaveBeenCalled();
    await userEvent.click(capture);
    fireEvent.keyDown(capture, {
      key: "S",
      code: "KeyS",
      altKey: true,
      shiftKey: true,
    });
    // The clash warning belongs to Recording; other sections' notices stay out of the way.
    const recording = within(screen.getByRole("region", { name: "Recording" }));
    expect(recording.queryByRole("alert")).toBeNull();
    expect(api.saveSettings).toHaveBeenCalledWith(
      "CommandOrControl+Shift+Space",
      "Alt+Shift+S",
    );
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

  it("scans local model folders for the model menu, and shows a failed scan in the library", async () => {
    vi.mocked(api.scanLocalModels).mockRejectedValue(
      new Error("Model folder unreadable"),
    );
    await ready();
    expect(api.scanLocalModels).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(settingsIndex("Transcription"));
    // The model menu's own scan fails quietly; the library reports it.
    await waitFor(() => expect(api.scanLocalModels).toHaveBeenCalledWith(null));
    expect(screen.queryByText("Model folder unreadable")).toBeNull();
    const pane = within(screen.getByRole("region", { name: "Transcription" }));
    // Your own models sit under More options, behind "Add your own model".
    await userEvent.click(pane.getAllByText("More options")[0]);
    await userEvent.click(
      pane.getByRole("button", { name: "Add your own model" }),
    );
    expect(screen.getByRole("button", { name: "Scan folders" })).toBeTruthy();
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
      const card = await screen.findByRole("status", {
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
        screen.queryByRole("status", { name: "Meeting detected" }),
      ).toBeNull();
      // Still the same session: no second prompt. A new session prompts again.
      deliver([zoom]);
      expect(
        screen.queryByRole("status", { name: "Meeting detected" }),
      ).toBeNull();
      deliver([]);
      deliver([zoom]);
      expect(
        await screen.findByRole("status", { name: "Meeting detected" }),
      ).toBeTruthy();
    });

    it("dismisses the prompt on Not now and returns focus to the workspace", async () => {
      vi.mocked(api.getSettings).mockResolvedValue(detecting);
      await ready();
      deliver([zoom]);
      await userEvent.click(
        within(
          await screen.findByRole("status", { name: "Meeting detected" }),
        ).getByRole("button", { name: "Not now" }),
      );
      expect(
        screen.queryByRole("status", { name: "Meeting detected" }),
      ).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("main"));
      expect(api.startCapture).not.toHaveBeenCalled();
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
      expect(document.activeElement).toBe(screen.getByRole("main"));
      expect(api.setDetectionIgnored).toHaveBeenCalledWith(
        zoom.id,
        "Zoom",
        true,
      );
      deliver([]);
      deliver([zoom]);
      expect(
        screen.queryByRole("status", { name: "Meeting detected" }),
      ).toBeNull();
    });

    it("saves automatic capture only while detection is on", async () => {
      vi.mocked(api.getSettings).mockResolvedValue(detecting);
      vi.mocked(api.saveAutoCapture).mockResolvedValue({
        ...detecting,
        auto_capture: true,
      });
      await ready();
      await userEvent.click(screen.getByRole("button", { name: "Settings" }));
      await userEvent.click(settingsIndex("Recording"));
      await userEvent.click(
        screen.getByRole("switch", { name: "Automatic capture" }),
      );
      expect(api.saveAutoCapture).toHaveBeenCalledWith(true);
      await waitFor(() =>
        expect(
          screen
            .getByRole("switch", { name: "Automatic capture" })
            .getAttribute("aria-checked"),
        ).toBe("true"),
      );
    });

    it("does not prompt while detection is off or OpenMeet is recording", async () => {
      await ready();
      deliver([zoom]);
      expect(
        screen.queryByRole("status", { name: "Meeting detected" }),
      ).toBeNull();
      vi.mocked(api.saveDetection).mockResolvedValue(detecting);
      await userEvent.click(screen.getByRole("button", { name: "Settings" }));
      await userEvent.click(settingsIndex("Recording"));
      const detection = screen.getByRole("switch", {
        name: "Meeting detection",
      });
      expect(detection.getAttribute("aria-checked")).toBe("false");
      await userEvent.click(detection);
      expect(api.saveDetection).toHaveBeenCalledWith(true);
      // Settings is its own full page, so the prompt shows on the meeting page.
      await userEvent.click(
        screen.getByRole("button", { name: "Back to Meetings" }),
      );
      await screen.findByRole("status", { name: "Meeting detected" });
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
        screen.queryByRole("status", { name: "Meeting detected" }),
      ).toBeNull();
    });
  });

  describe("closing settings", () => {
    const openRecording = async () => {
      await userEvent.click(screen.getByRole("button", { name: "Settings" }));
      await userEvent.click(settingsIndex("Recording"));
    };
    const stopShortcut = () => screen.getByLabelText("Stop recording shortcut");
    const settingsPage = () =>
      screen.queryByRole("heading", { name: "Settings", level: 1 });

    it("keeps Settings open when Escape is pressed inside a field", async () => {
      await ready();
      await openRecording();
      await userEvent.click(screen.getByLabelText("Default microphone"));
      await userEvent.keyboard("{Escape}");
      expect(settingsPage()).toBeTruthy();
    });

    it("saves a shortcut at once, so closing never asks to discard it", async () => {
      mockShortcutSaves();
      const confirm = vi.spyOn(window, "confirm");
      await ready();
      await openRecording();
      const capture = screen.getByRole("button", {
        name: "Change stop recording shortcut",
      });
      await userEvent.click(capture);
      fireEvent.keyDown(capture, {
        key: "S",
        code: "KeyS",
        altKey: true,
        shiftKey: true,
      });
      expect(api.saveSettings).toHaveBeenCalledWith(
        "CommandOrControl+Shift+Space",
        "Alt+Shift+S",
      );
      await userEvent.keyboard("{Escape}");
      // Nothing was drafted, so nothing is lost and nothing is asked.
      expect(settingsPage()).toBeNull();
      expect(confirm).not.toHaveBeenCalled();
      await openRecording();
      expect(stopShortcut().textContent).toBe("AltShiftS");
      confirm.mockRestore();
    });

    it("closes from the header back button on a clean page without asking", async () => {
      await ready();
      const confirm = vi.spyOn(window, "confirm");
      await openRecording();
      await userEvent.click(
        screen.getByRole("button", { name: "Back to Meetings" }),
      );
      expect(settingsPage()).toBeNull();
      expect(confirm).not.toHaveBeenCalled();
      confirm.mockRestore();
    });

    it("closes from the page body on a clean Escape without asking", async () => {
      await ready();
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      await openRecording();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(settingsPage()).toBeNull();
      expect(confirm).not.toHaveBeenCalled();
      confirm.mockRestore();
    });
  });
});
