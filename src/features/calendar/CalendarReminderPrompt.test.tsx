import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
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

// Fictional event, starting five minutes from now.
const reminder: CalendarReminder = {
  event_id: "evt-1",
  title: "Planning sync",
  start_utc: new Date(Date.now() + 5 * 60_000).toISOString(),
  has_link: false,
  related_count: 0,
};

let emit: (next: CalendarReminder) => void = () => undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.onCalendarReminder).mockImplementation(async (callback) => {
    emit = callback;
    return () => undefined;
  });
  vi.mocked(api.linkMeetingEvent).mockResolvedValue({} as never);
});

it("shows nothing without a reminder", () => {
  const { container } = render(
    <CalendarReminderPrompt
      reminder={null}
      onStart={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );

  expect(container.firstChild).toBeNull();
});

it("shows the minutes and the title, with both actions", async () => {
  const user = userEvent.setup();
  const onStart = vi.fn();
  const onDismiss = vi.fn();
  render(
    <CalendarReminderPrompt
      reminder={reminder}
      onStart={onStart}
      onDismiss={onDismiss}
    />,
  );

  expect(screen.getByRole("status").textContent).toMatch(
    /Starts in \d+ min: Planning sync/,
  );
  await user.click(screen.getByRole("button", { name: "Start recording" }));
  await user.click(screen.getByRole("button", { name: "Not now" }));

  expect(onStart).toHaveBeenCalledTimes(1);
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it("says it starts now when the start has passed", () => {
  render(
    <CalendarReminderPrompt
      reminder={{
        ...reminder,
        start_utc: new Date(Date.now() - 60_000).toISOString(),
      }}
      onStart={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );

  expect(screen.getByRole("status").textContent).toContain(
    "Starts now: Planning sync",
  );
});

it("counts down every 30 seconds and says it starts now once the start passes", () => {
  vi.useFakeTimers();
  try {
    const start = new Date(Date.now() + 90_000).toISOString();
    const { unmount } = render(
      <CalendarReminderPrompt
        reminder={{ ...reminder, start_utc: start }}
        onStart={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Starts in 2 min");

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByRole("status").textContent).toContain("Starts in 1 min");

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByRole("status").textContent).toContain(
      "Starts now: Planning sync",
    );

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

/** The hook plus the prompt, as App mounts them. meetingId stands for the recording's meeting id. */
function Harness({
  meetingId,
  onStart,
  onError,
}: {
  meetingId: string | null;
  onStart: (reminder: CalendarReminder) => void;
  onError: (f: unknown) => void;
}) {
  const calendar = useCalendarReminders({ meetingId, onStart, onError });
  return (
    <CalendarReminderPrompt
      reminder={calendar.reminder}
      onStart={calendar.start}
      onDismiss={calendar.dismiss}
    />
  );
}

it("prefills the dialog, then links the new meeting to the event", async () => {
  const user = userEvent.setup();
  const onStart = vi.fn();
  const onError = vi.fn();
  const { rerender } = render(
    <Harness meetingId={null} onStart={onStart} onError={onError} />,
  );
  await waitFor(() => expect(api.onCalendarReminder).toHaveBeenCalled());

  act(() => emit(reminder));
  await user.click(
    await screen.findByRole("button", { name: "Start recording" }),
  );

  expect(onStart).toHaveBeenCalledWith(reminder);
  expect(screen.queryByRole("status")).toBeNull();
  expect(api.linkMeetingEvent).not.toHaveBeenCalled();

  rerender(
    <Harness meetingId="meeting-new" onStart={onStart} onError={onError} />,
  );
  await waitFor(() =>
    expect(api.linkMeetingEvent).toHaveBeenCalledWith("meeting-new", "evt-1"),
  );
  expect(onError).not.toHaveBeenCalled();
});

it("does not link to a meeting that was already open when Start was pressed", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <Harness meetingId="meeting-old" onStart={vi.fn()} onError={vi.fn()} />,
  );
  await waitFor(() => expect(api.onCalendarReminder).toHaveBeenCalled());

  act(() => emit(reminder));
  await user.click(
    await screen.findByRole("button", { name: "Start recording" }),
  );
  rerender(
    <Harness meetingId="meeting-old" onStart={vi.fn()} onError={vi.fn()} />,
  );

  expect(api.linkMeetingEvent).not.toHaveBeenCalled();
});

it("reports a failed link through onError", async () => {
  const user = userEvent.setup();
  const failure = new Error("Calendar event not found.");
  vi.mocked(api.linkMeetingEvent).mockRejectedValue(failure);
  const onError = vi.fn();
  const { rerender } = render(
    <Harness meetingId={null} onStart={vi.fn()} onError={onError} />,
  );
  await waitFor(() => expect(api.onCalendarReminder).toHaveBeenCalled());

  act(() => emit(reminder));
  await user.click(
    await screen.findByRole("button", { name: "Start recording" }),
  );
  rerender(
    <Harness meetingId="meeting-new" onStart={vi.fn()} onError={onError} />,
  );

  await waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
});
