import { mockApiModule } from "../shared/test/api-mock";
import {
  act,
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
  ready,
  installDefaultMocks,
} from "../shared/test/app-harness";

vi.mock("../shared/api/api", async (original) =>
  mockApiModule(await original<typeof import("../shared/api/api")>()),
);

beforeEach(installDefaultMocks);

describe("layout and keyboard navigation", () => {
  it("returns focus to the workspace when a banner is dismissed", async () => {
    vi.mocked(api.getStartupWarning).mockResolvedValue(
      "Startup warning for test",
    );
    await ready();
    await userEvent.click(
      await screen.findByRole("button", { name: "Dismiss" }),
    );
    expect(screen.queryByText(/Startup warning for test/)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("shows first-run setup as its own screen, then gives focus back to the workspace", async () => {
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
    vi.mocked(api.saveSetupDone).mockResolvedValue({
      ...initialSettings,
      setup_done: true,
    });
    render(<App />);
    const skip = await screen.findByRole("button", { name: "Skip setup" });
    // No sidebar, no workspace, no recording bar while the wizard is open.
    expect(
      screen.queryByRole("complementary", { name: "Meeting navigation" }),
    ).toBeNull();
    expect(screen.queryByRole("main")).toBeNull();
    await userEvent.click(skip);
    await waitFor(() => expect(api.saveSetupDone).toHaveBeenCalledWith(true));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("main")),
    );
  });

  it("returns focus to the workspace after Settings, and to the trigger after the recording panel", async () => {
    await ready();
    await userEvent.click(
      within(
        screen.getByRole("complementary", { name: "Meeting navigation" }),
      ).getByRole("button", { name: "Settings" }),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Settings" }),
    ).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(await screen.findByRole("main")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("main"));

    const trigger = screen.getByRole("button", { name: "New recording" });
    await userEvent.click(trigger);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close" }),
    );
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.startCapture).not.toHaveBeenCalled();
  });

  it("starts narrow windows with navigation collapsed and notes visible", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    await ready();
    const toggle = screen.getByRole("button", { name: "Toggle meetings" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByRole("complementary", { name: "Meeting navigation" }),
    ).toBeNull();
    expect(screen.getByRole("textbox", { name: /My notes/ }).textContent).toBe(
      "Original notes",
    );
    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: "New recording" })).toBeTruthy();
  });

  it("collapses meeting navigation without hiding content or discarding the draft", async () => {
    await ready();
    const toggle = screen.getByRole("button", { name: "Toggle meetings" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Draft with sidebar closed" },
    });
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByRole("complementary", { name: "Meeting navigation" }),
    ).toBeNull();
    expect(screen.getByRole("textbox", { name: /My notes/ }).textContent).toBe(
      "Draft with sidebar closed",
    );
    await userEvent.click(toggle);
    expect(
      screen.getByRole("complementary", { name: "Meeting navigation" }),
    ).toBeTruthy();
    expect(api.getMeeting).toHaveBeenCalledOnce();
  });

  it("navigates content tabs by keyboard without losing or replacing typed notes", async () => {
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "My draft stays mine" },
    });
    const notesTab = screen.getByRole("tab", { name: "My notes" });
    const summaryTab = screen.getByRole("tab", { name: "Summary" });
    const transcriptTab = screen.getByRole("tab", { name: "Transcript" });
    notesTab.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(summaryTab);
    expect(summaryTab.getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByRole("tabpanel", { name: "Summary" }).textContent,
    ).toContain("Sample summary");
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(transcriptTab);
    expect(
      screen.getByRole("tabpanel", { name: "Transcript" }).textContent,
    ).toContain("Samples and simulations have no audio");
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(notesTab);
    expect(screen.getByRole("textbox", { name: /My notes/ }).textContent).toBe(
      "My draft stays mine",
    );
    expect(api.getMeeting).toHaveBeenCalledOnce();
  });
});

describe("collapsed sidebar and narrow windows", () => {
  it("drops the duplicated action row from the toolbar while the sidebar is collapsed", async () => {
    await ready();
    const toggle = screen.getByRole("button", { name: "Toggle meetings" });
    await userEvent.click(toggle);
    expect(screen.queryByRole("button", { name: "New recording" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
    // The toggle brings the sidebar, and its actions, back.
    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: "New recording" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeTruthy();
  });

  it("disables New recording in the sidebar while a recording is active", async () => {
    vi.mocked(api.getRecordingState).mockResolvedValue({
      revision: 1,
      status: "recording",
      meeting_id: "sample",
      source: "desktop",
      error: null,
      recording_offset_ms: null,
    });
    await ready();
    const sidebar = screen.getByRole("complementary", {
      name: "Meeting navigation",
    });
    expect(
      (
        within(sidebar).getByRole("button", {
          name: "New recording",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("collapses the sidebar when the window narrows to 800px and does not reopen it when it widens", async () => {
    const narrowListeners: ((event: { matches: boolean }) => void)[] = [];
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(min-width: 801px)",
        addEventListener: (
          _type: string,
          listener: (event: { matches: boolean }) => void,
        ) => {
          if (query === "(max-width: 800px)") narrowListeners.push(listener);
        },
        removeEventListener: vi.fn(),
      })),
    );
    await ready();
    const toggle = screen.getByRole("button", { name: "Toggle meetings" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    act(() =>
      narrowListeners.forEach((listener) => listener({ matches: true })),
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    act(() =>
      narrowListeners.forEach((listener) => listener({ matches: false })),
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("collapses the sidebar after a meeting is opened on a narrow window", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    await ready();
    const toggle = screen.getByRole("button", { name: "Toggle meetings" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(
      within(
        screen.getByRole("complementary", { name: "Meeting navigation" }),
      ).getByRole("button", { name: /Sample sync/ }),
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-expanded")).toBe("false"),
    );
  });
});
