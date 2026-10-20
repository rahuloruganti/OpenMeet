import { useEffect, useRef, useState, type Ref } from "react";
import {
  api,
  errorMessage,
  isLocalBase,
  type LibraryAnswer,
  type Meeting,
  type MeetingDetail,
  type ProcessingPlan,
  type Recipe,
} from "../lib/api";
import { renderMarkdown } from "../lib/markdown";
import { parseTimestamp, segmentsAt } from "../lib/timestamps";
import { RecipePicker } from "./Recipes";

type Props = {
  panelRef: Ref<HTMLElement>;
  /** The panel stays mounted while hidden, so an answer survives following a link. */
  hidden: boolean;
  meetings: Meeting[];
  recipes: Recipe[];
  /** Changes when the summary/question provider settings change. */
  connectionRevision: string;
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

export function LibraryQuestion(props: Props) {
  const { meetings, disabled } = props;
  const [mode, setMode] = useState<"tag" | "pick">("pick");
  const [tag, setTag] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [review, setReview] = useState<{
    plan: ProcessingPlan;
    ids: string[];
    question: string;
  } | null>(null);
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

  const tags = [
    ...new Map(
      meetings.flatMap((meeting) =>
        meeting.tags.map((name) => [name.toLocaleLowerCase(), name] as const),
      ),
    ).values(),
  ].sort((a, b) => a.localeCompare(b));
  const scope =
    mode === "tag"
      ? meetings.filter((meeting) => meeting.tags.some((t) => same(t, tag)))
      : meetings.filter((meeting) => picked.includes(meeting.id));
  const scopeKey = scope.map((meeting) => meeting.id).join(",");
  const tooMany = scope.length > 20;
  // Any scope, question or provider change discards the review and any request in flight.
  useEffect(() => {
    version.current += 1;
    setReview(null);
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

  const plan = async () => {
    const current = ++version.current;
    const ids = scope.map((meeting) => meeting.id);
    setError("");
    setNotice("");
    setWorking(true);
    try {
      const result = await api.planLibraryQuestion(ids, question.trim());
      if (current === version.current)
        setReview({ plan: result, ids, question: question.trim() });
    } catch (failure) {
      if (current !== version.current) return;
      const code = (failure as { code?: string } | null)?.code;
      if (code === "insufficient_evidence") setNotice(errorMessage(failure));
      else setError(errorMessage(failure));
    } finally {
      if (current === version.current) setWorking(false);
    }
  };

  const send = async () => {
    if (!review) return;
    const current = ++version.current;
    const { ids, plan: reviewed } = review;
    setReview(null);
    setError("");
    setWorking(true);
    try {
      const saved = await api.askLibrary(
        ids,
        review.question,
        reviewed.fingerprint,
      );
      // Saved even if the form changed meanwhile, so it always joins the list.
      setAnswers((list) => [saved, ...list]);
      if (current !== version.current) return;
      setQuestion("");
      await show(saved);
    } catch (failure) {
      if (current === version.current) setError(errorMessage(failure));
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

  const canReview =
    !disabled &&
    !working &&
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
        Choose the meetings to ask about. Nothing is sent until you review and
        confirm it.
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
        <ul className="library-meetings" aria-label="Meetings">
          {meetings.map((meeting) => (
            <li key={meeting.id}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={picked.includes(meeting.id)}
                  disabled={working}
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
                    {new Date(meeting.started_at).toLocaleDateString()}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <p role="status">
        {scope.length} meeting{scope.length === 1 ? "" : "s"} selected.
        {tooMany && " Choose at most 20."}
      </p>
      <form
        className="ask-meeting"
        onSubmit={(event) => {
          event.preventDefault();
          if (canReview) void plan();
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
          <button type="submit" disabled={!canReview}>
            Review
          </button>
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {review && (
        <div
          className="consent-card"
          role="group"
          aria-label="Confirm sending library question"
        >
          <p>
            <strong>
              Send this question and {review.ids.length} meeting
              {review.ids.length === 1 ? "" : "s"} to your selected provider?
            </strong>
          </p>
          <ul>
            <li>
              Model: <code>{review.plan.model}</code> via{" "}
              <code>{review.plan.base_url}</code>
            </li>
            <li>
              Sent in {review.plan.requests} request: your question, and the{" "}
              {review.plan.excerpts
                ? `title and start date of only these meetings, with ${review.plan.excerpts.segments} transcript excerpts selected on this device by keyword match from ${review.plan.excerpts.meetings} meeting${review.plan.excerpts.meetings === 1 ? "" : "s"}, plus each meeting's notes if they mention a keyword (only the matching paragraphs when long) — not the full transcripts`
                : "title, start date, notes and transcript text (with speaker names) of only these meetings"}
              :
              <ol>
                {review.ids.map((id) => (
                  <li key={id}>{title(id)}</li>
                ))}
              </ol>
            </li>
            <li>Not sent: audio recordings or other meetings.</li>
            <li>
              {isLocalBase(review.plan.base_url)
                ? "Text is sent to your local server. Its configuration determines whether it forwards requests."
                : "The text leaves this device and is handled under your provider's terms."}{" "}
              The question and answer are saved on this device, unencrypted,
              until you delete them or any of these meetings.
            </li>
          </ul>
          <div className="panel-actions">
            <button
              className="primary"
              disabled={disabled || working}
              onClick={() => void send()}
            >
              Send question
            </button>
            <button onClick={() => setReview(null)}>Cancel</button>
          </div>
        </div>
      )}
      {working && !review && <p role="status">Working…</p>}
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
          className="consent-card"
          role="group"
          aria-label="Confirm deleting saved answer"
        >
          <p>
            <strong>Delete this saved answer?</strong> The question and answer
            are removed from this device. The meetings are kept.
          </p>
          <div className="panel-actions">
            <button
              className="primary"
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
