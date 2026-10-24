import { useState } from "react";
import { api, type Settings } from "../../shared/api/api";
import { builtinTemplates } from "../../entities/processing";
import { Saved, useSaved } from "../../shared/ui/settings-link";

type Kind = "summary" | "recipe";

type Item = { id: string; name: string; body: string; kind: Kind };

type Props = {
  settings: Settings | null;
  disabled: boolean;
  onSettings: (settings: Settings) => void;
  /** Saves the default summary template immediately. */
  onDefaultTemplate: (template: string) => void;
};

const kindLabel: Record<Kind, string> = {
  summary: "Summary",
  recipe: "Recipe",
};

/** The word for one saved item: a summary template, or a recipe. */
const nounFor = (kind: Kind) => (kind === "summary" ? "template" : "recipe");

/**
 * Summary templates and recipes as ONE list, tagged by kind. Storage stays as it was:
 * templates are sent with a summary request, recipes only fill the question box.
 */
export function SummaryTemplates(props: Props) {
  const { settings } = props;
  const { shown, mark } = useSaved();
  // `creating` edits a new item of that kind; `editing` is the saved item, by kind.
  const [creating, setCreating] = useState<Kind | null>(null);
  const [editing, setEditing] = useState<{ id: string; kind: Kind } | null>(
    null,
  );
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [instructions, setInstructions] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const items: Item[] = [
    ...(settings?.summary_templates ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      body: item.instructions,
      kind: "summary" as const,
    })),
    ...(settings?.recipes ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      body: item.prompt,
      kind: "recipe" as const,
    })),
  ];
  const kind: Kind = editing?.kind ?? creating ?? "summary";
  const locked = props.disabled || busy || !settings;
  const reset = () => {
    setCreating(null);
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
  const start = (id: string | null, next: Kind) => {
    const item = items.find(
      (saved) => saved.kind === next && saved.id === (id ?? ""),
    );
    setEditing(null);
    setCreating(null);
    if (item) {
      setEditing({ id: item.id, kind: item.kind });
      setName(item.name);
      setBody(item.body);
    } else {
      setCreating(next);
      setName("");
      setBody("");
    }
    setError("");
    setNotice("");
  };
  const save = () =>
    run(async () => {
      const saved = editing
        ? kind === "summary"
          ? await api.saveSummaryTemplate(editing.id, name.trim(), body.trim())
          : await api.saveRecipe(editing.id, name.trim(), body.trim())
        : kind === "summary"
          ? await api.saveSummaryTemplate(null, name.trim(), body.trim())
          : await api.saveRecipe(null, name.trim(), body.trim());
      props.onSettings(saved);
      const noun = nounFor(kind);
      setNotice(editing ? `${noun} updated.` : `${noun} added.`);
      mark();
      reset();
    });
  const remove = () =>
    run(async () => {
      if (!editing) return;
      const saved =
        editing.kind === "summary"
          ? await api.deleteSummaryTemplate(editing.id)
          : await api.deleteRecipe(editing.id);
      props.onSettings(saved);
      setNotice(
        editing.kind === "summary"
          ? "Template deleted; earlier summaries keep their text."
          : "Recipe deleted.",
      );
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
          <div className="om-row" key={`${item.kind}-${item.id}`}>
            <div className="om-what">
              <strong>{item.name}</strong>
            </div>
            <div className="om-side">
              <span className="om-tag">{kindLabel[item.kind]}</span>
              <button
                type="button"
                className="om-ghost om-sm"
                aria-label={`Edit ${item.name}`}
                disabled={locked}
                onClick={() => start(item.id, item.kind)}
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
          className="om-ghost om-sm"
          disabled={locked}
          onClick={() => start(null, "summary")}
        >
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
        <div className="om-card om-form">
          <div className="om-seg" role="group" aria-label="Template kind">
            {(["summary", "recipe"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={kind === option}
                disabled={locked}
                onClick={() => {
                  if (editing) return;
                  setCreating(option);
                }}
              >
                <span className="om-seg-t">{kindLabel[option]}</span>
                <span className="om-seg-s">
                  {option === "summary"
                    ? "Writes notes for the whole meeting."
                    : "Fills the question box. Nothing is sent until you ask."}
                </span>
              </button>
            ))}
          </div>
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
            {kind === "recipe" ? "Question" : "Structure"}
            <textarea
              aria-label={
                kind === "recipe" ? "Template question" : "Template structure"
              }
              value={body}
              maxLength={kind === "recipe" ? 1000 : 4000}
              rows={3}
              disabled={locked}
              placeholder={
                kind === "recipe"
                  ? "What risks were raised, and who owns each one?"
                  : "## Summary\n## Risks\n## Action items"
              }
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <div className="om-form-actions">
            <button
              type="button"
              className="om-sm"
              aria-label={`${editing ? "Save" : "Add"} ${nounFor(kind)}`}
              disabled={locked || !name.trim() || !body.trim()}
              onClick={() => void save()}
            >
              {editing ? "Save" : "Add"}
            </button>
            {editing && (
              <button
                type="button"
                className="om-ghost om-sm om-danger"
                aria-label={`Delete ${nounFor(kind)}`}
                disabled={locked}
                onClick={() => void remove()}
              >
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
