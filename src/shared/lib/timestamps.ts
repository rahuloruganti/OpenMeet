import type { Segment } from "../api/api";

const two = (value: number) => String(value).padStart(2, "0");

/** `[mm:ss]` under an hour, `[h:mm:ss]` after. */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = total % 60;
  return hours > 0
    ? `[${hours}:${two(minutes)}:${two(seconds)}]`
    : `[${two(minutes)}:${two(seconds)}]`;
}

const stamp = /\[(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\]/;
/** Every bracketed time token, for splitting text into references. */
export const timestampTokens = /(\[(?:\d{1,2}:)?\d{1,3}:\d{2}\])/;

function toMs(match: RegExpExecArray | null): number | null {
  if (!match) return null;
  const [hours, minutes, seconds] = [match[1] ?? "0", match[2], match[3]].map(
    Number,
  );
  if (seconds > 59 || (match[1] !== undefined && minutes > 59)) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

/** First `[mm:ss]` / `[h:mm:ss]` on the caret's line, in ms, or null. */
export function timestampAtCaret(text: string, caret: number): number | null {
  const start = text.lastIndexOf("\n", caret - 1) + 1;
  const end = text.indexOf("\n", caret);
  return toMs(stamp.exec(text.slice(start, end === -1 ? undefined : end)));
}

/** A whole `[m:ss]` / `[h:mm:ss]` token in ms, or null. */
export function parseTimestamp(token: string): number | null {
  const match = stamp.exec(token);
  return match && match[0] === token ? toMs(match) : null;
}

/**
 * Indexes of timed segments starting in the cited second. Prompt lines show
 * whole seconds rounded down (`[1:01]` for 61.8 s), so matching uses the same rule.
 */
export function segmentsAt(segments: Segment[], ms: number): number[] {
  const second = Math.floor(ms / 1000);
  return segments.flatMap((segment, index) =>
    segment.timing.kind === "timed" &&
    Math.floor(segment.timing.start_ms / 1000) === second
      ? [index]
      : [],
  );
}
