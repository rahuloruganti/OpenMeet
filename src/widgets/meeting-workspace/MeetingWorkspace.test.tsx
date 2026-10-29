import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ActionItem,
  MeetingDetail,
  SummaryVersion,
} from "../../shared/api/api";
import { sample } from "../../shared/test/app-harness";
import { MeetingWorkspace } from "./MeetingWorkspace";

const scrollIntoView = Element.prototype.scrollIntoView;
afterEach(() => {
  vi.unstubAllGlobals();
  Element.prototype.scrollIntoView = scrollIntoView;
});

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
  onEnhance: vi.fn(),
  versions: [],
  customTemplates: [],
  defaultTemplate: "general-v1",
  summaryDraft: undefined,
  onSummaryDraft: vi.fn(),
  onSaveSummaryEdit: vi.fn(),
  onSpeakerNames: vi.fn(),
  segmentDraft: null,
  onSegmentDraft: vi.fn(),
  onSaveSegment: vi.fn(),
  onActionItems: vi.fn(),
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

it("shows meeting details under the title and the devices in the inspector", () => {
  render(<MeetingWorkspace {...base} selected={recorded} />);
  const meta = screen.getByRole("group", { name: "Meeting details" });
  expect(within(meta).getByText("Recording")).toBeTruthy();
  expect(within(meta).getByText("48:12")).toBeTruthy();
  expect(within(meta).getByText("atlas")).toBeTruthy();
  const inspector = screen.getByRole("complementary", {
    name: "Meeting inspector",
  });
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

const enhancedVersion: SummaryVersion = {
  id: 7,
  provider: "http://127.0.0.1:8080/v1",
  model: "local-model",
  template: "general-v1",
  markdown: "## Decisions\n- Ship on Friday [s12].",
  edited_from: null,
  stale: false,
  kind: "enhanced",
  notes_revision: 1,
  sources: [{ marker: "[s12]", segment_id: 12, start_ms: 5000, end_ms: 9000 }],
};
const withSegment: MeetingDetail = {
  ...recorded,
  segments: [
    {
      speaker: "Others",
      timing: { kind: "timed", start_ms: 5000, end_ms: 9000 },
      text: "Ship on Friday.",
    },
  ],
  segment_meta: [{ id: 12, original_text: null }],
};

const noAiModel = {
  message: "Choose a model for AI notes in Settings → AI notes.",
  section: "ai" as const,
};

it.each([
  { name: "no content", notes: "", segments: [], ready: false },
  {
    name: "no content with AI ready",
    notes: " \n ",
    segments: [],
    ready: true,
  },
  {
    name: "notes without AI",
    notes: "Draft notes",
    segments: [],
    ready: false,
  },
  {
    name: "transcript without AI",
    notes: "",
    segments: withSegment.segments,
    ready: false,
  },
  {
    name: "notes with AI ready",
    notes: "Draft notes",
    segments: [],
    ready: true,
  },
  {
    name: "transcript with AI ready",
    notes: "",
    segments: withSegment.segments,
    ready: true,
  },
])(
  "shows one summary next step for $name",
  async ({ notes, segments, ready }) => {
    const onOpenSettings = vi.fn();
    const onGenerate = vi.fn();
    const hasInput = /\S/.test(notes) || segments.length > 0;
    render(
      <MeetingWorkspace
        {...base}
        selected={{ ...sample, summary: null, segments }}
        notes={notes}
        llmBlocked={ready ? null : noAiModel}
        enhanceBlocked={
          !ready
            ? noAiModel.message
            : !hasInput
              ? "Add notes or transcribe the audio first."
              : null
        }
        onOpenSettings={onOpenSettings}
        onGenerate={onGenerate}
      />,
    );
    const panel = screen.getByRole("tabpanel", { name: "Summary" });
    const writeHint = within(panel).queryByText(
      "Write notes or add a transcript.",
    );
    const modelHint = within(panel).queryByText(
      "Choose an AI model to summarise these notes.",
    );
    const settings = within(panel).queryByRole("button", {
      name: "Open Settings for AI notes",
    });
    const generate = within(panel).queryByRole("button", {
      name: "Create summary",
    });
    expect(Boolean(writeHint)).toBe(!hasInput);
    expect(Boolean(modelHint)).toBe(hasInput && !ready);
    expect(Boolean(settings)).toBe(hasInput && !ready);
    expect(Boolean(generate)).toBe(hasInput && ready);
    expect(within(panel).queryByText(noAiModel.message)).toBeNull();
    expect(
      within(panel).queryByText(/Add notes or a transcript first/),
    ).toBeNull();
    if (settings) {
      await userEvent.click(settings);
      expect(onOpenSettings).toHaveBeenCalledWith("ai", settings);
    }
    if (generate) {
      expect(generate).toHaveProperty("disabled", false);
      await userEvent.click(generate);
      expect(onGenerate).toHaveBeenCalledWith("general-v1");
    }
  },
);

it("announces No matches when transcript Find has no results", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  render(
    <MeetingWorkspace {...base} selected={withSegment} tab="transcript" />,
  );
  const find = screen.getByRole("searchbox", { name: "Find in transcript" });
  await userEvent.type(find, "missing");
  const count = screen.getByText("No matches");
  expect(count.getAttribute("aria-live")).toBe("polite");
  expect(count.getAttribute("aria-hidden")).not.toBe("true");
  expect(screen.queryByText("0 of 0")).toBeNull();
  await userEvent.clear(find);
  await userEvent.type(find, "Friday");
  expect(screen.getByText("1 of 1")).toBeTruthy();
});

it("keeps numbered Find results when transcript matches exist", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  render(
    <MeetingWorkspace {...base} selected={withSegment} tab="transcript" />,
  );
  await userEvent.type(
    screen.getByRole("searchbox", { name: "Find in transcript" }),
    "i",
  );
  expect(screen.getByText("1 of 2").getAttribute("aria-live")).toBe("polite");
  await userEvent.click(screen.getByRole("button", { name: "Next match" }));
  expect(screen.getByText("2 of 2")).toBeTruthy();
  expect(screen.queryByText("No matches")).toBeNull();
});

