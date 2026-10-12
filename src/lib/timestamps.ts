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

/** First `[mm:ss]` / `[h:mm:ss]` on the caret's line, in ms, or null. */
export function timestampAtCaret(text: string, caret: number): number | null {
  const start = text.lastIndexOf("\n", caret - 1) + 1;
  const end = text.indexOf("\n", caret);
  const match = stamp.exec(text.slice(start, end === -1 ? undefined : end));
  if (!match) return null;
  const [hours, minutes, seconds] = [match[1] ?? "0", match[2], match[3]].map(
    Number,
  );
  if (seconds > 59 || (match[1] !== undefined && minutes > 59)) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}
