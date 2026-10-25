export type TurnSource = {
  speaker: string;
  /** null when the segment has no start time. */
  startMs: number | null;
};

export type Turn<T extends TurnSource> = {
  speaker: string;
  startMs: number | null;
  segments: T[];
};

/** Consecutive same-speaker segments within 10s of the previous segment start. */
export const TURN_GAP_MS = 10_000;

export function groupTurns<T extends TurnSource>(
  segments: readonly T[],
): Turn<T>[] {
  const turns: Turn<T>[] = [];
  for (const segment of segments) {
    const current = turns[turns.length - 1];
    if (current !== undefined && joinsTurn(current, segment)) {
      current.segments.push(segment);
      continue;
    }
    turns.push({
      speaker: segment.speaker,
      startMs: segment.startMs,
      segments: [segment],
    });
  }
  return turns;
}

function joinsTurn<T extends TurnSource>(turn: Turn<T>, segment: T): boolean {
  if (turn.speaker !== segment.speaker) return false;
  if (segment.startMs === null) return true;
  const previous = turn.segments[turn.segments.length - 1];
  if (previous === undefined || previous.startMs === null) return false;
  return segment.startMs - previous.startMs <= TURN_GAP_MS;
}
