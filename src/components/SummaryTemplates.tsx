import { useState } from "react";
import { api, errorMessage, type Settings } from "../lib/api";

type Props = {
  settings: Settings | null;
  disabled: boolean;
  onSettings: (settings: Settings) => void;
};

/** Saved personal instructions and user-defined summary templates. Built-in templates stay fixed. */
export function SummaryTemplates({ settings, disabled, onSettings }: Props) {
  const saved = settings?.summary_templates ?? [];
  const [instructions, setInstructions] = useState<string | null>(null);
  const [editing, setEditing] = useState("");
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const run = async (action: () => Promise<Settings>, done: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      onSettings(await action());
      setNotice(done);
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const choose = (id: string) => {
    const template = saved.find((item) => item.id === id);
    setEditing(template?.id ?? "");
    setName(template?.name ?? "");
    setBody(template?.instructions ?? "");
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
        onClick={() =>
          void run(
            () => api.saveSummaryInstructions(instructions ?? ""),
            "Summary instructions saved.",
          ).then((ok) => ok && setInstructions(null))
        }
      >
        Save instructions
      </button>
      <label>
        Custom template
        <select
          value={editing}
          disabled={locked}
          onChange={(event) => choose(event.target.value)}
        >
          <option value="">New template</option>
          {saved.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Template name
        <input
          value={name}
          maxLength={80}
          disabled={locked}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        Template structure
        <textarea
          value={body}
          maxLength={4000}
          disabled={locked}
          placeholder={"## Summary\n## Risks\n## Action items"}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      <div className="panel-actions">
        <button
          disabled={locked || !name.trim() || !body.trim()}
          onClick={() =>
            void run(
              () => api.saveSummaryTemplate(editing || null, name, body),
              editing ? "Template updated." : "Template added.",
            ).then((ok) => ok && !editing && choose(""))
          }
        >
          {editing ? "Save template" : "Add template"}
        </button>
        {editing && (
          <button
            disabled={locked}
            onClick={() =>
              void run(
                () => api.deleteSummaryTemplate(editing),
                "Template deleted. Earlier summaries keep their text.",
              ).then((ok) => ok && choose(""))
            }
          >
            Delete template
          </button>
        )}
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
