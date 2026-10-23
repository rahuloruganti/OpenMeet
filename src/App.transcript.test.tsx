import { mockApiModule } from "./test/api-mock";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { api, type MeetingDetail, type Settings } from "./lib/api";
import {
  initialSettings,
  sample,
  ready,
  installDefaultMocks,
} from "./test/app-harness";

vi.mock("./lib/api", async (original) =>
  mockApiModule(await original<typeof import("./lib/api")>()),
);

beforeEach(installDefaultMocks);

describe("transcript and audio", () => {
  describe("desktop foundation", () => {
    const transcribed = {
      ...sample,

      segments: [
        {
          speaker: "You" as const,

          timing: { kind: "timed" as const, start_ms: 1000, end_ms: 2000 },

          text: "Persimon budget",
        },

        {
          speaker: "Others" as const,

          timing: { kind: "untimed" as const },

          text: "Agreed",
        },
      ],

      segment_meta: [
        { id: 11, original_text: null },

        { id: 12, original_text: "Agred" },
      ],

      transcript_versions: [
        {
          id: 3,

          provider: "whisper",

          model: "small",

          edited: true,

          segment_count: 1,
        },
      ],
    };

    it("keeps track paths in secondary transcript details", async () => {
      vi.mocked(api.getMeeting).mockResolvedValue({
        ...sample,
        tracks: [
          {
            kind: "mic",
            path: "fictional-mic.wav",
            device_name: "Fictional microphone",
            sample_rate: 48000,
            frames: 48000,
            dropped_frames: 0,
            finalized: true,
            size_bytes: null,
          },
        ],
      });
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      const details = screen
        .getByText("Audio track details")
        .closest("details");
      expect(details).toBeTruthy();
      expect(details?.open).toBe(false);
      expect(details?.textContent).toContain(
        "You (microphone): fictional-mic.wav",
      );
      await userEvent.click(screen.getByText("Audio track details"));
      expect(details?.open).toBe(true);
      expect(screen.getByText(/No transcript/)).toBeTruthy();
    });

    it("edits, reverts, and guards transcript segments and shows earlier transcripts", async () => {
      vi.mocked(api.getMeeting).mockResolvedValue(transcribed);
      vi.mocked(api.editSegment).mockRejectedValueOnce({
        code: "segment_conflict",
        message: "This transcript segment changed or no longer exists.",
      });
      vi.mocked(api.getTranscriptVersion).mockResolvedValue([
        {
          speaker: "You",
          timing: { kind: "untimed" },
          text: "Kept earlier words",
        },
      ]);
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      expect(screen.getByText("(edited)")).toBeTruthy();
      await userEvent.click(
        screen.getByRole("button", { name: "Edit segment at 00:01" }),
      );
      const input = screen.getByRole("textbox", {
        name: "Edit segment at 00:01",
      });
      await userEvent.clear(input);
      await userEvent.type(input, "Persimmon budget");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(api.editSegment).toHaveBeenCalledWith(
        "sample",
        11,
        "Persimon budget",
        "Persimmon budget",
      );
      expect(
        await screen.findByText(/changed or no longer exists/),
      ).toBeTruthy();
      expect(screen.getByDisplayValue("Persimmon budget")).toBeTruthy();
      act(() => vi.mocked(api.onCloseRequested).mock.calls[0][0]());
      expect(
        await screen.findByRole("button", {
          name: "Discard unsaved edits and quit",
        }),
      ).toBeTruthy();
      await userEvent.click(
        screen.getByRole("button", { name: "Keep working" }),
      );
      vi.mocked(api.editSegment).mockResolvedValue(undefined);
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() =>
        expect(
          screen.queryByRole("textbox", { name: "Edit segment at 00:01" }),
        ).toBeNull(),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Revert segment at Untimed" }),
      );
      expect(api.editSegment).toHaveBeenLastCalledWith(
        "sample",
        12,
        "Agreed",
        "Agred",
      );
      await userEvent.selectOptions(
        screen.getByRole("combobox", { name: "Earlier transcripts" }),
        "3",
      );
      expect(api.getTranscriptVersion).toHaveBeenCalledWith("sample", 3);
      expect(await screen.findByText(/Kept earlier words/)).toBeTruthy();
    });
  });

  describe("transcript and audio", () => {
    const recorded: MeetingDetail = {
      ...sample,

      meeting: { ...sample.meeting, source: "desktop" },

      summary: null,

      summary_provider: null,

      summary_model: null,

      segments: [
        {
          speaker: "Others",

          timing: { kind: "timed", start_ms: 8250, end_ms: 9000 },

          text: "After pause",
        },
      ],

      tracks: [
        {
          kind: "mic",

          path: "mic.wav",

          device_name: "Microphone",

          sample_rate: 16000,

          frames: 48000,

          dropped_frames: 0,

          finalized: true,

          size_bytes: null,
        },

        {
          kind: "system",

          path: "system.wav",

          device_name: "Speakers",

          sample_rate: 16000,

          frames: 48000,

          dropped_frames: 0,

          finalized: true,

          size_bytes: null,
        },
      ],
    };

    beforeEach(() => {
      vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);

      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
        () => {},
      );

      vi.mocked(api.audioSrc).mockImplementation((path) => `asset://${path}`);
    });

    it("links only summary and task times that match a stored segment, then opens and plays it", async () => {
      vi.mocked(api.getMeeting).mockResolvedValue({
        ...recorded,
        summary: "## Decisions\n- Moved the launch [0:08], budget [9:59]",
        summary_provider: "merge",
        summary_model: "m1",
        segment_meta: [{ id: 21, original_text: null }],
        action_items: [
          {
            id: 1,
            text: "Confirm launch [0:08]",
            owner: null,
            due_date: null,
            done: false,
            source: "summary",
            summary_id: 4,
          },
        ],
      });
      vi.mocked(api.audioPosition).mockResolvedValue(2250);
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
      expect(screen.getByText("(unverified)")).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "Open transcript at 9:59" }),
      ).toBeNull();
      const links = screen.getAllByRole("button", {
        name: "Open transcript at 0:08",
      });
      expect(links).toHaveLength(2);
      await userEvent.click(links[0]);
      await waitFor(() =>
        expect(
          screen
            .getByRole("tab", { name: "Transcript" })
            .getAttribute("aria-selected"),
        ).toBe("true"),
      );
      await waitFor(() =>
        expect(api.audioPosition).toHaveBeenCalledWith(
          "sample",
          "system",
          8250,
        ),
      );
      const segment = document.getElementById("segment-21");
      expect(segment?.className).toContain("highlighted-segment");
      expect(document.activeElement).toBe(segment);
    });

    it("opens a cited library-answer time in its meeting on the transcript", async () => {
      const other = {
        ...recorded,
        meeting: { ...recorded.meeting, id: "rec", title: "Recorded sync" },
      };
      const withMeta = {
        ...other,
        segment_meta: [{ id: 31, original_text: null }],
      };
      vi.mocked(api.listMeetings).mockResolvedValue([
        sample.meeting,
        other.meeting,
      ]);
      vi.mocked(api.getMeeting).mockImplementation(async (id) =>
        id === "rec" ? withMeta : sample,
      );
      vi.mocked(api.askLibrary).mockResolvedValue({
        id: 1,
        question: "What moved?",
        answer: "Moved [M1 0:08] and [M2 0:08].",
        provider: "https://provider.example/v1",
        model: "test-chat",
        meeting_ids: ["rec"],
      });
      vi.mocked(api.audioPosition).mockResolvedValue(2250);
      vi.mocked(api.providerKeyStatus).mockResolvedValue("present");
      vi.mocked(api.getSettings).mockResolvedValue({
        ...initialSettings,
        llm: {
          base_url: "https://provider.example/v1",
          model: "test-chat",
          revision: 1,
        },
      });
      await ready();
      await userEvent.click(
        screen.getByRole("button", { name: "Ask across meetings" }),
      );
      await userEvent.click(screen.getByLabelText(/Recorded sync/));
      await userEvent.type(screen.getByLabelText("Question"), "What moved?");
      await userEvent.click(screen.getByRole("button", { name: "Ask" }));
      expect(api.askLibrary).toHaveBeenCalledWith(["rec"], "What moved?");
      expect(await screen.findByText("(unverified)")).toBeTruthy();
      await userEvent.click(
        await screen.findByRole("button", {
          name: "Open Recorded sync at 0:08",
        }),
      );
      await waitFor(() =>
        expect(
          screen
            .getByRole("tab", { name: "Transcript" })
            .getAttribute("aria-selected"),
        ).toBe("true"),
      );
      expect(api.getMeeting).toHaveBeenLastCalledWith("rec");
      await waitFor(() =>
        expect(api.audioPosition).toHaveBeenCalledWith("rec", "system", 8250),
      );
      const segment = document.getElementById("segment-31");
      expect(segment?.className).toContain("highlighted-segment");
      expect(document.activeElement).toBe(segment);
      await userEvent.click(
        screen.getByRole("button", { name: "Ask across meetings" }),
      );
      expect(screen.getByLabelText("Library answer")).toBeTruthy();
    });

    it("seeks the speaker's track to the backend-mapped file time", async () => {
      vi.mocked(api.getMeeting).mockResolvedValue(recorded);
      vi.mocked(api.audioPosition).mockResolvedValue(2250);
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      const system = screen.getByLabelText(
        "Others (system audio)",
      ) as HTMLAudioElement;
      expect(system.getAttribute("src")).toBe("asset://system.wav");
      const play = screen.getByRole("button", {
        name: "Play Others from 00:08",
      });
      expect(play.textContent).toBe("[00:08]");
      await userEvent.click(play);
      expect(api.audioPosition).toHaveBeenCalledWith("sample", "system", 8250);
      await waitFor(() => expect(system.currentTime).toBe(2.25));
      expect(
        (screen.getByLabelText("You (microphone)") as HTMLAudioElement)
          .currentTime,
      ).toBe(0);
    });

    it("shows rejected timing and never plays a guessed timestamp", async () => {
      vi.mocked(api.getMeeting).mockResolvedValue(recorded);
      vi.mocked(api.audioPosition).mockRejectedValue({
        code: "audio_timing",
        message:
          "The audio timing index is incomplete. Originals and previous transcripts are unchanged.",
      });
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      await userEvent.click(
        screen.getByRole("button", { name: "Play Others from 00:08" }),
      );
      expect((await screen.findByRole("alert")).textContent).toContain(
        "The audio timing index is incomplete. Originals and previous transcripts are unchanged.",
      );
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
      const player = screen.getByLabelText("Others (system audio)");
      expect(player).toBeInstanceOf(HTMLAudioElement);
      if (!(player instanceof HTMLAudioElement))
        throw new Error("Expected an audio player");
      expect(player.currentTime).toBe(0);
    });

    it("reports a playback failure and pauses audio when leaving the transcript", async () => {
      vi.mocked(api.getMeeting).mockResolvedValue(recorded);
      vi.mocked(api.audioPosition).mockResolvedValue(2250);
      vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(
        new Error("Output unavailable"),
      );
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      await userEvent.click(
        screen.getByRole("button", { name: "Play Others from 00:08" }),
      );
      expect(await screen.findByRole("alert")).toHaveProperty(
        "textContent",
        "Audio could not play. Check your output device and try again.",
      );
      vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
      await userEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(2);
    });

    it("reports missing audio without a silent playback failure", async () => {
      vi.mocked(api.getMeeting).mockResolvedValue(recorded);
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      fireEvent.error(screen.getByLabelText("You (microphone)"));
      expect(screen.getByRole("alert").textContent).toBe(
        "An audio file could not be opened. It may have been moved or is incomplete.",
      );
    });

    it("jumps from a [mm:ss] note line to the audio", async () => {
      vi.mocked(api.getMeeting).mockResolvedValue({
        ...recorded,
        user_markdown: "Original notes\n[00:12] decision",
      });
      render(<App />);
      const editor = (await screen.findByDisplayValue(
        /\[00:12\] decision/,
      )) as HTMLTextAreaElement;
      await waitFor(() =>
        expect(
          (
            screen.getByRole("button", {
              name: "Jump to audio",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(false),
      );
      editor.setSelectionRange(0, 0);
      await userEvent.click(
        screen.getByRole("button", { name: "Jump to audio" }),
      );
      expect(screen.getByText(/Put the cursor on a line/)).toBeTruthy();
      editor.setSelectionRange(editor.value.length, editor.value.length);
      await userEvent.click(
        screen.getByRole("button", { name: "Jump to audio" }),
      );
      expect(
        screen
          .getByRole("tab", { name: "Transcript" })
          .getAttribute("aria-selected"),
      ).toBe("true");
      expect(
        (screen.getByLabelText("You (microphone)") as HTMLAudioElement)
          .currentTime,
      ).toBe(12);
      expect(api.audioPosition).not.toHaveBeenCalled();
    });

    it("inserts a backend-derived timestamp at the caret while recording", async () => {
      const live = {
        revision: 1,
        status: "recording" as const,
        meeting_id: "sample",
        source: "desktop",
        error: null,
        recording_offset_ms: 1000,
      };
      vi.mocked(api.getRecordingState)
        .mockResolvedValueOnce(live)
        .mockResolvedValue({ ...live, recording_offset_ms: 65_400 });
      await ready();
      const editor = screen.getByDisplayValue(
        "Original notes",
      ) as HTMLTextAreaElement;
      editor.setSelectionRange(0, 0);
      await userEvent.click(
        screen.getByRole("button", { name: "Insert timestamp" }),
      );
      await waitFor(() => expect(editor.value).toBe("[01:05] Original notes"));
      expect(
        screen.queryByRole("button", { name: "Jump to audio" }),
      ).toBeNull();
    });

    it("ignores the timestamp shortcut while another task is running", async () => {
      vi.mocked(api.getRecordingState).mockResolvedValue({
        revision: 1,
        status: "recording",
        meeting_id: "sample",
        source: "desktop",
        error: null,
        recording_offset_ms: 65_400,
      });
      let pickFolder: (value: Settings) => void = () => {};
      vi.mocked(api.chooseVaultFolder).mockReturnValue(
        new Promise<Settings>((resolve) => {
          pickFolder = resolve;
        }),
      );
      await ready();
      const editor = screen.getByDisplayValue(
        "Original notes",
      ) as HTMLTextAreaElement;
      await userEvent.click(
        screen.getByRole("button", { name: "Export Markdown" }),
      );
      await waitFor(() => expect(api.chooseVaultFolder).toHaveBeenCalledOnce());
      // Positive control: the timestamp control exists, and is disabled while busy.
      expect(
        (
          screen.getByRole("button", {
            name: "Insert timestamp",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      editor.setSelectionRange(0, 0);
      const before = vi.mocked(api.getRecordingState).mock.calls.length;
      fireEvent.keyDown(editor, { key: "T", ctrlKey: true, shiftKey: true });
      expect(api.getRecordingState).toHaveBeenCalledTimes(before);
      expect(editor.value).toBe("Original notes");
      await act(async () => pickFolder(initialSettings));
      await waitFor(() =>
        expect(
          (
            screen.getByRole("button", {
              name: "Insert timestamp",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(false),
      );
      // Positive control: once the task ends, the same shortcut inserts the stamp.
      fireEvent.keyDown(editor, { key: "T", ctrlKey: true, shiftKey: true });
      await waitFor(() => expect(editor.value).toBe("[01:05] Original notes"));
    });
  });
});
