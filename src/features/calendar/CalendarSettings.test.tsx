import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { CalendarFeed, Settings } from "../../shared/api/api";
import { api } from "../../shared/api/api";
import { initialSettings } from "../../shared/test/app-harness";
import { CalendarSettings } from "./CalendarSettings";

vi.mock("../../shared/api/api", async (original) => ({
  ...(await original<typeof import("../../shared/api/api")>()),
  api: {
    listCalendarFeeds: vi.fn(),
    addCalendarFeed: vi.fn(),
    removeCalendarFeed: vi.fn(),
    syncCalendars: vi.fn(),
    saveCalendarReminders: vi.fn(),
    onCalendarChanged: vi.fn(),
  },
}));

const settings: Settings = {
  ...initialSettings,
  calendar_reminders: true,
  calendar_reminder_minutes: 2,
};

// Fictional feed: the address is never part of the feed shape the UI receives.
const feed = (over: Partial<CalendarFeed> = {}): CalendarFeed => ({
  id: "feed-1",
  label: "Work calendar",
  kind: "ics",
  last_sync_at: "2026-10-26T08:00:00.000000Z",
  last_status: "ok",
  last_error: null,
  has_url: true,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listCalendarFeeds).mockResolvedValue([]);
  vi.mocked(api.onCalendarChanged).mockResolvedValue(vi.fn());
});

it("says a calendar is optional when none is added", async () => {
  render(<CalendarSettings settings={settings} disabled={false} />);

  expect(
    await screen.findByText("No calendar added. OpenMeet works without one."),
  ).toBeTruthy();
  expect(screen.getByText("Leaves this device")).toBeTruthy();
  expect(
    screen.getByText("The calendar address is fetched over HTTPS."),
  ).toBeTruthy();
});

it("lists feeds with their last sync and error", async () => {
  vi.mocked(api.listCalendarFeeds).mockResolvedValue([
    feed(),
    feed({
      id: "feed-2",
      label: "Team",
      last_status: "error",
      last_error: "The calendar answered with HTTP 404.",
    }),
  ]);
  render(<CalendarSettings settings={settings} disabled={false} />);

  expect(await screen.findByText("Work calendar")).toBeTruthy();
  expect(screen.getByText(/^Synced /)).toBeTruthy();
  expect(screen.getByText(/^Sync failed /)).toBeTruthy();
  expect(screen.getByText("The calendar answered with HTTP 404.")).toBeTruthy();
});

it("adds a calendar with the label and address, then clears the address field", async () => {
  const user = userEvent.setup();
  vi.mocked(api.addCalendarFeed).mockResolvedValue(feed());
  vi.mocked(api.listCalendarFeeds)
    .mockResolvedValueOnce([])
    .mockResolvedValue([feed()]);
  render(<CalendarSettings settings={settings} disabled={false} />);

  await user.click(await screen.findByRole("button", { name: "Add calendar" }));
  const form = screen.getByRole("form", { name: "Add calendar" });
  await user.type(within(form).getByLabelText("Label"), "Work calendar");
  await user.type(
    within(form).getByLabelText("iCal address"),
    "https://calendar.example.test/private/basic.ics",
  );
  await user.click(within(form).getByRole("button", { name: "Save calendar" }));

  await waitFor(() =>
    expect(api.addCalendarFeed).toHaveBeenCalledWith(
      "Work calendar",
      "https://calendar.example.test/private/basic.ics",
    ),
  );
  expect(await screen.findByText("Work calendar")).toBeTruthy();
  expect(screen.queryByRole("form", { name: "Add calendar" })).toBeNull();
});

it("shows the backend message when the address is rejected", async () => {
  const user = userEvent.setup();
  vi.mocked(api.addCalendarFeed).mockRejectedValue(
    Object.assign(
      new Error("Paste the secret iCal address that ends in .ics"),
      { code: "calendar_url" },
    ),
  );
  render(<CalendarSettings settings={settings} disabled={false} />);

  await user.click(await screen.findByRole("button", { name: "Add calendar" }));
  const form = screen.getByRole("form", { name: "Add calendar" });
  await user.type(within(form).getByLabelText("Label"), "Work");
  await user.type(
    within(form).getByLabelText("iCal address"),
    "http://example.test/a",
  );
  await user.click(within(form).getByRole("button", { name: "Save calendar" }));

  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("ends in .ics"),
  );
});

it("removes a feed and syncs all feeds on demand", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listCalendarFeeds)
    .mockResolvedValueOnce([feed()])
    .mockResolvedValue([]);
  vi.mocked(api.removeCalendarFeed).mockResolvedValue(undefined);
  vi.mocked(api.syncCalendars).mockResolvedValue([
    feed({ last_sync_at: "2026-10-26T09:00:00.000000Z" }),
  ]);
  render(<CalendarSettings settings={settings} disabled={false} />);

  await user.click(await screen.findByRole("button", { name: "Sync now" }));
  await waitFor(() => expect(api.syncCalendars).toHaveBeenCalledTimes(1));

  await user.click(
    screen.getByRole("button", { name: "Remove Work calendar" }),
  );
  await waitFor(() =>
    expect(api.removeCalendarFeed).toHaveBeenCalledWith("feed-1"),
  );
  expect(
    await screen.findByText("No calendar added. OpenMeet works without one."),
  ).toBeTruthy();
});

