import { mockApiModule } from "./test/api-mock";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type MeetingDetail, type Settings } from "./lib/api";
import {
  sample,
  textPlan,
  initialSettings,
  ready,
  installDefaultMocks,
} from "./test/app-harness";

vi.mock("./lib/api", async (original) =>
  mockApiModule(await original<typeof import("./lib/api")>()),
);

beforeEach(installDefaultMocks);

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
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("tab", { name: "Connections" }));
    await userEvent.selectOptions(
      screen.getAllByLabelText("Saved connection")[0],
      "remote",
    );
    const key = screen.getAllByLabelText("API key")[0];
    await userEvent.type(key, "synthetic-key");
    await userEvent.click(
      screen.getByRole("button", { name: "Save connection" }),
    );
    await waitFor(() => expect(api.providerKeyStatus).toHaveBeenCalledTimes(4));
    expect(key).toHaveProperty("value", "");
    await act(async () => deliver("missing"));
    await userEvent.click(screen.getByRole("button", { name: "Close panel" }));
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    expect(
      screen.getByRole("button", { name: "Enhance notes" }),
    ).toHaveProperty("disabled", false);
  });

  it("keeps a connection draft across sections but clears its key", async () => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("tab", { name: "Connections" }));
    await userEvent.type(screen.getByLabelText("Connection name"), "Draft");
    await userEvent.type(screen.getByLabelText("API key"), "draft-key");
    await userEvent.click(screen.getByRole("tab", { name: "Recording" }));
    await userEvent.click(screen.getByRole("tab", { name: "Connections" }));
    expect(screen.getByLabelText("Connection name")).toHaveProperty(
      "value",
      "Draft",
    );
    expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
    expect(api.saveApiConnection).not.toHaveBeenCalled();
    expect(api.saveSttMode).not.toHaveBeenCalled();
    expect(api.listApiConnectionModels).not.toHaveBeenCalled();
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
      expect(screen.queryByText("0.0s")).toBeNull();
      expect(
        screen.getByText(
          /Generated with https:\/\/speech.example\/v1 \/ speech-model/,
        ),
      ).toBeTruthy();
      expect(api.audioPosition).not.toHaveBeenCalled();
    });

    it("removes sample and simulation creation while retaining historical labels", async () => {
      await ready();
      expect(
        screen.queryByRole("button", { name: "Load fictional sample" }),
      ).toBeNull();
      expect(screen.getAllByText("Fictional sample").length).toBeGreaterThan(0);
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
