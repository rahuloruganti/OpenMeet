import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Tip } from "./info-tip";

it("is a real button that opens its popover on focus and closes on blur", () => {
  render(<Tip label="Appearance" text="System follows Windows." />);
  const button = screen.getByRole("button", { name: "More about Appearance" });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("tooltip")).toBeNull();

  // Focus alone shows the text, so a keyboard user never has to hover.
  fireEvent.focus(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  const tip = screen.getByRole("tooltip");
  expect(tip.textContent).toBe("System follows Windows.");
  expect(button.getAttribute("aria-controls")).toBe(tip.id);

  // Leaving it closes it.
  fireEvent.blur(button);
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(button.getAttribute("aria-expanded")).toBe("false");
});

it("opens on a click and closes on Escape without closing the page behind it", async () => {
  // The Settings page closes on Escape; a tip must swallow its own Escape.
  const page = vi.fn();
  document.addEventListener("keydown", page);
  render(<Tip label="Models" text="Whisper files only." />);
  const button = screen.getByRole("button", { name: "More about Models" });

  await userEvent.click(button);
  expect(screen.getByRole("tooltip").textContent).toBe("Whisper files only.");
  // A click focuses the button, so focus keeps it open rather than toggling it shut.
  expect(button.getAttribute("aria-expanded")).toBe("true");

  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(page).not.toHaveBeenCalled();
  document.removeEventListener("keydown", page);
});

it("names itself after the setting it explains", () => {
  render(<Tip text="Nothing here." />);
  expect(
    screen.getByRole("button", { name: "More about this setting" }),
  ).toBeTruthy();
});