it("saves the reminder switch and minutes", async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  vi.mocked(api.saveCalendarReminders).mockResolvedValue({
    ...settings,
    calendar_reminders: false,
    calendar_reminder_minutes: 5,
  });
  render(
    <CalendarSettings settings={settings} disabled={false} onSaved={onSaved} />,
  );

  await user.click(screen.getByRole("switch", { name: "Calendar reminders" }));
  await waitFor(() =>
    expect(api.saveCalendarReminders).toHaveBeenCalledWith(false, 2),
  );
  await waitFor(() => expect(onSaved).toHaveBeenCalled());

  await user.selectOptions(screen.getByRole("combobox"), "5");
  // The switch is off after the first save, so the minutes change keeps reminders off.
  await waitFor(() =>
    expect(api.saveCalendarReminders).toHaveBeenLastCalledWith(false, 5),
  );
});

it("disables every control while settings are disabled", async () => {
  vi.mocked(api.listCalendarFeeds).mockResolvedValue([feed()]);
  render(<CalendarSettings settings={settings} disabled />);

  expect(
    (await screen.findByRole("button", {
      name: "Add calendar",
    })) as HTMLButtonElement,
  ).toHaveProperty("disabled", true);
  expect(
    (
      screen.getByRole("switch", {
        name: "Calendar reminders",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("closing the form clears the label and the address", async () => {
  const user = userEvent.setup();
  render(<CalendarSettings settings={settings} disabled={false} />);

  await user.click(await screen.findByRole("button", { name: "Add calendar" }));
  let form = screen.getByRole("form", { name: "Add calendar" });
  await user.type(within(form).getByLabelText("Label"), "Work calendar");
  await user.type(
    within(form).getByLabelText("iCal address"),
    "https://calendar.example.test/private/basic.ics",
  );
  await user.click(within(form).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("form", { name: "Add calendar" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Add calendar" }));
  form = screen.getByRole("form", { name: "Add calendar" });
  expect((within(form).getByLabelText("Label") as HTMLInputElement).value).toBe(
    "",
  );
  expect(
    (within(form).getByLabelText("iCal address") as HTMLInputElement).value,
  ).toBe("");
});

it("the Add calendar toggle clears the form when it closes it", async () => {
  const user = userEvent.setup();
  render(<CalendarSettings settings={settings} disabled={false} />);

  await user.click(await screen.findByRole("button", { name: "Add calendar" }));
  const form = screen.getByRole("form", { name: "Add calendar" });
  await user.type(within(form).getByLabelText("Label"), "Work");
  await user.type(
    within(form).getByLabelText("iCal address"),
    "https://calendar.example.test/private/basic.ics",
  );
  await user.click(screen.getByRole("button", { name: "Add calendar" }));
  expect(screen.queryByRole("form", { name: "Add calendar" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Add calendar" }));
  const reopened = screen.getByRole("form", { name: "Add calendar" });
  expect(
    (within(reopened).getByLabelText("Label") as HTMLInputElement).value,
  ).toBe("");
  expect(
    (within(reopened).getByLabelText("iCal address") as HTMLInputElement).value,
  ).toBe("");
});

it("a rejected add keeps the label, clears the address and shows the error", async () => {
  const user = userEvent.setup();
  vi.mocked(api.addCalendarFeed).mockRejectedValue(
    Object.assign(
      new Error("Paste the secret iCal address that ends in .ics"),
      {
        code: "calendar_url",
      },
    ),
  );
  render(<CalendarSettings settings={settings} disabled={false} />);

  await user.click(await screen.findByRole("button", { name: "Add calendar" }));
  const form = screen.getByRole("form", { name: "Add calendar" });
  await user.type(within(form).getByLabelText("Label"), "Work");
  await user.type(
    within(form).getByLabelText("iCal address"),
    "http://example.test/a",
  );
  await user.click(within(form).getByRole("button", { name: "Save calendar" }));

  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("ends in .ics"),
  );
  expect((within(form).getByLabelText("Label") as HTMLInputElement).value).toBe(
    "Work",
  );
  expect(
    (within(form).getByLabelText("iCal address") as HTMLInputElement).value,
  ).toBe("");
});

it("a fresh mount starts with an empty add form", async () => {
  const user = userEvent.setup();
  const first = render(
    <CalendarSettings settings={settings} disabled={false} />,
  );

  await user.click(await screen.findByRole("button", { name: "Add calendar" }));
  const form = screen.getByRole("form", { name: "Add calendar" });
  await user.type(within(form).getByLabelText("Label"), "Work");
  await user.type(
    within(form).getByLabelText("iCal address"),
    "https://calendar.example.test/private/basic.ics",
  );
  first.unmount();

  render(<CalendarSettings settings={settings} disabled={false} />);
  await user.click(await screen.findByRole("button", { name: "Add calendar" }));
  const reopened = screen.getByRole("form", { name: "Add calendar" });
  expect(
    (within(reopened).getByLabelText("Label") as HTMLInputElement).value,
  ).toBe("");
  expect(
    (within(reopened).getByLabelText("iCal address") as HTMLInputElement).value,
  ).toBe("");
});
