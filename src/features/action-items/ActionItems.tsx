import { useState, type ReactNode } from "react";
import { api, errorMessage, type ActionItem } from "../../shared/api/api";
import { timestampTokens } from "../../shared/lib/timestamps";
import { IconX } from "../../shared/ui/icons";
import "./action-items.css";

type Props = {
  meetingId: string;
  items: ActionItem[];
  /** The summary version on screen; its Action items section can be imported. */
  summaryId: number | null;
  disabled: boolean;
  onItems: (items: ActionItem[]) => void;
  /** Renders a `[m:ss]` citation found in a task as a validated source link. */
  reference?: (token: string) => ReactNode;
};

/** Editable tasks for the inspector. Unknown owners and due dates stay empty. */
export function ActionItems({
  meetingId,
  items,
  summaryId,
  disabled,
  onItems,
  reference,
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
    <div className="tasks" role="group" aria-label="Tasks">
      {items.length === 0 && <p className="insp-empty">No tasks yet</p>}
      <ul>
        {items.map((item) => (
          // Remount on stored changes; a failed save keeps the typed text in place.
          <li
            className={item.done ? "task is-done" : "task"}
            key={`${item.id}:${item.text}:${item.owner ?? ""}:${item.due_date ?? ""}`}
          >
            <input
              type="checkbox"
              aria-label={`Done: ${item.text}`}
              checked={item.done}
              disabled={locked}
              onChange={(event) => save(item, { done: event.target.checked })}
            />
            <div className="task-body">
              <textarea
                className="task-text"
                rows={1}
                aria-label={`Task: ${item.text}`}
                defaultValue={item.text}
                maxLength={500}
                disabled={locked}
                // One logical line that wraps; Enter commits like it did in a text field.
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
                onBlur={(event) =>
                  event.target.value.trim() !== item.text &&
                  save(item, { text: event.target.value })
                }
              />
              <div className="task-meta">
                <input
                  className="task-owner"
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
                  className={item.due_date ? undefined : "task-due-empty"}
                  aria-label={`Due date: ${item.text}`}
                  defaultValue={item.due_date ?? ""}
                  disabled={locked}
                  // Commit on blur: typing a year fires intermediate valid dates.
                  onBlur={(event) =>
                    event.target.value !== (item.due_date ?? "") &&
                    save(item, { due_date: event.target.value || null })
                  }
                />
                <span className="task-src">
                  {item.source === "summary" ? "Summary" : "Manual"}
                </span>
                {reference &&
                  item.text
                    .split(timestampTokens)
                    .filter((_, index) => index % 2 === 1)
                    .map((token, index) => (
                      <span key={index}>{reference(token)}</span>
                    ))}
              </div>
            </div>
            <button
              className="task-del"
              aria-label={`Delete task: ${item.text}`}
              disabled={locked}
              onClick={() =>
                void run(() => api.deleteActionItem(meetingId, item.id))
              }
            >
              <IconX size={14} />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="task-add"
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
            className="task-from-summary"
            disabled={locked}
            onClick={() =>
              void run(() => api.importActionItems(meetingId, summaryId))
            }
          >
            From summary
          </button>
        )}
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
