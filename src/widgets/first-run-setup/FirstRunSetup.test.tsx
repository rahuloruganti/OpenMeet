import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api, type Settings } from "../../shared/api/api";
import { baseUrlError } from "../../features/provider-settings";
import { CUSTOM_PROVIDER } from "../../shared/lib/providers";
import { FirstRunSetup } from "./FirstRunSetup";

vi.mock("../../shared/api/api", async (original) => ({
  ...(await original<typeof import("../../shared/api/api")>()),
  api: {
    importStatus: vi.fn(),
    importPrevious: vi.fn(),
    scanLocalModels: vi.fn(),
    detectLocalServers: vi.fn(),
    saveSttSettings: vi.fn(),
    saveSttMode: vi.fn(),
    saveApiConnection: vi.fn(),
    listApiConnectionModels: vi.fn(),
    saveProviderAssignment: vi.fn(),
    saveDefaultDevices: vi.fn(),
    saveProcessingDefault: vi.fn(),
    saveSetupDone: vi.fn(),
    providerKeyStatus: vi.fn(),
  },
}));

const settings = {
  stt_mode: "local",
  stt_language: "auto",
  stt_prompt: "",
  stt_model: "small",
  microphone_id: null,
  output_id: null,
  saved_connections: [],
  provider_assignments: { llm: null, cloud_stt: null },
  llm: null,
  cloud_stt: null,
  setup_done: false,
} as unknown as Settings;

function show(overrides: Partial<Settings> = {}) {
  const props = {
    onInstallStt: vi.fn(),
    onSettings: vi.fn(),
    onDevices: vi.fn(),
    onSkipSetup: vi.fn(),
    onStartMeeting: vi.fn(),
    onOpenSettings: vi.fn(),
  };
  render(
    <FirstRunSetup
      settings={{ ...settings, ...overrides }}
      devices={{
        capture_supported: true,
        microphones: [{ id: "mic", name: "Headset" }],
        outputs: [{ id: "app-audio", name: "All app audio (except OpenMeet)" }],
      }}
      stt={null}
      sttProgress={null}
      installing={false}
      onRefreshDevices={vi.fn()}
      onKeyStatus={vi.fn()}
      {...props}
    />,
  );
  return props;
}

const next = () =>
  userEvent.click(screen.getByRole("button", { name: "Continue" }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.importStatus).mockResolvedValue({
    available: false,
    path: null,
    meetings: 0,
    audio_files: 0,
    bytes: 0,
    blocked_reason: "No earlier data folder was found.",
  });
  vi.mocked(api.scanLocalModels).mockResolvedValue({
    models: [
      {
        path: "C:\\models\\ggml-base.bin",
        format: "whisper",
        size: 147951465,
        model_id: "base",
      },
      { path: "C:\\models\\llm.gguf", format: "gguf", size: 9, model_id: null },
    ],
    folders: [],
    truncated: false,
  });
  vi.mocked(api.detectLocalServers).mockResolvedValue([
    {
      name: "Ollama",
      base_url: "http://127.0.0.1:11434/v1",
      kind: "chat",
      needs_key: false,
      models: [{ id: "llama3" }, { id: "nomic-embed-text" }],
    },
  ]);
  vi.mocked(api.saveSttSettings).mockResolvedValue(settings);
  vi.mocked(api.saveSttMode).mockResolvedValue(settings);
  vi.mocked(api.providerKeyStatus).mockResolvedValue("missing");
  vi.mocked(api.saveSetupDone).mockResolvedValue({
    ...settings,
    setup_done: true,
  });
});

it("offers the import step only when there is something to bring over", async () => {
  show();
  await screen.findByRole("heading", { name: "How should we transcribe?" });
  const steps = screen.getByRole("list", { name: "Setup steps" });
  expect(within(steps).queryByText("Import")).toBeNull();
  expect(within(steps).getAllByRole("listitem")).toHaveLength(4);
});

