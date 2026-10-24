import { useEffect, useRef, useState, type Ref } from "react";
import {
  api,
  errorCode,
  errorMessage,
  type LibraryAnswer,
  type Meeting,
  type MeetingDetail,
  type Recipe,
} from "../../shared/api/api";
import { renderMarkdown } from "../../shared/lib/markdown";
import { foldText, formatDate, tagChoices } from "../../entities/meeting";
import { parseTimestamp, segmentsAt } from "../../shared/lib/timestamps";
import { RecipePicker } from "../../features/recipes";
import {
  OpenSettingsButton,
  type AiBlock,
  type OpenSettings,
} from "../../shared/ui/settings-link";

type Props = {
  /** Kept for the meeting page's panel-era call site; the Ask page owns the frame. */
  panelRef?: Ref<HTMLElement>;
  hidden?: boolean;
  onClose?: () => void;
  meetings: Meeting[];
  recipes: Recipe[];
  /** Changes when the summary/question provider settings change. */
  connectionRevision: string;
  /** Why AI notes cannot answer, with the Settings section that fixes it; null when they can. */
  llmBlocked: AiBlock | null;
  onOpenSettings: OpenSettings;
  disabled: boolean;
  /** Opens a meeting; `ms` is a cited transcript time to jump to, or null. */
  onOpen: (meetingId: string, ms: number | null) => void;
  /** The AI notes connection, when one is assigned: its name and whether text leaves this device. */
  connection?: { name: string; remote: boolean } | null;
};

/** The shown saved answer with the stored meetings its citations are checked against. */
type Answered = {
  answer: LibraryAnswer;
  details: Map<string, MeetingDetail>;
};

type Scope = "all" | "pick" | "tag";

const same = (a: string, b: string) =>
  a.toLocaleLowerCase() === b.toLocaleLowerCase();
// The most meetings one question can cover.
const LIMIT = 20;

