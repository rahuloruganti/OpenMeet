import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  LiveLine,
  LiveTranscript,
  LiveTranscriptEvent,
} from "../../shared/api/api";
import { api } from "../../shared/api/api";
import { useLiveTranscript } from "./use-live-transcript";

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
  text: string,
  final: boolean,
  extra: Partial<LiveLine> = {},
): LiveLine => ({
  id,
  lane: "mic",
  speaker: "You",
  start_ms: 0,
  end_ms: 1000,
  text,
  final,
  ...extra,
});

const loaded = (over: Partial<LiveTranscript> = {}): LiveTranscript => ({
  meeting_id: "m1",
  lines: [],
  partials: [],
  state: "running",
  engine: "Streaming English (NeMo)",
  leaves_device: false,
  notice: null,
  ...over,
});

let send: (event: LiveTranscriptEvent) => void = () => {};

const speak = (update: LiveLine) =>
  act(() => send({ meeting_id: "m1", line: update }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.liveTranscript).mockResolvedValue(loaded());
  vi.mocked(api.onLiveTranscript).mockImplementation(async (callback) => {
    send = callback;
    return () => {};
  });
  vi.mocked(api.onLiveState).mockResolvedValue(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

/** Renders the hook and lets the first load settle. */
async function open(paused = false) {
  const hook = renderHook(() => useLiveTranscript("m1", paused));
  await act(async () => undefined);
  return hook;
}

it("loads the finals and partials once and applies a partial to its own line", async () => {
  vi.mocked(api.liveTranscript).mockResolvedValue(
    loaded({
      lines: [line("mic:1", "Opening line.", true, { start_ms: 1000 })],
      partials: [],
    }),
  );
  const { result } = await open();
  expect(result.current.lines).toHaveLength(1);

  await speak(line("mic:2", "Half a sen", false, { start_ms: 4000 }));
  expect(result.current.partials.map((item) => item.text)).toEqual([
    "Half a sen",
  ]);

  // The same utterance is replaced, never appended.
  await speak(line("mic:2", "Half a sentence.", false, { start_ms: 4000 }));
  await act(() => {
    vi.advanceTimersByTime(200);
  });
  expect(result.current.partials.map((item) => item.text)).toEqual([
    "Half a sentence.",
  ]);
  expect(result.current.lines).toHaveLength(1);
});

it("keeps a final, closes the partial and sorts finals by start time", async () => {
  const { result } = await open();

  await speak(line("mic:2", "Later words.", true, { start_ms: 5000 }));
  await speak(line("mic:1", "Earlier words.", true, { start_ms: 1000 }));
  await act(() => {
    vi.advanceTimersByTime(3000);
  });

  expect(result.current.lines.map((item) => item.text)).toEqual([
    "Earlier words.",
    "Later words.",
  ]);
  expect(result.current.partials).toHaveLength(0);
});

it("applies at most one update per 200 ms while the page is visible", async () => {
  const { result } = await open();

  await speak(line("mic:1", "First", false));
  expect(result.current.partials[0].text).toBe("First");

  await speak(line("mic:1", "Second", false));
  // Still inside the window: nothing is applied yet.
  expect(result.current.partials[0].text).toBe("First");

  await act(() => {
    vi.advanceTimersByTime(199);
  });
  expect(result.current.partials[0].text).toBe("First");

  await act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(result.current.partials[0].text).toBe("Second");
});

it("waits 5 s for an update while the page is hidden", async () => {
  const { result } = await open();
  // One flush sets the window, then the page goes to the background.
  await speak(line("mic:1", "Visible", false));
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });

  await speak(line("mic:1", "Background", false));
  await act(() => {
    vi.advanceTimersByTime(4999);
  });
  expect(result.current.partials[0].text).toBe("Visible");

  await act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(result.current.partials[0].text).toBe("Background");

  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

it("shows nothing new while the recording is paused", async () => {
  const { result } = await open(true);

  await speak(line("mic:1", "Not yet", false));
  await act(() => {
    vi.advanceTimersByTime(6000);
  });

  expect(result.current.partials).toHaveLength(0);
  expect(result.current.lines).toHaveLength(0);
});

it("replaces the engine state from a state event and ignores other meetings", async () => {
  const { result } = await open();
  expect(result.current.transcript?.state).toBe("running");

  await act(async () => {
    const states = vi.mocked(api.onLiveState).mock.calls[0][0];
    states({
      meeting_id: "m1",
      state: "failed",
      engine: null,
      leaves_device: false,
      notice: "The live model failed to load.",
    });
    states({
      meeting_id: "other",
      state: "running",
      engine: "Other",
      leaves_device: true,
      notice: null,
    });
  });

  expect(result.current.transcript?.state).toBe("failed");
  expect(result.current.transcript?.notice).toBe(
    "The live model failed to load.",
  );
});
