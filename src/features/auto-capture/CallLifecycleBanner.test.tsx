import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallLifecycle } from "../../shared/api/api";
import { api } from "../../shared/api/api";
import { CallLifecycleBanner, countdown } from "./CallLifecycleBanner";
import { idleLifecycle } from "./useCallLifecycle";

vi.mock("../../shared/api/api", async (original) => ({
  ...(await original<typeof import("../../shared/api/api")>()),
  api: {
    getCallLifecycle: vi.fn(),
    lifecycleKeepRecording: vi.fn(),
    lifecycleEndNow: vi.fn(),
    onCallLifecycleChanged: vi.fn(),
  },
}));

const lifecycle = (over: Partial<CallLifecycle>): CallLifecycle => ({
  ...idleLifecycle,
  enabled: true,
  session_id: "session-1",
  meeting_id: "meeting-1",
  app_name: "Zoom",
  origin: "auto",
  revision: 7,
  reason: "test",
  ...over,
});

/** Renders the banner with the backend reporting `state`, and waits for the first read. */
async function showing(state: CallLifecycle) {
  vi.mocked(api.getCallLifecycle).mockResolvedValue(state);
  const view = render(<CallLifecycleBanner />);
  await act(async () => {});
  return view;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.onCallLifecycleChanged).mockResolvedValue(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CallLifecycleBanner", () => {
  it.each([
    [
      "disabled",
      lifecycle({ state: "disabled", enabled: false, origin: null }),
    ],
    ["armed", lifecycle({ state: "armed", origin: null })],
    ["candidate", lifecycle({ state: "candidate", origin: null })],
    ["complete", lifecycle({ state: "complete", origin: "auto" })],
    ["a manual recording", lifecycle({ state: "recording", origin: "manual" })],
    ["a manual pause", lifecycle({ state: "paused", origin: "manual" })],
  ])("renders nothing in %s", async (_, state) => {
    const { container } = await showing(state);
    expect(container.firstChild).toBeNull();
  });

  it("shows automatic recording with the app name", async () => {
    await showing(lifecycle({ state: "recording", app_name: "Zoom" }));
    expect(screen.getByText("Recording automatically · Zoom")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("omits the app part when no app name is known", async () => {
    await showing(lifecycle({ state: "recording", app_name: null }));
    expect(screen.getByText("Recording automatically")).toBeTruthy();
  });

  it("shows the automatic pause", async () => {
    await showing(lifecycle({ state: "paused" }));
    expect(screen.getByText("Automatic recording paused")).toBeTruthy();
  });

  it("shows the transcript finish", async () => {
    await showing(lifecycle({ state: "finalizing" }));
    expect(screen.getByText("Finishing transcript...")).toBeTruthy();
  });

  it("shows the backend error in the recording-error style", async () => {
    await showing(
      lifecycle({ state: "recoverable_error", error: "Audio device lost." }),
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Audio device lost.");
    expect(alert.className).toContain("error");
  });

  it("counts the end countdown down with the clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T10:00:00Z"));
    await showing(
      lifecycle({
        state: "end_pending",
        end_deadline_ms: Date.now() + 45_000,
      }),
    );
    expect(
      screen.getByText("Call seems to have ended. Recording ends in 00:45"),
    ).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(
      screen.getByText("Call seems to have ended. Recording ends in 00:44"),
    ).toBeTruthy();
    act(() => vi.advanceTimersByTime(40_000));
    expect(
      screen.getByText("Call seems to have ended. Recording ends in 00:04"),
    ).toBeTruthy();
    act(() => vi.advanceTimersByTime(4000));
    expect(
      screen.getByText("Call seems to have ended. Recording ends in 00:00"),
    ).toBeTruthy();
  });

  it("formats the countdown as mm:ss", () => {
    expect(countdown(45_000)).toBe("00:45");
    expect(countdown(44_001)).toBe("00:45");
    expect(countdown(61_000)).toBe("01:01");
    expect(countdown(-5)).toBe("00:00");
  });

  it("keeps the recording with the session id and revision", async () => {
    vi.mocked(api.lifecycleKeepRecording).mockResolvedValue(
      lifecycle({ state: "recording", revision: 8 }),
    );
    await showing(
      lifecycle({ state: "end_pending", end_deadline_ms: Date.now() + 45_000 }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Keep recording" }),
    );
    expect(api.lifecycleKeepRecording).toHaveBeenCalledWith("session-1", 7);
    expect(api.lifecycleEndNow).not.toHaveBeenCalled();
  });

  it("ends the recording now with the session id and revision", async () => {
    vi.mocked(api.lifecycleEndNow).mockResolvedValue(
      lifecycle({ state: "finalizing", revision: 8 }),
    );
    await showing(
      lifecycle({ state: "end_pending", end_deadline_ms: Date.now() + 45_000 }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "End now" }),
    );
    expect(api.lifecycleEndNow).toHaveBeenCalledWith("session-1", 7);
    expect(api.lifecycleKeepRecording).not.toHaveBeenCalled();
  });

  it("re-reads the state on a stale revision instead of showing an error", async () => {
    const current = lifecycle({ state: "recording", revision: 9 });
    vi.mocked(api.lifecycleEndNow).mockRejectedValue({
      code: "stale_revision",
      message: "The call changed.",
    });
    await showing(
      lifecycle({ state: "end_pending", end_deadline_ms: Date.now() + 45_000 }),
    );
    vi.mocked(api.getCallLifecycle).mockResolvedValue(current);
    await userEvent.click(
      await screen.findByRole("button", { name: "End now" }),
    );
    expect(
      await screen.findByText("Recording automatically · Zoom"),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("re-reads the state on each lifecycle event and ignores the payload", async () => {
    let notify: ((payload: CallLifecycle) => void) | undefined;
    vi.mocked(api.onCallLifecycleChanged).mockImplementation(
      async (callback) => {
        notify = callback;
        return () => {};
      },
    );
    await showing(lifecycle({ state: "armed", origin: null }));
    expect(api.getCallLifecycle).toHaveBeenCalledTimes(1);
    vi.mocked(api.getCallLifecycle).mockResolvedValue(
      lifecycle({ state: "recording", app_name: "Teams" }),
    );
    // The payload says idle; the banner must show what the backend reports on re-read.
    await act(async () => notify?.(idleLifecycle));
    expect(api.getCallLifecycle).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByText("Recording automatically · Teams"),
    ).toBeTruthy();
  });
});
