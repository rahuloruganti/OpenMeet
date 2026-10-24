import { mockApiModule } from "../shared/test/api-mock";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { api } from "../shared/api/api";
import {
  initialSettings,
  installDefaultMocks,
  ready,
  sample,
} from "../shared/test/app-harness";

vi.mock("../shared/api/api", async (original) =>
  mockApiModule(await original<typeof import("../shared/api/api")>()),
);

beforeEach(installDefaultMocks);

const palette = () => screen.getByRole("dialog", { name: "Command palette" });
const search = () =>
  screen.getByRole("combobox", { name: "Search commands and meetings" });
const sidebar = () =>
  screen.queryByRole("complementary", { name: "Meeting navigation" });
/** Ctrl+K and its friend: dispatched on the window, as the app listens there. */
const press = (key: string, extra: KeyboardEventInit = {}) =>
  fireEvent.keyDown(window, { key, ...extra });

describe("full pages", () => {
  it("shows first-run setup full screen with no meetings sidebar and no recording bar", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({
      ...initialSettings,
      setup_done: false,
    });
    vi.mocked(api.scanLocalModels).mockResolvedValue({
      models: [],
      folders: [],
      truncated: false,
    });
    vi.mocked(api.detectLocalServers).mockResolvedValue([]);
    vi.mocked(api.saveSetupDone).mockResolvedValue(initialSettings);
    render(<App />);
    const skip = await screen.findByRole("button", { name: "Skip setup" });
    expect(sidebar()).toBeNull();
    expect(screen.queryByRole("main")).toBeNull();
    expect(
      await screen.findByRole("heading", { name: "How should we transcribe?" }),
    ).toBeTruthy();
    // Ctrl+K stays out of the wizard.
    press("k", { ctrlKey: true });
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).toBeNull();
    await userEvent.click(skip);
    await waitFor(() => expect(api.saveSetupDone).toHaveBeenCalledWith(true));
    expect(await screen.findByRole("main")).toBeTruthy();
  });

  it("renders Settings as a page without the sidebar, and Escape returns to Meetings", async () => {
    await ready();
    await userEvent.click(
      within(sidebar()!).getByRole("button", { name: "Settings" }),
    );
    expect(sidebar()).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeTruthy();
    // The palette sits above every page; its Escape closes only the palette.
    press("k", { ctrlKey: true });
    expect(palette()).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(await screen.findByRole("main")).toBeTruthy();
    expect(sidebar()).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("renders Ask as a page with a Meetings back button and no sidebar", async () => {
    await ready();
    press("a", { ctrlKey: true, shiftKey: true });
    const back = await screen.findByRole("button", {
      name: "Back to meetings",
    });
    expect(sidebar()).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Ask" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Question" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask" })).toBeTruthy();
    await userEvent.click(back);
    expect(await screen.findByRole("main")).toBeTruthy();
    expect(sidebar()).toBeTruthy();
  });

  it("keeps the Ask page open when Escape is pressed inside the question box", async () => {
    await ready();
    press("a", { ctrlKey: true, shiftKey: true });
    const box = await screen.findByRole("textbox", { name: "Question" });
    await userEvent.type(box, "What was decided?");
    // The caret's Escape belongs to the field, as in Settings; the page stays.
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.getByRole("heading", { level: 1, name: "Ask" })).toBeTruthy();
    // Escape anywhere else on the page still goes back to Meetings.
    await userEvent.keyboard("{Escape}");
    expect(await screen.findByRole("main")).toBeTruthy();
  });

  it("opens Ask again after leaving it and keeps the sidebar out of the way", async () => {
    await ready();
    press("a", { ctrlKey: true, shiftKey: true });
    await screen.findByRole("heading", { level: 1, name: "Ask" });
    await userEvent.keyboard("{Escape}");
    await screen.findByRole("main");
    press("a", { ctrlKey: true, shiftKey: true });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Ask" }),
    ).toBeTruthy();
    // Only one question box: the answer panel is not left mounted in the workspace.
    expect(screen.getAllByRole("textbox", { name: "Question" })).toHaveLength(
      1,
    );
  });
});

