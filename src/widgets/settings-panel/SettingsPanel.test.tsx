import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { Settings } from "../../shared/api/api";
import { api } from "../../shared/api/api";
import { SettingsPanel } from "./SettingsPanel";

vi.mock("../../shared/api/api", async (original) => ({
  ...(await original<typeof import("../../shared/api/api")>()),
  api: {
    apiConnectionKeyStatus: vi.fn(),
    providerKeyStatus: vi.fn(),
    getSettings: vi.fn(),
    listApiConnectionModels: vi.fn(),
    scanLocalModels: vi.fn(),
    detectLocalServers: vi.fn(),
    localAiStatus: vi.fn(),
    localAiInstallEngine: vi.fn(),
    localAiSearchHf: vi.fn(),
    localAiHfFiles: vi.fn(),
    localAiDownloadHf: vi.fn(),
    localAiRemoveModel: vi.fn(),
    localAiCancel: vi.fn(),
    localAiUse: vi.fn(),
    localAiStart: vi.fn(),
    localAiStop: vi.fn(),
    onLocalAiProgress: vi.fn(),
    liveModels: vi.fn(),
    saveLiveSettings: vi.fn(),
    liveModelInstall: vi.fn(),
    liveModelCancel: vi.fn(),
    onLiveModelProgress: vi.fn(),
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
  processing_mode: "final",
  processing_summary: "general-v1",
  summary_default: "general-v1",
  detection_enabled: true,
  detection_ignored: [],
  auto_capture: false,
  calendar_reminders: true,
  calendar_reminder_minutes: 2,
  processing_enhance: true,
  setup_done: true,
  theme: "system",
  inspector_open: true,
  live_transcript: true,
  live_model: "",
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
  processing: { mode: "final" as const, summary: "general-v1" as const },
  onProcessing: vi.fn(),
  onDetectionIgnored: vi.fn(),
  onAutoCapture: vi.fn(),
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

beforeEach(() => {
  vi.resetAllMocks();
  // The transcription section looks for model files already on this PC.
  vi.mocked(api.scanLocalModels).mockResolvedValue({
    models: [],
    folders: [],
    truncated: false,
  });
  // Local AI reads this PC's hardware and models when its section is open.
  vi.mocked(api.localAiStatus).mockResolvedValue({
    hardware: {
      gpu_name: "NVIDIA GeForce RTX 3060",
      gpu_vendor: "nvidia",
      vram_bytes: 12 * 1024 ** 3,
      ram_bytes: 32 * 1024 ** 3,
      ram_available_bytes: 20 * 1024 ** 3,
      backend: "cuda",
    },
    engine_installed: true,
    engine_tag: "b11671",
    engine_download_bytes: 0,
    server: "stopped",
    server_error: null,
    active_model: null,
    in_use: false,
    models: [],
    job: null,
  });
  vi.mocked(api.onLocalAiProgress).mockResolvedValue(vi.fn());
  vi.mocked(api.liveModels).mockResolvedValue({
    models: [
      {
        id: "",
        label: "Same as Transcription",
        kind: "same",
        installed: true,
        download_bytes: null,
        leaves_device: false,
        languages: [],
        reason: null,
      },
    ],
    selected: "",
    ready: true,
    reason: null,
    installing: null,
  });
  vi.mocked(api.onLiveModelProgress).mockResolvedValue(vi.fn());
  vi.mocked(api.detectLocalServers).mockResolvedValue([]);
});

// Settings is one scrolling page: the sections sit in a nav as plain buttons, and each one is a
// labelled region on the page. Queries are scoped because every section is in the DOM at once.
const index = () =>
  within(screen.getByRole("navigation", { name: "Settings sections" }));
// The entry's label; a needs-you entry also says so in its name, after the label.
const indexButton = (name: string) => {
  const entry = index()
    .getAllByRole("button")
    .find(
      (button) => button.querySelector(":scope > span")?.textContent === name,
    );
  if (!entry) throw new Error(`No index entry named ${name}`);
  return entry;
};
const hiddenBy = (element: Element) => element.closest("[hidden]") !== null;
const region = (name: string) => screen.getByRole("region", { name });
const group = (section: string, name: string) =>
  within(region(section)).getByRole("region", { name, hidden: true });
const searchField = () =>
  screen.getByRole("searchbox", {
    name: "Search settings",
  }) as HTMLInputElement;
const missed = (element: HTMLElement) => element.hasAttribute("data-miss");

it("renders every section on one page, with the index naming each", () => {
  render(<SettingsPanel {...props()} />);
  const names = [
    "General",
    "Recording",
    "Transcription",
    "AI notes",
    "Export & storage",
    "Privacy & about",
  ];
  expect(
    index()
      .getAllByRole("button")
      .map((entry) => entry.querySelector(":scope > span")?.textContent),
  ).toEqual(names);
  // All six sections, not one at a time: each is a region and none is a tab panel.
  for (const name of names) expect(region(name)).toBeTruthy();
  expect(screen.queryAllByRole("tab")).toHaveLength(0);
  expect(screen.queryAllByRole("tabpanel")).toHaveLength(0);
  // Exactly one entry is the section in view.
  expect(indexButton("General").getAttribute("aria-current")).toBe("location");
  expect(
    index()
      .getAllByRole("button")
      .filter((entry) => entry.hasAttribute("aria-current")),
  ).toHaveLength(1);
});

it("marks the clicked index entry current and reports the pick", async () => {
  const input = props();
  const onSection = vi.fn();
  render(<SettingsPanel {...input} onSection={onSection} />);
  expect(indexButton("General").getAttribute("aria-current")).toBe("location");
  await userEvent.click(indexButton("Transcription"));
  expect(onSection).toHaveBeenCalledWith("transcription");
  expect(indexButton("Transcription").getAttribute("aria-current")).toBe(
    "location",
  );
  expect(indexButton("General").getAttribute("aria-current")).toBeNull();
  // Nothing is hidden by the pick: the section it names is on the page already.
  expect(region("Transcription")).toBeTruthy();
});

it("keeps the old ids working as aliases", () => {
  const input = props();
  const view = render(
    <SettingsPanel {...input} initialSection="connections" />,
  );
  expect(indexButton("AI notes").getAttribute("aria-current")).toBe("location");
  expect(region("AI notes")).toBeTruthy();
  view.unmount();
  render(<SettingsPanel {...input} initialSection="models" />);
  expect(indexButton("Transcription").getAttribute("aria-current")).toBe(
    "location",
  );
  expect(region("Transcription")).toBeTruthy();
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
  // Transcript formats are not a Settings choice: exports keep the formats already saved.
  expect(screen.queryByRole("group", { name: "Transcript files" })).toBeNull();
  expect(screen.queryByRole("button", { name: "SRT" })).toBeNull();
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

it("records a Windows-key shortcut as Win instead of Ctrl", async () => {
  const input = props();
  render(<SettingsPanel {...input} initialSection="recording" />);
  const capture = screen.getByRole("button", {
    name: "Change stop recording shortcut",
  });
  await userEvent.click(capture);
  fireEvent.keyDown(capture, {
    key: "F9",
    code: "F9",
    metaKey: true,
    shiftKey: true,
  });
  expect(input.onSaveShortcuts).toHaveBeenCalledWith(
    "CommandOrControl+Shift+Space",
    "Win+Shift+F9",
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

it("refuses a key the backend cannot register and says which keys work", async () => {
  const input = props();
  render(<SettingsPanel {...input} initialSection="recording" />);
  const capture = screen.getByRole("button", {
    name: "Change pause / resume shortcut",
  });
  await userEvent.click(capture);
  // Period has no name the backend registers, so it is refused here, not after a save.
  fireEvent.keyDown(capture, { key: ".", code: "Period", ctrlKey: true });
  expect(
    screen.getByText(
      "Use a letter, number, arrow or Space with Ctrl or Alt, or an F-key.",
    ),
  ).toBeTruthy();
  expect(input.onSaveShortcuts).not.toHaveBeenCalled();
});

it("shows a shortcut the backend refused inside the Shortcuts group", () => {
  render(
    <SettingsPanel
      {...props()}
      initialSection="recording"
      shortcutError="Use a shortcut such as Control+Shift+F9."
    />,
  );
  const shortcuts = within(screen.getByRole("region", { name: "Shortcuts" }));
  expect(shortcuts.getByRole("alert").textContent).toBe(
    "Use a shortcut such as Control+Shift+F9.",
  );
});

it("has no processing or meeting detection switch: both are always on", () => {
  render(<SettingsPanel {...props()} initialSection="recording" />);
  expect(
    screen.queryByRole("switch", { name: "Automatic processing" }),
  ).toBeNull();
  expect(
    screen.queryByRole("switch", { name: "Meeting detection" }),
  ).toBeNull();
  expect(screen.queryByLabelText("When a recording stops")).toBeNull();
});

it("saves the automatic summary as final processing, with no 'no summary' choice", async () => {
  const input = props();
  render(<SettingsPanel {...input} initialSection="recording" />);
  const summary = screen.getByRole("combobox", { name: "Automatic summary" });
  expect(
    within(summary).queryByRole("option", { name: "No automatic summary" }),
  ).toBeNull();
  await userEvent.selectOptions(summary, "standup-v1");
  expect(input.onProcessing).toHaveBeenCalledWith({
    mode: "final",
    summary: "standup-v1",
  });
});

it("offers automatic capture at once: opt-in and off until the user turns it on", async () => {
  const input = props();
  render(<SettingsPanel {...input} initialSection="recording" />);
  const auto = screen.getByRole<HTMLButtonElement>("switch", {
    name: "Automatic capture",
  });
  expect(auto.disabled).toBe(false);
  expect(auto.getAttribute("aria-checked")).toBe("false");
  expect(screen.queryByText(/Turn on meeting detection first/)).toBeNull();
  await userEvent.click(auto);
  expect(input.onAutoCapture).toHaveBeenCalledWith(true);
});

it("shows no 'Leaves this device' tag on the transcription engine", () => {
  render(<SettingsPanel {...props()} initialSection="transcription" />);
  const pane = within(region("Transcription"));
  const engine = pane.getByRole("group", { name: "Process audio" });
  expect(within(engine).queryByText("Leaves this device")).toBeNull();
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
  expect(indexButton("Export & storage").getAttribute("aria-current")).toBe(
    "location",
  );
  // Every section is on the page, so the export controls are usable either way.
  expect(region("Export & storage")).toBeTruthy();

  await userEvent.click(indexButton("Recording"));
  expect(onSection).toHaveBeenCalledWith("recording");
  expect(indexButton("Recording").getAttribute("aria-current")).toBe(
    "location",
  );

  // The page owns the section, so the panel stays where it was told to be.
  view.rerender(
    <SettingsPanel {...input} section="recording" onSection={onSection} />,
  );
  expect(indexButton("Recording").getAttribute("aria-current")).toBe(
    "location",
  );
  expect(
    indexButton("Export & storage").getAttribute("aria-current"),
  ).toBeNull();
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

it("shows no info icon anywhere in Settings", () => {
  render(<SettingsPanel {...props()} initialSection="general" />);
  expect(screen.queryAllByRole("button", { name: /^More about/ })).toHaveLength(
    0,
  );
  expect(document.querySelector(".om-info, .om-tip")).toBeNull();
});

it("offers a provider for a new AI connection", () => {
  render(<SettingsPanel {...props()} initialSection="connections" />);
  const pane = within(region("AI notes"));
  const provider = pane.getByLabelText("Provider");
  expect(provider).toHaveProperty("value", "openai");
  expect(within(provider).getAllByRole("option")).toHaveLength(9);
  // The preset brings its own URL, so only the key and the model are left to fill.
  expect(pane.queryByLabelText("Base URL")).toBeNull();
  expect(pane.getByLabelText("Connection name")).toHaveProperty(
    "value",
    "OpenAI",
  );
  expect(pane.getByLabelText("API key").getAttribute("placeholder")).toBe(
    "Key from platform.openai.com",
  );
});

it("puts Local AI where the Tasks group was", async () => {
  render(<SettingsPanel {...props()} initialSection="ai" />);
  const pane = within(region("AI notes"));
  const localAi = await pane.findByRole("region", { name: "Local AI" });
  expect(await within(localAi).findByText("Stays on this device")).toBeTruthy();
  // Tasks live in each meeting's inspector, so the settings group is gone.
  expect(pane.queryByRole("region", { name: "Tasks" })).toBeNull();
  expect(pane.queryByText("Where they live")).toBeNull();
});

it("hides the groups a search does not mention and counts the matches", async () => {
  render(<SettingsPanel {...props()} />);
  await userEvent.type(searchField(), "key");
  // The AI connection's API key field mentions the words; the theme switch does not.
  expect(missed(group("AI notes", "Connection"))).toBe(false);
  expect(missed(group("General", "Appearance"))).toBe(true);
  // A section with no match is marked whole, so its heading goes too.
  expect(missed(region("General"))).toBe(true);
  expect(missed(region("AI notes"))).toBe(false);
  // The index marks the sections with nothing to show and counts the groups in each.
  expect(indexButton("General").classList.contains("om-dim")).toBe(true);
  expect(indexButton("AI notes").classList.contains("om-dim")).toBe(false);
  // The count is the number of groups the search left on the page.
  const announced = screen.getByRole("status").textContent ?? "";
  expect(announced).toMatch(/^\d+ groups?$/);
  const shown = Array.from(
    document.querySelectorAll<HTMLElement>(".om-group"),
  ).filter((el) => !el.parentElement?.closest(".om-group") && !missed(el));
  expect(Number(announced.split(" ")[0])).toBe(shown.length);
  expect(shown.length).toBeGreaterThan(0);
});

it("says when nothing matches and clears the search from the page", async () => {
  const input = props();
  render(<SettingsPanel {...input} />);
  await userEvent.type(searchField(), "zzzz");
  expect(screen.getByText(/No settings match/)).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("0 groups");
  // Everything is marked, so nothing but the notice is left.
  expect(missed(region("General"))).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(searchField().value).toBe("");
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText(/No settings match/)).toBeNull();
  expect(missed(region("General"))).toBe(false);
  // Clearing a search never closes Settings.
  expect(input.onClose).not.toHaveBeenCalled();
});

it("clears the field on Escape and leaves Settings open", async () => {
  const input = props();
  render(<SettingsPanel {...input} />);
  await userEvent.type(searchField(), "export");
  expect(searchField().value).toBe("export");
  expect(missed(region("General"))).toBe(true);
  fireEvent.keyDown(searchField(), { key: "Escape" });
  expect(searchField().value).toBe("");
  expect(screen.queryByRole("status")).toBeNull();
  expect(missed(region("General"))).toBe(false);
  // The Escape belongs to the field: the page stays and nothing closes.
  expect(
    screen.getByRole("heading", { level: 1, name: "Settings" }),
  ).toBeTruthy();
  expect(input.onClose).not.toHaveBeenCalled();
});

it("runs a quick search from a chip and marks it pressed", async () => {
  render(<SettingsPanel {...props()} />);
  const chips = within(screen.getByRole("group", { name: "Quick searches" }));
  const theme = chips.getByRole("button", { name: "Theme" });
  expect(theme.getAttribute("aria-pressed")).toBe("false");
  await userEvent.click(theme);
  expect(searchField().value).toBe("Theme");
  expect(theme.getAttribute("aria-pressed")).toBe("true");
  // The chip narrows the page the same way typing would.
  expect(missed(group("General", "Appearance"))).toBe(false);
  expect(missed(region("Recording"))).toBe(true);
  // Pressing the same chip again clears the search.
  await userEvent.click(theme);
  expect(searchField().value).toBe("");
  expect(theme.getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByRole("status")).toBeNull();
});

it("marks what needs the user in the index, the section and a chip", async () => {
  // The fixture has no AI connection, so only AI notes needs the user.
  const input = props();
  const onSection = vi.fn();
  render(<SettingsPanel {...input} onSection={onSection} />);
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  // The dot's reason is read out with the entry, after its label; the dot itself is hidden.
  expect(nav.querySelectorAll(".om-need")).toHaveLength(1);
  expect(
    within(indexButton("AI notes")).getByText(
      ", needs you: Choose where notes are written",
    ),
  ).toBeTruthy();
  expect(indexButton("AI notes").textContent).toBe(
    "AI notes, needs you: Choose where notes are written",
  );
  expect(
    indexButton("AI notes")
      .querySelector(".om-need")
      ?.getAttribute("aria-hidden"),
  ).toBe("true");
  // The section says the same thing in a line at its top, and only that section does.
  expect(
    within(region("AI notes")).getByText("Choose where notes are written"),
  ).toBeTruthy();
  expect(
    within(region("General")).queryByText("Choose where notes are written"),
  ).toBeNull();
  // The chip counts them and jumps to the first one.
  await userEvent.click(screen.getByRole("button", { name: "Needs you · 1" }));
  expect(onSection).toHaveBeenCalledWith("ai");
  expect(indexButton("AI notes").getAttribute("aria-current")).toBe("location");
});

it("clears the search and jumps when an index entry with no match is picked", async () => {
  const onSection = vi.fn();
  render(<SettingsPanel {...props()} onSection={onSection} />);
  await userEvent.type(searchField(), "key");
  expect(missed(region("General"))).toBe(true);
  expect(
    indexButton("General").querySelector(".om-hit-count")?.textContent,
  ).toBe("0");
  await userEvent.click(indexButton("General"));
  // The hidden section comes back, the search is gone, and the index marks it.
  expect(searchField().value).toBe("");
  expect(missed(region("General"))).toBe(false);
  expect(onSection).toHaveBeenCalledWith("general");
  expect(indexButton("General").getAttribute("aria-current")).toBe("location");
});

it("searches only what is on screen, not other menu options", async () => {
  render(<SettingsPanel {...props()} />);
  const menu = Array.from(document.querySelectorAll("select")).find(
    (el) => el.options.length > 1,
  );
  expect(menu).toBeTruthy();
  const picked = menu!.selectedOptions[0];
  const other = Array.from(menu!.options).find((o) => !o.selected)!;
  // Unique fictional labels, so nothing else on the page mentions them.
  other.text = "Zebraquux";
  picked.text = "Yakquux";
  await userEvent.type(searchField(), "zebraquux");
  expect(screen.getByRole("status").textContent).toBe("0 groups");
  await userEvent.clear(searchField());
  await userEvent.type(searchField(), "yakquux");
  expect(screen.getByRole("status").textContent).toBe("1 group");
});

it("finds text inside a closed More options and opens that disclosure with a label", async () => {
  render(<SettingsPanel {...props()} />);
  const transcription = region("Transcription");
  const details = Array.from(transcription.querySelectorAll("details")).find(
    (el) => el.textContent?.includes("Vocabulary hint"),
  ) as HTMLDetailsElement;
  expect(details.open).toBe(false);
  await userEvent.type(searchField(), "vocabulary");
  expect(missed(transcription)).toBe(false);
  expect(details.open).toBe(true);
  expect(
    within(details.querySelector("summary") as HTMLElement).getByText(
      "in More options",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("1 group");
  // Clearing the search closes it again and takes the label away.
  await userEvent.clear(searchField());
  expect(details.open).toBe(false);
  expect(screen.queryByText("in More options")).toBeNull();
});

it("finds Delete connection in AI notes through its closed More options", async () => {
  render(<SettingsPanel {...props()} />);
  await userEvent.type(searchField(), "delete");
  expect(missed(region("AI notes"))).toBe(false);
  expect(missed(region("General"))).toBe(true);
  expect(screen.getByText("in More options")).toBeTruthy();
});

it("does not match menu options that are not picked", async () => {
  render(<SettingsPanel {...props()} />);
  // "Date, then title" is the file-name option that is not picked on Export.
  await userEvent.type(searchField(), "date, then");
  expect(screen.getByRole("status").textContent).toBe("0 groups");
  expect(screen.queryByText("in More options")).toBeNull();
});

it("leaves a disclosure alone when the group already matches on screen", async () => {
  render(<SettingsPanel {...props()} />);
  // "Transcription" is a section title, so the whole section shows without opening anything.
  await userEvent.type(searchField(), "transcription");
  const details = Array.from(
    region("Transcription").querySelectorAll("details"),
  );
  for (const el of details) expect(el.open).toBe(false);
});

it("gives every group a real heading that still names the region", () => {
  render(<SettingsPanel {...props()} />);
  const heading = screen.getByRole("heading", { level: 3, name: "Appearance" });
  expect(heading.tagName).toBe("H3");
  expect(group("General", "Appearance").contains(heading)).toBe(true);
});

it("puts a skip link after the search field that moves focus to the index", async () => {
  render(<SettingsPanel {...props()} />);
  const field = searchField();
  field.focus();
  await userEvent.tab();
  const skip = screen.getByRole("link", { name: "Skip to sections" });
  expect(document.activeElement).toBe(skip);
  await userEvent.click(skip);
  expect(document.activeElement).toBe(indexButton("General"));
});

it("offers the chosen AI branch only, with the other one hidden until searched", () => {
  render(<SettingsPanel {...props()} />);
  const choice = within(screen.getByRole("group", { name: "Notes written" }));
  expect(
    choice
      .getByRole("button", { name: /^On this PC/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    choice
      .getByRole("button", { name: /^With a connection/ })
      .getAttribute("aria-pressed"),
  ).toBe("false");
  expect(hiddenBy(group("AI notes", "Local AI"))).toBe(false);
  expect(hiddenBy(group("AI notes", "Connection"))).toBe(true);
  expect(hiddenBy(group("AI notes", "Templates"))).toBe(false);
});

it("derives the AI branch from a local or remote notes connection", () => {
  const local = {
    ...settings,
    llm: { base_url: "http://127.0.0.1:8080/v1", model: "qwen", revision: 1 },
  };
  const { unmount } = render(
    <SettingsPanel {...props()} settings={local} initialSection="ai" />,
  );
  expect(hiddenBy(group("AI notes", "Local AI"))).toBe(false);
  expect(hiddenBy(group("AI notes", "Connection"))).toBe(true);
  unmount();
  const remote = {
    ...settings,
    llm: { base_url: "https://api.openai.com/v1", model: "gpt", revision: 1 },
  };
  render(<SettingsPanel {...props()} settings={remote} initialSection="ai" />);
  expect(
    within(screen.getByRole("group", { name: "Notes written" }))
      .getByRole("button", { name: /^With a connection/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(hiddenBy(group("AI notes", "Connection"))).toBe(false);
  expect(hiddenBy(group("AI notes", "Local AI"))).toBe(true);
});

it("opens the connection branch for the connections alias", () => {
  render(<SettingsPanel {...props()} initialSection="connections" />);
  expect(hiddenBy(group("AI notes", "Connection"))).toBe(false);
  expect(hiddenBy(group("AI notes", "Local AI"))).toBe(true);
});

it("switches the AI branch on a click and saves nothing", async () => {
  const input = props();
  render(<SettingsPanel {...input} initialSection="ai" />);
  await userEvent.click(
    within(screen.getByRole("group", { name: "Notes written" })).getByRole(
      "button",
      { name: /^With a connection/ },
    ),
  );
  expect(hiddenBy(group("AI notes", "Connection"))).toBe(false);
  expect(hiddenBy(group("AI notes", "Local AI"))).toBe(true);
  await userEvent.click(
    within(screen.getByRole("group", { name: "Notes written" })).getByRole(
      "button",
      { name: /^On this PC/ },
    ),
  );
  expect(hiddenBy(group("AI notes", "Local AI"))).toBe(false);
  expect(input.onSettings).not.toHaveBeenCalled();
  expect(input.onSummaryDefault).not.toHaveBeenCalled();
  expect(input.onProcessing).not.toHaveBeenCalled();
});

it("keeps the saved AI destination in view while the other branch is shown", async () => {
  const remote = {
    ...settings,
    llm: { base_url: "https://api.openai.com/v1", model: "gpt", revision: 1 },
  };
  render(<SettingsPanel {...props()} settings={remote} initialSection="ai" />);
  await userEvent.click(
    within(screen.getByRole("group", { name: "Notes written" })).getByRole(
      "button",
      { name: /^On this PC/ },
    ),
  );
  expect(hiddenBy(group("AI notes", "Local AI"))).toBe(false);
  expect(
    screen.getByText(/Saved destination: .*api\.openai\.com/),
  ).toBeTruthy();
  expect(screen.getByText(/Switching this view saves nothing/)).toBeTruthy();
});

it("finds a connection setting while the other AI branch is chosen", async () => {
  render(<SettingsPanel {...props()} />);
  // The API key field lives in the connection branch, which is hidden on this PC.
  await userEvent.type(searchField(), "api key");
  expect(missed(group("AI notes", "Connection"))).toBe(false);
  expect(hiddenBy(group("AI notes", "Connection"))).toBe(false);
  await userEvent.clear(searchField());
  expect(hiddenBy(group("AI notes", "Connection"))).toBe(true);
});

it("keeps the export footer to the audio size and says the files are not encrypted in About", () => {
  render(<SettingsPanel {...props()} />);
  const exportPane = region("Export & storage");
  expect(within(exportPane).queryByText(/not encrypted/)).toBeNull();
  expect(within(exportPane).getByText("of audio")).toBeTruthy();
  expect(
    within(region("Privacy & about")).getByText(
      "Meeting files are not encrypted. Keep the data and export folders in a place only you can open.",
    ),
  ).toBeTruthy();
});

it("says the data folder is not available yet and offers no copy when it is unknown", async () => {
  vi.mocked(api.dataFolder).mockRejectedValueOnce(new Error("unavailable"));
  render(<SettingsPanel {...props()} initialSection="export" />);
  expect(await screen.findByText("Not available yet")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Copy data folder path" }),
  ).toBeNull();
});

it("words each needs-you reason as the action to take", () => {
  render(
    <SettingsPanel
      {...props()}
      microphone="gone"
      output="gone"
      stt={{
        engine: true,
        model: true,
        vad: true,
        installed: false,
        missing_bytes: 1,
        supported: true,
        models: [],
        languages: ["auto"],
      }}
    />,
  );
  expect(
    within(region("Recording")).getByText("Choose a microphone and speakers"),
  ).toBeTruthy();
  expect(
    within(region("Transcription")).getByText("Download a speech model"),
  ).toBeTruthy();
});

it("has no enhanced-notes switch: the feature is always on", () => {
  render(<SettingsPanel {...props()} initialSection="ai" />);
  expect(
    screen.queryByRole("switch", { name: "Enhance my notes after recording" }),
  ).toBeNull();
  expect(screen.queryByRole("group", { name: "Enhanced notes" })).toBeNull();
});

it("has no theme preview under General; the theme choice stays", () => {
  render(<SettingsPanel {...props()} initialSection="general" />);
  expect(screen.queryByRole("group", { name: "Preview" })).toBeNull();
  expect(screen.getByRole("group", { name: "Theme" })).toBeTruthy();
});

it("shows a failed save on the Settings page and lets it be dismissed", async () => {
  const onDismissError = vi.fn();
  render(
    <SettingsPanel
      {...props()}
      error="The export folder could not be saved."
      onDismissError={onDismissError}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "The export folder could not be saved.",
  );
  await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(onDismissError).toHaveBeenCalled();
});