it("shows what import would bring over, states the result, and lets the step be skipped", async () => {
  vi.mocked(api.importStatus).mockResolvedValue({
    available: true,
    path: "%APPDATA%\\dev.openmeet.preview",
    meetings: 16,
    audio_files: 46,
    bytes: 104 * 1024 * 1024,
    blocked_reason: null,
  });
  let release = () => {};
  vi.mocked(api.importPrevious).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            meetings: 16,
            transcript_lines: 420,
            audio_files: 46,
            notes: [],
          });
      }),
  );
  show();
  await screen.findByRole("heading", { name: "Bring your meetings over" });
  expect(screen.getByText(/16 meetings/).textContent).toContain(
    "46 recordings",
  );
  expect(screen.getByText("%APPDATA%\\dev.openmeet.preview")).toBeTruthy();
  const start = screen.getByRole("button", { name: "Import" });
  await userEvent.click(start);
  expect(
    (
      (await screen.findByRole("button", {
        name: "Importing…",
      })) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  release();
  expect(
    (
      await screen.findByText("Imported 16 meetings and 420 transcript lines.")
    ).getAttribute("role"),
  ).toBe("status");
  // The step is skippable: Import leaves the step alone and Continue moves on.
  await userEvent.click(screen.getByRole("button", { name: "Skip step" }));
  expect(
    await screen.findByRole("heading", { name: "How should we transcribe?" }),
  ).toBeTruthy();
});

it("reports a failed import in one line and leaves the wizard usable", async () => {
  vi.mocked(api.importStatus).mockResolvedValue({
    available: true,
    path: "C:\\old",
    meetings: 1,
    audio_files: 0,
    bytes: 1024,
    blocked_reason: null,
  });
  vi.mocked(api.importPrevious).mockRejectedValue(
    new Error("The destination folder already has meetings."),
  );
  show();
  await screen.findByRole("heading", { name: "Bring your meetings over" });
  await userEvent.click(screen.getByRole("button", { name: "Import" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(
    "The destination folder already has meetings.",
  );
});

it("uses an installed Whisper file in place and hides non-speech files", async () => {
  const props = show();
  await screen.findByRole("heading", { name: "How should we transcribe?" });
  await userEvent.click(screen.getByText("Use a model I already have"));
  const list = await screen.findByRole("list", {
    name: "Installed Whisper models",
  });
  expect(list.textContent).toContain("ggml-base.bin");
  expect(list.textContent).not.toContain("llm.gguf");
  await userEvent.click(
    within(list).getByRole("button", { name: "Use ggml-base.bin" }),
  );
  await waitFor(() =>
    expect(api.saveSttSettings).toHaveBeenCalledWith(
      "auto",
      "",
      "C:\\models\\ggml-base.bin",
    ),
  );
  expect(api.saveSttMode).toHaveBeenCalledWith("local");
  expect(props.onInstallStt).toHaveBeenCalled();
});

it("offers no local server for AI notes, even when one is detected", async () => {
  show();
  await screen.findByRole("heading", { name: "How should we transcribe?" });
  await next();
  await screen.findByRole("heading", { name: /AI notes/ });
  expect(screen.queryByRole("radio", { name: /on this computer/ })).toBeNull();
  expect(screen.queryByText(/No local AI server/)).toBeNull();
  expect(screen.getByRole("radio", { name: /API service/ })).toBeTruthy();
});

it("finishes with default devices and recording only, then starts a meeting", async () => {
  vi.mocked(api.saveDefaultDevices).mockResolvedValue(settings);
  vi.mocked(api.saveProcessingDefault).mockResolvedValue(settings);
  const props = show();
  await screen.findByRole("heading", { name: "How should we transcribe?" });
  await next();
  await next();
  expect(
    (
      screen.getByRole("checkbox", {
        name: /Transcribe every recording/,
      }) as HTMLInputElement
    ).checked,
  ).toBe(false);
  await next();
  expect(screen.getByRole("heading", { name: "You're set" })).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: "Start a meeting" }),
  );
  await waitFor(() => expect(api.saveSetupDone).toHaveBeenCalledWith(true));
  expect(api.saveDefaultDevices).toHaveBeenCalledWith("mic", "app-audio");
  expect(props.onDevices).toHaveBeenCalledWith("mic", "app-audio");
  expect(api.saveProcessingDefault).toHaveBeenCalledWith("recording", null);
  expect(props.onStartMeeting).toHaveBeenCalled();
});

it("opens Settings from the last step instead of starting a meeting", async () => {
  vi.mocked(api.saveDefaultDevices).mockResolvedValue(settings);
  vi.mocked(api.saveProcessingDefault).mockResolvedValue(settings);
  const props = show();
  await screen.findByRole("heading", { name: "How should we transcribe?" });
  await next();
  await next();
  await next();
  await userEvent.click(screen.getByRole("button", { name: "Open settings" }));
  await waitFor(() => expect(api.saveSetupDone).toHaveBeenCalledWith(true));
  expect(props.onOpenSettings).toHaveBeenCalled();
  expect(props.onStartMeeting).not.toHaveBeenCalled();
});

