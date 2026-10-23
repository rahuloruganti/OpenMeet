import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatShortDate } from "./meeting-labels";

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
