import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { ActionItem, MeetingDetail } from "../../shared/api/api";
import { sample } from "../../shared/test/app-harness";
import { MeetingWorkspace } from "./MeetingWorkspace";

const task: ActionItem = {
  id: 1,
  text: "Send the deck",
  owner: "Priya",
  due_date: "2026-10-31",
  done: false,
  source: "summary",
  summary_id: 3,
};

const recorded: MeetingDetail = {
  ...sample,
  meeting: {
    ...sample.meeting,
    source: "desktop",
    status: "stopped",
    ended_at: "2026-10-09T10:48:12Z",
    tags: ["atlas"],
  },
  tracks: [
    {
      kind: "mic",
      path: "mic.wav",
      device_name: "Headset (SoundCore 2)",
      sample_rate: 48000,
      frames: 480000,
      dropped_frames: 0,
      finalized: true,
      size_bytes: 1024,
    },
    {
      kind: "system",
      path: "system.wav",
      device_name: "Speakers (Realtek)",
      sample_rate: 48000,
      frames: 480000,
      dropped_frames: 0,
      finalized: true,
      size_bytes: 1024,
    },
  ],
  transcript_versions: [
    {
      id: 9,
      provider: "whisper",
      model: "base",
      edited: true,
      segment_count: 40,
    },
  ],
};

const base = {
  hidden: false,
  firstRun: false,
  notes: "Notes",
  notesStatus: "saved",
  tab: "summary" as const,
  disabled: false,
  job: null,
  processing: null,
  speechReady: true,
  enhanceBlocked: null,
  llmBlocked: null,
  onOpenSettings: vi.fn(),
  sttMode: "local" as const,
  onTab: vi.fn(),
  onNotes: vi.fn(),
  onSaveNow: vi.fn(),
  onExport: vi.fn(),
  onTranscribe: vi.fn(),
  onGenerate: vi.fn(),
  versions: [],
  customTemplates: [],
  defaultTemplate: "general-v1",
  recipes: [],
  summaryDraft: undefined,
  onSummaryDraft: vi.fn(),
  onSaveSummaryEdit: vi.fn(),
  onSpeakerNames: vi.fn(),
  segmentDraft: null,
  onSegmentDraft: vi.fn(),
  onSaveSegment: vi.fn(),
  onActionItems: vi.fn(),
  onAsk: vi.fn(),
  onDeleteThread: vi.fn(),
  recordingThis: false,
  onDeleteMeeting: vi.fn(),
  onDeleteAudio: vi.fn(),
  onRename: vi.fn(),
  onTags: vi.fn(),
  onRecover: vi.fn(),
  live: false,
  transcribeProgress: {},
  onCancelTranscribe: vi.fn(),
  getRecordingOffset: async () => null,
  onSeek: async () => null,
  pendingJump: null,
  onJumpDone: vi.fn(),
};

it("keeps tasks in the inspector and off the Summary tab", () => {
  render(
    <MeetingWorkspace
      {...base}
      selected={{ ...recorded, action_items: [task] }}
    />,
  );
  const inspector = screen.getByRole("complementary", {
    name: "Meeting inspector",
  });
  expect(within(inspector).getByLabelText("Task: Send the deck")).toBeTruthy();
  const summary = screen.getByRole("tabpanel", { name: "Summary" });
  expect(within(summary).queryByLabelText("Task: Send the deck")).toBeNull();
  expect(
    within(summary).queryByRole("button", { name: "Add task" }),
  ).toBeNull();
});

it("shows details and the devices of the meeting's tracks", () => {
  render(<MeetingWorkspace {...base} selected={recorded} />);
  const inspector = screen.getByRole("complementary", {
    name: "Meeting inspector",
  });
  expect(within(inspector).getByText("Recording")).toBeTruthy();
  expect(within(inspector).getByText("48:12")).toBeTruthy();
  expect(within(inspector).getByText("atlas")).toBeTruthy();
  // The saved-state row is about the notes, not the meeting.
  expect(within(inspector).getByText("Notes")).toBeTruthy();
  expect(within(inspector).getByText("Headset (SoundCore 2)")).toBeTruthy();
  expect(within(inspector).getByText("Speakers (Realtek)")).toBeTruthy();
});

it("hides the Devices section for a note without tracks", () => {
  render(<MeetingWorkspace {...base} selected={sample} />);
  const inspector = screen.getByRole("complementary", {
    name: "Meeting inspector",
  });
  expect(within(inspector).queryByText("Devices")).toBeNull();
});

it("opens transcript history from the meeting menu", async () => {
  render(<MeetingWorkspace {...base} selected={recorded} />);
  await userEvent.click(screen.getByLabelText("More meeting actions"));
  await userEvent.click(screen.getByRole("button", { name: "History" }));
  const sheet = screen.getByRole("dialog", { name: "Transcript history" });
  expect(within(sheet).getByText("whisper · base")).toBeTruthy();
  expect(
    within(sheet).getByText("Earlier transcripts are read-only."),
  ).toBeTruthy();
});

it("renames the meeting from the title with the keyboard", async () => {
  render(<MeetingWorkspace {...base} selected={recorded} />);
  const title = screen.getByRole("button", { name: "Sample sync" });
  title.focus();
  await userEvent.keyboard("{Enter}");
  const input = screen.getByRole("textbox", { name: "Meeting title" });
  await userEvent.clear(input);
  await userEvent.type(input, "Weekly sync{Enter}");
  expect(base.onRename).toHaveBeenCalledWith("Weekly sync");
  // Focus comes back to the title button (a fresh node once the input is gone).
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Sample sync" }),
  );
});

it("offers Start a meeting and New note when there are no meetings", () => {
  render(<MeetingWorkspace {...base} selected={null} />);
  expect(screen.getByRole("button", { name: "Start a meeting" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "New note" })).toBeTruthy();
});

it("opens the Tasks sheet as a modal and hands focus back on Escape", async () => {
  // Below 1100px the inspector is a sheet opened from the header.
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
  render(
    <MeetingWorkspace
      {...base}
      selected={{ ...recorded, action_items: [task] }}
    />,
  );
  const opener = screen.getByRole("button", { name: /Tasks/ });
  await userEvent.click(opener);
  const sheet = screen.getByRole("dialog", { name: "Tasks" });
  expect(sheet.getAttribute("aria-modal")).toBe("true");
  expect(sheet.contains(document.activeElement)).toBe(true);
  expect(within(sheet).getByLabelText("Task: Send the deck")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Tasks" })).toBeNull();
  expect(document.activeElement).toBe(opener);
  vi.unstubAllGlobals();
});

it("traps Tab in the History sheet and returns focus to the menu on Escape", async () => {
  render(<MeetingWorkspace {...base} selected={recorded} />);
  await userEvent.click(screen.getByLabelText("More meeting actions"));
  await userEvent.click(screen.getByRole("button", { name: "History" }));
  const sheet = screen.getByRole("dialog", { name: "Transcript history" });
  const close = within(sheet).getByRole("button", { name: "Close" });
  // Focus enters on the sheet's first control; Tab leaves it only back to itself.
  expect(document.activeElement).toBe(close);
  await userEvent.tab();
  await userEvent.tab();
  expect(document.activeElement).toBe(close);
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByLabelText("More meeting actions"),
  );
});
