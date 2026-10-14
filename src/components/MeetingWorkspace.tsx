import { useEffect, useRef, useState } from "react";
import {
  api,
  isLocalBase,
  type MeetingDetail,
  type ProcessingPlan,
  type Settings,
  type SummaryTemplate,
  type SummaryVersion,
} from "../lib/api";
import { extractSection, renderMarkdown } from "../lib/markdown";
import { formatBytes, sourceLabels } from "../lib/meeting-labels";
import { formatTimestamp, timestampAtCaret } from "../lib/timestamps";

const trackLabels: Record<string, string> = {
  mic: "You (microphone)",
  system: "Others (system audio)",
};

const templates: { id: SummaryTemplate; label: string }[] = [
  { id: "general-v1", label: "General" },
  { id: "standup-v1", label: "Stand-up" },
  { id: "one-to-one-v1", label: "One-to-one" },
];
const templateLabel = (id: string) =>
  templates.find((template) => template.id === id)?.label ??
  ({ "summary-v1": "General", fixture: "Sample" } as Record<string, string>)[
    id
  ] ??
  id;

export type Answer = { meetingId: string; question: string; text: string };

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
  sttMode: Settings["stt_mode"];
  connectionRevision: string;
  onTab: (tab: ContentTab) => void;
  onNotes: (text: string) => void;
  onSaveNow: () => void;
  onExport: () => void;
  onPlanTranscription: () => Promise<ProcessingPlan | null>;
  onTranscribe: (confirmation: string | null) => void;
  onGenerate: (template: SummaryTemplate, confirmation: string) => void;
  /** Stored summaries, newest first. */
  versions: SummaryVersion[];
  onPlanSummary: (template: SummaryTemplate) => Promise<ProcessingPlan | null>;
  onPlanQuestion: (question: string) => Promise<ProcessingPlan | null>;
  onAsk: (question: string, confirmation: string) => void;
  answer: Answer | null;
  /** The selected meeting is being recorded right now, so it cannot be deleted. */
  recordingThis: boolean;
  onDeleteMeeting: () => void;
  onDeleteAudio: () => void;
  onRename: (title: string) => void;
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
};

export function MeetingWorkspace(props: Props) {
  const { selected, tab, disabled, job, versions } = props;
  const [confirming, setConfirming] = useState<ProcessingPlan | null>(null);
  const [confirmingAudio, setConfirmingAudio] = useState<ProcessingPlan | null>(
    null,
  );
  const [template, setTemplate] = useState<SummaryTemplate>("general-v1");
  const [versionId, setVersionId] = useState<number | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState<ProcessingPlan | null>(null);
  const planVersion = useRef(0);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [jumpHint, setJumpHint] = useState("");
  const [playbackError, setPlaybackError] = useState("");
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
  ]);
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
  const transcribable =
    meeting.source === "desktop" &&
    meeting.status !== "recording" &&
    meeting.status !== "paused" &&
    selected.tracks.some((track) => track.finalized && track.frames > 0);
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
  const playable =
    meeting.source === "desktop" &&
    meeting.status !== "recording" &&
    meeting.status !== "paused"
      ? selected.tracks.filter((track) => track.finalized && track.frames > 0)
      : [];
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
        ? `Summary · generated by ${model ?? "a model"} via ${provider ?? "provider"}`
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
  const contentScope = `your notes (${props.notes.length} characters) and the transcript text (${selected.segments.length} segments)`;
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
              ? "Removes its notes, transcript, summaries and audio files from this device."
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
              let next: number;
              if (event.key === "ArrowRight")
                next = (index + 1) % contentTabs.length;
              else if (event.key === "ArrowLeft")
                next = (index + contentTabs.length - 1) % contentTabs.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = contentTabs.length - 1;
              else return;
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
                  onChange={(event) =>
                    setTemplate(event.target.value as SummaryTemplate)
                  }
                >
                  {templates.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
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
              <ul>
                <li>
                  Model: <code>{confirming.model}</code> via{" "}
                  <code>{confirming.base_url}</code>
                </li>
                <li>Template: {templateLabel(template)}</li>
                <li>Sent: {contentScope}.</li>
                <li>
                  Requests:{" "}
                  {confirming.requests === 1
                    ? "1 request."
                    : `${confirming.requests} requests (the transcript in ${confirming.requests - 1} parts, then one pass combining them with your notes).`}
                </li>
                <li>Not sent: audio recordings.</li>
                <li>
                  {isLocalBase(confirming.base_url)
                    ? "Text is sent to your local server. Its configuration determines whether it forwards requests."
                    : "The text leaves this device and is handled under your provider's terms."}{" "}
                  A new summary is saved beside any earlier one; your notes are
                  never changed.
                </li>
              </ul>
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
                onChange={(event) => setVersionId(Number(event.target.value))}
              >
                {versions.map((version, index) => (
                  <option key={version.id} value={version.id}>
                    {`Version ${versions.length - index} · ${version.model} · ${templateLabel(version.template)}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          {summary ? (
            <div className="summary-body">{renderMarkdown(summary)}</div>
          ) : (
            <p className="muted">
              No summary yet. Use Enhance notes after adding notes or a
              transcript.
            </p>
          )}
          {summary && (
            <div className="panel-actions">
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
              AI-generated. Check it against the transcript before relying on
              it.
            </p>
          )}
          <form
            className="ask-meeting"
            onSubmit={(event) => {
              event.preventDefault();
              if (question.trim())
                void reviewPlan(
                  () => props.onPlanQuestion(question.trim()),
                  setAsking,
                );
            }}
          >
            <label htmlFor="ask-question">Ask this meeting</label>
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
              <ul>
                <li>
                  Model: <code>{asking.model}</code> via{" "}
                  <code>{asking.base_url}</code>
                </li>
                <li>
                  Sent in {asking.requests} request(s): your question,{" "}
                  {contentScope} of this meeting only.
                </li>
                <li>Not sent: audio recordings or other meetings.</li>
                <li>
                  {isLocalBase(asking.base_url)
                    ? "Text is sent to your local server. Its configuration determines whether it forwards requests."
                    : "The text leaves this device and is handled under your provider's terms."}{" "}
                  The answer is shown here and not saved.
                </li>
              </ul>
              <div className="panel-actions">
                <button
                  className="primary"
                  disabled={disabled || job !== null}
                  onClick={() => {
                    setAsking(null);
                    props.onAsk(question.trim(), asking.fingerprint);
                  }}
                >
                  Send question
                </button>
                <button onClick={() => setAsking(null)}>Cancel</button>
              </div>
            </div>
          )}
          {props.answer?.meetingId === meeting.id && (
            <div className="ask-answer" aria-label="Answer">
              <p>
                <strong>Q: {props.answer.question}</strong>
              </p>
              {renderMarkdown(props.answer.text)}
              <p className="muted">
                AI-generated from this meeting's notes and transcript. Not
                saved; check it before relying on it.
              </p>
            </div>
          )}
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
                  A successful run replaces the generated transcript. Notes and
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
            const timing = segment.timing;
            const time =
              timing.kind === "timed"
                ? `${(timing.start_ms / 1000).toFixed(1)}s`
                : "Untimed";
            return (
              <p className="transcript-segment" key={index}>
                <strong>{segment.speaker}</strong>{" "}
                {timing.kind === "timed" &&
                playable.some((track) => track.kind === kind) ? (
                  <button
                    className="seek-button"
                    aria-label={`Play ${segment.speaker} from ${time}`}
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
                — {segment.text}
              </p>
            );
          })}
        </section>
      </div>
    </article>
  );
}
