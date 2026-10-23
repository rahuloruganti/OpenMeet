import { describe, expect, it } from "vitest";
import type { Meeting } from "../../shared/api/api";
import { groupMeetings } from "./group-meetings";

const make = (id: string, started_at: string): Meeting => ({
  id,
  title: id,
  started_at,
  ended_at: null,
  status: "stopped",
  source: "fixture",
  capture_error: null,
  tags: [],
});

describe("groupMeetings", () => {
  const now = new Date(2026, 9, 10, 15, 0); // local Oct 10, 15:00

  it("groups by local calendar day, keeps order, omits empty groups", () => {
    const groups = groupMeetings(
      [
        make("a", new Date(2026, 9, 10, 9, 0).toISOString()),
        make("b", new Date(2026, 9, 9, 23, 59).toISOString()),
        make("c", new Date(2026, 9, 9, 0, 0).toISOString()),
        make("d", new Date(2026, 8, 1, 12, 0).toISOString()),
      ],
      now,
    );
    expect(groups.map((g) => [g.label, g.meetings.map((m) => m.id)])).toEqual([
      ["Today", ["a"]],
      ["Yesterday", ["b", "c"]],
      ["Earlier", ["d"]],
    ]);
    expect(groupMeetings([make("x", "2026-01-01T00:00:00Z")], now)).toEqual([
      { label: "Earlier", meetings: [expect.objectContaining({ id: "x" })] },
    ]);
  });

  it("puts unparseable dates in Earlier instead of dropping them", () => {
    const groups = groupMeetings([make("bad", "not a date")], now);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Earlier");
  });
});