/** Ask across meetings: question box, scope row, recipes, saved answers and one answer. */
export function LibraryQuestion(props: Props) {
  const { meetings, disabled } = props;
  const [scopeMode, setScopeMode] = useState<Scope>("all");
  const [tag, setTag] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [question, setQuestion] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  // Nothing matched, so nothing was sent: a result, not a failure.
  const [notice, setNotice] = useState("");
  const [answered, setAnswered] = useState<Answered | null>(null);
  const [answers, setAnswers] = useState<LibraryAnswer[]>([]);
  const [deletingAnswer, setDeletingAnswer] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const version = useRef(0);
  const title = (id: string) =>
    meetings.find((meeting) => meeting.id === id)?.title ?? id;

  const tags = tagChoices(meetings);
  const scope =
    scopeMode === "all"
      ? meetings
      : scopeMode === "tag"
        ? meetings.filter((meeting) => meeting.tags.some((t) => same(t, tag)))
        : meetings.filter((meeting) => picked.includes(meeting.id));
  const scopeKey = scope.map((meeting) => meeting.id).join(",");
  const tooMany = scope.length > LIMIT;
  const needle = foldText(filter.trim());
  const shown = meetings.filter((meeting) =>
    foldText(meeting.title).includes(needle),
  );
  // Picks only grow up to the limit, so existing picks are never dropped.
  const pickFirst = () =>
    setPicked((ids) => {
      const next = [...ids];
      for (const meeting of shown.slice(0, LIMIT)) {
        if (next.length >= LIMIT) break;
        if (!next.includes(meeting.id)) next.push(meeting.id);
      }
      return next;
    });
  // Any scope, question or provider change discards a request in flight.
  useEffect(() => {
    version.current += 1;
    setNotice("");
    setWorking(false);
  }, [scopeKey, question, props.connectionRevision]);

  // Saved answers are deleted with any of their meetings, so reload when the library changes.
  const meetingsKey = meetings.map((meeting) => meeting.id).join(",");
  useEffect(() => {
    let live = true;
    api.listLibraryAnswers().then(
      (saved) => {
        if (!live) return;
        setAnswers(saved);
        setAnswered((open) =>
          open && saved.some((answer) => answer.id === open.answer.id)
            ? open
            : null,
        );
      },
      (failure) => {
        if (live) setError(errorMessage(failure));
      },
    );
    return () => {
      live = false;
    };
  }, [meetingsKey]);

  // Citations are checked against the stored transcripts of exactly the meetings asked about.
  const show = async (answer: LibraryAnswer) => {
    const details = new Map<string, MeetingDetail>();
    await Promise.all(
      answer.meeting_ids.map((id) =>
        api.getMeeting(id).then(
          (detail) => void details.set(id, detail),
          () => undefined,
        ),
      ),
    );
    setDeletingAnswer(false);
    setCopyStatus("");
    setAnswered({ answer, details });
  };

  const ask = async () => {
    const current = ++version.current;
    setError("");
    setNotice("");
    setWorking(true);
    try {
      const saved = await api.askLibrary(
        scope.map((meeting) => meeting.id),
        question.trim(),
      );
      // Saved even if the form changed meanwhile, so it always joins the list.
      setAnswers((list) => [saved, ...list]);
      if (current !== version.current) return;
      setQuestion("");
      await show(saved);
    } catch (failure) {
      if (current !== version.current) return;
      if (errorCode(failure) === "insufficient_evidence")
        setNotice(errorMessage(failure));
      else setError(errorMessage(failure));
    } finally {
      if (current === version.current) setWorking(false);
    }
  };

  const copyAnswer = async (answer: LibraryAnswer) => {
    try {
      await navigator.clipboard.writeText(answer.answer);
      setCopyStatus("Copied.");
    } catch {
      setCopyStatus("Could not copy.");
    }
  };

  const reference = (token: string) => {
    const match = /^\[M([1-9]\d*)(?: ([^\]]+))?\]$/.exec(token);
    const id = match
      ? answered?.answer.meeting_ids[Number(match[1]) - 1]
      : undefined;
    const time = match?.[2];
    const ms = time === undefined ? null : parseTimestamp(`[${time}]`);
    const detail = id === undefined ? undefined : answered?.details.get(id);
    const valid =
      time === undefined ||
      (ms !== null && !!detail && segmentsAt(detail.segments, ms).length > 0);
    if (id === undefined || !valid)
      return (
        <span className="unverified-reference">
          {token} <span className="muted">(unverified)</span>
        </span>
      );
    return (
      <button
        type="button"
        className="cite"
        aria-label={
          time === undefined
            ? `Open ${title(id)}`
            : `Open ${title(id)} at ${time}`
        }
        onClick={() => props.onOpen(id, ms)}
      >
        {match?.[1]}
      </button>
    );
  };

  const canAsk =
    !disabled &&
    !working &&
    !props.llmBlocked &&
    scope.length > 0 &&
    !tooMany &&
    question.trim().length > 0;

  return (
    <section className="ask" ref={props.panelRef} hidden={props.hidden}>
      <form
        className="askbox"
        onSubmit={(event) => {
          event.preventDefault();
          if (canAsk) void ask();
        }}
      >
        <label className="sr-only" htmlFor="library-question">
          Question
        </label>
        <textarea
          id="library-question"
          rows={2}
          maxLength={1000}
          disabled={working || !!props.llmBlocked}
          value={question}
          placeholder="Ask about your meetings…"
          onChange={(event) => setQuestion(event.target.value)}
        />
        <div className="ask-foot">
          <select
            aria-label="Scope"
            value={scopeMode}
            disabled={working}
            onChange={(event) => setScopeMode(event.target.value as Scope)}
          >
            <option value="all">All meetings</option>
            <option value="pick">Pick meetings…</option>
            <option value="tag">Meetings with a tag</option>
          </select>
          {scopeMode === "tag" && (
            <select
              className="tag-select"
              aria-label="Tag"
              value={tag}
              disabled={working || tags.length === 0}
              onChange={(event) => setTag(event.target.value)}
            >
              <option value="">Any tag</option>
              {tags.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
          <span className="grow" />
          <button type="submit" className="primary" disabled={!canAsk}>
            Ask
          </button>
        </div>
      </form>

      <div className="ask-meta">
        {props.connection?.name ? (
          <span
            className="who"
            title="Question, meeting titles, notes and keyword-matched transcript excerpts are sent to this service. The answer is saved on this device."
          >
            {props.connection.name}
            {props.connection.remote && (
              <span className="leaves">Leaves this device</span>
            )}
          </span>
        ) : (
          <span className="who">No AI notes connection</span>
        )}
        <span className="spacer" />
        <span
          className="count"
          title="One question can cover up to 20 meetings."
        >
          <span className="n">
            {scope.length} meeting{scope.length === 1 ? "" : "s"}
          </span>
        </span>
      </div>

      {props.llmBlocked && (
        <div className="blocked">
          <span>Connect an AI service to ask questions.</span>
          <span className="spacer" />
          <OpenSettingsButton
            section={props.llmBlocked.section}
            onOpenSettings={props.onOpenSettings}
          />
        </div>
      )}

      <RecipePicker
        recipes={props.recipes}
        disabled={working || !!props.llmBlocked}
        onPick={setQuestion}
      />

      {scopeMode === "pick" && (
        <div className="ask-pick">
          <label className="field">
            Filter meetings
            <input
              type="search"
              value={filter}
              disabled={working}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <div className="ask-actions">
            <button
              type="button"
              className="sm"
              disabled={working || shown.length === 0}
              onClick={pickFirst}
            >
              Select first {LIMIT} shown
            </button>
            <button
              type="button"
              className="sm"
              disabled={working || picked.length === 0}
              onClick={() => setPicked([])}
            >
              Clear selection
            </button>
          </div>
          {shown.length === 0 && (
            <p className="muted">No meetings match this filter.</p>
          )}
          <ul className="pick-list" aria-label="Meetings">
            {shown.map((meeting) => (
              <li key={meeting.id}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={picked.includes(meeting.id)}
                    disabled={
                      working ||
                      (!picked.includes(meeting.id) && picked.length >= LIMIT)
                    }
                    onChange={(event) =>
                      setPicked((ids) =>
                        event.target.checked
                          ? [...ids, meeting.id]
                          : ids.filter((id) => id !== meeting.id),
                      )
                    }
                  />
                  <span>
                    {meeting.title}{" "}
                    <span className="muted">
                      {formatDate(meeting.started_at)}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      {tooMany && (
        <p className="muted">
          One question covers {LIMIT} meetings: pick them or use a tag.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {working && <p role="status">Asking…</p>}

      {answers.length > 0 && (
        <div className="ask-recent">
          <span className="label">Recent questions</span>
          <ul>
            {answers.map((answer) => (
              <li key={answer.id}>
                <button
                  type="button"
                  className="qrow"
                  aria-current={
                    answered?.answer.id === answer.id ? "true" : undefined
                  }
                  onClick={() => void show(answer)}
                >
                  <span className="q">{answer.question}</span>
                  <span className="src">
                    {answer.meeting_ids.length} source
                    {answer.meeting_ids.length === 1 ? "" : "s"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {deletingAnswer && answered && (
        <div
          className="dialog-card"
          role="group"
          aria-label="Confirm deleting saved answer"
        >
          <p>
            <strong>Delete this saved answer?</strong> The meetings are kept.
          </p>
          <div className="ask-actions">
            <button
              type="button"
              className="danger danger-filled"
              onClick={() => {
                const id = answered.answer.id;
                setDeletingAnswer(false);
                api.deleteLibraryAnswer(id).then(
                  (rest) => {
                    setAnswers(rest);
                    setAnswered(null);
                  },
                  (failure) => setError(errorMessage(failure)),
                );
              }}
            >
              Delete answer permanently
            </button>
            <button type="button" onClick={() => setDeletingAnswer(false)}>
              Keep
            </button>
          </div>
        </div>
      )}

      {answered && (
        <section className="ask-answer" aria-label="Answer">
          <div className="asked">
            <h2>{answered.answer.question}</h2>
            <span className="sub">
              {answered.answer.meeting_ids.length} meeting
              {answered.answer.meeting_ids.length === 1 ? "" : "s"} ·{" "}
              {answered.answer.provider} {answered.answer.model}
            </span>
          </div>
          <div className="answer">
            {renderMarkdown(answered.answer.answer, reference)}
          </div>
          <div className="sources">
            <span className="label">Sources</span>
            {answered.answer.meeting_ids.map((id, index) => (
              <button
                type="button"
                className="src-row"
                key={`${id}-${index}`}
                onClick={() => props.onOpen(id, null)}
              >
                <span className="n">{index + 1}</span>
                <span>
                  <span className="head">
                    <span className="name">{title(id)}</span>
                  </span>
                  <span className="snip">
                    {answered.details.get(id)
                      ? formatDate(answered.details.get(id)!.meeting.started_at)
                      : "Unavailable"}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <div className="ask-actions">
            <button
              type="button"
              className="sm"
              onClick={() => void copyAnswer(answered.answer)}
            >
              Copy
            </button>
            <button
              type="button"
              className="sm"
              disabled={disabled || working}
              onClick={() => setDeletingAnswer(true)}
            >
              Delete answer
            </button>
            {copyStatus && <span role="status">{copyStatus}</span>}
            <span className="spacer" />
            <span className="saved">Saved on this device</span>
          </div>
        </section>
      )}
    </section>
  );
}
