import { describe, expect, it } from "vitest";
import { shortcutLabel } from "./shortcut-label";

describe("shortcutLabel", () => {
  it("shows the saved accelerator in friendly key names", () => {
    expect(shortcutLabel("CommandOrControl+Shift+Space")).toBe(
      "Ctrl+Shift+Space",
    );
    expect(shortcutLabel("Control+Shift+F9")).toBe("Ctrl+Shift+F9");
    expect(shortcutLabel("Meta+Alt+S")).toBe("Win+Alt+S");
    expect(shortcutLabel("Command+S")).toBe("Win+S");
  });

  it("leaves other keys unchanged", () => {
    expect(shortcutLabel("Alt+Shift+S")).toBe("Alt+Shift+S");
    expect(shortcutLabel("F10")).toBe("F10");
  });
});
