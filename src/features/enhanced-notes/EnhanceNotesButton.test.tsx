import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { EnhanceNotesButton } from "./EnhanceNotesButton";

const ready = {
  template: "general-v1",
  label: "Enhance notes",
  hasTranscript: true,
  hasNotes: true,
  modelReady: true,
  recording: false,
  busy: false,
};

it("runs enhancement with the chosen template when everything is ready", async () => {
  const onEnhance = vi.fn();
  render(<EnhanceNotesButton {...ready} onEnhance={onEnhance} />);
  const button = screen.getByRole("button", {
    name: "Enhance notes",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-describedby")).toBeNull();
  await userEvent.click(button);
  expect(onEnhance).toHaveBeenCalledWith("general-v1");
});

it.each([
  [{ recording: true }, "Stop recording to enhance your notes."],
  [{ hasTranscript: false }, "No transcript yet. Record or transcribe first."],
  [{ hasNotes: false }, "Write notes first."],
  [{ modelReady: false }, "Set up AI notes in Settings first."],
])("is off with one reason when %o", (change, reason) => {
  const onEnhance = vi.fn();
  render(<EnhanceNotesButton {...ready} {...change} onEnhance={onEnhance} />);
  const button = screen.getByRole("button", {
    name: "Enhance notes",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-describedby")).toBeTruthy();
  expect(screen.getByText(reason)).toBeTruthy();
});

it("names recording as the reason first when several things are missing", () => {
  render(
    <EnhanceNotesButton
      {...ready}
      recording
      hasTranscript={false}
      onEnhance={vi.fn()}
    />,
  );
  expect(
    screen.getByText("Stop recording to enhance your notes."),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Enhance notes" })
      .getAttribute("aria-describedby"),
  ).toBeTruthy();
});

it("shows progress and stays off while a job runs", () => {
  render(<EnhanceNotesButton {...ready} busy onEnhance={vi.fn()} />);
  expect(
    (screen.getByRole("button", { name: "Enhancing…" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