it("labels enhanced notes apart from a summary and opens a source in the transcript", async () => {
  const onTab = vi.fn();
  render(
    <MeetingWorkspace
      {...base}
      selected={withSegment}
      versions={[enhancedVersion]}
      onTab={onTab}
    />,
  );
  expect(screen.getByText(/^Enhanced notes · from local-model/)).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: "Open transcript at 00:05 to 00:09" }),
  );
  expect(onTab).toHaveBeenCalledWith("transcript");
});

it("regenerates enhanced notes with the picked template", async () => {
  const onEnhance = vi.fn();
  render(
    <MeetingWorkspace
      {...base}
      selected={withSegment}
      versions={[enhancedVersion]}
      onEnhance={onEnhance}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Regenerate" }));
  expect(onEnhance).toHaveBeenCalledWith("general-v1");
});

it("says why Enhance notes is off only in the enhancement block", () => {
  render(
    <MeetingWorkspace {...base} selected={{ ...recorded, summary: null }} />,
  );
  const enhanced = screen.getByRole("region", { name: "Enhanced notes" });
  expect(
    (
      within(enhanced).getByRole("button", {
        name: "Enhance notes",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    within(enhanced).getByText(
      "No transcript yet. Record or transcribe first.",
    ),
  ).toBeTruthy();
  expect(
    screen.getAllByText("No transcript yet. Record or transcribe first."),
  ).toHaveLength(1);
});

it("reuses the freshness line for enhanced notes that went stale", () => {
  render(
    <MeetingWorkspace
      {...base}
      selected={withSegment}
      versions={[{ ...enhancedVersion, stale: true }]}
    />,
  );
  expect(
    screen.getByText("Notes or transcript changed after these enhanced notes."),
  ).toBeTruthy();
});

const plainVersion: SummaryVersion = {
  id: 6,
  provider: "http://127.0.0.1:1234/v1",
  model: "local-model",
  template: "general-v1",
  markdown: "## Summary\n- Plain summary point.",
  edited_from: null,
  stale: false,
  kind: "summary",
  notes_revision: null,
  sources: [],
};

it("shows the plain summary and the enhanced notes as separate labelled blocks", () => {
  render(
    <MeetingWorkspace
      {...base}
      selected={withSegment}
      versions={[enhancedVersion, plainVersion]}
    />,
  );
  expect(screen.getByText(/^Generated by local-model via/)).toBeTruthy();
  expect(screen.getByText(/^Enhanced notes · from local-model/)).toBeTruthy();
  expect(screen.getByText("Plain summary point.")).toBeTruthy();
  const enhancedBlock = screen.getByRole("region", { name: "Enhanced notes" });
  expect(within(enhancedBlock).getByText("Decisions")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit summary" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Edit enhanced notes" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Regenerate" })).toBeTruthy();
});

it("gives each block its own freshness line", () => {
  const { rerender } = render(
    <MeetingWorkspace
      {...base}
      selected={withSegment}
      versions={[enhancedVersion, { ...plainVersion, stale: true }]}
    />,
  );
  expect(
    screen.getByText("Transcript changed after this summary."),
  ).toBeTruthy();
  expect(
    screen.queryByText(
      "Notes or transcript changed after these enhanced notes.",
    ),
  ).toBeNull();
  rerender(
    <MeetingWorkspace
      {...base}
      selected={withSegment}
      versions={[{ ...enhancedVersion, stale: true }, plainVersion]}
    />,
  );
  expect(
    screen.getByText("Notes or transcript changed after these enhanced notes."),
  ).toBeTruthy();
  expect(
    screen.queryByText("Transcript changed after this summary."),
  ).toBeNull();
});

it("edits enhanced notes as their own draft, not the plain summary", async () => {
  const onSummaryDraft = vi.fn();
  const { rerender } = render(
    <MeetingWorkspace
      {...base}
      selected={withSegment}
      versions={[enhancedVersion, plainVersion]}
      onSummaryDraft={onSummaryDraft}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Edit enhanced notes" }),
  );
  expect(onSummaryDraft).toHaveBeenCalledWith({
    baseId: enhancedVersion.id,
    latestId: enhancedVersion.id,
    text: enhancedVersion.markdown,
  });
  rerender(
    <MeetingWorkspace
      {...base}
      selected={withSegment}
      versions={[enhancedVersion, plainVersion]}
      summaryDraft={{
        baseId: enhancedVersion.id,
        latestId: enhancedVersion.id,
        text: "Edited notes.",
      }}
      onSummaryDraft={onSummaryDraft}
    />,
  );
  expect(
    screen.getByRole("textbox", { name: "Edit enhanced notes" }),
  ).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Edit summary" })).toBeNull();
  // While one block is being edited, the other block's edit control waits: no draft is silently replaced.
  expect(screen.queryByRole("button", { name: "Edit summary" })).toBeNull();
});

const modifierCases = [
  {
    name: "macOS with Command",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)",
    ctrlKey: false,
    metaKey: true,
    expected: true,
  },
  {
    name: "macOS with Control",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)",
    ctrlKey: true,
    metaKey: false,
    expected: false,
  },
  {
    name: "Windows with Control",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    ctrlKey: true,
    metaKey: false,
    expected: true,
  },
  {
    name: "Windows with Meta",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    ctrlKey: false,
    metaKey: true,
    expected: false,
  },
];

it.each(modifierCases)(
  "uses the primary modifier for timestamp insertion on $name",
  async ({ userAgent, ctrlKey, metaKey, expected }) => {
    vi.stubGlobal("navigator", { userAgent });
    const getRecordingOffset = vi.fn().mockResolvedValue(65_400);
    const onNotes = vi.fn();
    render(
      <MeetingWorkspace
        {...base}
        selected={recorded}
        tab="notes"
        live
        getRecordingOffset={getRecordingOffset}
        onNotes={onNotes}
      />,
    );
    const editor = screen.getByRole("textbox", { name: /My notes/ });
    editor.focus();
    (editor as HTMLTextAreaElement).setSelectionRange(0, 0);
    expect(
      fireEvent.keyDown(editor, {
        key: "T",
        shiftKey: true,
        ctrlKey,
        metaKey,
      }),
    ).toBe(!expected);
    if (expected) {
      await waitFor(() =>
        expect(onNotes).toHaveBeenCalledWith("[01:05] Notes"),
      );
      expect(getRecordingOffset).toHaveBeenCalledOnce();
    } else {
      expect(getRecordingOffset).not.toHaveBeenCalled();
      expect(onNotes).not.toHaveBeenCalled();
    }
  },
);

it.each(modifierCases)(
  "uses the primary modifier for transcript Find on $name",
  ({ userAgent, ctrlKey, metaKey, expected }) => {
    vi.stubGlobal("navigator", { userAgent });
    render(
      <MeetingWorkspace {...base} selected={withSegment} tab="transcript" />,
    );
    const find = screen.getByRole("searchbox", { name: "Find in transcript" });
    const tab = screen.getByRole("tab", { name: "Transcript" });
    tab.focus();
    expect(fireEvent.keyDown(tab, { key: "f", ctrlKey, metaKey })).toBe(
      !expected,
    );
    expect(document.activeElement).toBe(expected ? find : tab);
  },
);
