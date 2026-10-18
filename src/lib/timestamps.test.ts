import { describe, expect, it } from "vitest";
import {
  formatTimestamp,
  parseTimestamp,
  segmentsAt,
  timestampAtCaret,
} from "./timestamps";

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

  it("resolves references with the prompt's whole-second rule", () => {
    const at = (start_ms: number) => ({
      speaker: "You" as const,
      timing: { kind: "timed" as const, start_ms, end_ms: start_ms + 1 },
      text: "t",
    });
    const segments = [
      at(61_800),
      {
        speaker: "Others" as const,
        timing: { kind: "untimed" as const },
        text: "u",
      },
      at(4_503_000),
      at(61_200),
    ];
    expect(parseTimestamp("[1:01]")).toBe(61_000);
    expect(parseTimestamp("[01:01]")).toBe(61_000);
    expect(parseTimestamp("[75:03]")).toBe(4_503_000);
    expect(parseTimestamp("[1:15:03]")).toBe(4_503_000);
    expect(parseTimestamp("[9:99]")).toBeNull();
    expect(parseTimestamp("x [1:01]")).toBeNull();
    expect(segmentsAt(segments, 61_000)).toEqual([0, 3]);
    expect(segmentsAt(segments, 4_503_000)).toEqual([2]);
    expect(segmentsAt(segments, 62_000)).toEqual([]);
    expect(segmentsAt(segments, 0)).toEqual([]);
  });

  it("rejects malformed timestamps", () => {
    for (const text of ["[1:5]", "[00:60]", "[1:60:00]", "[ab:cd]", "1:02"])
      expect(timestampAtCaret(text, 0)).toBeNull();
  });
});
