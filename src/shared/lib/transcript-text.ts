/** m:ss under an hour, h:mm:ss at an hour or more. No brackets, no zero-padded minutes under an hour. */
export function formatClock(ms: number): string {
  const whole = Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
  const total = whole > 0 ? whole : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = total % 60;
  const secondText = String(seconds).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${secondText}`;
  }
  return `${minutes}:${secondText}`;
}

export type CopyTurn = {
  label: string;
  startMs: number | null;
  text: string;
};

/**
 * One turn per block: first line `Label 0:02` (omit the time when startMs is null),
 * next line the paragraph, blank line between turns. No trailing blank line.
 */
export function formatTranscript(turns: readonly CopyTurn[]): string {
  return turns
    .map((turn) => {
      const heading =
        turn.startMs === null
          ? turn.label
          : `${turn.label} ${formatClock(turn.startMs)}`;
      return `${heading}\n${turn.text}`;
    })
    .join("\n\n");
}

export type TextMatch = { segmentIndex: number; start: number; end: number };

/** Case-insensitive non-overlapping substring matches. Empty or whitespace query returns []. */
export function findInSegments(
  texts: readonly string[],
  query: string,
): TextMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const matches: TextMatch[] = [];
  for (let segmentIndex = 0; segmentIndex < texts.length; segmentIndex += 1) {
    const text = texts[segmentIndex] ?? "";
    const haystack = text.toLowerCase();
    let from = 0;
    while (from < haystack.length) {
      const start = haystack.indexOf(needle, from);
      if (start === -1) break;
      matches.push({
        segmentIndex,
        start,
        end: start + needle.length,
      });
      from = start + needle.length;
    }
  }
  return matches;
}
