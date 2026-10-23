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
  panelRef: Ref<HTMLElement>;
  /** The panel stays mounted while hidden, so an answer survives following a link. */
  hidden: boolean;
  meetings: Meeting[];
  recipes: Recipe[];
  /** Changes when the summary/question provider settings change. */
  connectionRevision: string;
  /** Why AI notes cannot answer, with the Settings section that fixes it; null when they can. */
  llmBlocked: AiBlock | null;
  onOpenSettings: OpenSettings;
  disabled: boolean;
  onClose: () => void;
  /** Opens a meeting; `ms` is a cited transcript time to jump to, or null. */
  onOpen: (meetingId: string, ms: number | null) => void;
};

/** The shown saved answer with the stored meetings its citations are checked against. */
type Answered = {
  answer: LibraryAnswer;
  details: Map<string, MeetingDetail>;
};

const same = (a: string, b: string) =>
  a.toLocaleLowerCase() === b.toLocaleLowerCase();
// The most meetings one question can cover.
const LIMIT = 20;

export function LibraryQuestion(props: Props) {
  const { meetings, disabled } = props;
  const [mode, setMode] = useState<"tag" | "pick">("pick");
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
  const version = useRef(0);
  const title = (id: string) =>
    meetings.find((meeting) => meeting.id === id)?.title ?? id;

  const tags = tagChoices(meetings);
  const scope =
    mode === "tag"
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
        className="seek-button"
        aria-label={
          time === undefined
            ? `Open ${title(id)}`
            : `Open ${title(id)} at ${time}`
        }
        onClick={() => props.onOpen(id, ms)}
      >
        {token}
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
    <section
      className="workspace-panel"
      hidden={props.hidden}
      ref={props.panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby="library-title"
    >
      <div className="panel-heading">
        <h2 id="library-title">Ask across meetings</h2>
        <button aria-label="Close panel" onClick={props.onClose}>
          Close
        </button>
      </div>
      <p className="panel-description">
        Choose the meetings to ask about. The question and those meetings'
        titles, notes and transcripts go to your AI notes connection; long
        content is cut down to keyword-matched excerpts first.
      </p>
      <fieldset>
        <legend>Scope</legend>
        <label className="check">
          <input
            type="radio"
            name="library-scope"
            checked={mode === "pick"}
            disabled={working}
            onChange={() => setMode("pick")}
          />
          <span>Choose meetings</span>
        </label>
        <label className="check">
          <input
            type="radio"
            name="library-scope"
            checked={mode === "tag"}
            disabled={working || tags.length === 0}
            onChange={() => setMode("tag")}
          />
          <span>Meetings with a tag</span>
        </label>
      </fieldset>
      {mode === "tag" ? (
        <label>
          Tag
          <select
            value={tag}
            disabled={working}
            onChange={(event) => setTag(event.target.value)}
          >
            <option value="">Choose a tag</option>
            {tags.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <label>
            Filter meetings
            <input
              type="search"
              value={filter}
              disabled={working}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <div className="panel-actions">
            <button
              disabled={working || shown.length === 0}
              onClick={pickFirst}
            >
              Select first {LIMIT} shown
            </button>
            <button
              disabled={working || picked.length === 0}
              onClick={() => setPicked([])}
            >
              Clear selection
            </button>
          </div>
          {shown.length === 0 && (
            <p className="muted">No meetings match this filter.</p>
          )}
          <ul className="library-meetings" aria-label="Meetings">
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
        </>
      )}
      <p role="status">
        {scope.length} of {LIMIT} selected.
        {tooMany && " Choose at most 20."}
      </p>
      {mode === "pick" && picked.length >= LIMIT && (
        <p className="muted">Limit reached: {LIMIT} meetings.</p>
      )}
      {props.llmBlocked && (
        <div className="panel-actions">
          <span className="muted">{props.llmBlocked.message}</span>
          <OpenSettingsButton
            section={props.llmBlocked.section}
            onOpenSettings={props.onOpenSettings}
          />
        </div>
      )}
      <form
        className="ask-meeting"
        onSubmit={(event) => {
          event.preventDefault();
          if (canAsk) void ask();
        }}
      >
        <label htmlFor="library-question">Question</label>
        <RecipePicker
          recipes={props.recipes}
          disabled={working}
          onPick={setQuestion}
        />
        <textarea
          id="library-question"
          rows={2}
          maxLength={1000}
          disabled={working}
          value={question}
          placeholder="Which meetings discussed the launch date?"
          onChange={(event) => setQuestion(event.target.value)}
        />
        <div className="panel-actions">
          <button type="submit" className="primary" disabled={!canAsk}>
            Ask
          </button>
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {working && <p role="status">Working…</p>}
      {answers.length > 0 && (
        <div className="panel-actions">
          <select
            aria-label="Saved answers"
            value={answered?.answer.id ?? ""}
            onChange={(event) => {
              const chosen = answers.find(
                (answer) => answer.id === Number(event.target.value),
              );
              if (chosen) void show(chosen);
            }}
          >
            {!answered && <option value="">Saved answers</option>}
            {answers.map((answer) => (
              <option key={answer.id} value={answer.id}>
                {answer.question.slice(0, 60)}
              </option>
            ))}
          </select>
          {answered && (
            <button
              className="danger"
              disabled={disabled || working}
              onClick={() => setDeletingAnswer(true)}
            >
              Delete answer
            </button>
          )}
        </div>
      )}
      {deletingAnswer && answered && (
        <div
          className="dialog-card"
          role="group"
          aria-label="Confirm deleting saved answer"
        >
          <p>
            <strong>Delete this saved answer?</strong> The question and answer
            are removed from this device. The meetings are kept.
          </p>
          <div className="panel-actions">
            <button
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
            <button onClick={() => setDeletingAnswer(false)}>Keep</button>
          </div>
        </div>
      )}
      {answered && (
        <div className="ask-answer" aria-label="Library answer">
          <p>
            <strong>Q: {answered.answer.question}</strong>
          </p>
          {renderMarkdown(answered.answer.answer, reference)}
          <p className="muted">
            AI-generated from {answered.answer.meeting_ids.length} meeting
            {answered.answer.meeting_ids.length === 1 ? "" : "s"}:{" "}
            {answered.answer.meeting_ids
              .map((id, index) => `M${index + 1} ${title(id)}`)
              .join("; ")}
            . Saved on this device. A link shows that a transcript line exists
            at that time, not that it supports the claim; check it before
            relying on it.
          </p>
        </div>
      )}
    </section>
  );
}
