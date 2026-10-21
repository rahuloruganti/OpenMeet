//! User corrections to final transcript segments and read-only copies of replaced transcripts.
use crate::{
    domain::{AppError, Result, Segment, TranscriptVersion},
    storage::Core,
};
use rusqlite::{params, OptionalExtension, Transaction};

const MAX_SEGMENT_BYTES: usize = 20_000;

/// Copies the replaceable transcript, edits included, before a new transcription replaces it.
/// Runs inside the replacing transaction so a failed replacement keeps no stray copy.
pub(crate) fn snapshot(tx: &Transaction<'_>, id: &str) -> Result<()> {
    let mut query = tx.prepare(
        "SELECT speaker, start_ms, end_ms, text, original_text IS NOT NULL FROM segments
         WHERE meeting_id = ?1 AND source IN ('whisper', 'cloud_stt') ORDER BY start_ms IS NULL, start_ms, id",
    )?;
    let rows = query
        .query_map([id], |row| {
            Ok((crate::storage::segment_row(row)?, row.get::<_, bool>(4)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.is_empty() {
        return Ok(());
    }
    let edited = rows.iter().any(|(_, edited)| *edited);
    let segments: Vec<Segment> = rows.into_iter().map(|(segment, _)| segment).collect();
    let (provider, model): (Option<String>, Option<String>) = tx
        .query_row(
            "SELECT provider, model FROM meeting_transcriptions WHERE meeting_id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .unwrap_or((None, None));
    let json = serde_json::to_string(&segments)
        .map_err(|_| AppError::new("internal", "The transcript could not be copied."))?;
    tx.execute(
        "INSERT INTO transcript_versions(meeting_id, provider, model, edited, segment_count, segments_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, provider, model, edited, segments.len() as i64, json],
    )?;
    Ok(())
}

impl Core {
    /// Replaces one segment's text, keeping the engine's text for revert. Saving the original
    /// text again clears the edit. `base_text` is the text the user started from: SQLite can
    /// reuse a replaced segment's id, so a mismatch means the edit targets a changed segment.
    pub fn edit_segment(
        &mut self,
        meeting_id: &str,
        segment_id: i64,
        base_text: &str,
        text: &str,
    ) -> Result<()> {
        let text = text.trim();
        if text.is_empty() || text.len() > MAX_SEGMENT_BYTES || text.chars().any(char::is_control) {
            return Err(AppError::new(
                "segment_edit",
                "Enter segment text on one line, at most 20,000 bytes.",
            ));
        }
        let changed = self.db.execute(
            "UPDATE segments SET
                original_text = CASE WHEN coalesce(original_text, text) = ?3 THEN NULL ELSE coalesce(original_text, text) END,
                text = ?3
             WHERE id = ?1 AND meeting_id = ?2 AND text = ?4",
            params![segment_id, meeting_id, text, base_text],
        )?;
        if changed != 1 {
            return Err(AppError::new(
                "segment_conflict",
                "This transcript segment changed or no longer exists, possibly after re-transcription. Your edit is still open; copy it before discarding.",
            ));
        }
        Ok(())
    }

    pub fn transcript_versions(&self, meeting_id: &str) -> Result<Vec<TranscriptVersion>> {
        let mut query = self.db.prepare(
            "SELECT id, provider, model, edited, segment_count FROM transcript_versions WHERE meeting_id = ?1 ORDER BY id DESC",
        )?;
        let versions = query
            .query_map([meeting_id], |row| {
                Ok(TranscriptVersion {
                    id: row.get(0)?,
                    provider: row.get(1)?,
                    model: row.get(2)?,
                    edited: row.get(3)?,
                    segment_count: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(versions)
    }

    pub fn transcript_version(&self, meeting_id: &str, version_id: i64) -> Result<Vec<Segment>> {
        let json: String = self
            .db
            .query_row(
                "SELECT segments_json FROM transcript_versions WHERE id = ?1 AND meeting_id = ?2",
                params![version_id, meeting_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| {
                AppError::new("not_found", "This transcript version is not available.")
            })?;
        serde_json::from_str(&json)
            .map_err(|_| AppError::new("internal", "This transcript version could not be read."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::SegmentTiming;
    use std::path::Path;

    fn line(text: &str, start_ms: i64) -> Segment {
        Segment {
            speaker: "You".into(),
            timing: SegmentTiming::Timed {
                start_ms,
                end_ms: start_ms + 100,
            },
            text: text.into(),
        }
    }

    #[test]
    fn edits_keep_originals_update_search_and_revert() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_note("Fictional transcript edits").unwrap();
        let other = core.create_note("Other fictional meeting").unwrap();
        core.replace_transcript(
            &id,
            &[line("Persimon budget", 0), line("Second", 500)],
            "whisper",
            "small",
        )
        .unwrap();
        let detail = core.get_meeting(&id).unwrap();
        assert_eq!(detail.segment_meta.len(), detail.segments.len());
        let first = detail.segment_meta[0].id;
        assert_eq!(detail.segment_meta[0].original_text, None);
        for bad in [
            "",
            "   ",
            "Two\nlines",
            &"x".repeat(MAX_SEGMENT_BYTES + 1) as &str,
        ] {
            assert_eq!(
                core.edit_segment(&id, first, "Persimon budget", bad)
                    .unwrap_err()
                    .code,
                "segment_edit"
            );
        }
        assert_eq!(
            core.edit_segment(&other, first, "Persimon budget", "Moved")
                .unwrap_err()
                .code,
            "segment_conflict"
        );
        assert_eq!(
            core.edit_segment(&id, first, "Not the current text", "Persimmon budget")
                .unwrap_err()
                .code,
            "segment_conflict"
        );
        core.edit_segment(&id, first, "Persimon budget", "Persimmon budget")
            .unwrap();
        let detail = core.get_meeting(&id).unwrap();
        assert_eq!(detail.segments[0].text, "Persimmon budget");
        assert_eq!(
            detail.segment_meta[0].original_text.as_deref(),
            Some("Persimon budget")
        );
        assert_eq!(detail.segment_meta[0].id, first);
        assert_eq!(core.search_meetings("Persimmon").unwrap()[0].meeting_id, id);
        core.edit_segment(&id, first, "Persimmon budget", "Persimmon budget, final")
            .unwrap();
        assert_eq!(
            core.get_meeting(&id).unwrap().segment_meta[0]
                .original_text
                .as_deref(),
            Some("Persimon budget")
        );
        core.edit_segment(&id, first, "Persimmon budget, final", "Persimon budget")
            .unwrap();
        let reverted = core.get_meeting(&id).unwrap();
        assert_eq!(reverted.segment_meta[0].original_text, None);
        assert_eq!(reverted.segments[0].text, "Persimon budget");
    }

    #[test]
    fn summaries_go_stale_on_transcript_or_name_changes_and_fresh_on_revert() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_note("Fictional freshness").unwrap();
        core.replace_transcript(&id, &[line("Budget is 40k", 0)], "whisper", "small")
            .unwrap();
        core.save_summary(&id, "p", "m", "## Summary\n40k", "general-v1")
            .unwrap();
        assert!(!core.get_meeting(&id).unwrap().summary_stale);
        let segment = core.get_meeting(&id).unwrap().segment_meta[0].id;
        core.edit_segment(&id, segment, "Budget is 40k", "Budget is 45k")
            .unwrap();
        let detail = core.get_meeting(&id).unwrap();
        assert!(detail.summary_stale);
        assert!(core.list_summaries(&id).unwrap()[0].stale);
        // An edit of a stale summary stays stale until it is regenerated.
        let base = core.list_summaries(&id).unwrap()[0].id;
        core.save_summary_edit(&id, base, base, "## Summary\nEdited")
            .unwrap();
        assert!(core.get_meeting(&id).unwrap().summary_stale);
        core.edit_segment(&id, segment, "Budget is 45k", "Budget is 40k")
            .unwrap();
        assert!(!core.get_meeting(&id).unwrap().summary_stale);
        core.save_speaker_names(&id, Some("Rahul"), None).unwrap();
        assert!(core.get_meeting(&id).unwrap().summary_stale);
        core.save_summary(&id, "p", "m", "## Summary\nRahul: 40k", "general-v1")
            .unwrap();
        let versions = core.list_summaries(&id).unwrap();
        assert!(!versions[0].stale && versions[1].stale);
        // Older summaries without a recorded hash are never flagged.
        core.db
            .execute("UPDATE summaries SET transcript_hash=NULL", [])
            .unwrap();
        core.save_speaker_names(&id, None, None).unwrap();
        assert!(!core.get_meeting(&id).unwrap().summary_stale);
    }

    #[test]
    fn upgrade_from_populated_v17_keeps_transcripts_summaries_tasks_and_search() {
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
            ] {
                db.execute_batch(script).unwrap();
            }
            db.execute_batch("INSERT INTO meetings(id,title,started_at,source,status) VALUES ('existing','Fictional upgrade','test','desktop','stopped');
                INSERT INTO notes(meeting_id,user_markdown,revision) VALUES ('existing','Preserve the original notes',7);
                INSERT INTO segments(id,meeting_id,speaker,start_ms,end_ms,text,source,pass) VALUES (42,'existing','You',0,1000,'Persimmon original','whisper','final');
                INSERT INTO meeting_transcriptions(meeting_id,provider,model) VALUES ('existing','whisper','small');
                INSERT INTO summaries(id,meeting_id,template_hash,model,provider,markdown) VALUES (5,'existing','general-v1','m','p','Kept summary');
                INSERT INTO action_items(meeting_id,text,source,summary_id,origin_text) VALUES ('existing','Kept task','summary',5,'Kept task');").unwrap();
        }
        for _ in 0..2 {
            let core = Core::open(&path).unwrap();
            let detail = core.get_meeting("existing").unwrap();
            assert_eq!(detail.segments[0].text, "Persimmon original");
            assert_eq!(
                detail.segment_meta,
                [crate::domain::SegmentMeta {
                    id: 42,
                    original_text: None
                }]
            );
            assert!(detail.transcript_versions.is_empty() && !detail.summary_stale);
            assert_eq!(detail.speaker_names, crate::domain::SpeakerNames::default());
            assert_eq!(detail.action_items[0].summary_id, Some(5));
            assert_eq!(detail.summary.as_deref(), Some("Kept summary"));
            let violations: i64 = core
                .db
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(violations, 0);
        }
        let mut core = Core::open(&path).unwrap();
        core.edit_segment("existing", 42, "Persimmon original", "Quince corrected")
            .unwrap();
        assert_eq!(
            core.search_meetings("Quince").unwrap()[0].meeting_id,
            "existing"
        );
        assert!(core.search_meetings("Persimmon").unwrap().is_empty());
        core.replace_transcript("existing", &[line("Fresh", 0)], "whisper", "base")
            .unwrap();
        assert_eq!(
            core.transcript_version(
                "existing",
                core.transcript_versions("existing").unwrap()[0].id
            )
            .unwrap()[0]
                .text,
            "Quince corrected"
        );
    }

    #[test]
    fn replacing_keeps_the_edited_transcript_as_a_read_only_version() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_note("Fictional re-transcription").unwrap();
        core.replace_transcript(&id, &[line("First pass", 0)], "whisper", "small")
            .unwrap();
        assert!(core.transcript_versions(&id).unwrap().is_empty());
        let segment = core.get_meeting(&id).unwrap().segment_meta[0].id;
        core.edit_segment(&id, segment, "First pass", "First pass, corrected")
            .unwrap();
        core.replace_transcript(
            &id,
            &[line("Second pass", 0)],
            "https://speech.example/v1",
            "m",
        )
        .unwrap();
        let versions = core.transcript_versions(&id).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(
            (
                versions[0].provider.as_deref(),
                versions[0].model.as_deref(),
                versions[0].edited,
                versions[0].segment_count
            ),
            (Some("whisper"), Some("small"), true, 1)
        );
        assert_eq!(
            core.transcript_version(&id, versions[0].id).unwrap(),
            [line("First pass, corrected", 0)]
        );
        assert_eq!(
            core.edit_segment(&id, segment, "First pass, corrected", "Stale")
                .unwrap_err()
                .code,
            "segment_conflict"
        );
        assert_eq!(core.get_meeting(&id).unwrap().transcript_versions, versions);
        let other = core.create_note("Other fictional meeting").unwrap();
        assert_eq!(
            core.transcript_version(&other, versions[0].id)
                .unwrap_err()
                .code,
            "not_found"
        );
        core.delete_meeting(&id).unwrap();
        let left: i64 = core
            .db
            .query_row("SELECT COUNT(*) FROM transcript_versions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(left, 0);
    }
}
