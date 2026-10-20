import { useState } from "react";
import { api, errorMessage, type Recipe, type Settings } from "../lib/api";

/** Built-in recipes live in code; saved ones come from Settings. */
export const builtinRecipes: Recipe[] = [
  {
    id: "builtin-catch-up",
    name: "Catch me up",
    prompt:
      "Catch me up: summarise what was discussed in five bullet points or fewer.",
  },
  {
    id: "builtin-follow-up-email",
    name: "Follow-up email",
    prompt:
      "Draft a short follow-up email to the other participants: thank them, recap the decisions, and list the action items with owners. Use only what the meetings support and leave a [placeholder] where a name or date is unknown.",
  },
  {
    id: "builtin-action-items",
    name: "Action items",
    prompt:
      "List every action item with its owner and any due date that was stated. Write 'owner unknown' or 'no date stated' instead of guessing.",
  },
  {
    id: "builtin-decisions",
    name: "Decisions",
    prompt: "What was decided, and what reason was given for each decision?",
  },
  {
    id: "builtin-open-questions",
    name: "Open questions",
    prompt: "Which questions or issues were raised but left unresolved?",
  },
];

/** Recipe chips: choosing one fills the question box. Nothing is sent until the usual review. */
export function RecipePicker(props: {
  recipes: Recipe[];
  disabled: boolean;
  onPick: (prompt: string) => void;
}) {
  return (
    <div className="recipe-picker" role="group" aria-label="Recipes">
      <span className="muted">Recipes</span>
      {[...builtinRecipes, ...props.recipes].map((recipe) => (
        <button
          type="button"
          key={recipe.id}
          className="recipe-chip"
          title={recipe.prompt}
          disabled={props.disabled}
          onClick={() => props.onPick(recipe.prompt)}
        >
          {recipe.name}
        </button>
      ))}
    </div>
  );
}

/** Saved recipes in Settings. Built-in recipes stay fixed. */
export function RecipeSettings({
  settings,
  disabled,
  onSettings,
}: {
  settings: Settings | null;
  disabled: boolean;
  onSettings: (settings: Settings) => void;
}) {
  const saved = settings?.recipes ?? [];
  const [editing, setEditing] = useState("");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const choose = (id: string) => {
    const recipe = saved.find((item) => item.id === id);
    setEditing(recipe?.id ?? "");
    setName(recipe?.name ?? "");
    setPrompt(recipe?.prompt ?? "");
  };
  const run = async (action: () => Promise<Settings>, done: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      onSettings(await action());
      setNotice(done);
      choose("");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const locked = disabled || busy || settings === null;
  return (
    <section className="settings-section" aria-label="Recipes">
      <h3>Recipes</h3>
      <p className="muted">
        Saved questions you can reuse when asking a meeting or several meetings.
        Choosing one only fills the question box; you still review what is sent.
        Built in: {builtinRecipes.map((recipe) => recipe.name).join(", ")}.
      </p>
      <label>
        Saved recipe
        <select
          value={editing}
          disabled={locked}
          onChange={(event) => choose(event.target.value)}
        >
          <option value="">New recipe</option>
          {saved.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Recipe name
        <input
          value={name}
          maxLength={80}
          disabled={locked}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        Question
        <textarea
          value={prompt}
          maxLength={1000}
          disabled={locked}
          placeholder="What risks were raised, and who owns each one?"
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      <div className="panel-actions">
        <button
          disabled={locked || !name.trim() || !prompt.trim()}
          onClick={() =>
            void run(
              () => api.saveRecipe(editing || null, name, prompt),
              editing ? "Recipe updated." : "Recipe added.",
            )
          }
        >
          {editing ? "Save recipe" : "Add recipe"}
        </button>
        {editing && (
          <button
            disabled={locked}
            onClick={() =>
              void run(() => api.deleteRecipe(editing), "Recipe deleted.")
            }
          >
            Delete recipe
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
