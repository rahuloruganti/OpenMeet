import { mockApiModule } from "../shared/test/api-mock";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { api, type MeetingDetail, type Settings } from "../shared/api/api";
import {
  initialSettings,
  installed,
  sample,
  sessionSnapshot,
  ready,
  installDefaultMocks,
} from "../shared/test/app-harness";

vi.mock("../shared/api/api", async (original) =>
  mockApiModule(await original<typeof import("../shared/api/api")>()),
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

    it("keeps a failed segment edit when another segment is clicked", async () => {
      vi.mocked(api.getMeeting).mockResolvedValue(transcribed);
      vi.mocked(api.editSegment).mockRejectedValue({
        code: "segment_conflict",
        message: "This transcript segment changed or no longer exists.",
      });
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      const first = document.getElementById("segment-11");
      if (!first) throw new Error("Missing segment");
      await act(async () => {
        first.focus();
      });
      await userEvent.click(
        screen.getByRole("button", { name: "Edit segment at 0:01" }),
      );
      const input = screen.getByRole("textbox", {
        name: "Edit segment at 0:01",
      });
      await userEvent.clear(input);
      await userEvent.type(input, "Unsaved words");
      await userEvent.keyboard("{Enter}");
      expect(
        await screen.findByText(/changed or no longer exists/),
      ).toBeTruthy();
      const untimed = document.getElementById("segment-12");
      if (!untimed) throw new Error("Missing untimed segment");
      // Tab-style focus moves save the failed draft once more; wait until that save has settled.
      await act(async () => {
        untimed.focus();
        await new Promise((done) => setTimeout(done, 20));
      });
      await userEvent.keyboard("{Enter}");
      expect(
        screen.queryByRole("textbox", { name: "Edit segment at Untimed" }),
      ).toBeNull();
      expect(screen.getByDisplayValue("Unsaved words")).toBeTruthy();
    });

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
      await userEvent.click(screen.getByRole("button", { name: "More" }));
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
      // A fixture has no playable audio, so the tab says so instead of offering a player.
      expect(
        screen.getByText("Samples and simulations have no audio."),
      ).toBeTruthy();
      expect(screen.queryByLabelText("You (microphone)")).toBeNull();
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
      expect(screen.getByTitle("Original: Agred")).toBeTruthy();
      const segment = document.getElementById("segment-11");
      if (!segment) throw new Error("Missing segment");
      await act(async () => {
        segment.focus();
      });
      await userEvent.click(
        screen.getByRole("button", { name: "Edit segment at 0:01" }),
      );
      const input = screen.getByRole("textbox", {
        name: "Edit segment at 0:01",
      });
      await userEvent.clear(input);
      await userEvent.type(input, "Persimmon budget");
      await userEvent.keyboard("{Enter}");
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
      // Quitting saves the open edit by default; a conflict keeps the window open and says so.
      // The dialog also blurs the field, which saves again, so both calls must fail.
      vi.mocked(api.editSegment).mockRejectedValue({
        code: "segment_conflict",
        message: "This transcript segment changed or no longer exists.",
      });
      act(() => vi.mocked(api.onCloseRequested).mock.calls[0][0]());
      expect(
        await screen.findByText(
          "Transcript edit not saved: This transcript segment changed or no longer exists.",
        ),
      ).toBeTruthy();
      expect(api.close).not.toHaveBeenCalled();
      await userEvent.click(
        screen.getByRole("button", { name: "Keep working" }),
      );
      vi.mocked(api.editSegment).mockResolvedValue(undefined);
      await userEvent.click(
        screen.getByRole("textbox", { name: "Edit segment at 0:01" }),
      );
      await userEvent.keyboard("{Enter}");
      await waitFor(() =>
        expect(
          screen.queryByRole("textbox", { name: "Edit segment at 0:01" }),
        ).toBeNull(),
      );
      const untimed = document.getElementById("segment-12");
      if (!untimed) throw new Error("Missing untimed segment");
      await act(async () => {
        untimed.focus();
      });
      await userEvent.click(
        screen.getByRole("button", { name: "Revert segment at Untimed" }),
      );
      expect(api.editSegment).toHaveBeenLastCalledWith(
        "sample",
        12,
        "Agreed",
        "Agred",
      );
      // Earlier transcripts moved behind the meeting menu: ⋯ > History, and stay read-only.
      await userEvent.click(screen.getByLabelText("More meeting actions"));
      const menu = screen
        .getByLabelText("More meeting actions")
        .closest("details");
      if (!menu) throw new Error("Missing meeting menu");
      await userEvent.click(
        within(menu).getByRole("button", { name: "History" }),
      );
      const history = await screen.findByRole("dialog", {
        name: "Transcript history",
      });
      await userEvent.click(
        within(history).getByRole("button", { name: "Earlier transcript 1" }),
      );
      expect(api.getTranscriptVersion).toHaveBeenCalledWith("sample", 3);
      const kept = await within(history).findByLabelText(
        "Earlier transcript (read-only)",
      );
      expect(within(kept).getByText(/Kept earlier words/)).toBeTruthy();
      // Nothing in History can replace the current transcript.
      expect(
        within(history).queryByRole("button", { name: /restore|replace/i }),
      ).toBeNull();
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

    it("has no Ask entry, so no saved answer can open a transcript time", async () => {
      await ready();
      expect(
        screen.queryByRole("button", { name: "Ask across meetings" }),
      ).toBeNull();
      expect(screen.queryByRole("combobox", { name: "Scope" })).toBeNull();
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
        name: "Play from 0:08",
      });
      expect(play.textContent).toBe("0:08");
      await userEvent.click(play);
      expect(api.audioPosition).toHaveBeenCalledWith("sample", "mic", 8250);
      expect(api.audioPosition).toHaveBeenCalledWith("sample", "system", 8250);
      await waitFor(() => expect(system.currentTime).toBe(2.25));
      expect(
        (screen.getByLabelText("You (microphone)") as HTMLAudioElement)
          .currentTime,
      ).toBe(2.25);
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
        screen.getByRole("button", { name: "Play from 0:08" }),
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
        screen.getByRole("button", { name: "Play from 0:08" }),
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
        "An audio file could not be opened. It may have been moved.",
      );
    });

    it("pauses the other track when one track refuses to play", async () => {
      vi.mocked(api.getMeeting).mockResolvedValue(recorded);
      vi.mocked(api.audioPosition).mockResolvedValue(2250);
      const paused: string[] = [];
      vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(function (
        this: HTMLMediaElement,
      ) {
        return this.getAttribute("aria-label") === "You (microphone)"
          ? Promise.reject(new Error("Output unavailable"))
          : Promise.resolve();
      });
      vi.mocked(HTMLMediaElement.prototype.pause).mockImplementation(function (
        this: HTMLMediaElement,
      ) {
        paused.push(this.getAttribute("aria-label") ?? "");
      });
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      await userEvent.click(
        screen.getByRole("button", { name: "Play from 0:08" }),
      );
      expect((await screen.findByRole("alert")).textContent).toBe(
        "Audio could not play. Check your output device and try again.",
      );
      expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
      expect(paused).toContain("Others (system audio)");
    });

    it("keeps the playhead moving when the shorter leading track ends", async () => {
      vi.mocked(api.getMeeting).mockResolvedValue(recorded);
      vi.mocked(api.audioPosition).mockResolvedValue(2250);
      vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(function (
        this: HTMLMediaElement,
      ) {
        Object.defineProperty(this, "paused", {
          configurable: true,
          value: false,
        });
        return Promise.resolve();
      });
      vi.mocked(HTMLMediaElement.prototype.pause).mockImplementation(function (
        this: HTMLMediaElement,
      ) {
        Object.defineProperty(this, "paused", {
          configurable: true,
          value: true,
        });
      });
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      const mic = screen.getByLabelText("You (microphone)") as HTMLAudioElement;
      const system = screen.getByLabelText(
        "Others (system audio)",
      ) as HTMLAudioElement;
      await userEvent.click(
        screen.getByRole("button", { name: "Play from 0:08" }),
      );
      await waitFor(() => expect(mic.paused).toBe(false));
      // The shorter track reaches its end (paused, as the element reports it); the other keeps playing.
      Object.defineProperty(mic, "paused", { configurable: true, value: true });
      system.currentTime = 5.25;
      await waitFor(() =>
        expect(document.querySelector(".tx-clock")?.textContent).toContain(
          "0:11",
        ),
      );
    });

    // Fake media: an element keeps its own time and ended state. play() restarts an
    // element that has ended or sits at its duration, as browsers do; seeking clears ended.
    const fakeMedia = () => {
      const played: string[] = [];
      const models = new WeakMap<
        HTMLMediaElement,
        { time: number; paused: boolean; ended: boolean }
      >();
      const attach = (element: HTMLMediaElement) => {
        const known = models.get(element);
        if (known) return known;
        const model = { time: 0, paused: true, ended: false };
        models.set(element, model);
        Object.defineProperty(element, "currentTime", {
          configurable: true,
          get: () => model.time,
          set: (value: number) => {
            model.time = value;
            model.ended = false;
          },
        });
        Object.defineProperty(element, "paused", {
          configurable: true,
          get: () => model.paused,
        });
        Object.defineProperty(element, "ended", {
          configurable: true,
          get: () => model.ended,
        });
        return model;
      };
      vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(function (
        this: HTMLMediaElement,
      ) {
        const model = attach(this);
        played.push(this.getAttribute("aria-label") ?? "");
        if (model.ended || model.time >= this.duration) this.currentTime = 0;
        model.paused = false;
        return Promise.resolve();
      });
      vi.mocked(HTMLMediaElement.prototype.pause).mockImplementation(function (
        this: HTMLMediaElement,
      ) {
        attach(this).paused = true;
      });
      return {
        played,
        end: (element: HTMLMediaElement, seconds: number) => {
          const model = attach(element);
          element.currentTime = seconds;
          model.paused = true;
          model.ended = true;
        },
      };
    };
    const clockText = () =>
      document.querySelector(".tx-clock")?.textContent ?? "";
    const playToggle = () =>
      document.querySelector(".tx-play") as HTMLButtonElement;
    const playLabel = () => playToggle()?.getAttribute("aria-label");

    it("shows Play and the finished position once every track has ended", async () => {
      vi.mocked(api.getMeeting).mockResolvedValue(recorded);
      vi.mocked(api.audioPosition).mockResolvedValue(2250);
      const media = fakeMedia();
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      const mic = screen.getByLabelText("You (microphone)") as HTMLAudioElement;
      const system = screen.getByLabelText(
        "Others (system audio)",
      ) as HTMLAudioElement;
      await userEvent.click(
        screen.getByRole("button", { name: "Play from 0:08" }),
      );
      await waitFor(() => expect(playLabel()).toBe("Pause"));
      mic.currentTime = 3.25;
      await waitFor(() => expect(clockText()).toContain("0:09"));
      media.end(mic, 3);
      media.end(system, 3);
      await waitFor(() => expect(playLabel()).toBe("Play"));
      expect(clockText()).toContain("0:09");
    });

    it("replays from the start when Play is pressed after the end", async () => {
      vi.mocked(api.getMeeting).mockResolvedValue(recorded);
      vi.mocked(api.audioPosition).mockResolvedValue(2250);
      const media = fakeMedia();
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      const mic = screen.getByLabelText("You (microphone)") as HTMLAudioElement;
      const system = screen.getByLabelText(
        "Others (system audio)",
      ) as HTMLAudioElement;
      await userEvent.click(
        screen.getByRole("button", { name: "Play from 0:08" }),
      );
      await waitFor(() => expect(playLabel()).toBe("Pause"));
      media.end(mic, 3);
      media.end(system, 3);
      await waitFor(() => expect(playLabel()).toBe("Play"));
      vi.mocked(api.audioPosition).mockClear();
      await userEvent.click(playToggle());
      await waitFor(() =>
        expect(api.audioPosition).toHaveBeenCalledWith("sample", "mic", 0),
      );
      await waitFor(() => expect(playLabel()).toBe("Pause"));
    });

    it("does not restart a track that already ended when playback resumes", async () => {
      vi.mocked(api.getMeeting).mockResolvedValue(recorded);
      vi.mocked(api.audioPosition).mockResolvedValue(2250);
      const media = fakeMedia();
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      const mic = screen.getByLabelText("You (microphone)") as HTMLAudioElement;
      const system = screen.getByLabelText(
        "Others (system audio)",
      ) as HTMLAudioElement;
      await userEvent.click(
        screen.getByRole("button", { name: "Play from 0:08" }),
      );
      await waitFor(() => expect(playLabel()).toBe("Pause"));
      // The shorter track ends at its 2 s mark while the other keeps playing.
      media.end(mic, 2);
      system.currentTime = 4;
      await waitFor(() => expect(clockText()).toContain("0:10"));
      await userEvent.click(playToggle());
      media.played.length = 0;
      await userEvent.click(playToggle());
      await waitFor(() => expect(playLabel()).toBe("Pause"));
      expect(media.played).toEqual(["Others (system audio)"]);
      expect(mic.currentTime).toBe(2);
    });

    it("does not play a track whose duration ends before the seek target", async () => {
      vi.mocked(api.getMeeting).mockResolvedValue(recorded);
      vi.mocked(api.audioPosition).mockResolvedValue(2250);
      const media = fakeMedia();
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      const mic = screen.getByLabelText("You (microphone)") as HTMLAudioElement;
      Object.defineProperty(mic, "duration", { configurable: true, value: 2 });
      await userEvent.click(
        screen.getByRole("button", { name: "Play from 0:08" }),
      );
      await waitFor(() =>
        expect(media.played).toEqual(["Others (system audio)"]),
      );
      expect(mic.currentTime).toBe(2.25);
    });

    it("ignores a play refused after another meeting opens", async () => {
      const other: MeetingDetail = {
        ...recorded,
        meeting: { ...recorded.meeting, id: "other", title: "Other sync" },
        tracks: recorded.tracks.map((track) => ({
          ...track,
          path: `other-${track.path}`,
        })),
      };
      vi.mocked(api.listMeetings).mockResolvedValue([
        recorded.meeting,
        other.meeting,
      ]);
      vi.mocked(api.getMeeting).mockImplementation(async (id) =>
        id === "other" ? other : recorded,
      );
      vi.mocked(api.audioPosition).mockResolvedValue(2250);
      const refusals: ((error: Error) => void)[] = [];
      vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(
        () =>
          new Promise<void>((_, reject) => {
            refusals.push(reject);
          }),
      );
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      await userEvent.click(
        screen.getByRole("button", { name: "Play from 0:08" }),
      );
      await waitFor(() => expect(refusals).toHaveLength(2));
      await userEvent.click(screen.getByRole("button", { name: /Other sync/ }));
      await screen.findByRole("heading", { name: "Other sync" });
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
      await act(async () => {
        for (const refuse of refusals) refuse(new Error("Output unavailable"));
        await new Promise((done) => setTimeout(done, 20));
      });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
    });

    it("ignores a seek that resolves after a newer seek", async () => {
      vi.mocked(api.getMeeting).mockResolvedValue(recorded);
      let resolveFirst: (ms: number) => void = () => {};
      vi.mocked(api.audioPosition).mockImplementation((_id, _kind, ms) =>
        ms === 8250
          ? new Promise<number>((resolve) => {
              resolveFirst = resolve;
            })
          : Promise.resolve(4000),
      );
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      const system = screen.getByLabelText(
        "Others (system audio)",
      ) as HTMLAudioElement;
      await userEvent.click(
        screen.getByRole("button", { name: "Play from 0:08" }),
      );
      const slider = screen.getByRole("slider", {
        name: "Playback position",
      });
      await act(async () => slider.focus());
      await userEvent.keyboard("{ArrowRight}");
      await waitFor(() => expect(system.currentTime).toBe(4));
      await act(async () => {
        resolveFirst(2250);
        await new Promise((done) => setTimeout(done, 20));
      });
      expect(system.currentTime).toBe(4);
      // The fixture is 3 s long, so the arrow key clamps to the end.
      expect(
        document.querySelector(".tx-clock")?.textContent?.startsWith("0:03"),
      ).toBe(true);
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    });

    it("drops a seek that resolves after another meeting opens", async () => {
      const other: MeetingDetail = {
        ...recorded,
        meeting: { ...recorded.meeting, id: "other", title: "Other sync" },
        tracks: recorded.tracks.map((track) => ({
          ...track,
          path: `other-${track.path}`,
        })),
      };
      vi.mocked(api.listMeetings).mockResolvedValue([
        recorded.meeting,
        other.meeting,
      ]);
      vi.mocked(api.getMeeting).mockImplementation(async (id) =>
        id === "other" ? other : recorded,
      );
      let resolveMic: (ms: number) => void = () => {};
      vi.mocked(api.audioPosition).mockImplementation((id) =>
        id === "sample"
          ? new Promise<number>((resolve) => {
              resolveMic = resolve;
            })
          : Promise.resolve(1000),
      );
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      await userEvent.click(
        screen.getByRole("button", { name: "Play from 0:08" }),
      );
      await userEvent.click(screen.getByRole("button", { name: /Other sync/ }));
      await screen.findByRole("heading", { name: "Other sync" });
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      const system = screen.getByLabelText(
        "Others (system audio)",
      ) as HTMLAudioElement;
      await act(async () => {
        resolveMic(2250);
        await new Promise((done) => setTimeout(done, 20));
      });
      expect(system.currentTime).toBe(0);
      expect(api.audioPosition).not.toHaveBeenCalledWith(
        "other",
        "system",
        8250,
      );
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
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
      expect(screen.getByText(/Put the cursor on a \[mm:ss\]/)).toBeTruthy();
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

    it("starts a stamp on its own line when the caret is mid-line", async () => {
      const live = {
        revision: 1,
        status: "recording" as const,
        meeting_id: "sample",
        source: "desktop",
        error: null,
        recording_offset_ms: 65_400,
      };
      vi.mocked(api.getRecordingState).mockResolvedValue(live);
      await ready();
      const editor = screen.getByDisplayValue(
        "Original notes",
      ) as HTMLTextAreaElement;
      editor.setSelectionRange(8, 8);
      await userEvent.click(
        screen.getByRole("button", { name: "Insert timestamp" }),
      );
      await waitFor(() =>
        expect(editor.value).toBe("Original\n[01:05]  notes"),
      );
      await waitFor(() => expect(editor.selectionStart).toBe(17));
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

  describe("next steps and re-transcription", () => {
    const stopped: MeetingDetail = {
      ...sample,
      meeting: { ...sample.meeting, source: "desktop" },
      summary: null,
      summary_provider: null,
      summary_model: null,
      tracks: [
        {
          kind: "mic",
          path: "mic.wav",
          device_name: "Microphone",
          sample_rate: 16000,
          frames: 16000,
          dropped_frames: 0,
          finalized: true,
          size_bytes: null,
        },
      ],
    };
    const transcribed: MeetingDetail = {
      ...stopped,
      segments: [
        {
          speaker: "Others",
          timing: { kind: "timed", start_ms: 1000, end_ms: 2000 },
          text: "Kickoff agreed",
        },
      ],
      segment_meta: [{ id: 21, original_text: null }],
    };

    it("transcribes from the next steps card and shows that it is running", async () => {
      vi.mocked(api.sttStatus).mockResolvedValue(installed);
      vi.mocked(api.getMeeting).mockResolvedValue(stopped);
      // Never settles, so the running state stays on screen for the assertions.
      vi.mocked(api.transcribeMeeting).mockReturnValue(new Promise(() => {}));
      await ready();
      const card = await screen.findByRole("group", { name: "Next steps" });
      expect(within(card).getByText("No transcript yet.")).toBeTruthy();
      await userEvent.click(
        within(card).getByRole("button", { name: "Transcribe audio" }),
      );
      await waitFor(() =>
        expect(api.transcribeMeeting).toHaveBeenCalledWith("sample"),
      );
      // The card hides itself on the Transcript tab, where progress and Cancel live.
      expect(
        screen
          .getByRole("tab", { name: "Transcript" })
          .getAttribute("aria-selected"),
      ).toBe("true");
      expect(
        screen.getByRole("button", { name: "Transcribing" }),
      ).toHaveProperty("disabled", true);
    });

    it("shows the card again once a cancelled processing status is dismissed", async () => {
      vi.mocked(api.sttStatus).mockResolvedValue(installed);
      vi.mocked(api.getMeeting).mockResolvedValue(stopped);
      vi.mocked(api.getSessionProcessing).mockResolvedValue(
        sessionSnapshot(1, "cancelled"),
      );
      await ready();
      await screen.findByRole("region", { name: "Session processing" });
      expect(screen.queryByRole("group", { name: "Next steps" })).toBeNull();
      await userEvent.click(
        screen.getByRole("button", { name: "Dismiss processing status" }),
      );
      expect(
        await screen.findByRole("group", { name: "Next steps" }),
      ).toBeTruthy();
    });

    it("jumps to the summary from the next steps card", async () => {
      vi.mocked(api.sttStatus).mockResolvedValue(installed);
      vi.mocked(api.getMeeting).mockResolvedValue(stopped);
      await ready();
      const card = await screen.findByRole("group", { name: "Next steps" });
      await userEvent.click(
        within(card).getByRole("button", { name: "Go to Summary" }),
      );
      expect(
        screen
          .getByRole("tab", { name: "Summary" })
          .getAttribute("aria-selected"),
      ).toBe("true");
    });

    it("explains the speech setup it needs instead of a transcribe button", async () => {
      vi.mocked(api.getMeeting).mockResolvedValue(stopped);
      await ready();
      const card = await screen.findByRole("group", { name: "Next steps" });
      expect(
        within(card).getByText("Download the speech engine in Settings first."),
      ).toBeTruthy();
      expect(
        within(card).queryByRole("button", { name: "Transcribe audio" }),
      ).toBeNull();
      expect(
        within(card).getByRole("button", {
          name: "Open Settings for Transcription",
        }),
      ).toBeTruthy();
    });

    it("leaves out the summary jump when there are no notes", async () => {
      vi.mocked(api.sttStatus).mockResolvedValue(installed);
      vi.mocked(api.getMeeting).mockResolvedValue({
        ...stopped,
        user_markdown: "",
      });
      render(<App />);
      const card = await screen.findByRole("group", { name: "Next steps" });
      expect(
        within(card).queryByRole("button", { name: "Go to Summary" }),
      ).toBeNull();
    });

    it("is not repeated on the Transcript tab, which already offers the action", async () => {
      vi.mocked(api.sttStatus).mockResolvedValue(installed);
      vi.mocked(api.getMeeting).mockResolvedValue(stopped);
      await ready();
      await screen.findByRole("group", { name: "Next steps" });
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      expect(screen.queryByRole("group", { name: "Next steps" })).toBeNull();
      expect(
        screen.getByRole("button", { name: "Transcribe audio" }),
      ).toBeTruthy();
    });

    it.each([
      ["a transcript exists", transcribed],
      [
        "the recording is still running",
        {
          ...stopped,
          meeting: { ...stopped.meeting, status: "recording" as const },
        },
      ],
      [
        "the recording was interrupted",
        {
          ...stopped,
          meeting: { ...stopped.meeting, status: "interrupted" as const },
        },
      ],
      [
        "the meeting is a note",
        {
          ...stopped,
          meeting: { ...stopped.meeting, source: "note" as const },
        },
      ],
    ])("hides the card when %s", async (_case, detail) => {
      vi.mocked(api.sttStatus).mockResolvedValue(installed);
      vi.mocked(api.getMeeting).mockResolvedValue(detail);
      await ready();
      expect(screen.queryByRole("group", { name: "Next steps" })).toBeNull();
    });

    it("waits while automatic processing runs and shows the card once it fails", async () => {
      vi.mocked(api.sttStatus).mockResolvedValue(installed);
      vi.mocked(api.getMeeting).mockResolvedValue(stopped);
      vi.mocked(api.getSessionProcessing).mockResolvedValue(
        sessionSnapshot(1, "transcribing"),
      );
      await ready();
      await screen.findByRole("region", { name: "Session processing" });
      expect(screen.queryByRole("group", { name: "Next steps" })).toBeNull();
    });

    it("shows the card after automatic processing has failed", async () => {
      vi.mocked(api.sttStatus).mockResolvedValue(installed);
      vi.mocked(api.getMeeting).mockResolvedValue(stopped);
      vi.mocked(api.getSessionProcessing).mockResolvedValue(
        sessionSnapshot(1, "failed"),
      );
      await ready();
      await screen.findByRole("region", { name: "Session processing" });
      expect(
        await screen.findByRole("group", { name: "Next steps" }),
      ).toBeTruthy();
    });

    it("asks before re-transcribing and keeps the transcript when cancelled", async () => {
      vi.mocked(api.sttStatus).mockResolvedValue(installed);
      vi.mocked(api.getMeeting).mockResolvedValue(transcribed);
      vi.mocked(api.transcribeMeeting).mockResolvedValue(undefined);
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      const trigger = screen.getByRole("button", {
        name: "Re-transcribe audio",
      });
      expect(trigger.classList.contains("primary")).toBe(false);
      await userEvent.click(trigger);
      const card = screen.getByRole("group", {
        name: "Confirm re-transcription",
      });
      expect(card.textContent).toContain(
        "The current transcript, edits included, is kept in History.",
      );
      expect(card.textContent).toContain(
        "This runs on your computer and can take about as long as the recording.",
      );
      expect(card.textContent).not.toContain("uploaded");
      expect(within(card).getByRole("button", { name: "Cancel" })).toBe(
        document.activeElement,
      );
      expect(api.transcribeMeeting).not.toHaveBeenCalled();
      await userEvent.click(
        within(card).getByRole("button", { name: "Cancel" }),
      );
      expect(
        screen.queryByRole("group", { name: "Confirm re-transcription" }),
      ).toBeNull();
      expect(trigger).toBe(document.activeElement);
      expect(api.transcribeMeeting).not.toHaveBeenCalled();
      await userEvent.click(trigger);
      await userEvent.click(
        within(
          screen.getByRole("group", { name: "Confirm re-transcription" }),
        ).getByRole("button", { name: "Re-transcribe audio" }),
      );
      await waitFor(() =>
        expect(api.transcribeMeeting).toHaveBeenCalledWith("sample"),
      );
    });

    it("uses the online wording for a cloud speech connection and closes on Escape", async () => {
      vi.mocked(api.getSettings).mockResolvedValue({
        ...initialSettings,
        stt_mode: "cloud",
        cloud_stt: {
          base_url: "https://speech.example/v1",
          model: "speech-model",
          revision: 2,
        },
      });
      vi.mocked(api.providerKeyStatus).mockResolvedValue("present");
      vi.mocked(api.getMeeting).mockResolvedValue(transcribed);
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      await userEvent.click(
        screen.getByRole("button", { name: "Re-transcribe audio" }),
      );
      const card = screen.getByRole("group", {
        name: "Confirm re-transcription",
      });
      expect(card.textContent).toContain(
        "Audio is uploaded again and may be billed again.",
      );
      expect(card.textContent).not.toContain("runs on your computer");
      fireEvent.keyDown(card, { key: "Escape" });
      expect(
        screen.queryByRole("group", { name: "Confirm re-transcription" }),
      ).toBeNull();
      expect(screen.getByRole("button", { name: "Re-transcribe audio" })).toBe(
        document.activeElement,
      );
      expect(api.transcribeMeeting).not.toHaveBeenCalled();
    });

    it("closes the confirmation when another meeting opens", async () => {
      const other: MeetingDetail = {
        ...transcribed,
        meeting: { ...transcribed.meeting, id: "other", title: "Other sync" },
      };
      vi.mocked(api.sttStatus).mockResolvedValue(installed);
      vi.mocked(api.listMeetings).mockResolvedValue([
        transcribed.meeting,
        other.meeting,
      ]);
      vi.mocked(api.getMeeting).mockImplementation(async (id) =>
        id === "other" ? other : transcribed,
      );
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      await userEvent.click(
        screen.getByRole("button", { name: "Re-transcribe audio" }),
      );
      expect(
        screen.getByRole("group", { name: "Confirm re-transcription" }),
      ).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: /Other sync/ }));
      await screen.findByRole("heading", { name: "Other sync" });
      expect(
        screen.queryByRole("group", { name: "Confirm re-transcription" }),
      ).toBeNull();
    });
  });
});

