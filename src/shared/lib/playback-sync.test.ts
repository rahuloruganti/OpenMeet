import { expect, it } from "vitest";
import { SYNC_DRIFT_MS, fileDriftMs, sessionFromFile } from "./playback-sync";

it("maps the leading file clock back to meeting time", () => {
  expect(sessionFromFile(8_000, 2_000, 4.5)).toBe(10_500);
});

it("sets the sync drift limit at 120ms", () => {
  expect(SYNC_DRIFT_MS).toBe(120);
});

it("reports signed file drift inside and beyond 120ms", () => {
  expect(fileDriftMs(2_000, 1_000, 4_000, 5.0625)).toBe(62.5);
  expect(
    Math.abs(fileDriftMs(2_000, 1_000, 4_000, 5.0625)),
  ).toBeLessThanOrEqual(SYNC_DRIFT_MS);
  expect(fileDriftMs(2_000, 1_000, 4_000, 4.9375)).toBe(-62.5);
  expect(
    Math.abs(fileDriftMs(2_000, 1_000, 4_000, 4.9375)),
  ).toBeLessThanOrEqual(SYNC_DRIFT_MS);
  expect(fileDriftMs(2_000, 1_000, 4_000, 5.25)).toBe(250);
  expect(Math.abs(fileDriftMs(2_000, 1_000, 4_000, 5.25))).toBeGreaterThan(
    SYNC_DRIFT_MS,
  );
  expect(fileDriftMs(2_000, 1_000, 4_000, 4.75)).toBe(-250);
  expect(Math.abs(fileDriftMs(2_000, 1_000, 4_000, 4.75))).toBeGreaterThan(
    SYNC_DRIFT_MS,
  );
});
