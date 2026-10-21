import { api, type Recipe, type Settings } from "../lib/api";
import { SavedTextEditor } from "./SummaryTemplates";

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
  return (
    <section className="settings-section" aria-label="Recipes">
      <h3>Recipes</h3>
      <p className="muted">
        Saved questions you can reuse when asking a meeting or several meetings.
        Choosing one only fills the question box; you still review what is sent.
        Built in: {builtinRecipes.map((recipe) => recipe.name).join(", ")}.
      </p>
      <SavedTextEditor
        noun="recipe"
        pickerLabel="Saved recipe"
        bodyLabel="Question"
        bodyMax={1000}
        placeholder="What risks were raised, and who owns each one?"
        deleted="Recipe deleted."
        items={(settings?.recipes ?? []).map((recipe) => ({
          id: recipe.id,
          name: recipe.name,
          body: recipe.prompt,
        }))}
        locked={disabled || settings === null}
        onSave={api.saveRecipe}
        onDelete={api.deleteRecipe}
        onSettings={onSettings}
      />
    </section>
  );
}
