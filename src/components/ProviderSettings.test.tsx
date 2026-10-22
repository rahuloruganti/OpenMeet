import { act, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api, type ProviderModel, type Settings } from "../lib/api";
import { Assignment, Connections } from "./ProviderSettings";
vi.mock("../lib/api", async (original) => ({
  ...(await original<typeof import("../lib/api")>()),
  api: {
    getSettings: vi.fn(),
    apiConnectionKeyStatus: vi.fn(),
    providerKeyStatus: vi.fn(),
    saveApiConnection: vi.fn(),
    listApiConnectionModels: vi.fn(),
    saveProviderAssignment: vi.fn(),
    deleteApiConnection: vi.fn(),
  },
}));
const connection = {
  id: "remote",
  name: "Remote",
  base_url: "https://provider.example/v1",
  revision: 1,
};
const settings: Settings = {
  saved_connections: [
    connection,
    {
      id: "local",
      name: "Local",
      base_url: "http://127.0.0.1:1234/v1",
      revision: 1,
    },
  ],
  provider_assignments: {
    llm: { connection_id: "remote", model: "saved-model", revision: 1 },
    cloud_stt: null,
  },
  llm: { base_url: connection.base_url, model: "saved-model", revision: 1 },
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
  export: {
    transcript: true,
    summary: true,
    filename: "title",
    transcript_formats: [],
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
};
const props = () => ({
  settings,
  active: true,
  disabled: false,
  onSaved: vi.fn(),
  onKeyStatus: vi.fn(),
});
/** Connections plus both task assignments, sharing fetched model IDs as Settings does. */
function Both(input: ReturnType<typeof props>) {
  const [models, setModels] = useState<{
    connectionId: string;
    models: ProviderModel[];
  } | null>(null);
  const task = {
    settings: input.settings,
    disabled: input.disabled,
    models,
    onSaved: input.onSaved,
    onKeyStatus: input.onKeyStatus,
  };
  return (
    <>
      <Connections
        {...input}
        onModels={(connectionId, list) =>
          setModels({ connectionId, models: list })
        }
      />
      <Assignment role="llm" {...task} />
      <Assignment role="cloud_stt" {...task} />
    </>
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getSettings).mockResolvedValue(settings);
  vi.mocked(api.apiConnectionKeyStatus).mockResolvedValue("present");
  vi.mocked(api.providerKeyStatus).mockResolvedValue("present");
  vi.mocked(api.saveProviderAssignment).mockResolvedValue(settings);
});
it("does not discover automatically and supports local discovery without a key", async () => {
  vi.mocked(api.apiConnectionKeyStatus).mockResolvedValue("missing");
  vi.mocked(api.listApiConnectionModels).mockResolvedValue([
    { id: "local-model" },
  ]);
  render(<Both {...props()} />);
  expect(
    screen.getAllByRole("option", { name: "Local · This device" })[0],
  ).toBeTruthy();
  expect(
    screen.getAllByRole("option", { name: "Remote · Leaves this device" })[0],
  ).toBeTruthy();
  expect(api.listApiConnectionModels).not.toHaveBeenCalled();
  await userEvent.selectOptions(
    screen.getByLabelText("Saved connection"),
    "local",
  );
  await userEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  await screen.findByText("local-model");
  expect(api.listApiConnectionModels).toHaveBeenCalledWith("local", 1);
});
it("clears passwords immediately on failed save and reloads partial publications", async () => {
  const input = props();
  vi.mocked(api.saveApiConnection).mockRejectedValue(
    new Error("Previous credential cleanup failed."),
  );
  render(<Both {...input} />);
  await userEvent.selectOptions(
    screen.getByLabelText("Saved connection"),
    "remote",
  );
  const key = screen.getByLabelText("API key");
  await userEvent.type(key, "synthetic-secret");
  await userEvent.click(
    screen.getByRole("button", { name: "Save connection" }),
  );
  expect(key).toHaveProperty("value", "");
  await screen.findByRole("alert");
  await waitFor(() => expect(input.onSaved).toHaveBeenCalledWith(settings));
  expect(api.saveApiConnection).toHaveBeenCalledWith({
    id: "remote",
    name: "Remote",
    baseUrl: connection.base_url,
    keyChange: { kind: "replace", key: "synthetic-secret" },
    expectedRevision: 1,
  });
});
it("preserves nonsecret drafts but clears keys when a tab hides and on unmount", async () => {
  const input = props();
  const view = render(<Both {...input} />);
  await userEvent.type(screen.getByLabelText("Connection name"), "Draft");
  const key = screen.getByLabelText("API key");
  await userEvent.type(key, "secret");
  view.rerender(<Both {...input} active={false} />);
  expect(key).toHaveProperty("value", "");
  expect(screen.getByLabelText("Connection name")).toHaveProperty(
    "value",
    "Draft",
  );
  view.rerender(<Both {...input} active />);
  await userEvent.type(key, "secret-again");
  view.unmount();
  expect(key).toHaveProperty("value", "");
});
it("saves each task independently even when they share a connection", async () => {
  render(<Both {...props()} />);
  await userEvent.clear(screen.getByLabelText("Summary model ID"));
  await userEvent.type(
    screen.getByLabelText("Summary model ID"),
    "chat-custom",
  );
  await userEvent.selectOptions(
    screen.getByLabelText("Speech API connection"),
    "remote",
  );
  await userEvent.type(
    screen.getByLabelText("Speech API model ID"),
    "speech-custom",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Save speech api assignment" }),
  );
  expect(api.saveProviderAssignment).toHaveBeenLastCalledWith(
    "cloud_stt",
    { kind: "assigned", connection_id: "remote", model: "speech-custom" },
    null,
  );
  expect(screen.getByLabelText("Summary model ID")).toHaveProperty(
    "value",
    "chat-custom",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Save summary assignment" }),
  );
  expect(api.saveProviderAssignment).toHaveBeenLastCalledWith(
    "llm",
    { kind: "assigned", connection_id: "remote", model: "chat-custom" },
    1,
  );
});
it("retains manual assignments after failed discovery and blocks an unsaved destination", async () => {
  vi.mocked(api.listApiConnectionModels).mockRejectedValue(
    new Error("Discovery unavailable"),
  );
  render(<Both {...props()} />);
  await userEvent.selectOptions(
    screen.getByLabelText("Saved connection"),
    "remote",
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Refresh models" }),
    ).toHaveProperty("disabled", false),
  );
  await userEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  await screen.findByText("Discovery unavailable");
  expect(screen.getByLabelText("Summary model ID")).toHaveProperty(
    "value",
    "saved-model",
  );
  await userEvent.type(screen.getByLabelText("API base URL"), "/other");
  expect(screen.getByRole("button", { name: "Refresh models" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(
    screen.getByRole("button", { name: "Delete connection" }),
  ).toHaveProperty("disabled", true);
});
it("discards discovery from an older connection revision", async () => {
  let finish: (value: ProviderModel[]) => void = () => {};
  vi.mocked(api.listApiConnectionModels).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const input = props();
  const view = render(<Both {...input} />);
  await userEvent.selectOptions(
    screen.getByLabelText("Saved connection"),
    "remote",
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Refresh models" }),
    ).toHaveProperty("disabled", false),
  );
  await userEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  view.rerender(
    <Both
      {...input}
      settings={{
        ...settings,
        saved_connections: [{ ...connection, revision: 2 }],
      }}
    />,
  );
  await act(async () => finish([{ id: "old-model" }]));
  expect(screen.queryByText("old-model")).toBeNull();
});

it("clears transient keys and retains assignment drafts after revision-only updates", async () => {
  const input = props();
  const view = render(<Both {...input} />);
  await userEvent.selectOptions(
    screen.getByLabelText("Saved connection"),
    "remote",
  );
  await userEvent.type(
    screen.getByLabelText("API key"),
    "synthetic-unsaved-key",
  );
  await userEvent.clear(screen.getByLabelText("Summary model ID"));
  await userEvent.type(
    screen.getByLabelText("Summary model ID"),
    "keep-this-draft",
  );
  view.rerender(
    <Both
      {...input}
      settings={{
        ...settings,
        saved_connections: [{ ...connection, revision: 2 }],
        provider_assignments: {
          ...settings.provider_assignments,
          llm: { connection_id: "remote", model: "saved-model", revision: 2 },
        },
        llm: {
          base_url: connection.base_url,
          model: "saved-model",
          revision: 2,
        },
      }}
    />,
  );
  expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
  expect(screen.getByLabelText("Summary model ID")).toHaveProperty(
    "value",
    "keep-this-draft",
  );
});
it("brings the save result into view on a long settings page", async () => {
  const scroll = vi.fn();
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  try {
    vi.mocked(api.saveApiConnection).mockResolvedValue(settings);
    render(<Both {...props()} />);
    await userEvent.selectOptions(
      screen.getByLabelText("Saved connection"),
      "remote",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save connection" }),
    );
    await screen.findByText(/Connection saved/);
    expect(scroll).toHaveBeenCalled();
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

it("hides an assignment's save button until it differs and offers fetched model IDs", async () => {
  vi.mocked(api.listApiConnectionModels).mockResolvedValue([
    { id: "fetched-model" },
  ]);
  render(<Both {...props()} />);
  expect(
    screen.queryByRole("button", { name: "Save summary assignment" }),
  ).toBeNull();
  await userEvent.selectOptions(
    screen.getByLabelText("Saved connection"),
    "remote",
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Refresh models" }),
    ).toHaveProperty("disabled", false),
  );
  await userEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  await screen.findByText("fetched-model");
  const input = screen.getByLabelText("Summary model ID") as HTMLInputElement;
  expect(
    input.list?.querySelector('option[value="fetched-model"]'),
  ).toBeTruthy();
  await userEvent.type(input, "-2");
  expect(
    screen.getByRole("button", { name: "Save summary assignment" }),
  ).toBeTruthy();
});
