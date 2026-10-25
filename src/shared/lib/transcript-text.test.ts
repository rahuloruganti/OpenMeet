import { expect, it } from "vitest";
import {
  findInSegments,
  formatClock,
  formatTranscript,
} from "./transcript-text";

it("formats a clock without brackets or padded minutes under an hour", () => {
  expect(formatClock(0)).toBe("0:00");
  expect(formatClock(2_000)).toBe("0:02");
  expect(formatClock(8_250)).toBe("0:08");
  expect(formatClock(61_000)).toBe("1:01");
  expect(formatClock(3_723_000)).toBe("1:02:03");
  expect(formatClock(-1)).toBe("0:00");
  expect(formatClock(-1_500)).toBe("0:00");
  expect(formatClock(Number.NaN)).toBe("0:00");
});

it("formats timed and untimed turns with one blank line and no trailing newline", () => {
  const text = formatTranscript([
    {
      label: "Jordan (You)",
      startMs: 2_000,
      text: "Okay, let's start. I want the invite locked.",
    },
    {
      label: "Morgan (Others)",
      startMs: null,
      text: "Notes from the shared doc will land later.",
    },
  ]);
  expect(text).toBe(
    [
      "Jordan (You) 0:02",
      "Okay, let's start. I want the invite locked.",
      "",
      "Morgan (Others)",
      "Notes from the shared doc will land later.",
    ].join("\n"),
  );
  expect(text.endsWith("\n")).toBe(false);
});

it("finds case-insensitive non-overlapping matches and ignores a blank query", () => {
  expect(findInSegments(["Export the EXPORT"], "export")).toEqual([
    { segmentIndex: 0, start: 0, end: 6 },
    { segmentIndex: 0, start: 11, end: 17 },
  ]);
  expect(findInSegments(["no", "EXPORT"], "  Export  ")).toEqual([
    { segmentIndex: 1, start: 0, end: 6 },
  ]);
  expect(findInSegments(["notes"], "export")).toEqual([]);
  expect(findInSegments(["export"], "")).toEqual([]);
  expect(findInSegments(["export"], "   ")).toEqual([]);
  expect(findInSegments(["lock. the lockX"], "lock.")).toEqual([
    { segmentIndex: 0, start: 0, end: 5 },
  ]);
  expect(findInSegments(["banana"], "ana")).toEqual([
    { segmentIndex: 0, start: 1, end: 4 },
  ]);
});
