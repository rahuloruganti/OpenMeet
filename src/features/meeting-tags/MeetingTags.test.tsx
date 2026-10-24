import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api, type Meeting, type SearchHit } from "../../shared/api/api";
import { MeetingSidebar } from "../../widgets/meeting-sidebar";
import { MeetingTagsForm } from "./MeetingTags";
vi.mock("../../shared/api/api", async (original) => ({
  ...(await original<typeof import("../../shared/api/api")>()),
  api: { setMeetingTags: vi.fn() },
}));
beforeEach(() => vi.resetAllMocks());

it("saves a trimmed tag list and keeps the input on failure", async () => {
  const onTags = vi.fn();
  vi.mocked(api.setMeetingTags)
    .mockRejectedValueOnce({ code: "meeting_tag", message: "Tag too long." })
    .mockResolvedValue(["Client", "Q4"]);
  render(
    <MeetingTagsForm
      meetingId="m1"
      tags={[]}
      disabled={false}
      onTags={onTags}
    />,
  );
  await userEvent.type(screen.getByLabelText("Tags"), " Client , Q4,, ");
  const save = screen.getByRole("button", { name: "Save tags" });
  await userEvent.click(save);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect((screen.getByLabelText("Tags") as HTMLInputElement).value).toBe(
    " Client , Q4,, ",
  );
  expect(onTags).not.toHaveBeenCalled();
  await userEvent.click(save);
  expect(api.setMeetingTags).toHaveBeenLastCalledWith("m1", ["Client", "Q4"]);
  expect(onTags).toHaveBeenCalledWith(["Client", "Q4"]);
});

const make = (id: string, tags: string[]): Meeting => ({
  id,
  title: `Meeting ${id}`,
  started_at: "2026-10-10T09:00:00Z",
  ended_at: null,
  status: "stopped",
  source: "fixture",
  capture_error: null,
  tags,
});

it("filters meetings and full-text hits by tag", async () => {
  const hits: SearchHit[] = ["a", "b"].map((id) => ({
    meeting_id: id,
    kind: "notes",
    snippet: `budget ${id}`,
  }));
  render(
    <MeetingSidebar
      open
      meetings={[make("a", ["Client"]), make("b", [])]}
      search="budget"
      selectedId={undefined}
      disabled={false}
      recordingActive={false}
      onSearch={vi.fn()}
      onNewRecording={vi.fn()}
      onSettings={vi.fn()}
      onAsk={vi.fn()}
      onOpenMeeting={vi.fn()}
      onNewNote={vi.fn()}
      hits={hits}
      onOpenHit={vi.fn()}
      audioBytes={null}
    />,
  );
  expect(screen.getByText(/Notes · budget b/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Client" }));
  expect(screen.getByText(/Notes · budget a/)).toBeTruthy();
  expect(screen.queryByText(/Notes · budget b/)).toBeNull();
  expect(screen.queryByText("Meeting b")).toBeNull();
});
