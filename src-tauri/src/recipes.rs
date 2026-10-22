//! Recipes: saved question prompts that fill the question box. Nothing is sent when one is chosen;
//! the normal question send rules still apply.
use crate::{
    domain::{AppError, Recipe, Result, Settings},
    storage::{Core, Named},
};
use rusqlite::Connection;

/// A recipe becomes the question, so it shares the question length limit.
const MAX_PROMPT_CHARS: usize = 1_000;

const RECIPES: Named = Named {
    table: "recipes",
    column: "prompt",
    prefix: "recipe-",
    code: "recipe",
    noun: "recipe",
    cap: 50,
    missing: || AppError::new("recipe_missing", "This recipe no longer exists."),
};

pub fn read(db: &Connection) -> Result<Vec<Recipe>> {
    Ok(db
        .prepare("SELECT id,name,prompt FROM recipes ORDER BY name,id")?
        .query_map([], |row| {
            Ok(Recipe {
                id: row.get(0)?,
                name: row.get(1)?,
                prompt: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

impl Core {
    /// Creates a recipe when `id` is `None`; otherwise replaces an existing one.
    pub fn save_recipe(&mut self, id: Option<&str>, name: &str, prompt: &str) -> Result<Settings> {
        let prompt = prompt.trim();
        if prompt.is_empty() {
            return Err(AppError::new(
                "recipe",
                "Write the question this recipe asks.",
            ));
        }
        crate::llm::validate_instructions(prompt, MAX_PROMPT_CHARS)
            .map_err(|error| AppError::new("recipe", error.message))?;
        self.save_named(&RECIPES, id, name, prompt)
    }

    pub fn delete_recipe(&mut self, id: &str) -> Result<Settings> {
        self.delete_named(&RECIPES, id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn recipes_are_validated_saved_edited_and_deleted() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        assert_eq!(core.save_recipe(None, " ", "q").unwrap_err().code, "recipe");
        assert_eq!(core.save_recipe(None, "R", " ").unwrap_err().code, "recipe");
        assert_eq!(
            core.save_recipe(None, "R", &"x".repeat(1_001))
                .unwrap_err()
                .code,
            "recipe"
        );
        let saved = core
            .save_recipe(None, " Risks ", " What risks were raised? ")
            .unwrap();
        let recipe = &saved.recipes[0];
        assert_eq!(
            (recipe.name.as_str(), recipe.prompt.as_str()),
            ("Risks", "What risks were raised?")
        );
        let id = recipe.id.clone();
        let edited = core.save_recipe(Some(&id), "Risks", "List risks.").unwrap();
        assert_eq!(edited.recipes[0].prompt, "List risks.");
        assert!(core.delete_recipe(&id).unwrap().recipes.is_empty());
        assert_eq!(core.delete_recipe(&id).unwrap_err().code, "recipe_missing");
        assert_eq!(
            core.save_recipe(Some(&id), "R", "q").unwrap_err().code,
            "recipe_missing"
        );
    }
}
