import { isMac } from "./platform";

/** macOS writes modifiers as symbols; Windows keeps the word names. */
const MAC_MODIFIERS: Record<string, string> = {
  CommandOrControl: "⌘",
  Command: "⌘",
  Meta: "⌘",
  Control: "⌃",
  Alt: "⌥",
  Option: "⌥",
  Shift: "⇧",
};

const WINDOWS_MODIFIERS: Record<string, string> = {
  CommandOrControl: "Ctrl",
  Control: "Ctrl",
  Command: "Win",
  Meta: "Win",
};

/** The cap for one accelerator part, or null when the part is a plain key. */
function modifierLabel(part: string): string | null {
  const labels = isMac() ? MAC_MODIFIERS : WINDOWS_MODIFIERS;
  return labels[part] ?? null;
}

/** Friendly text for an accelerator: "CommandOrControl+Shift+Space" reads "Ctrl+Shift+Space" on
 * Windows and "⌘+⇧+Space" on macOS. Saved accelerators keep one format on both platforms. */
export function shortcutLabel(accelerator: string): string {
  return accelerator
    .split("+")
    .map((part) => {
      const key = part.trim();
      return modifierLabel(key) ?? key;
    })
    .join("+");
}

/** The shortcut modifier as one key cap: Command on macOS, Control on Windows. */
export function modKeyLabel(): string {
  return isMac() ? "⌘" : "Ctrl";
}

/** A chord as one hint string: "⌘K" on macOS, "Ctrl+K" on Windows. */
export function chordHint(
  key: string,
  modifiers: Array<"shift" | "alt"> = [],
): string {
  const mac = isMac();
  const parts = [mac ? "⌘" : "Ctrl"];
  if (modifiers.includes("shift")) parts.push(mac ? "⇧" : "Shift");
  if (modifiers.includes("alt")) parts.push(mac ? "⌥" : "Alt");
  parts.push(key);
  return parts.join(mac ? "" : "+");
}
