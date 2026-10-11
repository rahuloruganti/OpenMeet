use crate::{audio, domain::*};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub struct Core {
    pub(crate) db: Connection,
    recording: RecordingState,
    audio_root: PathBuf,
    audio: Option<audio::Session>,
    capture_report: Option<audio::Report>,
}

impl Core {
    pub fn open(path: &Path) -> Result<Self> {
        let mut db = Connection::open(path)?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.pragma_update(None, "foreign_keys", "ON")?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
        match version {
            0 => {
                let transaction = db.transaction()?;
                transaction.execute_batch(include_str!("../migrations/001_foundation.sql"))?;
                transaction.commit()?;
            }
            1..=5 => {}
            _ => {
                return Err(AppError::new(
                    "schema_version",
                    "This database needs a newer OpenMeet version.",
                ))
            }
        }
        if version < 2 {
            db.pragma_update(None, "foreign_keys", "OFF")?;
            let tx = db.transaction()?;
            tx.execute_batch(include_str!("../migrations/002_capture.sql"))?;
            let violations: i64 =
                tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get(0)
                })?;
            if violations != 0 {
                return Err(AppError::new(
                    "migration",
                    "Capture migration would break existing references.",
                ));
            }
            tx.commit()?;
            db.pragma_update(None, "foreign_keys", "ON")?;
        }
        // Each script sets its own `user_version`, so migration N runs for databases below N.
        let additive = [
            include_str!("../migrations/003_local_model.sql"),
            include_str!("../migrations/004_merge_model.sql"),
            include_str!("../migrations/005_transcripts.sql"),
        ];
        for (number, script) in (3..).zip(additive) {
            if version < number {
                let tx = db.transaction()?;
                tx.execute_batch(script)?;
                tx.commit()?;
            }
        }
        // A restarted process cannot still own a recording from the previous process.
        db.execute(
            "UPDATE meetings SET status = 'interrupted' WHERE status IN ('recording', 'paused')",
            [],
        )?;
        Ok(Self {
            db,
            recording: RecordingState::default(),
            audio_root: path.parent().unwrap_or(Path::new(".")).join("audio"),
            audio: None,
            capture_report: None,
        })
    }

    pub fn recording_state(&self) -> RecordingState {
        self.recording.clone()
    }

    /// Rejects a new session while one is active or unfinished; returns the trimmed title.
    fn begin<'a>(&self, title: &'a str) -> Result<&'a str> {
        if self.audio.is_some()
            || self.capture_report.is_some()
            || matches!(
                self.recording.status,
                CaptureStatus::Recording | CaptureStatus::Paused
            )
        {
            return Err(AppError::new(
                "already_recording",
                "Stop the active recording before starting another.",
            ));
        }
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 160 {
            return Err(AppError::new(
                "invalid_title",
                "Use a meeting title between 1 and 160 characters.",
            ));
        }
        Ok(title)
    }

    pub fn start(&mut self, title: &str) -> Result<RecordingState> {
        let title = self.begin(title)?;
        let id = Uuid::new_v4().to_string();
        let transaction = self.db.transaction()?;
        transaction.execute(
            "INSERT INTO meetings(id, title, started_at, source, status) VALUES (?1, ?2, ?3, 'simulation', 'recording')",
            params![id, title, now()?],
        )?;
        transaction.execute("INSERT INTO notes(meeting_id) VALUES (?1)", [&id])?;
        transaction.commit()?;
        self.recording = RecordingState {
            revision: self.recording.revision + 1,
            status: CaptureStatus::Recording,
            meeting_id: Some(id),
            source: Some("simulation".into()),
            error: None,
        };
        Ok(self.recording_state())
    }

    pub fn start_desktop(
        &mut self,
        title: &str,
        options: audio::CaptureOptions,
        consent: bool,
    ) -> Result<RecordingState> {
        if !consent {
            return Err(AppError::new(
                "consent_required",
                "Confirm participant consent before recording.",
            ));
        }
        let title = self.begin(title)?;
        if options.microphone_id.is_empty() || options.output_id.is_empty() {
            return Err(AppError::new(
                "audio_devices",
                "Select both a microphone and a system-output device.",
            ));
        }
        let id = Uuid::new_v4().to_string();
        std::fs::create_dir_all(&self.audio_root)?;
        let session = audio::Session::prepare(self.audio_root.join(&id), options.clone())?;
        let tx = self.db.transaction()?;
        tx.execute("INSERT INTO meetings(id, title, started_at, source, status) VALUES (?1, ?2, ?3, 'desktop', 'paused')", params![id, title, now()?])?;
        tx.execute("INSERT INTO notes(meeting_id) VALUES (?1)", [&id])?;
        for track in &session.tracks {
            tx.execute("INSERT INTO tracks(meeting_id, kind, path, timing_path, device_name, sample_rate, channels) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", params![id, track.kind, track.path, track.timing_path, track.device_name, track.sample_rate, track.channels])?;
        }
        tx.execute(
            "UPDATE settings SET microphone_id = ?1, output_id = ?2 WHERE id = 1",
            params![options.microphone_id, options.output_id],
        )?;
        tx.commit()?;
        self.audio = Some(session);
        self.recording = RecordingState {
            revision: self.recording.revision + 1,
            status: CaptureStatus::Paused,
            meeting_id: Some(id),
            source: Some("desktop".into()),
            error: None,
        };
        self.resume()
    }

    pub fn audio_health(&self) -> Option<audio::Health> {
        self.audio.as_ref().map(audio::Session::health)
    }

    pub fn poll_audio(&mut self) -> Result<()> {
        if let Some(error) = self.audio_health().and_then(|h| h.error) {
            if self.recording.status == CaptureStatus::Recording {
                self.recording.error = Some(error.clone());
                // The callback/worker already closed the shared gate. Always reflect that, even if SQLite fails.
                self.recording.status = CaptureStatus::Paused;
                self.recording.revision += 1;
                self.db.execute(
                    "UPDATE meetings SET status = 'paused', capture_error = ?1 WHERE id = ?2",
                    params![error, self.recording.meeting_id],
                )?;
            }
        }
        Ok(())
    }

    pub fn pause(&mut self) -> Result<RecordingState> {
        if self.recording.status != CaptureStatus::Recording {
            return Err(AppError::new("invalid_state", "Recording is not active."));
        }
        if let Some(audio) = &self.audio {
            let result = audio.pause();
            self.recording.status = CaptureStatus::Paused;
            self.recording.revision += 1;
            self.db.execute(
                "UPDATE meetings SET status = 'paused' WHERE id = ?1",
                [&self.recording.meeting_id],
            )?;
            result?;
            Ok(self.recording_state())
        } else {
            self.transition(CaptureStatus::Recording, CaptureStatus::Paused, "paused")
        }
    }

    pub fn resume(&mut self) -> Result<RecordingState> {
        if self.recording.status != CaptureStatus::Paused {
            return Err(AppError::new("invalid_state", "Recording is not paused."));
        }
        if let Some(audio) = &self.audio {
            audio.resume()?;
            self.recording.status = CaptureStatus::Recording;
            self.recording.revision += 1;
            let stored = self.db.execute(
                "UPDATE meetings SET status = 'recording' WHERE id = ?1",
                [&self.recording.meeting_id],
            );
            if let Err(error) = stored {
                let _ = audio.pause();
                self.recording.status = CaptureStatus::Paused;
                return Err(error.into());
            }
            Ok(self.recording_state())
        } else {
            self.transition(CaptureStatus::Paused, CaptureStatus::Recording, "recording")
        }
    }

    fn transition(
        &mut self,
        expected: CaptureStatus,
        next: CaptureStatus,
        stored: &str,
    ) -> Result<RecordingState> {
        if self.recording.status != expected {
            return Err(AppError::new(
                "invalid_state",
                "That action is unavailable in the current recording state.",
            ));
        }
        self.db.execute(
            "UPDATE meetings SET status = ?1 WHERE id = ?2",
            params![stored, self.recording.meeting_id],
        )?;
        self.recording.status = next;
        self.recording.revision += 1;
        Ok(self.recording_state())
    }

    pub fn stop(&mut self) -> Result<RecordingState> {
        if let Some(mut audio) = self.audio.take() {
            self.recording.status = CaptureStatus::Stopped;
            self.recording.revision += 1;
            self.capture_report = Some(match audio.stop() {
                Ok(report) => report,
                Err(error) => audio::Report {
                    tracks: audio.tracks.clone(),
                    error: Some(error.message),
                },
            });
        }
        if let Some(report) = &self.capture_report {
            self.recording.error = report.error.clone();
            let tx = self.db.transaction()?;
            for track in &report.tracks {
                tx.execute("UPDATE tracks SET frames = ?1, dropped_frames = ?2, finalized = ?3 WHERE meeting_id = ?4 AND kind = ?5", params![track.frames, track.dropped_frames, track.finalized, self.recording.meeting_id, track.kind])?;
            }
            tx.execute(
                "UPDATE meetings SET ended_at = ?1, status = ?2, capture_error = ?3 WHERE id = ?4",
                params![
                    now()?,
                    if report.error.is_some() {
                        "interrupted"
                    } else {
                        "stopped"
                    },
                    report.error,
                    self.recording.meeting_id
                ],
            )?;
            tx.commit()?;
            self.capture_report = None;
        }
        if matches!(
            self.recording.status,
            CaptureStatus::Recording | CaptureStatus::Paused
        ) {
            self.db.execute(
                "UPDATE meetings SET status = 'stopped', ended_at = ?1 WHERE id = ?2",
                params![now()?, self.recording.meeting_id],
            )?;
            self.recording.status = CaptureStatus::Stopped;
            self.recording.revision += 1;
        }
        Ok(self.recording_state())
    }

    pub fn toggle_pause(&mut self) -> Result<RecordingState> {
        match self.recording.status {
            CaptureStatus::Recording => self.pause(),
            CaptureStatus::Paused => self.resume(),
            _ => Ok(self.recording_state()),
        }
    }

    pub fn list_meetings(&self) -> Result<Vec<Meeting>> {
        let mut query = self.db.prepare("SELECT id, title, started_at, ended_at, status, source, capture_error FROM meetings ORDER BY started_at DESC, id DESC")?;
        let rows = query.query_map([], meeting_row)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn get_meeting(&self, id: &str) -> Result<MeetingDetail> {
        let meeting = self.db.query_row(
            "SELECT id, title, started_at, ended_at, status, source, capture_error FROM meetings WHERE id = ?1",
            [id], meeting_row,
        ).optional()?.ok_or_else(|| AppError::new("not_found", "Meeting not found."))?;
        let (user_markdown, notes_revision) = self.db.query_row(
            "SELECT user_markdown, revision FROM notes WHERE meeting_id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let mut query = self.db.prepare("SELECT speaker, start_ms, end_ms, text FROM segments WHERE meeting_id = ?1 ORDER BY start_ms, id")?;
        let segments = query
            .query_map([id], |row| {
                Ok(Segment {
                    speaker: row.get(0)?,
                    start_ms: row.get(1)?,
                    end_ms: row.get(2)?,
                    text: row.get(3)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let (summary, summary_provider, summary_model) = self
            .db
            .query_row(
                "SELECT markdown, provider, model FROM summaries WHERE meeting_id = ?1 ORDER BY id DESC LIMIT 1",
                [id],
                |row| Ok((Some(row.get(0)?), Some(row.get(1)?), Some(row.get(2)?))),
            )
            .optional()?
            .unwrap_or((None, None, None));
        let mut query = self.db.prepare("SELECT kind, path, timing_path, device_name, sample_rate, channels, frames, dropped_frames, finalized FROM tracks WHERE meeting_id = ?1 ORDER BY kind")?;
        let tracks = query
            .query_map([id], |row| {
                Ok(audio::Track {
                    kind: row.get(0)?,
                    path: row.get(1)?,
                    timing_path: row.get(2)?,
                    device_name: row.get(3)?,
                    sample_rate: row.get(4)?,
                    channels: row.get(5)?,
                    frames: row.get(6)?,
                    dropped_frames: row.get(7)?,
                    finalized: row.get(8)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(MeetingDetail {
            meeting,
            user_markdown,
            notes_revision,
            segments,
            summary,
            summary_provider,
            summary_model,
            tracks,
        })
    }

    /// Replaces only previously generated (whisper) segments; fixtures and notes are untouched.
    pub fn replace_transcript(&mut self, id: &str, segments: &[Segment]) -> Result<()> {
        let tx = self.db.transaction()?;
        tx.execute(
            "DELETE FROM segments WHERE meeting_id = ?1 AND source = 'whisper'",
            [id],
        )?;
        for segment in segments {
            tx.execute(
                "INSERT INTO segments(meeting_id, speaker, start_ms, end_ms, text, source, pass) VALUES (?1, ?2, ?3, ?4, ?5, 'whisper', 'final')",
                params![id, segment.speaker, segment.start_ms, segment.end_ms, segment.text],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Appends a new summary version; earlier summaries are retained.
    pub fn save_summary(
        &mut self,
        id: &str,
        provider: &str,
        model: &str,
        markdown: &str,
    ) -> Result<()> {
        self.db.execute(
            "INSERT INTO summaries(meeting_id, template_hash, model, provider, markdown) VALUES (?1, 'summary-v1', ?2, ?3, ?4)",
            params![id, model, provider, markdown],
        )?;
        Ok(())
    }

    pub fn save_notes(&mut self, id: &str, markdown: &str, expected_revision: i64) -> Result<i64> {
        if markdown.len() > 1024 * 1024 || !(0..i64::MAX).contains(&expected_revision) {
            return Err(AppError::new(
                "invalid_notes",
                "Notes exceed the 1 MiB limit or have an invalid revision.",
            ));
        }
        let changed = self.db.execute(
            "UPDATE notes SET user_markdown = ?1, revision = revision + 1 WHERE meeting_id = ?2 AND revision = ?3",
            params![markdown, id, expected_revision],
        )?;
        if changed != 1 {
            return Err(AppError::new("notes_conflict", "Notes changed elsewhere or the meeting is missing. Copy your edits before reloading; nothing was overwritten."));
        }
        Ok(expected_revision + 1)
    }

    pub fn settings(&self) -> Result<Settings> {
        Ok(self.db.query_row(
            "SELECT vault_folder, pause_shortcut, microphone_id, output_id, merge_model FROM settings WHERE id = 1",
            [],
            |row| {
                Ok(Settings {
                    vault_folder: row.get(0)?,
                    pause_shortcut: row.get(1)?,
                    microphone_id: row.get(2)?,
                    output_id: row.get(3)?,
                    merge_model: row.get(4)?,
                })
            },
        )?)
    }

    pub fn save_merge_model(&mut self, model: &str, available: &[String]) -> Result<Settings> {
        if model.is_empty() || model.len() > 256 || !available.iter().any(|name| name == model) {
            return Err(AppError::new(
                "merge_model_unavailable",
                "Choose an available Merge model. Refresh the Merge model list and try again.",
            ));
        }
        self.db
            .execute("UPDATE settings SET merge_model = ?1 WHERE id = 1", [model])?;
        self.settings()
    }

    pub fn save_shortcut(&mut self, shortcut: &str) -> Result<Settings> {
        self.db.execute(
            "UPDATE settings SET pause_shortcut = ?1 WHERE id = 1",
            [shortcut],
        )?;
        self.settings()
    }

    pub fn save_vault(&mut self, path: &Path) -> Result<Settings> {
        let path = path.canonicalize()?;
        if !path.is_dir() {
            return Err(AppError::new(
                "invalid_folder",
                "Select an existing folder.",
            ));
        }
        let path = path.to_str().ok_or_else(|| {
            AppError::new("invalid_folder", "The folder path is not valid UTF-8.")
        })?;
        self.db
            .execute("UPDATE settings SET vault_folder = ?1 WHERE id = 1", [path])?;
        self.settings()
    }

    pub fn create_fixture(&mut self) -> Result<String> {
        #[derive(Deserialize)]
        struct Fixture {
            title: String,
            notes: String,
            summary: String,
            segments: Vec<Segment>,
        }
        let fixture: Fixture =
            serde_json::from_str(include_str!("../../fixtures/sample-meeting.json"))
                .map_err(|_| AppError::new("fixture", "The bundled fixture is invalid."))?;
        let id = Uuid::new_v4().to_string();
        let at = now()?;
        let tx = self.db.transaction()?;
        tx.execute("INSERT INTO meetings(id, title, started_at, ended_at, source, status) VALUES (?1, ?2, ?3, ?3, 'fixture', 'stopped')", params![id, fixture.title, at])?;
        tx.execute(
            "INSERT INTO notes(meeting_id, user_markdown) VALUES (?1, ?2)",
            params![id, fixture.notes],
        )?;
        for segment in fixture.segments {
            tx.execute("INSERT INTO segments(meeting_id, speaker, start_ms, end_ms, text, source, pass) VALUES (?1, ?2, ?3, ?4, ?5, 'fixture', 'final')", params![id, segment.speaker, segment.start_ms, segment.end_ms, segment.text])?;
        }
        tx.execute("INSERT INTO summaries(meeting_id, template_hash, model, provider, markdown) VALUES (?1, 'fixture', 'hand-written', 'fixture', ?2)", params![id, fixture.summary])?;
        tx.commit()?;
        Ok(id)
    }
}

fn meeting_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Meeting> {
    Ok(Meeting {
        id: row.get(0)?,
        title: row.get(1)?,
        started_at: row.get(2)?,
        ended_at: row.get(3)?,
        status: row.get(4)?,
        source: row.get(5)?,
        capture_error: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simulation_transitions_and_idempotent_stop() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        assert!(core.pause().is_err());
        let first = core.start("Demo").unwrap();
        assert!(core.start("Duplicate").is_err());
        assert_eq!(core.pause().unwrap().status, CaptureStatus::Paused);
        assert!(core.pause().is_err());
        assert_eq!(core.resume().unwrap().status, CaptureStatus::Recording);
        core.stop().unwrap();
        assert_eq!(core.stop().unwrap().status, CaptureStatus::Stopped);
        assert_eq!(core.list_meetings().unwrap().len(), 1);
        assert!(core
            .get_meeting(first.meeting_id.as_ref().unwrap())
            .unwrap()
            .meeting
            .ended_at
            .is_some());
    }

    #[test]
    fn desktop_start_rejects_denied_consent_and_missing_devices_without_capture() {
        let dir = tempfile::tempdir().unwrap();
        let mut core = Core::open(&dir.path().join("meetings.db")).unwrap();
        let options = audio::CaptureOptions {
            microphone_id: "mic".into(),
            output_id: "out".into(),
        };
        assert_eq!(
            core.start_desktop("Denied", options.clone(), false)
                .unwrap_err()
                .code,
            "consent_required"
        );
        for options in [
            audio::CaptureOptions {
                microphone_id: String::new(),
                ..options.clone()
            },
            audio::CaptureOptions {
                output_id: String::new(),
                ..options
            },
        ] {
            assert_eq!(
                core.start_desktop("Missing device", options, true)
                    .unwrap_err()
                    .code,
                "audio_devices"
            );
        }
        assert_eq!(core.recording_state().status, CaptureStatus::Idle);
        assert!(core.list_meetings().unwrap().is_empty());
        assert!(core.audio.is_none());
        assert!(!core.audio_root.exists());
    }

    #[test]
    fn restart_preserves_notes_and_marks_interrupted_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        let id;
        {
            let mut core = Core::open(&path).unwrap();
            id = core.start("Interrupted").unwrap().meeting_id.unwrap();
            core.save_notes(&id, "Important user notes", 0).unwrap();
        }
        let core = Core::open(&path).unwrap();
        let meeting = core.get_meeting(&id).unwrap();
        assert_eq!(meeting.meeting.status, "interrupted");
        assert_eq!(meeting.user_markdown, "Important user notes");
        assert_eq!(core.recording_state().status, CaptureStatus::Idle);
    }

    #[test]
    fn stale_note_writes_cannot_overwrite_newer_edits() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_fixture().unwrap();
        assert_eq!(core.save_notes(&id, "New", 0).unwrap(), 1);
        assert_eq!(
            core.save_notes(&id, "Stale", 0).unwrap_err().code,
            "notes_conflict"
        );
        assert_eq!(core.get_meeting(&id).unwrap().user_markdown, "New");
        assert!(core
            .save_notes(&id, &"x".repeat(1024 * 1024 + 1), 1)
            .is_err());
    }

    #[test]
    fn real_transcripts_replace_only_whisper_rows_and_summaries_keep_provenance() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        let mut core = Core::open(&path).unwrap();
        let id = core.create_fixture().unwrap();
        let line = |text: &str, start: i64| Segment {
            speaker: "Others".into(),
            start_ms: start,
            end_ms: start + 10,
            text: text.into(),
        };
        core.replace_transcript(&id, &[line("first run", 0), line("second", 20)])
            .unwrap();
        core.replace_transcript(&id, &[line("rerun", 5)]).unwrap();
        let texts: Vec<_> = core
            .get_meeting(&id)
            .unwrap()
            .segments
            .into_iter()
            .map(|s| s.text)
            .collect();
        assert!(texts.contains(&"rerun".to_string()));
        assert!(!texts.iter().any(|t| t == "first run" || t == "second"));
        assert_eq!(texts.len(), 3, "two fixture segments plus the rerun");
        assert_eq!(
            core.get_meeting(&id).unwrap().summary_provider.as_deref(),
            Some("fixture")
        );
        core.save_summary(&id, "merge", "anthropic/claude-haiku-5-5", "# S")
            .unwrap();
        let detail = core.get_meeting(&id).unwrap();
        assert_eq!(detail.summary.as_deref(), Some("# S"));
        assert_eq!(detail.summary_provider.as_deref(), Some("merge"));
        assert_eq!(
            detail.summary_model.as_deref(),
            Some("anthropic/claude-haiku-5-5")
        );
        let bad = Segment {
            speaker: "Nobody".into(),
            ..line("x", 0)
        };
        assert_eq!(
            core.replace_transcript(&id, &[bad]).unwrap_err().code,
            "database"
        );
        assert_eq!(core.get_meeting(&id).unwrap().segments.len(), 3);
    }

    #[test]
    fn merge_model_selection_requires_an_available_model_and_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        let mut core = Core::open(&path).unwrap();
        assert_eq!(core.settings().unwrap().merge_model, None);
        let available = vec!["openai/gpt-5.4".to_string()];
        for invalid in ["", "gated/model", &"m".repeat(300)] {
            assert_eq!(
                core.save_merge_model(invalid, &available).unwrap_err().code,
                "merge_model_unavailable"
            );
        }
        assert_eq!(core.settings().unwrap().merge_model, None);
        core.save_merge_model("openai/gpt-5.4", &available).unwrap();
        drop(core);
        let core = Core::open(&path).unwrap();
        let settings = core.settings().unwrap();
        assert_eq!(settings.merge_model.as_deref(), Some("openai/gpt-5.4"));
    }

    #[test]
    fn migrations_preserve_populated_v2_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        {
            let db = Connection::open(&path).unwrap();
            db.execute_batch(include_str!("../migrations/001_foundation.sql"))
                .unwrap();
            db.execute_batch(include_str!("../migrations/002_capture.sql"))
                .unwrap();
            db.execute_batch("PRAGMA foreign_keys = ON;
                INSERT INTO meetings(id, title, started_at, source, status) VALUES ('old', 'Existing fixture', '2026-10-10', 'fixture', 'stopped');
                INSERT INTO notes(meeting_id, user_markdown, revision) VALUES ('old', 'Existing notes', 7);
                INSERT INTO segments(meeting_id, speaker, start_ms, end_ms, text, source, pass) VALUES ('old', 'You', 0, 100, 'Fictional text', 'fixture', 'final');
                INSERT INTO summaries(meeting_id, template_hash, model, provider, markdown) VALUES ('old', 'fixture', 'hand-written', 'fixture', 'Existing summary');
                UPDATE settings SET vault_folder = 'saved-folder', microphone_id = 'mic', output_id = 'out';").unwrap();
        }
        let core = Core::open(&path).unwrap();
        let detail = core.get_meeting("old").unwrap();
        assert_eq!(detail.user_markdown, "Existing notes");
        assert_eq!(detail.notes_revision, 7);
        assert_eq!(detail.segments.len(), 1);
        assert_eq!(detail.summary.as_deref(), Some("Existing summary"));
        let settings = core.settings().unwrap();
        assert_eq!(settings.vault_folder.as_deref(), Some("saved-folder"));
        assert_eq!(settings.microphone_id.as_deref(), Some("mic"));
        assert_eq!(settings.output_id.as_deref(), Some("out"));
        assert_eq!(settings.merge_model, None);
        assert_eq!(
            core.db
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            5
        );
        assert_eq!(detail.segments[0].text, "Fictional text");
        assert_eq!(
            core.db
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        assert_eq!(
            core.db
                .pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn migrations_are_repeatable_and_fixture_is_persistent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        let id;
        {
            let mut core = Core::open(&path).unwrap();
            id = core.create_fixture().unwrap();
            core.save_vault(dir.path()).unwrap();
        }
        let core = Core::open(&path).unwrap();
        let detail = core.get_meeting(&id).unwrap();
        assert_eq!(detail.segments.len(), 2);
        assert!(detail.summary.unwrap().contains("hand-written fixture"));
        assert!(core.settings().unwrap().vault_folder.is_some());
        assert_eq!(
            core.db
                .pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            core.db
                .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
                .unwrap(),
            "wal"
        );
    }
}
