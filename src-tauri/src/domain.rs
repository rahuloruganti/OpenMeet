use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error, Serialize)]
#[error("{message}")]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
}

impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(_: rusqlite::Error) -> Self {
        Self::new(
            "database",
            "The local database operation failed. Your previous saved data was not replaced.",
        )
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::new("filesystem", format!("File operation failed: {error}"))
    }
}

pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureStatus {
    #[default]
    Idle,
    Recording,
    Paused,
    Stopped,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct RecordingState {
    pub revision: u64,
    pub status: CaptureStatus,
    pub meeting_id: Option<String>,
    pub source: Option<String>,
    pub error: Option<String>,
    /// Audio written so far (microphone frames / rate), so paused time is excluded.
    /// Computed from capture counters on every read; `None` without real capture.
    pub recording_offset_ms: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Meeting {
    pub id: String,
    pub title: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub status: String,
    pub source: String,
    pub capture_error: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SegmentTiming {
    Timed { start_ms: i64, end_ms: i64 },
    Untimed,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Segment {
    pub speaker: String,
    pub timing: SegmentTiming,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct MeetingDetail {
    pub meeting: Meeting,
    pub user_markdown: String,
    pub notes_revision: i64,
    pub segments: Vec<Segment>,
    pub summary: Option<String>,
    pub summary_provider: Option<String>,
    pub summary_model: Option<String>,
    pub tracks: Vec<crate::audio::Track>,
    pub summary_template: Option<String>,
    pub transcript_provider: Option<String>,
    pub transcript_model: Option<String>,
    pub action_items: Vec<ActionItem>,
    /// The latest summary is a user edit rather than unedited model output.
    pub summary_edited: bool,
    /// The transcript or speaker names changed after the latest summary was made.
    pub summary_stale: bool,
    pub speaker_names: SpeakerNames,
    /// Aligned by index with `segments`, from the same query.
    pub segment_meta: Vec<SegmentMeta>,
    /// Earlier transcripts, newest first; segments load on request.
    pub transcript_versions: Vec<TranscriptVersion>,
    /// Saved questions and answers, newest thread first, turns oldest first.
    pub question_threads: Vec<QuestionThread>,
}

/// One saved question and the answer the provider returned for it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct QuestionTurn {
    pub id: i64,
    pub question: String,
    pub answer: String,
    pub provider: String,
    pub model: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct QuestionThread {
    pub id: i64,
    pub turns: Vec<QuestionTurn>,
}

/// Identity and edit state of one stored segment.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SegmentMeta {
    pub id: i64,
    /// The engine's text when the user edited the segment; None when unedited.
    pub original_text: Option<String>,
}

/// A transcript kept before a later transcription replaced it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TranscriptVersion {
    pub id: i64,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub edited: bool,
    pub segment_count: i64,
}

/// Optional display names for the "You" (microphone) and "Others" (system audio) labels.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct SpeakerNames {
    pub you: Option<String>,
    pub others: Option<String>,
}

impl SpeakerNames {
    /// "Rahul (You)" when named, otherwise the stored label unchanged.
    pub fn label(&self, speaker: &str) -> String {
        let name = match speaker {
            "You" => self.you.as_deref(),
            "Others" => self.others.as_deref(),
            _ => None,
        };
        name.map_or_else(|| speaker.to_string(), |name| format!("{name} ({speaker})"))
    }
}

/// An editable meeting task. `owner` and `due_date` are None when not established.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ActionItem {
    pub id: i64,
    pub text: String,
    pub owner: Option<String>,
    pub due_date: Option<String>,
    pub done: bool,
    /// "manual" or "summary"; summary imports keep the summary version id while it exists.
    pub source: String,
    pub summary_id: Option<i64>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRole {
    Llm,
    CloudStt,
}

impl ProviderRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Llm => "llm",
            Self::CloudStt => "cloud_stt",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProviderConfig {
    pub base_url: String,
    pub model: Option<String>,
    pub revision: i64,
    #[serde(skip_serializing)]
    pub credential_account: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub revision: i64,
    #[serde(skip_serializing)]
    pub credential_account: Option<String>,
}

impl SavedConnection {
    pub fn config(&self) -> ProviderConfig {
        ProviderConfig {
            base_url: self.base_url.clone(),
            model: None,
            revision: self.revision,
            credential_account: self.credential_account.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProviderAssignment {
    pub connection_id: String,
    pub model: String,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProviderAssignments {
    pub llm: Option<ProviderAssignment>,
    pub cloud_stt: Option<ProviderAssignment>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProviderSelection {
    Unassigned,
    Assigned {
        connection_id: String,
        model: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SttMode {
    Local,
    Cloud,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyStatus {
    Present,
    Missing,
    Unavailable,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KeyChange {
    Keep,
    Replace { key: String },
    Remove,
}

/// A question about long content sends locally selected excerpts instead of everything.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ExcerptSummary {
    pub segments: usize,
    pub meetings: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProcessingPlan {
    pub fingerprint: String,
    pub base_url: String,
    pub model: String,
    pub requests: usize,
    pub audio_bytes: u64,
    pub tracks: Vec<String>,
    /// Set when only selected excerpts are sent; None means the full content.
    pub excerpts: Option<ExcerptSummary>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Settings {
    pub vault_folder: Option<String>,
    pub pause_shortcut: String,
    pub microphone_id: Option<String>,
    pub output_id: Option<String>,
    pub saved_connections: Vec<SavedConnection>,
    pub provider_assignments: ProviderAssignments,
    pub llm: Option<ProviderConfig>,
    pub cloud_stt: Option<ProviderConfig>,
    pub stt_mode: SttMode,
    pub stt_language: String,
    pub stt_prompt: String,
    pub stt_model: String,
    pub stop_shortcut: Option<String>,
    pub export: ExportOptions,
    pub summary_instructions: String,
    pub summary_templates: Vec<CustomTemplate>,
    pub recipes: Vec<Recipe>,
}

/// A saved, reusable question prompt; `id` is `recipe-<uuid>`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Recipe {
    pub id: String,
    pub name: String,
    pub prompt: String,
}

/// An answer to a question over several meetings. `meetings` are in the order sent (M1 first).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LibraryAnswer {
    pub id: i64,
    pub question: String,
    pub answer: String,
    pub provider: String,
    pub model: String,
    pub created_at: String,
    pub meeting_ids: Vec<String>,
}

/// A user-defined summary structure; `id` is `custom-<uuid>` and is stored with each summary.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CustomTemplate {
    pub id: String,
    pub name: String,
    pub instructions: String,
}

impl Settings {
    pub fn connection(&self, role: ProviderRole) -> Option<&ProviderConfig> {
        match role {
            ProviderRole::Llm => self.llm.as_ref(),
            ProviderRole::CloudStt => self.cloud_stt.as_ref(),
        }
    }
}

/// One stored summary; `template` is the versioned template id (`general-v1`, …).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SummaryVersion {
    pub id: i64,
    pub provider: String,
    pub model: String,
    pub template: String,
    pub markdown: String,
    /// The version this one was edited from by the user; None for generated output.
    pub edited_from: Option<i64>,
    /// The transcript or speaker names changed after this version was made.
    pub stale: bool,
}

#[derive(Debug, Serialize)]
pub struct ExportResult {
    pub path: String,
    pub created_copy: bool,
    /// Transcript files written beside the Markdown snapshot, in the order requested.
    pub transcript_paths: Vec<String>,
}

/// Markdown export choices; the filename pattern is a closed set so untrusted input cannot pick one.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ExportOptions {
    pub transcript: bool,
    pub summary: bool,
    pub filename: FilenamePattern,
    /// Extra transcript files written beside the Markdown snapshot. Empty by default so older
    /// stored settings keep their fingerprints.
    #[serde(default)]
    pub transcript_formats: Vec<TranscriptFormat>,
}

/// A transcript file written next to the Markdown snapshot. SRT and VTT need every segment to
/// carry engine timestamps, so an untimed transcript is refused for them.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptFormat {
    Txt,
    Srt,
    Vtt,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FilenamePattern {
    Title,
    DateTitle,
}

pub fn now() -> Result<String> {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| AppError::new("clock", "Could not format the current time."))
}

/// One full-text match; `kind` is `title`, `notes`, `transcript` or `summary`.
#[derive(Clone, Debug, Serialize)]
pub struct SearchHit {
    pub meeting_id: String,
    pub kind: String,
    pub snippet: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_state_payload_matches_the_typescript_shape() {
        let state = RecordingState {
            recording_offset_ms: Some(1500),
            ..RecordingState::default()
        };
        assert_eq!(
            serde_json::to_value(&state).unwrap(),
            serde_json::json!({
                "revision": 0, "status": "idle", "meeting_id": null, "source": null,
                "error": null, "recording_offset_ms": 1500
            })
        );
    }

    #[test]
    fn segment_timing_and_key_status_have_explicit_wire_variants() {
        let timed = Segment {
            speaker: "You".into(),
            text: "Test words".into(),
            timing: SegmentTiming::Timed {
                start_ms: 2,
                end_ms: 10,
            },
        };
        assert_eq!(
            serde_json::to_value(timed).unwrap(),
            serde_json::json!({
                "speaker": "You", "text": "Test words", "timing": {"kind": "timed", "start_ms": 2, "end_ms": 10}
            })
        );
        assert_eq!(
            serde_json::to_value(SegmentTiming::Untimed).unwrap(),
            serde_json::json!({"kind": "untimed"})
        );
        assert_eq!(
            serde_json::to_value(KeyStatus::Unavailable).unwrap(),
            "unavailable"
        );
        assert_eq!(
            serde_json::to_value(ProviderRole::CloudStt).unwrap(),
            "cloud_stt"
        );
        assert!(matches!(
            serde_json::from_value::<KeyChange>(
                serde_json::json!({"kind": "replace", "key": "test-only"})
            )
            .unwrap(),
            KeyChange::Replace { .. }
        ));
    }
}
