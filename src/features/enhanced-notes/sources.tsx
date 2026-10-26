import type { SourceRef } from "../../shared/api/api";
import type { ReferenceRenderer } from "../../shared/lib/markdown";

const sourceToken = /^\[s\d{1,12}\]$/;

/** Whether a Markdown reference token is a source marker such as [s123]. */
export function isSourceMarker(token: string): boolean {
  return sourceToken.test(token);
}

/** mm:ss from milliseconds; minutes past 59 keep counting (75 minutes reads 75:00). */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Chips for source markers. A marker outside `sources` shows nothing, so a citation
 * the server dropped never reaches the reader. Other tokens pass through unchanged.
 */
export function sourceChip(
  sources: SourceRef[],
  onOpen: (source: SourceRef) => void,
): ReferenceRenderer {
  const byMarker = new Map(sources.map((source) => [source.marker, source]));
  return (token) => {
    if (!isSourceMarker(token)) return token;
    const source = byMarker.get(token);
    if (!source) return <></>;
    if (source.start_ms === null || source.end_ms === null)
      return (
        <button
          type="button"
          className="source-chip"
          title="Untimed segment"
          aria-label="Open transcript, untimed segment"
          onClick={() => onOpen(source)}
        >
          #{source.segment_id}
        </button>
      );
    const range = `${clock(source.start_ms)} to ${clock(source.end_ms)}`;
    return (
      <button
        type="button"
        className="source-chip"
        title={range}
        aria-label={`Open transcript at ${range}`}
        onClick={() => onOpen(source)}
      >
        {clock(source.start_ms)}
      </button>
    );
  };
}
