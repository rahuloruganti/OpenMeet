import { describe, expect, it } from "vitest";
import { formatTimestamp, timestampAtCaret } from "./timestamps";

describe("note timestamps", () => {
  it("formats minutes and hours", () => {
    expect(formatTimestamp(0)).toBe("[00:00]");
    expect(formatTimestamp(65_999)).toBe("[01:05]");
    expect(formatTimestamp(3_723_000)).toBe("[1:02:03]");
  });

  it("reads the first timestamp on the caret's line only", () => {
    const text = "[00:10] intro\n- decision [1:02:03] then [00:05]\nno stamp";
    expect(timestampAtCaret(text, 3)).toBe(10_000);
    expect(timestampAtCaret(text, 20)).toBe(3_723_000);
    expect(timestampAtCaret(text, text.length)).toBeNull();
    expect(timestampAtCaret("[75:30]", 0)).toBe(4_530_000);
  });

  it("rejects malformed timestamps", () => {
    for (const text of ["[1:5]", "[00:60]", "[1:60:00]", "[ab:cd]", "1:02"])
      expect(timestampAtCaret(text, 0)).toBeNull();
  });
});
