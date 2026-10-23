import { useState } from "react";
import type { Settings } from "../api/api";
import { useTask } from "../lib/use-task";

type Item = { id: string; name: string; body: string };

export function SavedTextEditor(props: {
  /** Lower-case singular, e.g. "template". */
  noun: string;
  pickerLabel: string;
  bodyLabel: string;
  bodyMax: number;
  placeholder: string;
  /** Shown after a delete. */
  deleted: string;
  items: Item[];
  locked: boolean;
  onSave: (id: string | null, name: string, body: string) => Promise<Settings>;
  onDelete: (id: string) => Promise<Settings>;
  onSettings: (settings: Settings) => void;
}) {
  const [editing, setEditing] = useState("");
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const { busy, notice, error, setNotice, run } = useTask();
  const Noun = props.noun[0].toUpperCase() + props.noun.slice(1);
  const choose = (id: string) => {
    const item = props.items.find((saved) => saved.id === id);
    setEditing(item?.id ?? "");
    setName(item?.name ?? "");
    setBody(item?.body ?? "");
  };
  const save = (
    action: () => Promise<Settings>,
    done: string,
    reset: boolean,
  ) =>
    run(async () => {
      props.onSettings(await action());
      setNotice(done);
      if (reset) choose("");
    });
  const locked = props.locked || busy;
  return (
    <>
      <label>
        {props.pickerLabel}
        <select
          value={editing}
          disabled={locked}
          onChange={(event) => choose(event.target.value)}
        >
          <option value="">New {props.noun}</option>
          {props.items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {Noun} name
        <input
          value={name}
          maxLength={80}
          disabled={locked}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        {props.bodyLabel}
        <textarea
          value={body}
          maxLength={props.bodyMax}
          disabled={locked}
          placeholder={props.placeholder}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      <div className="panel-actions">
        <button
          disabled={locked || !name.trim() || !body.trim()}
          onClick={() =>
            void save(
              () => props.onSave(editing || null, name, body),
              editing ? `${Noun} updated.` : `${Noun} added.`,
              !editing,
            )
          }
        >
          {editing ? `Save ${props.noun}` : `Add ${props.noun}`}
        </button>
        {editing && (
          <button
            disabled={locked}
            onClick={() =>
              void save(() => props.onDelete(editing), props.deleted, true)
            }
          >
            Delete {props.noun}
          </button>
        )}
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </>
  );
}
