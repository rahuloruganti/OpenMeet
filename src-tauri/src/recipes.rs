//! Recipes: saved question prompts that fill the question box. Nothing is sent when one is chosen;
//! the normal question review and consent still apply.
use crate::{
    domain::{AppError, Recipe, Result, Settings},
    storage::Core,
};
use rusqlite::{params, Connection};
use uuid::Uuid;

const MAX_RECIPES: i64 = 50;
/// A recipe becomes the question, so it shares the question length limit.
const MAX_PROMPT_CHARS: usize = 1_000;

fn missing() -> AppError {
    AppError::new("recipe_missing", "This recipe no longer exists.")
}

fn invalid(message: &str) -> AppError {
    AppError::new("recipe", message)
}

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
        let (name, prompt) = (name.trim(), prompt.trim());
        if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
            return Err(invalid(
                "Enter a recipe name of 1–80 characters on one line.",
            ));
        }
        if prompt.is_empty() {
            return Err(invalid("Write the question this recipe asks."));
        }
        crate::llm::validate_instructions(prompt, MAX_PROMPT_CHARS)
            .map_err(|error| invalid(&error.message))?;
        let changed = match id {
            Some(id) => self.db.execute(
                "UPDATE recipes SET name=?2,prompt=?3 WHERE id=?1",
                params![id, name, prompt],
            )?,
            None => {
                let count: i64 = self
                    .db
                    .query_row("SELECT COUNT(*) FROM recipes", [], |row| row.get(0))?;
                if count >= MAX_RECIPES {
                    return Err(invalid(&format!(
                        "You can save up to {MAX_RECIPES} recipes."
                    )));
                }
                self.db.execute(
                    "INSERT INTO recipes(id,name,prompt) VALUES (?1,?2,?3)",
                    params![format!("recipe-{}", Uuid::new_v4()), name, prompt],
                )?
            }
        };
        if changed != 1 {
            return Err(missing());
        }
        self.settings()
    }

    pub fn delete_recipe(&mut self, id: &str) -> Result<Settings> {
        if self.db.execute("DELETE FROM recipes WHERE id=?1", [id])? != 1 {
            return Err(missing());
        }
        self.settings()
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
