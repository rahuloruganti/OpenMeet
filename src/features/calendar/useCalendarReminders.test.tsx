import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CalendarReminder } from "../../shared/api/api";
import { api } from "../../shared/api/api";
import { CalendarReminderPrompt } from "./CalendarReminderPrompt";
import { useCalendarReminders } from "./useCalendarReminders";

vi.mock("../../shared/api/api", async (original) => ({
  ...(await original<typeof import("../../shared/api/api")>()),
  api: {
    onCalendarReminder: vi.fn(),
    linkMeetingEvent: vi.fn(),
  },
}));

// Fictional events, starting five minutes from now.
const event = (id: string, title = `Event ${id}`): CalendarReminder => ({
  event_id: id,
  title,
  start_utc: new Date(Date.now() + 5 * 60_000).toISOString(),
  has_link: false,
  related_count: 0,
});

let emit: (next: CalendarReminder) => void = () => undefined;
let calendar: ReturnType<typeof useCalendarReminders> | null = null;
const onStart = vi.fn();
const onError = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  calendar = null;
  vi.mocked(api.onCalendarReminder).mockImplementation(async (callback) => {
    emit = callback;
    return () => undefined;
  });
  vi.mocked(api.linkMeetingEvent).mockResolvedValue({} as never);
});

afterEach(() => {
  vi.useRealTimers();
});

function Harness({ meetingId }: { meetingId: string | null }) {
  const hook = useCalendarReminders({ meetingId, onStart, onError });
  calendar = hook;
  return (
    <CalendarReminderPrompt
      reminder={hook.reminder}
      onStart={hook.start}
      onDismiss={hook.dismiss}
    />
  );
}

/** Renders the harness and waits until the reminder subscription is live. */
async function mount(meetingId: string | null = null) {
  const view = render(<Harness meetingId={meetingId} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(api.onCalendarReminder).toHaveBeenCalled();
  return view;
}

const shownTitle = () => screen.queryByRole("status")?.textContent ?? "";

it("keeps an unseen reminder when a second one arrives", async () => {
  const user = userEvent.setup();
  await mount();

  act(() => emit(event("evt-1", "First")));
  act(() => emit(event("evt-2", "Second")));

  expect(shownTitle()).toContain("First");
  await user.click(screen.getByRole("button", { name: "Not now" }));
  expect(shownTitle()).toContain("Second");
  await user.click(screen.getByRole("button", { name: "Not now" }));
  expect(screen.queryByRole("status")).toBeNull();
});

it("Start passes the shown event on and advances to the next queued one", async () => {
  const user = userEvent.setup();
  await mount();

  act(() => emit(event("evt-1", "First")));
  act(() => emit(event("evt-2", "Second")));
  await user.click(screen.getByRole("button", { name: "Start recording" }));

  expect(onStart).toHaveBeenCalledWith(
    expect.objectContaining({ event_id: "evt-1" }),
  );
  expect(shownTitle()).toContain("Second");
});

it("de-duplicates queued reminders by event id", async () => {
  const user = userEvent.setup();
  await mount();

  act(() => emit(event("evt-1", "First")));
  act(() => emit(event("evt-1", "First")));
  act(() => emit(event("evt-2", "Second")));
  await user.click(screen.getByRole("button", { name: "Start recording" }));

  expect(onStart).toHaveBeenCalledTimes(1);
  expect(shownTitle()).toContain("Second");
  await user.click(screen.getByRole("button", { name: "Not now" }));
  expect(screen.queryByRole("status")).toBeNull();
});

it("does not link the next unrelated meeting after the dialog was cancelled", async () => {
  const user = userEvent.setup();
  const { rerender } = await mount(null);

  act(() => emit(event("evt-1")));
  await user.click(screen.getByRole("button", { name: "Start recording" }));
  // App calls clear() when the New recording dialog is cancelled or closed.
  act(() => calendar!.clear());

  rerender(<Harness meetingId="meeting-unrelated" />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(api.linkMeetingEvent).not.toHaveBeenCalled();
});

it("still links the meeting created from the calendar prompt", async () => {
  const user = userEvent.setup();
  const { rerender } = await mount(null);

  act(() => emit(event("evt-1")));
  await user.click(screen.getByRole("button", { name: "Start recording" }));
  rerender(<Harness meetingId="meeting-new" />);

  await waitFor(() =>
    expect(api.linkMeetingEvent).toHaveBeenCalledWith("meeting-new", "evt-1"),
  );
});

it("expires the pending link after two minutes", async () => {
  vi.useFakeTimers();
  const { rerender } = await mount(null);

  act(() => emit(event("evt-1")));
  fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
  act(() => {
    vi.advanceTimersByTime(2 * 60_000 + 1_000);
  });

  rerender(<Harness meetingId="meeting-late" />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(api.linkMeetingEvent).not.toHaveBeenCalled();
});

it("keeps the pending link inside the two-minute window", async () => {
  vi.useFakeTimers();
  const { rerender } = await mount(null);

  act(() => emit(event("evt-1")));
  fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
  act(() => {
    vi.advanceTimersByTime(2 * 60_000 - 1_000);
  });

  rerender(<Harness meetingId="meeting-soon" />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(api.linkMeetingEvent).toHaveBeenCalledWith("meeting-soon", "evt-1");
});

it("dismissing the prompt drops a pending link", async () => {
  const user = userEvent.setup();
  const { rerender } = await mount(null);

  act(() => emit(event("evt-1", "First")));
  act(() => emit(event("evt-2", "Second")));
  await user.click(screen.getByRole("button", { name: "Start recording" }));
  await user.click(screen.getByRole("button", { name: "Not now" }));

  rerender(<Harness meetingId="meeting-after-dismiss" />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(api.linkMeetingEvent).not.toHaveBeenCalled();
});
