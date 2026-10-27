import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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
    testApiConnection: vi.fn(),
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
  processing_mode: "recording",
  processing_summary: null,
  summary_default: "general-v1",
  detection_enabled: false,
  detection_ignored: [],
  auto_capture: false,
  calendar_reminders: true,
  calendar_reminder_minutes: 2,
  setup_done: true,
  processing_enhance: true,
  theme: "system",
  inspector_open: true,
  live_transcript: true,
  live_model: "",
};
const props = (input: Settings = settings) => ({
  role: "llm" as const,
  settings: input,
  active: true,
  disabled: false,
  onSaved: vi.fn(),
  onKeyStatus: vi.fn(),
});
/** The model menu entry that asks for a model ID by hand. */
const other = () => screen.getByRole("option", { name: /^Other/ });
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getSettings).mockResolvedValue(settings);
  vi.mocked(api.apiConnectionKeyStatus).mockResolvedValue("present");
  vi.mocked(api.providerKeyStatus).mockResolvedValue("present");
  vi.mocked(api.saveProviderAssignment).mockResolvedValue(settings);
  vi.mocked(api.listApiConnectionModels).mockResolvedValue([]);
  vi.mocked(api.testApiConnection).mockResolvedValue([]);
});

it("lists saved connections by name and loads models only when Test is clicked", async () => {
  vi.mocked(api.testApiConnection).mockResolvedValue([{ id: "local-model" }]);
  render(<ConnectionEditor {...props()} />);
  expect(screen.getByRole("option", { name: "Local" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Remote" })).toBeTruthy();
  // Nothing is listed until the user asks: no request on render, no models offered.
  expect(api.testApiConnection).not.toHaveBeenCalled();
  expect(screen.queryByRole("option", { name: "local-model" })).toBeNull();
  // A saved model the provider does not list keeps its own entry.
  expect(screen.getByRole("option", { name: "saved-model" })).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Test" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Test" }));
  await screen.findByText("Working. 1 model found; nothing was saved.");
  expect(api.testApiConnection).toHaveBeenCalledWith(
    connection.base_url,
    null,
    "remote",
  );
  expect(screen.getByRole("option", { name: "local-model" })).toBeTruthy();
  // A listed model never replaces the one the task already uses.
  expect(screen.getByLabelText("Model")).toHaveProperty("value", "saved-model");
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
  await userEvent.selectOptions(screen.getByLabelText("Model"), other());
  await userEvent.clear(screen.getByLabelText("Model ID"));
  await userEvent.type(screen.getByLabelText("Model ID"), "chat-custom");
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

it("keeps a manual model after a failed test and blocks a stale destination", async () => {
  vi.mocked(api.testApiConnection).mockRejectedValue(
    new Error("Test unavailable"),
  );
  render(<ConnectionEditor {...props()} />);
  await userEvent.selectOptions(screen.getByLabelText("Model"), other());
  await userEvent.clear(screen.getByLabelText("Model ID"));
  await userEvent.type(screen.getByLabelText("Model ID"), "manual-model");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Test" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Test" }));
  expect(await screen.findByText(/^Not working$/)).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe(
    "Nothing was saved: the check did not finish, so check the URL and key, then Test again.",
  );
  // A failed test leaves the ID the user typed alone.
  expect(screen.getByLabelText("Model ID")).toHaveProperty(
    "value",
    "manual-model",
  );
  // A URL that no longer matches the saved connection needs its own key first.
  await userEvent.type(screen.getByLabelText("Base URL"), "/other");
  expect(screen.getByRole("button", { name: "Test" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(
    screen.getByRole("button", { name: "Test" }).getAttribute("title"),
  ).toBe("Enter the key for the new URL.");
  expect(
    screen.getByRole("button", { name: "Delete connection" }),
  ).toHaveProperty("disabled", true);
});

it("discards a test result from an older connection revision", async () => {
  let finish: (value: ProviderModel[]) => void = () => {};
  vi.mocked(api.testApiConnection).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const input = props();
  const view = render(<ConnectionEditor {...input} />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Test" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Test" }));
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
  expect(screen.queryByRole("option", { name: "old-model" })).toBeNull();
  expect(screen.getByLabelText("Model")).toHaveProperty("value", "saved-model");
  // Nor does its success notice: it described a revision no longer on screen.
  expect(screen.queryByText(/^Working\./)).toBeNull();
});

