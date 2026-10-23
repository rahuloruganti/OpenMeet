/** Friendly text for an accelerator, e.g. "CommandOrControl+Shift+Space" -> "Ctrl+Shift+Space". */
export function shortcutLabel(accelerator: string): string {
  return accelerator
    .split("+")
    .map((part) => {
      const key = part.trim();
      if (key === "CommandOrControl" || key === "Control") return "Ctrl";
      if (key === "Command" || key === "Meta") return "Win";
      return key;
    })
    .join("+");
}
