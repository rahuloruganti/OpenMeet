import { act, render, screen, waitFor, within } from "@testing-library/react";
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

// Fictional calendar data only. The component itself is never mocked.
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
  related: MeetingPreparation["related"] = [],
): MeetingPreparation => ({ event: event(), related });
const START = "2026-10-26T09:00:00.000Z";
const row = (
  props: Partial<Parameters<typeof CalendarEventRow>[0]> = {},
  key = "m1",
) => (
  <CalendarEventRow
    key={key}
    meetingId="m1"
    startedAt={START}
    eventId={null}
    disabled={false}
    {...props}
  />
);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.listCalendarEvents).mockResolvedValue([]);
  vi.mocked(api.meetingPreparation).mockResolvedValue(preparation());
  vi.mocked(api.linkMeetingEvent).mockResolvedValue({} as never);
});

it("offers one compact calendar-icon disclosure without fetching until opened", () => {
  render(row());
  const trigger = screen.getByRole("button", { name: "Link to event" });
  expect(trigger.querySelector("svg")).not.toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.getAttribute("aria-controls")).toBeTruthy();
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(screen.queryByRole("group", { name: "Calendar events" })).toBeNull();
  expect(api.listCalendarEvents).not.toHaveBeenCalled();
  expect(api.meetingPreparation).not.toHaveBeenCalled();
});

it("opens by keyboard and retains the trigger to toggle the picker closed", async () => {
  const user = userEvent.setup();
  render(row());
  const trigger = screen.getByRole("button", { name: "Link to event" });
  await user.tab();
  expect(document.activeElement).toBe(trigger);
  await user.keyboard("{Enter}");
  const picker = await screen.findByRole("group", { name: "Calendar events" });
  expect(picker.id).toBe(trigger.getAttribute("aria-controls"));
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await user.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("group", { name: "Calendar events" })).toBeNull();
});

it("dismisses with Escape and restores focus without bubbling to meeting navigation", async () => {
  const user = userEvent.setup();
  const onKeyDown = vi.fn();
  render(<div onKeyDown={onKeyDown}>{row()}</div>);
  const trigger = screen.getByRole("button", { name: "Link to event" });
  await user.click(trigger);
  await user.tab();
  onKeyDown.mockClear();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("group", { name: "Calendar events" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(onKeyDown).not.toHaveBeenCalled();
});

it("dismisses on an outside click without stealing focus", async () => {
  const user = userEvent.setup();
  render(
    <>
      {row()}
      <button type="button">Outside</button>
    </>,
  );
  const trigger = screen.getByRole("button", { name: "Link to event" });
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "Outside" }));
  expect(screen.queryByRole("group", { name: "Calendar events" })).toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Outside" }),
  );
});

it("shows loading only while the event list is pending", async () => {
  const user = userEvent.setup();
  const pending = deferred<CalendarEvent[]>();
  vi.mocked(api.listCalendarEvents).mockReturnValue(pending.promise);
  render(row());
  await user.click(screen.getByRole("button", { name: "Link to event" }));
  expect(screen.getByRole("status").textContent).toBe("Loading events…");
  await act(async () => pending.resolve([]));
  expect(screen.queryByText("Loading events…")).toBeNull();
  expect(screen.getByText("No calendar events within one day.")).toBeTruthy();
});

it("lists events within one day and links the chosen event without changing the payload", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listCalendarEvents).mockResolvedValue([
    event(),
    event({ id: "evt-2", title: "Design review" }),
  ]);
  render(row());
  await user.click(screen.getByRole("button", { name: "Link to event" }));
  const picker = await screen.findByRole("group", { name: "Calendar events" });
  expect(api.listCalendarEvents).toHaveBeenCalledWith(
    "2026-10-25T09:00:00.000Z",
    "2026-10-27T09:00:00.000Z",
  );
  await user.click(
    within(picker).getByRole("button", { name: /Design review/ }),
  );
  await waitFor(() =>
    expect(api.linkMeetingEvent).toHaveBeenCalledWith("m1", "evt-2"),
  );
  expect(screen.queryByRole("group", { name: "Calendar events" })).toBeNull();
});

it("shows the empty-list explanation inside the picker", async () => {
  const user = userEvent.setup();
  render(row());
  await user.click(screen.getByRole("button", { name: "Link to event" }));
  const picker = screen.getByRole("group", { name: "Calendar events" });
  expect(
    await within(picker).findByText("No calendar events within one day."),
  ).toBeTruthy();
});

it("keeps a list failure visible without claiming it is loading or empty", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listCalendarEvents).mockRejectedValue(
    new Error("Calendar is unavailable."),
  );
  render(row());
  await user.click(screen.getByRole("button", { name: "Link to event" }));
  const picker = screen.getByRole("group", { name: "Calendar events" });
  expect((await within(picker).findByRole("alert")).textContent).toBe(
    "Calendar is unavailable.",
  );
  expect(screen.queryByText("Loading events…")).toBeNull();
  expect(screen.queryByText("No calendar events within one day.")).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Link to event" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
});

