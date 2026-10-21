import { useState } from "react";
import { api, errorMessage, type Settings } from "../lib/api";

type Props = {
  settings: Settings | null;
  disabled: boolean;
  onSettings: (settings: Settings) => void;
};

type Item = { id: string; name: string; body: string };

/** Picker plus name/body form for saved user texts (summary templates, recipes). */
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
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const Noun = props.noun[0].toUpperCase() + props.noun.slice(1);
  const choose = (id: string) => {
    const item = props.items.find((saved) => saved.id === id);
    setEditing(item?.id ?? "");
    setName(item?.name ?? "");
    setBody(item?.body ?? "");
  };
  const run = async (
    action: () => Promise<Settings>,
    done: string,
    reset: boolean,
  ) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      props.onSettings(await action());
      setNotice(done);
      if (reset) choose("");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
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
            void run(
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
              void run(() => props.onDelete(editing), props.deleted, true)
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

/** Saved personal instructions and user-defined summary templates. Built-in templates stay fixed. */
export function SummaryTemplates({ settings, disabled, onSettings }: Props) {
  const [instructions, setInstructions] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const saveInstructions = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      onSettings(await api.saveSummaryInstructions(instructions ?? ""));
      setNotice("Summary instructions saved.");
      setInstructions(null);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const locked = disabled || busy || settings === null;
  return (
    <section className="settings-section" aria-label="Summary templates">
      <h3>Summary templates</h3>
      <p className="muted">
        Saved instructions and the chosen template are sent with every summary
        request. General, Stand-up, and One-to-one stay available.
      </p>
      <label>
        Saved summary instructions
        <textarea
          value={instructions ?? settings?.summary_instructions ?? ""}
          maxLength={2000}
          disabled={locked}
          placeholder="For example: Write in British English."
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>
      <button
        disabled={locked || instructions === null}
        onClick={() => void saveInstructions()}
      >
        Save instructions
      </button>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <SavedTextEditor
        noun="template"
        pickerLabel="Custom template"
        bodyLabel="Template structure"
        bodyMax={4000}
        placeholder={"## Summary\n## Risks\n## Action items"}
        deleted="Template deleted. Earlier summaries keep their text."
        items={(settings?.summary_templates ?? []).map((item) => ({
          id: item.id,
          name: item.name,
          body: item.instructions,
        }))}
        locked={disabled || settings === null}
        onSave={api.saveSummaryTemplate}
        onDelete={api.deleteSummaryTemplate}
        onSettings={onSettings}
      />
    </section>
  );
}
