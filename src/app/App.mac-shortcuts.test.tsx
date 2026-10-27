import { mockApiModule } from "../shared/test/api-mock";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../shared/api/api";
import { installDefaultMocks, ready } from "../shared/test/app-harness";

vi.mock("../shared/api/api", async (original) =>
  mockApiModule(await original<typeof import("../shared/api/api")>()),
);

const MAC_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)";

/** On a Mac the app shortcuts fire on Command, so the platform is stubbed before rendering. */
beforeEach(() => {
  installDefaultMocks();
  vi.stubGlobal("navigator", { userAgent: MAC_USER_AGENT });
});

afterEach(() => vi.unstubAllGlobals());

const palette = () => screen.queryByRole("dialog", { name: "Command palette" });
const press = (key: string, extra: KeyboardEventInit = {}) =>
  fireEvent.keyDown(window, { key, ...extra });

describe("macOS shortcuts", () => {
  it("opens the command palette on Command+K", async () => {
    await ready();
    press("k", { metaKey: true });
    expect(palette()).toBeTruthy();
  });

  it("leaves Control+K to the text field under it", async () => {
    await ready();
    const notes = screen.getByRole("textbox", { name: /My notes/ });
    notes.focus();
    fireEvent.keyDown(notes, { key: "k", ctrlKey: true });
    expect(palette()).toBeNull();
  });

  it("opens the New recording dialog on Command+N and never starts a capture", async () => {
    await ready();
    press("n", { metaKey: true });
    expect(
      await screen.findByRole("dialog", { name: /New recording/ }),
    ).toBeTruthy();
    expect(api.startCapture).not.toHaveBeenCalled();
  });

  it("opens Settings on Command+comma", async () => {
    await ready();
    press(",", { metaKey: true });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Settings" }),
    ).toBeTruthy();
  });

  it("saves the inspector preference on Command+I while typing in a text field", async () => {
    await ready();
    const notes = screen.getByRole("textbox", { name: /My notes/ });
    notes.focus();
    fireEvent.keyDown(notes, { key: "i", metaKey: true });
    await waitFor(() =>
      expect(api.saveUiPrefs).toHaveBeenCalledWith("system", false),
    );
  });

  it("leaves Command+C, Command+V, Command+A and Command+Z to the text field", async () => {
    await ready();
    const notes = screen.getByRole("textbox", { name: /My notes/ });
    notes.focus();
    for (const key of ["c", "v", "a", "z"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      notes.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(palette()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the Mac modifier in the sidebar hint and the palette key caps", async () => {
    await ready();
    expect(screen.getByText("⌘K")).toBeTruthy();
    // The workspace key hint under the inspector toggle uses the same label.
    expect(screen.getByText("⌘I")).toBeTruthy();
    press("k", { metaKey: true });
    const action = screen.getByRole("option", { name: "New recording" });
    expect(action.textContent).toContain("⌘N");
  });
});
