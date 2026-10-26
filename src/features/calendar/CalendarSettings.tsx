import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  api,
  errorMessage,
  type CalendarFeed,
  type Settings,
} from "../../shared/api/api";
import { formatDateTime } from "../../entities/meeting";
import { Saved, useSaved } from "../../shared/ui/settings-link";
import "./calendar.css";

type Props = {
  settings: Settings | null;
  disabled: boolean;
  /** The saved settings a reminder change returns, so the rest of the page sees the new choice. */
  onSaved?: (settings: Settings) => void;
};

const MINUTE_CHOICES = [0, 1, 2, 5, 10, 15, 20, 30];

/** One line under each feed: when it last synced, and whether that worked. */
export function feedStatus(feed: CalendarFeed): string {
  if (!feed.has_url) return "Address missing. Remove it and add it again.";
  if (feed.last_status === "never" || feed.last_sync_at === null)
    return "Not synced yet";
  const when = formatDateTime(feed.last_sync_at);
  return feed.last_status === "ok" ? `Synced ${when}` : `Sync failed ${when}`;
}

/** Settings > Recording > Calendar: read-only iCal feeds and the reminder switch. */
export function CalendarSettings({ settings, disabled, onSaved }: Props) {
  const [feeds, setFeeds] = useState<CalendarFeed[]>([]);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reminders, setReminders] = useState({
    enabled: settings?.calendar_reminders ?? true,
    minutes: settings?.calendar_reminder_minutes ?? 2,
  });
  const { shown, mark } = useSaved();
  const labelId = useId();
  const addressId = useId();
  const minutesId = useId();
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const next = await api.listCalendarFeeds();
    if (mounted.current) setFeeds(next);
  }, []);

  const fail = useCallback((failure: unknown) => {
    if (mounted.current) setError(errorMessage(failure));
  }, []);

  useEffect(() => {
    mounted.current = true;
    void Promise.resolve()
      .then(() => refresh())
      .catch(fail);
    let stop: (() => void) | undefined;
    let closed = false;
    void Promise.resolve()
      .then(() => api.onCalendarChanged(() => void refresh().catch(fail)))
      .then((unlisten) => {
        if (closed) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    return () => {
      mounted.current = false;
      closed = true;
      stop?.();
      setLabel("");
      setAddress("");
    };
  }, [refresh, fail]);

  useEffect(() => {
    if (settings) {
      setReminders({
        enabled: settings.calendar_reminders,
        minutes: settings.calendar_reminder_minutes,
      });
    }
  }, [settings]);

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    void Promise.resolve()
      .then(() => api.addCalendarFeed(label.trim(), address.trim()))
      .then(() => {
        if (!mounted.current) return;
        setLabel("");
        setAddress("");
        setAdding(false);
        return refresh();
      })
      .catch((failure) => {
        if (!mounted.current) return;
        setAddress("");
        fail(failure);
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  const remove = (feed: CalendarFeed) => {
    setError("");
    void Promise.resolve()
      .then(() => api.removeCalendarFeed(feed.id))
      .then(() => refresh())
      .catch(fail);
  };

  const syncNow = () => {
    setBusy(true);
    setError("");
    void Promise.resolve()
      .then(() => api.syncCalendars())
      .then((next) => {
        if (mounted.current) setFeeds(next);
      })
      .catch(fail)
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  const saveReminders = (enabled: boolean, minutes: number) => {
    const before = reminders;
    setReminders({ enabled, minutes });
    setError("");
    void Promise.resolve()
      .then(() => api.saveCalendarReminders(enabled, minutes))
      .then((saved) => {
        if (!mounted.current) return;
        onSaved?.(saved);
        mark();
      })
      .catch((failure) => {
        if (!mounted.current) return;
        setReminders(before);
        fail(failure);
      });
  };

  const closeForm = () => {
    setAdding(false);
    setLabel("");
    setAddress("");
  };

  const controlsOff = disabled || busy;

  return (
    <section className="om-group" aria-label="Calendar">
      <h3 className="om-group-label">
        Calendar
        {shown && <Saved show />}
      </h3>

      <div className="om-card om-rows">
        <div className="om-row">
          <div className="om-what">
            <strong>Calendars</strong>
            <span>
              Reads each address every 15 minutes. Never writes to your
              calendar.
            </span>
            <span className="om-muted">
              The calendar address is fetched over HTTPS.
            </span>
          </div>
          <div className="om-side">
            <button
              type="button"
              className="om-ghost om-sm"
              disabled={controlsOff || feeds.length === 0}
              onClick={syncNow}
            >
              Sync now
            </button>
            <button
              type="button"
              className="om-sm"
              disabled={controlsOff}
              aria-expanded={adding}
              onClick={() => (adding ? closeForm() : setAdding(true))}
            >
              Add calendar
            </button>
          </div>
        </div>

        {feeds.length === 0 && (
          <div className="om-row">
            <div className="om-what">
              <span className="om-muted">
                No calendar added. OpenMeet works without one.
              </span>
            </div>
          </div>
        )}

        {feeds.map((feed) => (
          <div className="om-row" key={feed.id}>
            <div className="om-what">
              <strong>{feed.label}</strong>
              <span>{feedStatus(feed)}</span>
              {feed.last_error && (
                <span className="cal-error">{feed.last_error}</span>
              )}
            </div>
            <div className="om-side">
              <button
                type="button"
                className="om-ghost om-sm"
                aria-label={`Remove ${feed.label}`}
                disabled={controlsOff}
                onClick={() => remove(feed)}
              >
                Remove
              </button>
            </div>
          </div>
        ))}

        {adding && (
          <div className="om-row">
            <form className="cal-form" onSubmit={add} aria-label="Add calendar">
              <label htmlFor={labelId}>Label</label>
              <input
                id={labelId}
                type="text"
                maxLength={80}
                value={label}
                disabled={busy}
                onChange={(event) => setLabel(event.target.value)}
              />
              <label htmlFor={addressId}>iCal address</label>
              <input
                id={addressId}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={address}
                disabled={busy}
                onChange={(event) => setAddress(event.target.value)}
              />
              <p className="om-muted cal-helper">
                Paste the secret iCal address from Google Calendar settings or
                the Outlook published ICS link. It is stored in Windows
                Credential Manager.
              </p>
              <div className="cal-actions">
                <button
                  type="submit"
                  className="om-sm"
                  disabled={busy || !label.trim() || !address.trim()}
                >
                  Save calendar
                </button>
                <button
                  type="button"
                  className="om-ghost om-sm"
                  disabled={busy}
                  onClick={closeForm}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        <div className="om-row">
          <div className="om-what">
            <strong>Reminders</strong>
            <span>A prompt appears before a timed event starts.</span>
          </div>
          <div className="om-side">
            <label htmlFor={minutesId} className="cal-minutes-label">
              Minutes before
            </label>
            <select
              id={minutesId}
              value={reminders.minutes}
              disabled={disabled || !settings}
              onChange={(event) =>
                saveReminders(reminders.enabled, Number(event.target.value))
              }
            >
              {MINUTE_CHOICES.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes}
                </option>
              ))}
            </select>
            <button
              type="button"
              role="switch"
              aria-checked={reminders.enabled}
              aria-label="Calendar reminders"
              className="om-switch"
              disabled={disabled || !settings}
              onClick={() =>
                saveReminders(!reminders.enabled, reminders.minutes)
              }
            />
          </div>
        </div>
      </div>

      {error && (
        <p className="om-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
