use crate::{audio, domain::*};
use rusqlite::{params, Connection, OptionalExtension};
#[cfg(test)]
use serde::Deserialize;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Highest `user_version` this build understands; bump with every new migration.
const LATEST_SCHEMA: i64 = 22;
const MAX_TAGS: usize = 20;
const MAX_TAG_CHARS: usize = 40;

pub struct Core {
    pub(crate) db: Connection,
    recording: RecordingState,
    audio_root: PathBuf,
    audio: Option<audio::Session>,
    capture_report: Option<audio::Report>,
    pub(crate) pending_processing: Option<crate::session_processing::Plan>,
    pub(crate) processing_owner: crate::processing_control::Owner,
    pub(crate) live_cancellation: Option<(String, std::sync::Arc<std::sync::atomic::AtomicBool>)>,
    pub(crate) live_receiver: Option<(
        String,
        std::sync::mpsc::Receiver<crate::live_audio::Chunk>,
        std::sync::Arc<std::sync::atomic::AtomicBool>,
    )>,
    pub(crate) quitting: bool,
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
            (8, include_str!("../migrations/008_stt_settings.sql"), false),
            (
                9,
                include_str!("../migrations/009_export_options.sql"),
                false,
            ),
            (
                10,
                include_str!("../migrations/010_provider_settings.sql"),
                false,
            ),
            (
                11,
                include_str!("../migrations/011_cloud_transcripts.sql"),
                false,
            ),
            (
                12,
                include_str!("../migrations/012_saved_connections.sql"),
                false,
            ),
            (
                13,
                include_str!("../migrations/013_session_processing.sql"),
                false,
            ),
            (
                14,
                include_str!("../migrations/014_processing_workflow.sql"),
                false,
            ),
            (
                15,
                include_str!("../migrations/015_summary_templates.sql"),
                false,
            ),
            (
                16,
                include_str!("../migrations/016_action_items.sql"),
                false,
            ),
            (
                17,
                include_str!("../migrations/017_summary_edits.sql"),
                false,
            ),
            (
                18,
                include_str!("../migrations/018_speaker_names.sql"),
                false,
            ),
            (
                19,
                include_str!("../migrations/019_transcript_edits.sql"),
                false,
            ),
            (
                20,
                include_str!("../migrations/020_summary_freshness.sql"),
                false,
            ),
            (
                21,
                include_str!("../migrations/021_meeting_tags.sql"),
                false,
            ),
            (
                22,
                include_str!("../migrations/022_question_threads.sql"),
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
        db.execute("UPDATE processing_runs SET stage='interrupted',error='Processing was interrupted. Review before retrying.' WHERE stage IN ('live','finalizing_audio','transcribing','awaiting_notes','summarizing')", [])?;
        db.execute(
            "UPDATE processing_sessions SET state='interrupted',revision=revision+1 WHERE state='prepared' AND meeting_id IN (SELECT meeting_id FROM processing_runs WHERE stage='interrupted')",
            [],
        )?;
        Ok(Self {
            db,
            recording: RecordingState::default(),
            audio_root: path.parent().unwrap_or(Path::new(".")).join("audio"),
            audio: None,
            capture_report: None,
            pending_processing: None,
            processing_owner: crate::processing_control::Owner::default(),
            live_cancellation: None,
            live_receiver: None,
            quitting: false,
        })
    }

