//! Saved question threads: answered questions are kept and follow-ups append to a thread.
use crate::{
    domain::{AppError, QuestionThread, QuestionTurn, Result},
    storage::Core,
};
use rusqlite::{params, OptionalExtension};

fn missing() -> AppError {
    AppError::new("not_found", "This question thread no longer exists.")
}

impl Core {
    /// Newest thread first, each thread's turns oldest first.
    pub fn question_threads(&self, meeting_id: &str) -> Result<Vec<QuestionThread>> {
        let mut query = self.db.prepare(
            "SELECT t.id,u.id,u.question,u.answer,u.provider,u.model FROM question_threads t \
             LEFT JOIN question_turns u ON u.thread_id=t.id WHERE t.meeting_id=?1 ORDER BY t.id DESC,u.id",
        )?;
        let rows = query.query_map([meeting_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<i64>>(1)?
                    .map(|id| {
                        Ok::<_, rusqlite::Error>(QuestionTurn {
                            id,
                            question: row.get(2)?,
                            answer: row.get(3)?,
                            provider: row.get(4)?,
                            model: row.get(5)?,
                        })
                    })
                    .transpose()?,
            ))
        })?;
        let mut threads: Vec<QuestionThread> = Vec::new();
        for row in rows {
            let (id, turn) = row?;
            if threads.last().map(|thread| thread.id) != Some(id) {
                threads.push(QuestionThread {
                    id,
                    turns: Vec::new(),
                });
            }
            if let (Some(turn), Some(thread)) = (turn, threads.last_mut()) {
                thread.turns.push(turn);
            }
        }
        Ok(threads)
    }

    /// Stores one answered question: a new thread when `thread_id` is None, otherwise appended to
    /// that thread of this meeting. Returns the saved thread.
    pub fn save_question_turn(
        &mut self,
        meeting_id: &str,
        thread_id: Option<i64>,
        question: &str,
        answer: &str,
        provider: &str,
        model: &str,
    ) -> Result<QuestionThread> {
        let tx = self.db.transaction()?;
        let thread_id = match thread_id {
            Some(id) => tx
                .query_row(
                    "SELECT id FROM question_threads WHERE id=?1 AND meeting_id=?2",
                    params![id, meeting_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(missing)?,
            None => {
                tx.execute(
                    "INSERT INTO question_threads(meeting_id) VALUES (?1)",
                    [meeting_id],
                )?;
                tx.last_insert_rowid()
            }
        };
        tx.execute(
            "INSERT INTO question_turns(thread_id,question,answer,provider,model) VALUES (?1,?2,?3,?4,?5)",
            params![thread_id, question, answer, provider, model],
        )?;
        tx.commit()?;
        self.question_threads(meeting_id)?
            .into_iter()
            .find(|thread| thread.id == thread_id)
            .ok_or_else(missing)
    }

    /// Explicit user action: removes the thread and its turns; returns the remaining threads.
    pub fn delete_question_thread(
        &mut self,
        meeting_id: &str,
        thread_id: i64,
    ) -> Result<Vec<QuestionThread>> {
        if self.db.execute(
            "DELETE FROM question_threads WHERE id=?1 AND meeting_id=?2",
            params![thread_id, meeting_id],
        )? == 0
        {
            return Err(missing());
        }
        self.question_threads(meeting_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn count(core: &Core, table: &str) -> i64 {
        core.db
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    #[test]
    fn turns_create_and_append_threads_newest_first_and_stay_in_their_meeting() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let (a, b) = (
            core.create_note("Fictional A").unwrap(),
            core.create_note("Fictional B").unwrap(),
        );
        assert!(core.get_meeting(&a).unwrap().question_threads.is_empty());
        let first = core
            .save_question_turn(&a, None, "Budget?", "40k", "p", "m")
            .unwrap();
        let second = core
            .save_question_turn(&a, None, "Owner?", "Rahul", "p", "m")
            .unwrap();
        let appended = core
            .save_question_turn(&a, Some(first.id), "Why?", "Cost", "p", "m2")
            .unwrap();
        assert_eq!(appended.id, first.id);
        let questions: Vec<_> = appended.turns.iter().map(|t| t.question.as_str()).collect();
        assert_eq!(questions, ["Budget?", "Why?"]);
        assert_eq!(appended.turns[1].model, "m2");
        let threads = core.get_meeting(&a).unwrap().question_threads;
        assert_eq!(
            threads.iter().map(|t| t.id).collect::<Vec<_>>(),
            [second.id, first.id]
        );
        // A thread of another meeting is refused and nothing is stored.
        let before = count(&core, "question_turns");
        for target in [first.id, 9999] {
            assert_eq!(
                core.save_question_turn(&b, Some(target), "Q", "A", "p", "m")
                    .unwrap_err()
                    .code,
                "not_found"
            );
        }
        assert_eq!(count(&core, "question_turns"), before);
        assert!(core.get_meeting(&b).unwrap().question_threads.is_empty());
    }

    #[test]
    fn threads_cascade_on_thread_and_meeting_delete() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let (a, b) = (
            core.create_note("Fictional A").unwrap(),
            core.create_note("Fictional B").unwrap(),
        );
        let first = core
            .save_question_turn(&a, None, "Q1", "A1", "p", "m")
            .unwrap();
        core.save_question_turn(&a, Some(first.id), "Q2", "A2", "p", "m")
            .unwrap();
        let kept = core
            .save_question_turn(&a, None, "Q3", "A3", "p", "m")
            .unwrap();
        core.save_question_turn(&b, None, "Q4", "A4", "p", "m")
            .unwrap();
        assert_eq!(
            core.delete_question_thread(&b, first.id).unwrap_err().code,
            "not_found"
        );
        assert_eq!(count(&core, "question_turns"), 4);
        assert_eq!(
            core.delete_question_thread(&a, first.id).unwrap(),
            std::slice::from_ref(&kept)
        );
        assert_eq!(count(&core, "question_turns"), 2);
        core.delete_meeting(&a).unwrap();
        assert_eq!(
            (
                count(&core, "question_threads"),
                count(&core, "question_turns")
            ),
            (1, 1)
        );
    }

    #[test]
    fn upgrade_from_populated_v21_keeps_data_and_starts_with_no_threads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        {
            let db = crate::storage::test_v11_database(&path);
            for script in [
                include_str!("../migrations/012_saved_connections.sql"),
                include_str!("../migrations/013_session_processing.sql"),
                include_str!("../migrations/014_processing_workflow.sql"),
                include_str!("../migrations/015_summary_templates.sql"),
                include_str!("../migrations/016_action_items.sql"),
                include_str!("../migrations/017_summary_edits.sql"),
                include_str!("../migrations/018_speaker_names.sql"),
                include_str!("../migrations/019_transcript_edits.sql"),
                include_str!("../migrations/020_summary_freshness.sql"),
                include_str!("../migrations/021_meeting_tags.sql"),
            ] {
                db.execute_batch(script).unwrap();
            }
            db.execute_batch("INSERT INTO meetings(id,title,started_at,source,status) VALUES ('existing','Fictional upgrade','test','desktop','stopped');
                INSERT INTO notes(meeting_id,user_markdown,revision) VALUES ('existing','Preserve the original notes',7);
                INSERT INTO segments(id,meeting_id,speaker,start_ms,end_ms,text,source,pass) VALUES (42,'existing','You',0,1000,'Persimmon original','whisper','final');
                INSERT INTO meeting_transcriptions(meeting_id,provider,model) VALUES ('existing','whisper','small');
                INSERT INTO summaries(id,meeting_id,template_hash,model,provider,markdown) VALUES (5,'existing','general-v1','m','p','Kept summary');
                INSERT INTO action_items(meeting_id,text,source,summary_id,origin_text) VALUES ('existing','Kept task','summary',5,'Kept task');
                INSERT INTO meeting_tags(meeting_id,tag) VALUES ('existing','Client');").unwrap();
        }
        for _ in 0..2 {
            let core = Core::open(&path).unwrap();
            let detail = core.get_meeting("existing").unwrap();
            assert_eq!(detail.segments[0].text, "Persimmon original");
            assert_eq!(detail.user_markdown, "Preserve the original notes");
            assert_eq!(detail.summary.as_deref(), Some("Kept summary"));
            assert_eq!(detail.action_items[0].text, "Kept task");
            assert_eq!(detail.meeting.tags, ["Client"]);
            assert!(detail.question_threads.is_empty());
            assert_eq!(
                core.search_meetings("Persimmon").unwrap()[0].meeting_id,
                "existing"
            );
            let violations: i64 = core
                .db
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(violations, 0);
        }
        let mut core = Core::open(&path).unwrap();
        let thread = core
            .save_question_turn("existing", None, "Budget?", "Unknown", "p", "m")
            .unwrap();
        assert_eq!(
            core.get_meeting("existing").unwrap().question_threads,
            [thread]
        );
        // v24 on the upgraded database: a saved library answer goes with its meeting.
        assert!(core.settings().unwrap().recipes.is_empty());
        core.save_library_answer(&["existing".into()], "Q", "A", "p", "m")
            .unwrap();
        core.delete_meeting("existing").unwrap();
        assert!(core.library_answers().unwrap().is_empty());
        let violations: i64 = core
            .db
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(violations, 0);
    }
}
