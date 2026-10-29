import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  type ActionItem,
  type CustomTemplate,
  type SessionProcessingSnapshot,
  type SpeakerNames,
  type MeetingDetail,
  type Settings,
  type SourceRef,
  type SummaryVersion,
} from "../../shared/api/api";
import { builtinTemplates as templates } from "../../entities/processing";
import { tabTarget } from "../../shared/lib/tabs";
import { chordHint, modKeyLabel } from "../../shared/lib/shortcut-label";
import { primaryModifierPressed } from "../../shared/lib/platform";
import { renderMarkdown } from "../../shared/lib/markdown";
import { ActionItems } from "../../features/action-items";
import {
  EnhanceNotesButton,
  isSourceMarker,
  sourceChip,
} from "../../features/enhanced-notes";
import { RewriteSelection } from "../../features/rewrite-selection";
import {
  OpenSettingsButton,
  type AiBlock,
  type OpenSettings,
  type SettingsSection,
} from "../../shared/ui/settings-link";
import { CalendarEventRow } from "../../features/calendar";
import { MeetingTagsForm } from "../../features/meeting-tags";
import { MoveToFolder } from "../../features/folders";
import { TranscriptVersions } from "../../features/transcript-versions";
import {
  formatBytes,
  formatDateTime,
  sourceLabels,
} from "../../entities/meeting";
import {
  IconCalendar,
  IconChevronLeft,
  IconClock,
  IconCopy,
  IconMic,
  IconMore,
  IconPanelLeft,
} from "../../shared/ui/icons";
import {
  formatTimestamp,
  parseTimestamp,
  segmentsAt,
  timestampAtCaret,
} from "../../shared/lib/timestamps";
import { Sheet } from "./ui/Sheet";
import {
  TranscriptDock,
  TranscriptPanel,
  TranscriptProvider,
} from "./ui/TranscriptTab";
import "./meeting-workspace.css";

// Transcript segments are rendered in pages; citations open the page that holds them.
const SEGMENT_PAGE = 200;

/** Inspector rows: short device kinds. */
const deviceLabels: Record<string, string> = {
  mic: "Microphone",
  system: "System audio",
};

const templateLabel = (id: string, custom: CustomTemplate[]) =>
  templates.find((template) => template.id === id)?.label ??
  custom.find((template) => template.id === id)?.name ??
  ({ "summary-v1": "General", fixture: "Sample" } as Record<string, string>)[
    id
  ] ??
  (id.startsWith("custom-") ? "Deleted custom template" : id);

