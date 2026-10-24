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

beforeEach(installDefaultMocks);

/** The AI notes section: Connections merged into the place they are used. */
async function openAiNotes() {
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  await userEvent.click(screen.getByRole("tab", { name: "AI notes" }));
  return within(screen.getByRole("tabpanel", { name: "AI notes" }));
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

  it("keeps a connection draft across sections but clears its key", async () => {
    await ready();
    const pane = await openAiNotes();
    const editor = within(
      pane.getByRole("region", { name: "AI notes connection" }),
    );
    await userEvent.click(
      editor.getByText("More options", { selector: "summary" }),
    );
    await userEvent.type(editor.getByLabelText("Connection name"), "Draft");
    await userEvent.type(editor.getByLabelText("API key"), "draft-key");
    await userEvent.click(screen.getByRole("tab", { name: "Recording" }));
    await userEvent.click(screen.getByRole("tab", { name: "AI notes" }));
    const back = within(screen.getByRole("tabpanel", { name: "AI notes" }));
    expect(back.getByLabelText("Connection name")).toHaveProperty(
      "value",
      "Draft",
    );
    expect(back.getByLabelText("API key")).toHaveProperty("value", "");
    expect(api.saveApiConnection).not.toHaveBeenCalled();
    expect(api.saveSttMode).not.toHaveBeenCalled();
    expect(api.listApiConnectionModels).not.toHaveBeenCalled();
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
    expect(screen.getByText("Enter a name and a URL.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Refresh models" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByText("Save the connection first.")).toBeTruthy();
    const remove = screen.getByRole("button", { name: "Remove key" });
    expect(remove).toHaveProperty("disabled", true);
    expect(remove.getAttribute("title")).toBe("No saved key to remove.");
    const url = screen.getByLabelText("Base URL");
    await userEvent.type(screen.getByLabelText("Connection name"), "Draft");
    await userEvent.type(url, "provider.example/v1");
    expect(screen.getByRole("alert").textContent).toBe(
      "Use a full URL like https://api.example.com/v1.",
    );
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty(
      "disabled",
      true,
    );
    await userEvent.clear(url);
    await userEvent.type(url, "http://provider.example/v1");
    expect(screen.getByRole("alert").textContent).toBe(
      "Use https, or http on localhost, without credentials or a query.",
    );
    await userEvent.clear(url);
    await userEvent.type(url, "https://user@provider.example/v1?key=1");
    expect(screen.getByRole("alert").textContent).toBe(
      "Use https, or http on localhost, without credentials or a query.",
    );
    await userEvent.clear(url);
    await userEvent.type(url, "http://127.0.0.1:1234/v1");
    expect(screen.queryByRole("alert")).toBeNull();
    // A connection still needs a model before it can be saved.
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty(
      "disabled",
      true,
    );
    await userEvent.type(screen.getByLabelText("Model"), "test-chat");
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.queryByText("Enter a name and a URL.")).toBeNull();
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
    expect(await screen.findByText("Add an API key first.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Refresh models" }),
    ).toHaveProperty("disabled", true);
    const remove = screen.getByRole("button", { name: "Remove key" });
    expect(remove).toHaveProperty("disabled", true);
    expect(remove.getAttribute("title")).toBe("No saved key to remove.");
    // A remote connection still says so up front, and the key is never shown.
    expect(pane.getByText("Leaves this device")).toBeTruthy();
    expect(pane.getByText("No key")).toBeTruthy();
    await userEvent.click(
      editor.getByText("More options", { selector: "summary" }),
    );
    await userEvent.type(screen.getByLabelText("Connection name"), " edited");
    expect(screen.getByText("Save the connection first.")).toBeTruthy();
    expect(screen.queryByText("Enter a name and a URL.")).toBeNull();
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
