//! Saved answers to questions over several meetings. Deleting any source meeting deletes the
//! answers made from it (schema trigger), so no derived text outlives its meeting.
use crate::{
    domain::{AppError, LibraryAnswer, Result},
    storage::Core,
};
use rusqlite::params;

impl Core {
    /// Newest first, each with its meeting ids in the order sent.
    pub fn library_answers(&self) -> Result<Vec<LibraryAnswer>> {
        let mut query = self.db.prepare(
            "SELECT a.id,a.question,a.answer,a.provider,a.model,a.created_at,m.meeting_id \
             FROM library_answers a JOIN library_answer_meetings m ON m.answer_id=a.id \
             ORDER BY a.id DESC,m.position",
        )?;
        let rows = query.query_map([], |row| {
            Ok((
                LibraryAnswer {
                    id: row.get(0)?,
                    question: row.get(1)?,
                    answer: row.get(2)?,
                    provider: row.get(3)?,
                    model: row.get(4)?,
                    created_at: row.get(5)?,
                    meeting_ids: Vec::new(),
                },
                row.get::<_, String>(6)?,
            ))
        })?;
        let mut answers: Vec<LibraryAnswer> = Vec::new();
        for row in rows {
            let (answer, meeting_id) = row?;
            if answers.last().map(|last| last.id) != Some(answer.id) {
                answers.push(answer);
            }
            if let Some(last) = answers.last_mut() {
                last.meeting_ids.push(meeting_id);
            }
        }
        Ok(answers)
    }

    /// Stores one answer with its scope; returns the saved answer.
    pub fn save_library_answer(
        &mut self,
        meeting_ids: &[String],
        question: &str,
        answer: &str,
        provider: &str,
        model: &str,
    ) -> Result<LibraryAnswer> {
        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT INTO library_answers(question,answer,provider,model) VALUES (?1,?2,?3,?4)",
            params![question, answer, provider, model],
        )?;
        let id = tx.last_insert_rowid();
        for (position, meeting_id) in meeting_ids.iter().enumerate() {
            tx.execute(
                "INSERT INTO library_answer_meetings(answer_id,position,meeting_id) VALUES (?1,?2,?3)",
                params![id, position as i64, meeting_id],
            )?;
        }
        tx.commit()?;
        self.library_answers()?
            .into_iter()
            .find(|saved| saved.id == id)
            .ok_or_else(missing)
    }

    /// Explicit user action; returns the remaining answers.
    pub fn delete_library_answer(&mut self, id: i64) -> Result<Vec<LibraryAnswer>> {
        if self
            .db
            .execute("DELETE FROM library_answers WHERE id=?1", [id])?
            == 0
        {
            return Err(missing());
        }
        self.library_answers()
    }
}

fn missing() -> AppError {
    AppError::new("not_found", "This saved answer no longer exists.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn answers_keep_scope_order_and_go_with_any_source_meeting() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let (a, b, c) = (
            core.create_note("Fictional A").unwrap(),
            core.create_note("Fictional B").unwrap(),
            core.create_note("Fictional C").unwrap(),
        );
        let first = core
            .save_library_answer(&[b.clone(), a.clone()], "Q1", "A1 [M1]", "p", "m")
            .unwrap();
        assert_eq!(first.meeting_ids, [b.clone(), a.clone()]);
        let second = core
            .save_library_answer(std::slice::from_ref(&c), "Q2", "A2", "p", "m")
            .unwrap();
        assert_eq!(core.library_answers().unwrap(), [second.clone(), first]);
        // A meeting that does not exist is refused and nothing is stored.
        assert!(core
            .save_library_answer(&["missing".into()], "Q", "A", "p", "m")
            .is_err());
        assert_eq!(core.library_answers().unwrap().len(), 2);
        // Deleting one source meeting removes the whole answer, not only that link.
        core.delete_meeting(&a).unwrap();
        assert_eq!(
            core.library_answers().unwrap(),
            std::slice::from_ref(&second)
        );
        let links: i64 = core
            .db
            .query_row("SELECT COUNT(*) FROM library_answer_meetings", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(links, 1);
        assert!(core.delete_library_answer(second.id).unwrap().is_empty());
        assert_eq!(
            core.delete_library_answer(second.id).unwrap_err().code,
            "not_found"
        );
    }
}
