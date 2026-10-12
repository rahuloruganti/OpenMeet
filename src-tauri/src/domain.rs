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
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Segment {
    pub speaker: String,
    pub start_ms: i64,
    pub end_ms: i64,
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
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Settings {
    pub vault_folder: Option<String>,
    pub pause_shortcut: String,
    pub microphone_id: Option<String>,
    pub output_id: Option<String>,
    pub merge_model: Option<String>,
    pub stt_language: String,
    pub stt_prompt: String,
    pub stt_model: String,
    pub stop_shortcut: Option<String>,
    pub export: ExportOptions,
}

/// One stored summary; `template` is the versioned template id (`general-v1`, …).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SummaryVersion {
    pub id: i64,
    pub provider: String,
    pub model: String,
    pub template: String,
    pub markdown: String,
}

#[derive(Debug, Serialize)]
pub struct ExportResult {
    pub path: String,
    pub created_copy: bool,
}

/// Markdown export choices; the filename pattern is a closed set so untrusted input cannot pick one.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ExportOptions {
    pub transcript: bool,
    pub summary: bool,
    pub filename: FilenamePattern,
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
}
