import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import {
  api,
  type LibraryAnswer,
  type Meeting,
  type MeetingDetail,
} from "../lib/api";
import { LibraryQuestion } from "./LibraryQuestion";
import type { AiBlock } from "./SettingsPanel";

vi.mock("../lib/api", async (original) => ({
  ...(await original<typeof import("../lib/api")>()),
  api: {
    askLibrary: vi.fn(),
    getMeeting: vi.fn(),
    listLibraryAnswers: vi.fn(),
    deleteLibraryAnswer: vi.fn(),
  },
}));

const make = (id: string, title: string, tags: string[]): Meeting => ({
  id,
  title,
  started_at: "2026-10-09T10:00:00Z",
  ended_at: null,
  status: "stopped",
  source: "desktop",
  capture_error: null,
  tags,
});
const meetings = [
  make("a", "Alpha sync", ["Client"]),
  make("b", "Beta review", []),
  make("c", "Gamma plan", ["client"]),
];
const detail = (id: string): MeetingDetail =>
  ({
    meeting: meetings.find((meeting) => meeting.id === id),
    segments: [
      {
        speaker: "Others",
        timing: { kind: "timed", start_ms: 8250, end_ms: 9000 },
        text: "Words",
      },
    ],
  }) as MeetingDetail;

function show(
  onOpen = vi.fn(),
  llmBlocked: AiBlock | null = null,
  onOpenSettings = vi.fn(),
) {
  render(
    <LibraryQuestion
      hidden={false}
      panelRef={{ current: null }}
      meetings={meetings}
      recipes={[
        { id: "recipe-1", name: "Risks", prompt: "What risks came up?" },
      ]}
      connectionRevision="1"
      llmBlocked={llmBlocked}
      onOpenSettings={onOpenSettings}
      disabled={false}
      onClose={vi.fn()}
      onOpen={onOpen}
    />,
  );
  return onOpen;
}
const ask = async (text = "What was decided?") => {
  await userEvent.type(screen.getByLabelText("Question"), text);
  await userEvent.click(screen.getByRole("button", { name: "Ask" }));
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getMeeting).mockImplementation(async (id) => detail(id));
  vi.mocked(api.listLibraryAnswers).mockResolvedValue([]);
});
const saved = (
  id: number,
  meetingIds: string[],
  answer: string,
  question = "What was decided?",
): LibraryAnswer => ({
  id,
  question,
  answer,
  provider: "https://provider.example/v1",
  model: "test-chat",
  meeting_ids: meetingIds,
});

it("resolves a tag to its meetings and sends exactly that scope", async () => {
  vi.mocked(api.askLibrary).mockResolvedValue(
    saved(1, ["a", "c"], "Ship it [M1 0:08]."),
  );
  show();
  expect(
    (screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await userEvent.click(screen.getByLabelText("Meetings with a tag"));
  await userEvent.selectOptions(screen.getByLabelText("Tag"), "client");
  expect(screen.getByRole("status").textContent).toContain("2 meetings");
  await ask();
  expect(api.askLibrary).toHaveBeenCalledWith(["a", "c"], "What was decided?");
  expect(
    (await screen.findByLabelText("Library answer")).textContent,
  ).toContain("Ship it");
});

it("links only in-scope citations that match a stored segment and marks the rest unverified", async () => {
  vi.mocked(api.askLibrary).mockResolvedValue(
    saved(
      1,
      ["a"],
      "Launch is Friday [M1 0:08]. Budget [M1 9:59], other [M2 0:08], plan [M1], bare [0:08].",
    ),
  );
  const onOpen = show();
  await userEvent.click(screen.getByLabelText(/Alpha sync/));
  await ask();
  const link = await screen.findByRole("button", {
    name: "Open Alpha sync at 0:08",
  });
  expect(api.getMeeting).toHaveBeenCalledWith("a");
  expect(screen.getAllByText("(unverified)")).toHaveLength(3);
  expect(screen.queryByRole("button", { name: /9:59|M2|Beta/ })).toBeNull();
  await userEvent.click(link);
  expect(onOpen).toHaveBeenLastCalledWith("a", 8000);
  await userEvent.click(
    screen.getByRole("button", { name: "Open Alpha sync" }),
  );
  expect(onOpen).toHaveBeenLastCalledWith("a", null);
});

it("shows no matching passages as a status message, not an error", async () => {
  const message =
    "No passages in the selected content matched your question. Nothing was sent.";
  vi.mocked(api.askLibrary).mockRejectedValue({
    code: "insufficient_evidence",
    message,
  });
  show();
  await userEvent.click(screen.getByLabelText(/Alpha sync/));
  await ask();
  expect((await screen.findByText(message)).getAttribute("role")).toBe(
    "status",
  );
  expect(screen.queryByRole("alert")).toBeNull();
  // Changing the question clears the message.
  await userEvent.type(screen.getByLabelText("Question"), "?");
  expect(screen.queryByText(message)).toBeNull();
});

it("explains a blocked AI notes setup, disables Ask, and links to its Settings section", async () => {
  const onOpenSettings = vi.fn();
  show(
    vi.fn(),
    {
      message: "Choose a model for AI notes in Settings → AI notes.",
      section: "ai",
    },
    onOpenSettings,
  );
  await userEvent.click(screen.getByLabelText(/Alpha sync/));
  await userEvent.type(screen.getByLabelText("Question"), "What was decided?");
  expect(
    (screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    screen.getByText("Choose a model for AI notes in Settings → AI notes."),
  ).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: "Open Settings for AI notes" }),
  );
  expect(onOpenSettings).toHaveBeenCalledWith(
    "ai",
    expect.any(HTMLButtonElement),
  );
  expect(api.askLibrary).not.toHaveBeenCalled();
});

