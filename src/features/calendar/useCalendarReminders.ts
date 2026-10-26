import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CalendarReminder } from "../../shared/api/api";

type Options = {
  /** The meeting being recorded now, or null. A new id is the meeting this reminder asked for. */
  meetingId: string | null;
  /** Opens the New recording dialog, prefilled with the event title. */
  onStart: (reminder: CalendarReminder) => void;
  onError: (failure: unknown) => void;
};

/** A link waits this long for the meeting it asked for; after that it is forgotten. */
const PENDING_LINK_MS = 2 * 60_000;

/**
 * Shows calendar reminders one at a time, oldest first. The backend marks an event as reminded
 * when it sends it, so a reminder must never be overwritten unseen: later ones queue up behind it.
 * "Start recording" remembers the event and links it to the meeting once the recording gets a
 * meeting id. `clear` forgets that link, for a cancelled or closed New recording dialog.
 */
export function useCalendarReminders({ meetingId, onStart, onError }: Options) {
  const [queue, setQueue] = useState<CalendarReminder[]>([]);
  const pending = useRef<{ eventId: string; baseline: string | null } | null>(
    null,
  );
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null);

  const forgetLink = useCallback(() => {
    pending.current = null;
    if (expiry.current !== null) clearTimeout(expiry.current);
    expiry.current = null;
  }, []);

  useEffect(() => {
    let closed = false;
    let stop: (() => void) | undefined;
    void Promise.resolve()
      .then(() =>
        api.onCalendarReminder((next) => {
          if (closed) return;
          setQueue((current) => {
            // The same event again (a re-sent reminder) replaces its entry, keeping its place.
            const at = current.findIndex(
              (item) => item.event_id === next.event_id,
            );
            if (at === -1) return [...current, next];
            return current.map((item, index) => (index === at ? next : item));
          });
        }),
      )
      .then((unlisten) => {
        if (closed) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    return () => {
      closed = true;
      stop?.();
      forgetLink();
    };
  }, [forgetLink]);

  useEffect(() => {
    const wanted = pending.current;
    if (!wanted || !meetingId || meetingId === wanted.baseline) return;
    forgetLink();
    void Promise.resolve()
      .then(() => api.linkMeetingEvent(meetingId, wanted.eventId))
      .catch(onError);
  }, [meetingId, onError, forgetLink]);

  const start = useCallback(() => {
    const head = queue[0];
    if (!head) return;
    forgetLink();
    pending.current = { eventId: head.event_id, baseline: meetingId };
    expiry.current = setTimeout(forgetLink, PENDING_LINK_MS);
    setQueue((current) => current.slice(1));
    onStart(head);
  }, [queue, meetingId, onStart, forgetLink]);

  const dismiss = useCallback(() => {
    forgetLink();
    setQueue((current) => current.slice(1));
  }, [forgetLink]);

  return { reminder: queue[0] ?? null, start, dismiss, clear: forgetLink };
}
