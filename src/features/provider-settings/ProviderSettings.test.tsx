import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api, type ProviderModel, type Settings } from "../../shared/api/api";
import { ConnectionEditor } from "./ProviderSettings";
vi.mock("../../shared/api/api", async (original) => ({
  ...(await original<typeof import("../../shared/api/api")>()),
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
  theme: "system",
  inspector_open: true,
};
const props = (input: Settings = settings) => ({
  role: "llm" as const,
  settings: input,
  active: true,
  disabled: false,
  onSaved: vi.fn(),
  onKeyStatus: vi.fn(),
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getSettings).mockResolvedValue(settings);
  vi.mocked(api.apiConnectionKeyStatus).mockResolvedValue("present");
  vi.mocked(api.providerKeyStatus).mockResolvedValue("present");
  vi.mocked(api.saveProviderAssignment).mockResolvedValue(settings);
});

it("lists saved connections by destination and discovers models only on request", async () => {
  vi.mocked(api.listApiConnectionModels).mockResolvedValue([
    { id: "local-model" },
  ]);
  render(<ConnectionEditor {...props()} />);
  expect(
    screen.getByRole("option", { name: "Local · This device" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("option", { name: "Remote · Leaves this device" }),
  ).toBeTruthy();
  expect(api.listApiConnectionModels).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Refresh models" }),
    ).toHaveProperty("disabled", false),
  );
  await userEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  await screen.findByText(
    "Model IDs fetched. Compatibility with each task is unverified.",
  );
  expect(api.listApiConnectionModels).toHaveBeenCalledWith("remote", 1);
});

it("clears the typed key at once on a failed save and reloads a partial save", async () => {
  const input = props();
  vi.mocked(api.saveApiConnection).mockRejectedValue(
    new Error("Previous credential cleanup failed."),
  );
  render(<ConnectionEditor {...input} />);
  const key = screen.getByLabelText("API key");
  await userEvent.type(key, "synthetic-secret");
  expect(
    screen.getByRole("button", { name: "Save" }).getAttribute("disabled"),
  ).toBe(null);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(key).toHaveProperty("value", "");
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Previous credential cleanup failed.",
  );
  expect(input.onSaved).toHaveBeenCalledWith(settings);
  expect(api.saveApiConnection).toHaveBeenCalledWith({
    id: "remote",
    name: "Remote",
    baseUrl: connection.base_url,
    keyChange: { kind: "replace", key: "synthetic-secret" },
    expectedRevision: 1,
  });
});

it("keeps non-secret drafts but clears a typed key when the section hides or unmounts", async () => {
  const input = props();
  const view = render(<ConnectionEditor {...input} />);
  await userEvent.type(screen.getByLabelText("Connection name"), " Draft");
  const key = screen.getByLabelText("API key");
  await userEvent.type(key, "secret");
  view.rerender(<ConnectionEditor {...input} active={false} />);
  expect(key).toHaveProperty("value", "");
  expect(screen.getByLabelText("Connection name")).toHaveProperty(
    "value",
    "Remote Draft",
  );
  view.rerender(<ConnectionEditor {...input} active />);
  await userEvent.type(key, "secret-again");
  view.unmount();
  expect(key).toHaveProperty("value", "");
});

it("saves the connection and the task that uses it from one button", async () => {
  const input = props();
  render(<ConnectionEditor {...input} />);
  await userEvent.clear(screen.getByLabelText("Model"));
  await userEvent.type(screen.getByLabelText("Model"), "chat-custom");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(api.saveProviderAssignment).toHaveBeenCalledWith(
      "llm",
      { kind: "assigned", connection_id: "remote", model: "chat-custom" },
      1,
    ),
  );
  expect(api.saveApiConnection).not.toHaveBeenCalled();
});

it("can unassign the task without deleting the connection", async () => {
  render(<ConnectionEditor {...props()} />);
  await userEvent.selectOptions(
    screen.getByLabelText("Saved connection"),
    "No connection",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(api.saveProviderAssignment).toHaveBeenCalledWith(
      "llm",
      { kind: "unassigned" },
      1,
    ),
  );
  expect(api.deleteApiConnection).not.toHaveBeenCalled();
});

it("keeps a manual model after a failed discovery and blocks a stale destination", async () => {
  vi.mocked(api.listApiConnectionModels).mockRejectedValue(
    new Error("Discovery unavailable"),
  );
  render(<ConnectionEditor {...props()} />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Refresh models" }),
    ).toHaveProperty("disabled", false),
  );
  await userEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  await screen.findByText("Discovery unavailable");
  expect(screen.getByLabelText("Model")).toHaveProperty("value", "saved-model");
  await userEvent.type(screen.getByLabelText("Base URL"), "/other");
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
  const view = render(<ConnectionEditor {...input} />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Refresh models" }),
    ).toHaveProperty("disabled", false),
  );
  await userEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  view.rerender(
    <ConnectionEditor
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

it("clears a typed key but keeps the model draft after a revision-only update", async () => {
  const input = props();
  const view = render(<ConnectionEditor {...input} />);
  await userEvent.type(screen.getByLabelText("API key"), "synthetic-key");
  await userEvent.clear(screen.getByLabelText("Model"));
  await userEvent.type(screen.getByLabelText("Model"), "keep-this-draft");
  view.rerender(
    <ConnectionEditor
      {...input}
      settings={{
        ...settings,
        saved_connections: [{ ...connection, revision: 2 }],
        provider_assignments: {
          ...settings.provider_assignments,
          llm: { connection_id: "remote", model: "saved-model", revision: 2 },
        },
      }}
    />,
  );
  expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
  expect(screen.getByLabelText("Model")).toHaveProperty(
    "value",
    "keep-this-draft",
  );
});

it("brings the save result into view on a long page", async () => {
  const scroll = vi.fn();
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  try {
    vi.mocked(api.saveApiConnection).mockResolvedValue(settings);
    render(<ConnectionEditor {...props()} />);
    await userEvent.type(screen.getByLabelText("API key"), "synthetic-key");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Saved on this device/);
    expect(scroll).toHaveBeenCalled();
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

it("offers fetched model IDs for the task it serves", async () => {
  vi.mocked(api.listApiConnectionModels).mockResolvedValue([
    { id: "fetched-model" },
  ]);
  render(<ConnectionEditor {...props()} />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Refresh models" }),
    ).toHaveProperty("disabled", false),
  );
  await userEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  await screen.findByText("fetched-model");
  const input = screen.getByLabelText("Model") as HTMLInputElement;
  expect(
    input.list?.querySelector('option[value="fetched-model"]'),
  ).toBeTruthy();
});

it("offers no local server choice for AI notes and marks it as leaving the device", () => {
  render(<ConnectionEditor {...props()} />);
  expect(screen.queryByRole("group", { name: "AI connection" })).toBeNull();
  expect(screen.queryByText(/Local server/)).toBeNull();
  expect(screen.getByText("Leaves this device")).toBeTruthy();
  expect(screen.getByLabelText("Base URL")).toHaveProperty(
    "placeholder",
    "https://api.example.com/v1",
  );
});