it("retries loading after dismissing and reopening a failed picker", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listCalendarEvents)
    .mockRejectedValueOnce(new Error("Calendar is unavailable."))
    .mockResolvedValueOnce([event()]);
  render(row());
  const trigger = screen.getByRole("button", { name: "Link to event" });
  await user.click(trigger);
  await screen.findByRole("alert");
  await user.keyboard("{Escape}");
  await user.click(trigger);
  expect(
    await screen.findByRole("button", { name: /Weekly sync/ }),
  ).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.listCalendarEvents).toHaveBeenCalledTimes(2);
});

it("hides linked details until disclosed and preserves earlier-meeting navigation", async () => {
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
  render(row({ eventId: "evt-1", onOpenMeeting }));
  const trigger = await screen.findByRole("button", { name: "Weekly sync" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("Earlier: 2")).toBeNull();
  expect(screen.queryByRole("button", { name: "Unlink" })).toBeNull();
  await user.click(trigger);
  const details = screen.getByRole("group", { name: "Calendar event" });
  expect(within(details).getByText("Earlier: 2")).toBeTruthy();
  await user.click(
    within(details).getAllByRole("button", { name: "Weekly sync" })[0],
  );
  expect(onOpenMeeting).toHaveBeenCalledExactlyOnceWith("m-0");
  expect(screen.queryByRole("group", { name: "Calendar event" })).toBeNull();
});

it("leaves the current meeting out of linked details", async () => {
  const user = userEvent.setup();
  vi.mocked(api.meetingPreparation).mockResolvedValue(
    preparation([
      {
        meeting_id: "m1",
        title: "Weekly sync",
        started_at: START,
        summary_excerpt: null,
      },
    ]),
  );
  render(row({ eventId: "evt-1" }));
  await user.click(await screen.findByRole("button", { name: "Weekly sync" }));
  expect(screen.queryByText(/Earlier:/)).toBeNull();
  expect(
    within(screen.getByRole("group", { name: "Calendar event" })).queryByRole(
      "button",
      { name: "Weekly sync" },
    ),
  ).toBeNull();
});

it("preserves the full linked title in the compact trigger's accessible name and tooltip", async () => {
  const title =
    "Fictional weekly planning with the design and operations teams for the coming quarter";
  vi.mocked(api.meetingPreparation).mockResolvedValue({
    event: event({ title }),
    related: [],
  });
  render(row({ eventId: "evt-1" }));
  const trigger = await screen.findByRole("button", { name: title });
  expect(trigger.title).toBe(title);
  expect(trigger.querySelector(".cal-trigger-title")?.textContent).toBe(title);
  expect(screen.queryByRole("group", { name: "Calendar event" })).toBeNull();
});

it("unlinks from the details dropdown without changing the payload", async () => {
  const user = userEvent.setup();
  render(row({ eventId: "evt-1" }));
  await user.click(await screen.findByRole("button", { name: "Weekly sync" }));
  await user.click(screen.getByRole("button", { name: "Unlink" }));
  await waitFor(() =>
    expect(api.linkMeetingEvent).toHaveBeenCalledWith("m1", null),
  );
  expect(
    await screen.findByRole("button", { name: "Link to event" }),
  ).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Calendar event" })).toBeNull();
});

it("shows pending linked-event loading only in its disclosed details", async () => {
  const user = userEvent.setup();
  const pending = deferred<MeetingPreparation>();
  vi.mocked(api.meetingPreparation).mockReturnValue(pending.promise);
  render(row({ eventId: "evt-1" }));
  await user.click(screen.getByRole("button", { name: "Loading event…" }));
  expect(screen.getByRole("status").textContent).toBe("Loading event…");
  await act(async () => pending.resolve(preparation()));
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("button", { name: "Weekly sync" })).toBeTruthy();
});

it("keeps preparation errors readable with an Unlink action and no false loading", async () => {
  const user = userEvent.setup();
  vi.mocked(api.meetingPreparation).mockRejectedValue(
    new Error("Calendar event not found."),
  );
  render(row({ eventId: "evt-1" }));
  const trigger = await screen.findByRole("button", { name: "Linked event" });
  await user.click(trigger);
  expect(screen.getByRole("alert").textContent).toBe(
    "Calendar event not found.",
  );
  expect(screen.queryByText("Loading event…")).toBeNull();
  expect(screen.getByRole("button", { name: "Unlink" })).toBeTruthy();
});

it("does not open or fetch choices when disabled", async () => {
  const user = userEvent.setup();
  render(row({ disabled: true }));
  const trigger = screen.getByRole("button", { name: "Link to event" });
  expect((trigger as HTMLButtonElement).disabled).toBe(true);
  await user.click(trigger);
  expect(api.listCalendarEvents).not.toHaveBeenCalled();
  expect(screen.queryByRole("group", { name: "Calendar events" })).toBeNull();
});