it("clears a typed key but keeps the model draft after a revision-only update", async () => {
  const input = props();
  const view = render(<ConnectionEditor {...input} />);
  await userEvent.type(screen.getByLabelText("API key"), "synthetic-key");
  await userEvent.selectOptions(screen.getByLabelText("Model"), other());
  await userEvent.clear(screen.getByLabelText("Model ID"));
  await userEvent.type(screen.getByLabelText("Model ID"), "keep-this-draft");
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

it("offers tested model IDs for the task it serves", async () => {
  vi.mocked(api.testApiConnection).mockResolvedValue([{ id: "fetched-model" }]);
  render(<ConnectionEditor {...props()} />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Test" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Test" }));
  expect(
    await screen.findByRole("option", { name: "fetched-model" }),
  ).toBeTruthy();
});

it("offers no local server choice for AI notes and shows no leaving-the-device tag", () => {
  render(<ConnectionEditor {...props()} />);
  expect(screen.queryByRole("group", { name: "AI connection" })).toBeNull();
  expect(screen.queryByText(/Local server/)).toBeNull();
  expect(screen.queryByText("Leaves this device")).toBeNull();
  expect(screen.getByLabelText("Base URL")).toHaveProperty(
    "placeholder",
    "https://api.example.com/v1",
  );
});

/** A brand-new role: nothing saved, nothing assigned. */
const fresh: Settings = {
  ...settings,
  saved_connections: [],
  provider_assignments: { llm: null, cloud_stt: null },
  llm: null,
};

/** The editor as App mounts it: saved settings come back down as props. */
function Harness({ start }: { start: Settings }) {
  const [live, setLive] = useState(start);
  return (
    <ConnectionEditor
      role="llm"
      settings={live}
      active
      disabled={false}
      onSaved={setLive}
      onKeyStatus={vi.fn()}
    />
  );
}

const openAi = {
  id: "new-openai",
  name: "OpenAI",
  base_url: "https://api.openai.com/v1",
  revision: 1,
};

it("puts the provider first for a new connection and hides the preset URL", () => {
  render(<ConnectionEditor {...props(fresh)} />);
  const boxes = screen.getAllByRole("combobox");
  expect(boxes[0].getAttribute("aria-label")).toBe("Provider");
  expect(boxes[1].getAttribute("aria-label")).toBe("Saved connection");
  expect(
    screen.getAllByRole("option").map((option) => option.textContent),
  ).toContain("OpenAI");
  expect(
    within(screen.getByLabelText("Provider"))
      .getAllByRole("option")
      .map((option) => option.textContent),
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
  // The preset brings its own URL, so there is nothing to type.
  expect(screen.queryByLabelText("Base URL")).toBeNull();
  expect(screen.getByLabelText("Connection name")).toHaveProperty(
    "value",
    "OpenAI",
  );
  expect(screen.getByLabelText("API key").getAttribute("placeholder")).toBe(
    "Key from platform.openai.com",
  );
  // The hint names the host; no badge says where the data goes.
  expect(screen.getByText("api.openai.com")).toBeTruthy();
  expect(screen.queryByText("Leaves this device")).toBeNull();
});

it("offers only the speech providers for cloud transcription", () => {
  render(<ConnectionEditor {...props(fresh)} role="cloud_stt" />);
  expect(
    within(screen.getByLabelText("Provider"))
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["OpenAI", "Groq", "Custom"]);
});

it("reveals a free-text model ID only for Other… and saves the typed id", async () => {
  render(<ConnectionEditor {...props()} />);
  expect(screen.queryByLabelText("Model ID")).toBeNull();
  await userEvent.selectOptions(screen.getByLabelText("Model"), other());
  expect(screen.getByLabelText("Model ID")).toHaveProperty(
    "value",
    "saved-model",
  );
  // Choosing a listed model again puts the free-text field away.
  await userEvent.selectOptions(screen.getByLabelText("Model"), "saved-model");
  expect(screen.queryByLabelText("Model ID")).toBeNull();
  await userEvent.selectOptions(screen.getByLabelText("Model"), other());
  const id = screen.getByLabelText("Model ID");
  await userEvent.clear(id);
  await userEvent.type(id, "chat-custom");
  expect(screen.getByLabelText("Model")).toHaveProperty("value", "__other__");
  expect(id).toHaveProperty("value", "chat-custom");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(api.saveProviderAssignment).toHaveBeenCalledWith(
      "llm",
      { kind: "assigned", connection_id: "remote", model: "chat-custom" },
      1,
    ),
  );
});

