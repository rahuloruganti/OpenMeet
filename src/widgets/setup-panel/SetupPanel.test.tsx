import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AudioDevices } from "../../shared/api/api";
import { SetupPanel } from "./SetupPanel";

afterEach(() => vi.unstubAllGlobals());

const devices: AudioDevices = {
  capture_supported: true,
  microphones: [
    { id: "mic1", name: "Headset (SoundCore 2)" },
    { id: "mic2", name: "Microphone Array (Realtek)" },
  ],
  outputs: [{ id: "out1", name: "Speakers (Realtek)" }],
};

const props = {
  panelRef: { current: null },
  devices,
  title: "Weekly sync",
  microphone: "mic1",
  output: "out1",
  disabled: false,
  active: false,
  onTitle: vi.fn(),
  onMicrophone: vi.fn(),
  onOutput: vi.fn(),
  onRefreshDevices: vi.fn(),
  onClose: vi.fn(),
  processing: { mode: "recording" as const, summary: null },
  onOpenSettings: vi.fn(),
  onStartCapture: vi.fn(),
  speechReady: true,
  sttMode: "local" as const,
};

it("is a modal dialog with title and devices, and Escape closes it", async () => {
  render(<SetupPanel {...props} />);
  const dialog = screen.getByRole("dialog", { name: "New recording" });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(
    screen.getByRole("textbox", { name: "Title" }).getAttribute("value"),
  ).toBe("Weekly sync");
  expect(screen.getByRole("combobox", { name: "Microphone" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "System audio" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(props.onClose).toHaveBeenCalled();
});

it("keeps Tab inside the dialog, from the last control round to the first", async () => {
  render(<SetupPanel {...props} />);
  const start = screen.getByRole("button", { name: "Start recording" });
  start.focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Close" }),
  );
});

it("blocks Start recording without a title", () => {
  render(<SetupPanel {...props} title="   " />);
  expect(
    screen.getByRole("button", { name: "Start recording" }),
  ).toHaveProperty("disabled", true);
});

it("keeps every option in More options", async () => {
  render(<SetupPanel {...props} />);
  const more = screen.getByText("More options").closest("details");
  expect(more?.open).toBe(false);
  await userEvent.click(screen.getByText("More options"));
  expect(more?.open).toBe(true);
  expect(screen.getByRole("button", { name: "Refresh devices" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open Settings" })).toBeTruthy();
});

const unsupported: AudioDevices = {
  capture_supported: false,
  microphones: [],
  outputs: [],
};

it("says recording needs Windows on Windows when capture is unsupported", () => {
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  });
  render(<SetupPanel {...props} devices={unsupported} />);

  const alerts = screen.getAllByRole("alert").map((node) => node.textContent);
  expect(alerts.join(" ")).toContain("Recording needs Windows.");
  expect(alerts.join(" ")).not.toContain("this Mac");
});

it("does not claim a Mac needs Windows when capture is unsupported", () => {
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)",
  });
  render(<SetupPanel {...props} devices={unsupported} />);

  const alerts = screen.getAllByRole("alert").map((node) => node.textContent);
  expect(alerts.join(" ")).toContain("Recording is not available on this Mac.");
  expect(alerts.join(" ")).not.toContain("Windows");
});
