import { expect, it } from "vitest";
import { groupTurns } from "./turns";

it("merges same-speaker gaps of 0, 7000, and exactly 10000", () => {
  const zero = [
    { speaker: "Jordan", startMs: 0, text: "a" },
    { speaker: "Jordan", startMs: 0, text: "b" },
  ];
  expect(groupTurns(zero)).toEqual([
    { speaker: "Jordan", startMs: 0, segments: zero },
  ]);
  expect(groupTurns(zero)[0]?.segments[1]).toBe(zero[1]);

  const segments = [
    { speaker: "Jordan", startMs: 0, text: "open" },
    { speaker: "Jordan", startMs: 7_000, text: "middle" },
    { speaker: "Jordan", startMs: 17_000, text: "close" },
  ];
  const turns = groupTurns(segments);
  expect(turns).toEqual([
    { speaker: "Jordan", startMs: segments[0].startMs, segments },
  ]);
  expect(turns[0]?.segments[0]).toBe(segments[0]);
  expect(turns[0]?.segments[2]).toBe(segments[2]);
  expect(turns[0]?.segments).not.toBe(segments);
  expect(segments.map((segment) => segment.text)).toEqual([
    "open",
    "middle",
    "close",
  ]);
});

it("splits when the gap is 10001", () => {
  const segments = [
    { speaker: "Jordan", startMs: 0, text: "open" },
    { speaker: "Jordan", startMs: 10_001, text: "later" },
  ];
  const turns = groupTurns(segments);
  expect(turns).toEqual([
    { speaker: "Jordan", startMs: 0, segments: [segments[0]] },
    { speaker: "Jordan", startMs: 10_001, segments: [segments[1]] },
  ]);
  expect(turns[1]?.segments[0]).toBe(segments[1]);
});

it("splits on a speaker change even with a 1s gap", () => {
  const segments = [
    { speaker: "Jordan", startMs: 0, text: "open" },
    { speaker: "Morgan", startMs: 1_000, text: "reply" },
  ];
  expect(groupTurns(segments)).toEqual([
    { speaker: "Jordan", startMs: 0, segments: [segments[0]] },
    { speaker: "Morgan", startMs: 1_000, segments: [segments[1]] },
  ]);
});

it("joins an untimed segment to the same speaker without moving the turn start", () => {
  const segments = [
    { speaker: "Jordan", startMs: 4_000, text: "timed" },
    { speaker: "Jordan", startMs: null, text: "untimed" },
  ];
  const turns = groupTurns(segments);
  expect(turns).toEqual([{ speaker: "Jordan", startMs: 4_000, segments }]);
  expect(turns[0]?.segments[1]).toBe(segments[1]);
});

it("starts a new turn for an untimed segment after a different speaker", () => {
  const segments = [
    { speaker: "Jordan", startMs: 0, text: "timed" },
    { speaker: "Morgan", startMs: null, text: "untimed" },
  ];
  expect(groupTurns(segments)).toEqual([
    { speaker: "Jordan", startMs: 0, segments: [segments[0]] },
    { speaker: "Morgan", startMs: null, segments: [segments[1]] },
  ]);
});

it("starts a new turn when a timed segment follows an untimed same-speaker segment", () => {
  const segments = [
    { speaker: "Jordan", startMs: null, text: "untimed" },
    { speaker: "Jordan", startMs: 5_000, text: "timed" },
  ];
  expect(groupTurns(segments)).toEqual([
    { speaker: "Jordan", startMs: null, segments: [segments[0]] },
    { speaker: "Jordan", startMs: 5_000, segments: [segments[1]] },
  ]);
});
