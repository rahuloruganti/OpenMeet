import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Meeting } from "../../shared/api/api";
import { CommandPalette, type PaletteAction } from "./CommandPalette";

const meeting = (id: string, title: string): Meeting => ({
  id,
  title,
  started_at: "2026-10-20T09:00:00Z",
  ended_at: null,
  status: "stopped",
  source: "desktop",
  capture_error: null,
  calendar_event_id: null,
  tags: [],
  folder_id: null,
});

function open(
  meetings = [meeting("cafe", "Café review")],
  currentMeetingId: string | null = "cafe",
) {
  const onAction = vi.fn();
  const onClose = vi.fn();
  const onOpenMeeting = vi.fn();
  render(
    <CommandPalette
      meetings={meetings}
      theme="system"
      currentMeetingId={currentMeetingId}
      onClose={onClose}
      onAction={onAction}
      onOpenMeeting={onOpenMeeting}
    />,
  );
  return { onAction, onClose, onOpenMeeting };
}

const search = () =>
  screen.getByRole("combobox", { name: "Search commands and meetings" });

afterEach(() => vi.restoreAllMocks());

it("groups every command by purpose in at most four visible groups", () => {
  open();
  expect(
    screen
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label")),
  ).toEqual(["Create", "This meeting", "Preferences", "Meetings"]);
  expect(
    within(screen.getByRole("group", { name: "Create" }))
      .getAllByRole("option")
      .map((row) => row.querySelector(".label")?.textContent),
  ).toEqual(["New recording", "New note"]);
  expect(
    within(screen.getByRole("group", { name: "This meeting" }))
      .getAllByRole("option")
      .map((row) => row.querySelector(".label")?.textContent),
  ).toEqual(["Export meeting", "Rename"]);
  expect(
    within(screen.getByRole("group", { name: "Preferences" }))
      .getAllByRole("option")
      .map((row) => row.querySelector(".label")?.textContent),
  ).toEqual(["Open settings", "Theme: System", "Theme: Dark", "Theme: Light"]);
});

it("keeps theme search together and hides groups with no matching rows", async () => {
  open();
  await userEvent.type(search(), "theme");
  expect(screen.getAllByRole("group")).toHaveLength(1);
  expect(screen.getByRole("group", { name: "Preferences" })).toBeTruthy();
  expect(screen.getAllByRole("option")).toHaveLength(3);
  expect(
    screen.getByRole("option", { name: "Theme: SystemCurrent" }),
  ).toBeTruthy();
});

it("still matches only command labels and meeting titles with folded text", async () => {
  const { onOpenMeeting, onClose } = open();
  await userEvent.type(search(), "create");
  expect(screen.getByRole("status").textContent).toBe("No matches.");
  await userEvent.clear(search());
  await userEvent.type(search(), "cafe");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  await userEvent.keyboard("{Enter}");
  expect(onOpenMeeting).toHaveBeenCalledWith("cafe");
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("keeps the six recent and twenty searched meeting limits", () => {
  open(
    Array.from({ length: 25 }, (_, index) =>
      meeting(`m${index}`, `Review ${index}`),
    ),
  );
  const meetings = () =>
    within(screen.getByRole("group", { name: "Meetings" })).getAllByRole(
      "option",
    );
  expect(meetings()).toHaveLength(6);
  fireEvent.change(search(), { target: { value: "review" } });
  expect(meetings()).toHaveLength(20);
});

it.each<[PaletteAction, string]>([
  ["new-recording", "New recording"],
  ["new-note", "New note"],
  ["settings", "Open settings"],
  ["export", "Export meeting"],
  ["rename", "Rename"],
  ["theme-system", "Theme: SystemCurrent"],
  ["theme-dark", "Theme: Dark"],
  ["theme-light", "Theme: Light"],
])("keeps the %s command", async (action, label) => {
  const { onAction, onClose } = open();
  await userEvent.click(screen.getByRole("option", { name: label }));
  expect(onAction).toHaveBeenCalledWith(action);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("keeps meeting commands disabled without an open meeting", async () => {
  const { onAction, onClose } = open([], null);
  for (const name of ["Export meeting", "Rename"]) {
    const row = screen.getByRole("option", { name });
    expect(row.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(row);
  }
  expect(onAction).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it.each([
  ["Windows", "Ctrl"],
  ["Macintosh", "⌘"],
])("preserves shortcut key caps on %s", (platform, mod) => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(platform);
  open();
  const caps = (name: string) =>
    Array.from(
      screen.getByRole("option", { name }).querySelectorAll("kbd"),
      (cap) => cap.textContent,
    );
  expect(caps("New recording")).toEqual([mod, "N"]);
  expect(caps("New note")).toEqual([mod, "⇧", "N"]);
  expect(caps("Open settings")).toEqual([mod, ","]);
  expect(caps("Export meeting")).toEqual([mod, "E"]);
  expect(caps("Rename")).toEqual(["F2"]);
});
