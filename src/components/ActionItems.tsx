import { useState } from "react";
import { api, errorMessage, type ActionItem } from "../lib/api";

type Props = {
  meetingId: string;
  items: ActionItem[];
  /** The summary version on screen; its Action items section can be imported. */
  summaryId: number | null;
  disabled: boolean;
  onItems: (items: ActionItem[]) => void;
};

/** Editable tasks. Unknown owners and due dates stay empty instead of being guessed. */
export function ActionItems({
  meetingId,
  items,
  summaryId,
  disabled,
  onItems,
}: Props) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<ActionItem[]>) => {
    setBusy(true);
    setError("");
    try {
      onItems(await action());
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = (item: ActionItem, change: Partial<ActionItem>) => {
    const next = { ...item, ...change };
    void run(() =>
      api.saveActionItem(
        meetingId,
        item.id,
        next.text,
        next.owner,
        next.due_date,
        next.done,
      ),
    );
  };
  const locked = disabled || busy;
  return (
    <section className="action-items" aria-label="Tasks">
      <h4>Tasks</h4>
      {items.length === 0 && <p className="muted">No tasks yet.</p>}
      <ul>
        {items.map((item) => (
          // Remount on stored changes; a failed save keeps the typed text in place.
          <li
            key={`${item.id}:${item.text}:${item.owner ?? ""}:${item.due_date ?? ""}`}
          >
            <input
              type="checkbox"
              aria-label={`Done: ${item.text}`}
              checked={item.done}
              disabled={locked}
              onChange={(event) => save(item, { done: event.target.checked })}
            />
            <input
              aria-label={`Task: ${item.text}`}
              defaultValue={item.text}
              maxLength={500}
              disabled={locked}
              onBlur={(event) =>
                event.target.value.trim() !== item.text &&
                save(item, { text: event.target.value })
              }
            />
            <input
              aria-label={`Owner: ${item.text}`}
              placeholder="Unassigned"
              defaultValue={item.owner ?? ""}
              maxLength={80}
              disabled={locked}
              onBlur={(event) =>
                event.target.value.trim() !== (item.owner ?? "") &&
                save(item, { owner: event.target.value || null })
              }
            />
            <input
              type="date"
              aria-label={`Due date: ${item.text}`}
              defaultValue={item.due_date ?? ""}
              disabled={locked}
              // Commit on blur: typing a year fires intermediate valid dates.
              onBlur={(event) =>
                event.target.value !== (item.due_date ?? "") &&
                save(item, { due_date: event.target.value || null })
              }
            />
            <span className="muted">
              {item.source === "summary" ? "From summary" : "Added manually"}
            </span>
            <button
              aria-label={`Delete task: ${item.text}`}
              disabled={locked}
              onClick={() =>
                void run(() => api.deleteActionItem(meetingId, item.id))
              }
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      <form
        className="panel-actions"
        onSubmit={(event) => {
          event.preventDefault();
          void run(() =>
            api.saveActionItem(meetingId, null, draft, null, null, false),
          ).then((ok) => ok && setDraft(""));
        }}
      >
        <input
          aria-label="New task"
          placeholder="Add a task"
          value={draft}
          maxLength={500}
          disabled={locked}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={locked || !draft.trim()}>
          Add task
        </button>
        {summaryId !== null && (
          <button
            type="button"
            disabled={locked}
            onClick={() =>
              void run(() => api.importActionItems(meetingId, summaryId))
            }
          >
            Add from summary
          </button>
        )}
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
