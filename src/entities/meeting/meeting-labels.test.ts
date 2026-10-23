import { describe, expect, it } from "vitest";
import {
  foldText,
  formatDate,
  formatDateTime,
  formatShortDate,
  formatTime,
} from "./meeting-labels";

// Built from local time so the displayed clock is 10:15 in any timezone.
const iso = new Date(2026, 9, 23, 10, 15).toISOString();

describe("date helpers", () => {
  it("formatDate shows month, day and year without a time", () => {
    const text = formatDate(iso);
    expect(text).toContain("2026");
    expect(text).toContain("23");
    expect(text).not.toContain(":");
  });

  it("formatDateTime shows the year and hour and minute, but no seconds", () => {
    const text = formatDateTime(iso);
    expect(text).toContain("2026");
    expect(text).toContain("10:15");
    expect(text).not.toMatch(/:\d{2}:\d{2}/);
  });

  it("formatShortDate omits the year in the current year", () => {
    const now = new Date(2026, 5, 1);
    const text = formatShortDate(iso, now);
    expect(text).toContain("23");
    expect(text).not.toContain("2026");
  });

  it("formatShortDate adds the year outside the current year", () => {
    const now = new Date(2027, 0, 5);
    expect(formatShortDate(iso, now)).toContain("2026");
  });
});

describe("foldText", () => {
  it("ignores case and accents in both directions", () => {
    expect(foldText("Café Ångström")).toBe("cafe angstrom");
    expect(foldText("cafe")).toBe("cafe");
    expect(foldText("Ångström").includes(foldText("angstrom"))).toBe(true);
    expect(foldText("Café").includes(foldText("cafe"))).toBe(true);
    expect(foldText("Naïve résumé")).toBe("naive resume");
  });

  it("leaves text without accents alone", () => {
    expect(foldText("Planning Review 2026")).toBe("planning review 2026");
  });
});

describe("formatTime", () => {
  it("shows the start time with hour and minute, without a date", () => {
    const text = formatTime(new Date(2026, 9, 23, 9, 30).toISOString());
    expect(text).toMatch(/9:30/);
    expect(text).not.toContain("2026");
    expect(text).not.toContain("23");
  });
});