it("fills the question from a recipe without sending anything", async () => {
  show();
  await userEvent.click(
    screen.getByRole("button", { name: "Follow-up email" }),
  );
  expect(
    (screen.getByLabelText("Question") as HTMLTextAreaElement).value,
  ).toContain("follow-up email");
  await userEvent.click(screen.getByRole("button", { name: "Risks" }));
  expect((screen.getByLabelText("Question") as HTMLTextAreaElement).value).toBe(
    "What risks came up?",
  );
  expect(api.askLibrary).not.toHaveBeenCalled();
});

it("lists saved answers with their scope, and deletes one only after confirmation", async () => {
  vi.mocked(api.listLibraryAnswers).mockResolvedValue([
    saved(2, ["c", "a"], "Gamma first [M1 0:08].", "Newest?"),
    saved(1, ["b"], "Older answer.", "Older?"),
  ]);
  vi.mocked(api.deleteLibraryAnswer).mockResolvedValue([
    saved(1, ["b"], "Older answer.", "Older?"),
  ]);
  const onOpen = show();
  await userEvent.selectOptions(
    await screen.findByLabelText("Saved answers"),
    "2",
  );
  const answer = await screen.findByLabelText("Library answer");
  expect(answer.textContent).toContain("Q: Newest?");
  expect(answer.textContent).toContain("M1 Gamma plan; M2 Alpha sync");
  // M1 is the first meeting sent, not the first in the library.
  await userEvent.click(
    await screen.findByRole("button", { name: "Open Gamma plan at 0:08" }),
  );
  expect(onOpen).toHaveBeenLastCalledWith("c", 8000);
  await userEvent.click(screen.getByRole("button", { name: "Delete answer" }));
  expect(api.deleteLibraryAnswer).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "Delete answer permanently" }),
  );
  expect(api.deleteLibraryAnswer).toHaveBeenCalledWith(2);
  expect(screen.queryByLabelText("Library answer")).toBeNull();
  expect(
    within(screen.getByLabelText("Saved answers")).queryByText("Newest?"),
  ).toBeNull();
});

it("shows a sent answer as saved and adds it to the saved list", async () => {
  vi.mocked(api.askLibrary).mockResolvedValue(saved(7, ["a"], "Done."));
  show();
  await userEvent.click(screen.getByLabelText(/Alpha sync/));
  await ask();
  expect(
    (await screen.findByLabelText("Library answer")).textContent,
  ).toContain("Saved on this device");
  expect(
    (screen.getByLabelText("Saved answers") as HTMLSelectElement).value,
  ).toBe("7");
  expect((screen.getByLabelText("Question") as HTMLTextAreaElement).value).toBe(
    "",
  );
});
