import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { Settings } from "../../shared/api/api";
import { SettingsPanel } from "./SettingsPanel";

vi.mock("../../shared/api/api", async (original) => ({
  ...(await original<typeof import("../../shared/api/api")>()),
  api: {
    apiConnectionKeyStatus: vi.fn(),
    providerKeyStatus: vi.fn(),
    getSettings: vi.fn(),
    dataFolder: vi.fn(async () => ({
      path: "C:/Users/Rahul/AppData/Roaming/OpenMeetPy",
    })),
  },
}));

const settings: Settings = {
  saved_connections: [],
  provider_assignments: { llm: null, cloud_stt: null },
  llm: null,
  cloud_stt: null,
  stt_mode: "local",
  stt_language: "auto",
  stt_prompt: "",
  stt_model: "small",
  vault_folder: "C:/Users/Rahul/Documents/OpenMeet",
  pause_shortcut: "CommandOrControl+Shift+Space",
  stop_shortcut: null,
  microphone_id: "mic-1",
  output_id: "out-1",
  export: {
    transcript: true,
    summary: true,
    filename: "title",
    transcript_formats: ["txt"],
  },
  summary_instructions: "",
  summary_templates: [],
  recipes: [],
  processing_mode: "recording",
  processing_summary: null,
  summary_default: "general-v1",
  detection_enabled: false,
  detection_ignored: [],
  setup_done: true,
  theme: "system",
  inspector_open: true,
};

const props = () => ({
  settings,
  disabled: false,
  devices: {
    capture_supported: true,
    microphones: [{ id: "mic-1", name: "Yeti Nano" }],
    outputs: [{ id: "out-1", name: "Speakers" }],
  },
  microphone: "mic-1",
  output: "out-1",
  onDefaultDevices: vi.fn(),
  onRefreshDevices: vi.fn(),
  onSaveShortcuts: vi.fn(),
  processing: { mode: "recording" as const, summary: null },
  onProcessing: vi.fn(),
  detectionSupported: true,
  onDetection: vi.fn(),
  onDetectionIgnored: vi.fn(),
  stt: {
    engine: true,
    model: true,
    vad: true,
    installed: true,
    missing_bytes: 0,
    supported: true,
    models: [{ id: "small", size: 466 * 1024 * 1024, installed: true }],
    languages: ["auto", "en"],
  },
  sttProgress: null,
  installing: false,
  onInstallStt: vi.fn(),
  onCancelStt: vi.fn(),
  onSttMode: vi.fn(),
  onSaveStt: vi.fn(),
  onImported: vi.fn(async () => {}),
  onKeyStatus: vi.fn(),
  onSettings: vi.fn(),
  onSummaryDefault: vi.fn(),
  onChooseFolder: vi.fn(),
  onExportOptions: vi.fn(),
  audioBytes: 1024,
  onRunSetup: vi.fn(),
  onClose: vi.fn(),
  onTheme: vi.fn(),
});

beforeEach(() => vi.resetAllMocks());

it("shows one section at a time and moves between them from the keyboard", async () => {
  render(<SettingsPanel {...props()} />);
  const tabs = screen.getAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    "General",
    "Recording",
    "Transcription",
    "AI notes",
    "Export & storage",
    "Privacy & about",
  ]);
  const general = screen.getByRole("tab", { name: "General" });
  expect(general.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tabpanel", { name: "General" })).toBeTruthy();
  // A hidden section is out of the accessibility tree, so only one is visible.
  expect(screen.queryByRole("tabpanel", { name: "Recording" })).toBeNull();
  fireEvent.keyDown(general, { key: "ArrowDown" });
  const recording = screen.getByRole("tab", { name: "Recording" });
  expect(document.activeElement).toBe(recording);
  expect(recording.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(recording, { key: "End" });
  expect(document.activeElement).toBe(
    screen.getByRole("tab", { name: "Privacy & about" }),
  );
  fireEvent.keyDown(screen.getByRole("tab", { name: "Privacy & about" }), {
    key: "Home",
  });
  expect(document.activeElement).toBe(
    screen.getByRole("tab", { name: "General" }),
  );
});

it("keeps the old ids working as aliases", () => {
  const input = props();
  const view = render(
    <SettingsPanel {...input} initialSection="connections" />,
  );
  expect(screen.getByRole("tabpanel", { name: "AI notes" })).toBeTruthy();
  expect(
    screen.getByRole("tab", { name: "AI notes" }).getAttribute("aria-selected"),
  ).toBe("true");
  view.unmount();
  render(<SettingsPanel {...input} initialSection="models" />);
  expect(screen.getByRole("tabpanel", { name: "Transcription" })).toBeTruthy();
});

it("saves the theme at once and confirms with a tick", async () => {
  const input = props();
  render(<SettingsPanel {...input} />);
  const group = screen.getByRole("group", { name: "Theme" });
  await userEvent.click(within(group).getByRole("button", { name: "Dark" }));
  expect(input.onTheme).toHaveBeenCalledWith("dark");
  expect(screen.getByText("✓ Saved")).toBeTruthy();
});

it("closes from the header back button", async () => {
  const input = props();
  render(<SettingsPanel {...input} />);
  await userEvent.click(
    screen.getByRole("button", { name: "Back to Meetings" }),
  );
  expect(input.onClose).toHaveBeenCalledOnce();
});

