import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api, type ActionItem } from "../lib/api";
import { ActionItems } from "./ActionItems";
vi.mock("../lib/api", async (original) => ({
  ...(await original<typeof import("../lib/api")>()),
  api: {
    saveActionItem: vi.fn(),
    deleteActionItem: vi.fn(),
    importActionItems: vi.fn(),
  },
}));
const task: ActionItem = {
  id: 7,
  text: "Send the deck",
  owner: null,
  due_date: null,
  done: false,
  source: "summary",
  summary_id: 3,
};
beforeEach(() => vi.resetAllMocks());

it("adds, edits, completes, imports and deletes tasks, keeping unknowns explicit", async () => {
  const onItems = vi.fn();
  vi.mocked(api.saveActionItem).mockResolvedValue([task]);
  vi.mocked(api.importActionItems).mockResolvedValue([task]);
  vi.mocked(api.deleteActionItem).mockResolvedValue([]);
  render(
    <ActionItems
      meetingId="m1"
      items={[task]}
      summaryId={3}
      disabled={false}
      onItems={onItems}
    />,
  );
  expect(screen.getByText("From summary")).toBeTruthy();
  expect(
    (screen.getByLabelText("Owner: Send the deck") as HTMLInputElement)
      .placeholder,
  ).toBe("Unassigned");
  await userEvent.type(screen.getByLabelText("New task"), "Book a room");
  await userEvent.click(screen.getByRole("button", { name: "Add task" }));
  expect(api.saveActionItem).toHaveBeenCalledWith(
    "m1",
    null,
    "Book a room",
    null,
    null,
    false,
  );
  expect(onItems).toHaveBeenCalledWith([task]);
  const text = screen.getByLabelText("Task: Send the deck");
  await userEvent.clear(text);
  await userEvent.type(text, "Send the final deck");
  await userEvent.tab();
  expect(api.saveActionItem).toHaveBeenLastCalledWith(
    "m1",
    7,
    "Send the final deck",
    null,
    null,
    false,
  );
  await userEvent.click(screen.getByLabelText("Done: Send the deck"));
  expect(api.saveActionItem).toHaveBeenLastCalledWith(
    "m1",
    7,
    "Send the deck",
    null,
    null,
    true,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Add from summary" }),
  );
  expect(api.importActionItems).toHaveBeenCalledWith("m1", 3);
  await userEvent.click(
    screen.getByRole("button", { name: "Delete task: Send the deck" }),
  );
  expect(api.deleteActionItem).toHaveBeenCalledWith("m1", 7);
});

it("shows a failed save and keeps the typed text", async () => {
  vi.mocked(api.saveActionItem).mockRejectedValue({
    code: "action_item",
    message: "Keep the owner on one line, at most 80 characters.",
  });
  render(
    <ActionItems
      meetingId="m1"
      items={[task]}
      summaryId={null}
      disabled={false}
      onItems={vi.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: "Add from summary" })).toBeNull();
  await userEvent.type(screen.getByLabelText("Owner: Send the deck"), "Alex");
  await userEvent.tab();
  expect((await screen.findByRole("alert")).textContent).toContain("owner");
  expect(screen.getByDisplayValue("Alex")).toBeTruthy();
});
