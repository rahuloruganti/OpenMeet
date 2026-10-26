import { useEffect, useState } from "react";
import type { CalendarReminder } from "../../shared/api/api";
import "./calendar.css";

type Props = {
  reminder: CalendarReminder | null;
  onStart: () => void;
  onDismiss: () => void;
};

/** How often the "Starts in N min" text is recounted while a reminder is shown. */
const TICK_MS = 30_000;

/** "Starts in 2 min:" with the event title; "Start recording" opens the dialog prefilled. */
export function CalendarReminderPrompt({
  reminder,
  onStart,
  onDismiss,
}: Props) {
  const [, setTick] = useState(0);
  const shown = reminder !== null;

  useEffect(() => {
    if (!shown) return;
    const id = setInterval(() => setTick((tick) => tick + 1), TICK_MS);
    return () => clearInterval(id);
  }, [shown]);

  if (!reminder) return null;
  const minutes = Math.ceil(
    (Date.parse(reminder.start_utc) - Date.now()) / 60_000,
  );
  return (
    <div className="cal-prompt" role="status" aria-live="polite">
      <span>
        {minutes >= 1 ? `Starts in ${minutes} min:` : "Starts now:"}{" "}
        <strong>{reminder.title}</strong>
      </span>
      <div className="cal-prompt-actions">
        <button type="button" className="om-sm" onClick={onStart}>
          Start recording
        </button>
        <button type="button" className="om-ghost om-sm" onClick={onDismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}
