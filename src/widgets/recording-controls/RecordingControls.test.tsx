import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type RecordingState } from "../../shared/api/api";
import { idleLifecycle } from "../../features/auto-capture";
import { RecordingControls } from "./RecordingControls";

beforeEach(() => {
  vi.spyOn(api, "getCallLifecycle").mockResolvedValue(idleLifecycle);
  vi.spyOn(api, "onCallLifecycleChanged").mockResolvedValue(vi.fn());
});
afterEach(() => vi.restoreAllMocks());

const controlsProps = (
  state: Partial<RecordingState> = {},
): ComponentProps<typeof RecordingControls> => {
  const recording: RecordingState = {
    revision: 1,
    status: "idle",
    meeting_id: null,
    source: null,
    error: null,
    recording_offset_ms: null,
    ...state,
  };
  return {
    recording,
    active: recording.status === "recording" || recording.status === "paused",
    ready: true,
    controlBusy: false,
    disabled: false,
    showOpenActive: false,
    onOpenActive: vi.fn(),
    onToggle: vi.fn(),
    onStop: vi.fn(),
    health: null,
  };
};

it.each(["idle", "stopped"] as const)(
  "removes inert controls while %s and keeps the status announcement",
  (status) => {
    render(<RecordingControls {...controlsProps({ status })} />);
    const bar = screen.getByRole("region", { name: "Recording controls" });
    expect(bar.classList.contains("is-idle")).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Ready");
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  },
);

it.each([
  {
    status: "recording",
    source: "desktop",
    label: "Recording",
    toggle: "Pause",
  },
  { status: "paused", source: "desktop", label: "Paused", toggle: "Resume" },
  {
    status: "recording",
    source: "simulation",
    label: "Simulation · Recording",
    toggle: "Pause",
  },
  {
    status: "paused",
    source: "simulation",
    label: "Simulation · Paused",
    toggle: "Resume",
  },
] as const)(
  "preserves $label controls",
  ({ status, source, label, toggle }) => {
    const props = controlsProps({
      status,
      source,
      meeting_id: "synthetic",
      recording_offset_ms: source === "desktop" ? 1000 : null,
    });
    render(<RecordingControls {...props} />);
    const bar = screen.getByRole("region", { name: "Recording controls" });
    expect(bar.classList.contains("is-idle")).toBe(false);
    expect(screen.getByRole("status").textContent).toBe(label);
    fireEvent.click(screen.getByRole("button", { name: toggle }));
    expect(props.onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(props.onStop).toHaveBeenCalledTimes(1);
  },
);

it("keeps failed captures visible after recording has stopped", () => {
  render(
    <RecordingControls
      {...controlsProps({
        status: "stopped",
        source: "desktop",
        error: "Microphone disconnected",
      })}
    />,
  );
  expect(
    screen
      .getByRole("region", { name: "Recording controls" })
      .classList.contains("is-idle"),
  ).toBe(false);
  expect(screen.getByRole("status").textContent).toBe("Recording failed");
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Pause" }).disabled,
  ).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled,
  ).toBe(true);
});

it.each([
  { error: null, label: "Simulation · Stopped" },
  { error: "Simulated failure", label: "Simulation failed" },
])("keeps a stopped simulation distinct: $label", ({ error, label }) => {
  render(
    <RecordingControls
      {...controlsProps({ status: "stopped", source: "simulation", error })}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe(label);
  expect(
    screen
      .getByRole("region", { name: "Recording controls" })
      .classList.contains("is-idle"),
  ).toBe(false);
  expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
});

it("preserves the entry to the active meeting", () => {
  const props = {
    ...controlsProps({ status: "recording", source: "desktop" }),
    showOpenActive: true,
  };
  render(<RecordingControls {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Open active meeting" }));
  expect(props.onOpenActive).toHaveBeenCalledTimes(1);
});

it("keeps the same live status node as idle becomes recording and stops", () => {
  const view = render(<RecordingControls {...controlsProps()} />);
  const announcement = screen.getByRole("status");
  view.rerender(
    <RecordingControls
      {...controlsProps({
        status: "recording",
        source: "desktop",
        recording_offset_ms: 1000,
      })}
    />,
  );
  expect(screen.getByRole("status")).toBe(announcement);
  expect(announcement.textContent).toBe("Recording");
  expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  view.rerender(
    <RecordingControls
      {...controlsProps({ status: "stopped", source: "desktop" })}
    />,
  );
  expect(screen.getByRole("status")).toBe(announcement);
  expect(announcement.textContent).toBe("Ready");
  expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
});

it("preserves lifecycle errors when recording itself is idle", async () => {
  vi.mocked(api.getCallLifecycle).mockResolvedValue({
    ...idleLifecycle,
    state: "recoverable_error",
    error: "Automatic capture could not start",
  });
  render(<RecordingControls {...controlsProps()} />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Automatic capture could not start",
  );
  expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
});

it("retries closed-audio finalization without offering resume", () => {
  const stop = vi.fn();
  const toggle = vi.fn();
  const props = {
    recording: {
      revision: 2,
      status: "paused" as const,
      meeting_id: "synthetic",
      source: "desktop",
      error: null,
      recording_offset_ms: null,
    },
    active: true,
    ready: true,
    controlBusy: false,
    disabled: false,
    showOpenActive: false,
    onOpenActive: vi.fn(),
    onToggle: toggle,
    onStop: stop,
    health: null,
  };
  const view = render(<RecordingControls {...props} />);
  expect(screen.getByRole("status").textContent).toBe("Finishing audio…");
  const resume = screen.getByRole<HTMLButtonElement>("button", {
    name: "Resume",
  });
  expect(resume.disabled).toBe(true);
  fireEvent.click(resume);
  expect(toggle).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry finalization" }));
  expect(stop).toHaveBeenCalledTimes(1);

  view.rerender(
    <RecordingControls
      {...props}
      recording={{ ...props.recording, recording_offset_ms: 1000 }}
    />,
  );
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Resume" }).disabled,
  ).toBe(false);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled,
  ).toBe(false);
});
