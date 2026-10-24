import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Meeting } from "../../shared/api/api";
import { formatShortDate, formatTime } from "../../entities/meeting";
import { MeetingSidebar } from "./MeetingSidebar";

const at = (date: Date): string => date.toISOString();
const now = new Date();
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 30);
const earlier = new Date(
  now.getFullYear(),
  now.getMonth(),
  now.getDate() - 5,
  9,
  30,
);

const make = (
  id: string,
  title: string,
  started: Date,
  tags: string[] = [],
): Meeting => ({
  id,
  title,
  started_at: at(started),
  ended_at: null,
  status: "stopped",
  source: "desktop",
  capture_error: null,
  tags,
});

function sidebar(meetings: Meeting[], search = "") {
  render(
    <MeetingSidebar
      open
      meetings={meetings}
      search={search}
      selectedId={undefined}
      disabled={false}
      recordingActive={false}
      onSearch={vi.fn()}
      onNewRecording={vi.fn()}
      onSettings={vi.fn()}
      onAsk={vi.fn()}
      onOpenMeeting={vi.fn()}
      onNewNote={vi.fn()}
      hits={[]}
      onOpenHit={vi.fn()}
      audioBytes={null}
    />,
  );
}

const row = (name: RegExp) => screen.getByRole("button", { name });

describe("meeting sidebar", () => {
  it("filters with folded text in either direction", () => {
    sidebar(
      [
        make("cafe", "Café review", today),
        make("ang", "Ångström sync", earlier),
        make("b", "Budget", earlier),
      ],
      "cafe",
    );
    expect(screen.queryByRole("button", { name: /Ångström/ })).toBeNull();
    expect(row(/Café review/)).toBeTruthy();
  });

  it("filters with a folded search written without accents", () => {
    sidebar(
      [make("ang", "Ångström sync", earlier), make("b", "Budget", earlier)],
      "angstrom",
    );
    expect(row(/Ångström sync/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Budget/ })).toBeNull();
  });

  it("shows start times for Today and Yesterday and dates for earlier meetings", () => {
    sidebar([make("t", "Standup", today), make("e", "Retro", earlier)]);
    const todayRow = within(row(/Standup/));
    expect(todayRow.getByText(formatTime(at(today)))).toBeTruthy();
    const earlierRow = within(row(/Retro/));
    expect(earlierRow.getByText(formatShortDate(at(earlier)))).toBeTruthy();
  });

  it("keeps two same-day, same-title meetings distinguishable by start time", () => {
    const morning = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      8,
      5,
    );
    const afternoon = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      15,
      45,
    );
    sidebar([make("a", "Sync", morning), make("b", "Sync", afternoon)]);
    const rows = screen.getAllByRole("button", { name: /Sync/ });
    expect(rows[0].querySelector("time")?.textContent).toBe(
      formatTime(at(morning)),
    );
    expect(rows[1].querySelector("time")?.textContent).toBe(
      formatTime(at(afternoon)),
    );
    expect(rows[0].querySelector("time")?.textContent).not.toBe(
      rows[1].querySelector("time")?.textContent,
    );
  });

  it("shows at most three tags with a count, and the full list in a title", () => {
    sidebar([
      make("tags", "Planning", today, [
        "Alpha",
        "Beta",
        "Gamma",
        "Delta",
        "Epsilon",
      ]),
    ]);
    const meta = row(/Planning/).querySelector(".meeting-tags") as HTMLElement;
    expect(meta.textContent).toBe(" · Alpha, Beta, Gamma +2");
    expect(meta.getAttribute("title")).toBe(
      "Alpha, Beta, Gamma, Delta, Epsilon",
    );
  });

  it("shows all tags without a count when there are three or fewer", () => {
    sidebar([make("tags", "Planning", today, ["Alpha", "Beta"])]);
    const meta = row(/Planning/).querySelector(".meeting-tags") as HTMLElement;
    expect(meta.textContent).toBe(" · Alpha, Beta");
    expect(meta.getAttribute("title")).toBe("Alpha, Beta");
  });
});
