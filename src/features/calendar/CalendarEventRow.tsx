import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  type CalendarEvent,
  type MeetingPreparation,
} from "../../shared/api/api";
import { formatDateTime } from "../../entities/meeting";
import { IconCalendar } from "../../shared/ui/icons";
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

/** Compact calendar disclosure; its picker and series details stay out of the header flow. */
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
  const [preparationError, setPreparationError] = useState("");
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<CalendarEvent[] | null>(null);
  const [pickerError, setPickerError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const pickerRequest = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const dropdown = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(false);
  const disclosureId = useId();

  useEffect(() => {
    if (busy || open || !returnFocus.current) return;
    returnFocus.current = false;
    if (!disabled) trigger.current?.focus();
  }, [busy, open, disabled]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pickerRequest.current += 1;
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
      .catch((failure: unknown) => {
        if (active) setPreparationError(errorMessage(failure));
      });
    return () => {
      active = false;
    };
  }, [eventId]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  const title =
    eventId === null
      ? "Link to event"
      : (preparation?.event.title ??
        (preparationError ? "Linked event" : "Loading event…"));

  // Keep the existing anchored-dropdown pattern inside a narrow viewport, even
  // when metadata wraps and the trigger ends up near either window edge.
  useLayoutEffect(() => {
    if (!open) return;
    const fit = () => {
      if (!root.current || !dropdown.current) return;
      const left = root.current.getBoundingClientRect().left;
      const width = dropdown.current.getBoundingClientRect().width;
      const gutter =
        Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--space-16",
          ),
        ) || 16;
      dropdown.current.style.left = `${Math.max(gutter - left, Math.min(0, window.innerWidth - gutter - left - width))}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open, title]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (eventId !== null) return;
    const request = ++pickerRequest.current;
    const start = Date.parse(startedAt);
    setChoices(null);
    setPickerError("");
    setError("");
    void Promise.resolve()
      .then(() =>
        api.listCalendarEvents(
          new Date(start - DAY_MS).toISOString(),
          new Date(start + DAY_MS).toISOString(),
        ),
      )
      .then((list) => {
        if (mounted.current && request === pickerRequest.current)
          setChoices(list);
      })
      .catch((failure: unknown) => {
        if (mounted.current && request === pickerRequest.current)
          setPickerError(errorMessage(failure));
      });
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
        setPreparationError("");
        returnFocus.current = dropdown.current !== null;
        setOpen(false);
        setChoices(null);
      })
      .catch((failure: unknown) => {
        if (mounted.current) setError(errorMessage(failure));
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  const earlier = (preparation?.related ?? []).filter(
    (item) => item.meeting_id !== meetingId,
  );
  const off = disabled || busy;

  return (
    <div
      className="cal-event"
      ref={root}
      onKeyDown={(event) => {
        if (!open || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="om-ghost om-sm cal-trigger"
        disabled={off}
        aria-expanded={open}
        aria-controls={disclosureId}
        title={title}
        onClick={toggle}
      >
        <IconCalendar size={14} />
        <span className="cal-trigger-title">{title}</span>
      </button>

      {open && (
        <div
          ref={dropdown}
          id={disclosureId}
          className="cal-dropdown"
          role="group"
          aria-label={eventId === null ? "Calendar events" : "Calendar event"}
          aria-busy={busy}
        >
          {eventId === null ? (
            <>
              {pickerError ? (
                <p className="om-error" role="alert">
                  {pickerError}
                </p>
              ) : choices === null ? (
                <span className="om-muted" role="status">
                  Loading events…
                </span>
              ) : choices.length === 0 ? (
                <span className="om-muted">
                  No calendar events within one day.
                </span>
              ) : (
                choices.map((event) => (
                  <button
                    key={event.id}
                    type="button"
                    className="cal-choice"
                    disabled={off}
                    onClick={() => link(event.id)}
                  >
                    <span className="cal-choice-title">{event.title}</span>
                    <span className="cal-time">
                      {formatDateTime(event.start_utc)}
                    </span>
                  </button>
                ))
              )}
            </>
          ) : (
            <>
              {preparationError ? (
                <p className="om-error" role="alert">
                  {preparationError}
                </p>
              ) : preparation ? (
                <div className="cal-details">
                  <strong className="cal-choice-title">
                    {preparation.event.title}
                  </strong>
                  <span className="cal-time">
                    {formatDateTime(preparation.event.start_utc)}
                  </span>
                </div>
              ) : (
                <span className="om-muted" role="status">
                  Loading event…
                </span>
              )}
              {earlier.length > 0 && (
                <div className="cal-related">
                  <span className="om-muted">Earlier: {earlier.length}</span>
                  {earlier.map((item) => (
                    <button
                      key={item.meeting_id}
                      type="button"
                      className="cal-choice"
                      disabled={off || !onOpenMeeting}
                      onClick={() => {
                        setOpen(false);
                        onOpenMeeting?.(item.meeting_id);
                      }}
                    >
                      {item.title}
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="om-ghost om-sm"
                disabled={off}
                onClick={() => link(null)}
              >
                Unlink
              </button>
            </>
          )}
          {error && (
            <p className="om-error" role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            className="om-ghost om-sm"
            onClick={() => {
              setOpen(false);
              trigger.current?.focus();
            }}
          >
            {eventId === null ? "Cancel" : "Close"}
          </button>
        </div>
      )}
    </div>
  );
}
