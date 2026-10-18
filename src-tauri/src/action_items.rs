//! Editable meeting tasks: manual entries and explicit imports from a summary's action items.
use crate::{
    domain::{ActionItem, AppError, Result},
    storage::Core,
};
use rusqlite::{params, OptionalExtension};

const MAX_ITEMS: usize = 200;
const MAX_TEXT: usize = 500;
const MAX_OWNER: usize = 80;

fn invalid(message: &str) -> AppError {
    AppError::new("action_item", message)
}

fn missing() -> AppError {
    AppError::new("not_found", "This task no longer exists.")
}

/// One line of bounded text; empty optional fields become None so "unknown" has one form.
fn line(value: &str, max: usize, what: &str) -> Result<String> {
    let value = value.trim();
    if value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(invalid(&format!(
            "Keep the {what} on one line, at most {max} characters."
        )));
    }
    Ok(value.to_string())
}

fn due_date(value: Option<&str>) -> Result<Option<String>> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let bad = || invalid("Use a due date such as 2026-10-31, or leave it empty.");
    let parts: Vec<&str> = value.split('-').collect();
    let [year, month, day] = parts.as_slice() else {
        return Err(bad());
    };
    if year.len() != 4 || month.len() != 2 || day.len() != 2 {
        return Err(bad());
    }
    let month = month
        .parse::<u8>()
        .ok()
        .and_then(|m| time::Month::try_from(m).ok());
    match (year.parse::<i32>(), month, day.parse::<u8>()) {
        (Ok(year), Some(month), Ok(day))
            if time::Date::from_calendar_date(year, month, day).is_ok() =>
        {
            Ok(Some(value.to_string()))
        }
        _ => Err(bad()),
    }
}

/// Top-level bullets under a summary's "Action items" heading. Nested bullets, "None noted"
/// and Markdown checkboxes are dropped; owners and dates are never inferred from the text.
pub fn summary_bullets(markdown: &str) -> Vec<String> {
    let mut level = None;
    let mut items = Vec::new();
    for raw in markdown.lines() {
        let hashes = raw.chars().take_while(|c| *c == '#').count();
        let heading = (1..=6).contains(&hashes) && raw[hashes..].starts_with(' ');
        match level {
            None => {
                if heading && raw[hashes..].trim().eq_ignore_ascii_case("action items") {
                    level = Some(hashes);
                }
            }
            Some(found) if heading && hashes <= found => break,
            Some(_) => {
                let Some(rest) = ["- ", "* ", "+ "]
                    .iter()
                    .find_map(|marker| raw.strip_prefix(marker))
                    .or_else(|| {
                        let digits = raw.chars().take_while(char::is_ascii_digit).count();
                        (digits > 0)
                            .then(|| raw[digits..].strip_prefix(". "))
                            .flatten()
                    })
                else {
                    continue;
                };
                let rest = ["[ ] ", "[x] ", "[X] "]
                    .iter()
                    .find_map(|box_| rest.strip_prefix(box_))
                    .unwrap_or(rest)
                    .trim();
                let lower = rest.trim_end_matches('.').to_ascii_lowercase();
                if !rest.is_empty() && lower != "none noted" && lower != "none" {
                    items.push(rest.to_string());
                }
            }
        }
    }
    items
}

