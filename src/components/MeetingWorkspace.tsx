import { useEffect, useRef, useState } from "react";
import {
  api,
  isLocalBase,
  type ActionItem,
  type CustomTemplate,
  type Recipe,
  type SpeakerNames,
  speakerLabel,
  type MeetingDetail,
  type ProcessingPlan,
  type Settings,
  type SummaryVersion,
} from "../lib/api";
import { builtinTemplates as templates } from "../lib/processing";
import { tabTarget } from "../lib/tabs";
import { TextConsent } from "./TextConsent";
import { extractSection, renderMarkdown } from "../lib/markdown";
import { ActionItems } from "./ActionItems";
import { RecipePicker } from "./Recipes";
import { RewriteSelection } from "./RewriteSelection";
import { MeetingTagsForm } from "./MeetingTags";
import { SpeakerNamesForm } from "./SpeakerNames";
import { TranscriptVersions } from "./TranscriptVersions";
import { formatBytes, sourceLabels } from "../lib/meeting-labels";
import {
  formatTimestamp,
  parseTimestamp,
  segmentsAt,
  timestampAtCaret,
} from "../lib/timestamps";

const trackLabels: Record<string, string> = {
  mic: "You (microphone)",
  system: "Others (system audio)",
};

const templateLabel = (id: string, custom: CustomTemplate[]) =>
  templates.find((template) => template.id === id)?.label ??
  custom.find((template) => template.id === id)?.name ??
  ({ "summary-v1": "General", fixture: "Sample" } as Record<string, string>)[
    id
  ] ??
  (id.startsWith("custom-") ? "Deleted custom template" : id);

/** A follow-up sends this many of the thread's latest turns; keep equal to the backend limit. */
const FOLLOW_UP_TURNS = 6;
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
  speechReady: boolean;
  /** Why summary generation is unavailable, or null when it can run. */
  enhanceBlocked: string | null;
  /** Why the summary/question provider cannot be used at all, or null. */
  llmBlocked: string | null;
  sttMode: Settings["stt_mode"];
  connectionRevision: string;
  onTab: (tab: ContentTab) => void;
  onNotes: (text: string) => void;
  onSaveNow: () => void;
  onExport: () => void;
  onPlanTranscription: () => Promise<ProcessingPlan | null>;
  onTranscribe: (confirmation: string | null) => void;
  /** `template` is a built-in id or a custom template id. */
  onGenerate: (template: string, confirmation: string) => void;
  /** Stored summaries, newest first. */
  versions: SummaryVersion[];
  customTemplates: CustomTemplate[];
  /** The template the picker starts at, from Settings. */
  defaultTemplate: string;
  /** Saved question prompts; built-in recipes are added by the picker. */
  recipes: Recipe[];
  /** Saved personal instructions sent with every summary. */
  summaryInstructions: string;
  onPlanSummary: (template: string) => Promise<ProcessingPlan | null>;
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
  /** `threadId` continues a saved thread; null starts a new one. */
  onPlanQuestion: (
    question: string,
    threadId: number | null,
  ) => Promise<ProcessingPlan | null>;
  onAsk: (
    question: string,
    threadId: number | null,
    confirmation: string,
  ) => void;
  onDeleteThread: (threadId: number) => void;
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
  /** A library-answer citation to open once its meeting is selected. */
  pendingJump: { meetingId: string; ms: number | null } | null;
  onJumpDone: () => void;
};