it("tests a new connection with the typed key and offers what it finds", async () => {
  vi.mocked(api.testApiConnection).mockResolvedValue([
    { id: "whisper-1" },
    { id: "gpt-4o" },
  ]);
  render(<ConnectionEditor {...props(fresh)} />);
  const key = screen.getByLabelText("API key");
  await userEvent.type(key, "typed-key");
  // With no model and no list yet, the menu says how to get one.
  expect(
    screen.getByRole("option", { name: "Test to load models" }),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Test" }));
  await screen.findByText("Working. 1 model found; nothing was saved.");
  // A new connection has no saved key to fall back on, and nothing is stored.
  expect(api.testApiConnection).toHaveBeenCalledWith(
    "https://api.openai.com/v1",
    "typed-key",
    null,
  );
  expect(api.saveApiConnection).not.toHaveBeenCalled();
  expect(screen.getByText("Working")).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByLabelText("Model")).toHaveProperty("value", "gpt-4o"),
  );
  expect(screen.getByRole("option", { name: "gpt-4o" })).toBeTruthy();
  // A speech model is not offered for AI notes, and nothing is assigned yet.
  expect(screen.queryByRole("option", { name: "whisper-1" })).toBeNull();
  expect(api.saveProviderAssignment).not.toHaveBeenCalled();
  // Only Save clears the typed key.
  expect(key).toHaveProperty("value", "typed-key");
});

it("tests a saved connection with its saved key", async () => {
  render(<ConnectionEditor {...props()} />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Test" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Test" }));
  await waitFor(() =>
    expect(api.testApiConnection).toHaveBeenCalledWith(
      connection.base_url,
      null,
      "remote",
    ),
  );
  expect(
    await screen.findByText("Working. 0 models found; nothing was saved."),
  ).toBeTruthy();
  expect(screen.getByText("Working")).toBeTruthy();
  expect(api.saveApiConnection).not.toHaveBeenCalled();
});

it("asks for a URL before Test can check anything", async () => {
  render(<ConnectionEditor {...props(fresh)} />);
  await userEvent.selectOptions(screen.getByLabelText("Provider"), "custom");
  const test = () => screen.getByRole("button", { name: "Test" });
  expect(screen.getByLabelText("Base URL")).toHaveProperty("value", "");
  expect(test()).toHaveProperty("disabled", true);
  expect(test().getAttribute("title")).toBe("Enter a valid URL first.");
  await userEvent.type(
    screen.getByLabelText("Base URL"),
    "provider.example/v1",
  );
  expect(test()).toHaveProperty("disabled", true);
  expect(test().getAttribute("title")).toBe("Enter a valid URL first.");
  // A loopback server needs no key.
  await userEvent.clear(screen.getByLabelText("Base URL"));
  await userEvent.type(
    screen.getByLabelText("Base URL"),
    "http://127.0.0.1:1234/v1",
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(test()).toHaveProperty("disabled", false);
});

it("asks for a key on a remote connection that has none", async () => {
  vi.mocked(api.apiConnectionKeyStatus).mockResolvedValue("missing");
  render(<ConnectionEditor {...props()} />);
  await waitFor(() =>
    expect(api.apiConnectionKeyStatus).toHaveBeenCalledWith("remote"),
  );
  const test = screen.getByRole("button", { name: "Test" });
  expect(test).toHaveProperty("disabled", true);
  expect(test.getAttribute("title")).toBe("Enter the API key first.");
  // Typing a key is enough to test with, without saving it.
  await userEvent.type(screen.getByLabelText("API key"), "typed-key");
  expect(screen.getByRole("button", { name: "Test" })).toHaveProperty(
    "disabled",
    false,
  );
});

it("blocks removing a saved key while the connection has unsaved edits", async () => {
  render(<ConnectionEditor {...props()} />);
  const remove = () => screen.getByRole("button", { name: "Remove key" });
  await waitFor(() => expect(screen.getByText(/^Key saved/)).toBeTruthy());
  expect(remove()).toHaveProperty("disabled", false);
  await userEvent.type(screen.getByLabelText("Connection name"), " edited");
  expect(remove()).toHaveProperty("disabled", true);
  expect(remove().getAttribute("title")).toBe("Save the connection first.");
});

it("switches to a free name and the provider URL, and drops the old key", async () => {
  const taken: Settings = {
    ...fresh,
    saved_connections: [
      {
        id: "saved-groq",
        name: "Groq",
        base_url: "https://api.groq.com/openai/v1",
        revision: 1,
      },
    ],
  };
  vi.mocked(api.saveApiConnection).mockResolvedValue({
    ...taken,
    saved_connections: [
      ...taken.saved_connections,
      {
        id: "new-groq",
        name: "Groq 2",
        base_url: "https://api.groq.com/openai/v1",
        revision: 1,
      },
    ],
  });
  render(<Harness start={taken} />);
  const key = screen.getByLabelText("API key");
  await userEvent.type(key, "synthetic-key");
  await userEvent.selectOptions(screen.getByLabelText("Provider"), "groq");
  // The typed key belonged to the previous destination.
  expect(key).toHaveProperty("value", "");
  expect(screen.getByLabelText("Connection name")).toHaveProperty(
    "value",
    "Groq 2",
  );
  expect(key.getAttribute("placeholder")).toBe("Key from console.groq.com");
  await userEvent.type(key, "synthetic-key");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(api.saveApiConnection).toHaveBeenCalledWith({
      id: null,
      name: "Groq 2",
      baseUrl: "https://api.groq.com/openai/v1",
      keyChange: { kind: "replace", key: "synthetic-key" },
      expectedRevision: null,
    }),
  );
});

