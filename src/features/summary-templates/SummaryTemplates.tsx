import { useState } from "react";
import { api, type Settings } from "../../shared/api/api";
import { useTask } from "../../shared/lib/use-task";
import { SavedTextEditor } from "../../shared/ui/saved-text-editor";

type Props = {
  settings: Settings | null;
  disabled: boolean;
  onSettings: (settings: Settings) => void;
};

/** Saved personal instructions and user-defined summary templates. Built-in templates stay fixed. */
export function SummaryTemplates({ settings, disabled, onSettings }: Props) {
  const [instructions, setInstructions] = useState<string | null>(null);
  const { busy, notice, error, setNotice, run } = useTask();
  const saveInstructions = () =>
    run(async () => {
      onSettings(await api.saveSummaryInstructions(instructions ?? ""));
      setNotice("Summary instructions saved.");
      setInstructions(null);
    });
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
