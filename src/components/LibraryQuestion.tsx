import { useEffect, useRef, useState, type Ref } from "react";
import {
  api,
  errorMessage,
  isLocalBase,
  type Meeting,
  type MeetingDetail,
  type ProcessingPlan,
} from "../lib/api";
import { renderMarkdown } from "../lib/markdown";
import { parseTimestamp, segmentsAt } from "../lib/timestamps";

type Props = {
  panelRef: Ref<HTMLElement>;
  /** The panel stays mounted while hidden, so an answer survives following a link. */
  hidden: boolean;
  meetings: Meeting[];
  /** Changes when the summary/question provider settings change. */
  connectionRevision: string;
  disabled: boolean;
  onClose: () => void;
  /** Opens a meeting; `ms` is a cited transcript time to jump to, or null. */
  onOpen: (meetingId: string, ms: number | null) => void;
};

/** What was sent, kept with the answer so its citations are checked against exactly that scope. */
type Answered = {
  text: string;
  /** M1, M2, ... in the order sent. */
  scope: { id: string; title: string }[];
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
  const version = useRef(0);

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
      const text = await api.askLibrary(
        ids,
        review.question,
        reviewed.fingerprint,
      );
      // Citations are checked against the stored transcripts of exactly the meetings asked about.
      const details = new Map<string, MeetingDetail>();
      await Promise.all(
        ids.map((id) =>
          api.getMeeting(id).then(
            (detail) => void details.set(id, detail),
            () => undefined,
          ),
        ),
      );
      if (current !== version.current) return;
      setAnswered({
        text,
        scope: ids.map((id) => ({
          id,
          title: meetings.find((meeting) => meeting.id === id)?.title ?? id,
        })),
        details,
      });
    } catch (failure) {
      if (current === version.current) setError(errorMessage(failure));
    } finally {
      if (current === version.current) setWorking(false);
    }
  };

  const reference = (token: string) => {
    const match = /^\[M([1-9]\d*)(?: ([^\]]+))?\]$/.exec(token);
    const meeting = match ? answered?.scope[Number(match[1]) - 1] : undefined;
    const time = match?.[2];
    const ms = time === undefined ? null : parseTimestamp(`[${time}]`);
    const detail = meeting && answered?.details.get(meeting.id);
    const valid =
      time === undefined ||
      (ms !== null && !!detail && segmentsAt(detail.segments, ms).length > 0);
    if (!meeting || !valid)
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
            ? `Open ${meeting.title}`
            : `Open ${meeting.title} at ${time}`
        }
        onClick={() => props.onOpen(meeting.id, ms)}
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
                  <li key={id}>
                    {meetings.find((meeting) => meeting.id === id)?.title ?? id}
                  </li>
                ))}
              </ol>
            </li>
            <li>Not sent: audio recordings or other meetings.</li>
            <li>
              {isLocalBase(review.plan.base_url)
                ? "Text is sent to your local server. Its configuration determines whether it forwards requests."
                : "The text leaves this device and is handled under your provider's terms."}{" "}
              The answer is shown here and is not saved.
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
      {answered && (
        <div className="ask-answer" aria-label="Library answer">
          {renderMarkdown(answered.text, reference)}
          <p className="muted">
            AI-generated from {answered.scope.length} meeting
            {answered.scope.length === 1 ? "" : "s"}:{" "}
            {answered.scope
              .map((meeting, index) => `M${index + 1} ${meeting.title}`)
              .join("; ")}
            . Not saved. A link shows that a transcript line exists at that
            time, not that it supports the claim; check it before relying on it.
          </p>
        </div>
      )}
    </section>
  );
}