it("shows the URL field for Custom and names a blank connection by its host", async () => {
  vi.mocked(api.saveApiConnection).mockResolvedValue({
    ...fresh,
    saved_connections: [
      {
        id: "new-custom",
        name: "provider.example",
        base_url: "https://provider.example/v1",
        revision: 1,
      },
    ],
  });
  render(<Harness start={fresh} />);
  await userEvent.selectOptions(screen.getByLabelText("Provider"), "custom");
  const url = screen.getByLabelText("Base URL");
  expect(url).toHaveProperty("value", "");
  expect(screen.getByLabelText("API key").getAttribute("placeholder")).toBe(
    null,
  );
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByText("Enter a URL.")).toBeTruthy();
  await userEvent.type(url, "provider.example/v1");
  expect(screen.getByRole("alert").textContent).toBe(
    "Use a full URL like https://api.example.com/v1.",
  );
  await userEvent.clear(url);
  await userEvent.type(url, "https://provider.example/v1");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(api.saveApiConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "provider.example",
        baseUrl: "https://provider.example/v1",
      }),
    ),
  );
});

it("saves a new connection and its model in one Save, after Test fills the list", async () => {
  vi.mocked(api.saveApiConnection).mockResolvedValue({
    ...fresh,
    saved_connections: [openAi],
  });
  vi.mocked(api.testApiConnection).mockResolvedValue([
    { id: "whisper-1" },
    { id: "gpt-4o" },
  ]);
  vi.mocked(api.listApiConnectionModels).mockResolvedValue([{ id: "gpt-4o" }]);
  render(<Harness start={fresh} />);
  await userEvent.type(screen.getByLabelText("API key"), "typed-key");
  // Test lists models with the typed key and stores nothing.
  await userEvent.click(screen.getByRole("button", { name: "Test" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Model")).toHaveProperty("value", "gpt-4o"),
  );
  expect(api.saveApiConnection).not.toHaveBeenCalled();
  // One Save stores the connection, then the task that uses it, in that order.
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved on this device. No meeting content was sent.");
  expect(api.saveApiConnection).toHaveBeenCalledWith({
    id: null,
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyChange: { kind: "replace", key: "typed-key" },
    expectedRevision: null,
  });
  expect(api.saveProviderAssignment).toHaveBeenCalledWith(
    "llm",
    { kind: "assigned", connection_id: "new-openai", model: "gpt-4o" },
    null,
  );
  expect(
    vi.mocked(api.saveApiConnection).mock.invocationCallOrder[0],
  ).toBeLessThan(
    vi.mocked(api.saveProviderAssignment).mock.invocationCallOrder[0],
  );
  expect(api.listApiConnectionModels).not.toHaveBeenCalled();
});

it("says what to do for each failed Test, and that nothing was saved", async () => {
  const cases: [string, string][] = [
    [
      "provider_unauthorized",
      "Nothing was saved: the provider rejected this key, so check it for typos and Test again.",
    ],
    [
      "provider_unreachable",
      "Nothing was saved: the address did not answer, so check the URL and your connection, then Test again.",
    ],
    [
      "provider_models",
      "Nothing was saved: the provider's model list was not usable, so type a model ID under Other… instead.",
    ],
    [
      "provider_rate_limited",
      "Nothing was saved: the provider is rate limiting, so wait a minute and Test again.",
    ],
  ];
  for (const [code, sentence] of cases) {
    vi.mocked(api.testApiConnection).mockRejectedValueOnce(
      Object.assign(new Error("raw backend text"), { code }),
    );
    const view = render(<ConnectionEditor {...props()} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Test" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Test" }));
    expect((await screen.findByRole("alert")).textContent).toBe(sentence);
    expect(screen.getByText("Not working")).toBeTruthy();
    view.unmount();
  }
  expect(api.saveApiConnection).not.toHaveBeenCalled();
  expect(api.saveProviderAssignment).not.toHaveBeenCalled();
});

