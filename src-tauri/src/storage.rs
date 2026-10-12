use crate::{audio, domain::*};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Highest `user_version` this build understands; bump with every new migration.
const LATEST_SCHEMA: i64 = 9;

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
            1..=LATEST_SCHEMA => {}
            _ => {
                return Err(AppError::new(
                    "schema_version",
                    "This database needs a newer OpenMeet version.",
                ))
            }
        }
        // Each script sets its own `user_version`, so migration N runs for databases below N.
        // Keep entries numbered explicitly and in ascending order; LATEST_SCHEMA must match the last one.
        // `true` marks a rebuild of a table other tables reference: it runs with foreign keys OFF
        // (only switchable outside a transaction) and must pass foreign_key_check before commit.
        let additive = [
            (2, include_str!("../migrations/002_capture.sql"), true),
            (3, include_str!("../migrations/003_local_model.sql"), false),
            (4, include_str!("../migrations/004_merge_model.sql"), false),
            (5, include_str!("../migrations/005_transcripts.sql"), false),
            (6, include_str!("../migrations/006_note_meetings.sql"), true),
            (7, include_str!("../migrations/007_search.sql"), false),
            (
                9,
                include_str!("../migrations/009_export_options.sql"),
                false,
            ),
        ];
        for (number, script, rebuilds_referenced) in additive {
            if version >= number {
                continue;
            }
            if rebuilds_referenced {
                db.pragma_update(None, "foreign_keys", "OFF")?;
            }
            let tx = db.transaction()?;
            tx.execute_batch(script)?;
            if rebuilds_referenced {
                let violations: i64 =
                    tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                        row.get(0)
                    })?;
                if violations != 0 {
                    return Err(AppError::new(
                        "migration",
                        format!("Migration {number} would break existing references."),
                    ));
                }
            }
            tx.commit()?;
            if rebuilds_referenced {
                db.pragma_update(None, "foreign_keys", "ON")?;
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
        validate_title(title)
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
        let (summary, summary_provider, summary_model, summary_template) = self
            .db
            .query_row(
                "SELECT markdown, provider, model, template_hash FROM summaries WHERE meeting_id = ?1 ORDER BY id DESC LIMIT 1",
                [id],
                |row| Ok((Some(row.get(0)?), Some(row.get(1)?), Some(row.get(2)?), Some(row.get(3)?))),
            )
            .optional()?
            .unwrap_or((None, None, None, None));
        let mut query = self.db.prepare("SELECT kind, path, timing_path, device_name, sample_rate, channels, frames, dropped_frames, finalized FROM tracks WHERE meeting_id = ?1 ORDER BY kind")?;
        let tracks = query
            .query_map([id], |row| {
                let path: String = row.get(1)?;
                Ok(audio::Track {
                    kind: row.get(0)?,
                    size_bytes: std::fs::metadata(&path).ok().map(|file| file.len()),
                    path,
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
            summary_template,
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
        template: &str,
    ) -> Result<()> {
        self.db.execute(
            "INSERT INTO summaries(meeting_id, template_hash, model, provider, markdown) VALUES (?1, ?5, ?2, ?3, ?4)",
            params![id, model, provider, markdown, template],
        )?;
        Ok(())
    }

    /// Every summary version, newest first. The table has no timestamp, so ids order them.
    pub fn list_summaries(&self, id: &str) -> Result<Vec<SummaryVersion>> {
        let mut query = self.db.prepare(
            "SELECT id, provider, model, template_hash, markdown FROM summaries WHERE meeting_id = ?1 ORDER BY id DESC",
        )?;
        let versions = query
            .query_map([id], |row| {
                Ok(SummaryVersion {
                    id: row.get(0)?,
                    provider: row.get(1)?,
                    model: row.get(2)?,
                    template: row.get(3)?,
                    markdown: row.get(4)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(versions)
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
            "SELECT vault_folder, pause_shortcut, microphone_id, output_id, merge_model, export_transcript, export_summary, export_filename FROM settings WHERE id = 1",
            [],
            |row| {
                Ok(Settings {
                    vault_folder: row.get(0)?,
                    pause_shortcut: row.get(1)?,
                    microphone_id: row.get(2)?,
                    output_id: row.get(3)?,
                    merge_model: row.get(4)?,
                    export: ExportOptions {
                        transcript: row.get(5)?,
                        summary: row.get(6)?,
                        // The column CHECK constraint allows only these two values.
                        filename: match row.get::<_, String>(7)?.as_str() {
                            "date_title" => FilenamePattern::DateTitle,
                            _ => FilenamePattern::Title,
                        },
                    },
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

    /// A notes-only meeting. It never touches `RecordingState`, so it is allowed during a recording.
    pub fn create_note(&mut self, title: &str) -> Result<String> {
        let title = validate_title(title)?;
        let id = Uuid::new_v4().to_string();
        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT INTO meetings(id, title, started_at, source, status) VALUES (?1, ?2, ?3, 'note', 'stopped')",
            params![id, title, now()?],
        )?;
        tx.execute("INSERT INTO notes(meeting_id) VALUES (?1)", [&id])?;
        tx.commit()?;
        Ok(id)
    }

    /// Bytes stored in the per-meeting audio folders (WAV and timing files), without following links.
    pub fn audio_usage(&self) -> Result<u64> {
        let folders = match std::fs::read_dir(&self.audio_root) {
            Ok(folders) => folders,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(error.into()),
        };
        let mut total = 0;
        for folder in folders {
            let folder = folder?;
            if !folder.file_type()?.is_dir() {
                continue;
            }
            for file in std::fs::read_dir(folder.path())? {
                let metadata = file?.metadata()?;
                if metadata.is_file() {
                    total += metadata.len();
                }
            }
        }
        Ok(total)
    }

    /// Removes this meeting's track files and rows; notes, transcript and summaries stay.
    pub fn delete_audio(&mut self, id: &str) -> Result<()> {
        if self.recording.meeting_id.as_deref() == Some(id)
            && (self.audio.is_some()
                || self.capture_report.is_some()
                || matches!(
                    self.recording.status,
                    CaptureStatus::Recording | CaptureStatus::Paused
                ))
        {
            return Err(AppError::new(
                "recording_active",
                "Stop the recording before deleting it or its audio.",
            ));
        }
        let exists: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM meetings WHERE id = ?1)",
            [id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(AppError::new("not_found", "Meeting not found."));
        }
        for file in self.owned_audio_files(id)? {
            match std::fs::remove_file(&file) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        self.db
            .execute("DELETE FROM tracks WHERE meeting_id = ?1", [id])?;
        if Uuid::parse_str(id).is_ok() {
            // Succeeds only once the folder is empty; unknown files are left in place.
            let _ = std::fs::remove_dir(self.audio_root.join(id));
        }
        Ok(())
    }

    /// Deletes the audio (same guard), then the meeting; notes, transcript and summaries cascade.
    /// Exported Markdown snapshots live outside app data and are never touched.
    pub fn delete_meeting(&mut self, id: &str) -> Result<()> {
        self.delete_audio(id)?;
        self.db
            .execute("DELETE FROM meetings WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Existing track files, refusing (before deleting anything) any file that is not directly inside
    /// `audio_root/<uuid>/` once `..` and links are resolved. Already-missing files are skipped.
    fn owned_audio_files(&self, id: &str) -> Result<Vec<PathBuf>> {
        let folder = Uuid::parse_str(id).ok().and_then(|_| {
            let root = self.audio_root.canonicalize().ok()?;
            let folder = self.audio_root.join(id).canonicalize().ok()?;
            (folder.parent() == Some(root.as_path())).then_some(folder)
        });
        let mut query = self
            .db
            .prepare("SELECT path, timing_path FROM tracks WHERE meeting_id = ?1")?;
        let stored = query
            .query_map([id], |row| {
                Ok([row.get::<_, String>(0)?, row.get::<_, String>(1)?])
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut files = Vec::new();
        for path in stored.iter().flatten() {
            let file = match Path::new(path).canonicalize() {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if file.parent() != folder.as_deref() || !file.is_file() {
                return Err(AppError::new(
                    "unsafe_audio_path",
                    "A stored audio path points outside this meeting's audio folder. Nothing was deleted.",
                ));
            }
            files.push(file);
        }
        Ok(files)
    }

    /// Best match per meeting and kind, ranked by relevance (bm25).
    pub fn search_meetings(&self, query: &str) -> Result<Vec<SearchHit>> {
        let query: String = query.chars().filter(|c| !c.is_control()).collect();
        let query = query.trim();
        if query.chars().count() > 200 {
            return Err(AppError::new(
                "invalid_query",
                "Search for 200 characters or fewer.",
            ));
        }
        // FTS5 tokens are letters and digits; anything else alone would be an empty phrase.
        if !query.chars().any(char::is_alphanumeric) {
            return Ok(Vec::new());
        }
        // One quoted phrase with doubled quotes, so `"`, `*`, `:`, NEAR, AND/OR/NOT stay literal text.
        // The trailing `*` prefix-matches the last word for search-as-you-type.
        let phrase = format!("\"{}\"*", query.replace('"', "\"\""));
        let mut statement = self.db.prepare(
            "SELECT meeting_id, kind, snippet(search, 2, '', '', 'â€¦', 12) FROM search WHERE search MATCH ?1 ORDER BY rank LIMIT 200",
        )?;
        let rows = statement.query_map([phrase], |row| {
            Ok(SearchHit {
                meeting_id: row.get(0)?,
                kind: row.get(1)?,
                snippet: row.get(2)?,
            })
        })?;
        let mut seen = std::collections::HashSet::new();
        let mut hits = Vec::new();
        for hit in rows {
            let hit = hit?;
            if seen.insert((hit.meeting_id.clone(), hit.kind.clone())) {
                hits.push(hit);
                if hits.len() == 20 {
                    break;
                }
            }
        }
        Ok(hits)
    }

    /// Returns the stored (trimmed) title. Exported snapshots keep their old names.
    pub fn rename_meeting(&mut self, id: &str, title: &str) -> Result<String> {
        let title = validate_title(title)?;
        let changed = self.db.execute(
            "UPDATE meetings SET title = ?1 WHERE id = ?2",
            params![title, id],
        )?;
        if changed != 1 {
            return Err(AppError::new("not_found", "Meeting not found."));
        }
        Ok(title.to_string())
    }

    pub fn save_export_options(&mut self, options: &ExportOptions) -> Result<Settings> {
        let filename = match options.filename {
            FilenamePattern::Title => "title",
            FilenamePattern::DateTitle => "date_title",
        };
        self.db.execute(
            "UPDATE settings SET export_transcript = ?1, export_summary = ?2, export_filename = ?3 WHERE id = 1",
            params![options.transcript, options.summary, filename],
        )?;
        self.settings()
    }

    /// Unfinalized tracks of an interrupted desktop recording as (kind, original, repaired copy).
    /// Copying happens outside the core lock; see `mark_recovered`.
    pub fn recoverable_tracks(&self, id: &str) -> Result<Vec<(String, PathBuf, PathBuf)>> {
        let detail = self.get_meeting(id)?;
        if detail.meeting.source != "desktop" || detail.meeting.status != "interrupted" {
            return Err(AppError::new(
                "not_recoverable",
                "Only interrupted recordings can be recovered.",
            ));
        }
        let mut tracks = Vec::new();
        for track in detail.tracks.into_iter().filter(|track| !track.finalized) {
            let original = PathBuf::from(&track.path);
            if !original.starts_with(&self.audio_root) {
                return Err(AppError::new(
                    "unsafe_path",
                    "A track path is outside the OpenMeet audio folder. Nothing was changed.",
                ));
            }
            let copy = original.with_file_name(format!("{}.recovered.wav", track.kind));
            tracks.push((track.kind, original, copy));
        }
        if tracks.is_empty() {
            return Err(AppError::new(
                "not_recoverable",
                "This recording has no unfinished audio tracks to recover.",
            ));
        }
        Ok(tracks)
    }

    /// Points a track at its repaired copy. The original file stays on disk unchanged.
    pub fn mark_recovered(&mut self, id: &str, kind: &str, copy: &Path, frames: i64) -> Result<()> {
        let changed = self.db.execute(
            "UPDATE tracks SET path = ?1, frames = ?2, finalized = 1 WHERE meeting_id = ?3 AND kind = ?4 AND finalized = 0",
            params![copy.to_string_lossy(), frames, id, kind],
        )?;
        if changed != 1 {
            return Err(AppError::new(
                "not_recoverable",
                "The track changed during recovery. The repaired copy was kept on disk.",
            ));
        }
        Ok(())
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

/// Returns the trimmed title if it has 1â€“160 characters.
fn validate_title(title: &str) -> Result<&str> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 160 {
        return Err(AppError::new(
            "invalid_title",
            "Use a meeting title between 1 and 160 characters.",
        ));
    }
    Ok(title)
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
        core.save_summary(
            &id,
            "merge",
            "anthropic/claude-haiku-5-5",
            "# S",
            "general-v1",
        )
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
    fn summary_versions_list_newest_first_with_templates_and_latest_stays_current() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_fixture().unwrap();
        let other = core.create_fixture().unwrap();
        core.save_summary(&id, "merge", "m1", "one", "general-v1")
            .unwrap();
        core.save_summary(&id, "merge", "m2", "two", "standup-v1")
            .unwrap();
        core.save_summary(&other, "merge", "m9", "elsewhere", "general-v1")
            .unwrap();
        let versions = core.list_summaries(&id).unwrap();
        let rows: Vec<_> = versions
            .iter()
            .map(|v| (v.markdown.as_str(), v.template.as_str(), v.model.as_str()))
            .collect();
        assert_eq!(
            rows,
            [
                ("two", "standup-v1", "m2"),
                ("one", "general-v1", "m1"),
                (versions[2].markdown.as_str(), "fixture", "hand-written"),
            ]
        );
        assert!(versions[0].id > versions[1].id && versions[1].id > versions[2].id);
        assert_eq!(
            core.get_meeting(&id).unwrap().summary.as_deref(),
            Some("two")
        );
        assert!(core.list_summaries("missing").unwrap().is_empty());
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
            LATEST_SCHEMA
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

    fn count(core: &Core, sql: &str) -> i64 {
        core.db.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn found(core: &Core, query: &str) -> Vec<(String, String)> {
        core.search_meetings(query)
            .unwrap()
            .into_iter()
            .map(|hit| (hit.meeting_id, hit.kind))
            .collect()
    }

    #[test]
    fn fts5_is_available_in_bundled_sqlite() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE VIRTUAL TABLE probe USING fts5(body); INSERT INTO probe VALUES ('hello world');",
        )
        .unwrap();
        let matches: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM probe WHERE probe MATCH 'hello'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(matches, 1);
    }

    #[test]
    fn migrations_preserve_populated_v5_database_and_backfill_search() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        {
            let db = Connection::open(&path).unwrap();
            for script in [
                include_str!("../migrations/001_foundation.sql"),
                include_str!("../migrations/002_capture.sql"),
                include_str!("../migrations/003_local_model.sql"),
                include_str!("../migrations/004_merge_model.sql"),
                include_str!("../migrations/005_transcripts.sql"),
            ] {
                db.execute_batch(script).unwrap();
            }
            db.execute_batch("PRAGMA foreign_keys = ON;
                INSERT INTO meetings(id, title, started_at, ended_at, source, status, capture_error) VALUES ('m1', 'Planning sync', '2026-10-10', '2026-10-10', 'desktop', 'interrupted', 'device lost');
                INSERT INTO meetings(id, title, started_at, source, status) VALUES ('m2', 'Other fixture', '2026-10-09', 'fixture', 'stopped');
                INSERT INTO notes(meeting_id, user_markdown, revision) VALUES ('m1', 'Discuss quarterly budget', 3), ('m2', 'Unrelated', 0);
                INSERT INTO segments(meeting_id, speaker, start_ms, end_ms, text, source, pass) VALUES ('m1', 'You', 0, 100, 'The roadmap slipped', 'whisper', 'final');
                INSERT INTO summaries(meeting_id, template_hash, model, provider, markdown) VALUES ('m1', 'summary-v1', 'model-x', 'merge', 'Hire a contractor');
                INSERT INTO tracks(meeting_id, kind, path, timing_path, device_name, sample_rate, channels, frames, finalized) VALUES ('m1', 'mic', 'mic.wav', 'mic.timing.jsonl', 'Mic', 48000, 1, 480, 1);
                INSERT INTO capture_events(meeting_id, kind, offset_us) VALUES ('m1', 'paused', 5);").unwrap();
        }
        let mut core = Core::open(&path).unwrap();
        assert_eq!(
            core.db
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            LATEST_SCHEMA
        );
        assert_eq!(
            count(&core, "SELECT COUNT(*) FROM pragma_foreign_key_check"),
            0
        );
        assert_eq!(
            core.db
                .pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        let detail = core.get_meeting("m1").unwrap();
        assert_eq!(detail.meeting.source, "desktop");
        assert_eq!(detail.meeting.status, "interrupted");
        assert_eq!(detail.meeting.capture_error.as_deref(), Some("device lost"));
        assert_eq!(detail.user_markdown, "Discuss quarterly budget");
        assert_eq!(detail.notes_revision, 3);
        assert_eq!(detail.segments[0].text, "The roadmap slipped");
        assert_eq!(detail.summary.as_deref(), Some("Hire a contractor"));
        assert_eq!(detail.tracks.len(), 1);
        assert_eq!(detail.tracks[0].frames, 480);
        assert_eq!(count(&core, "SELECT COUNT(*) FROM capture_events"), 1);
        assert_eq!(core.list_meetings().unwrap().len(), 2);
        let m1 = |kind: &str| vec![("m1".to_string(), kind.to_string())];
        assert_eq!(found(&core, "planning"), m1("title"));
        assert_eq!(found(&core, "budget"), m1("notes"));
        assert_eq!(found(&core, "roadmap"), m1("transcript"));
        assert_eq!(found(&core, "contractor"), m1("summary"));
        // The rebuilt meetings table accepts notes and still enforces and cascades every reference.
        core.create_note("Scratch").unwrap();
        assert!(core
            .db
            .execute("INSERT INTO notes(meeting_id) VALUES ('missing')", [])
            .is_err());
        core.db
            .execute("DELETE FROM meetings WHERE id = 'm1'", [])
            .unwrap();
        for table in ["notes", "segments", "summaries", "tracks", "capture_events"] {
            let sql = format!("SELECT COUNT(*) FROM {table} WHERE meeting_id = 'm1'");
            assert_eq!(count(&core, &sql), 0, "{table}");
        }
        assert_eq!(core.get_meeting("m2").unwrap().user_markdown, "Unrelated");
        assert!(found(&core, "roadmap").is_empty());
    }

    #[test]
    fn note_meetings_never_appear_as_recordings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        let note;
        {
            let mut core = Core::open(&path).unwrap();
            let live = core.start("Live").unwrap();
            note = core.create_note("  Ideas  ").unwrap();
            assert_eq!(core.recording_state(), live, "recording state is untouched");
            assert_eq!(core.create_note(" ").unwrap_err().code, "invalid_title");
            assert_eq!(core.save_notes(&note, "First idea", 0).unwrap(), 1);
        }
        let core = Core::open(&path).unwrap();
        let detail = core.get_meeting(&note).unwrap();
        assert_eq!(detail.meeting.title, "Ideas");
        assert_eq!(detail.meeting.source, "note");
        assert_eq!(
            detail.meeting.status, "stopped",
            "restart does not interrupt notes"
        );
        assert_eq!(detail.user_markdown, "First idea");
        assert!(detail.tracks.is_empty() && detail.segments.is_empty());
        assert_eq!(found(&core, "first"), vec![(note, "notes".to_string())]);
    }

    #[test]
    fn search_index_follows_edits_and_deletes_and_escapes_queries() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let note = core.create_note("Alpha").unwrap();
        let fixture = core.create_fixture().unwrap();
        let ours = |kind: &str| vec![(note.clone(), kind.to_string())];
        core.save_notes(&note, "kiwi plan", 0).unwrap();
        assert_eq!(found(&core, "kiwi"), ours("notes"));
        core.save_notes(&note, "mango plan", 1).unwrap();
        assert!(found(&core, "kiwi").is_empty());
        assert_eq!(found(&core, "man"), ours("notes"), "prefix match");
        let line = |text: &str| Segment {
            speaker: "You".into(),
            start_ms: 0,
            end_ms: 1,
            text: text.into(),
        };
        core.replace_transcript(&note, &[line("papaya talk"), line("papaya talk")])
            .unwrap();
        assert_eq!(
            found(&core, "papaya"),
            ours("transcript"),
            "one hit per kind"
        );
        core.replace_transcript(&note, &[line("guava")]).unwrap();
        assert!(found(&core, "papaya").is_empty());
        assert_eq!(found(&core, "guava"), ours("transcript"));
        core.save_summary(&note, "merge", "m", "lychee summary", "general-v1")
            .unwrap();
        assert_eq!(found(&core, "lychee"), ours("summary"));
        core.db
            .execute(
                "UPDATE meetings SET title = 'Durian' WHERE id = ?1",
                [&note],
            )
            .unwrap();
        assert_eq!(found(&core, "durian"), ours("title"));
        assert!(found(&core, "alpha").is_empty());
        assert_eq!(
            found(&core, "checklist").len(),
            3,
            "fixture notes, transcript, summary"
        );
        for hostile in [
            "\"",
            "\"\"",
            "*",
            "kiwi*",
            "NEAR(a b)",
            "a OR",
            "AND",
            "NOT x",
            "body:kiwi",
            "-x",
            "^x",
            "(",
            "{body}",
            "\0",
            "\"unterminated",
            "'; DROP TABLE search; --",
            "!!!",
            "Ã¼nÃ¯code",
        ] {
            assert!(core.search_meetings(hostile).is_ok(), "{hostile:?}");
        }
        assert_eq!(
            found(&core, "\"mango plan\""),
            ours("notes"),
            "quotes are literal"
        );
        assert!(found(&core, "").is_empty());
        assert_eq!(
            core.search_meetings(&"x".repeat(201)).unwrap_err().code,
            "invalid_query"
        );
        core.delete_meeting(&note).unwrap();
        for gone in ["mango", "guava", "lychee", "durian"] {
            assert!(found(&core, gone).is_empty(), "{gone}");
        }
        let sql = format!("SELECT COUNT(*) FROM search WHERE meeting_id = '{note}'");
        assert_eq!(count(&core, &sql), 0);
        assert_eq!(found(&core, "checklist").len(), 3);
        assert!(core.get_meeting(&fixture).is_ok());
    }

    #[test]
    fn deletion_is_confined_to_the_meeting_audio_folder() {
        let dir = tempfile::tempdir().unwrap();
        let mut core = Core::open(&dir.path().join("meetings.db")).unwrap();
        let root = core.audio_root.clone();
        // A stopped desktop meeting whose mic track is stored at `wav` / `timing`.
        let add = |core: &Core, id: &str, wav: &Path, timing: &Path| {
            std::fs::create_dir_all(root.join(id)).unwrap();
            core.db.execute("INSERT INTO meetings(id, title, started_at, source, status) VALUES (?1, 'Rec', '2026-10-10', 'desktop', 'stopped')", [id]).unwrap();
            core.db
                .execute(
                    "INSERT INTO notes(meeting_id, user_markdown) VALUES (?1, 'keep me')",
                    [id],
                )
                .unwrap();
            core.db.execute("INSERT INTO tracks(meeting_id, kind, path, timing_path, device_name, sample_rate, channels, finalized) VALUES (?1, 'mic', ?2, ?3, 'Mic', 48000, 1, 1)",
                params![id, wav.to_str().unwrap(), timing.to_str().unwrap()]).unwrap();
        };
        let good = Uuid::new_v4().to_string();
        let folder = root.join(&good);
        add(
            &core,
            &good,
            &folder.join("mic.wav"),
            &folder.join("mic.timing.jsonl"),
        );
        std::fs::write(folder.join("mic.wav"), [0u8; 10]).unwrap();
        std::fs::write(folder.join("mic.timing.jsonl"), [0u8; 3]).unwrap();
        let detail = core.get_meeting(&good).unwrap();
        assert_eq!(detail.tracks[0].size_bytes, Some(10));
        assert!(serde_json::to_value(&detail).unwrap()["tracks"][0]["size_bytes"].is_u64());
        assert_eq!(core.audio_usage().unwrap(), 13);

        // Stored paths that escape the meeting folder are refused before anything is removed.
        let outside = root.join("outside.wav");
        std::fs::write(&outside, b"x").unwrap();
        let secret = dir.path().join("secret.wav");
        std::fs::write(&secret, b"x").unwrap();
        let mut hostile = vec![];
        let dotdot = Uuid::new_v4().to_string();
        let escape = root.join(&dotdot).join("..").join("outside.wav");
        // Its WAV is legitimate, but the timing path escapes: nothing at all may be removed.
        let legit = root.join(&dotdot).join("mic.wav");
        add(&core, &dotdot, &legit, &escape);
        std::fs::write(&legit, b"x").unwrap();
        hostile.push(dotdot);
        let absolute = Uuid::new_v4().to_string();
        add(&core, &absolute, &secret, &secret);
        hostile.push(absolute);
        let linked = Uuid::new_v4().to_string();
        let link = root.join(&linked).join("mic.wav");
        add(&core, &linked, &link, &link);
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&secret, &link).is_ok();
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&secret, &link).is_ok();
        if made {
            hostile.push(linked);
        }
        for id in &hostile {
            assert_eq!(core.delete_audio(id).unwrap_err().code, "unsafe_audio_path");
            assert_eq!(
                core.delete_meeting(id).unwrap_err().code,
                "unsafe_audio_path"
            );
            assert_eq!(core.get_meeting(id).unwrap().tracks.len(), 1);
        }
        assert!(outside.exists() && secret.exists() && legit.exists());

        // Delete audio keeps notes; delete meeting cascades; other meetings are intact.
        core.delete_audio(&good).unwrap();
        assert!(!folder.exists());
        let detail = core.get_meeting(&good).unwrap();
        assert!(detail.tracks.is_empty());
        assert_eq!(detail.user_markdown, "keep me");
        core.delete_meeting(&good).unwrap();
        assert_eq!(core.get_meeting(&good).unwrap_err().code, "not_found");
        let sql = format!("SELECT COUNT(*) FROM notes WHERE meeting_id = '{good}'");
        assert_eq!(count(&core, &sql), 0);
        assert_eq!(core.delete_meeting(&good).unwrap_err().code, "not_found");
        for id in &hostile {
            assert_eq!(core.get_meeting(id).unwrap().user_markdown, "keep me");
        }

        // The active meeting is refused.
        let live = core.start("Live").unwrap().meeting_id.unwrap();
        assert_eq!(
            core.delete_meeting(&live).unwrap_err().code,
            "recording_active"
        );
        assert_eq!(
            core.delete_audio(&live).unwrap_err().code,
            "recording_active"
        );
        core.stop().unwrap();
        core.delete_meeting(&live).unwrap();
    }

    #[test]
    fn rename_validates_titles_and_keeps_the_old_one_on_rejection() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_fixture().unwrap();
        assert_eq!(
            core.rename_meeting(&id, "  Planning review  ").unwrap(),
            "Planning review"
        );
        for invalid in ["", "   ", &"x".repeat(161)] {
            assert_eq!(
                core.rename_meeting(&id, invalid).unwrap_err().code,
                "invalid_title"
            );
        }
        assert!(core.rename_meeting(&id, &"é".repeat(160)).is_ok());
        core.rename_meeting(&id, "Planning review").unwrap();
        assert_eq!(
            core.rename_meeting("missing", "Title").unwrap_err().code,
            "not_found"
        );
        assert_eq!(
            core.get_meeting(&id).unwrap().meeting.title,
            "Planning review"
        );
        assert_eq!(core.list_meetings().unwrap()[0].title, "Planning review");
    }

    #[test]
    fn export_options_default_on_and_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        let mut core = Core::open(&path).unwrap();
        assert_eq!(
            core.settings().unwrap().export,
            ExportOptions {
                transcript: true,
                summary: true,
                filename: FilenamePattern::Title
            }
        );
        let chosen = ExportOptions {
            transcript: false,
            summary: true,
            filename: FilenamePattern::DateTitle,
        };
        assert_eq!(core.save_export_options(&chosen).unwrap().export, chosen);
        drop(core);
        assert_eq!(
            Core::open(&path).unwrap().settings().unwrap().export,
            chosen
        );
    }

    #[test]
    fn interrupted_tracks_recover_into_copies_and_originals_stay() {
        let dir = tempfile::tempdir().unwrap();
        let mut core = Core::open(&dir.path().join("meetings.db")).unwrap();
        let folder = dir.path().join("audio").join("rec");
        std::fs::create_dir_all(&folder).unwrap();
        let mic = folder.join("mic.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(&mic, spec).unwrap();
        for i in 0..1000 {
            writer.write_sample(i as f32 / 1000.0).unwrap();
        }
        writer.finalize().unwrap();
        // Simulate a crash: stale header sizes and a partial last sample.
        let mut bytes = std::fs::read(&mic).unwrap();
        bytes[4..8].fill(0);
        bytes.truncate(bytes.len() - 2);
        std::fs::write(&mic, &bytes).unwrap();
        let outside = dir.path().join("elsewhere.wav");
        core.db.execute_batch(&format!(
            "INSERT INTO meetings(id, title, started_at, source, status) VALUES ('rec', 'Crashed', '2026-10-10T09:00:00Z', 'desktop', 'interrupted'), ('ok', 'Fine', '2026-10-10T09:00:00Z', 'desktop', 'stopped'), ('bad', 'Odd path', '2026-10-10T09:00:00Z', 'desktop', 'interrupted');
             INSERT INTO notes(meeting_id) VALUES ('rec'), ('ok'), ('bad');
             INSERT INTO tracks(meeting_id, kind, path, timing_path, device_name, sample_rate, channels, frames, finalized) VALUES
               ('rec', 'mic', '{mic}', 'mic.timing.jsonl', 'Mic', 16000, 1, 0, 0),
               ('rec', 'system', 'system.wav', 'system.timing.jsonl', 'Out', 16000, 1, 500, 1),
               ('ok', 'mic', 'mic.wav', 'mic.timing.jsonl', 'Mic', 16000, 1, 0, 0),
               ('bad', 'mic', '{outside}', 'mic.timing.jsonl', 'Mic', 16000, 1, 0, 0);",
            mic = mic.to_string_lossy().replace('\'', "''"),
            outside = outside.to_string_lossy().replace('\'', "''"),
        )).unwrap();
        assert_eq!(
            core.recoverable_tracks("ok").unwrap_err().code,
            "not_recoverable"
        );
        assert_eq!(
            core.recoverable_tracks("bad").unwrap_err().code,
            "unsafe_path"
        );
        let tracks = core.recoverable_tracks("rec").unwrap();
        assert_eq!(tracks.len(), 1, "finalized tracks are left alone");
        let (kind, original, copy) = &tracks[0];
        assert_eq!(copy, &folder.join("mic.recovered.wav"));
        let frames = audio::repair_wav(original, copy).unwrap();
        assert_eq!(frames, 999);
        core.mark_recovered("rec", kind, copy, frames).unwrap();
        let detail = core.get_meeting("rec").unwrap();
        let track = detail.tracks.iter().find(|t| t.kind == "mic").unwrap();
        assert!(track.finalized);
        assert_eq!(track.frames, 999);
        assert_eq!(track.path, copy.to_string_lossy());
        assert_eq!(
            detail.meeting.status, "interrupted",
            "still labelled as interrupted"
        );
        assert_eq!(
            std::fs::read(&mic).unwrap(),
            bytes,
            "original bytes unchanged"
        );
        assert_eq!(hound::WavReader::open(copy).unwrap().len(), 999);
        assert_eq!(
            core.recoverable_tracks("rec").unwrap_err().code,
            "not_recoverable"
        );
        assert_eq!(
            core.mark_recovered("rec", "mic", copy, 1).unwrap_err().code,
            "not_recoverable"
        );
    }

    #[test]
    fn migrations_preserve_populated_v5_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        {
            let db = Connection::open(&path).unwrap();
            for script in [
                include_str!("../migrations/001_foundation.sql"),
                include_str!("../migrations/002_capture.sql"),
                include_str!("../migrations/003_local_model.sql"),
                include_str!("../migrations/004_merge_model.sql"),
                include_str!("../migrations/005_transcripts.sql"),
            ] {
                db.execute_batch(script).unwrap();
            }
            db.execute_batch("PRAGMA foreign_keys = ON;
                INSERT INTO meetings(id, title, started_at, ended_at, source, status, capture_error) VALUES ('rec', 'Recorded', '2026-10-10T09:00:00Z', '2026-10-10T10:00:00Z', 'desktop', 'interrupted', 'Device lost');
                INSERT INTO meetings(id, title, started_at, source, status) VALUES ('fix', 'Fixture', '2026-10-10T08:00:00Z', 'fixture', 'stopped');
                INSERT INTO notes(meeting_id, user_markdown, revision) VALUES ('rec', 'Recorded notes', 3), ('fix', 'Fixture notes', 1);
                INSERT INTO segments(meeting_id, speaker, start_ms, end_ms, text, source, pass) VALUES ('rec', 'Others', 0, 900, 'Fictional words', 'whisper', 'final'), ('fix', 'You', 0, 100, 'Fixture words', 'fixture', 'final');
                INSERT INTO summaries(meeting_id, template_hash, model, provider, markdown) VALUES ('rec', 'summary-v1', 'openai/gpt-x', 'merge', 'Old summary'), ('rec', 'summary-v1', 'openai/gpt-y', 'merge', 'New summary');
                INSERT INTO tracks(meeting_id, kind, path, timing_path, device_name, sample_rate, channels, frames, finalized) VALUES ('rec', 'mic', 'mic.wav', 'mic.timing.jsonl', 'Mic', 48000, 1, 0, 0), ('rec', 'system', 'system.wav', 'system.timing.jsonl', 'Out', 48000, 2, 96000, 1);
                UPDATE settings SET vault_folder = 'saved-folder', microphone_id = 'mic', output_id = 'out', merge_model = 'openai/gpt-y';").unwrap();
        }
        let core = Core::open(&path).unwrap();
        let rec = core.get_meeting("rec").unwrap();
        assert_eq!(rec.meeting.status, "interrupted");
        assert_eq!(rec.meeting.capture_error.as_deref(), Some("Device lost"));
        assert_eq!(
            (rec.user_markdown.as_str(), rec.notes_revision),
            ("Recorded notes", 3)
        );
        assert_eq!(rec.segments[0].text, "Fictional words");
        assert_eq!(rec.summary.as_deref(), Some("New summary"));
        assert_eq!(rec.summary_template.as_deref(), Some("summary-v1"));
        assert_eq!(rec.tracks.len(), 2);
        assert!(!rec.tracks[0].finalized && rec.tracks[1].frames == 96000);
        let fix = core.get_meeting("fix").unwrap();
        assert_eq!(fix.user_markdown, "Fixture notes");
        assert_eq!(fix.segments.len(), 1);
        let settings = core.settings().unwrap();
        assert_eq!(settings.vault_folder.as_deref(), Some("saved-folder"));
        assert_eq!(settings.merge_model.as_deref(), Some("openai/gpt-y"));
        assert!(settings.export.transcript && settings.export.summary);
        assert_eq!(settings.export.filename, FilenamePattern::Title);
        let version: i64 = core
            .db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, LATEST_SCHEMA);
        let violations: i64 = core
            .db
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(violations, 0);
        // Cascades still work after the upgrade.
        core.db
            .execute("DELETE FROM meetings WHERE id = 'fix'", [])
            .unwrap();
        let orphans: i64 = core
            .db
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE meeting_id = 'fix'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(orphans, 0);
    }
}