it("skips the whole wizard without saving devices or processing", async () => {
  const props = show();
  await screen.findByRole("heading", { name: "How should we transcribe?" });
  await userEvent.click(screen.getByRole("button", { name: "Skip setup" }));
  await waitFor(() => expect(api.saveSetupDone).toHaveBeenCalledWith(true));
  expect(api.saveDefaultDevices).not.toHaveBeenCalled();
  expect(api.saveProcessingDefault).not.toHaveBeenCalled();
  expect(props.onSkipSetup).toHaveBeenCalled();
});

it("recommends Parakeet for English or auto, and Whisper small for other languages", async () => {
  show({ stt_language: "en" });
  await screen.findByRole("heading", { name: "How should we transcribe?" });
  await userEvent.click(screen.getByText("More models"));
  const english = await screen.findByRole("list", {
    name: "Recommended downloads",
  });
  expect(english.textContent).toContain("Parakeet TDT 0.6B v3");
  expect(english.textContent).toContain("Whisper small");
  // Each download button is named for its own model, not a generic "Download".
  expect(
    within(english).getByRole("button", {
      name: "Download and use Parakeet TDT 0.6B v3 (English + European languages)",
    }),
  ).toBeTruthy();
  expect(
    within(english).getByRole("button", {
      name: "Download and use Whisper small",
    }),
  ).toBeTruthy();
  cleanup();
  show({ stt_language: "ja" });
  await screen.findByRole("heading", { name: "How should we transcribe?" });
  await userEvent.click(screen.getByText("More models"));
  expect(
    (await screen.findByRole("list", { name: "Recommended downloads" }))
      .textContent,
  ).not.toContain("Parakeet");
});

it("saves automatic transcription only when the box is ticked", async () => {
  vi.mocked(api.saveDefaultDevices).mockResolvedValue(settings);
  vi.mocked(api.saveProcessingDefault).mockResolvedValue(settings);
  show();
  await screen.findByRole("heading", { name: "How should we transcribe?" });
  await next();
  await next();
  await userEvent.click(
    screen.getByRole("checkbox", { name: /Transcribe every recording/ }),
  );
  await next();
  await userEvent.click(
    screen.getByRole("button", { name: "Start a meeting" }),
  );
  await waitFor(() => expect(api.saveSetupDone).toHaveBeenCalledWith(true));
  expect(api.saveProcessingDefault).toHaveBeenCalledWith("final", null);
});

it("offers the major providers for AI notes and connects the default one", async () => {
  vi.mocked(api.saveApiConnection).mockResolvedValue({
    ...settings,
    saved_connections: [
      {
        id: "conn-1",
        name: "OpenAI",
        base_url: "https://api.openai.com/v1",
        revision: 4,
      },
    ],
  } as unknown as Settings);
  vi.mocked(api.listApiConnectionModels).mockResolvedValue([
    { id: "gpt-5-mini" },
    { id: "text-embedding-3-small" },
  ]);
  show();
  await screen.findByRole("heading", { name: "How should we transcribe?" });
  await next();
  await userEvent.click(screen.getByRole("radio", { name: /API service/ }));
  const picker = screen.getByLabelText("Provider") as HTMLSelectElement;
  expect(
    within(picker)
      .getAllByRole("option")
      .map((item) => item.textContent),
  ).toEqual([
    "OpenAI",
    "Claude (Anthropic)",
    "Gemini (Google)",
    "Mistral",
    "Groq",
    "Grok (xAI)",
    "DeepSeek",
    "OpenRouter",
    "Custom",
  ]);
  // The first preset is the default: no Base URL to type, and the name follows the label.
  expect(picker.value).toBe("openai");
  expect(screen.queryByLabelText("Base URL")).toBeNull();
  expect(screen.getByRole("note").textContent).toBe("api.openai.com");
  expect(
    (screen.getByLabelText(/^API key/) as HTMLInputElement).placeholder,
  ).toBe("Key from platform.openai.com");
  await userEvent.click(
    screen.getByRole("button", { name: "Connect and list models" }),
  );
  await waitFor(() =>
    expect(api.saveApiConnection).toHaveBeenCalledWith({
      id: null,
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      keyChange: { kind: "keep" },
      expectedRevision: null,
    }),
  );
  expect(api.listApiConnectionModels).toHaveBeenCalledWith("conn-1", 4);
  // The first model that fits the task is picked for the user.
  await waitFor(() =>
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe(
      "gpt-5-mini",
    ),
  );
});