it("says a saved key is kept until a new one is typed", async () => {
  render(<ConnectionEditor {...props()} />);
  expect(
    await screen.findByText("Key saved. Type a new key to replace it."),
  ).toBeTruthy();
  expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
});

it("confirms before deleting a connection, inline, and Escape cancels", async () => {
  vi.mocked(api.deleteApiConnection).mockResolvedValue(settings);
  const unassigned: Settings = {
    ...settings,
    provider_assignments: { llm: null, cloud_stt: null },
  };
  const confirm = vi.spyOn(window, "confirm");
  render(<ConnectionEditor {...props(unassigned)} />);
  // Nothing is assigned, so the editor opens on a new connection: pick the saved one.
  await userEvent.selectOptions(
    screen.getByLabelText("Saved connection"),
    "remote",
  );
  await userEvent.click(
    screen.getByText("More options", { selector: "summary" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Delete connection" }),
  );
  // The question is on the card, with its own Cancel and Delete. No browser dialog.
  const group = screen.getByRole("group", { name: "Confirm delete" });
  expect(
    within(group).getByText("Delete Remote? Its key is removed too."),
  ).toBeTruthy();
  expect(confirm).not.toHaveBeenCalled();
  expect(api.deleteApiConnection).not.toHaveBeenCalled();
  // Escape cancels and does nothing else.
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("group", { name: "Confirm delete" })).toBeNull();
  expect(api.deleteApiConnection).not.toHaveBeenCalled();
  // Cancel button also backs out.
  await userEvent.click(
    screen.getByRole("button", { name: "Delete connection" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("group", { name: "Confirm delete" })).toBeNull();
  expect(api.deleteApiConnection).not.toHaveBeenCalled();
  // Only the Delete button in the row removes it.
  await userEvent.click(
    screen.getByRole("button", { name: "Delete connection" }),
  );
  await userEvent.click(
    within(screen.getByRole("group", { name: "Confirm delete" })).getByRole(
      "button",
      { name: "Delete" },
    ),
  );
  await waitFor(() =>
    expect(api.deleteApiConnection).toHaveBeenCalledWith("remote", 1),
  );
  confirm.mockRestore();
});

it("keeps the Save button disabled for an empty new connection", async () => {
  render(<ConnectionEditor {...props(fresh)} />);
  // Custom with no URL and no key is the empty case: nothing to save.
  await userEvent.selectOptions(screen.getByLabelText("Provider"), "custom");
  const save = screen.getByRole("button", { name: "Save" });
  expect(save).toHaveProperty("disabled", true);
  expect(save.getAttribute("title")).toBe("Enter a URL first.");
});

it("saves a new connection without a model, then offers its models", async () => {
  vi.mocked(api.saveApiConnection).mockResolvedValue({
    ...fresh,
    saved_connections: [openAi],
  });
  vi.mocked(api.listApiConnectionModels).mockResolvedValue([
    { id: "whisper-1" },
    { id: "gpt-4o" },
  ]);
  vi.mocked(api.saveProviderAssignment).mockResolvedValue({
    ...fresh,
    saved_connections: [openAi],
    provider_assignments: {
      llm: { connection_id: "new-openai", model: "gpt-4o", revision: 1 },
      cloud_stt: null,
    },
  });
  render(<Harness start={fresh} />);
  await userEvent.type(screen.getByLabelText("API key"), "synthetic-key");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved on this device. No meeting content was sent.");
  // The first listed chat model is assigned in the same click; a speech model never is.
  expect(api.saveApiConnection).toHaveBeenCalledWith({
    id: null,
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyChange: { kind: "replace", key: "synthetic-key" },
    expectedRevision: null,
  });
  expect(api.listApiConnectionModels).toHaveBeenCalledWith("new-openai", 1);
  expect(api.saveProviderAssignment).toHaveBeenCalledWith(
    "llm",
    { kind: "assigned", connection_id: "new-openai", model: "gpt-4o" },
    null,
  );
  expect(screen.getByLabelText("Model")).toHaveProperty("value", "gpt-4o");
  expect(screen.queryByRole("option", { name: "whisper-1" })).toBeNull();
});

it("keeps the saved connection when the automatic model listing fails", async () => {
  vi.mocked(api.saveApiConnection).mockResolvedValue({
    ...fresh,
    saved_connections: [openAi],
  });
  vi.mocked(api.listApiConnectionModels).mockRejectedValue(
    new Error("Discovery unavailable"),
  );
  render(<Harness start={fresh} />);
  await userEvent.type(screen.getByLabelText("API key"), "synthetic-key");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Discovery unavailable",
  );
  expect(api.saveApiConnection).toHaveBeenCalledTimes(1);
  expect(api.saveProviderAssignment).not.toHaveBeenCalled();
  expect(screen.getByRole("option", { name: "OpenAI" })).toBeTruthy();
});

it("saves a remote connection without a key but does not list its models", async () => {
  vi.mocked(api.apiConnectionKeyStatus).mockResolvedValue("missing");
  vi.mocked(api.saveApiConnection).mockResolvedValue({
    ...fresh,
    saved_connections: [openAi],
  });
  render(<Harness start={fresh} />);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(
    await screen.findByText("Saved. Add the key, then Test to load models."),
  ).toBeTruthy();
  expect(api.saveApiConnection).toHaveBeenCalledTimes(1);
  expect(api.listApiConnectionModels).not.toHaveBeenCalled();
  expect(api.testApiConnection).not.toHaveBeenCalled();
  expect(api.saveProviderAssignment).not.toHaveBeenCalled();
  // The card says why no model was listed: there is no key to test with yet.
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Test" }).getAttribute("title"),
    ).toBe("Enter the API key first."),
  );
  expect(screen.getByText("No key")).toBeTruthy();
});