export function MeetingWorkspace(props: Props) {
  const { selected, tab, disabled, job, versions } = props;
  const [confirming, setConfirming] = useState<ProcessingPlan | null>(null);
  const [confirmingAudio, setConfirmingAudio] = useState<ProcessingPlan | null>(
    null,
  );
  const [chosenTemplate, setTemplate] = useState(props.defaultTemplate);
  useEffect(() => setTemplate(props.defaultTemplate), [props.defaultTemplate]);
  // A deleted custom template falls back to General instead of failing at send time.
  const template =
    templates.some((item) => item.id === chosenTemplate) ||
    props.customTemplates.some((item) => item.id === chosenTemplate)
      ? chosenTemplate
      : "general-v1";
  // Content key, not array identity, so a settings refresh keeps an open review.
  const customKey = JSON.stringify(props.customTemplates);
  const [versionId, setVersionId] = useState<number | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState<ProcessingPlan | null>(null);
  // A thread id, "new" for the empty form, or null to show the newest thread.
  const [chosenThread, setChosenThread] = useState<number | "new" | null>(null);
  const [deletingThread, setDeletingThread] = useState(false);
  const threads = selected?.question_threads ?? [];
  const activeThread =
    chosenThread === "new"
      ? null
      : (threads.find((thread) => thread.id === chosenThread) ??
        threads[0] ??
        null);
  const earlierTurns = Math.min(
    activeThread?.turns.length ?? 0,
    FOLLOW_UP_TURNS,
  );
  const turnTotal = threads.reduce(
    (sum, thread) => sum + thread.turns.length,
    0,
  );
  const planVersion = useRef(0);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
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
  const meetingId = selected?.meeting.id;
  const [deleting, setDeleting] = useState<"meeting" | "audio" | null>(null);
  const [typed, setTyped] = useState("");
  useEffect(() => {
    setConfirming(null);
    setAsking(null);
    setQuestion("");
    setChosenThread(null);
    setDeletingThread(false);
    setDeleting(null);
    setTyped("");
    setTitleDraft(null);
    setJumpHint("");
    setPlaybackError("");
    if (actions.current) actions.current.open = false;
  }, [meetingId]);
  useEffect(() => {
    planVersion.current += 1;
    setConfirming(null);
    setAsking(null);
    setConfirmingAudio(null);
  }, [
    meetingId,
    props.notes,
    selected?.segments,
    props.connectionRevision,
    props.sttMode,
    template,
    question,
    activeThread?.id,
    selected?.question_threads,
    customKey,
    props.summaryInstructions,
  ]);
  // A saved answer clears the box and shows its thread; a deleted thread closes the prompt.
  const newestThread = threads[0]?.id;
  useEffect(() => {
    setChosenThread(null);
    setQuestion("");
  }, [newestThread]);
  useEffect(() => {
    setQuestion("");
  }, [turnTotal]);
  useEffect(() => setDeletingThread(false), [activeThread?.id]);
  const reviewPlan = async (
    load: () => Promise<ProcessingPlan | null>,
    show: (plan: ProcessingPlan | null) => void,
  ) => {
    const version = planVersion.current;
    const plan = await load();
    if (version === planVersion.current) show(plan);
  };
  useEffect(() => {
    if (tab !== "transcript" || props.hidden)
      Object.values(players.current).forEach((player) => player?.pause());
  }, [tab, props.hidden]);
  useEffect(() => {
    setVersionId(null);
    setCopyStatus("");
  }, [versions]);
  useEffect(() => setHighlighted([]), [meetingId]);
  // Runs after the effects above, so their resets cannot undo the jump.
  const jump = props.pendingJump;
  useEffect(() => {
    if (!jump || selected?.meeting.id !== jump.meetingId) return;
    props.onJumpDone();
    const target =
      jump.ms === null
        ? null
        : citationTarget(selected, segmentsAt(selected.segments, jump.ms));
    if (!target) return;
    setHighlighted(target.highlighted);
    setPendingReference(target.pending);
    props.onTab("transcript");
  });
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

  if (!selected) {
    return (
      <article className="content-area" hidden={props.hidden}>
        <div className="empty-workspace">
          <div className="empty-mark" aria-hidden="true">
            ✎
          </div>
          <span className="eyebrow">A little room to think</span>
          {props.firstRun ? (
            <>
              <h2>Start your first note</h2>
              <p>
                Choose New note or New recording in the sidebar. Your notes stay
                on this device.
              </p>
            </>
          ) : (
            <>
              <h2>Your meeting notes, on your device.</h2>
              <p>
                Select a meeting to edit notes and export a Markdown snapshot.
              </p>
            </>
          )}
        </div>
      </article>
    );
  }
  const { meeting } = selected;
  const playable = playableTracks(selected);
  const transcribable = playable.length > 0;
  const hasTranscript = selected.segments.length > 0;
  const audioBytes = selected.tracks.reduce(
    (total, track) => total + (track.size_bytes ?? 0),
    0,
  );
  const deleteDisabled = disabled || job !== null || props.recordingThis;
  const askDelete = (what: "meeting" | "audio") => {
    if (actions.current) actions.current.open = false;
    setTyped("");
    setDeleting(what);
  };
  // Viewing an older version is display-only; export keeps using the latest.
  const shown = versions.find((version) => version.id === versionId);
  const summary = shown?.markdown ?? selected.summary;
  const provider = shown?.provider ?? selected.summary_provider;
  const model = shown?.model ?? selected.summary_model;
  const current = shown ?? versions[0];
  const edited = current
    ? current.edited_from !== null
    : selected.summary_edited;
  const versionName = (id: number | null) => {
    const index = versions.findIndex((version) => version.id === id);
    return index < 0
      ? "an earlier version"
      : `version ${versions.length - index}`;
  };
  const draft = props.summaryDraft;
  const stale = current ? current.stale : selected.summary_stale;
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
          setHighlighted(target.highlighted);
          setPendingReference(target.pending);
          props.onTab("transcript");
        }}
      >
        {token}
      </button>
    );
  };
  const insertTimestamp = async () => {
    const offset = await props.getRecordingOffset();
    const area = editor.current;
    if (offset === null || !area) return;
    const { selectionStart: start, selectionEnd: end, value } = area;
    const stamp = `${formatTimestamp(offset)} `;
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
      setJumpHint("Put the cursor on a line with a [mm:ss] timestamp.");
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
  const summaryLabel =
    meeting.source === "fixture" && provider === "fixture"
      ? "Sample summary (hand-written)"
      : summary
        ? edited
          ? `Summary · edited by you, based on ${versionName(current?.edited_from ?? null)}`
          : `Summary · generated by ${model ?? "a model"} via ${provider ?? "provider"}`
        : "Summary";
  const actionItems = summary ? extractSection(summary, "Action items") : null;
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus(`Copied ${what}.`);
    } catch {
      setCopyStatus(`Could not copy ${what}: the clipboard is unavailable.`);
    }
  };
  const blocked = disabled || job !== null || props.enhanceBlocked !== null;
  const named =
    selected.speaker_names.you !== null ||
    selected.speaker_names.others !== null;
  const contentScope = `your notes (${props.notes.length} characters) and the transcript text (${selected.segments.length} segments${named ? ", with your speaker names" : ""})`;
  const recoverable =
    meeting.source === "desktop" &&
    meeting.status === "interrupted" &&
    selected.tracks.some((track) => !track.finalized);
  const startRename = () => {
    if (!disabled) setTitleDraft(meeting.title);
  };

  return (
    <article className="content-area" hidden={props.hidden}>
      <div className="meeting-heading">
        {titleDraft === null ? (
          <h1 className="meeting-title" onClick={startRename}>
            {meeting.title}
          </h1>
        ) : (
          <input
            className="meeting-title meeting-title-input"
            aria-label="Meeting title"
            autoFocus
            maxLength={160}
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={() => setTitleDraft(null)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                setTitleDraft(null);
                // The backend trims and validates; an invalid title is reported, not saved.
                if (titleDraft !== meeting.title) props.onRename(titleDraft);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setTitleDraft(null);
              }
            }}
          />
        )}
        <div className="meeting-actions">
          <button
            disabled={disabled || titleDraft !== null}
            onClick={startRename}
          >
            Rename
          </button>
          <button disabled={disabled} onClick={props.onExport}>
            Export Markdown
          </button>
          <details className="more-actions" ref={actions} key={meeting.id}>
            <summary aria-label="More meeting actions">•••</summary>
            <div className="action-menu">
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
        </div>
      </div>
      <MeetingTagsForm
        key={`${meeting.id}:${meeting.tags.join(",")}`}
        meetingId={meeting.id}
        tags={meeting.tags}
        disabled={disabled}
        onTags={(tags) => props.onTags(meeting.id, tags)}
      />
      {deleting && !props.recordingThis && (
        <div
          className="consent-card delete-card"
          role="group"
          aria-label={
            deleting === "meeting"
              ? "Confirm meeting deletion"
              : "Confirm audio deletion"
          }
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
              ? "Removes its notes, transcript, summaries, audio files and any saved cross-meeting answers that used it from this device."
              : `Removes ${selected.tracks.length} audio track${selected.tracks.length === 1 ? "" : "s"} (${formatBytes(audioBytes)}) and their timing files. Notes, transcript and summaries are kept.`}{" "}
            Exported Markdown snapshots are not touched. This cannot be undone.
          </p>
          <label>
            Type the meeting title to confirm
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </label>
          <div className="panel-actions">
            <button
              className="danger"
              disabled={deleteDisabled || typed !== meeting.title}
              onClick={() => {
                setDeleting(null);
                if (deleting === "meeting") props.onDeleteMeeting();
                else props.onDeleteAudio();
              }}
            >
              {deleting === "meeting" ? "Delete meeting" : "Delete audio"}
            </button>
            <button onClick={() => setDeleting(null)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="meeting-meta">
        <span className="source-badge">{sourceLabels[meeting.source]}</span>
        <time dateTime={meeting.started_at}>
          {new Date(meeting.started_at).toLocaleString()}
        </time>
        <span className="save-status" role="status">
          {props.notesStatus === "error"
            ? "Not saved"
            : props.notesStatus === "saving"
              ? "Saving…"
              : "Saved"}
        </span>
      </div>
      {recoverable && (
        <div
          className="consent-card"
          role="group"
          aria-label="Interrupted recording"
        >
          <p>
            This recording was interrupted before its audio files were finished,
            so they cannot be transcribed yet.
          </p>
          <div className="panel-actions">
            <button
              disabled={disabled || job !== null}
              onClick={props.onRecover}
            >
              {job === "recover" ? "Recovering…" : "Recover audio"}
            </button>
            <span className="muted">
              Writes repaired copies next to the originals. The original files
              are not changed.
            </span>
          </div>
        </div>
      )}
      <div className="content-tabs" role="tablist" aria-label="Meeting content">
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
              const next = tabTarget(event.key, index, contentTabs.length);
              if (next === null) return;
              event.preventDefault();
              props.onTab(contentTabs[next].id);
              document.getElementById(`tab-${contentTabs[next].id}`)?.focus();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="document-canvas">
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
            className="notes-editor"
            value={props.notes}
            disabled={disabled}
            rows={10}
            placeholder="Start writing. Capture a thought, a decision, or what happens next…"
            ref={editor}
            onChange={(event) => props.onNotes(event.target.value)}
            onKeyDown={(event) => {
              if (
                props.live &&
                event.shiftKey &&
                (event.ctrlKey || event.metaKey) &&
                event.key.toLowerCase() === "t"
              ) {
                event.preventDefault();
                void insertTimestamp();
              }
            }}
          />
          <div className="editor-footer">
            <button disabled={disabled} onClick={props.onSaveNow}>
              Save notes now
            </button>
            <RewriteSelection
              key={meeting.id}
              editor={editor}
              notes={props.notes}
              disabled={disabled}
              blocked={
                job !== null ? "Another task is running." : props.llmBlocked
              }
              onApply={props.onNotes}
            />
            {props.live && (
              <button
                disabled={disabled}
                title="Ctrl+Shift+T while typing"
                onClick={() => void insertTimestamp()}
              >
                Insert timestamp
              </button>
            )}
            {playable.length > 0 && (
              <button disabled={disabled} onClick={jumpToAudio}>
                Jump to audio
              </button>
            )}
            {jumpHint && (
              <span className="muted" role="status">
                {jumpHint}
              </span>
            )}
            <span className="muted">
              Autosaved on this device · Markdown supported
            </span>
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
          <div className="summary-heading">
            <h3>{summaryLabel}</h3>
            <div className="panel-actions">
              <label>
                Template{" "}
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
              <button
                className="primary"
                disabled={blocked}
                aria-describedby="enhance-hint"
                onClick={() =>
                  void reviewPlan(
                    () => props.onPlanSummary(template),
                    setConfirming,
                  )
                }
              >
                {job === "summary" ? "Generating…" : "Enhance notes"}
              </button>
            </div>
          </div>
          {summary && stale && (
            <p className="muted" role="status">
              The transcript or speaker names changed after this summary was
              made. Generate a new summary to include the changes. Time links
              point to the current transcript.
            </p>
          )}
          {props.enhanceBlocked !== null && (
            <p id="enhance-hint" className="muted">
              {props.enhanceBlocked}
            </p>
          )}
          {confirming !== null && props.enhanceBlocked === null && (
            <div
              className="consent-card"
              role="group"
              aria-label="Confirm sending"
            >
              <p>
                <strong>
                  Send text to your selected provider to generate a summary?
                </strong>
              </p>
              <TextConsent
                plan={confirming}
                note="A new summary is saved beside any earlier one; your notes are never changed."
              >
                <li>
                  Template: {templateLabel(template, props.customTemplates)}
                </li>
                {props.summaryInstructions !== "" && (
                  <li>Includes your saved summary instructions.</li>
                )}
                <li>Sent: {contentScope}.</li>
                <li>
                  Requests:{" "}
                  {confirming.requests === 1
                    ? "1 request."
                    : `${confirming.requests} requests (the transcript in ${confirming.requests - 1} parts, then one pass combining them with your notes).`}
                </li>
                <li>Not sent: audio recordings.</li>
                {versions[0]?.edited_from != null && (
                  <li>
                    Your edited summary stays in history; the new summary
                    becomes the current version.
                  </li>
                )}
              </TextConsent>
              <div className="panel-actions">
                <button
                  className="primary"
                  disabled={disabled || job !== null}
                  onClick={() => {
                    setConfirming(null);
                    props.onGenerate(template, confirming.fingerprint);
                  }}
                >
                  Send and generate summary
                </button>
                <button onClick={() => setConfirming(null)}>Cancel</button>
              </div>
            </div>
          )}
          {versions.length > 1 && (
            <label className="summary-version">
              Version{" "}
              <select
                value={shown?.id ?? versions[0].id}
                disabled={draft !== undefined}
                onChange={(event) => setVersionId(Number(event.target.value))}
              >
                {versions.map((version, index) => (
                  <option key={version.id} value={version.id}>
                    {`Version ${versions.length - index} · ${version.model} · ${templateLabel(version.template, props.customTemplates)}${version.edited_from !== null ? " · edited" : ""}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          {draft ? (
            <div className="summary-edit">
              <textarea
                aria-label="Edit summary"
                value={draft.text}
                onChange={(event) =>
                  props.onSummaryDraft({ ...draft, text: event.target.value })
                }
              />
              <p className="muted">
                Saving adds a new version. Earlier versions stay in history.
              </p>
              <div className="panel-actions">
                <button
                  className="primary"
                  disabled={disabled || !draft.text.trim()}
                  onClick={() =>
                    void props
                      .onSaveSummaryEdit(draft)
                      .then((saved) => saved && setVersionId(null))
                  }
                >
                  Save edited summary
                </button>
                <button onClick={() => props.onSummaryDraft(null)}>
                  Discard edit
                </button>
              </div>
            </div>
          ) : summary ? (
            <div className="summary-body">
              {renderMarkdown(summary, reference)}
            </div>
          ) : (
            <p className="muted">
              No summary yet. Use Enhance notes after adding notes or a
              transcript.
            </p>
          )}
          {summary && !draft && (
            <div className="panel-actions">
              <button
                disabled={disabled || !current}
                onClick={() =>
                  current &&
                  props.onSummaryDraft({
                    baseId: current.id,
                    latestId: versions[0].id,
                    text: current.markdown,
                  })
                }
              >
                Edit summary
              </button>
              <button onClick={() => void copy(summary, "summary")}>
                Copy summary
              </button>
              <button
                disabled={!actionItems}
                onClick={() =>
                  actionItems && void copy(actionItems, "action items")
                }
              >
                Copy action items
              </button>
              <span className="muted" role="status">
                {copyStatus}
              </span>
            </div>
          )}
          {summary && provider !== "fixture" && (
            <p className="muted">
              {edited
                ? "Edited by you from AI output. Check it against the transcript before relying on it."
                : "AI-generated. Check it against the transcript before relying on it."}
            </p>
          )}
          <ActionItems
            meetingId={selected.meeting.id}
            items={selected.action_items}
            summaryId={shown?.id ?? versions[0]?.id ?? null}
            disabled={disabled}
            onItems={(items) => props.onActionItems(selected.meeting.id, items)}
            reference={reference}
          />
          {threads.length > 0 && (
            <div className="panel-actions">
              <select
                aria-label="Question threads"
                value={activeThread?.id ?? ""}
                onChange={(event) =>
                  setChosenThread(Number(event.target.value))
                }
              >
                {!activeThread && <option value="">New question</option>}
                {threads.map((thread) => (
                  <option key={thread.id} value={thread.id}>
                    {thread.turns[0]?.question.slice(0, 60)}
                  </option>
                ))}
              </select>
              <button
                disabled={!activeThread}
                onClick={() => setChosenThread("new")}
              >
                New question
              </button>
              {activeThread && (
                <button
                  disabled={disabled || job !== null}
                  onClick={() => setDeletingThread(true)}
                >
                  Delete thread
                </button>
              )}
            </div>
          )}
          {deletingThread && activeThread && (
            <div
              className="consent-card"
              role="group"
              aria-label="Confirm deleting question thread"
            >
              <p>
                <strong>Delete this question thread?</strong> Its{" "}
                {activeThread.turns.length} saved question
                {activeThread.turns.length === 1 ? "" : "s"} and answers are
                removed from this device. Your notes and transcript are kept.
              </p>
              <div className="panel-actions">
                <button
                  className="primary"
                  onClick={() => {
                    setDeletingThread(false);
                    props.onDeleteThread(activeThread.id);
                  }}
                >
                  Delete thread permanently
                </button>
                <button onClick={() => setDeletingThread(false)}>Keep</button>
              </div>
            </div>
          )}
          <form
            className="ask-meeting"
            onSubmit={(event) => {
              event.preventDefault();
              if (question.trim())
                void reviewPlan(
                  () =>
                    props.onPlanQuestion(
                      question.trim(),
                      activeThread?.id ?? null,
                    ),
                  setAsking,
                );
            }}
          >
            <label htmlFor="ask-question">
              {activeThread ? "Ask a follow-up" : "Ask this meeting"}
            </label>
            <RecipePicker
              recipes={props.recipes}
              disabled={blocked}
              onPick={(prompt) => {
                setQuestion(prompt);
                setAsking(null);
              }}
            />
            <textarea
              id="ask-question"
              rows={2}
              maxLength={1000}
              value={question}
              placeholder="What did we decide about the launch date?"
              onChange={(event) => {
                setQuestion(event.target.value);
                setAsking(null);
              }}
            />
            <div className="panel-actions">
              <button type="submit" disabled={blocked || !question.trim()}>
                {job === "ask" ? "Asking…" : "Ask"}
              </button>
            </div>
          </form>
          {asking && props.enhanceBlocked === null && (
            <div
              className="consent-card"
              role="group"
              aria-label="Confirm sending question"
            >
              <p>
                <strong>Send this question to your selected provider?</strong>
              </p>
              <TextConsent
                plan={asking}
                note="The question and answer are saved with this meeting on this device, unencrypted."
              >
                <li>
                  Sent in {asking.requests} request(s): your question,{" "}
                  {asking.excerpts
                    ? `${asking.excerpts.segments} transcript excerpts selected on this device by keyword match, plus your notes if they mention a keyword (only the matching paragraphs when the notes are long), from this meeting only — not the full transcript`
                    : `${contentScope} of this meeting only`}
                  .
                </li>
                {earlierTurns > 0 && (
                  <li>
                    Includes {earlierTurns} earlier question
                    {earlierTurns === 1 ? "" : "s"} and answer
                    {earlierTurns === 1 ? "" : "s"} from this thread.
                  </li>
                )}
                <li>Not sent: audio recordings or other meetings.</li>
              </TextConsent>
              <div className="panel-actions">
                <button
                  className="primary"
                  disabled={disabled || job !== null}
                  onClick={() => {
                    setAsking(null);
                    props.onAsk(
                      question.trim(),
                      activeThread?.id ?? null,
                      asking.fingerprint,
                    );
                  }}
                >
                  Send question
                </button>
                <button onClick={() => setAsking(null)}>Cancel</button>
              </div>
            </div>
          )}
          {activeThread?.turns.map((turn) => (
            <div className="ask-answer" aria-label="Answer" key={turn.id}>
              <p>
                <strong>Q: {turn.question}</strong>
              </p>
              {renderMarkdown(turn.answer, reference)}
              <p className="muted">
                AI-generated from this meeting's notes and transcript. Saved on
                this device; check it before relying on it.
              </p>
            </div>
          ))}
        </section>
        <section
          className="reading-panel"
          id="panel-transcript"
          role="tabpanel"
          aria-labelledby="tab-transcript"
          hidden={tab !== "transcript"}
          tabIndex={0}
        >
          <div className="section-intro">
            <h3>Transcript</h3>
            <p className="muted">
              Follow the conversation. Select a timestamp to listen.
            </p>
          </div>
          {playbackError && (
            <p className="error" role="alert">
              {playbackError}
            </p>
          )}
          {playable.map((track) => (
            <div className="audio-player" key={track.kind}>
              <span aria-hidden="true">
                {trackLabels[track.kind] ?? track.kind}
              </span>
              <audio
                controls
                preload="metadata"
                aria-label={trackLabels[track.kind] ?? track.kind}
                src={api.audioSrc(track.path)}
                onError={() =>
                  setPlaybackError(
                    "An audio file could not be opened. It may have been moved or is incomplete.",
                  )
                }
                ref={(element) => {
                  players.current[track.kind] = element;
                }}
              />
            </div>
          ))}
          {selected.tracks.length > 0 && (
            <details className="track-details">
              <summary>Audio track details</summary>
              {selected.tracks.map((track) => (
                <p key={track.kind}>
                  {track.kind}: {track.path}
                  {track.size_bytes === null
                    ? " (file missing)"
                    : ` (${formatBytes(track.size_bytes)})`}
                </p>
              ))}
            </details>
          )}
          {!hasTranscript && (
            <p className="muted">
              {transcribable
                ? "No transcript yet."
                : meeting.source === "note"
                  ? "No transcript. Notes have no recorded audio."
                  : meeting.source !== "desktop"
                    ? "No transcript. Fictional samples and simulations have no recorded audio."
                    : meeting.status === "recording" ||
                        meeting.status === "paused"
                      ? "No transcript yet. Stop the recording first."
                      : "No transcript. This recording has no finalized audio tracks."}
            </p>
          )}
          {transcribable && (
            <div className="panel-actions">
              <button
                className="primary"
                disabled={disabled || job !== null || !props.speechReady}
                onClick={() => {
                  if (props.sttMode === "cloud")
                    void reviewPlan(
                      props.onPlanTranscription,
                      setConfirmingAudio,
                    );
                  else props.onTranscribe(null);
                }}
              >
                {job === "transcribe"
                  ? props.sttMode === "cloud"
                    ? "Transcribing with cloud provider…"
                    : "Transcribing locally…"
                  : hasTranscript
                    ? "Re-transcribe audio"
                    : "Transcribe audio"}
              </button>
              {hasTranscript && (
                <span className="muted">
                  Re-transcribing keeps the current transcript
                  {selected.segment_meta.some((meta) => meta.original_text)
                    ? ", including your edits,"
                    : ""}{" "}
                  as an earlier transcript.
                </span>
              )}
              {!props.speechReady && (
                <span className="muted">
                  {props.sttMode === "cloud"
                    ? "Save a cloud speech connection and model in Settings first."
                    : "Download the speech engine in Settings first."}
                </span>
              )}
              {job === "transcribe" && (
                <>
                  <button
                    disabled={
                      Object.keys(props.transcribeProgress).length === 0
                    }
                    onClick={props.onCancelTranscribe}
                  >
                    Cancel transcription
                  </button>
                  <span className="muted" role="status">
                    {props.sttMode === "cloud"
                      ? "Cancelling stops further uploads and keeps the previous transcript. An in-flight request may finish remotely and still be billed."
                      : "This runs on your computer and can take about as long as the recording. Cancelling keeps the previous transcript."}
                  </span>
                </>
              )}
            </div>
          )}
          {confirmingAudio && transcribable && (
            <div
              className="consent-card"
              role="group"
              aria-label="Confirm audio upload"
            >
              <p>
                <strong>Upload recorded audio for transcription?</strong>
              </p>
              <ul>
                <li>
                  Destination: <code>{confirmingAudio.base_url}</code>
                </li>
                <li>
                  Model: <code>{confirmingAudio.model}</code>
                </li>
                <li>
                  Tracks: {confirmingAudio.tracks.join(", ")}. Audio:{" "}
                  {formatBytes(confirmingAudio.audio_bytes)}. Requests:{" "}
                  {confirmingAudio.requests}.
                </li>
                <li>
                  {isLocalBase(confirmingAudio.base_url)
                    ? "Audio is sent to your local server. Its configuration determines whether it forwards requests."
                    : "Microphone and system audio leave this device. Your provider handles retention and billing."}
                </li>
                <li>
                  Cancelling prevents further uploads. Audio already received
                  cannot be recalled, and an in-flight request may finish
                  remotely.
                </li>
                <li>
                  A successful run replaces the current transcript and keeps it,
                  including any edits, as an earlier transcript. Notes and
                  original audio are kept.
                </li>
              </ul>
              <div className="panel-actions">
                <button
                  className="primary"
                  disabled={disabled || job !== null}
                  onClick={() => {
                    setConfirmingAudio(null);
                    props.onTranscribe(confirmingAudio.fingerprint);
                  }}
                >
                  Upload and transcribe audio
                </button>
                <button onClick={() => setConfirmingAudio(null)}>Cancel</button>
              </div>
            </div>
          )}
          {job === "transcribe" &&
            Object.entries(props.transcribeProgress).map(([kind, percent]) => (
              <label className="audio-player" key={kind}>
                {kind === "preparing"
                  ? "Preparing audio…"
                  : `Transcribing ${trackLabels[kind] ?? kind}: ${percent}%`}
                <progress max={100} value={percent} />
              </label>
            ))}
          {hasTranscript && meeting.source === "desktop" && (
            <p className="muted">
              {selected.transcript_provider === "whisper"
                ? "Generated locally with Whisper."
                : `Generated with ${selected.transcript_provider ?? "an earlier transcription engine"}${selected.transcript_model ? ` / ${selected.transcript_model}` : ""}.`}{" "}
              “You” is your microphone, “Others” is system audio. Check names
              and numbers before relying on it.
            </p>
          )}
          {hasTranscript && (
            <SpeakerNamesForm
              key={`${meeting.id}:${selected.speaker_names.you ?? ""}:${selected.speaker_names.others ?? ""}`}
              meetingId={meeting.id}
              names={selected.speaker_names}
              disabled={disabled}
              onNames={(names) => props.onSpeakerNames(meeting.id, names)}
            />
          )}
          <TranscriptVersions
            key={meeting.id}
            meetingId={meeting.id}
            versions={selected.transcript_versions}
            names={selected.speaker_names}
          />
          {selected.segments.some(
            (segment) => segment.timing.kind === "untimed",
          ) && (
            <p className="muted">
              Untimed text has no playback links. Track/chunk order does not
              establish the order of utterances across tracks.
            </p>
          )}
          {selected.segments.map((segment, index) => {
            const kind = segment.speaker === "You" ? "mic" : "system";
            const speaker = speakerLabel(
              selected.speaker_names,
              segment.speaker,
            );
            const meta = selected.segment_meta[index];
            const draft =
              meta &&
              props.segmentDraft?.meetingId === meeting.id &&
              props.segmentDraft.segmentId === meta.id
                ? props.segmentDraft
                : null;
            const editLocked = disabled || job !== null;
            const timing = segment.timing;
            const time =
              timing.kind === "timed"
                ? `${(timing.start_ms / 1000).toFixed(1)}s`
                : "Untimed";
            return (
              <p
                className={
                  meta && highlighted.includes(meta.id)
                    ? "transcript-segment highlighted-segment"
                    : "transcript-segment"
                }
                key={index}
                id={meta ? `segment-${meta.id}` : undefined}
                tabIndex={-1}
              >
                <strong>{speaker}</strong>{" "}
                {timing.kind === "timed" &&
                playable.some((track) => track.kind === kind) ? (
                  <button
                    className="seek-button"
                    aria-label={`Play ${speaker} from ${time}`}
                    onClick={() =>
                      void props
                        .onSeek(kind, timing.start_ms)
                        .then((fileMs) => {
                          if (fileMs !== null) play(kind, fileMs);
                        })
                    }
                  >
                    {time}
                  </button>
                ) : (
                  <span className="muted">{time}</span>
                )}{" "}
                —{" "}
                {draft ? (
                  <span className="segment-edit">
                    <input
                      aria-label={`Edit segment at ${time}`}
                      value={draft.text}
                      maxLength={20000}
                      onChange={(event) =>
                        props.onSegmentDraft({
                          ...draft,
                          text: event.target.value,
                        })
                      }
                    />
                    <button
                      disabled={editLocked || !draft.text.trim()}
                      onClick={() => void props.onSaveSegment(draft)}
                    >
                      Save
                    </button>
                    <button onClick={() => props.onSegmentDraft(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <>
                    {segment.text}
                    {meta && (
                      <>
                        {" "}
                        {meta.original_text !== null && (
                          <span
                            className="muted"
                            title={`Original: ${meta.original_text}`}
                          >
                            (edited)
                          </span>
                        )}{" "}
                        <button
                          className="seek-button"
                          aria-label={`Edit segment at ${time}`}
                          disabled={editLocked || props.segmentDraft !== null}
                          onClick={() =>
                            props.onSegmentDraft({
                              meetingId: meeting.id,
                              segmentId: meta.id,
                              baseText: segment.text,
                              text: segment.text,
                            })
                          }
                        >
                          Edit
                        </button>
                        {meta.original_text !== null && (
                          <button
                            className="seek-button"
                            aria-label={`Revert segment at ${time}`}
                            disabled={editLocked || props.segmentDraft !== null}
                            onClick={() =>
                              void props.onSaveSegment({
                                meetingId: meeting.id,
                                segmentId: meta.id,
                                baseText: segment.text,
                                text: meta.original_text ?? segment.text,
                              })
                            }
                          >
                            Revert
                          </button>
                        )}
                      </>
                    )}
                  </>
                )}
              </p>
            );
          })}
        </section>
      </div>
    </article>
  );
}
