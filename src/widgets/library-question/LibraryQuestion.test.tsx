import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import {
  api,
  type LibraryAnswer,
  type Meeting,
  type MeetingDetail,
} from "../../shared/api/api";
import { LibraryQuestion } from "./LibraryQuestion";
import type { AiBlock } from "../settings-panel";

vi.mock("../../shared/api/api", async (original) => ({
  ...(await original<typeof import("../../shared/api/api")>()),
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
      meetings={meetings}
      recipes={[
        { id: "recipe-1", name: "Risks", prompt: "What risks came up?" },
      ]}
      connectionRevision="1"
      llmBlocked={llmBlocked}
      onOpenSettings={onOpenSettings}
      disabled={false}
      onOpen={onOpen}
    />,
  );
  return onOpen;
}
const ask = async (text = "What was decided?") => {
  await userEvent.type(screen.getByLabelText("Question"), text);
  await userEvent.click(screen.getByRole("button", { name: "Ask" }));
};
/** The scope count beside the question box. */
const count = () =>
  document.querySelector(".ask-meta .count .n")?.textContent?.trim();
const box = (name: string | RegExp) =>
  screen.getByRole("checkbox", { name }) as HTMLInputElement;

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

it("asks across every meeting by default and shows the scope count", async () => {
  vi.mocked(api.askLibrary).mockResolvedValue(saved(1, ["a"], "Ship it."));
  show();
  expect(count()).toBe("3 meetings");
  expect(
    (screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await ask();
  expect(api.askLibrary).toHaveBeenCalledWith(
    ["a", "b", "c"],
    "What was decided?",
  );
  expect((await screen.findByLabelText("Answer")).textContent).toContain(
    "Ship it",
  );
});

it("resolves a tag to its meetings and sends exactly that scope", async () => {
  vi.mocked(api.askLibrary).mockResolvedValue(
    saved(1, ["a", "c"], "Ship it [M1 0:08]."),
  );
  show();
  await userEvent.selectOptions(screen.getByLabelText("Scope"), "tag");
  await userEvent.selectOptions(screen.getByLabelText("Tag"), "client");
  expect(count()).toBe("2 meetings");
  await ask();
  expect(api.askLibrary).toHaveBeenCalledWith(["a", "c"], "What was decided?");
  expect((await screen.findByLabelText("Answer")).textContent).toContain(
    "Ship it",
  );
});

it("names the AI notes connection and marks a remote one as leaving the device", async () => {
  render(
    <LibraryQuestion
      meetings={meetings}
      recipes={[]}
      connectionRevision="1"
      llmBlocked={null}
      onOpenSettings={vi.fn()}
      disabled={false}
      onOpen={vi.fn()}
      connection={{ name: "Gemini 2.5 Flash · Google", remote: true }}
    />,
  );
  expect(screen.getByText("Gemini 2.5 Flash · Google")).toBeTruthy();
  expect(screen.getByText("Leaves this device")).toBeTruthy();
});

it("keeps the disclosure of a remote connection reachable from the keyboard", () => {
  render(
    <LibraryQuestion
      meetings={meetings}
      recipes={[]}
      connectionRevision="1"
      llmBlocked={null}
      onOpenSettings={vi.fn()}
      disabled={false}
      onOpen={vi.fn()}
      connection={{ name: "Gemini 2.5 Flash · Google", remote: true }}
    />,
  );
  const who = screen.getByText("Gemini 2.5 Flash · Google");
  expect(who.getAttribute("tabindex")).toBe("0");
  const note = document.getElementById(
    who.getAttribute("aria-describedby") ?? "",
  );
  expect(note?.textContent).toContain("sent to this service");
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
  await userEvent.selectOptions(screen.getByLabelText("Scope"), "pick");
  await userEvent.click(box(/Alpha sync/));
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

it("lists the meetings behind an answer as sources", async () => {
  vi.mocked(api.askLibrary).mockResolvedValue(saved(1, ["a", "c"], "Done."));
  const onOpen = show();
  await ask();
  const sources = await screen.findByText("Sources");
  expect(sources).toBeTruthy();
  const rows = within(screen.getByLabelText("Answer")).getAllByRole("button", {
    name: /Alpha sync|Gamma plan/,
  });
  expect(rows).toHaveLength(2);
  await userEvent.click(rows[1]);
  expect(onOpen).toHaveBeenLastCalledWith("c", null);
});

it("shows no matching passages as a status message, not an error", async () => {
  const message =
    "No passages in the selected content matched your question. Nothing was sent.";
  vi.mocked(api.askLibrary).mockRejectedValue({
    code: "insufficient_evidence",
    message,
  });
  show();
  await ask();
  expect((await screen.findByText(message)).getAttribute("role")).toBe(
    "status",
  );
  expect(screen.queryByRole("alert")).toBeNull();
  // Changing the question clears the message.
  await userEvent.type(screen.getByLabelText("Question"), "?");
  expect(screen.queryByText(message)).toBeNull();
});

it("explains a blocked AI notes setup in one sentence and links to its Settings section", async () => {
  const onOpenSettings = vi.fn();
  show(
    vi.fn(),
    {
      message: "Choose a model for AI notes in Settings → AI notes.",
      section: "ai",
    },
    onOpenSettings,
  );
  await userEvent.type(screen.getByLabelText("Question"), "What was decided?");
  expect(
    (screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    screen.getByText("Connect an AI service to ask questions."),
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
  await userEvent.click(
    await screen.findByRole("button", { name: /Newest\?/ }),
  );
  expect(screen.getByText("Recent questions")).toBeTruthy();
  const answer = await screen.findByLabelText("Answer");
  expect(answer.textContent).toContain("Newest?");
  expect(answer.textContent).toContain("2 meetings");
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
  expect(screen.queryByLabelText("Answer")).toBeNull();
  expect(screen.queryByRole("button", { name: /Newest\?/ })).toBeNull();
});

it("shows a sent answer as saved and adds it to the saved list", async () => {
  vi.mocked(api.askLibrary).mockResolvedValue(saved(7, ["a"], "Done."));
  show();
  await ask();
  expect((await screen.findByLabelText("Answer")).textContent).toContain(
    "Saved on this device",
  );
  expect(
    screen.getByRole("button", { name: /What was decided\?/ }),
  ).toBeTruthy();
  expect((screen.getByLabelText("Question") as HTMLTextAreaElement).value).toBe(
    "",
  );
});

it("copies the shown answer with the Copy button", async () => {
  vi.mocked(api.askLibrary).mockResolvedValue(saved(7, ["a"], "Done."));
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  show();
  await ask();
  await userEvent.click(await screen.findByRole("button", { name: "Copy" }));
  expect(writeText).toHaveBeenCalledWith("Done.");
  expect(screen.getByText("Copied.")).toBeTruthy();
});

function showMeetings(list: Meeting[]) {
  render(
    <LibraryQuestion
      meetings={list}
      recipes={[]}
      connectionRevision="1"
      llmBlocked={null}
      onOpenSettings={vi.fn()}
      disabled={false}
      onOpen={vi.fn()}
    />,
  );
}

it("filters meetings by title, ignoring case and accents", async () => {
  showMeetings([
    make("cafe", "Café planning", []),
    make("ang", "Ångström notes", []),
    make("b", "Budget", []),
  ]);
  await userEvent.selectOptions(screen.getByLabelText("Scope"), "pick");
  const filter = screen.getByLabelText("Filter meetings");
  await userEvent.type(filter, "cafe");
  expect(box(/Café planning/)).toBeTruthy();
  expect(screen.queryByRole("checkbox", { name: /Budget/ })).toBeNull();
  await userEvent.clear(filter);
  await userEvent.type(filter, "ANGSTROM");
  expect(box(/Ångström notes/)).toBeTruthy();
  await userEvent.type(filter, " zzz");
  expect(screen.getByText("No meetings match this filter.")).toBeTruthy();
});

const many = Array.from({ length: 25 }, (_, index) =>
  make(`m${index}`, `Weekly ${String(index).padStart(2, "0")}`, []),
);

it("refuses every-meeting scope beyond the 20-meeting limit and says how to fix it", async () => {
  showMeetings(many);
  expect(count()).toBe("25 meetings");
  await userEvent.type(screen.getByLabelText("Question"), "What moved?");
  expect(
    (screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    screen.getByText(
      "One question covers 20 meetings: pick them or use a tag.",
    ),
  ).toBeTruthy();
  await userEvent.selectOptions(screen.getByLabelText("Scope"), "pick");
  expect(count()).toBe("0 meetings");
});

it("selects the first 20 shown, disables the rest at the limit, and clears", async () => {
  showMeetings(many);
  await userEvent.selectOptions(screen.getByLabelText("Scope"), "pick");
  await userEvent.click(
    screen.getByRole("button", { name: "Select first 20 shown" }),
  );
  expect(count()).toBe("20 meetings");
  expect(box(/Weekly 19/).checked).toBe(true);
  expect(box(/Weekly 20/).checked).toBe(false);
  expect(box(/Weekly 20/).disabled).toBe(true);
  // Picked boxes stay enabled so they can be unpicked.
  expect(box(/Weekly 00/).disabled).toBe(false);
  await userEvent.click(
    screen.getByRole("button", { name: "Clear selection" }),
  );
  expect(count()).toBe("0 meetings");
  expect(box(/Weekly 20/).disabled).toBe(false);
});

it("never drops picks beyond the first 20 and never exceeds 20", async () => {
  showMeetings(many);
  await userEvent.selectOptions(screen.getByLabelText("Scope"), "pick");
  await userEvent.click(box(/Weekly 24/));
  await userEvent.click(
    screen.getByRole("button", { name: "Select first 20 shown" }),
  );
  expect(count()).toBe("20 meetings");
  expect(box(/Weekly 24/).checked).toBe(true);
  expect(box(/Weekly 00/).checked).toBe(true);
});

it("selects only the filtered meetings with the same button", async () => {
  showMeetings(many);
  await userEvent.selectOptions(screen.getByLabelText("Scope"), "pick");
  await userEvent.type(screen.getByLabelText("Filter meetings"), "Weekly 1");
  await userEvent.click(
    screen.getByRole("button", { name: "Select first 20 shown" }),
  );
  expect(count()).toBe("10 meetings");
  await userEvent.clear(screen.getByLabelText("Filter meetings"));
  expect(box(/Weekly 00/).checked).toBe(false);
  expect(box(/Weekly 15/).checked).toBe(true);
});
