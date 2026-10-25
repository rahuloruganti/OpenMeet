import { mockApiModule } from "../shared/test/api-mock";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type MeetingDetail, type Settings } from "../shared/api/api";
import {
  sample,
  textPlan,
  initialSettings,
  ready,
  installDefaultMocks,
} from "../shared/test/app-harness";

vi.mock("../shared/api/api", async (original) =>
  mockApiModule(await original<typeof import("../shared/api/api")>()),
);

beforeEach(() => {
  installDefaultMocks();
  // The transcription section looks for model files already on this PC.
  vi.mocked(api.scanLocalModels).mockResolvedValue({
    models: [],
    folders: [],
    truncated: false,
  });
});

/** One entry of the Settings index: every section is on the page, the index scrolls to one. */
const settingsIndex = (name: string) =>
  within(
    screen.getByRole("navigation", { name: "Settings sections" }),
  ).getByRole("button", {
    name: (accessible) =>
      accessible === name || accessible.startsWith(`${name}, needs you:`),
  });

/** The AI notes section: Connections merged into the place they are used. */
async function openAiNotes() {
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  await userEvent.click(settingsIndex("AI notes"));
  // Connections are the "With a connection" path; a PC-only setup opens its own first.
  await userEvent.click(
    within(screen.getByRole("group", { name: "Notes written" })).getByRole(
      "button",
      { name: /^With a connection/ },
    ),
  );
  return within(screen.getByRole("region", { name: "AI notes" }));
}