    pub fn recording_state(&self) -> RecordingState {
        RecordingState {
            recording_offset_ms: self.audio.as_ref().map(audio::Session::offset_ms),
            ..self.recording.clone()
        }
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

    #[cfg(test)]
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
            recording_offset_ms: None,
        };
        Ok(self.recording_state())
    }

    pub fn start_desktop(
        &mut self,
        title: &str,
        options: audio::CaptureOptions,
        consent: bool,
        processing_confirmation: Option<&str>,
    ) -> Result<RecordingState> {
        if !consent {
            return Err(AppError::new(
                "consent_required",
                "Confirm participant consent before recording.",
            ));
        }
        let title = self.begin(title)?;
        let processing = self.confirmed_session_processing(processing_confirmation)?;
        if options.microphone_id.is_empty() || options.output_id.is_empty() {
            return Err(AppError::new(
                "audio_devices",
                "Select both a microphone and a system-output device.",
            ));
        }
        let id = Uuid::new_v4().to_string();
        std::fs::create_dir_all(&self.audio_root)?;
        if processing
            .as_ref()
            .is_some_and(|plan| plan.meeting_id.is_some())
        {
            return Err(AppError::new(
                "session_consent_changed",
                "A retry review cannot authorize a new recording.",
            ));
        }
        let live_enabled = processing.as_ref().is_some_and(|plan| match plan.scope {
            crate::session_processing::Scope::LiveOnly { .. } => true,
            crate::session_processing::Scope::Final { live, .. } => live,
        });
        let (producer, receiver, incomplete) = crate::live_audio::channel();
        let session = audio::Session::prepare(
            self.audio_root.join(&id),
            options.clone(),
            live_enabled.then_some(producer),
        )?;
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
        if let Some(plan) = &processing {
            crate::session_processing::attach(&tx, plan, &id)?;
        }
        tx.commit()?;
        self.pending_processing = None;
        if processing.is_some() {
            self.live_receiver = Some((id.clone(), receiver, incomplete));
        }
        self.audio = Some(session);
        self.recording = RecordingState {
            revision: self.recording.revision + 1,
            status: CaptureStatus::Paused,
            meeting_id: Some(id),
            source: Some("desktop".into()),
            error: None,
            recording_offset_ms: None,
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
            #[cfg(test)]
            {
                self.transition(CaptureStatus::Recording, CaptureStatus::Paused, "paused")
            }
            #[cfg(not(test))]
            {
                Err(AppError::new(
                    "invalid_state",
                    "The audio capture session is unavailable.",
                ))
            }
        }
    }

    pub fn resume(&mut self) -> Result<RecordingState> {
        if self.capture_report.is_some() {
            return Err(AppError::new(
                "invalid_state",
                "Audio has stopped. Retry finalization before starting another recording.",
            ));
        }
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
            #[cfg(test)]
            {
                self.transition(CaptureStatus::Paused, CaptureStatus::Recording, "recording")
            }
            #[cfg(not(test))]
            {
                Err(AppError::new(
                    "invalid_state",
                    "The audio capture session is unavailable.",
                ))
            }
        }
    }

    #[cfg(test)]
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
        if let Some((id, cancel)) = &self.live_cancellation {
            if self.recording.meeting_id.as_deref() == Some(id) {
                cancel.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        if let Some(mut audio) = self.audio.take() {
            self.recording.status = CaptureStatus::Stopped;
            self.recording.revision += 1;
            self.capture_report = Some(match audio.stop() {
                Ok(report) => report,
                Err(error) if error.code == "audio_worker_busy" => {
                    self.audio = Some(audio);
                    self.recording.status = CaptureStatus::Paused;
                    self.recording.error = Some(error.message.clone());
                    self.db.execute(
                        "UPDATE meetings SET status = 'paused', capture_error = ?1 WHERE id = ?2",
                        params![error.message, self.recording.meeting_id],
                    )?;
                    return Err(error);
                }
                Err(error) => audio::Report {
                    tracks: audio.tracks.clone(),
                    error: Some(error.message),
                },
            });
        }
        if let Some(report) = &self.capture_report {
            // Keep Stop actionable until SQLite accepts the retained report; audio is already closed.
            if self.recording.status != CaptureStatus::Paused {
                self.recording.status = CaptureStatus::Paused;
                self.recording.revision += 1;
            }
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
            if let Some(id) = self.recording.meeting_id.as_deref() {
                crate::session_workflow::stopped(
                    &tx,
                    id,
                    report.error.is_none()
                        && report.tracks.len() == 2
                        && report
                            .tracks
                            .iter()
                            .all(|track| track.finalized && track.frames > 0),
                    self.quitting,
                )?;
            }
            tx.commit()?;
            self.capture_report = None;
            self.recording.status = CaptureStatus::Stopped;
            self.recording.revision += 1;
        }
        #[cfg(test)]
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
        let mut meetings = query
            .query_map([], meeting_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut tags = self
            .db
            .prepare("SELECT meeting_id, tag FROM meeting_tags ORDER BY tag")?;
        let mut by_meeting = std::collections::HashMap::<String, Vec<String>>::new();
        for row in tags.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (meeting_id, tag) = row?;
            by_meeting.entry(meeting_id).or_default().push(tag);
        }
        for meeting in &mut meetings {
            meeting.tags = by_meeting.remove(&meeting.id).unwrap_or_default();
        }
        Ok(meetings)
    }

    pub fn get_meeting(&self, id: &str) -> Result<MeetingDetail> {
        let mut meeting = self.db.query_row(
            "SELECT id, title, started_at, ended_at, status, source, capture_error FROM meetings WHERE id = ?1",
            [id], meeting_row,
        ).optional()?.ok_or_else(|| AppError::new("not_found", "Meeting not found."))?;
        meeting.tags = self.meeting_tags(id)?;
        let (user_markdown, notes_revision) = self.db.query_row(
            "SELECT user_markdown, revision FROM notes WHERE meeting_id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let mut query = self.db.prepare("SELECT speaker, start_ms, end_ms, text, id, original_text FROM segments WHERE meeting_id = ?1 ORDER BY start_ms IS NULL, start_ms, id")?;
        let (segments, segment_meta): (Vec<_>, Vec<_>) = query
            .query_map([id], |row| {
                Ok((
                    Segment {
                        speaker: row.get(0)?,
                        timing: match row.get::<_, Option<i64>>(1)? {
                            Some(start_ms) => SegmentTiming::Timed {
                                start_ms,
                                end_ms: row.get(2)?,
                            },
                            None => SegmentTiming::Untimed,
                        },
                        text: row.get(3)?,
                    },
                    SegmentMeta {
                        id: row.get(4)?,
                        original_text: row.get(5)?,
                    },
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .unzip();
        let (summary, summary_provider, summary_model, summary_template, summary_edited, summary_hash) = self
            .db
            .query_row(
                "SELECT markdown, provider, model, template_hash, edited_from IS NOT NULL, transcript_hash FROM summaries WHERE meeting_id = ?1 ORDER BY id DESC LIMIT 1",
                [id],
                |row| Ok((Some(row.get(0)?), Some(row.get(1)?), Some(row.get(2)?), Some(row.get(3)?), row.get(4)?, row.get::<_, Option<String>>(5)?)),
            )
            .optional()?
            .unwrap_or((None, None, None, None, false, None));
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
        let (transcript_provider, transcript_model) = self
            .db
            .query_row(
                "SELECT provider, model FROM meeting_transcriptions WHERE meeting_id = ?1",
                [id],
                |row| Ok((Some(row.get(0)?), row.get(1)?)),
            )
            .optional()?
            .unwrap_or((None, None));
        let action_items = self.action_items(id)?;
        let speaker_names = self.speaker_names(id)?;
        let transcript_versions = self.transcript_versions(id)?;
        let question_threads = self.question_threads(id)?;
        let summary_stale =
            summary_hash.is_some_and(|hash| hash != transcript_hash(&segments, &speaker_names));
        Ok(MeetingDetail {
            question_threads,
            summary_stale,
            segment_meta,
            transcript_versions,
            speaker_names,
            action_items,
            summary_edited,
            meeting,
            user_markdown,
            notes_revision,
            segments,
            summary,
            summary_provider,
            summary_model,
            tracks,
            summary_template,
            transcript_provider,
            transcript_model,
        })
    }

    /// Transcript and provenance publish together; failures preserve the previous run and notes.
    pub fn replace_transcript(
        &mut self,
        id: &str,
        segments: &[Segment],
        provider: &str,
        model: &str,
    ) -> Result<()> {
        let tx = self.db.transaction()?;
        replace_transcript_in(&tx, id, segments, provider, model)?;
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
        // Callers refuse to publish when the transcript changed during generation, so the
        // current transcript is the one this summary read.
        let detail = self.get_meeting(id)?;
        let hash = transcript_hash(&detail.segments, &detail.speaker_names);
        self.db.execute(
            "INSERT INTO summaries(meeting_id, template_hash, model, provider, markdown, transcript_hash) VALUES (?1, ?5, ?2, ?3, ?4, ?6)",
            params![id, model, provider, markdown, template, hash],
        )?;
        Ok(())
    }

    pub fn speaker_names(&self, id: &str) -> Result<SpeakerNames> {
        let mut names = SpeakerNames::default();
        let mut query = self
            .db
            .prepare("SELECT speaker, name FROM speaker_names WHERE meeting_id=?1")?;
        for row in query.query_map([id], |row| Ok((row.get::<_, String>(0)?, row.get(1)?)))? {
            let (speaker, name) = row?;
            match speaker.as_str() {
                "You" => names.you = Some(name),
                _ => names.others = Some(name),
            }
        }
        Ok(names)
    }

    /// Empty names clear the label back to "You"/"Others".
    pub fn save_speaker_names(
        &mut self,
        id: &str,
        you: Option<&str>,
        others: Option<&str>,
    ) -> Result<SpeakerNames> {
        let clean = |value: Option<&str>| -> Result<Option<String>> {
            let value = value.unwrap_or("").trim();
            if value.chars().count() > 80 || value.chars().any(char::is_control) {
                return Err(AppError::new(
                    "speaker_name",
                    "Keep each speaker name on one line, at most 80 characters.",
                ));
            }
            Ok((!value.is_empty()).then(|| value.to_string()))
        };
        let names = [("You", clean(you)?), ("Others", clean(others)?)];
        self.get_meeting(id)?;
        let tx = self.db.transaction()?;
        for (speaker, name) in names {
            match name {
                Some(name) => tx.execute(
                    "INSERT INTO speaker_names(meeting_id,speaker,name) VALUES (?1,?2,?3) ON CONFLICT(meeting_id,speaker) DO UPDATE SET name=excluded.name",
                    params![id, speaker, name],
                )?,
                None => tx.execute(
                    "DELETE FROM speaker_names WHERE meeting_id=?1 AND speaker=?2",
                    params![id, speaker],
                )?,
            };
        }
        tx.commit()?;
        self.speaker_names(id)
    }

    /// Saves the user's edit of `base_id` as the newest version, keeping every earlier one. Refuses
    /// when another version arrived since editing began, so neither side replaces the other silently.
    pub fn save_summary_edit(
        &mut self,
        id: &str,
        base_id: i64,
        expected_latest_id: i64,
        markdown: &str,
    ) -> Result<()> {
        if markdown.trim().is_empty() || markdown.len() > MAX_SUMMARY_EDIT_BYTES {
            return Err(AppError::new(
                "summary_edit",
                "Enter summary text of at most 2 MiB.",
            ));
        }
        let tx = self.db.transaction()?;
        let latest: Option<i64> = tx.query_row(
            "SELECT max(id) FROM summaries WHERE meeting_id=?1",
            [id],
            |row| row.get(0),
        )?;
        if latest != Some(expected_latest_id) {
            return Err(AppError::new(
                "summary_conflict",
                "A newer summary version arrived while you were editing. Review it in the version picker; saving again puts your edit on top of it.",
            ));
        }
        let (base, template, model, provider, hash): (String, String, String, String, Option<String>) = tx
            .query_row(
                "SELECT markdown, template_hash, model, provider, transcript_hash FROM summaries WHERE id=?1 AND meeting_id=?2",
                params![base_id, id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::new("not_found", "This summary version is not available."))?;
        if base == markdown {
            return Err(AppError::new(
                "summary_edit",
                "The summary is unchanged. Nothing was saved.",
            ));
        }
        // Provenance and freshness of the edited output are kept; `edited_from` marks the text as the user's.
        tx.execute(
            "INSERT INTO summaries(meeting_id, template_hash, model, provider, markdown, edited_from, transcript_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, template, model, provider, markdown, base_id, hash],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Every summary version, newest first. The table has no timestamp, so ids order them.
    pub fn list_summaries(&self, id: &str) -> Result<Vec<SummaryVersion>> {
        let current = match self.get_meeting(id) {
            Ok(detail) => transcript_hash(&detail.segments, &detail.speaker_names),
            Err(error) if error.code == "not_found" => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut query = self.db.prepare(
            "SELECT id, provider, model, template_hash, markdown, edited_from, transcript_hash FROM summaries WHERE meeting_id = ?1 ORDER BY id DESC",
        )?;
        let versions = query
            .query_map([id], |row| {
                Ok(SummaryVersion {
                    id: row.get(0)?,
                    provider: row.get(1)?,
                    model: row.get(2)?,
                    template: row.get(3)?,
                    markdown: row.get(4)?,
                    edited_from: row.get(5)?,
                    stale: row
                        .get::<_, Option<String>>(6)?
                        .is_some_and(|hash| hash != current),
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
        read_settings(&self.db)
    }

    pub fn api_connection(&self, id: &str) -> Result<SavedConnection> {
        self.db.query_row("SELECT id,name,base_url,revision,credential_account FROM saved_connections WHERE id=?1", [id], saved_connection_row).optional()?.ok_or_else(provider_conflict)
    }

    pub fn save_api_connection(
        &mut self,
        id: Option<&str>,
        name: &str,
        base_url: &str,
        credential_account: Option<&str>,
        expected_revision: Option<i64>,
    ) -> Result<Settings> {
        let name = name.trim();
        if name.is_empty() || name.len() > 120 || name.chars().any(char::is_control) {
            return Err(AppError::new(
                "provider_name",
                "Enter a connection name of at most 120 bytes without control characters.",
            ));
        }
        let base_url = crate::providers::validate_base_url(base_url)?;
        let tx = self.db.transaction()?;
        let previous = id.map(|id| {
            tx.query_row("SELECT id,name,base_url,revision,credential_account FROM saved_connections WHERE id=?1", [id], saved_connection_row).optional()?.ok_or_else(provider_conflict)
        }).transpose()?;
        if previous.as_ref().map(|c| c.revision) != expected_revision {
            return Err(provider_conflict());
        }
        let revision = expected_revision
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(provider_conflict)?;
        let destination_changed = previous.as_ref().is_some_and(|c| c.base_url != base_url);
        if destination_changed
            && ((credential_account.is_none() && !crate::providers::is_local_base(&base_url))
                || (credential_account.is_some()
                    && previous
                        .as_ref()
                        .and_then(|c| c.credential_account.as_deref())
                        == credential_account))
        {
            return Err(AppError::new(
                "provider_key_required",
                "Enter a new API key when changing the provider URL.",
            ));
        }
        let id = id
            .map(str::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        tx.execute("INSERT INTO saved_connections(id,name,base_url,credential_account,revision) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,credential_account=excluded.credential_account,revision=excluded.revision", params![id,name,base_url,credential_account,revision])?;
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM provider_assignments WHERE connection_id=?1 AND revision=?2)", params![id,i64::MAX], |row| row.get::<_,bool>(0))? { return Err(provider_conflict()); }
        tx.execute(
            "UPDATE provider_assignments SET revision=revision+1 WHERE connection_id=?1",
            [&id],
        )?;
        let settings = read_settings(&tx)?;
        tx.commit()?;
        Ok(settings)
    }

    pub fn delete_api_connection(&mut self, id: &str, expected_revision: i64) -> Result<Settings> {
        let tx = self.db.transaction()?;
        if tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM provider_assignments WHERE connection_id=?1)",
            [id],
            |row| row.get::<_, bool>(0),
        )? {
            return Err(AppError::new(
                "provider_assigned",
                "Unassign this connection from all tasks before deleting it.",
            ));
        }
        if tx.execute(
            "DELETE FROM saved_connections WHERE id=?1 AND revision=?2",
            params![id, expected_revision],
        )? != 1
        {
            return Err(provider_conflict());
        }
        let settings = read_settings(&tx)?;
        tx.commit()?;
        Ok(settings)
    }

    pub fn save_provider_assignment(
        &mut self,
        role: ProviderRole,
        selection: &ProviderSelection,
        expected_revision: Option<i64>,
    ) -> Result<Settings> {
        let tx = self.db.transaction()?;
        let (assigned, revision): (Option<String>, i64) = tx.query_row(
            "SELECT connection_id,revision FROM provider_assignments WHERE role=?1",
            [role.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if assigned.as_ref().map(|_| revision) != expected_revision {
            return Err(provider_conflict());
        }
        let next = revision.checked_add(1).ok_or_else(provider_conflict)?;
        let (id, model) = match selection {
            ProviderSelection::Unassigned => (None, None),
            ProviderSelection::Assigned {
                connection_id,
                model,
            } => {
                crate::providers::validate_model(model)?;
                if !tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM saved_connections WHERE id=?1)",
                    [connection_id],
                    |row| row.get::<_, bool>(0),
                )? {
                    return Err(provider_conflict());
                }
                (Some(connection_id.as_str()), Some(model.as_str()))
            }
        };
        tx.execute(
            "UPDATE provider_assignments SET connection_id=?1,model=?2,revision=?3 WHERE role=?4",
            params![id, model, next, role.as_str()],
        )?;
        let settings = read_settings(&tx)?;
        tx.commit()?;
        Ok(settings)
    }

    pub fn save_stt_mode(&mut self, mode: SttMode) -> Result<Settings> {
        self.db.execute(
            "UPDATE settings SET stt_mode = ?1 WHERE id = 1",
            [match mode {
                SttMode::Local => "local",
                SttMode::Cloud => "cloud",
            }],
        )?;
        self.settings()
    }

    pub fn save_shortcuts(&mut self, pause: &str, stop: Option<&str>) -> Result<Settings> {
        self.db.execute(
            "UPDATE settings SET pause_shortcut = ?1, stop_shortcut = ?2 WHERE id = 1",
            params![pause, stop],
        )?;
        self.settings()
    }

    pub fn save_stt_settings(
        &mut self,
        language: &str,
        prompt: &str,
        model: &str,
    ) -> Result<Settings> {
        let prompt = prompt.trim();
        crate::stt::validate(language, prompt, model)?;
        self.db.execute(
            "UPDATE settings SET stt_language = ?1, stt_prompt = ?2, stt_model = ?3 WHERE id = 1",
            params![language, prompt, model],
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

    #[cfg(test)]
    pub fn create_fixture(&mut self) -> Result<String> {
        #[derive(Deserialize)]
        struct Fixture {
            title: String,
            notes: String,
            summary: String,
            segments: Vec<FixtureSegment>,
        }
        #[derive(Deserialize)]
        struct FixtureSegment {
            speaker: String,
            start_ms: i64,
            end_ms: i64,
            text: String,
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
        // Recovery leaves the original partial WAV unreferenced beside its recovered copy,
        // so also take every other regular file directly in the folder (links are left alone).
        if let Some(folder) = &folder {
            for entry in std::fs::read_dir(folder)? {
                let entry = entry?;
                if entry.file_type()?.is_file() && !files.contains(&entry.path()) {
                    files.push(entry.path());
                }
            }
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
            "SELECT meeting_id, kind, snippet(search, 2, '', '', '…', 12) FROM search WHERE search MATCH ?1 ORDER BY rank LIMIT 200",
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

    /// Segment ids (the transcript rows' rowids) of the in-scope meetings that match any of
    /// `terms`, best bm25 match first. Terms reach FTS5 only as quoted strings.
    pub fn transcript_hits(&self, meeting_ids: &[String], terms: &[String]) -> Result<Vec<i64>> {
        let Some(query) = crate::retrieval::fts_query(terms) else {
            return Ok(Vec::new());
        };
        let marks = vec!["?"; meeting_ids.len()].join(", ");
        let mut statement = self.db.prepare(&format!(
            "SELECT rowid FROM search WHERE search MATCH ?1 AND kind = 'transcript' AND meeting_id IN ({marks}) ORDER BY rank LIMIT {}",
            crate::retrieval::MAX_HITS
        ))?;
        let params = std::iter::once(&query).chain(meeting_ids);
        let rows = statement.query_map(rusqlite::params_from_iter(params), |row| row.get(0))?;
        Ok(rows.collect::<std::result::Result<Vec<i64>, _>>()?)
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

    fn meeting_tags(&self, id: &str) -> Result<Vec<String>> {
        let mut query = self
            .db
            .prepare("SELECT tag FROM meeting_tags WHERE meeting_id = ?1 ORDER BY tag")?;
        let tags = query
            .query_map([id], |row| row.get(0))?
            .collect::<std::result::Result<Vec<String>, _>>()?;
        Ok(tags)
    }

    /// Replaces a meeting's tags with the validated, case-insensitively deduplicated list and returns it sorted.
    pub fn set_meeting_tags(&mut self, id: &str, tags: &[String]) -> Result<Vec<String>> {
        let mut clean: Vec<String> = Vec::new();
        for tag in tags {
            let tag = tag.trim();
            if tag.is_empty() {
                continue;
            }
            if tag.chars().count() > MAX_TAG_CHARS || tag.chars().any(char::is_control) {
                return Err(AppError::new(
                    "meeting_tag",
                    "Use tags of 1 to 40 characters on one line.",
                ));
            }
            if !clean.iter().any(|t| t.to_lowercase() == tag.to_lowercase()) {
                clean.push(tag.to_string());
            }
        }
        if clean.len() > MAX_TAGS {
            return Err(AppError::new(
                "meeting_tag",
                "Use at most 20 tags per meeting.",
            ));
        }
        let tx = self.db.transaction()?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM meetings WHERE id = ?1)",
            [id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(AppError::new("not_found", "Meeting not found."));
        }
        tx.execute("DELETE FROM meeting_tags WHERE meeting_id = ?1", [id])?;
        for tag in &clean {
            tx.execute(
                "INSERT INTO meeting_tags (meeting_id, tag) VALUES (?1, ?2)",
                params![id, tag],
            )?;
        }
        tx.commit()?;
        self.meeting_tags(id)
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

    /// Personal instructions added to every later summary request, manual or automatic.
    pub fn save_summary_instructions(&mut self, instructions: &str) -> Result<Settings> {
        let instructions = instructions.trim();
        crate::llm::validate_instructions(instructions, MAX_SUMMARY_INSTRUCTIONS)?;
        self.db.execute(
            "UPDATE settings SET summary_instructions = ?1 WHERE id = 1",
            [instructions],
        )?;
        self.settings()
    }

    /// Creates a template when `id` is `None`; otherwise replaces an existing one.
    pub fn save_summary_template(
        &mut self,
        id: Option<&str>,
        name: &str,
        instructions: &str,
    ) -> Result<Settings> {
        let (name, instructions) = (name.trim(), instructions.trim());
        if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
            return Err(AppError::new(
                "summary_template",
                "Enter a template name of 1–80 characters on one line.",
            ));
        }
        crate::llm::validate_instructions(instructions, MAX_TEMPLATE_INSTRUCTIONS)?;
        if instructions.is_empty() {
            return Err(AppError::new(
                "summary_template",
                "Describe the summary structure for this template.",
            ));
        }
        let changed = match id {
            Some(id) => self.db.execute(
                "UPDATE summary_templates SET name=?2,instructions=?3 WHERE id=?1",
                params![id, name, instructions],
            )?,
            None => {
                let count: i64 =
                    self.db
                        .query_row("SELECT COUNT(*) FROM summary_templates", [], |row| {
                            row.get(0)
                        })?;
                if count >= MAX_CUSTOM_TEMPLATES {
                    return Err(AppError::new(
                        "summary_template",
                        format!("You can save up to {MAX_CUSTOM_TEMPLATES} custom templates."),
                    ));
                }
                self.db.execute(
                    "INSERT INTO summary_templates(id,name,instructions) VALUES (?1,?2,?3)",
                    params![
                        format!("{CUSTOM_TEMPLATE_PREFIX}{}", Uuid::new_v4()),
                        name,
                        instructions
                    ],
                )?
            }
        };
        if changed != 1 {
            return Err(missing_template());
        }
        self.settings()
    }

    /// Existing summaries keep their stored text; history shows a fallback label afterwards.
    pub fn delete_summary_template(&mut self, id: &str) -> Result<Settings> {
        if self
            .db
            .execute("DELETE FROM summary_templates WHERE id=?1", [id])?
            != 1
        {
            return Err(missing_template());
        }
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
            let copy =
                original.with_file_name(format!("{}.recovered-{}.wav", track.kind, Uuid::new_v4()));
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

fn provider_conflict() -> AppError {
    AppError::new("provider_conflict", "Provider settings changed elsewhere. Reload Settings and try again; nothing was overwritten.")
}

fn read_settings(db: &Connection) -> Result<Settings> {
    let connection = |role: ProviderRole| {
        db.query_row(
                "SELECT c.base_url, a.model, a.revision, c.credential_account FROM provider_assignments a JOIN saved_connections c ON c.id = a.connection_id WHERE a.role = ?1",
                [role.as_str()],
                provider_row,
            ).optional()
    };
    let saved_connections = db.prepare("SELECT id,name,base_url,revision,credential_account FROM saved_connections ORDER BY name,id")?
            .query_map([], saved_connection_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    let assignment = |role: ProviderRole| {
        db.query_row("SELECT connection_id,model,revision FROM provider_assignments WHERE role=?1 AND connection_id IS NOT NULL", [role.as_str()], |row| Ok(ProviderAssignment {connection_id:row.get(0)?,model:row.get(1)?,revision:row.get(2)?})).optional()
    };
    let provider_assignments = ProviderAssignments {
        llm: assignment(ProviderRole::Llm)?,
        cloud_stt: assignment(ProviderRole::CloudStt)?,
    };
    let llm = connection(ProviderRole::Llm)?;
    let cloud_stt = connection(ProviderRole::CloudStt)?;
    let summary_templates = db
        .prepare("SELECT id,name,instructions FROM summary_templates ORDER BY name,id")?
        .query_map([], |row| {
            Ok(CustomTemplate {
                id: row.get(0)?,
                name: row.get(1)?,
                instructions: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(db.query_row(
            "SELECT vault_folder, pause_shortcut, microphone_id, output_id, stt_mode, export_transcript, export_summary, export_filename, stt_language, stt_prompt, stt_model, stop_shortcut, summary_instructions FROM settings WHERE id = 1",
            [],
            |row| {
                Ok(Settings {
                    vault_folder: row.get(0)?,
                    pause_shortcut: row.get(1)?,
                    microphone_id: row.get(2)?,
                    output_id: row.get(3)?,
                    saved_connections,
                    provider_assignments,
                    llm,
                    cloud_stt,
                    stt_mode: match row.get::<_, String>(4)?.as_str() {
                        "cloud" => SttMode::Cloud,
                        _ => SttMode::Local,
                    },
                    export: ExportOptions {
                        transcript: row.get(5)?,
                        summary: row.get(6)?,
                        // The column CHECK constraint allows only these two values.
                        filename: match row.get::<_, String>(7)?.as_str() {
                            "date_title" => FilenamePattern::DateTitle,
                            _ => FilenamePattern::Title,
                        },
                    },
                    stt_language: row.get(8)?,
                    stt_prompt: row.get(9)?,
                    stt_model: row.get(10)?,
                    stop_shortcut: row.get(11)?,
                    summary_instructions: row.get(12)?,
                    summary_templates,
                })
            },
        )?)
}

/// SHA-256 of the exact transcript lines a summary reads, speaker names included.
pub(crate) fn transcript_hash(segments: &[Segment], names: &SpeakerNames) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(crate::transcript_lines(segments, names).join("\n"))
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub const CUSTOM_TEMPLATE_PREFIX: &str = "custom-";
const MAX_SUMMARY_EDIT_BYTES: usize = 2 * 1024 * 1024;
const MAX_CUSTOM_TEMPLATES: i64 = 50;
const MAX_TEMPLATE_INSTRUCTIONS: usize = 4000;
const MAX_SUMMARY_INSTRUCTIONS: usize = 2000;

pub fn missing_template() -> AppError {
    AppError::new(
        "summary_template_missing",
        "This summary template no longer exists. Choose another template.",
    )
}

fn saved_connection_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedConnection> {
    Ok(SavedConnection {
        id: row.get(0)?,
        name: row.get(1)?,
        base_url: row.get(2)?,
        revision: row.get(3)?,
        credential_account: row.get(4)?,
    })
}

fn provider_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProviderConfig> {
    Ok(ProviderConfig {
        base_url: row.get(0)?,
        model: row.get(1)?,
        revision: row.get(2)?,
        credential_account: row.get(3)?,
    })
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
        tags: Vec::new(),
    })
}

/// Returns the trimmed title if it has 1–160 characters.
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

pub(crate) fn replace_transcript_in(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
    segments: &[Segment],
    provider: &str,
    model: &str,
) -> Result<()> {
    crate::transcript_edits::snapshot(tx, id)?;
    tx.execute(
        "DELETE FROM segments WHERE meeting_id = ?1 AND source IN ('whisper', 'cloud_stt')",
        [id],
    )?;
    let source = if provider == "whisper" {
        "whisper"
    } else {
        "cloud_stt"
    };
    for segment in segments {
        let (start_ms, end_ms) = match segment.timing {
            SegmentTiming::Timed { start_ms, end_ms } => (Some(start_ms), Some(end_ms)),
            SegmentTiming::Untimed => (None, None),
        };
        tx.execute(
                "INSERT INTO segments(meeting_id, speaker, start_ms, end_ms, text, source, pass) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'final')",
                params![id, segment.speaker, start_ms, end_ms, segment.text, source],
            )?;
    }
    tx.execute(
            "INSERT INTO meeting_transcriptions(meeting_id, provider, model) VALUES (?1, ?2, ?3) ON CONFLICT(meeting_id) DO UPDATE SET provider = excluded.provider, model = excluded.model",
            params![id, provider, model],
        )?;
    Ok(())
}

#[cfg(test)]
pub(crate) fn test_v11_database(path: &Path) -> Connection {
    let db = Connection::open(path).unwrap();
    for script in [
        include_str!("../migrations/001_foundation.sql"),
        include_str!("../migrations/002_capture.sql"),
        include_str!("../migrations/003_local_model.sql"),
        include_str!("../migrations/004_merge_model.sql"),
        include_str!("../migrations/005_transcripts.sql"),
        include_str!("../migrations/006_note_meetings.sql"),
        include_str!("../migrations/007_search.sql"),
        include_str!("../migrations/008_stt_settings.sql"),
        include_str!("../migrations/009_export_options.sql"),
        include_str!("../migrations/010_provider_settings.sql"),
        include_str!("../migrations/011_cloud_transcripts.sql"),
    ] {
        db.execute_batch(script).unwrap();
    }
    db
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
    fn restart_interrupts_active_processing_without_changing_completed_grants() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("meetings.db");
        let mut core = Core::open(&path).unwrap();
        let mut ids = Vec::new();
        for completed in [true, false] {
            let id = core.create_note("Synthetic restart check").unwrap();
            let plan = core
                .prepare_session_processing(crate::session_processing::Request::Final {
                    live: false,
                    summary: None,
                })
                .unwrap();
            core.db
                .execute(
                    "UPDATE meetings SET source='desktop',status='paused' WHERE id=?1",
                    [&id],
                )
                .unwrap();
            let tx = core.db.transaction().unwrap();
            crate::session_processing::attach(&tx, &plan, &id).unwrap();
            if completed {
                tx.execute("UPDATE processing_runs SET stage='completed',transcript_done=1 WHERE meeting_id=?1", [&id]).unwrap();
                tx.execute("UPDATE meetings SET status='stopped' WHERE id=?1", [&id])
                    .unwrap();
            }
            tx.commit().unwrap();
            ids.push(id);
        }
        drop(core);
        let core = Core::open(&path).unwrap();
        let completed = core.session_processing(&ids[0]).unwrap().unwrap();
        assert_eq!(completed.state, crate::session_processing::State::Prepared);
        assert_eq!(
            completed.workflow.unwrap().stage,
            crate::session_workflow::Stage::Completed
        );
        let interrupted = core.session_processing(&ids[1]).unwrap().unwrap();
        assert_eq!(
            interrupted.state,
            crate::session_processing::State::Interrupted
        );
        assert_eq!(
            interrupted.workflow.unwrap().stage,
            crate::session_workflow::Stage::Interrupted
        );
    }

    #[test]
    fn failed_capture_publication_keeps_the_report_for_an_atomic_retry() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("meetings.db");
        let mut core = Core::open(&path).unwrap();
        let id = core.create_note("Synthetic publication check").unwrap();
        core.save_notes(&id, "Keep these notes", 0).unwrap();
        core.db
            .execute(
                "UPDATE meetings SET source='desktop',status='paused' WHERE id=?1",
                [&id],
            )
            .unwrap();
        let plan = core
            .prepare_session_processing(crate::session_processing::Request::Final {
                live: false,
                summary: None,
            })
            .unwrap();
        let tx = core.db.transaction().unwrap();
        crate::session_processing::attach(&tx, &plan, &id).unwrap();
        tx.commit().unwrap();
        core.db
            .execute(
                "UPDATE meetings SET source = 'desktop', status = 'recording' WHERE id = ?1",
                [&id],
            )
            .unwrap();
        for kind in ["mic", "system"] {
            core.db.execute("INSERT INTO tracks(meeting_id, kind, path, timing_path, device_name, sample_rate, channels) VALUES (?1, ?2, ?3, ?4, 'Synthetic', 16000, 1)", params![id, kind, format!("{kind}.wav"), format!("{kind}.timing.jsonl")]).unwrap();
        }
        let mut tracks = core.get_meeting(&id).unwrap().tracks;
        for track in &mut tracks {
            track.frames = 16000;
            track.finalized = true;
        }
        core.recording = RecordingState {
            status: CaptureStatus::Stopped,
            meeting_id: Some(id.clone()),
            source: Some("desktop".into()),
            revision: 2,
            ..RecordingState::default()
        };
        core.capture_report = Some(audio::Report {
            tracks,
            error: None,
        });
        core.db.execute_batch("CREATE TRIGGER fail_track_publication BEFORE UPDATE ON tracks WHEN OLD.kind = 'system' BEGIN SELECT RAISE(ABORT, 'synthetic publication failure'); END;").unwrap();
        assert_eq!(core.stop().unwrap_err().code, "database");
        assert!(core.capture_report.is_some());
        assert_eq!(core.recording_state().status, CaptureStatus::Paused);
        assert!(core.recording_state().recording_offset_ms.is_none());
        assert_eq!(core.resume().unwrap_err().code, "invalid_state");
        assert_eq!(
            core.processing_workflow(&id).unwrap().unwrap().stage,
            crate::session_workflow::Stage::Live
        );
        let detail = core.get_meeting(&id).unwrap();
        assert!(detail
            .tracks
            .iter()
            .all(|track| track.frames == 0 && !track.finalized));
        assert_eq!(detail.meeting.status, "recording");
        assert_eq!(detail.user_markdown, "Keep these notes");
        assert_eq!(
            core.start("Must remain blocked").unwrap_err().code,
            "already_recording"
        );
        core.db
            .execute_batch("DROP TRIGGER fail_track_publication;")
            .unwrap();
        assert_eq!(core.stop().unwrap().status, CaptureStatus::Stopped);
        assert!(core.capture_report.is_none());
        let scheduled = core.session_processing(&id).unwrap().unwrap();
        assert_eq!(
            scheduled.workflow.as_ref().unwrap().stage,
            crate::session_workflow::Stage::FinalizingAudio
        );
        assert_eq!(scheduled.workflow.as_ref().unwrap().run_id, plan.id);
        let recording_revision = core.recording_state().revision;
        core.stop().unwrap();
        let duplicate = core.session_processing(&id).unwrap().unwrap();
        assert_eq!(duplicate.revision, scheduled.revision);
        assert_eq!(duplicate.workflow.unwrap().run_id, plan.id);
        assert_eq!(core.recording_state().revision, recording_revision);
        drop(core);
        let detail = Core::open(&path).unwrap().get_meeting(&id).unwrap();
        assert!(detail
            .tracks
            .iter()
            .all(|track| track.frames == 16000 && track.finalized));
        assert_eq!(detail.meeting.status, "stopped");
        assert!(detail.meeting.ended_at.is_some());
        assert_eq!(detail.user_markdown, "Keep these notes");
    }

    #[test]
    fn stop_timeout_retains_the_writer_until_late_finalization_finishes() {
        let folder = tempfile::tempdir().unwrap();
        let mut core = Core::open(&folder.path().join("meetings.db")).unwrap();
        let id = core.create_note("Synthetic stalled writer").unwrap();
        core.db
            .execute(
                "UPDATE meetings SET source = 'desktop', status = 'recording' WHERE id = ?1",
                [&id],
            )
            .unwrap();
        let (session, release, finished) =
            audio::pending_writer_for_test(&core.audio_root.join(&id));
        for track in &session.tracks {
            core.db.execute("INSERT INTO tracks(meeting_id, kind, path, timing_path, device_name, sample_rate, channels) VALUES (?1, ?2, ?3, ?4, 'Synthetic', 16000, 1)", params![id, track.kind, track.path, track.timing_path]).unwrap();
        }
        core.recording = RecordingState {
            status: CaptureStatus::Recording,
            meeting_id: Some(id.clone()),
            source: Some("desktop".into()),
            revision: 1,
            ..RecordingState::default()
        };
        core.audio = Some(session);
        let first_stop = core.stop();
        let pending_state = core.recording_state();
        let retained_worker = core.audio.is_some();
        let premature_recovery = core.recoverable_tracks(&id).is_ok();
        let _ = release.send(());
        finished
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap();
        let final_state = core.stop().unwrap();
        assert_eq!(first_stop.unwrap_err().code, "audio_worker_busy");
        assert!(
            retained_worker,
            "The pending writer must remain owned by the active session"
        );
        assert_eq!(pending_state.status, CaptureStatus::Paused);
        assert!(
            !premature_recovery,
            "Recovery must wait for the writer to release its files"
        );
        assert_eq!(final_state.status, CaptureStatus::Stopped);
        let detail = core.get_meeting(&id).unwrap();
        assert_eq!(detail.meeting.status, "interrupted");
        for track in detail.tracks {
            assert!(track.finalized);
            assert_eq!(track.frames, 4);
            assert_eq!(
                hound::WavReader::open(track.path)
                    .unwrap()
                    .samples::<f32>()
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .unwrap(),
                [0.25; 4]
            );
        }
        assert!(core.audio.is_none());
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
            core.start_desktop("Denied", options.clone(), false, None)
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
                core.start_desktop("Missing device", options, true, None)
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
            timing: SegmentTiming::Timed {
                start_ms: start,
                end_ms: start + 10,
            },
            text: text.into(),
        };
        core.replace_transcript(
            &id,
            &[line("first run", 0), line("second", 20)],
            "whisper",
            "small",
        )
        .unwrap();
        core.replace_transcript(&id, &[line("rerun", 5)], "whisper", "small")
            .unwrap();
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
            core.replace_transcript(&id, &[bad], "whisper", "small")
                .unwrap_err()
                .code,
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
    fn summary_edits_append_versions_and_refuse_stale_or_empty_saves() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_note("Fictional edited summary").unwrap();
        let other = core.create_note("Other fictional meeting").unwrap();
        core.save_summary(&id, "p", "m", "## Summary\nOriginal output", "standup-v1")
            .unwrap();
        core.save_summary(&other, "p", "m", "## Summary\nElsewhere", "general-v1")
            .unwrap();
        let base = core.list_summaries(&id).unwrap()[0].id;
        let foreign = core.list_summaries(&other).unwrap()[0].id;
        for (base_id, latest, text, code) in [
            (base, base, "   ", "summary_edit"),
            (base, base, "## Summary\nOriginal output", "summary_edit"),
            (foreign, base, "Edited", "not_found"),
            (base, base + 99, "Edited", "summary_conflict"),
        ] {
            assert_eq!(
                core.save_summary_edit(&id, base_id, latest, text)
                    .unwrap_err()
                    .code,
                code
            );
        }
        assert!(core
            .save_summary_edit(&id, base, base, &"x".repeat(2 * 1024 * 1024 + 1))
            .is_err());
        core.save_summary_edit(&id, base, base, "## Summary\nQuinceEdited text")
            .unwrap();
        let versions = core.list_summaries(&id).unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(
            (versions[0].edited_from, versions[0].template.as_str()),
            (Some(base), "standup-v1")
        );
        assert_eq!(
            (versions[1].markdown.as_str(), versions[1].edited_from),
            ("## Summary\nOriginal output", None)
        );
        let detail = core.get_meeting(&id).unwrap();
        assert!(detail.summary_edited);
        assert_eq!(
            core.search_meetings("QuinceEdited").unwrap()[0].meeting_id,
            id
        );
        assert!(crate::export::render(
            &detail,
            &ExportOptions {
                transcript: false,
                summary: true,
                filename: FilenamePattern::Title
            }
        )
        .contains("summary_edited: true\n"));
        // A newer generated version makes the old latest id stale; the edit stays in history.
        core.save_summary(&id, "p", "m", "## Summary\nRegenerated", "standup-v1")
            .unwrap();
        assert_eq!(
            core.save_summary_edit(&id, base, versions[0].id, "Another edit")
                .unwrap_err()
                .code,
            "summary_conflict"
        );
        assert!(!core.get_meeting(&id).unwrap().summary_edited);
        assert_eq!(core.list_summaries(&id).unwrap().len(), 3);
    }

    #[test]
    fn upgrade_from_populated_v16_keeps_summaries_tasks_and_search() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        {
            let db = test_v11_database(&path);
            for script in [
                include_str!("../migrations/012_saved_connections.sql"),
                include_str!("../migrations/013_session_processing.sql"),
                include_str!("../migrations/014_processing_workflow.sql"),
                include_str!("../migrations/015_summary_templates.sql"),
                include_str!("../migrations/016_action_items.sql"),
            ] {
                db.execute_batch(script).unwrap();
            }
            db.execute_batch("INSERT INTO meetings(id,title,started_at,source,status) VALUES ('existing','Fictional upgrade','test','fixture','stopped');
                INSERT INTO notes(meeting_id,user_markdown,revision) VALUES ('existing','Preserve the original notes',7);
                INSERT INTO summaries(id,meeting_id,template_hash,model,provider,markdown) VALUES (5,'existing','general-v1','hand-written','fixture','Persimmon summary');
                INSERT INTO action_items(meeting_id,text,source,summary_id,origin_text) VALUES ('existing','Kept task','summary',5,'Kept task');").unwrap();
        }
        for _ in 0..2 {
            let core = Core::open(&path).unwrap();
            let detail = core.get_meeting("existing").unwrap();
            assert_eq!(detail.summary.as_deref(), Some("Persimmon summary"));
            assert!(!detail.summary_edited);
            assert_eq!(detail.action_items[0].summary_id, Some(5));
            assert_eq!(
                core.list_summaries("existing").unwrap()[0].edited_from,
                None
            );
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
    }

    #[test]
    fn custom_templates_and_instructions_are_validated_persisted_and_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        let mut core = Core::open(&path).unwrap();
        let settings = core
            .save_summary_template(None, "  Retro  ", "## Went well\n## To improve")
            .unwrap();
        let id = settings.summary_templates[0].id.clone();
        assert!(id.starts_with(CUSTOM_TEMPLATE_PREFIX));
        assert_eq!(settings.summary_templates[0].name, "Retro");
        core.save_summary_template(Some(&id), "Retrospective", "## Actions")
            .unwrap();
        core.save_summary_instructions(" Use British English.\n")
            .unwrap();
        for (name, instructions) in [
            ("", "## A"),
            (&"n".repeat(81) as &str, "## A"),
            ("Line\nbreak", "## A"),
            ("Empty", "   "),
            ("Long", &"x".repeat(4001) as &str),
            ("Control", "bell\u{7}"),
        ] {
            assert!(
                core.save_summary_template(None, name, instructions)
                    .unwrap_err()
                    .code
                    .starts_with("summary_"),
                "{name}"
            );
        }
        assert!(core.save_summary_instructions(&"x".repeat(2001)).is_err());
        assert_eq!(
            core.save_summary_template(Some("custom-missing"), "Name", "## A")
                .unwrap_err()
                .code,
            "summary_template_missing"
        );
        drop(core);
        let mut core = Core::open(&path).unwrap();
        let settings = core.settings().unwrap();
        assert_eq!(settings.summary_instructions, "Use British English.");
        assert_eq!(
            settings.summary_templates,
            [CustomTemplate {
                id: id.clone(),
                name: "Retrospective".into(),
                instructions: "## Actions".into()
            }]
        );
        let meeting = core.create_note("Fictional template meeting").unwrap();
        core.save_summary(&meeting, "p", "m", "Kept summary", &id)
            .unwrap();
        assert!(core
            .delete_summary_template(&id)
            .unwrap()
            .summary_templates
            .is_empty());
        assert_eq!(
            core.delete_summary_template(&id).unwrap_err().code,
            "summary_template_missing"
        );
        assert_eq!(core.list_summaries(&meeting).unwrap()[0].template, id);
        for index in 0..MAX_CUSTOM_TEMPLATES {
            core.save_summary_template(None, &format!("T{index}"), "## A")
                .unwrap();
        }
        assert!(core
            .save_summary_template(None, "One more", "## A")
            .is_err());
    }

    #[test]
    fn saved_connections_share_models_and_preserve_independent_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        let mut core = Core::open(&path).unwrap();
        let settings = core
            .save_api_connection(
                None,
                "Shared",
                "https://chat.example/v1",
                Some("synthetic-key-a"),
                None,
            )
            .unwrap();
        let id = settings.saved_connections[0].id.clone();
        core.save_provider_assignment(
            ProviderRole::Llm,
            &ProviderSelection::Assigned {
                connection_id: id.clone(),
                model: "chat".into(),
            },
            None,
        )
        .unwrap();
        core.save_provider_assignment(
            ProviderRole::CloudStt,
            &ProviderSelection::Assigned {
                connection_id: id.clone(),
                model: "speech".into(),
            },
            None,
        )
        .unwrap();
        assert_eq!(
            core.delete_api_connection(&id, 1).unwrap_err().code,
            "provider_assigned"
        );
        assert_eq!(
            core.save_api_connection(
                Some(&id),
                "Shared",
                "https://changed.example/v1",
                Some("synthetic-key-a"),
                Some(1)
            )
            .unwrap_err()
            .code,
            "provider_key_required"
        );
        core.save_api_connection(
            Some(&id),
            "Shared",
            "https://changed.example/v1",
            Some("synthetic-key-b"),
            Some(1),
        )
        .unwrap();
        assert_eq!(
            core.save_api_connection(
                Some(&id),
                "Stale",
                "https://changed.example/v1",
                None,
                Some(1)
            )
            .unwrap_err()
            .code,
            "provider_conflict"
        );
        core.save_api_connection(None, "Unrelated", "http://localhost:1234/v1", None, None)
            .unwrap();
        assert_eq!(core.settings().unwrap().llm.unwrap().revision, 2);
        assert_eq!(core.settings().unwrap().cloud_stt.unwrap().revision, 2);
        assert_eq!(
            core.save_provider_assignment(
                ProviderRole::Llm,
                &ProviderSelection::Unassigned,
                Some(1)
            )
            .unwrap_err()
            .code,
            "provider_conflict"
        );
        core.save_provider_assignment(ProviderRole::Llm, &ProviderSelection::Unassigned, Some(2))
            .unwrap();
        core.save_provider_assignment(
            ProviderRole::Llm,
            &ProviderSelection::Assigned {
                connection_id: id.clone(),
                model: "new-chat".into(),
            },
            None,
        )
        .unwrap();
        drop(core);
        let core = Core::open(&path).unwrap();
        let settings = core.settings().unwrap();
        let llm = settings.llm.as_ref().unwrap();
        assert_eq!(
            (
                llm.model.as_deref(),
                llm.revision,
                llm.credential_account.as_deref()
            ),
            (Some("new-chat"), 4, Some("synthetic-key-b"))
        );
        assert_eq!(
            settings.cloud_stt.as_ref().unwrap().model.as_deref(),
            Some("speech")
        );
        assert_eq!(settings.cloud_stt.as_ref().unwrap().revision, 2);
        let serialized = serde_json::to_string(&settings).unwrap();
        assert!(!serialized.contains("credential_account"));
        assert!(!serialized.contains("synthetic-key"));
    }

    #[test]
    fn connection_updates_roll_back_and_do_not_invalidate_unrelated_tasks() {
        let dir = tempfile::tempdir().unwrap();
        let mut core = Core::open(&dir.path().join("meetings.db")).unwrap();
        let first = core
            .save_api_connection(None, "First", "http://localhost:1234/v1", None, None)
            .unwrap()
            .saved_connections[0]
            .id
            .clone();
        let second = core
            .save_api_connection(None, "Second", "http://localhost:1235/v1", None, None)
            .unwrap()
            .saved_connections
            .iter()
            .find(|c| c.name == "Second")
            .unwrap()
            .id
            .clone();
        core.save_provider_assignment(
            ProviderRole::Llm,
            &ProviderSelection::Assigned {
                connection_id: first.clone(),
                model: "chat".into(),
            },
            None,
        )
        .unwrap();
        core.save_provider_assignment(
            ProviderRole::CloudStt,
            &ProviderSelection::Assigned {
                connection_id: second.clone(),
                model: "speech".into(),
            },
            None,
        )
        .unwrap();
        core.save_api_connection(
            Some(&first),
            "Renamed",
            "http://localhost:1234/v1",
            None,
            Some(1),
        )
        .unwrap();
        assert_eq!(core.settings().unwrap().llm.unwrap().revision, 2);
        assert_eq!(core.settings().unwrap().cloud_stt.unwrap().revision, 1);
        core.db
            .execute(
                "UPDATE provider_assignments SET revision=?1 WHERE role='llm'",
                [i64::MAX],
            )
            .unwrap();
        assert_eq!(
            core.save_api_connection(
                Some(&first),
                "Must roll back",
                "http://localhost:1234/v1",
                None,
                Some(2)
            )
            .unwrap_err()
            .code,
            "provider_conflict"
        );
        assert_eq!(core.api_connection(&first).unwrap().name, "Renamed");
        assert_eq!(core.api_connection(&first).unwrap().revision, 2);
        core.save_provider_assignment(
            ProviderRole::CloudStt,
            &ProviderSelection::Unassigned,
            Some(1),
        )
        .unwrap();
        assert_eq!(
            core.delete_api_connection(&second, 2).unwrap_err().code,
            "provider_conflict"
        );
        core.delete_api_connection(&second, 1).unwrap();
        assert!(core.api_connection(&second).is_err());
        assert!(core.settings().unwrap().cloud_stt.is_none());
    }

    #[test]
    fn v11_migration_preserves_connections_and_dormant_legacy_settings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        {
            let db = test_v11_database(&path);
            db.execute_batch("INSERT INTO provider_connections VALUES ('llm','https://chat.example/v1','chat','existing-account-a',7),('cloud_stt','https://speech.example/v1',NULL,'existing-account-b',4); UPDATE settings SET merge_model='dormant',stt_model='base';").unwrap();
        }
        let core = Core::open(&path).unwrap();
        let settings = core.settings().unwrap();
        assert_eq!(settings.saved_connections.len(), 2);
        let llm = settings.llm.unwrap();
        assert_eq!(
            (
                llm.revision,
                llm.model.as_deref(),
                llm.credential_account.as_deref()
            ),
            (7, Some("chat"), Some("existing-account-a"))
        );
        assert!(settings.cloud_stt.is_none());
        assert_eq!(
            settings
                .saved_connections
                .iter()
                .find(|c| c.id == "migrated-cloud_stt")
                .unwrap()
                .credential_account
                .as_deref(),
            Some("existing-account-b")
        );
        assert_eq!(settings.stt_model, "base");
        assert_eq!(
            core.db
                .query_row("SELECT merge_model FROM settings", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "dormant"
        );
        assert_eq!(
            core.db
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn cloud_and_local_transcripts_replace_atomically_with_provenance_and_search() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        let mut core = Core::open(&path).unwrap();
        let id = core.create_fixture().unwrap();
        core.save_notes(&id, "Preserved private notes", 0).unwrap();
        let timed = Segment {
            speaker: "Others".into(),
            timing: SegmentTiming::Timed {
                start_ms: 10,
                end_ms: 20,
            },
            text: "Coconut local".into(),
        };
        core.replace_transcript(&id, std::slice::from_ref(&timed), "whisper", "base")
            .unwrap();
        let cloud = vec![
            Segment {
                speaker: "You".into(),
                timing: SegmentTiming::Untimed,
                text: "Dragonfruit first".into(),
            },
            Segment {
                speaker: "You".into(),
                timing: SegmentTiming::Untimed,
                text: "Dragonfruit second".into(),
            },
            Segment {
                speaker: "Others".into(),
                timing: SegmentTiming::Untimed,
                text: "Lychee remote".into(),
            },
        ];
        core.replace_transcript(&id, &cloud, "https://speech.example/v1", "speech-model")
            .unwrap();
        assert!(core.search_meetings("Coconut").unwrap().is_empty());
        assert_eq!(core.search_meetings("Dragonfruit").unwrap().len(), 1);
        let detail = core.get_meeting(&id).unwrap();
        assert_eq!(detail.segments.len(), 5, "legacy fixture rows remain");
        assert_eq!(&detail.segments[2..], &cloud);
        assert_eq!(
            detail.transcript_provider.as_deref(),
            Some("https://speech.example/v1")
        );
        assert_eq!(detail.transcript_model.as_deref(), Some("speech-model"));
        assert_eq!(detail.user_markdown, "Preserved private notes");
        assert_eq!(detail.notes_revision, 1);
        assert_eq!(detail.summary_provider.as_deref(), Some("fixture"));
        let bad = Segment {
            timing: SegmentTiming::Timed {
                start_ms: 30,
                end_ms: 20,
            },
            ..timed.clone()
        };
        assert!(core
            .replace_transcript(&id, &[bad], "whisper", "small")
            .is_err());
        let after = core.get_meeting(&id).unwrap();
        assert_eq!(after.segments, detail.segments);
        assert_eq!(after.transcript_model, detail.transcript_model);
        assert_eq!(core.search_meetings("Dragonfruit").unwrap().len(), 1);
        drop(core);
        let mut core = Core::open(&path).unwrap();
        assert_eq!(core.get_meeting(&id).unwrap().segments, detail.segments);
        core.replace_transcript(&id, &[timed], "whisper", "base")
            .unwrap();
        assert!(core.search_meetings("Dragonfruit").unwrap().is_empty());
        assert_eq!(core.search_meetings("Coconut").unwrap().len(), 1);
        let detail = core.get_meeting(&id).unwrap();
        assert_eq!(detail.transcript_provider.as_deref(), Some("whisper"));
        assert_eq!(detail.transcript_model.as_deref(), Some("base"));
        core.replace_transcript(&id, &[], "https://speech.example/v1", "silent-model")
            .unwrap();
        assert_eq!(core.get_meeting(&id).unwrap().segments.len(), 2);
        assert_eq!(
            core.get_meeting(&id).unwrap().transcript_model.as_deref(),
            Some("silent-model")
        );
        assert!(core.search_meetings("Coconut").unwrap().is_empty());
        core.delete_meeting(&id).unwrap();
        assert_eq!(
            core.db
                .query_row("SELECT COUNT(*) FROM meeting_transcriptions", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(core.search_meetings("checklist").unwrap().is_empty());
    }

    #[test]
    fn segment_database_rejects_half_null_and_invalid_timing_pairs() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_note("Timing boundary").unwrap();
        for (start, end) in [
            (None, Some(1)),
            (Some(0), None),
            (Some(-1), Some(2)),
            (Some(3), Some(2)),
        ] {
            assert!(core.db.execute(
                "INSERT INTO segments(meeting_id, speaker, start_ms, end_ms, text, source, pass) VALUES (?1, 'You', ?2, ?3, 'Invalid', 'cloud_stt', 'final')",
                params![id, start, end],
            ).is_err());
        }
        core.db.execute("INSERT INTO segments(meeting_id, speaker, start_ms, end_ms, text, source, pass) VALUES (?1, 'You', NULL, NULL, 'Untimed', 'cloud_stt', 'final')", [&id]).unwrap();
        assert_eq!(
            core.get_meeting(&id).unwrap().segments[0].timing,
            SegmentTiming::Untimed
        );
    }

    #[test]
    fn provider_migrations_preserve_populated_v11_database_and_fts_triggers() {
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
                include_str!("../migrations/006_note_meetings.sql"),
                include_str!("../migrations/007_search.sql"),
                include_str!("../migrations/008_stt_settings.sql"),
                include_str!("../migrations/009_export_options.sql"),
                include_str!("../migrations/010_provider_settings.sql"),
                include_str!("../migrations/011_cloud_transcripts.sql"),
            ] {
                db.execute_batch(script).unwrap();
            }
            db.execute_batch("PRAGMA foreign_keys = ON;
                INSERT INTO meetings(id,title,started_at,source,status) VALUES ('legacy','Legacy fixture','2026-10-10','fixture','stopped'), ('recorded','Recorded','2026-10-10','desktop','stopped');
                INSERT INTO notes(meeting_id,user_markdown,revision) VALUES ('legacy','Edited fixture notes',7), ('recorded','Kept notes',4);
                INSERT INTO segments(id,meeting_id,speaker,start_ms,end_ms,text,source,pass) VALUES (42,'recorded','You',100,200,'Persimmon original','whisper','final'), (43,'legacy','Others',0,100,'Fictional checklist','fixture','final');
                INSERT INTO meeting_transcriptions(meeting_id,provider,model) VALUES ('recorded','whisper',NULL);
                INSERT INTO summaries(meeting_id,template_hash,model,provider,markdown) VALUES ('recorded','general-v1','old-model','merge','Kept summary');
                INSERT INTO tracks(meeting_id,kind,path,timing_path,device_name,sample_rate,channels,frames,finalized) VALUES ('recorded','mic','mic.wav','mic.jsonl','Mic',16000,1,16000,1);
                INSERT INTO provider_connections VALUES ('llm','https://chat.example/v1',NULL,'preserved-ref-a',9),('cloud_stt','https://speech.example/v1',NULL,'preserved-ref-b',6); UPDATE settings SET merge_model='legacy/model', stt_model='base', stt_language='de', stt_prompt='Okta', stop_shortcut='Alt+S';").unwrap();
            db.execute(
                "UPDATE tracks SET path = ?1, timing_path = ?2 WHERE meeting_id = 'recorded'",
                params![
                    dir.path().join("missing-mic.wav").to_str().unwrap(),
                    dir.path().join("missing-mic.jsonl").to_str().unwrap()
                ],
            )
            .unwrap();
        }
        let mut core = Core::open(&path).unwrap();
        let detail = core.get_meeting("recorded").unwrap();
        assert_eq!(detail.user_markdown, "Kept notes");
        assert_eq!(detail.notes_revision, 4);
        assert_eq!(
            detail.segments[0].timing,
            SegmentTiming::Timed {
                start_ms: 100,
                end_ms: 200
            }
        );
        assert_eq!(detail.transcript_provider.as_deref(), Some("whisper"));
        assert_eq!(detail.transcript_model, None, "old model was not recorded");
        assert_eq!(detail.summary.as_deref(), Some("Kept summary"));
        assert_eq!(detail.summary_provider.as_deref(), Some("merge"));
        assert_eq!(
            detail.tracks[0].path,
            dir.path().join("missing-mic.wav").to_str().unwrap()
        );
        assert_eq!(
            core.db
                .query_row(
                    "SELECT id FROM segments WHERE text='Persimmon original'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            42
        );
        let settings = core.settings().unwrap();
        assert_eq!(settings.saved_connections.len(), 2);
        assert_eq!(
            settings
                .saved_connections
                .iter()
                .find(|c| c.id == "migrated-llm")
                .unwrap()
                .credential_account
                .as_deref(),
            Some("preserved-ref-a")
        );
        assert_eq!(settings.llm, None);
        assert_eq!(settings.cloud_stt, None);
        assert_eq!(settings.stt_mode, SttMode::Local);
        assert_eq!(
            (
                settings.stt_model.as_str(),
                settings.stt_language.as_str(),
                settings.stt_prompt.as_str()
            ),
            ("base", "de", "Okta")
        );
        assert_eq!(settings.stop_shortcut.as_deref(), Some("Alt+S"));
        assert_eq!(
            core.db
                .query_row("SELECT merge_model FROM settings", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "legacy/model"
        );
        let legacy = core.get_meeting("legacy").unwrap();
        assert_eq!(legacy.meeting.source, "fixture");
        assert_eq!(
            (legacy.user_markdown.as_str(), legacy.notes_revision),
            ("Edited fixture notes", 7)
        );
        assert_eq!(core.search_meetings("Persimmon").unwrap().len(), 1);
        core.db
            .execute(
                "UPDATE segments SET text='Rambutan updated' WHERE id=42",
                [],
            )
            .unwrap();
        assert!(core.search_meetings("Persimmon").unwrap().is_empty());
        assert_eq!(core.search_meetings("Rambutan").unwrap().len(), 1);
        core.replace_transcript(
            "recorded",
            &[Segment {
                speaker: "You".into(),
                timing: SegmentTiming::Untimed,
                text: "Tamarind cloud".into(),
            }],
            "https://speech.example/v1",
            "cloud-model",
        )
        .unwrap();
        assert!(core.search_meetings("Rambutan").unwrap().is_empty());
        assert_eq!(core.search_meetings("Tamarind").unwrap().len(), 1);
        assert_eq!(
            core.db
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        drop(core);
        let mut core = Core::open(&path).unwrap();
        assert_eq!(
            core.get_meeting("recorded")
                .unwrap()
                .transcript_model
                .as_deref(),
            Some("cloud-model")
        );
        core.delete_meeting("recorded").unwrap();
        assert!(core.search_meetings("Tamarind").unwrap().is_empty());
        assert_eq!(core.get_meeting("legacy").unwrap().notes_revision, 7);
        assert_eq!(
            core.db
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            LATEST_SCHEMA
        );
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
        assert_eq!(settings.llm, None);
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
            timing: SegmentTiming::Timed {
                start_ms: 0,
                end_ms: 1,
            },
            text: text.into(),
        };
        core.replace_transcript(
            &note,
            &[line("papaya talk"), line("papaya talk")],
            "whisper",
            "small",
        )
        .unwrap();
        assert_eq!(
            found(&core, "papaya"),
            ours("transcript"),
            "one hit per kind"
        );
        core.replace_transcript(&note, &[line("guava")], "whisper", "small")
            .unwrap();
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
            "ünïcode",
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
        // An unreferenced file (a recovered track's original) goes too.
        std::fs::write(folder.join("system.wav"), b"x").unwrap();
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
        assert_eq!(copy.parent(), Some(folder.as_path()));
        assert_ne!(copy, original);
        let frames = audio::repair_wav(original, copy).unwrap();
        assert_eq!(frames, 999);
        core.db.execute_batch("CREATE TRIGGER refuse_recovery BEFORE UPDATE ON tracks BEGIN SELECT RAISE(ABORT, 'Synthetic recovery publication failure'); END;").unwrap();
        assert!(core.mark_recovered("rec", kind, copy, frames).is_err());
        core.db
            .execute_batch("DROP TRIGGER refuse_recovery;")
            .unwrap();
        let unpublished_copy = copy.clone();
        let retry = core.recoverable_tracks("rec").unwrap();
        let (kind, original, copy) = &retry[0];
        assert_ne!(
            copy, &unpublished_copy,
            "A retry must not collide with the copy retained after a failed database publication"
        );
        let frames = audio::repair_wav(original, copy).unwrap();
        assert_eq!(
            std::fs::read(copy).unwrap(),
            std::fs::read(&unpublished_copy).unwrap()
        );
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
        assert_eq!(settings.llm, None);
        assert_eq!(
            core.db
                .query_row("SELECT merge_model FROM settings", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "openai/gpt-y"
        );
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

    #[test]
    fn migration_8_upgrades_a_populated_v5_database() {
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
                INSERT INTO meetings(id, title, started_at, source, status) VALUES ('v5', 'Recorded', '2026-10-10', 'desktop', 'stopped');
                INSERT INTO notes(meeting_id, user_markdown, revision) VALUES ('v5', 'Kept notes', 3);
                INSERT INTO segments(meeting_id, speaker, start_ms, end_ms, text, source, pass) VALUES ('v5', 'Others', 0, 100, 'Fictional words', 'whisper', 'final');
                INSERT INTO summaries(meeting_id, template_hash, model, provider, markdown) VALUES ('v5', 'summary-v1', 'm', 'merge', 'Kept summary');
                INSERT INTO tracks(meeting_id, kind, path, timing_path, device_name, sample_rate, channels, frames, finalized) VALUES ('v5', 'mic', 'mic.wav', 'mic.timing.jsonl', 'Mic', 48000, 1, 4800, 1);
                UPDATE settings SET pause_shortcut = 'Alt+P', merge_model = 'openai/gpt-5.4';").unwrap();
            let version: i64 = db
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .unwrap();
            assert_eq!(version, 5);
        }
        let core = Core::open(&path).unwrap();
        let detail = core.get_meeting("v5").unwrap();
        assert_eq!(detail.user_markdown, "Kept notes");
        assert_eq!(detail.notes_revision, 3);
        assert_eq!(detail.segments[0].text, "Fictional words");
        assert_eq!(detail.summary.as_deref(), Some("Kept summary"));
        assert_eq!(detail.tracks[0].frames, 4800);
        let settings = core.settings().unwrap();
        assert_eq!(settings.pause_shortcut, "Alt+P");
        assert_eq!(settings.llm, None);
        assert_eq!(
            core.db
                .query_row("SELECT merge_model FROM settings", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "openai/gpt-5.4"
        );
        assert_eq!(settings.stt_language, "auto");
        assert_eq!(settings.stt_prompt, "");
        assert_eq!(settings.stt_model, "small");
        assert_eq!(settings.stop_shortcut, None);
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
    }

    #[test]
    fn transcription_and_shortcut_settings_validate_and_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        let mut core = Core::open(&path).unwrap();
        let long = "x".repeat(501);
        for (language, prompt, model) in [
            ("klingon", "", "small"),
            ("de", "", "huge"),
            ("de", long.as_str(), "small"),
            ("de", "line\nbreak", "small"),
        ] {
            let error = core.save_stt_settings(language, prompt, model).unwrap_err();
            assert_eq!(error.code, "stt_settings");
        }
        assert_eq!(core.settings().unwrap().stt_model, "small");
        core.save_stt_settings("de", "  Kubernetes, Okta  ", "base")
            .unwrap();
        assert_eq!(core.settings().unwrap().stt_prompt, "Kubernetes, Okta");
        core.save_stt_settings("en", &"é".repeat(500), "large-v3-turbo")
            .unwrap();
        core.save_shortcuts("Alt+P", Some("Alt+S")).unwrap();
        drop(core);
        let settings = Core::open(&path).unwrap().settings().unwrap();
        assert_eq!(settings.stt_language, "en");
        assert_eq!(settings.stt_prompt.chars().count(), 500);
        assert_eq!(settings.stt_model, "large-v3-turbo");
        assert_eq!(settings.pause_shortcut, "Alt+P");
        assert_eq!(settings.stop_shortcut.as_deref(), Some("Alt+S"));
    }

    #[test]
    fn meeting_tags_validate_dedupe_persist_and_cascade() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        let mut core = Core::open(&path).unwrap();
        let id = core.create_note("Fictional tagged meeting").unwrap();
        let other = core.create_note("Fictional untagged meeting").unwrap();
        let strings = |tags: &[&str]| tags.iter().map(|t| t.to_string()).collect::<Vec<_>>();
        let long = "x".repeat(41);
        let many: Vec<String> = (0..21).map(|n| format!("tag{n}")).collect();
        for bad in [
            strings(&[long.as_str()]),
            strings(&["line\nbreak"]),
            strings(&["tab\there"]),
            many,
        ] {
            assert_eq!(
                core.set_meeting_tags(&id, &bad).unwrap_err().code,
                "meeting_tag"
            );
        }
        assert_eq!(
            core.set_meeting_tags("missing", &strings(&["a"]))
                .unwrap_err()
                .code,
            "not_found"
        );
        // Empty entries drop out, case-insensitive duplicates keep the first spelling.
        let stored = core
            .set_meeting_tags(&id, &strings(&[" Q4 ", "", "client", "CLIENT", "Client"]))
            .unwrap();
        assert_eq!(stored, strings(&["client", "Q4"]));
        assert_eq!(core.get_meeting(&id).unwrap().meeting.tags, stored);
        let listed = core.list_meetings().unwrap();
        assert_eq!(listed.iter().find(|m| m.id == id).unwrap().tags, stored);
        assert!(listed
            .iter()
            .find(|m| m.id == other)
            .unwrap()
            .tags
            .is_empty());
        // A rejected replacement leaves the earlier tags intact.
        core.set_meeting_tags(&id, &strings(&[long.as_str()]))
            .unwrap_err();
        drop(core);
        let mut core = Core::open(&path).unwrap();
        assert_eq!(core.get_meeting(&id).unwrap().meeting.tags, stored);
        assert!(core.set_meeting_tags(&id, &[]).unwrap().is_empty());
        core.set_meeting_tags(&id, &strings(&["Again"])).unwrap();
        core.delete_meeting(&id).unwrap();
        let rows: i64 = core
            .db
            .query_row("SELECT COUNT(*) FROM meeting_tags", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn upgrade_from_populated_v20_adds_empty_tags_and_keeps_search() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        {
            let db = test_v11_database(&path);
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
            ] {
                db.execute_batch(script).unwrap();
            }
            db.execute_batch("INSERT INTO meetings(id,title,started_at,source,status) VALUES ('existing','Fictional upgrade','test','desktop','stopped');
                INSERT INTO notes(meeting_id,user_markdown,revision) VALUES ('existing','Persimmon notes kept',3);
                INSERT INTO summaries(id,meeting_id,template_hash,model,provider,markdown) VALUES (5,'existing','general-v1','m','p','Kept summary');").unwrap();
        }
        for _ in 0..2 {
            let core = Core::open(&path).unwrap();
            let detail = core.get_meeting("existing").unwrap();
            assert_eq!(detail.user_markdown, "Persimmon notes kept");
            assert_eq!(detail.summary.as_deref(), Some("Kept summary"));
            assert!(detail.meeting.tags.is_empty());
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
    }
}