describe("command palette", () => {
  it("opens on Ctrl+K, filters as you type, and runs the first match with Enter", async () => {
    await ready();
    press("k", { ctrlKey: true });
    expect(palette()).toBeTruthy();
    expect(document.activeElement).toBe(search());
    // Actions first, meetings under their own heading.
    expect(
      within(palette()).getByRole("group", { name: "Actions" }),
    ).toBeTruthy();
    expect(
      within(palette()).getByRole("group", { name: "Meetings" }),
    ).toBeTruthy();
    await userEvent.type(search(), "settings");
    expect(within(palette()).queryByText("New recording")).toBeNull();
    await userEvent.keyboard("{Enter}");
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).toBeNull();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Settings" }),
    ).toBeTruthy();
  });

  it("moves with the arrow keys and closes on Escape without leaving the page", async () => {
    await ready();
    press("k", { ctrlKey: true });
    const selected = () => {
      const row = palette().querySelector('[aria-selected="true"]');
      return row?.textContent ?? "";
    };
    expect(selected()).toContain("New recording");
    await userEvent.keyboard("{ArrowDown}");
    expect(selected()).toContain("New note");
    await userEvent.keyboard("{ArrowUp}");
    expect(selected()).toContain("New recording");
    expect(search().getAttribute("aria-activedescendant")).toBe(
      "palette-new-recording",
    );
    await userEvent.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).toBeNull();
    expect(screen.getByRole("main")).toBeTruthy();
  });

  it("opens a meeting by title and closes", async () => {
    vi.mocked(api.listMeetings).mockResolvedValue([
      { ...sample.meeting, id: "second", title: "Planning review" },
    ]);
    await ready();
    press("k", { ctrlKey: true });
    await userEvent.type(search(), "planning");
    expect(
      within(palette()).getByRole("option", { name: /Planning review/ }),
    ).toBeTruthy();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(api.getMeeting).toHaveBeenLastCalledWith("second"),
    );
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).toBeNull();
  });

  it("says so when nothing matches", async () => {
    await ready();
    press("k", { ctrlKey: true });
    await userEvent.type(search(), "zzzz");
    expect(within(palette()).getByRole("status").textContent).toBe(
      "No matches.",
    );
  });
});

describe("theme and inspector preferences", () => {
  it("forces the chosen theme on <html> and clears it again for System", async () => {
    await ready();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    press("k", { ctrlKey: true });
    await userEvent.type(search(), "dark");
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark"),
    );
    expect(api.saveUiPrefs).toHaveBeenLastCalledWith("dark", true);
    press("k", { ctrlKey: true });
    await userEvent.type(search(), "light");
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(document.documentElement.getAttribute("data-theme")).toBe("light"),
    );
    press("k", { ctrlKey: true });
    await userEvent.type(search(), "system");
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(document.documentElement.hasAttribute("data-theme")).toBe(false),
    );
  });

  it("applies the saved theme on startup", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({
      ...initialSettings,
      theme: "light",
    });
    await ready();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("saves the inspector preference on Ctrl+I while typing in a text field", async () => {
    await ready();
    const notes = screen.getByRole("textbox", { name: /My notes/ });
    notes.focus();
    fireEvent.keyDown(notes, { key: "i", ctrlKey: true });
    await waitFor(() =>
      expect(api.saveUiPrefs).toHaveBeenCalledWith("system", false),
    );
    // The saved preference comes back through settings before the next toggle.
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Inspector" })
          .getAttribute("aria-pressed"),
      ).toBe("false"),
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: /My notes/ }), {
      key: "i",
      ctrlKey: true,
    });
    await waitFor(() =>
      expect(api.saveUiPrefs).toHaveBeenLastCalledWith("system", true),
    );
  });
});

describe("shortcuts", () => {
  it("opens the New recording dialog on Ctrl+N and never starts a capture", async () => {
    await ready();
    press("n", { ctrlKey: true });
    expect(
      await screen.findByRole("dialog", { name: /New recording/ }),
    ).toBeTruthy();
    expect(api.startCapture).not.toHaveBeenCalled();
  });

  it("focuses the meeting title editor on F2", async () => {
    await ready();
    press("F2");
    const editor = await screen.findByRole("textbox", {
      name: "Meeting title",
    });
    expect(document.activeElement).toBe(editor);
  });

  it("ignores Ctrl+N while typing in the notes editor, but not Ctrl+K", async () => {
    await ready();
    const notes = screen.getByRole("textbox", { name: /My notes/ });
    notes.focus();
    fireEvent.keyDown(notes, { key: "n", ctrlKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(notes, { key: "k", ctrlKey: true });
    expect(palette()).toBeTruthy();
  });

  it("opens Settings on Ctrl+comma from the palette's own input", async () => {
    await ready();
    press("k", { ctrlKey: true });
    fireEvent.keyDown(search(), { key: ",", ctrlKey: true });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Settings" }),
    ).toBeTruthy();
    // The palette closes and Settings opens on General.
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).toBeNull();
    expect(
      (await screen.findByRole("tab", { name: "General" })).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
  });
});