describe("saved connections and provider workflows", () => {
  it("ignores startup key status that arrives after saving a reusable connection", async () => {
    let deliver: (status: "missing") => void = () => {};
    vi.mocked(api.providerKeyStatus)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          deliver = resolve;
        }),
      )
      .mockResolvedValue("present");
    const saved = {
      id: "remote",
      name: "Remote",
      base_url: textPlan.base_url,
      revision: 1,
    };
    const connected: Settings = {
      ...initialSettings,
      saved_connections: [saved],
      provider_assignments: {
        llm: { connection_id: saved.id, model: "chat", revision: 1 },
        cloud_stt: null,
      },
      llm: { base_url: saved.base_url, model: "chat", revision: 1 },
    };
    vi.mocked(api.getSettings).mockResolvedValue(connected);
    vi.mocked(api.saveApiConnection).mockResolvedValue({
      ...connected,
      saved_connections: [{ ...saved, revision: 2 }],
    });
    await ready();
    const pane = await openAiNotes();
    await userEvent.selectOptions(
      pane.getByLabelText("Saved connection"),
      "remote",
    );
    const key = pane.getByLabelText("API key");
    await userEvent.type(key, "synthetic-key");
    await userEvent.click(pane.getByRole("button", { name: "Save" }));
    // Startup reads each role twice; one save re-reads both once.
    await waitFor(() => expect(api.providerKeyStatus).toHaveBeenCalledTimes(6));
    // A key is never read back into the field.
    expect(key).toHaveProperty("value", "");
    await act(async () => deliver("missing"));
    await userEvent.click(
      screen.getByRole("button", { name: "Back to Meetings" }),
    );
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    expect(
      screen.getByRole("button", { name: "Create summary" }),
    ).toHaveProperty("disabled", false);
  });

  it("keeps a connection draft and its typed key when another section is picked", async () => {
    await ready();
    const pane = await openAiNotes();
    // Every section is on one page now; the index marks where the view is, it hides nothing.
    for (const name of [
      "General",
      "Recording",
      "Transcription",
      "AI notes",
      "Export & storage",
      "Privacy & about",
    ])
      expect(screen.getByRole("region", { name })).toBeTruthy();
    const index = within(
      screen.getByRole("navigation", { name: "Settings sections" }),
    );
    expect(
      index
        .getAllByRole("button", { current: "location" })
        .map((entry) => entry.querySelector(":scope > span")?.textContent),
    ).toEqual(["AI notes"]);
    const editor = within(
      pane.getByRole("region", { name: "AI notes connection" }),
    );
    await userEvent.click(
      editor.getByText("More options", { selector: "summary" }),
    );
    await userEvent.clear(editor.getByLabelText("Connection name"));
    await userEvent.type(editor.getByLabelText("Connection name"), "Draft");
    await userEvent.type(editor.getByLabelText("API key"), "draft-key");
    // Nothing is hidden any more: the index moves the view, and the editor stays on the page.
    await userEvent.click(settingsIndex("Recording"));
    expect(settingsIndex("Recording").getAttribute("aria-current")).toBe(
      "location",
    );
    await userEvent.click(settingsIndex("AI notes"));
    expect(settingsIndex("AI notes").getAttribute("aria-current")).toBe(
      "location",
    );
    expect(editor.getByLabelText("Connection name")).toHaveProperty(
      "value",
      "Draft",
    );
    // The typed key is not lost by scrolling to another section, and it is still never shown,
    // saved or read back.
    const key = editor.getByLabelText("API key") as HTMLInputElement;
    expect(key).toHaveProperty("value", "draft-key");
    expect(key.type).toBe("password");
    expect(api.saveApiConnection).not.toHaveBeenCalled();
    expect(api.saveSttMode).not.toHaveBeenCalled();
    expect(api.listApiConnectionModels).not.toHaveBeenCalled();
    expect(api.apiConnectionKeyStatus).not.toHaveBeenCalled();
  });

  it("checks the API base URL before saving and says why each button is unavailable", async () => {
    await ready();
    const pane = await openAiNotes();
    const editor = within(
      pane.getByRole("region", { name: "AI notes connection" }),
    );
    await userEvent.click(
      editor.getByText("More options", { selector: "summary" }),
    );
    // A new connection starts on a provider, so its URL is already valid; the
    // only thing missing before Test can check it is the key.
    expect(editor.queryByText("Enter a URL.")).toBeNull();
    expect(editor.queryByLabelText("Base URL")).toBeNull();
    const test = () => editor.getByRole("button", { name: "Test" });
    expect(test()).toHaveProperty("disabled", true);
    expect(test().getAttribute("title")).toBe("Enter the API key first.");
    const remove = editor.getByRole("button", { name: "Remove key" });
    expect(remove).toHaveProperty("disabled", true);
    expect(remove.getAttribute("title")).toBe("No saved key to remove.");
    // Custom is the only path where a URL is typed, so it is the only one to check.
    await userEvent.selectOptions(editor.getByLabelText("Provider"), "custom");
    expect(editor.getByText("Enter a URL.")).toBeTruthy();
    expect(editor.getByRole("button", { name: "Save" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(test()).toHaveProperty("disabled", true);
    expect(test().getAttribute("title")).toBe("Enter a valid URL first.");
    const url = editor.getByLabelText("Base URL");
    await userEvent.type(url, "provider.example/v1");
    expect(editor.getByRole("alert").textContent).toBe(
      "Use a full URL like https://api.example.com/v1.",
    );
    expect(editor.getByRole("button", { name: "Save" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(test()).toHaveProperty("disabled", true);
    await userEvent.clear(url);
    await userEvent.type(url, "http://provider.example/v1");
    expect(editor.getByRole("alert").textContent).toBe(
      "Use https, or http on localhost, without credentials or a query.",
    );
    expect(test()).toHaveProperty("disabled", true);
    await userEvent.clear(url);
    await userEvent.type(url, "https://user@provider.example/v1?key=1");
    expect(editor.getByRole("alert").textContent).toBe(
      "Use https, or http on localhost, without credentials or a query.",
    );
    expect(test()).toHaveProperty("disabled", true);
    await userEvent.clear(url);
    await userEvent.type(url, "http://127.0.0.1:1234/v1");
    expect(editor.queryByRole("alert")).toBeNull();
    // A new connection saves without a model; the task still needs one.
    expect(editor.getByRole("button", { name: "Save" })).toHaveProperty(
      "disabled",
      false,
    );
    // A loopback server needs no key, so Test can check it straight away.
    expect(test()).toHaveProperty("disabled", false);
    expect(editor.queryByText("Enter a URL.")).toBeNull();
  });

  it("creates a connection from a preset without a model and offers its models", async () => {
    const saved = {
      id: "openai",
      name: "OpenAI",
      base_url: "https://api.openai.com/v1",
      revision: 1,
    };
    vi.mocked(api.saveApiConnection).mockResolvedValue({
      ...initialSettings,
      saved_connections: [saved],
    });
    vi.mocked(api.listApiConnectionModels).mockResolvedValue([
      { id: "tts-1" },
      { id: "gpt-4o" },
    ]);
    vi.mocked(api.saveProviderAssignment).mockResolvedValue({
      ...initialSettings,
      saved_connections: [saved],
      provider_assignments: {
        ...initialSettings.provider_assignments,
        llm: { connection_id: "openai", model: "gpt-4o", revision: 1 },
      },
    });
    await ready();
    const pane = await openAiNotes();
    const editor = within(
      pane.getByRole("region", { name: "AI notes connection" }),
    );
    await userEvent.type(editor.getByLabelText("API key"), "synthetic-key");
    await userEvent.click(editor.getByRole("button", { name: "Save" }));
    expect(
      await editor.findByText(
        "Saved on this device. No meeting content was sent.",
      ),
    ).toBeTruthy();
    expect(api.saveApiConnection).toHaveBeenCalledWith({
      id: null,
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      keyChange: { kind: "replace", key: "synthetic-key" },
      expectedRevision: null,
    });
    // One Save also assigns the first chat model the provider lists.
    expect(api.saveProviderAssignment).toHaveBeenCalledWith(
      "llm",
      { kind: "assigned", connection_id: "openai", model: "gpt-4o" },
      null,
    );
    expect(editor.getByLabelText("Model")).toHaveProperty("value", "gpt-4o");
  });

  it("explains the key rules and the unavailable reasons for a saved remote connection", async () => {
    const saved = {
      id: "remote",
      name: "Remote",
      base_url: textPlan.base_url,
      revision: 1,
    };
    vi.mocked(api.getSettings).mockResolvedValue({
      ...initialSettings,
      saved_connections: [saved],
    });
    vi.mocked(api.apiConnectionKeyStatus).mockResolvedValue("missing");
    await ready();
    const pane = await openAiNotes();
    const editor = within(
      pane.getByRole("region", { name: "AI notes connection" }),
    );
    await userEvent.selectOptions(
      pane.getByLabelText("Saved connection"),
      "remote",
    );
    // A remote connection with no saved key says so, and Test says why it waits.
    const test = () => editor.getByRole("button", { name: "Test" });
    await waitFor(() =>
      expect(api.apiConnectionKeyStatus).toHaveBeenCalledWith("remote"),
    );
    expect(test()).toHaveProperty("disabled", true);
    expect(test().getAttribute("title")).toBe("Enter the API key first.");
    expect(editor.getByText("No key")).toBeTruthy();
    const remove = editor.getByRole("button", { name: "Remove key" });
    expect(remove).toHaveProperty("disabled", true);
    expect(remove.getAttribute("title")).toBe("No saved key to remove.");
    // A remote connection still says so up front, and the key is never shown.
    expect(editor.getByText("Leaves this device")).toBeTruthy();
    await userEvent.click(
      editor.getByText("More options", { selector: "summary" }),
    );
    await userEvent.type(editor.getByLabelText("Connection name"), " edited");
    // Still nothing to remove, and the card never asks for a name on its own.
    expect(
      editor.getByRole("button", { name: "Remove key" }).getAttribute("title"),
    ).toBe("No saved key to remove.");
    expect(editor.queryByText("Enter a name and a URL.")).toBeNull();
  });

  describe("provider workflows", () => {
    const recorded: MeetingDetail = {
      ...sample,

      meeting: { ...sample.meeting, source: "desktop" },

      summary: null,

      tracks: [
        {
          kind: "mic",

          path: "mic.wav",

          device_name: "Mic",

          sample_rate: 16000,

          frames: 16000,

          dropped_frames: 0,

          finalized: true,

          size_bytes: 32044,
        },
      ],
    };

    const cloudSettings: Settings = {
      ...initialSettings,

      llm: {
        base_url: "https://chat.example/v1",

        model: "chat-model",

        revision: 4,
      },

      cloud_stt: {
        base_url: "https://speech.example/v1",

        model: "speech-model",

        revision: 2,
      },

      stt_mode: "cloud",
    };

    it("uploads audio in cloud mode without requiring local downloads", async () => {
      vi.mocked(api.getSettings).mockResolvedValue(cloudSettings);
      vi.mocked(api.providerKeyStatus).mockResolvedValue("present");
      vi.mocked(api.getMeeting).mockResolvedValue(recorded);
      vi.mocked(api.transcribeMeeting).mockResolvedValue(undefined);
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      await userEvent.click(
        screen.getByRole("button", { name: "Transcribe audio" }),
      );
      await waitFor(() =>
        expect(api.transcribeMeeting).toHaveBeenCalledWith("sample"),
      );
      expect(api.sttInstall).not.toHaveBeenCalled();
      expect(screen.getByDisplayValue("Original notes")).toBeTruthy();
    });

    it("renders untimed cloud text without fabricated timestamps or seek controls", async () => {
      vi.mocked(api.getMeeting).mockResolvedValue({
        ...recorded,
        transcript_provider: "https://speech.example/v1",
        transcript_model: "speech-model",
        segments: [
          {
            speaker: "You",
            timing: { kind: "untimed" },
            text: "A text-only transcript.",
          },
        ],
      });
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      expect(screen.getByText("Untimed")).toBeTruthy();
      expect(screen.getByText(/A text-only transcript/)).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: /Play You from/ }),
      ).toBeNull();
      expect(screen.queryByText("[00:00]")).toBeNull();
      // The engine that produced the text is still named, so it can be checked.
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      expect(
        screen.getByText(
          /Transcribed with https:\/\/speech.example\/v1 \/ speech-model/,
        ),
      ).toBeTruthy();
      expect(api.audioPosition).not.toHaveBeenCalled();
    });

    it("removes sample and simulation creation while retaining historical labels", async () => {
      await ready();
      expect(
        screen.queryByRole("button", { name: "Load fictional sample" }),
      ).toBeNull();
      expect(screen.getAllByText("Sample").length).toBeGreaterThan(0);
      await userEvent.click(
        screen.getByRole("button", { name: "New recording" }),
      );
      expect(screen.queryByText("Try a simulation instead")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Start simulation" }),
      ).toBeNull();
    });
  });
});