/** "48:12", or "1:02:03"; a running recording has no end yet. */
const formatDuration = (startedAt: string, endedAt: string | null) => {
  if (!endedAt) return "—";
  const total = Math.max(
    0,
    Math.round(
      (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000,
    ),
  );
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => `${value}`.padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
};

/** An unsaved summary edit: the version it edits and the newest version when editing began. */
export type SummaryDraft = { baseId: number; latestId: number; text: string };
/** An unsaved segment edit; `baseText` is the segment text when editing began. */
export type SegmentDraft = {
  meetingId: string;
  segmentId: number;
  baseText: string;
  text: string;
};

/** The finalized tracks a recorded meeting can play. */
function playableTracks(selected: MeetingDetail) {
  const { meeting } = selected;
  return meeting.source === "desktop" &&
    meeting.status !== "recording" &&
    meeting.status !== "paused"
    ? selected.tracks.filter((track) => track.finalized && track.frames > 0)
    : [];
}

/** What opening a cited second does: the segments to highlight and the first one to focus and play. */
function citationTarget(selected: MeetingDetail, matches: number[]) {
  const first = matches[0];
  const meta = first === undefined ? undefined : selected.segment_meta[first];
  if (first === undefined || !meta) return null;
  const segment = selected.segments[first];
  const kind = segment.speaker === "You" ? "mic" : "system";
  return {
    index: first,
    highlighted: matches.flatMap((index) => {
      const id = selected.segment_meta[index]?.id;
      return id === undefined ? [] : [id];
    }),
    pending: {
      id: meta.id,
      seek:
        segment.timing.kind === "timed" &&
        playableTracks(selected).some((track) => track.kind === kind)
          ? { kind, startMs: segment.timing.start_ms }
          : null,
    },
  };
}

/** The inspector is dropped below this width; a Tasks button opens a sheet instead. */
const narrowInspectorQuery = "(max-width: 900px)";

const useNarrowInspector = () => {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.(narrowInspectorQuery).matches ?? false,
  );
  useEffect(() => {
    const media = window.matchMedia?.(narrowInspectorQuery);
    if (!media) return;
    // Resize as well as change: some shells deliver only one of the two.
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener?.("change", update);
    window.addEventListener("resize", update);
    return () => {
      media.removeEventListener?.("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return narrow;
};

export const contentTabs = [
  { id: "notes", label: "My notes" },
  { id: "summary", label: "Summary" },
  { id: "transcript", label: "Transcript" },
] as const;
export type ContentTab = (typeof contentTabs)[number]["id"];

type Props = {
  hidden: boolean;
  selected: MeetingDetail | null;
  firstRun: boolean;
  notes: string;
  notesStatus: string;
  tab: ContentTab;
  disabled: boolean;
  /** "transcribe" | "summary" | "install" | "recover" while a background job runs. */
  job: string | null;
  /** The selected meeting's automatic processing snapshot while its status is shown, or null. */
  processing: SessionProcessingSnapshot | null;
  speechReady: boolean;
  /** Why summary generation is unavailable, or null when it can run. */
  enhanceBlocked: string | null;
  /** Why the summary provider cannot be used at all, with the Settings section that fixes it; null when it can. */
  llmBlocked: AiBlock | null;
  onOpenSettings: OpenSettings;
  sttMode: Settings["stt_mode"];
  onTab: (tab: ContentTab) => void;
  onNotes: (text: string) => void;
  onSaveNow: () => void;
  onExport: () => void;
  onTranscribe: () => void;
  /** `template` is a built-in id or a custom template id. */
  onGenerate: (template: string) => void;
  /** Enhanced notes from the raw notes and the final transcript; the raw notes are never changed. */
  onEnhance: (template: string) => void;
  /** Stored summaries, newest first. */
  versions: SummaryVersion[];
  customTemplates: CustomTemplate[];
  /** The template the picker starts at, from Settings. */
  defaultTemplate: string;
  /** Unsaved edit of this meeting's summary; App keeps it across meeting switches. */
  summaryDraft: SummaryDraft | undefined;
  onSummaryDraft: (draft: SummaryDraft | null) => void;
  /** Resolves true once saved; a failure keeps the draft. */
  onSaveSummaryEdit: (draft: SummaryDraft) => Promise<boolean>;
  onSpeakerNames: (meetingId: string, names: SpeakerNames) => void;
  /** The open segment edit, kept by App across meeting switches. */
  segmentDraft: SegmentDraft | null;
  onSegmentDraft: (draft: SegmentDraft | null) => void;
  /** Resolves true once saved; a failure keeps the draft. */
  onSaveSegment: (draft: SegmentDraft) => Promise<boolean>;
  /** Replaces the selected meeting's tasks after a backend change. */
  onActionItems: (meetingId: string, items: ActionItem[]) => void;
  /** The selected meeting is being recorded right now, so it cannot be deleted. */
  recordingThis: boolean;
  onDeleteMeeting: () => void;
  onDeleteAudio: () => void;
  onRename: (title: string) => void;
  onTags: (meetingId: string, tags: string[]) => void;
  onRecover: () => void;
  /** The selected meeting is the active real recording. */
  live: boolean;
  /** Percent per track kind while transcribing. */
  transcribeProgress: Record<string, number>;
  onCancelTranscribe: () => void;
  /** Fresh backend offset (frames written, pauses excluded), or null. */
  getRecordingOffset: () => Promise<number | null>;
  /** Maps a transcript time to the track's file time in ms, or null on failure. */
  onSeek: (kind: string, sessionMs: number) => Promise<number | null>;
  /** Banners rendered under the toolbar (errors, notices, detection). */
  banners?: ReactNode;
  /** One-line processing status rendered above the editor. */
  status?: ReactNode;
  /** Controlled inspector state; without it the workspace keeps its own. */
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
  /** Home actions, used when there is no meeting to show. */
  onStartRecording?: (trigger: HTMLButtonElement) => void;
  /** Opens another meeting, such as an earlier meeting in the same calendar series. */
  onOpenMeeting?: (meetingId: string) => void;
  onNewNote?: () => void;
  /** Sidebar state for the breadcrumb toggle. */
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
};

export function MeetingWorkspace(props: Props) {
  const { selected, tab, disabled, job, versions } = props;
  const [chosenTemplate, setTemplate] = useState(props.defaultTemplate);
  useEffect(() => setTemplate(props.defaultTemplate), [props.defaultTemplate]);
  // A deleted custom template falls back to General instead of failing at send time.
  const template =
    templates.some((item) => item.id === chosenTemplate) ||
    props.customTemplates.some((item) => item.id === chosenTemplate)
      ? chosenTemplate
      : "general-v1";
  const [versionId, setVersionId] = useState<number | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  // Set while the title input is open; Enter, Escape and the blur they can trigger settle it once.
  const titleEditing = useRef(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const [jumpHint, setJumpHint] = useState("");
  const [playbackError, setPlaybackError] = useState("");
  // Segment ids a clicked reference points to; the first is opened once the tab shows.
  const [highlighted, setHighlighted] = useState<number[]>([]);
  const [pendingReference, setPendingReference] = useState<{
    id: number;
    seek: { kind: string; startMs: number } | null;
  } | null>(null);
  const actions = useRef<HTMLDetailsElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const players = useRef<Record<string, HTMLAudioElement | null>>({});
  // A page (Settings, setup) replaces the workspace, so leaving it must stop playback too.
  // A layout effect, so it runs before React detaches the media elements' refs.
  useLayoutEffect(() => {
    const elements = players.current;
    return () => {
      Object.values(elements).forEach((player) => player?.pause());
    };
  }, []);
  const meetingId = selected?.meeting.id;
  // How many transcript segments are rendered, kept for the meeting they were shown for.
  const [segmentWindow, setSegmentWindow] = useState<{
    meetingId: string | undefined;
    count: number;
  }>({ meetingId: undefined, count: SEGMENT_PAGE });
  const shownCount = (state: typeof segmentWindow) =>
    state.meetingId === meetingId ? state.count : SEGMENT_PAGE;
  const shownSegments = shownCount(segmentWindow);
  // Inspector: controlled by the shell when it passes the pair, otherwise local.
  const [ownInspector, setOwnInspector] = useState(true);
  const inspectorOpen = props.inspectorOpen ?? ownInspector;
  const narrow = useNarrowInspector();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  // Switching meetings, even back and forth, starts each one on its first page.
  useEffect(
    () => setSegmentWindow({ meetingId, count: SEGMENT_PAGE }),
    [meetingId],
  );
  // A citation beyond the rendered page first widens the page, then it is focused.
  const revealSegment = (index: number) =>
    setSegmentWindow((state) => ({
      meetingId,
      count: Math.max(shownCount(state), index + 1),
    }));
  const [deleting, setDeleting] = useState<"meeting" | "audio" | null>(null);
  const [typed, setTyped] = useState("");
  const deleteTyped = useRef<HTMLInputElement>(null);
  const deleteCancel = useRef<HTMLButtonElement>(null);
  const titleButton = useRef<HTMLButtonElement>(null);
  // The control that opened a sheet: Escape, Close and the veil hand focus back to it.
  const sheetOpener = useRef<HTMLElement | null>(null);
  const tasksButton = useRef<HTMLButtonElement>(null);
  // Set by Enter or Escape in the title input, so focus returns to the title once the input is gone.
  const focusTitle = useRef(false);
  const toggleInspector = () => {
    const next = !inspectorOpen;
    if (props.inspectorOpen === undefined) setOwnInspector(next);
    props.onToggleInspector?.();
  };
  useEffect(() => {
    setDeleting(null);
    setTyped("");
    setTitleDraft(null);
    setJumpHint("");
    setPlaybackError("");
    setHistoryOpen(false);
    setTasksOpen(false);
    if (actions.current) actions.current.open = false;
  }, [meetingId]);
  // The blur that also ends a rename does not set focusTitle, so clicking elsewhere keeps that focus.
  useEffect(() => {
    if (titleDraft === null && focusTitle.current) {
      focusTitle.current = false;
      titleButton.current?.focus();
    }
  }, [titleDraft]);
  // Opening the rename field selects the stored title; typing must not re-select it.
  const titleOpen = titleDraft !== null;
  useEffect(() => {
    if (titleOpen) titleInput.current?.select();
  }, [titleOpen]);
  // Opening the confirmation focuses its typed title, or Cancel when none is needed, never the delete button.
  useEffect(() => {
    if (deleting) (deleteTyped.current ?? deleteCancel.current)?.focus();
  }, [deleting]);
  useEffect(() => {
    if (tab !== "transcript" || props.hidden)
      Object.values(players.current).forEach((player) => player?.pause());
  }, [tab, props.hidden]);
  useEffect(() => {
    setVersionId(null);
    setCopyStatus("");
  }, [versions]);
  useEffect(() => setHighlighted([]), [meetingId]);
  const play = (kind: string, fileMs: number) => {
    const player = players.current[kind];
    if (!player) return;
    player.currentTime = fileMs / 1000;
    setPlaybackError("");
    void player
      .play()
      ?.catch(() =>
        setPlaybackError(
          "Audio could not play. Check your output device and try again.",
        ),
      );
  };
  // Runs after the Transcript tab is shown, so the tab-change pause cannot stop it.
  useEffect(() => {
    if (tab !== "transcript" || !pendingReference) return;
    const element = document.getElementById(`segment-${pendingReference.id}`);
    element?.scrollIntoView?.({ block: "center" });
    element?.focus();
    const seek = pendingReference.seek;
    setPendingReference(null);
    if (seek)
      void props.onSeek(seek.kind, seek.startMs).then((fileMs) => {
        if (fileMs !== null) play(seek.kind, fileMs);
      });
  });

  const hero = (firstRun: boolean) => {
    const setupRows: {
      label: string;
      section: SettingsSection;
      ready: boolean;
    }[] = [
      {
        label: "Transcription",
        section: "transcription",
        ready: props.speechReady,
      },
      {
        label: "AI notes",
        section: props.llmBlocked?.section ?? "ai",
        ready: props.llmBlocked === null,
      },
    ];
    const missing = !props.disabled && setupRows.some((row) => !row.ready);
    return (
      <div className="mw-hero">
        <span className="mw-hero-mark" aria-hidden="true">
          <IconMic size={20} />
        </span>
        <p className="mw-hero-copy">
          Record a meeting or write a note on this PC.
        </p>
        <div className="mw-hero-row">
          <button
            className="primary mw-hero-go"
            disabled={props.disabled}
            onClick={(event) => props.onStartRecording?.(event.currentTarget)}
          >
            Start a meeting
          </button>
          <button
            className="mw-hero-note"
            disabled={props.disabled}
            onClick={props.onNewNote}
          >
            New note
          </button>
        </div>
        <p className="mw-hero-keys">
          <kbd>{modKeyLabel()}</kbd> <kbd>N</kbd> for a new recording
        </p>
        {firstRun && missing && (
          <details className="mw-hero-setup">
            <summary>Setup</summary>
            <ul aria-label="Setup status">
              {setupRows.map((row) => (
                <li key={row.label}>
                  <span>
                    {row.label}{" "}
                    <span className="muted">
                      {row.ready ? "Ready" : "Not set up"}
                    </span>
                  </span>
                  {!row.ready && (
                    <OpenSettingsButton
                      section={row.section}
                      onOpenSettings={props.onOpenSettings}
                    />
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    );
  };

  if (!selected) {
    return (
      <article className="mw is-empty" hidden={props.hidden}>
        {hero(props.firstRun)}
      </article>
    );
  }
  const { meeting } = selected;
  const playable = playableTracks(selected);
  const transcribable = playable.length > 0;
  const hasTranscript = selected.segments.length > 0;
  const hasSummaryInput = /\S/.test(props.notes) || hasTranscript;
  // The Transcript tab already says "No transcript yet." with the same action, so the card stays off it.
  const nextSteps =
    meeting.source === "desktop" &&
    meeting.status === "stopped" &&
    transcribable &&
    !hasTranscript &&
    tab !== "transcript" &&
    (props.processing === null ||
      (props.processing.workflow?.stage ?? props.processing.state) ===
        "failed");
  const speechReason =
    props.sttMode === "cloud"
      ? "Choose a cloud speech model in Settings first."
      : "Download the speech engine in Settings first.";
  const audioBytes = selected.tracks.reduce(
    (total, track) => total + (track.size_bytes ?? 0),
    0,
  );
  const deleteDisabled = disabled || job !== null || props.recordingThis;
  // An empty note has nothing to lose, so deleting it needs no typed title.
  const emptyNote =
    meeting.source === "note" &&
    !/\S/.test(props.notes) &&
    selected.segments.length === 0 &&
    !selected.summary &&
    versions.length === 0 &&
    selected.action_items.length === 0 &&
    selected.tracks.length === 0;
  const needsTitle = !(deleting === "meeting" && emptyNote);
  const askDelete = (what: "meeting" | "audio") => {
    if (actions.current) actions.current.open = false;
    setTyped("");
    setDeleting(what);
  };
  // Escape in the ••• menu, and Cancel or Escape in the delete card, return focus to its summary.
  const focusActions = () => actions.current?.querySelector("summary")?.focus();
  // Viewing an older version is display-only; export keeps using the latest.
  const shown = versions.find((version) => version.id === versionId);
  // The plain summary stream and the enhanced notes are separate blocks, each with its own newest
  // version, label, freshness line and edit. Export and the meeting detail use the plain summary only.
  const summaries = versions.filter((version) => version.kind === "summary");
  const current = shown?.kind === "summary" ? shown : summaries[0];
  const summary = current?.markdown ?? selected.summary;
  const provider = current?.provider ?? selected.summary_provider;
  const model = current?.model ?? selected.summary_model;
  const edited = current
    ? current.edited_from !== null
    : selected.summary_edited;
  const stale = current ? current.stale : selected.summary_stale;
  const enhancedCurrent = versions.find(
    (version) => version.kind === "enhanced",
  );
  const enhancedEdited = enhancedCurrent?.edited_from != null;
  // AI text is the draft until the user saves an edit; a sample summary is not a draft.
  const summaryIsDraft = summary && !edited && provider !== "fixture";
  const versionName = (id: number | null) => {
    const index = summaries.findIndex((version) => version.id === id);
    return index < 0
      ? "an earlier version"
      : `version ${summaries.length - index}`;
  };
  const draft = props.summaryDraft;
  // A draft belongs to one block: the kind of the version it edits decides which block shows it.
  const draftKind = (id: number) =>
    versions.find((version) => version.id === id)?.kind ?? "summary";
  const summaryDraft =
    draft !== undefined && draftKind(draft.baseId) === "summary"
      ? draft
      : undefined;
  const enhancedDraft =
    draft !== undefined && draftKind(draft.baseId) === "enhanced"
      ? draft
      : undefined;
  /** A `[m:ss]` citation becomes a link only when a stored timed segment starts in that second. */
  const reference = (token: string) => {
    const ms = parseTimestamp(token);
    const target = citationTarget(
      selected,
      ms === null ? [] : segmentsAt(selected.segments, ms),
    );
    if (!target)
      return (
        <span className="unverified-reference">
          {token} <span className="muted">(unverified)</span>
        </span>
      );
    return (
      <button
        className="seek-button"
        aria-label={`Open transcript at ${token.slice(1, -1)}`}
        onClick={() => {
          revealSegment(target.index);
          setHighlighted(target.highlighted);
          setPendingReference(target.pending);
          props.onTab("transcript");
        }}
      >
        {token}
      </button>
    );
  };
  // A source chip opens its cited segment the way a timestamp citation does.
  const openSource = (source: SourceRef) => {
    const index = selected.segment_meta.findIndex(
      (meta) => meta.id === source.segment_id,
    );
    const target = index < 0 ? null : citationTarget(selected, [index]);
    if (!target) return;
    revealSegment(target.index);
    setHighlighted(target.highlighted);
    setPendingReference(target.pending);
    props.onTab("transcript");
  };
  const chip = sourceChip(enhancedCurrent?.sources ?? [], openSource);
  // Enhanced notes cite [sNNN] segments and may still carry a timestamp citation.
  const noteReference = (token: string) =>
    isSourceMarker(token) ? chip(token) : reference(token);
  const insertTimestamp = async () => {
    const offset = await props.getRecordingOffset();
    const area = editor.current;
    if (offset === null || !area) return;
    const { selectionStart: start, selectionEnd: end, value } = area;
    // A stamp typed mid-line would glue onto the previous word, so it starts a new line.
    const newLine = start > 0 && value[start - 1] !== "\n" ? "\n" : "";
    const stamp = `${newLine}${formatTimestamp(offset)} `;
    props.onNotes(value.slice(0, start) + stamp + value.slice(end));
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(start + stamp.length, start + stamp.length);
    });
  };
  const jumpToAudio = () => {
    const area = editor.current;
    const ms = area ? timestampAtCaret(area.value, area.selectionStart) : null;
    if (ms === null) {
      setJumpHint("Put the cursor on a [mm:ss] timestamp.");
      return;
    }
    setJumpHint("");
    props.onTab("transcript");
    // Note timestamps are microphone file time. Both tracks pause together, so the
    // system track is seeked to the same position (approximate, not index-mapped).
    for (const track of playable) {
      const player = players.current[track.kind];
      if (player) player.currentTime = ms / 1000;
    }
    play(playable.some((t) => t.kind === "mic") ? "mic" : playable[0].kind, ms);
  };
  const origin = edited
    ? `Edited by you, from ${versionName(current?.edited_from ?? null)}`
    : `Generated by ${model ?? "a model"} via ${provider ?? "a connection"}`;
  const summaryLabel =
    meeting.source === "fixture" && provider === "fixture"
      ? "Sample summary"
      : summary
        ? origin
        : "";
  const enhancedLabel = enhancedCurrent
    ? `Enhanced notes · ${enhancedEdited ? "edited by you" : `from ${enhancedCurrent.model ?? "a model"} via ${enhancedCurrent.provider ?? "a connection"}`}`
    : "Enhanced notes";
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus(`Copied ${what}.`);
    } catch {
      setCopyStatus(`Could not copy ${what}.`);
    }
  };
  const copyTasks = () => {
    const lines = selected.action_items.map(
      (item) =>
        `- [${item.done ? "x" : " "}] ${item.text}${item.owner ? ` — ${item.owner}` : ""}${item.due_date ? ` (${item.due_date})` : ""}`,
    );
    if (lines.length === 0) {
      setCopyStatus("No tasks to copy.");
      return;
    }
    void copy(lines.join("\n"), "tasks");
  };
  const blocked = disabled || job !== null || props.enhanceBlocked !== null;
  const recoverable =
    meeting.source === "desktop" &&
    meeting.status === "interrupted" &&
    selected.tracks.some((track) => !track.finalized);
  const startRename = () => {
    if (disabled) return;
    titleEditing.current = true;
    setTitleDraft(meeting.title);
  };
  const settleTitle = (save: boolean) => {
    if (!titleEditing.current || titleDraft === null) return;
    titleEditing.current = false;
    setTitleDraft(null);
    // The backend trims and validates; an invalid title is reported, not saved.
    if (save && titleDraft !== meeting.title) props.onRename(titleDraft);
  };
  const openTasks = selected.action_items.length;
  /** Saved state of the notes: a failed save must not read as a clean green tick. */
  const savedState =
    props.notesStatus === "error"
      ? "error"
      : props.notesStatus === "saving"
        ? "working"
        : "ok";
  const savedLabel =
    props.notesStatus === "error"
      ? "Not saved"
      : props.notesStatus === "saving"
        ? "Saving…"
        : "Saved";
  const closeSheet = () => {
    setHistoryOpen(false);
    setTasksOpen(false);
  };
  // The control that opened a sheet: Escape, Close and the veil hand focus back to it.
  const showTasks = () => {
    sheetOpener.current = tasksButton.current;
    setTasksOpen(true);
  };
  // The menu closes on the way in, so its summary is what can take focus back.
  // A toolbar History button passes itself so focus returns there instead.
  const openHistory = (opener?: HTMLElement | null) => {
    sheetOpener.current =
      opener ?? actions.current?.querySelector<HTMLElement>("summary") ?? null;
    setHistoryOpen(true);
  };

  return (
    <article className="mw" hidden={props.hidden}>
      <header className="mw-toolbar">
        <button
          className="mw-up"
          aria-label="Toggle meetings"
          aria-controls="meeting-sidebar"
          aria-expanded={props.sidebarOpen ?? true}
          onClick={props.onToggleSidebar}
        >
          <IconChevronLeft size={16} />
          Meetings
        </button>
        <span className="mw-gap" />
        {narrow ? (
          <button
            className="mw-tool mw-tasks-btn"
            ref={tasksButton}
            aria-haspopup="dialog"
            aria-expanded={tasksOpen}
            onClick={showTasks}
          >
            Tasks <span className="mw-count">({openTasks})</span>
          </button>
        ) : (
          <button
            className="mw-tool mw-toggle"
            aria-pressed={inspectorOpen}
            aria-label="Inspector"
            title={`Inspector · ${chordHint("I")}`}
            onClick={toggleInspector}
          >
            <IconPanelLeft size={16} />
            <span className="mw-keyhint">{chordHint("I")}</span>
          </button>
        )}
        <details
          className="mw-more"
          ref={actions}
          key={meeting.id}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !actions.current?.open) return;
            event.stopPropagation();
            actions.current.open = false;
            focusActions();
          }}
        >
          <summary
            className="mw-tool mw-dots"
            aria-label="More meeting actions"
          >
            <IconMore size={16} />
          </summary>
          <div className="mw-menu">
            <button
              disabled={disabled || titleDraft !== null}
              onClick={startRename}
            >
              Rename
            </button>
            <button
              aria-label="Export Markdown"
              disabled={disabled}
              onClick={() => {
                if (actions.current) actions.current.open = false;
                props.onExport();
              }}
            >
              Export
            </button>
            <button
              aria-haspopup="dialog"
              onClick={() => {
                if (actions.current) actions.current.open = false;
                openHistory();
              }}
            >
              History
            </button>
            {selected.tracks.length > 0 && (
              <button
                disabled={deleteDisabled}
                onClick={() => askDelete("audio")}
              >
                Delete audio…
              </button>
            )}
            <button
              disabled={deleteDisabled}
              onClick={() => askDelete("meeting")}
            >
              Delete meeting…
            </button>
          </div>
        </details>
      </header>

      <div className="mw-banners">{props.banners}</div>

      <div className="mw-body">
        <div className="mw-doc">
          <TranscriptProvider
            hidden={props.hidden}
            tab={tab}
            selected={selected}
            disabled={disabled}
            job={job}
            speechReady={props.speechReady}
            speechReason={speechReason}
            sttMode={props.sttMode}
            transcribeProgress={props.transcribeProgress}
            segmentDraft={props.segmentDraft}
            highlighted={highlighted}
            shownCount={shownSegments}
            onShowThrough={(count) =>
              setSegmentWindow((state) => ({
                meetingId,
                count: Math.max(shownCount(state), count),
              }))
            }
            playersRef={players}
            playbackError={playbackError}
            setPlaybackError={setPlaybackError}
            onSeek={props.onSeek}
            onSegmentDraft={props.onSegmentDraft}
            onSaveSegment={props.onSaveSegment}
            onTranscribe={props.onTranscribe}
            onCancelTranscribe={props.onCancelTranscribe}
            onOpenHistory={openHistory}
            onSpeakerNames={props.onSpeakerNames}
            onOpenSettings={props.onOpenSettings}
          >
            <div className="mw-head">
              {titleDraft === null ? (
                <h1 className="mw-title">
                  <button
                    className="mw-title-btn"
                    ref={titleButton}
                    title={
                      props.sidebarOpen === false
                        ? `${meeting.title} · Rename (F2) · ${chordHint("I")} toggles the inspector`
                        : `${meeting.title} · Rename (F2)`
                    }
                    onClick={startRename}
                  >
                    {meeting.title}
                  </button>
                </h1>
              ) : (
                <input
                  className="mw-title mw-title-input"
                  aria-label="Meeting title"
                  autoFocus
                  maxLength={160}
                  placeholder="Untitled note"
                  ref={titleInput}
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onBlur={() => settleTitle(true)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      focusTitle.current = true;
                      settleTitle(true);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      focusTitle.current = true;
                      settleTitle(false);
                    }
                  }}
                />
              )}
              <div
                className="mw-meta"
                role="group"
                aria-label="Meeting details"
              >
                <span className="mw-meta-item">
                  <IconCalendar size={14} />
                  {formatDateTime(meeting.started_at)}
                </span>
                <span className="mw-meta-item">
                  {sourceLabels[meeting.source]}
                </span>
                <span
                  className={`mw-meta-item mw-meta-duration${
                    meeting.ended_at ? "" : " is-empty"
                  }`}
                >
                  <span className="sr-only">Duration </span>
                  <IconClock size={14} />
                  {formatDuration(meeting.started_at, meeting.ended_at)}
                </span>
                <CalendarEventRow
                  key={`${meeting.id}:${meeting.calendar_event_id ?? ""}`}
                  meetingId={meeting.id}
                  startedAt={meeting.started_at}
                  eventId={meeting.calendar_event_id}
                  disabled={disabled}
                  onOpenMeeting={props.onOpenMeeting}
                />
                <MeetingTagsForm
                  key={`${meeting.id}:${meeting.tags.join(",")}`}
                  meetingId={meeting.id}
                  tags={meeting.tags}
                  disabled={disabled}
                  onTags={(tags) => props.onTags(meeting.id, tags)}
                />
                <MoveToFolder
                  meetingId={meeting.id}
                  folderId={meeting.folder_id}
                  disabled={disabled}
                />
              </div>
              <div
                className="mw-tabs"
                role="tablist"
                aria-label="Meeting content"
                style={
                  {
                    "--mw-tab": Math.max(
                      0,
                      contentTabs.findIndex((item) => item.id === tab),
                    ),
                  } as CSSProperties
                }
              >
                <span className="mw-tabs-ind" aria-hidden="true" />
                {contentTabs.map((item, index) => (
                  <button
                    key={item.id}
                    id={`tab-${item.id}`}
                    role="tab"
                    aria-selected={tab === item.id}
                    aria-controls={`panel-${item.id}`}
                    tabIndex={tab === item.id ? 0 : -1}
                    onClick={() => props.onTab(item.id)}
                    onKeyDown={(event) => {
                      const next = tabTarget(
                        event.key,
                        index,
                        contentTabs.length,
                      );
                      if (next === null) return;
                      event.preventDefault();
                      props.onTab(contentTabs[next].id);
                      document
                        .getElementById(`tab-${contentTabs[next].id}`)
                        ?.focus();
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {props.status && <div className="mw-status">{props.status}</div>}
            </div>
            <div className="mw-alerts">
              {deleting && !props.recordingThis && (
                <div
                  className="dialog-card delete-card"
                  role="group"
                  aria-label={
                    deleting === "meeting"
                      ? "Confirm meeting deletion"
                      : "Confirm audio deletion"
                  }
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.stopPropagation();
                    setDeleting(null);
                    focusActions();
                  }}
                >
                  <p>
                    <strong>
                      {deleting === "meeting"
                        ? `Permanently delete “${meeting.title}”?`
                        : `Permanently delete the audio of “${meeting.title}”?`}
                    </strong>
                  </p>
                  <p>
                    {deleting === "meeting"
                      ? "Deletes its notes, transcript, summaries, audio and the saved answers that used it."
                      : `Removes ${selected.tracks.length} audio track${selected.tracks.length === 1 ? "" : "s"} (${formatBytes(audioBytes)}). Notes, transcript and summaries stay.`}{" "}
                    This cannot be undone.
                  </p>
                  {needsTitle && (
                    <label>
                      Type the meeting title to confirm
                      <input
                        ref={deleteTyped}
                        value={typed}
                        onChange={(event) => setTyped(event.target.value)}
                      />
                    </label>
                  )}
                  <div className="panel-actions">
                    <button
                      className="danger danger-filled"
                      disabled={
                        deleteDisabled ||
                        (needsTitle && typed !== meeting.title)
                      }
                      onClick={() => {
                        setDeleting(null);
                        if (deleting === "meeting") props.onDeleteMeeting();
                        else props.onDeleteAudio();
                      }}
                    >
                      {deleting === "meeting"
                        ? "Delete meeting"
                        : "Delete audio"}
                    </button>
                    <button
                      ref={deleteCancel}
                      onClick={() => {
                        setDeleting(null);
                        focusActions();
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {recoverable && (
                <div
                  className="mw-card"
                  role="group"
                  aria-label="Interrupted recording"
                >
                  <p>Recording was interrupted before its audio finished.</p>
                  <div className="mw-card-row">
                    <button
                      disabled={disabled || job !== null}
                      onClick={props.onRecover}
                    >
                      {job === "recover" ? "Recovering…" : "Recover audio"}
                    </button>
                  </div>
                </div>
              )}
              {nextSteps && (
                <div className="mw-card" role="group" aria-label="Next steps">
                  <p>No transcript yet.</p>
                  <div className="mw-card-row">
                    {props.speechReady ? (
                      <button
                        className="primary"
                        disabled={disabled || job !== null}
                        // Progress and Cancel live on the Transcript tab, so show it while this runs.
                        onClick={() => {
                          props.onTab("transcript");
                          props.onTranscribe();
                        }}
                      >
                        {job === "transcribe"
                          ? "Transcribing…"
                          : "Transcribe audio"}
                      </button>
                    ) : (
                      <>
                        <span className="muted">{speechReason}</span>
                        <OpenSettingsButton
                          section="transcription"
                          onOpenSettings={props.onOpenSettings}
                        />
                      </>
                    )}
                    {/\S/.test(props.notes) && (
                      <button onClick={() => props.onTab("summary")}>
                        Go to Summary
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="mw-scroll">
              <section
                className="notes-panel"
                id="panel-notes"
                role="tabpanel"
                aria-labelledby="tab-notes"
                hidden={tab !== "notes"}
              >
                <label className="sr-only" htmlFor="notes">
                  My notes <span className="muted">({props.notesStatus})</span>
                </label>
                <textarea
                  id="notes"
                  className="mw-editor"
                  value={props.notes}
                  readOnly={disabled}
                  rows={10}
                  placeholder="Start writing. Capture a thought, a decision, or what happens next…"
                  ref={editor}
                  onChange={(event) => props.onNotes(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      !disabled &&
                      props.live &&
                      event.shiftKey &&
                      primaryModifierPressed(event) &&
                      event.key.toLowerCase() === "t"
                    ) {
                      event.preventDefault();
                      void insertTimestamp();
                    }
                  }}
                />
                <div className="mw-efoot">
                  <span className={`mw-saved ${savedState}`}>{savedLabel}</span>
                  <span className="mw-gap" />
                  <button
                    className="mw-mini"
                    disabled={disabled}
                    onClick={props.onSaveNow}
                  >
                    Save notes now
                  </button>
                  <RewriteSelection
                    key={meeting.id}
                    editor={editor}
                    notes={props.notes}
                    disabled={disabled}
                    blocked={
                      job !== null
                        ? { message: "Another task is running.", section: null }
                        : props.llmBlocked
                    }
                    onOpenSettings={props.onOpenSettings}
                    onApply={props.onNotes}
                  />
                  {props.live && (
                    <button
                      className="mw-mini"
                      disabled={disabled}
                      title={`${chordHint("T", ["shift"])} while typing`}
                      onClick={() => void insertTimestamp()}
                    >
                      Insert timestamp
                    </button>
                  )}
                  {playable.length > 0 && (
                    <button
                      className="mw-mini"
                      disabled={disabled}
                      onClick={jumpToAudio}
                    >
                      Jump to audio
                    </button>
                  )}
                  {jumpHint && (
                    <span className="mw-mini-note" role="status">
                      {jumpHint}
                    </span>
                  )}
                </div>
              </section>
              <section
                className="reading-panel"
                id="panel-summary"
                role="tabpanel"
                aria-labelledby="tab-summary"
                hidden={tab !== "summary"}
                tabIndex={0}
              >
                <div className="mw-summary-head">
                  <span className="mw-summary-label">
                    {summaryLabel || "Summary"}
                  </span>
                  <span className="mw-gap" />
                  <label className="mw-inline-label">
                    Template
                    <select
                      value={template}
                      disabled={blocked}
                      onChange={(event) => setTemplate(event.target.value)}
                    >
                      {templates.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                      {props.customTemplates.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {(summary ||
                    (hasSummaryInput && props.llmBlocked === null)) && (
                    <button
                      className="primary"
                      disabled={blocked}
                      aria-describedby={summary ? "enhance-hint" : undefined}
                      onClick={() => props.onGenerate(template)}
                    >
                      {job === "summary" ? "Generating…" : "Create summary"}
                    </button>
                  )}
                </div>
                {summary && stale && (
                  <p className="mw-hint" role="status">
                    Transcript changed after this summary.
                  </p>
                )}
                {summary && props.enhanceBlocked !== null && (
                  <div className="mw-card-row">
                    <span id="enhance-hint" className="mw-hint">
                      {props.enhanceBlocked}
                    </span>
                    {props.llmBlocked && (
                      <OpenSettingsButton
                        section={props.llmBlocked.section}
                        onOpenSettings={props.onOpenSettings}
                      />
                    )}
                  </div>
                )}
                {summaries.length > 1 && (
                  <label className="mw-inline-label">
                    Version
                    <select
                      value={current?.id}
                      disabled={draft !== undefined}
                      onChange={(event) =>
                        setVersionId(Number(event.target.value))
                      }
                    >
                      {summaries.map((version, index) => (
                        <option key={version.id} value={version.id}>
                          {`${summaries.length - index} · ${version.model} · ${templateLabel(version.template, props.customTemplates)}${version.edited_from !== null ? " · edited" : ""}`}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {summaryDraft ? (
                  <div className="summary-edit">
                    <textarea
                      aria-label="Edit summary"
                      value={summaryDraft.text}
                      disabled={disabled}
                      onChange={(event) =>
                        props.onSummaryDraft({
                          ...summaryDraft,
                          text: event.target.value,
                        })
                      }
                    />
                    <div className="mw-card-row">
                      <button
                        className="primary"
                        disabled={disabled || !summaryDraft.text.trim()}
                        onClick={() =>
                          void props
                            .onSaveSummaryEdit(summaryDraft)
                            .then((saved) => saved && setVersionId(null))
                        }
                      >
                        Save edited summary
                      </button>
                      <button
                        disabled={disabled}
                        onClick={() => props.onSummaryDraft(null)}
                      >
                        Discard edit
                      </button>
                    </div>
                  </div>
                ) : summary ? (
                  <div
                    className={`summary-body${summaryIsDraft ? " is-draft" : ""}`}
                  >
                    {renderMarkdown(summary, reference)}
                  </div>
                ) : !hasSummaryInput ? (
                  <p className="mw-hint">Write notes or add a transcript.</p>
                ) : props.llmBlocked ? (
                  <div className="mw-card-row">
                    <span className="mw-hint">
                      Choose an AI model to summarise these notes.
                    </span>
                    <OpenSettingsButton
                      section={props.llmBlocked.section}
                      onOpenSettings={props.onOpenSettings}
                    />
                  </div>
                ) : null}
                {summary && !draft && (
                  <div className="mw-card-row">
                    <button
                      disabled={disabled || !current}
                      onClick={() =>
                        current &&
                        props.onSummaryDraft({
                          baseId: current.id,
                          // Conflicts are checked per kind: the newest plain summary is the one to match.
                          latestId: summaries[0]?.id ?? current.id,
                          text: current.markdown,
                        })
                      }
                    >
                      Edit summary
                    </button>
                    <button onClick={() => void copy(summary, "summary")}>
                      Copy summary
                    </button>
                    <span className="mw-mini-note" role="status">
                      {copyStatus}
                    </span>
                  </div>
                )}
                {summary && provider !== "fixture" && (
                  <p className="mw-hint">
                    AI-generated. Check it against the transcript.
                  </p>
                )}
                <section className="mw-enhanced" aria-label="Enhanced notes">
                  <div className="mw-summary-head">
                    <span className="mw-summary-label">{enhancedLabel}</span>
                    <span className="mw-gap" />
                    <EnhanceNotesButton
                      template={template}
                      label={enhancedCurrent ? "Regenerate" : "Enhance notes"}
                      hasTranscript={selected.segments.length > 0}
                      hasNotes={props.notes.trim() !== ""}
                      modelReady={props.llmBlocked === null}
                      recording={props.live}
                      busy={job === "enhance"}
                      onEnhance={props.onEnhance}
                    />
                  </div>
                  {enhancedCurrent && enhancedCurrent.stale && (
                    <p className="mw-hint" role="status">
                      Notes or transcript changed after these enhanced notes.
                    </p>
                  )}
                  {enhancedDraft ? (
                    <div className="summary-edit">
                      <textarea
                        aria-label="Edit enhanced notes"
                        value={enhancedDraft.text}
                        disabled={disabled}
                        onChange={(event) =>
                          props.onSummaryDraft({
                            ...enhancedDraft,
                            text: event.target.value,
                          })
                        }
                      />
                      <div className="mw-card-row">
                        <button
                          className="primary"
                          disabled={disabled || !enhancedDraft.text.trim()}
                          onClick={() =>
                            void props
                              .onSaveSummaryEdit(enhancedDraft)
                              .then((saved) => saved && setVersionId(null))
                          }
                        >
                          Save edited enhanced notes
                        </button>
                        <button
                          disabled={disabled}
                          onClick={() => props.onSummaryDraft(null)}
                        >
                          Discard edit
                        </button>
                      </div>
                    </div>
                  ) : enhancedCurrent ? (
                    <>
                      <div
                        className={`summary-body${
                          enhancedEdited ? "" : " is-draft"
                        }`}
                      >
                        {renderMarkdown(
                          enhancedCurrent.markdown,
                          noteReference,
                        )}
                      </div>
                      {!draft && (
                        <div className="mw-card-row">
                          <button
                            disabled={disabled}
                            onClick={() =>
                              props.onSummaryDraft({
                                baseId: enhancedCurrent.id,
                                latestId: enhancedCurrent.id,
                                text: enhancedCurrent.markdown,
                              })
                            }
                          >
                            Edit enhanced notes
                          </button>
                        </div>
                      )}
                      <p className="mw-hint">
                        AI-enhanced from your notes. Check the cited segments.
                      </p>
                    </>
                  ) : null}
                </section>
              </section>
              <section
                className="reading-panel"
                id="panel-transcript"
                role="tabpanel"
                aria-labelledby="tab-transcript"
                hidden={tab !== "transcript"}
                tabIndex={0}
              >
                <TranscriptPanel />
              </section>
            </div>
            <TranscriptDock />
          </TranscriptProvider>
        </div>

        {!narrow && (
          <aside
            className="inspector"
            aria-label="Meeting inspector"
            hidden={!inspectorOpen}
          >
            <section className="insp-sec" aria-labelledby="insp-tasks">
              <h2 id="insp-tasks">
                Tasks <span className="mw-count">{openTasks}</span>
                <span className="mw-gap" />
                <button
                  className="insp-mini"
                  title="Copy as Markdown"
                  onClick={copyTasks}
                >
                  <IconCopy size={14} />
                  Copy
                </button>
              </h2>
              <ActionItems
                meetingId={meeting.id}
                items={selected.action_items}
                summaryId={shown?.id ?? versions[0]?.id ?? null}
                disabled={disabled}
                onItems={(items) => props.onActionItems(meeting.id, items)}
                reference={reference}
              />
            </section>
            {selected.tracks.length > 0 && (
              <section className="insp-sec" aria-labelledby="insp-devices">
                <h2 id="insp-devices">Devices</h2>
                <div className="insp-dev">
                  {selected.tracks.map((track) => (
                    <div className="insp-devrow" key={track.kind}>
                      <span className="insp-devkind">
                        {deviceLabels[track.kind] ?? track.kind}
                      </span>
                      <span className="insp-devname">
                        {track.device_name || "Unknown device"}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </aside>
        )}

        {(historyOpen || tasksOpen) && (
          <div className="mw-veil" aria-hidden="true" onClick={closeSheet} />
        )}
        {tasksOpen && (
          <Sheet
            title="Tasks"
            count={openTasks}
            opener={sheetOpener.current}
            onClose={closeSheet}
          >
            <ActionItems
              meetingId={meeting.id}
              items={selected.action_items}
              summaryId={shown?.id ?? versions[0]?.id ?? null}
              disabled={disabled}
              onItems={(items) => props.onActionItems(meeting.id, items)}
              reference={reference}
            />
          </Sheet>
        )}
        {historyOpen && (
          <Sheet
            title="Transcript history"
            opener={sheetOpener.current}
            onClose={closeSheet}
            footer="Earlier transcripts are read-only."
          >
            <TranscriptVersions
              key={meeting.id}
              meetingId={meeting.id}
              versions={selected.transcript_versions}
              names={selected.speaker_names}
            />
          </Sheet>
        )}
      </div>
    </article>
  );
}
