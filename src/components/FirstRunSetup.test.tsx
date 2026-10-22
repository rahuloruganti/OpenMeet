import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api, type Settings } from "../lib/api";
import { FirstRunSetup } from "./FirstRunSetup";

vi.mock("../lib/api", async (original) => ({
  ...(await original<typeof import("../lib/api")>()),
  api: {
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
  };
  render(
    <FirstRunSetup
      panelRef={{ current: null }}
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

beforeEach(() => {
  vi.resetAllMocks();
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

it("uses an installed Whisper file in place and hides non-speech files", async () => {
  const props = show();
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  const list = await screen.findByRole("list", {
    name: "Installed Whisper models",
  });
  expect(list.textContent).toContain("matches pinned base");
  expect(list.textContent).not.toContain("llm.gguf");
  await userEvent.click(within(list).getByRole("button", { name: "Use" }));
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

it("offers a detected local server for AI notes with chat models only", async () => {
  vi.mocked(api.saveApiConnection).mockResolvedValue(settings);
  show();
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await userEvent.click(
    await screen.findByRole("radio", { name: /Ollama on this computer/ }),
  );
  const model = screen.getByRole("combobox", { name: "Model" });
  const options = within(model)
    .getAllByRole("option")
    .map((option) => option.textContent);
  expect(options).toContain("llama3");
  expect(options).not.toContain("nomic-embed-text");
  expect(api.saveApiConnection).not.toHaveBeenCalled();
});

it("finishes with default devices and automatic transcription, or skips with nothing else saved", async () => {
  vi.mocked(api.saveDefaultDevices).mockResolvedValue(settings);
  vi.mocked(api.saveProcessingDefault).mockResolvedValue(settings);
  const props = show();
  for (let step = 0; step < 3; step++)
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await userEvent.click(screen.getByRole("button", { name: "Finish" }));
  await waitFor(() => expect(api.saveSetupDone).toHaveBeenCalledWith(true));
  expect(api.saveDefaultDevices).toHaveBeenCalledWith("mic", "app-audio");
  expect(props.onDevices).toHaveBeenCalledWith("mic", "app-audio");
  expect(api.saveProcessingDefault).toHaveBeenCalledWith("final", null);

  vi.mocked(api.saveDefaultDevices).mockClear();
  vi.mocked(api.saveProcessingDefault).mockClear();
  vi.mocked(api.saveSetupDone).mockClear();
  document.body.innerHTML = "";
  show();
  await userEvent.click(screen.getByRole("button", { name: "Skip setup" }));
  await waitFor(() => expect(api.saveSetupDone).toHaveBeenCalledWith(true));
  expect(api.saveDefaultDevices).not.toHaveBeenCalled();
  expect(api.saveProcessingDefault).not.toHaveBeenCalled();
});

it("recommends Parakeet for English or auto, and Whisper small for other languages", async () => {
  show({ stt_language: "en" });
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  const english = await screen.findByRole("list", {
    name: "Recommended downloads",
  });
  expect(english.textContent).toContain("Parakeet TDT 0.6B v3");
  expect(english.textContent).toContain("Whisper small");
  document.body.innerHTML = "";
  show({ stt_language: "ja" });
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  const japanese = await screen.findByRole("list", {
    name: "Recommended downloads",
  });
  expect(japanese.textContent).not.toContain("Parakeet");
  expect(japanese.textContent).toContain("Whisper small");
});