describe("long transcripts", () => {
  const observers: {
    callback: IntersectionObserverCallback;
  }[] = [];

  beforeEach(() => {
    observers.length = 0;
    class MockObserver {
      callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal("IntersectionObserver", MockObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const revealMore = async () => {
    const observer = observers.at(-1);
    if (!observer) throw new Error("No transcript observer");
    await act(async () => {
      observer.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver,
      );
    });
  };

  const long: MeetingDetail = {
    ...sample,
    summary: "## Decisions\n- Late point [06:39]",
    summary_provider: "merge",
    summary_model: "m1",
    segments: Array.from({ length: 450 }, (_, index) => ({
      speaker: index % 2 ? ("Others" as const) : ("You" as const),
      timing: {
        kind: "timed" as const,
        start_ms: index * 1000,
        end_ms: index * 1000 + 900,
      },
      text: `Segment ${index + 1}`,
    })),
    segment_meta: Array.from({ length: 450 }, (_, index) => ({
      id: index + 1,
      original_text: null,
    })),
  };
  const rows = () => document.querySelectorAll(".transcript-segment");

  it("renders 200 segments, then pages in more or all of the rest", async () => {
    vi.mocked(api.getMeeting).mockResolvedValue(long);
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    expect(rows()).toHaveLength(200);
    expect(screen.queryByRole("button", { name: /Show next/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
    await revealMore();
    expect(rows()).toHaveLength(400);
    await revealMore();
    expect(rows()).toHaveLength(450);
    expect(screen.queryByRole("button", { name: /Show next/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
  });

  it("widens the rendered page to a citation beyond it, then focuses it", async () => {
    vi.mocked(api.getMeeting).mockResolvedValue(long);
    await ready();
    expect(document.getElementById("segment-400")).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Open transcript at 06:39" }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: "Transcript" })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
    expect(rows()).toHaveLength(400);
    const segment = document.getElementById("segment-400");
    expect(segment?.textContent).toContain("Segment 400");
    expect(segment?.className).toContain("highlighted-segment");
    expect(document.activeElement).toBe(segment);
  });

  it("starts from the first page again when another meeting opens", async () => {
    const other = { ...sample.meeting, id: "other", title: "Other sync" };
    vi.mocked(api.listMeetings).mockResolvedValue([sample.meeting, other]);
    vi.mocked(api.getMeeting).mockImplementation(async (id) =>
      id === "other" ? { ...sample, meeting: other } : long,
    );
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    await revealMore();
    await revealMore();
    expect(rows()).toHaveLength(450);
    await userEvent.click(screen.getByRole("button", { name: /Other sync/ }));
    await userEvent.click(screen.getByRole("button", { name: /Sample sync/ }));
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    expect(rows()).toHaveLength(200);
  });
});