it("numbers a provider name that a saved connection already uses", async () => {
  vi.mocked(api.saveApiConnection).mockResolvedValue({
    ...settings,
    saved_connections: [
      {
        id: "conn-old",
        name: "OpenAI",
        base_url: "https://api.example.com/v1",
        revision: 1,
      },
      {
        id: "conn-new",
        name: "OpenAI 2",
        base_url: "https://api.openai.com/v1",
        revision: 1,
      },
    ],
  } as unknown as Settings);
  vi.mocked(api.listApiConnectionModels).mockResolvedValue([{ id: "gpt-5" }]);
  show({
    saved_connections: [
      {
        id: "conn-old",
        name: "OpenAI",
        base_url: "https://api.example.com/v1",
        revision: 1,
      },
    ],
  } as Partial<Settings>);
  await screen.findByRole("heading", { name: "How should we transcribe?" });
  await userEvent.click(screen.getByRole("radio", { name: /Cloud service/ }));
  await userEvent.click(
    screen.getByRole("button", { name: "Connect and list models" }),
  );
  await waitFor(() =>
    expect(api.saveApiConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: null,
        name: "OpenAI 2",
        baseUrl: "https://api.openai.com/v1",
      }),
    ),
  );
});

it("offers only the speech providers for cloud transcription", async () => {
  show();
  await screen.findByRole("heading", { name: "How should we transcribe?" });
  await userEvent.click(screen.getByRole("radio", { name: /Cloud service/ }));
  const picker = screen.getByLabelText("Provider");
  expect(
    within(picker)
      .getAllByRole("option")
      .map((item) => item.textContent),
  ).toEqual(["OpenAI", "Groq", "Custom"]);
});

it("saves a custom API under its destination when no name is typed", async () => {
  vi.mocked(api.saveApiConnection).mockResolvedValue({
    ...settings,
    saved_connections: [
      {
        id: "conn-2",
        name: "api.example.com",
        base_url: "https://api.example.com/v1",
        revision: 1,
      },
    ],
  } as unknown as Settings);
  vi.mocked(api.listApiConnectionModels).mockResolvedValue([{ id: "fun-1" }]);
  show();
  await screen.findByRole("heading", { name: "How should we transcribe?" });
  await userEvent.click(screen.getByRole("radio", { name: /Cloud service/ }));
  await userEvent.selectOptions(
    screen.getByLabelText("Provider"),
    CUSTOM_PROVIDER,
  );
  await userEvent.type(
    screen.getByLabelText("Base URL"),
    "https://api.example.com/v1",
  );
  // A name is optional now: the URL alone lets the user connect.
  const connect = screen.getByRole("button", {
    name: "Connect and list models",
  }) as HTMLButtonElement;
  expect(connect.disabled).toBe(false);
  await userEvent.click(connect);
  await waitFor(() =>
    expect(api.saveApiConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: null,
        name: "api.example.com",
        baseUrl: "https://api.example.com/v1",
      }),
    ),
  );
});

it("rejects a base URL the way Settings does, before asking the server", async () => {
  show();
  await screen.findByRole("heading", { name: "How should we transcribe?" });
  await userEvent.click(screen.getByRole("radio", { name: /Cloud service/ }));
  // A typed API is the Custom choice; every preset brings its own URL.
  await userEvent.selectOptions(
    screen.getByLabelText("Provider"),
    CUSTOM_PROVIDER,
  );
  await userEvent.type(screen.getByLabelText(/^Name/), "Work");
  const url = screen.getByLabelText("Base URL");
  await userEvent.type(url, "http://api.example.com/v1");
  // Exactly the one-line rule the Settings connection editor shows: one validator, one message.
  const expected = baseUrlError("http://api.example.com/v1");
  expect(expected).toBeTruthy();
  expect((await screen.findByRole("alert")).textContent).toBe(expected);
  expect(
    (
      screen.getByRole("button", {
        name: "Connect and list models",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(api.saveApiConnection).not.toHaveBeenCalled();
  await userEvent.clear(url);
  await userEvent.type(url, "https://api.example.com/v1");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    (
      screen.getByRole("button", {
        name: "Connect and list models",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});
