import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type {
  LiveLine,
  LiveTranscript as LiveTranscriptData,
  LiveTranscriptEvent,
} from "../../shared/api/api";
import { api } from "../../shared/api/api";
import { LiveTranscript } from "./LiveTranscript";

vi.mock("../../shared/api/api", async (original) => ({
  ...(await original<typeof import("../../shared/api/api")>()),
  api: {
    liveTranscript: vi.fn(),
    onLiveTranscript: vi.fn(),
    onLiveState: vi.fn(),
  },
}));

const line = (
  id: string,
  speaker: string,
  text: string,
  start_ms: number,
  extra: Partial<LiveLine> = {},
): LiveLine => ({
  id,
  lane: speaker === "You" ? "mic" : "system",
  speaker,
  start_ms,
  end_ms: start_ms + 2000,
  text,
  final: true,
  ...extra,
});

const data = (over: Partial<LiveTranscriptData> = {}): LiveTranscriptData => ({
  meeting_id: "m1",
  lines: [],
  partials: [],
  state: "running",
  engine: "Streaming English (Kroko)",
  leaves_device: false,
  notice: null,
  ...over,
});

let send: (event: LiveTranscriptEvent) => void = () => {};

const view = (extra: Partial<Parameters<typeof LiveTranscript>[0]> = {}) => (
  <LiveTranscript
    meetingId="m1"
    paused={false}
    provisional={false}
    names={{ you: null, others: null }}
    onOpenSettings={vi.fn()}
    {...extra}
  />
);

beforeEach(() => {
  vi.mocked(api.liveTranscript).mockResolvedValue(data());
  vi.mocked(api.onLiveTranscript).mockImplementation(async (callback) => {
    send = callback;
    return () => {};
  });
  vi.mocked(api.onLiveState).mockResolvedValue(() => {});
});

it("groups consecutive finals of one speaker into one paragraph with one time", async () => {
  vi.mocked(api.liveTranscript).mockResolvedValue(
    data({
      lines: [
        line("mic:1", "You", "First part.", 61_000),
        line("mic:2", "You", "Second part.", 64_000),
        line("sys:1", "Others", "A question.", 70_000),
      ],
    }),
  );
  const { container } = render(view());

  const paragraphs = await screen.findAllByText(
    (_, element) => element?.className === "lt-line",
  );
  expect(paragraphs).toHaveLength(2);
  expect(screen.getByText(/First part\. Second part\./)).toBeTruthy();
  // One timestamp for the run, from its first line.
  expect(screen.getAllByText("01:01")).toHaveLength(1);
  // Finals are announced politely; partials are not.
  expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(2);
});

it("puts a partial after the last paragraph of its lane in muted text", async () => {
  vi.mocked(api.liveTranscript).mockResolvedValue(
    data({
      lines: [line("mic:1", "You", "Said aloud.", 1000)],
      partials: [
        line("sys:2", "Others", "Still being", 9000, {
          final: false,
          start_ms: 9000,
        }),
      ],
    }),
  );
  const { container } = render(view());

  await screen.findByText(/Said aloud\./);
  const rows = Array.from(container.querySelectorAll(".lt-line"));
  expect(rows).toHaveLength(2);
  expect(rows[1].className).toContain("lt-partial");
  expect(rows[1].textContent).toContain("Still being");
  expect(rows[1].querySelector('[aria-live="polite"]')).toBeNull();
});

it("keeps partials after every final in time order, whichever lane they belong to", async () => {
  vi.mocked(api.liveTranscript).mockResolvedValue(
    data({
      lines: [
        line("sys:1", "Others", "Friday works.", 1000),
        line("mic:2", "You", "Then Friday.", 5000),
      ],
      partials: [
        line("mic:3", "You", "And the handover", 9000, {
          final: false,
          start_ms: 9000,
        }),
        line("sys:4", "Others", "I will tell", 8000, {
          final: false,
          start_ms: 8000,
        }),
      ],
    }),
  );
  const { container } = render(view());

  await screen.findByText(/Then Friday\./);
  const rows = Array.from(container.querySelectorAll(".lt-line")).map(
    (row) => row.textContent ?? "",
  );
  expect(rows).toHaveLength(4);
  expect(rows[0]).toContain("Friday works.");
  expect(rows[1]).toContain("Then Friday.");
  expect(rows[2]).toContain("I will tell");
  expect(rows[3]).toContain("And the handover");
});

it("follows the newest line until the reader scrolls up and offers Jump to live", async () => {
  vi.mocked(api.liveTranscript).mockResolvedValue(
    data({ lines: [line("mic:1", "You", "Said aloud.", 1000)] }),
  );
  const { container } = render(view());
  await screen.findByText(/Said aloud\./);

  const box = container.querySelector(".lt-scroll") as HTMLDivElement;
  Object.defineProperty(box, "scrollHeight", {
    configurable: true,
    value: 900,
  });
  Object.defineProperty(box, "clientHeight", {
    configurable: true,
    value: 300,
  });
  box.scrollTop = 100;
  fireEvent.scroll(box);

  const jump = await screen.findByRole("button", { name: "Jump to live" });
  await userEvent.click(jump);
  expect(screen.queryByRole("button", { name: "Jump to live" })).toBeNull();
});

it("says why live text is off and opens the Recording section", async () => {
  vi.mocked(api.liveTranscript).mockResolvedValue(
    data({
      state: "off",
      engine: null,
      notice: "Live transcript is off because no live model is ready.",
    }),
  );
  const onOpenSettings = vi.fn();
  render(view({ onOpenSettings }));

  expect(await screen.findByText(/no live model is ready/)).toBeTruthy();
  const link = screen.getByRole("button", {
    name: "Open Settings for Recording",
  });
  await userEvent.click(link);
  expect(onOpenSettings).toHaveBeenCalledWith("recording", link);
});

it("tags a cloud engine that leaves the device, and a paused recording", async () => {
  vi.mocked(api.liveTranscript).mockResolvedValue(
    data({ state: "running", leaves_device: true, engine: "Cloud speech" }),
  );
  render(view({ paused: true }));

  expect(await screen.findByText("Leaves this device")).toBeTruthy();
  expect(screen.getByText("Paused")).toBeTruthy();
  expect(screen.getByText("Cloud speech")).toBeTruthy();
});

it("shows a new line as it arrives", async () => {
  vi.mocked(api.liveTranscript).mockResolvedValue(
    data({ state: "starting", engine: null }),
  );
  render(view());
  await screen.findByText("Starting live transcript.");

  await act(async () => {
    send({ meeting_id: "m1", line: line("mic:1", "You", "Hello there.", 0) });
  });

  expect(await screen.findByText(/Hello there\./)).toBeTruthy();
  expect(screen.queryByText("Starting live transcript.")).toBeNull();
});

it("shows nothing for a finished recording that never ran live", async () => {
  vi.mocked(api.liveTranscript).mockResolvedValue(data({ state: "stopped" }));
  const { container } = render(view({ provisional: true }));
  await act(async () => undefined);
  expect(container.querySelector(".lt")).toBeNull();
});
