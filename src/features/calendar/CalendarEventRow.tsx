import { useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  type CalendarEvent,
  type MeetingPreparation,
} from "../../shared/api/api";
import { formatDateTime } from "../../entities/meeting";
import "./calendar.css";

type Props = {
  meetingId: string;
  startedAt: string;
  /** The linked event at load time. The parent remounts this row when the link changes. */
  eventId: string | null;
  disabled: boolean;
  onOpenMeeting?: (meetingId: string) => void;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Details row for a meeting's calendar event: link, unlink, and earlier meetings in the series. */
export function CalendarEventRow({
  meetingId,
  startedAt,
  eventId: initialEventId,
  disabled,
  onOpenMeeting,
}: Props) {
  const [eventId, setEventId] = useState(initialEventId);
  const [preparation, setPreparation] = useState<MeetingPreparation | null>(
    null,
  );
  const [unavailable, setUnavailable] = useState(false);
  const [picking, setPicking] = useState(false);
  const [choices, setChoices] = useState<CalendarEvent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (eventId === null) return;
    let active = true;
    void Promise.resolve()
      .then(() => api.meetingPreparation(eventId))
      .then((next) => {
        if (active) setPreparation(next);
      })
      .catch(() => {
        if (active) setUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [eventId]);

  const fail = (failure: unknown) => {
    if (mounted.current) setError(errorMessage(failure));
  };

  const openPicker = () => {
    const start = Date.parse(startedAt);
    setPicking(true);
    setChoices(null);
    setError("");
    void Promise.resolve()
      .then(() =>
        api.listCalendarEvents(
          new Date(start - DAY_MS).toISOString(),
          new Date(start + DAY_MS).toISOString(),
        ),
      )
      .then((list) => {
        if (mounted.current) setChoices(list);
      })
      .catch(fail);
  };

  const link = (next: string | null) => {
    setBusy(true);
    setError("");
    void Promise.resolve()
      .then(() => api.linkMeetingEvent(meetingId, next))
      .then(() => {
        if (!mounted.current) return;
        setEventId(next);
        setPreparation(null);
        setUnavailable(false);
        setPicking(false);
        setChoices(null);
      })
      .catch(fail)
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  const earlier = (preparation?.related ?? []).filter(
    (item) => item.meeting_id !== meetingId,
  );
  const off = disabled || busy;

  return (
    <div className="cal-event">
      {eventId === null ? (
        !picking && (
          <button
            type="button"
            className="om-ghost om-sm"
            disabled={off}
            onClick={openPicker}
          >
            Link to event
          </button>
        )
      ) : (
        <div className="cal-linked">
          {preparation ? (
            <span>
              <strong>{preparation.event.title}</strong>{" "}
              <span className="mono">
                {formatDateTime(preparation.event.start_utc)}
              </span>
            </span>
          ) : unavailable ? (
            <span className="om-muted">
              The linked event is no longer in your calendar.
            </span>
          ) : (
            <span className="om-muted">Loading event…</span>
          )}
          <button
            type="button"
            className="om-ghost om-sm"
            disabled={off}
            onClick={() => link(null)}
          >
            Unlink
          </button>
        </div>
      )}

      {eventId !== null && earlier.length > 0 && (
        <div className="cal-earlier">
          <span>Earlier: {earlier.length}</span>
          {earlier.map((item) => (
            <button
              key={item.meeting_id}
              type="button"
              className="cal-link"
              onClick={() => onOpenMeeting?.(item.meeting_id)}
            >
              {item.title}
            </button>
          ))}
        </div>
      )}

      {picking && (
        <div className="cal-picker" role="group" aria-label="Calendar events">
          {choices === null ? (
            <span className="om-muted">Loading events…</span>
          ) : choices.length === 0 ? (
            <span className="om-muted">No calendar events within one day.</span>
          ) : (
            choices.map((event) => (
              <button
                key={event.id}
                type="button"
                className="cal-choice"
                disabled={off}
                onClick={() => link(event.id)}
              >
                <span>{event.title}</span>
                <span className="om-muted mono">
                  {formatDateTime(event.start_utc)}
                </span>
              </button>
            ))
          )}
          <button
            type="button"
            className="om-ghost om-sm"
            onClick={() => setPicking(false)}
          >
            Cancel
          </button>
        </div>
      )}

      {error && (
        <p className="om-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
