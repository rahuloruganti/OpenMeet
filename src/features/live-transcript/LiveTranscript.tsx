import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { LiveLine, SpeakerNames } from "../../shared/api/api";
import { speakerLabel } from "../../shared/api/api";
import {
  findInSegments,
  formatClock,
  formatTranscript,
} from "../../shared/lib/transcript-text";
import { groupTurns } from "../../shared/lib/turns";
import {
  OpenSettingsButton,
  type OpenSettings,
} from "../../shared/ui/settings-link";
import { paragraphs, partialSlots } from "./lines";
import { useLiveTranscript } from "./use-live-transcript";
import "../../shared/ui/transcript-turns.css";
import "./live-transcript.css";

type Props = {
  meetingId: string;
  /** The recording is paused: no new text arrives while it stays paused. */
  paused: boolean;
  /** The recording ended and the final transcript is not ready yet. */
  provisional: boolean;
  names: SpeakerNames;
  onOpenSettings: OpenSettings;
  /** Find query while this is the only transcript on screen. */
  query?: string;
  matchIndex?: number;
  onPlainText?: (text: string) => void;
  onMatchCount?: (count: number) => void;
};

/** Shown until the backend reports a state, and while it is coming up. */
const STARTING = "Starting live transcript.";

/** What the status line says about the engine and its state. */
function statusOf(state: string) {
  if (state === "off") return "Off";
  if (state === "starting") return "Starting";
  if (state === "running") return "Live";
  return "Stopped";
}

function scrollBox(node: HTMLElement | null) {
  const outer = node?.closest(".mw-scroll");
  return outer instanceof HTMLElement ? outer : node;
}

