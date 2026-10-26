import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { CalendarEvent, MeetingPreparation } from "../../shared/api/api";
import { api } from "../../shared/api/api";
import { CalendarEventRow } from "./CalendarEventRow";

vi.mock("../../shared/api/api", async (original) => ({
  ...(await original<typeof import("../../shared/api/api")>()),
  api: {
    meetingPreparation: vi.fn(),
    listCalendarEvents: vi.fn(),
    linkMeetingEvent: vi.fn(),
  },
}));

// Fictional calendar data only.
const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "evt-1",
  feed_id: "feed-1",
  title: "Weekly sync",
  start_utc: "2026-10-26T09:00:00.000000Z",
  end_utc: "2026-10-26T09:30:00.000000Z",
  all_day: false,
  location: null,
  status: "confirmed",
  attendees: [],
  has_link: false,
  ...over,
});

const preparation = (
  related: MeetingPreparation["related"],
): MeetingPreparation => ({
  event: event(),
  related,
});

const START = "2026-10-26T09:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.linkMeetingEvent).mockResolvedValue({} as never);
});

it("offers to link when the meeting has no event", () => {
  render(
    <CalendarEventRow
      meetingId="m1"
      startedAt={START}
      eventId={null}
      disabled={false}
    />,
  );

  expect(screen.getByRole("button", { name: "Link to event" })).toBeTruthy();
  expect(api.meetingPreparation).not.toHaveBeenCalled();
});

it("lists events within one day of the meeting start and links the chosen one", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listCalendarEvents).mockResolvedValue([
    event(),
    event({ id: "evt-2", title: "Design review" }),
  ]);
  render(
    <CalendarEventRow
      meetingId="m1"
      startedAt={START}
      eventId={null}
      disabled={false}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Link to event" }));
  const group = await screen.findByRole("group", { name: "Calendar events" });

  expect(api.listCalendarEvents).toHaveBeenCalledWith(
    "2026-10-25T09:00:00.000Z",
    "2026-10-27T09:00:00.000Z",
  );
  await user.click(
    within(group).getByRole("button", { name: /Design review/ }),
  );

  await waitFor(() =>
    expect(api.linkMeetingEvent).toHaveBeenCalledWith("m1", "evt-2"),
  );
  expect(screen.queryByRole("group", { name: "Calendar events" })).toBeNull();
});

it("says so when no event is within one day", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listCalendarEvents).mockResolvedValue([]);
  render(
    <CalendarEventRow
      meetingId="m1"
      startedAt={START}
      eventId={null}
      disabled={false}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Link to event" }));

  expect(
    await screen.findByText("No calendar events within one day."),
  ).toBeTruthy();
});

it("shows the linked title, earlier meetings, and opens one of them", async () => {
  const user = userEvent.setup();
  const onOpenMeeting = vi.fn();
  vi.mocked(api.meetingPreparation).mockResolvedValue(
    preparation([
      {
        meeting_id: "m-0",
        title: "Weekly sync",
        started_at: "2026-10-19T09:00:00.000Z",
        summary_excerpt: null,
      },
      {
        meeting_id: "m-9",
        title: "Weekly sync",
        started_at: "2026-10-12T09:00:00.000Z",
        summary_excerpt: null,
      },
    ]),
  );
  render(
    <CalendarEventRow
      meetingId="m1"
      startedAt={START}
      eventId="evt-1"
      disabled={false}
      onOpenMeeting={onOpenMeeting}
    />,
  );

  expect(
    await screen.findByText("Weekly sync", { selector: "strong" }),
  ).toBeTruthy();
  expect(screen.getByText("Earlier: 2")).toBeTruthy();
  // Both earlier meetings share the series title; the newest comes first.
  await user.click(screen.getAllByRole("button", { name: "Weekly sync" })[0]);

  expect(onOpenMeeting).toHaveBeenCalledWith("m-0");
});

it("leaves out the meeting itself from the earlier list", async () => {
  vi.mocked(api.meetingPreparation).mockResolvedValue(
    preparation([
      {
        meeting_id: "m1",
        title: "Weekly sync",
        started_at: "2026-10-19T09:00:00.000Z",
        summary_excerpt: null,
      },
    ]),
  );
  render(
    <CalendarEventRow
      meetingId="m1"
      startedAt={START}
      eventId="evt-1"
      disabled={false}
    />,
  );

  await screen.findByText("Weekly sync");
  expect(screen.queryByText(/Earlier:/)).toBeNull();
});

it("unlinks the event", async () => {
  const user = userEvent.setup();
  vi.mocked(api.meetingPreparation).mockResolvedValue(preparation([]));
  render(
    <CalendarEventRow
      meetingId="m1"
      startedAt={START}
      eventId="evt-1"
      disabled={false}
    />,
  );

  await screen.findByText("Weekly sync");
  await user.click(screen.getByRole("button", { name: "Unlink" }));

  await waitFor(() =>
    expect(api.linkMeetingEvent).toHaveBeenCalledWith("m1", null),
  );
  expect(
    await screen.findByRole("button", { name: "Link to event" }),
  ).toBeTruthy();
});

it("says the event is gone when its preparation cannot be read", async () => {
  vi.mocked(api.meetingPreparation).mockRejectedValue(
    new Error("Calendar event not found."),
  );
  render(
    <CalendarEventRow
      meetingId="m1"
      startedAt={START}
      eventId="evt-1"
      disabled={false}
    />,
  );

  expect(
    await screen.findByText("The linked event is no longer in your calendar."),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Unlink" })).toBeTruthy();
});