it("never assigns a task to an empty model", async () => {
  render(<ConnectionEditor {...props()} />);
  // An empty model can only come from Other… with nothing typed.
  await userEvent.selectOptions(screen.getByLabelText("Model"), other());
  await userEvent.clear(screen.getByLabelText("Model ID"));
  expect(screen.getByLabelText("Model ID")).toHaveProperty("value", "");
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(api.saveProviderAssignment).not.toHaveBeenCalled();
});

it("shows the provider picker only while a new connection is being made", async () => {
  render(<ConnectionEditor {...props()} />);
  // A saved connection keeps its own URL and hides the picker.
  expect(screen.queryByLabelText("Provider")).toBeNull();
  expect(screen.getByLabelText("Base URL")).toBeTruthy();
  await userEvent.selectOptions(screen.getByLabelText("Saved connection"), "");
  expect(screen.getByLabelText("Provider")).toHaveProperty("value", "openai");
});

it("drops a Test result and its models as soon as the key is edited", async () => {
  vi.mocked(api.testApiConnection).mockResolvedValue([{ id: "fetched-model" }]);
  render(<ConnectionEditor {...props()} />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Test" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Test" }));
  expect(
    await screen.findByRole("option", { name: "fetched-model" }),
  ).toBeTruthy();
  expect(screen.getByText(/^Working\./)).toBeTruthy();
  await userEvent.type(screen.getByLabelText("API key"), "x");
  expect(screen.queryByRole("option", { name: "fetched-model" })).toBeNull();
  expect(screen.queryByText(/^Working\./)).toBeNull();
  expect(screen.queryByText("Working")).toBeNull();
});

it("discards a Test that a key edit overtakes while it is in flight", async () => {
  let finish: (value: ProviderModel[]) => void = () => {};
  vi.mocked(api.testApiConnection).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<ConnectionEditor {...props()} />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Test" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Test" }));
  // The key field is locked while Test runs; an edit that lands anyway must still win.
  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: "x" },
  });
  await act(async () => finish([{ id: "old-model" }]));
  expect(screen.queryByRole("option", { name: "old-model" })).toBeNull();
  expect(screen.queryByText(/^Working\./)).toBeNull();
  expect(screen.queryByText("Working")).toBeNull();
});
