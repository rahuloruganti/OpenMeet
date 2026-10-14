import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api, type ProviderModel, type Settings } from "../lib/api";
import { ProviderSettings } from "./ProviderSettings";

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      getSettings: vi.fn(),
      providerKeyStatus: vi.fn(),
      saveProviderConnection: vi.fn(),
      listProviderModels: vi.fn(),
      saveProviderModel: vi.fn(),
    },
  };
});

const config = {
  base_url: "https://provider.example/v1",
  model: "saved-model",
  revision: 1,
};
const settings: Settings = {
  llm: config,
  cloud_stt: null,
  stt_mode: "local",
  stt_model: "small",
  stt_language: "auto",
  stt_prompt: "",
  vault_folder: null,
  pause_shortcut: "CommandOrControl+Shift+Space",
  stop_shortcut: null,
  microphone_id: null,
  output_id: null,
  export: { transcript: true, summary: true, filename: "title" },
};
const props = () => ({
  role: "llm" as const,
  config,
  keyStatus: "present" as const,
  disabled: false,
  onSaved: vi.fn(),
  onKeyStatus: vi.fn(),
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getSettings).mockResolvedValue(settings);
  vi.mocked(api.providerKeyStatus).mockResolvedValue("present");
});

it("discovers models from a saved local server without requiring a key", async () => {
  vi.mocked(api.listProviderModels).mockResolvedValue([{ id: "local-model" }]);
  render(
    <ProviderSettings
      {...props()}
      keyStatus="missing"
      config={{ ...config, base_url: "http://127.0.0.1:1234/v1" }}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Refresh summary models" }),
  );
  await screen.findByRole("option", { name: "local-model" });
  expect(api.listProviderModels).toHaveBeenCalledWith("llm", 1);
  expect(screen.getByText("Local server. API key optional.")).toBeTruthy();
});

it("clears the password on a failed save and reloads settings after partial publication", async () => {
  const input = props();
  const newer = { ...settings, llm: { ...config, revision: 2 } };
  vi.mocked(api.getSettings).mockResolvedValue(newer);
  vi.mocked(api.saveProviderConnection).mockRejectedValue({
    code: "provider_cleanup",
    message: "Previous credential cleanup failed.",
  });
  render(<ProviderSettings {...input} />);
  const key = screen.getByLabelText("Summary API key");
  await userEvent.type(key, "synthetic-secret");
  await userEvent.click(
    screen.getByRole("button", { name: "Save summary connection" }),
  );
  expect(key).toHaveProperty("value", "");
  await screen.findByRole("alert");
  await waitFor(() => expect(input.onSaved).toHaveBeenCalledWith(newer));
  expect(api.saveProviderConnection).toHaveBeenCalledWith(
    "llm",
    config.base_url,
    { kind: "replace", key: "synthetic-secret" },
    1,
  );
  expect(screen.getByRole("alert").textContent).not.toContain(
    "synthetic-secret",
  );
});

it("clears a detached password element when Settings closes without saving", async () => {
  const view = render(<ProviderSettings {...props()} />);
  const key = screen.getByLabelText("Summary API key");
  await userEvent.type(key, "unsaved-synthetic-secret");
  view.unmount();
  expect(key).toHaveProperty("value", "");
  expect(api.saveProviderConnection).not.toHaveBeenCalled();
});

it("keeps the saved model and custom-ID path when discovery is unsupported", async () => {
  vi.mocked(api.listProviderModels).mockRejectedValue(
    new Error("Model discovery is unavailable."),
  );
  render(<ProviderSettings {...props()} />);
  await userEvent.click(
    screen.getByRole("button", { name: "Refresh summary models" }),
  );
  await screen.findByText("Model discovery is unavailable.");
  expect(screen.getByLabelText("Summary model")).toHaveProperty(
    "value",
    "saved-model",
  );
  await userEvent.selectOptions(screen.getByLabelText("Summary model"), "");
  await userEvent.clear(screen.getByLabelText("Summary custom model ID"));
  await userEvent.type(
    screen.getByLabelText("Summary custom model ID"),
    "unlisted-model",
  );
  vi.mocked(api.saveProviderModel).mockResolvedValue(settings);
  await userEvent.click(
    screen.getByRole("button", { name: "Save summary model" }),
  );
  expect(api.saveProviderModel).toHaveBeenCalledWith(
    "llm",
    "unlisted-model",
    1,
  );
});

it("discards model discovery returned for an old connection revision", async () => {
  let finish: (models: ProviderModel[]) => void = () => {};
  vi.mocked(api.listProviderModels).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const input = props();
  const view = render(<ProviderSettings {...input} />);
  await userEvent.click(
    screen.getByRole("button", { name: "Refresh summary models" }),
  );
  view.rerender(
    <ProviderSettings
      {...input}
      config={{ ...config, base_url: "https://new.example/v1", revision: 2 }}
    />,
  );
  await act(async () => finish([{ id: "old-provider-model" }]));
  expect(
    screen.queryByRole("option", { name: "old-provider-model" }),
  ).toBeNull();
  expect(screen.getByLabelText("Summary API base URL")).toHaveProperty(
    "value",
    "https://new.example/v1",
  );
});

it("uses the cloud speech slot independently and blocks discovery for an unsaved URL", async () => {
  render(<ProviderSettings {...props()} role="cloud_stt" />);
  await userEvent.clear(screen.getByLabelText("Cloud speech API base URL"));
  await userEvent.type(
    screen.getByLabelText("Cloud speech API base URL"),
    "https://other.example/v1",
  );
  expect(
    screen.getByRole("button", { name: "Refresh cloud speech models" }),
  ).toHaveProperty("disabled", true);
  expect(
    screen.getByRole("button", { name: "Remove cloud speech key" }),
  ).toHaveProperty("disabled", true);
  const key = screen.getByLabelText("Cloud speech API key");
  await userEvent.type(key, "speech-synthetic-key");
  vi.mocked(api.saveProviderConnection).mockResolvedValue(settings);
  await userEvent.click(
    screen.getByRole("button", { name: "Save cloud speech connection" }),
  );
  expect(api.saveProviderConnection).toHaveBeenCalledWith(
    "cloud_stt",
    "https://other.example/v1",
    { kind: "replace", key: "speech-synthetic-key" },
    1,
  );
  expect(key).toHaveProperty("value", "");
});
