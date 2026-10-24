import type { LiveLine } from "../../shared/api/api";

/** The finals kept on screen, and the newest partial of each lane. */
export type LiveLines = { lines: LiveLine[]; partials: LiveLine[] };

export const noLines: LiveLines = { lines: [], partials: [] };

const laneOrder: LiveLine["lane"][] = ["mic", "system"];

const byStart = (a: LiveLine, b: LiveLine) => a.start_ms - b.start_ms;

/** A line the engines emitted with nothing in it is noise and never shown. */
const speaks = (line: LiveLine) => line.text.trim() !== "";

/**
 * One update from the live engine. A partial replaces the line with its id; a final replaces it
 * too and stays, in time order. A lane keeps only its newest partial.
 */
export function addLine(state: LiveLines, line: LiveLine): LiveLines {
  if (!speaks(line)) return state;
  const lines = state.lines.filter((item) => item.id !== line.id);
  const partials = state.partials.filter(
    (item) => item.id !== line.id && item.lane !== line.lane,
  );
  if (!line.final) return { lines: state.lines, partials: [...partials, line] };

  // A late final for an older utterance must not jump above what came after it.
  lines.push(line);
  lines.sort(byStart);
  return { lines, partials };
}

export const addLines = (state: LiveLines, batch: LiveLine[]) =>
  batch.reduce(addLine, state);

/** The lines a fresh load starts from: the saved finals and the open partials. */
export function loadLines(saved: LiveLines): LiveLines {
  const lines = saved.lines.filter(speaks).slice().sort(byStart);
  const partials = saved.partials
    .filter(speaks)
    .reduce<LiveLine[]>(
      (kept, line) => [
        ...kept.filter(
          (item) => item.id !== line.id && item.lane !== line.lane,
        ),
        line,
      ],
      [],
    )
    .sort((a, b) => laneOrder.indexOf(a.lane) - laneOrder.indexOf(b.lane));
  return { lines, partials };
}

/** One paragraph: consecutive finals of the same speaker, with the first one's start time. */
export type Paragraph = {
  key: string;
  lane: LiveLine["lane"];
  speaker: string;
  start_ms: number;
  text: string;
};

/** Consecutive finals of one speaker read as one paragraph, so a lane is not a line per word. */
export function paragraphs(lines: LiveLine[]): Paragraph[] {
  const blocks: Paragraph[] = [];
  for (const line of lines) {
    const last = blocks[blocks.length - 1];
    if (last && last.speaker === line.speaker && last.lane === line.lane) {
      blocks[blocks.length - 1] = {
        ...last,
        text: `${last.text} ${line.text}`,
      };
      continue;
    }
    blocks.push({
      key: line.id,
      lane: line.lane,
      speaker: line.speaker,
      start_ms: line.start_ms,
      text: line.text,
    });
  }
  return blocks;
}

/**
 * Where the partials go: after every final, in the order they started, like Otter's open paragraph at
 * the bottom. A partial placed mid-list would read out of time order next to the other lane's finals.
 * Keyed by the paragraph index to insert before.
 */
export function partialSlots(
  blocks: Paragraph[],
  partials: LiveLine[],
): Map<number, LiveLine[]> {
  const slots = new Map<number, LiveLine[]>();
  if (partials.length > 0)
    slots.set(blocks.length, partials.slice().sort(byStart));
  return slots;
}