it("saves export changes as they are made", async () => {
  const input = props();
  render(<SettingsPanel {...input} initialSection="export" />);
  const transcript = screen.getByRole("switch", { name: "Include transcript" });
  expect(transcript.getAttribute("aria-checked")).toBe("true");
  await userEvent.click(transcript);
  expect(input.onExportOptions).toHaveBeenCalledWith({
    ...settings.export,
    transcript: false,
  });
  await userEvent.click(screen.getByRole("button", { name: "SRT" }));
  expect(input.onExportOptions).toHaveBeenLastCalledWith({
    ...settings.export,
    transcript_formats: ["txt", "srt"],
  });
  await userEvent.selectOptions(
    screen.getByLabelText("File name"),
    "date_title",
  );
  expect(input.onExportOptions).toHaveBeenLastCalledWith({
    ...settings.export,
    filename: "date_title",
  });
});

it("records a shortcut from a key press and saves it", async () => {
  const input = props();
  render(<SettingsPanel {...input} initialSection="recording" />);
  const capture = screen.getByRole("button", {
    name: "Change stop recording shortcut",
  });
  await userEvent.click(capture);
  fireEvent.keyDown(capture, {
    key: "S",
    code: "KeyS",
    ctrlKey: true,
    shiftKey: true,
  });
  expect(input.onSaveShortcuts).toHaveBeenCalledWith(
    "CommandOrControl+Shift+Space",
    "CommandOrControl+Shift+S",
  );
  expect(screen.getByLabelText("Pause / resume shortcut").textContent).toBe(
    "CtrlShiftSpace",
  );
});

it("refuses a key press without a modifier and says why", async () => {
  const input = props();
  render(<SettingsPanel {...input} initialSection="recording" />);
  const capture = screen.getByRole("button", {
    name: "Change pause / resume shortcut",
  });
  await userEvent.click(capture);
  fireEvent.keyDown(capture, { key: "s", code: "KeyS" });
  expect(screen.getByText("Add Ctrl or Alt, or use an F-key.")).toBeTruthy();
  expect(input.onSaveShortcuts).not.toHaveBeenCalled();
});

it("explains the automation switches and hides their details until they are on", async () => {
  const input = props();
  render(<SettingsPanel {...input} initialSection="recording" />);
  expect(screen.queryByLabelText("When a recording stops")).toBeNull();
  await userEvent.click(
    screen.getByRole("switch", { name: "Automatic processing" }),
  );
  expect(input.onProcessing).toHaveBeenCalledWith({
    mode: "final",
    summary: "general-v1",
  });
  const detecting = screen.getByRole("switch", { name: "Meeting detection" });
  expect(detecting.getAttribute("aria-checked")).toBe("false");
  await userEvent.click(detecting);
  expect(input.onDetection).toHaveBeenCalledWith(true);
});

it("tags cloud transcription as leaving this device", () => {
  render(<SettingsPanel {...props()} initialSection="transcription" />);
  const pane = within(screen.getByRole("tabpanel", { name: "Transcription" }));
  const engine = pane.getByRole("group", { name: "Runs" });
  expect(within(engine).getByText("Leaves this device")).toBeTruthy();
  expect(within(engine).getByText("Audio stays here")).toBeTruthy();
  // The cloud connection card is not shown while the engine runs here.
  expect(pane.queryByLabelText("Base URL")).toBeNull();
});

it("follows a section the page controls and reports every pick", async () => {
  const input = props();
  const onSection = vi.fn();
  const view = render(
    <SettingsPanel {...input} section="export" onSection={onSection} />,
  );
  expect(
    screen.getByRole("tabpanel", { name: "Export & storage" }),
  ).toBeTruthy();

  await userEvent.click(screen.getByRole("tab", { name: "Recording" }));
  expect(onSection).toHaveBeenCalledWith("recording");
  // The page owns the section, so the panel stays where it was told to be.
  expect(
    screen.getByRole("tabpanel", { name: "Export & storage" }),
  ).toBeTruthy();

  view.rerender(
    <SettingsPanel {...input} section="recording" onSection={onSection} />,
  );
  expect(screen.getByRole("tabpanel", { name: "Recording" })).toBeTruthy();
});

it("shows the real data folder and copies it", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<SettingsPanel {...props()} initialSection="export" />);
  expect(
    await screen.findByText("C:/Users/Rahul/AppData/Roaming/OpenMeetPy"),
  ).toBeTruthy();
  // There is no reveal command yet, so the path is copied instead.
  await userEvent.click(
    screen.getByRole("button", { name: "Copy data folder path" }),
  );
  expect(writeText).toHaveBeenCalledWith(
    "C:/Users/Rahul/AppData/Roaming/OpenMeetPy",
  );
  expect(
    screen.getByRole("button", { name: "Copy data folder path" }).textContent,
  ).toBe("Copied");
});

it("puts a long explanation behind a focusable tip button", async () => {
  render(<SettingsPanel {...props()} initialSection="general" />);
  const tip = screen.getByRole("button", { name: "More about Appearance" });
  expect(tip.getAttribute("aria-expanded")).toBe("false");
  await userEvent.click(tip);
  expect(screen.getByRole("tooltip").textContent).toBe(
    "System follows the Windows light or dark setting. OpenMeet switches with it.",
  );
});
