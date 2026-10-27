import { useState } from "react";
import { api, type Settings } from "../../shared/api/api";
import { builtinTemplates } from "../../entities/processing";
import { IconPlus, IconTrash } from "../../shared/ui/icons";
import { Saved, useSaved } from "../../shared/ui/settings-link";
import "./summary-templates.css";

type Item = { id: string; name: string; body: string };

type Props = {
  settings: Settings | null;
  disabled: boolean;
  onSettings: (settings: Settings) => void;
  /** Saves the default summary template immediately. */
  onDefaultTemplate: (template: string) => void;
};

/** Saved summary templates, with the template the Enhance picker starts at. */
export function SummaryTemplates(props: Props) {
  const { settings } = props;
  const { shown, mark } = useSaved();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [instructions, setInstructions] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const items: Item[] = (settings?.summary_templates ?? []).map((item) => ({
    id: item.id,
    name: item.name,
    body: item.instructions,
  }));
  const locked = props.disabled || busy || !settings;
  const reset = () => {
    setCreating(false);
    setEditing(null);
    setName("");
    setBody("");
    setError("");
  };
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (failure) {
      setError(
        (failure as { message?: string } | null)?.message ?? String(failure),
      );
    } finally {
      setBusy(false);
    }
  };
  const start = (id: string | null) => {
    const item = items.find((saved) => saved.id === (id ?? ""));
    setEditing(null);
    setCreating(false);
    if (item) {
      setEditing(item.id);
      setName(item.name);
      setBody(item.body);
    } else {
      setCreating(true);
      setName("");
      setBody("");
    }
    setError("");
    setNotice("");
  };
  const save = () =>
    run(async () => {
      const saved = await api.saveSummaryTemplate(
        editing,
        name.trim(),
        body.trim(),
      );
      props.onSettings(saved);
      setNotice(editing ? "template updated." : "template added.");
      mark();
      reset();
    });
  const remove = () =>
    run(async () => {
      if (!editing) return;
      props.onSettings(await api.deleteSummaryTemplate(editing));
      setNotice("Template deleted; earlier summaries keep their text.");
      reset();
    });
  const saveInstructions = () =>
    run(async () => {
      if (instructions === null) return;
      props.onSettings(await api.saveSummaryInstructions(instructions));
      setInstructions(null);
      mark();
    });
  const templateOptions = [
    ...builtinTemplates.map(({ id, label }) => ({ id, name: label })),
    ...(settings?.summary_templates ?? []).map(({ id, name: label }) => ({
      id,
      name: label,
    })),
  ];
  const chosen = settings?.summary_default ?? "general-v1";
  return (
    <div className="om-templates">
      <div className="om-card om-rows">
        <div className="om-row">
          <div className="om-what">
            <strong>Default</strong>
          </div>
          <div className="om-side">
            <select
              aria-label="Default template"
              value={chosen}
              disabled={locked}
              onChange={(event) => props.onDefaultTemplate(event.target.value)}
            >
              {templateOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
              {!templateOptions.some((option) => option.id === chosen) && (
                <option value={chosen}>{chosen}</option>
              )}
            </select>
          </div>
        </div>
        {items.map((item) => (
          <div className="om-row tpl-row" key={item.id}>
            <div className="om-what">
              <strong>{item.name}</strong>
            </div>
            <div className="om-side">
              <button
                type="button"
                className="om-ghost om-sm"
                aria-label={`Edit ${item.name}`}
                disabled={locked}
                onClick={() => start(item.id)}
              >
                Edit
              </button>
            </div>
          </div>
        ))}
        {items.length === 0 && (
          <div className="om-row">
            <div className="om-what">
              <strong>No saved templates</strong>
              <span>Built-in templates stay available</span>
            </div>
          </div>
        )}
      </div>
      <div className="om-card-foot">
        <button
          type="button"
          className="om-ghost om-sm tpl-new"
          disabled={locked}
          onClick={() => start(null)}
        >
          <IconPlus size={14} />
          New template
        </button>
        <span className="om-spacer" />
        <span className="om-muted">{items.length} saved</span>
        <Saved show={shown} />
      </div>
      {notice && <p className="om-muted">{notice}</p>}
      {!creating && !editing && error && (
        <p role="alert" className="om-error">
          {error}
        </p>
      )}

      {(creating || editing) && (
        <div className="om-card om-form tpl-form">
          <label>
            Template name
            <input
              aria-label="Template name"
              value={name}
              maxLength={80}
              disabled={locked}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Structure
            <textarea
              aria-label="Template structure"
              value={body}
              maxLength={4000}
              rows={3}
              disabled={locked}
              placeholder={"## Summary\n## Risks\n## Action items"}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <div className="om-form-actions">
            <button
              type="button"
              className="om-sm"
              aria-label={`${editing ? "Save" : "Add"} template`}
              disabled={locked || !name.trim() || !body.trim()}
              onClick={() => void save()}
            >
              {editing ? "Save" : "Add"}
            </button>
            {editing && (
              <button
                type="button"
                className="om-ghost om-sm om-danger"
                aria-label="Delete template"
                disabled={locked}
                onClick={() => void remove()}
              >
                <IconTrash size={14} />
                Delete
              </button>
            )}
            <button
              type="button"
              className="om-ghost om-sm"
              disabled={busy}
              onClick={reset}
            >
              Cancel
            </button>
          </div>
          {error && (
            <p role="alert" className="om-error">
              {error}
            </p>
          )}
          {notice && <p className="om-muted">{notice}</p>}
        </div>
      )}

      <details className="om-more">
        <summary>More options</summary>
        <div className="om-more-body">
          <div className="om-frow">
            <span>Saved instructions</span>
          </div>
          <textarea
            className="tpl-instructions"
            aria-label="Saved summary instructions"
            value={instructions ?? settings?.summary_instructions ?? ""}
            maxLength={2000}
            rows={2}
            disabled={locked}
            placeholder="For example: Write in British English."
            onChange={(event) => setInstructions(event.target.value)}
            onBlur={() => void saveInstructions()}
          />
          <div className="om-frow">
            <span />
            <Saved show={shown} />
          </div>
        </div>
      </details>
    </div>
  );
}
