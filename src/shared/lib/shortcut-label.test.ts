import { afterEach, describe, expect, it, vi } from "vitest";
import { chordHint, modKeyLabel, shortcutLabel } from "./shortcut-label";

const MAC_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)";
const WINDOWS_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

const useMac = () => vi.stubGlobal("navigator", { userAgent: MAC_USER_AGENT });
const useWindows = () =>
  vi.stubGlobal("navigator", { userAgent: WINDOWS_USER_AGENT });

afterEach(() => vi.unstubAllGlobals());

describe("shortcutLabel", () => {
  it("shows the saved accelerator in friendly key names on Windows", () => {
    useWindows();
    expect(shortcutLabel("CommandOrControl+Shift+Space")).toBe(
      "Ctrl+Shift+Space",
    );
    expect(shortcutLabel("Control+Shift+F9")).toBe("Ctrl+Shift+F9");
    expect(shortcutLabel("Meta+Alt+S")).toBe("Win+Alt+S");
    expect(shortcutLabel("Command+S")).toBe("Win+S");
  });

  it("shows the saved accelerator as modifier symbols on macOS", () => {
    useMac();
    expect(shortcutLabel("CommandOrControl+Shift+Space")).toBe("⌘+⇧+Space");
    expect(shortcutLabel("Control+Shift+F9")).toBe("⌃+⇧+F9");
    expect(shortcutLabel("Meta+Alt+S")).toBe("⌘+⌥+S");
    expect(shortcutLabel("Command+S")).toBe("⌘+S");
    expect(shortcutLabel("Option+Shift+S")).toBe("⌥+⇧+S");
  });

  it("leaves other keys unchanged", () => {
    useWindows();
    expect(shortcutLabel("Alt+Shift+S")).toBe("Alt+Shift+S");
    expect(shortcutLabel("F10")).toBe("F10");
    useMac();
    expect(shortcutLabel("Alt+Shift+S")).toBe("⌥+⇧+S");
    expect(shortcutLabel("F10")).toBe("F10");
  });
});

describe("modKeyLabel and chordHint", () => {
  it("names the shortcut modifier for each platform", () => {
    useWindows();
    expect(modKeyLabel()).toBe("Ctrl");
    useMac();
    expect(modKeyLabel()).toBe("⌘");
  });

  it("writes a chord as one hint string", () => {
    useWindows();
    expect(chordHint("K")).toBe("Ctrl+K");
    expect(chordHint("T", ["shift"])).toBe("Ctrl+Shift+T");
    expect(chordHint("S", ["shift", "alt"])).toBe("Ctrl+Shift+Alt+S");
    useMac();
    expect(chordHint("K")).toBe("⌘K");
    expect(chordHint("T", ["shift"])).toBe("⌘⇧T");
    expect(chordHint("S", ["shift", "alt"])).toBe("⌘⇧⌥S");
  });
});