function marked(
  text: string,
  ranges: { start: number; end: number; current: boolean }[],
) {
  if (ranges.length === 0) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    parts.push(
      <mark key={index} className={range.current ? "tx-cur" : undefined}>
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/**
 * The live transcript while a meeting is recording. Finished lines use the same speaker turns as
 * the saved transcript. The line still being spoken stays last, in muted text, and is not announced.
 */
export function LiveTranscript(props: Props) {
  const { transcript, lines, partials, error } = useLiveTranscript(
    props.meetingId,
    props.paused,
  );
  const box = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const state = transcript?.state ?? "starting";
  const notice = error ?? transcript?.notice ?? null;
  const blocks = paragraphs(lines);
  const tail = partialSlots(blocks, partials).get(blocks.length) ?? [];
  const turns = groupTurns(
    lines.map((line) => ({
      speaker: line.speaker,
      startMs: line.start_ms,
      text: line.text,
      id: line.id,
    })),
  );
  const texts = [
    ...turns.map((turn) =>
      turn.segments.map((segment) => segment.text).join(" "),
    ),
    ...tail.map((line) => line.text),
  ];
  const matches = findInSegments(texts, props.query ?? "");
  const current =
    matches.length === 0 ? 0 : (props.matchIndex ?? 0) % matches.length;
  const quiet = turns.length === 0 && tail.length === 0;
  const off = state === "off";
  const said = notice !== null || off;
  const plain = formatTranscript([
    ...turns.map((turn) => ({
      label: speakerLabel(props.names, turn.speaker),
      startMs: turn.startMs,
      text: turn.segments.map((segment) => segment.text).join(" "),
    })),
    ...tail.map((line) => ({
      label: speakerLabel(props.names, line.speaker),
      startMs: line.start_ms,
      text: line.text,
    })),
  ]);

  useEffect(() => {
    props.onPlainText?.(plain);
    props.onMatchCount?.(matches.length);
  }, [plain, matches.length, props.onPlainText, props.onMatchCount]);

  // Follow the newest line only while the reader is already at the bottom.
  useLayoutEffect(() => {
    if (!following) return;
    const element = scrollBox(box.current);
    if (element) element.scrollTop = element.scrollHeight;
  }, [following, lines, partials]);

  useLayoutEffect(() => {
    if (!props.query?.trim() || matches.length === 0) return;
    box.current?.querySelector("mark.tx-cur")?.scrollIntoView?.({
      block: "center",
    });
  }, [props.query, current, matches.length, lines, partials]);

  useEffect(() => {
    const node = box.current;
    const outer = node?.closest(".mw-scroll");
    if (!(outer instanceof HTMLElement)) return;
    const onScroll = () => {
      setFollowing(
        outer.scrollHeight - outer.scrollTop - outer.clientHeight <= 8,
      );
    };
    outer.addEventListener("scroll", onScroll);
    return () => outer.removeEventListener("scroll", onScroll);
  }, [lines, partials]);

  const follow = () => {
    setFollowing(true);
    const element = scrollBox(box.current);
    if (element) element.scrollTop = element.scrollHeight;
  };

  const noteScroll = () => {
    const element = scrollBox(box.current);
    if (!element) return;
    setFollowing(
      element.scrollHeight - element.scrollTop - element.clientHeight <= 8,
    );
  };

  // Nothing to say: live never ran for this finished recording.
  if (quiet && !said && state !== "starting" && state !== "running")
    return null;

  const rangesAt = (index: number) =>
    matches
      .map((match, at) =>
        match.segmentIndex === index
          ? {
              start: match.start,
              end: match.end,
              current: at === current,
            }
          : null,
      )
      .filter(
        (match): match is { start: number; end: number; current: boolean } =>
          match !== null,
      );

  const renderPartial = (partial: LiveLine, index: number) => (
    <div className="tx-turn" key={`partial-${partial.id}`}>
      <span className="tx-time">{formatClock(partial.start_ms)}</span>
      <span className="tx-name">
        <span
          className={`tx-dot ${partial.speaker === "You" ? "you" : "others"}`}
          aria-hidden="true"
        />
        {speakerLabel(props.names, partial.speaker)}
      </span>
      <p className="tx-p is-live">
        {marked(partial.text, rangesAt(turns.length + index))}
        <span className="tx-caret" aria-hidden="true" />
      </p>
    </div>
  );

  return (
    <section className="lt" aria-label="Live transcript">
      <p className="tx-status">
        {props.paused ? (
          <span className="tx-pause-mark" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="14" height="14" focusable="false">
              <path
                d="M4.5 3.5h2.2v9H4.5zM9.3 3.5h2.2v9H9.3z"
                fill="currentColor"
              />
            </svg>
          </span>
        ) : (
          <span className="tx-pulse" aria-hidden="true" />
        )}
        <span>{transcript?.engine ?? "Live transcript"}</span>
        {props.paused ? (
          <span>Paused. Nothing is recorded until you resume.</span>
        ) : (
          <span>{statusOf(state)}</span>
        )}
        {transcript?.leaves_device && <span>Leaves this device</span>}
        {props.provisional && <span>Provisional</span>}
      </p>

      {said && (
        <p className="lt-notice" role="status">
          {notice ?? "Live transcript is off."}
          {off && (
            <>
              {" "}
              <OpenSettingsButton
                section="recording"
                onOpenSettings={props.onOpenSettings}
              />
            </>
          )}
        </p>
      )}

      {quiet && !said && !props.paused && (
        <p className="lt-hint">
          {state === "starting" ? STARTING : "Listening."}
        </p>
      )}

      {!quiet && (
        <div
          className="lt-scroll"
          role="group"
          aria-label="Live transcript lines"
          ref={box}
          onScroll={noteScroll}
        >
          {turns.map((turn, index) => (
            <div className="tx-turn" key={turn.segments[0]?.id ?? index}>
              <span className="tx-time">
                {turn.startMs === null ? "Untimed" : formatClock(turn.startMs)}
              </span>
              <span className="tx-name">
                <span
                  className={`tx-dot ${turn.speaker === "You" ? "you" : "others"}`}
                  aria-hidden="true"
                />
                {speakerLabel(props.names, turn.speaker)}
              </span>
              <p className="tx-p" aria-live="polite">
                {marked(
                  turn.segments.map((segment) => segment.text).join(" "),
                  rangesAt(index),
                )}
              </p>
            </div>
          ))}
          {tail.map(renderPartial)}
        </div>
      )}

      {props.paused && <p className="tx-paused-line">Paused</p>}

      {!following && !quiet && (
        <button type="button" className="lt-jump" onClick={follow}>
          Jump to live
        </button>
      )}
    </section>
  );
}