impl Core {
    pub fn action_items(&self, meeting_id: &str) -> Result<Vec<ActionItem>> {
        let mut query = self.db.prepare(
            "SELECT id,text,owner,due_date,done,source,summary_id FROM action_items WHERE meeting_id=?1 ORDER BY id",
        )?;
        let items = query
            .query_map([meeting_id], |row| {
                Ok(ActionItem {
                    id: row.get(0)?,
                    text: row.get(1)?,
                    owner: row.get(2)?,
                    due_date: row.get(3)?,
                    done: row.get(4)?,
                    source: row.get(5)?,
                    summary_id: row.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(items)
    }

    /// Creates a manual task when `id` is None, otherwise edits that task of this meeting.
    pub fn save_action_item(
        &mut self,
        meeting_id: &str,
        id: Option<i64>,
        text: &str,
        owner: Option<&str>,
        due: Option<&str>,
        done: bool,
    ) -> Result<Vec<ActionItem>> {
        let text = line(text, MAX_TEXT, "task")?;
        if text.is_empty() {
            return Err(invalid("Describe the task."));
        }
        let owner =
            Some(line(owner.unwrap_or(""), MAX_OWNER, "owner")?).filter(|owner| !owner.is_empty());
        let due = due_date(due)?;
        let changed = match id {
            Some(id) => self.db.execute(
                "UPDATE action_items SET text=?3,owner=?4,due_date=?5,done=?6 WHERE id=?1 AND meeting_id=?2",
                params![id, meeting_id, text, owner, due, done],
            )?,
            None => {
                self.get_meeting_title(meeting_id)?;
                if self.action_items(meeting_id)?.len() >= MAX_ITEMS {
                    return Err(invalid(&format!("A meeting can have at most {MAX_ITEMS} tasks.")));
                }
                self.db.execute(
                    "INSERT INTO action_items(meeting_id,text,owner,due_date,done,source) VALUES (?1,?2,?3,?4,?5,'manual')",
                    params![meeting_id, text, owner, due, done],
                )?
            }
        };
        if changed != 1 {
            return Err(missing());
        }
        self.action_items(meeting_id)
    }

    pub fn delete_action_item(&mut self, meeting_id: &str, id: i64) -> Result<Vec<ActionItem>> {
        if self.db.execute(
            "DELETE FROM action_items WHERE id=?1 AND meeting_id=?2",
            params![id, meeting_id],
        )? != 1
        {
            return Err(missing());
        }
        self.action_items(meeting_id)
    }

    /// Adds the shown summary version's action items that were not imported from it before,
    /// even if those tasks were edited since. Refuses rather than truncating at the task limit.
    pub fn import_action_items(
        &mut self,
        meeting_id: &str,
        summary_id: i64,
    ) -> Result<Vec<ActionItem>> {
        let markdown: String = self
            .db
            .query_row(
                "SELECT markdown FROM summaries WHERE id=?1 AND meeting_id=?2",
                params![summary_id, meeting_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::new("not_found", "This summary version is not available."))?;
        let mut seen: std::collections::HashSet<String> = self
            .db
            .prepare("SELECT origin_text FROM action_items WHERE meeting_id=?1 AND summary_id=?2 AND origin_text IS NOT NULL")?
            .query_map(params![meeting_id, summary_id], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let bullets = summary_bullets(&markdown)
            .into_iter()
            .map(|bullet| line(&bullet, MAX_TEXT, "task"))
            .collect::<Result<Vec<_>>>()
            .map_err(|_| {
                invalid(&format!(
                    "An action item in this summary is longer than {MAX_TEXT} characters. Nothing was added; add it manually instead."
                ))
            })?;
        let fresh: Vec<String> = bullets
            .into_iter()
            .filter(|bullet| seen.insert(bullet.clone()))
            .collect();
        if fresh.is_empty() {
            return Err(invalid(
                "No new action items were found in this summary's Action items section.",
            ));
        }
        if self.action_items(meeting_id)?.len() + fresh.len() > MAX_ITEMS {
            return Err(invalid(&format!(
                "Importing would exceed {MAX_ITEMS} tasks for this meeting. Nothing was added."
            )));
        }
        let tx = self.db.transaction()?;
        for text in &fresh {
            tx.execute(
                "INSERT INTO action_items(meeting_id,text,source,summary_id,origin_text) VALUES (?1,?2,'summary',?3,?2)",
                params![meeting_id, text, summary_id],
            )?;
        }
        tx.commit()?;
        self.action_items(meeting_id)
    }

    fn get_meeting_title(&self, meeting_id: &str) -> Result<String> {
        self.db
            .query_row(
                "SELECT title FROM meetings WHERE id=?1",
                [meeting_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::new("not_found", "Meeting not found."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn summary_bullets_keep_only_top_level_action_items() {
        let markdown = "## Summary\n- Not a task\n## Action items\n- [ ] Send the deck\n  - nested detail\n* [x] Book a room.\n2. Email Sam\nPlain text\n- None noted.\n### Later\n- Sub-heading task\n## Decisions\n- Not a task either";
        assert_eq!(
            summary_bullets(markdown),
            [
                "Send the deck",
                "Book a room.",
                "Email Sam",
                "Sub-heading task"
            ]
        );
        assert!(summary_bullets("## Summary\n- Only this").is_empty());
        assert!(summary_bullets("## Action items\nNone noted").is_empty());
    }

    #[test]
    fn tasks_validate_import_once_and_follow_their_meeting() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_note("Fictional task meeting").unwrap();
        let other = core.create_note("Other fictional meeting").unwrap();
        core.save_summary(
            &id,
            "p",
            "m",
            "## Action items\n- Send the deck\n- Book a room",
            "general-v1",
        )
        .unwrap();
        core.save_summary(
            &other,
            "p",
            "m",
            "## Action items\n- Elsewhere",
            "general-v1",
        )
        .unwrap();
        let summary = core.list_summaries(&id).unwrap()[0].id;
        let foreign = core.list_summaries(&other).unwrap()[0].id;
        assert_eq!(
            core.import_action_items(&id, foreign).unwrap_err().code,
            "not_found"
        );
        let items = core.import_action_items(&id, summary).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(
            (
                items[0].owner.as_deref(),
                items[0].due_date.as_deref(),
                items[0].source.as_str()
            ),
            (None, None, "summary")
        );
        let items = core
            .save_action_item(
                &id,
                Some(items[0].id),
                "Send the final deck",
                Some("Alex"),
                Some("2026-10-31"),
                true,
            )
            .unwrap();
        assert_eq!(
            core.import_action_items(&id, summary).unwrap_err().code,
            "action_item"
        );
        assert_eq!(items[0].text, "Send the final deck");
        let items = core
            .save_action_item(
                &id,
                Some(items[0].id),
                "Send the final deck",
                Some("  "),
                Some(""),
                false,
            )
            .unwrap();
        assert_eq!(
            (items[0].owner.as_deref(), items[0].due_date.as_deref()),
            (None, None)
        );
        for (text, owner, due) in [
            ("", None, None),
            ("Two\nlines", None, None),
            ("Task", Some("Owner\tname"), None),
            ("Task", None, Some("2026-02-30")),
            ("Task", None, Some("31/10/2026")),
            (&"x".repeat(501) as &str, None, None),
        ] {
            assert_eq!(
                core.save_action_item(&id, None, text, owner, due, false)
                    .unwrap_err()
                    .code,
                "action_item",
                "{text:?} {owner:?} {due:?}"
            );
        }
        let items = core
            .save_action_item(&id, None, "Manual task", None, Some("2028-02-29"), false)
            .unwrap();
        assert_eq!(items[2].source, "manual");
        assert_eq!(
            core.delete_action_item(&other, items[2].id)
                .unwrap_err()
                .code,
            "not_found"
        );
        assert_eq!(core.delete_action_item(&id, items[2].id).unwrap().len(), 2);
        assert_eq!(core.get_meeting(&id).unwrap().action_items.len(), 2);
        core.delete_meeting(&id).unwrap();
        let left: i64 = core
            .db
            .query_row("SELECT COUNT(*) FROM action_items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn upgrade_from_populated_v15_keeps_summaries_and_imports_from_them() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        {
            let db = crate::storage::test_v11_database(&path);
            for script in [
                include_str!("../migrations/012_saved_connections.sql"),
                include_str!("../migrations/013_session_processing.sql"),
                include_str!("../migrations/014_processing_workflow.sql"),
                include_str!("../migrations/015_summary_templates.sql"),
            ] {
                db.execute_batch(script).unwrap();
            }
            db.execute_batch("INSERT INTO meetings(id,title,started_at,source,status) VALUES ('existing','Fictional upgrade','test','fixture','stopped');
                INSERT INTO notes(meeting_id,user_markdown,revision) VALUES ('existing','Preserve the original notes',7);
                INSERT INTO summaries(id,meeting_id,template_hash,model,provider,markdown) VALUES (5,'existing','general-v1','hand-written','fixture','## Action items\n- Kept task');").unwrap();
        }
        for _ in 0..2 {
            let core = Core::open(&path).unwrap();
            let detail = core.get_meeting("existing").unwrap();
            assert_eq!(detail.user_markdown, "Preserve the original notes");
            assert_eq!(
                detail.summary.as_deref(),
                Some("## Action items\n- Kept task")
            );
            assert!(detail.action_items.is_empty());
        }
        let mut core = Core::open(&path).unwrap();
        assert_eq!(
            core.import_action_items("existing", 5).unwrap()[0].text,
            "Kept task"
        );
        let violations: i64 = core
            .db
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(violations, 0);
    }

    #[test]
    fn imports_refuse_instead_of_exceeding_the_task_limit() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_note("Fictional busy meeting").unwrap();
        for index in 0..MAX_ITEMS - 1 {
            core.save_action_item(&id, None, &format!("Task {index}"), None, None, false)
                .unwrap();
        }
        core.save_summary(&id, "p", "m", "## Action items\n- One\n- Two", "general-v1")
            .unwrap();
        let summary = core.list_summaries(&id).unwrap()[0].id;
        assert_eq!(
            core.import_action_items(&id, summary).unwrap_err().code,
            "action_item"
        );
        assert_eq!(core.action_items(&id).unwrap().len(), MAX_ITEMS - 1);
        let long = format!("## Action items\n- Short\n- {}", "x".repeat(MAX_TEXT + 1));
        let other = core.create_note("Fictional long item").unwrap();
        core.save_summary(&other, "p", "m", &long, "general-v1")
            .unwrap();
        let summary = core.list_summaries(&other).unwrap()[0].id;
        assert!(core
            .import_action_items(&other, summary)
            .unwrap_err()
            .message
            .contains("Nothing was added"));
        assert!(core.action_items(&other).unwrap().is_empty());
    }
}
