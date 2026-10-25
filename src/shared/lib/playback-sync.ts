/** Re-sync the other track when it is further than this from the leader. */
export const SYNC_DRIFT_MS = 120;

/**
 * Meeting time from the leading audio element.
 * Approximate across pauses inside a recording. Re-anchor at each seek.
 */
export function sessionFromFile(
  anchorSessionMs: number,
  anchorFileMs: number,
  currentTimeSec: number,
): number {
  return anchorSessionMs + (currentTimeSec * 1000 - anchorFileMs);
}

/** Signed drift: element file time minus the file time the anchor predicts. */
export function fileDriftMs(
  anchorFileMs: number,
  anchorSessionMs: number,
  sessionNowMs: number,
  currentTimeSec: number,
): number {
  const expectedFileMs = anchorFileMs + (sessionNowMs - anchorSessionMs);
  return currentTimeSec * 1000 - expectedFileMs;
}
