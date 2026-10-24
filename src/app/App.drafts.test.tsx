import { mockApiModule } from "../shared/test/api-mock";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../shared/api/api";
import { sample, ready, installDefaultMocks } from "../shared/test/app-harness";

vi.mock("../shared/api/api", async (original) =>
  mockApiModule(await original<typeof import("../shared/api/api")>()),
);

beforeEach(installDefaultMocks);

describe("note drafts and shutdown", () => {
  it("shows the quit prompt over the meetings page even when Settings was open", async () => {
    await ready();
    await userEvent.click(
      within(
        screen.getByRole("complementary", { name: "Meeting navigation" }),
      ).getByRole("button", { name: "Settings" }),
    );
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    act(() => vi.mocked(api.onCloseRequested).mock.calls[0][0]());
    const quit = await screen.findByRole("button", { name: "Save and quit" });
    expect(document.activeElement).toBe(quit);
    await userEvent.click(screen.getByRole("button", { name: "Keep working" }));
    expect(screen.getByRole("main")).toBeTruthy();
  });

  it("guards opening the active meeting when another meeting has an unsaved draft", async () => {
    vi.mocked(api.getRecordingState).mockResolvedValue({
      revision: 1,
      status: "recording",
      meeting_id: "active",
      source: "desktop",
      error: null,
      recording_offset_ms: null,
    });
    vi.mocked(api.getMeeting).mockImplementation(async (id) =>
      id === "active"
        ? {
            ...sample,
            meeting: {
              ...sample.meeting,
              id: "active",
              title: "Active capture",
              source: "desktop",
              status: "recording",
            },
            user_markdown: "Active notes",
          }
        : sample,
    );
    await ready();
    vi.mocked(api.saveNotes).mockRejectedValue(new Error("Write failed"));
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Do not lose this draft" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Open active meeting" }),
    );
    await screen.findByText(/Notes not saved: Write failed/);
    expect(api.getMeeting).not.toHaveBeenCalledWith("active");
    expect(screen.getByDisplayValue("Do not lose this draft")).toBeTruthy();
    vi.mocked(api.saveNotes).mockResolvedValue(1);
    await userEvent.click(
      screen.getByRole("button", { name: "Open active meeting" }),
    );
    await screen.findByDisplayValue("Active notes");
    expect(
      screen.getByRole("heading", { name: "Active capture" }),
    ).toBeTruthy();
  });

  it("keeps the note draft and a running capture while Settings replaces the page", async () => {
    vi.mocked(api.getRecordingState).mockResolvedValue({
      revision: 1,
      status: "recording",
      meeting_id: "sample",
      source: "desktop",
      error: null,
      recording_offset_ms: null,
    });
    await ready();
    vi.mocked(api.saveNotes).mockRejectedValue(new Error("Disk full"));
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Keep my draft through settings" },
    });
    await userEvent.click(
      within(
        screen.getByRole("complementary", { name: "Meeting navigation" }),
      ).getByRole("button", { name: "Settings" }),
    );
    // Settings is a page of its own: the meeting document is gone, the capture is not stopped.
    expect(
      await screen.findByRole("heading", { level: 1, name: "Settings" }),
    ).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /My notes/ })).toBeNull();
    expect(api.stop).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(
      screen.getByDisplayValue("Keep my draft through settings"),
    ).toBeTruthy();
    await screen.findByText(/Notes not saved: Disk full/);
  });

  it("stops before saving notes and retains a failed draft", async () => {
    vi.mocked(api.getRecordingState).mockResolvedValue({
      revision: 1,
      status: "recording",
      meeting_id: "sample",
      source: "desktop",
      error: null,
      recording_offset_ms: null,
    });
    vi.mocked(api.stop).mockResolvedValue({
      revision: 2,
      status: "stopped",
      meeting_id: "sample",
      source: "desktop",
      error: null,
      recording_offset_ms: null,
    });
    await ready();
    vi.mocked(api.saveNotes).mockRejectedValue(new Error("Disk full"));
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Keep this unsaved draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText(/Notes not saved: Disk full/);
    expect(api.stop).toHaveBeenCalledOnce();
    expect(vi.mocked(api.stop).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.saveNotes).mock.invocationCallOrder[0],
    );
    // The bar says the capture is over (distinct from Recording and Paused).
    await waitFor(() =>
      expect(document.querySelector(".status-dot.stopped")).toBeTruthy(),
    );
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByDisplayValue("Keep this unsaved draft")).toBeTruthy();
    vi.mocked(api.saveNotes).mockResolvedValue(1);
    await userEvent.click(
      screen.getByRole("button", { name: "Save notes now" }),
    );
    await waitFor(() =>
      expect(screen.queryByText(/Notes not saved:/)).toBeNull(),
    );
  });

  it("stops while a note save is still pending", async () => {
    vi.mocked(api.getRecordingState).mockResolvedValue({
      revision: 1,
      status: "recording",
      meeting_id: "sample",
      source: "desktop",
      error: null,
      recording_offset_ms: null,
    });
    vi.mocked(api.stop).mockResolvedValue({
      revision: 2,
      status: "stopped",
      meeting_id: "sample",
      source: "desktop",
      error: null,
      recording_offset_ms: null,
    });
    let finishSave!: (revision: number) => void;
    vi.mocked(api.saveNotes).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Pending save" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Save notes now" }),
    );
    await waitFor(() => expect(api.saveNotes).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(document.querySelector(".status-dot.stopped")).toBeTruthy(),
    );
    expect(api.stop).toHaveBeenCalledOnce();
    expect(screen.getByDisplayValue("Pending save")).toBeTruthy();
    await act(async () => finishSave(1));
  });

  it("keeps the note draft while Settings replaces the page", async () => {
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Draft to preserve" },
    });
    await userEvent.click(
      within(
        screen.getByRole("complementary", { name: "Meeting navigation" }),
      ).getByRole("button", { name: "Settings" }),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Settings" }),
    ).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "My notes" })).toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByDisplayValue("Draft to preserve")).toBeTruthy();
  });

  it("does not close or discard notes when saving fails", async () => {
    await ready();
    vi.mocked(api.saveNotes).mockRejectedValue({
      code: "database",
      message: "Disk full",
    });
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Keep these edits" },
    });
    act(() => vi.mocked(api.onCloseRequested).mock.calls[0][0]());
    const quit = await screen.findByRole("dialog", { name: "Save and quit?" });
    await userEvent.click(
      within(quit).getByRole("button", { name: "Save and quit" }),
    );
    // The banner and the quit dialog both explain the failed save.
    await waitFor(() =>
      expect(screen.getAllByText(/Notes not saved: Disk full/)).toHaveLength(2),
    );
    expect(within(quit).getByRole("alert").textContent).toContain(
      "Quitting waits for them",
    );
    expect(api.close).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Keep these edits")).toBeTruthy();
  });

  it("explains a failed save in the quit dialog and keeps Keep working focused", async () => {
    await ready();
    vi.mocked(api.saveNotes).mockRejectedValue(new Error("Disk full"));
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Keep these edits" },
    });
    await screen.findByText(/Notes not saved: Disk full/);
    act(() => vi.mocked(api.onCloseRequested).mock.calls[0][0]());
    const dialog = await screen.findByRole("dialog", {
      name: "Save and quit?",
    });
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "Notes not saved: Disk full. Quitting waits for them. Copy your text or retry.",
    );
    // Enter on the dialog must not retry a failing save by default.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Keep working" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save and quit" }),
    );
    await screen.findByText(/Save your notes first: fix the error above/);
    expect(api.close).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Keep these edits")).toBeTruthy();
  });

  it("does not switch meetings when the current notes cannot be saved", async () => {
    vi.mocked(api.listMeetings).mockResolvedValue([
      sample.meeting,
      { ...sample.meeting, id: "second", title: "Second meeting" },
    ]);
    await ready();
    vi.mocked(api.saveNotes).mockRejectedValue(new Error("Write failed"));
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Unflushed" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: /Second meeting/ }),
    );
    await screen.findByText(/Notes not saved: Write failed/);
    expect(api.getMeeting).not.toHaveBeenCalledWith("second");
    expect(screen.getByDisplayValue("Unflushed")).toBeTruthy();
    // The refused switch says why, and the failure text appears once (in the banner).
    await screen.findByText(/Save your notes first: fix the error above/);
    expect(screen.getAllByText(/Write failed/)).toHaveLength(1);
    const saved = document.querySelector(".mw-saved");
    expect(saved?.textContent).toBe("Not saved");
    // A failed save reads as an error, not the calm green "Saved" state.
    expect(saved?.classList.contains("error")).toBe(true);
    // The banner keeps the text and points at the retry.
    expect(
      screen
        .getAllByRole("alert")
        .some((alert) =>
          alert.textContent?.includes("Copy your text or retry."),
        ),
    ).toBe(true);
  });

  it("keeps Save notes now retries in the banner instead of a second message", async () => {
    await ready();
    vi.mocked(api.saveNotes).mockRejectedValue(new Error("Write failed"));
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Retry me" },
    });
    await screen.findByText(/Notes not saved: Write failed/);
    const saves = vi.mocked(api.saveNotes).mock.calls.length;
    await userEvent.click(
      screen.getByRole("button", { name: "Save notes now" }),
    );
    await waitFor(() =>
      expect(vi.mocked(api.saveNotes).mock.calls.length).toBeGreaterThan(saves),
    );
    await act(async () => {});
    expect(
      screen.queryByText(/That action needs your notes saved first/),
    ).toBeNull();
    expect(screen.getByText(/Notes not saved: Write failed/)).toBeTruthy();
  });

  it("flushes notes before graceful shutdown", async () => {
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Last edit before quitting" },
    });
    act(() => vi.mocked(api.onCloseRequested).mock.calls[0][0]());
    await userEvent.click(
      await screen.findByRole("button", { name: "Save and quit" }),
    );
    await waitFor(() => expect(api.close).toHaveBeenCalledOnce());
    expect(api.saveNotes).toHaveBeenCalledWith(
      "sample",
      "Last edit before quitting",
      0,
    );
    expect(vi.mocked(api.saveNotes).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.close).mock.invocationCallOrder[0],
    );
  });
});