it("disables linking while pending and preserves choices and errors after failure", async () => {
  const user = userEvent.setup();
  const pending = deferred<never>();
  vi.mocked(api.listCalendarEvents).mockResolvedValue([event()]);
  vi.mocked(api.linkMeetingEvent).mockReturnValue(pending.promise);
  render(row());
  await user.click(screen.getByRole("button", { name: "Link to event" }));
  const choice = await screen.findByRole("button", { name: /Weekly sync/ });
  await user.click(choice);
  expect((choice as HTMLButtonElement).disabled).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Link to event" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () =>
    pending.reject(new Error("Could not link this event.")),
  );
  expect(screen.getByRole("alert").textContent).toBe(
    "Could not link this event.",
  );
  expect((choice as HTMLButtonElement).disabled).toBe(false);
  expect(
    screen
      .getByRole("button", { name: "Link to event" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
});

it("disables unlink and earlier navigation when the meeting becomes disabled", async () => {
  const user = userEvent.setup();
  const onOpenMeeting = vi.fn();
  vi.mocked(api.meetingPreparation).mockResolvedValue(
    preparation([
      {
        meeting_id: "m-0",
        title: "Earlier sync",
        started_at: START,
        summary_excerpt: null,
      },
    ]),
  );
  const view = render(row({ eventId: "evt-1", onOpenMeeting }));
  await user.click(await screen.findByRole("button", { name: "Weekly sync" }));
  view.rerender(row({ eventId: "evt-1", onOpenMeeting, disabled: true }));
  expect(
    (screen.getByRole("button", { name: "Unlink" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Earlier sync" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "Earlier sync" }));
  expect(onOpenMeeting).not.toHaveBeenCalled();
  expect(api.linkMeetingEvent).not.toHaveBeenCalled();
});

it.each(["resolve", "reject"] as const)(
  "ignores a picker %s after unmount during navigation",
  async (outcome) => {
    const user = userEvent.setup();
    const pending = deferred<CalendarEvent[]>();
    vi.mocked(api.listCalendarEvents)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue([]);
    const view = render(row());
    await user.click(screen.getByRole("button", { name: "Link to event" }));
    view.rerender(row({ meetingId: "m2" }, "m2"));
    await user.click(screen.getByRole("button", { name: "Link to event" }));
    await screen.findByText("No calendar events within one day.");
    await act(async () => {
      if (outcome === "resolve")
        pending.resolve([event({ title: "Old meeting event" })]);
      else pending.reject(new Error("Old meeting failure."));
    });
    expect(screen.queryByText("Old meeting event")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("No calendar events within one day.")).toBeTruthy();
  },
);

it("ignores pending linking after unmount without fetching stale preparation", async () => {
  const user = userEvent.setup();
  const pending = deferred<never>();
  vi.mocked(api.listCalendarEvents).mockResolvedValue([event()]);
  vi.mocked(api.linkMeetingEvent).mockReturnValue(pending.promise);
  const view = render(row());
  await user.click(screen.getByRole("button", { name: "Link to event" }));
  await user.click(await screen.findByRole("button", { name: /Weekly sync/ }));
  view.rerender(row({ meetingId: "m2" }, "m2"));
  await act(async () => pending.resolve({} as never));
  expect(
    screen
      .getByRole("button", { name: "Link to event" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(api.meetingPreparation).not.toHaveBeenCalled();
});

it("returns keyboard focus to the trigger after linking completes", async () => {
  const user = userEvent.setup();
  const pending = deferred<never>();
  vi.mocked(api.listCalendarEvents).mockResolvedValue([event()]);
  vi.mocked(api.linkMeetingEvent).mockReturnValue(pending.promise);
  render(row());
  await user.click(screen.getByRole("button", { name: "Link to event" }));
  const choice = await screen.findByRole("button", { name: /Weekly sync/ });
  choice.focus();
  await user.keyboard("{Enter}");
  await act(async () => pending.resolve({} as never));

  const trigger = await screen.findByRole("button", { name: "Weekly sync" });
  expect(document.activeElement).toBe(trigger);
});

it("preserves linked details and the error when unlinking fails", async () => {
  const user = userEvent.setup();
  vi.mocked(api.linkMeetingEvent).mockRejectedValue(
    new Error("Could not unlink this event."),
  );
  render(row({ eventId: "evt-1" }));
  await user.click(await screen.findByRole("button", { name: "Weekly sync" }));
  await user.click(screen.getByRole("button", { name: "Unlink" }));

  expect((await screen.findByRole("alert")).textContent).toBe(
    "Could not unlink this event.",
  );
  expect(
    screen
      .getByRole("button", { name: "Weekly sync" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(
    (screen.getByRole("button", { name: "Unlink" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

it.each(["resolve", "reject"] as const)(
  "ignores a preparation %s after unmount during navigation",
  async (outcome) => {
    const pending = deferred<MeetingPreparation>();
    vi.mocked(api.meetingPreparation).mockReturnValue(pending.promise);
    const view = render(row({ eventId: "evt-1" }));
    await waitFor(() =>
      expect(api.meetingPreparation).toHaveBeenCalledWith("evt-1"),
    );
    view.rerender(row({ meetingId: "m2" }, "m2"));
    await act(async () => {
      if (outcome === "resolve") pending.resolve(preparation());
      else pending.reject(new Error("Old preparation failure."));
    });
    expect(
      screen
        .getByRole("button", { name: "Link to event" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(screen.queryByText("Weekly sync")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  },
);
