import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RecordingControls } from "./RecordingControls";

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
