import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  type LiveLine,
  type LiveStateEvent,
  type LiveTranscript,
} from "../../shared/api/api";
import { addLines, mergeLoaded, noLines, type LiveLines } from "./lines";

/** Otter's numbers: 200 ms while the page is visible, 5 s while it is in the background. */
export const VISIBLE_FLUSH_MS = 200;
export const HIDDEN_FLUSH_MS = 5000;

const hidden = () =>
  typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * Meetings this session showed live text for. The meeting page keeps the panel after stop until
 * the final transcript lands, and only for a recording that had live text: nothing is asked of a
 * finished meeting that never ran live.
 */
const seen = new Set<string>();
export const liveSeen = (meetingId: string) => seen.has(meetingId);

/**
 * The live transcript of one meeting: one load, then the engine's updates. Updates are applied at
 * most every 200 ms while the page is visible and every 5 s while it is hidden (leading and
 * trailing), so a fast engine cannot re-render per word. A paused recording shows nothing new.
 */
export function useLiveTranscript(meetingId: string, paused: boolean) {
  const [transcript, setTranscript] = useState<LiveTranscript | null>(null);
  const [lines, setLines] = useState<LiveLines>(noLines);
  const [error, setError] = useState<string | null>(null);
  const pausedRef = useRef(paused);
  const buffered = useRef<LiveLine[]>([]);
  const timer = useRef<number | null>(null);
  const flushedAt = useRef(0);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const stopTimer = useCallback(() => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const flush = useCallback(() => {
    stopTimer();
    if (buffered.current.length === 0) return;
    const batch = buffered.current;
    buffered.current = [];
    flushedAt.current = Date.now();
    setLines((current) => addLines(current, batch));
  }, [stopTimer]);

  const receive = useCallback(
    (line: LiveLine) => {
      // A paused recording has no new audio; nothing is added while it is paused.
      if (pausedRef.current) return;
      buffered.current.push(line);
      if (timer.current !== null) return;
      const wait = hidden() ? HIDDEN_FLUSH_MS : VISIBLE_FLUSH_MS;
      const left = wait - (Date.now() - flushedAt.current);
      if (left <= 0) {
        flush();
        return;
      }
      timer.current = window.setTimeout(flush, left);
    },
    [flush],
  );

  useEffect(() => {
    let live = true;
    // The newest state event for this meeting. It beats the snapshot even if the load resolves later.
    let stateEvent: LiveStateEvent | null = null;
    setTranscript(null);
    setLines(noLines);
    setError(null);
    buffered.current = [];
    flushedAt.current = 0;

    // Promise.resolve: a stubbed api may answer with nothing.
    void Promise.resolve()
      .then(() => api.liveTranscript(meetingId))
      .then((loaded) => {
        if (!live || !loaded || loaded.meeting_id !== meetingId) return;
        const next: LiveTranscript = stateEvent
          ? {
              ...loaded,
              state: stateEvent.state,
              engine: stateEvent.engine,
              leaves_device: stateEvent.leaves_device,
              notice: stateEvent.notice,
            }
          : loaded;
        if (
          next.state !== "off" ||
          next.lines.length > 0 ||
          next.partials.length > 0
        )
          seen.add(meetingId);
        setTranscript(next);
        // Lines the events already applied stay; the snapshot only fills in what they missed.
        setLines((current) =>
          mergeLoaded(current, {
            lines: loaded.lines,
            partials: loaded.partials,
          }),
        );
      })
      .catch((failure) => {
        if (live) setError(errorMessage(failure));
      });

    const unlistenLine = api.onLiveTranscript((event) => {
      if (live && event.meeting_id === meetingId) receive(event.line);
    });
    const unlistenState = api.onLiveState((event) => {
      if (!live || event.meeting_id !== meetingId) return;
      stateEvent = event;
      setTranscript((current) => ({
        meeting_id: meetingId,
        lines: current?.lines ?? [],
        partials: current?.partials ?? [],
        state: event.state,
        engine: event.engine,
        leaves_device: event.leaves_device,
        notice: event.notice,
      }));
    });
    // Coming back to the page ends the long wait at once.
    const shown = () => {
      if (!hidden()) flush();
    };
    document.addEventListener("visibilitychange", shown);

    return () => {
      live = false;
      document.removeEventListener("visibilitychange", shown);
      stopTimer();
      buffered.current = [];
      void Promise.resolve(unlistenLine)
        .then((stop) => stop?.())
        .catch(() => undefined);
      void Promise.resolve(unlistenState)
        .then((stop) => stop?.())
        .catch(() => undefined);
    };
  }, [meetingId, receive, flush, stopTimer]);

  return { transcript, lines: lines.lines, partials: lines.partials, error };
}
