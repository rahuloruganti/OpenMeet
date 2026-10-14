//! Session consent preparation only. No inference or provider dispatch is enabled here.
use crate::{
    domain::{AppError, ProviderRole, Result, Settings, SttMode},
    llm::Template,
    storage::Core,
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    LiveOnly {},
    Final {
        live: bool,
        summary: Option<Template>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Destination {
    LocalWhisper {
        model: String,
    },
    CompatibleApi {
        base_url: String,
        model: String,
        connection_id: String,
        connection_revision: i64,
        assignment_revision: i64,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SummaryScope {
    pub destination: Destination,
    pub template: Template,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Scope {
    LiveOnly {
        speech: Destination,
    },
    Final {
        live: bool,
        speech: Destination,
        summary: Option<SummaryScope>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Limits {
    pub duration_seconds: u32,
    pub upload_bytes: u64,
    pub requests: u32,
    pub text_characters: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Plan {
    pub id: String,
    pub fingerprint: String,
    pub configuration_revision: i64,
    pub review_expires_at: i64,
    pub scope: Scope,
    pub language: String,
    pub tracks: [String; 2],
    pub limits: Limits,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Prepared,
    ConsentRequired,
    Cancelled,
    Interrupted,
}

#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub meeting_id: String,
    pub revision: i64,
    pub state: State,
    pub plan: Plan,
    pub started_at: i64,
    pub authorized_until: i64,
}

fn changed() -> AppError {
    AppError::new(
        "session_consent_changed",
        "The session review expired or processing settings changed. Review again before recording. Nothing was sent.",
    )
}

fn invalid_record() -> AppError {
    AppError::new(
        "session_processing",
        "The processing consent record could not be read. No processing was started.",
    )
}

fn clock() -> Result<i64> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| AppError::new("clock", "The system clock is unavailable."))?;
    i64::try_from(seconds).map_err(|_| AppError::new("clock", "The system clock is out of range."))
}

fn api_destination(settings: &Settings, role: ProviderRole) -> Result<Destination> {
    let assignment = match role {
        ProviderRole::Llm => &settings.provider_assignments.llm,
        ProviderRole::CloudStt => &settings.provider_assignments.cloud_stt,
    }
    .as_ref()
    .ok_or_else(|| {
        AppError::new(
            "provider_model",
            "Choose and save a model for each selected processing stage first.",
        )
    })?;
    let connection = settings
        .saved_connections
        .iter()
        .find(|connection| connection.id == assignment.connection_id)
        .ok_or_else(changed)?;
    Ok(Destination::CompatibleApi {
        base_url: connection.base_url.clone(),
        model: assignment.model.clone(),
        connection_id: connection.id.clone(),
        connection_revision: connection.revision,
        assignment_revision: assignment.revision,
    })
}

impl Core {
    pub fn prepare_session_processing(&mut self, request: Request) -> Result<Plan> {
        self.prepare_session_processing_at(request, clock()?)
    }

    fn prepare_session_processing_at(&mut self, request: Request, now: i64) -> Result<Plan> {
        // A new review supersedes the previous one, including when this review fails.
        self.pending_processing = None;
        let settings = self.settings()?;
        let speech = match settings.stt_mode {
            SttMode::Local => Destination::LocalWhisper {
                model: settings.stt_model.clone(),
            },
            SttMode::Cloud => api_destination(&settings, ProviderRole::CloudStt)?,
        };
        let scope = match request {
            Request::LiveOnly {} => Scope::LiveOnly { speech },
            Request::Final { live, summary } => Scope::Final {
                live,
                speech,
                summary: summary
                    .map(|template| -> Result<_> {
                        Ok(SummaryScope {
                            destination: api_destination(&settings, ProviderRole::Llm)?,
                            template,
                        })
                    })
                    .transpose()?,
            },
        };
        let mut plan = Plan {
            id: Uuid::new_v4().to_string(),
            fingerprint: String::new(),
            configuration_revision: self.processing_configuration_revision()?,
            review_expires_at: now.checked_add(300).ok_or_else(changed)?,
            scope,
            language: settings.stt_language,
            tracks: ["mic".into(), "system".into()],
            limits: Limits {
                duration_seconds: 3600,
                upload_bytes: 256 * 1024 * 1024,
                requests: 1000,
                text_characters: 800_000,
            },
        };
        let bytes = serde_json::to_vec(&plan).map_err(|_| invalid_record())?;
        plan.fingerprint = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        self.pending_processing = Some(plan.clone());
        Ok(plan)
    }

    fn processing_configuration_revision(&self) -> Result<i64> {
        Ok(self.db.query_row(
            "SELECT revision FROM processing_configuration WHERE id=1",
            [],
            |row| row.get(0),
        )?)
    }

    pub(crate) fn confirmed_session_processing(
        &self,
        confirmation: Option<&str>,
    ) -> Result<Option<Plan>> {
        self.confirmed_session_processing_at(confirmation, clock()?)
    }

    fn confirmed_session_processing_at(
        &self,
        confirmation: Option<&str>,
        now: i64,
    ) -> Result<Option<Plan>> {
        let Some(confirmation) = confirmation else {
            return Ok(None);
        };
        let plan = self.pending_processing.as_ref().ok_or_else(changed)?;
        if confirmation != plan.fingerprint
            || now >= plan.review_expires_at
            || now < plan.review_expires_at.saturating_sub(300)
            || plan.configuration_revision != self.processing_configuration_revision()?
        {
            return Err(changed());
        }
        Ok(Some(plan.clone()))
    }

    pub fn session_processing(&self, meeting_id: &str) -> Result<Option<Snapshot>> {
        self.get_meeting(meeting_id)?;
        let now = clock()?;
        self.db.execute(
            "UPDATE processing_sessions SET state='consent_required',revision=revision+1 WHERE meeting_id=?1 AND state='prepared' AND (authorized_until<=?2 OR started_at>?2)",
            params![meeting_id, now],
        )?;
        let row: Option<(i64, String, String, i64, i64)> = self.db.query_row(
            "SELECT revision,state,plan_json,started_at,authorized_until FROM processing_sessions WHERE meeting_id=?1",
            [meeting_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).optional()?;
        row.map(|(revision, state, json, started_at, authorized_until)| {
            let state = match state.as_str() {
                "prepared" => State::Prepared,
                "consent_required" => State::ConsentRequired,
                "cancelled" => State::Cancelled,
                "interrupted" => State::Interrupted,
                _ => return Err(invalid_record()),
            };
            Ok(Snapshot {
                meeting_id: meeting_id.to_string(),
                revision,
                state,
                plan: serde_json::from_str(&json).map_err(|_| invalid_record())?,
                started_at,
                authorized_until,
            })
        })
        .transpose()
    }

    pub fn cancel_session_processing(
        &mut self,
        meeting_id: &str,
        expected_revision: i64,
    ) -> Result<Snapshot> {
        let snapshot = self.session_processing(meeting_id)?.ok_or_else(|| {
            AppError::new(
                "not_found",
                "This meeting has no session processing consent.",
            )
        })?;
        if snapshot.state == State::Cancelled {
            return Ok(snapshot);
        }
        if snapshot.revision != expected_revision {
            return Err(AppError::new(
                "session_processing_conflict",
                "Processing state changed. Refresh before cancelling.",
            ));
        }
        let changed = self.db.execute(
            "UPDATE processing_sessions SET state='cancelled',revision=revision+1 WHERE meeting_id=?1 AND revision=?2",
            params![meeting_id, expected_revision],
        )?;
        if changed != 1 {
            return Err(AppError::new(
                "session_processing_conflict",
                "Processing state changed. Refresh before cancelling.",
            ));
        }
        self.session_processing(meeting_id)?
            .ok_or_else(invalid_record)
    }
}

pub(crate) fn attach(tx: &Transaction<'_>, plan: &Plan, meeting_id: &str) -> Result<()> {
    let started_at = clock()?;
    let revision: i64 = tx.query_row(
        "SELECT revision FROM processing_configuration WHERE id=1",
        [],
        |row| row.get(0),
    )?;
    if started_at >= plan.review_expires_at
        || started_at < plan.review_expires_at.saturating_sub(300)
        || revision != plan.configuration_revision
    {
        return Err(changed());
    }
    let recording: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM meetings WHERE id=?1 AND source='desktop' AND status='paused')",
        [meeting_id],
        |row| row.get(0),
    )?;
    if !recording {
        return Err(AppError::new(
            "session_processing",
            "Processing consent can only be attached while preparing its new recording.",
        ));
    }
    let authorized_until = started_at
        .checked_add(i64::from(plan.limits.duration_seconds))
        .ok_or_else(changed)?;
    tx.execute(
        "INSERT INTO processing_sessions(id,meeting_id,state,plan_json,started_at,authorized_until) VALUES (?1,?2,'prepared',?3,?4,?5)",
        params![plan.id, meeting_id, serde_json::to_string(plan).map_err(|_| invalid_record())?, started_at, authorized_until],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{CaptureStatus, ProviderSelection};
    use std::path::Path;

    fn core() -> Core {
        Core::open(Path::new(":memory:")).unwrap()
    }

    fn cloud_settings(core: &mut Core) {
        core.save_api_connection(
            None,
            "Fictional speech",
            "https://speech.example/v1",
            Some("synthetic-credential-reference"),
            None,
        )
        .unwrap();
        core.save_api_connection(
            None,
            "Fictional text",
            "https://text.example/v1",
            None,
            None,
        )
        .unwrap();
        let connections = core.settings().unwrap().saved_connections;
        for (role, name, model) in [
            (ProviderRole::CloudStt, "Fictional speech", "speech-model"),
            (ProviderRole::Llm, "Fictional text", "text-model"),
        ] {
            let connection = connections
                .iter()
                .find(|connection| connection.name == name)
                .unwrap();
            core.save_provider_assignment(
                role,
                &ProviderSelection::Assigned {
                    connection_id: connection.id.clone(),
                    model: model.into(),
                },
                None,
            )
            .unwrap();
        }
    }

    fn attach_synthetic(core: &mut Core, plan: &Plan) -> String {
        let id = core.create_note("Fictional session consent check").unwrap();
        core.db
            .execute(
                "UPDATE meetings SET source='desktop',status='paused' WHERE id=?1",
                [&id],
            )
            .unwrap();
        let tx = core.db.transaction().unwrap();
        attach(&tx, plan, &id).unwrap();
        tx.commit().unwrap();
        core.pending_processing = None;
        id
    }

    #[test]
    fn review_discloses_independent_scopes_and_budgets_without_credentials() {
        let mut core = core();
        core.save_stt_settings("en", "", "base").unwrap();
        let local = core
            .prepare_session_processing(Request::LiveOnly {})
            .unwrap();
        let local_json = serde_json::to_value(&local).unwrap();
        assert_eq!(
            local_json["scope"],
            serde_json::json!({"kind":"live_only","speech":{"kind":"local_whisper","model":"base"}})
        );
        cloud_settings(&mut core);
        core.save_stt_mode(SttMode::Cloud).unwrap();
        let plan = core
            .prepare_session_processing(Request::Final {
                live: true,
                summary: Some(Template::Standup),
            })
            .unwrap();
        let value = serde_json::to_value(&plan).unwrap();
        assert_eq!(
            value["scope"]["speech"]["base_url"],
            "https://speech.example/v1"
        );
        assert_eq!(value["scope"]["speech"]["model"], "speech-model");
        assert_eq!(
            value["scope"]["summary"]["destination"]["base_url"],
            "https://text.example/v1"
        );
        assert_eq!(value["scope"]["summary"]["template"], "standup-v1");
        assert_eq!(value["tracks"], serde_json::json!(["mic", "system"]));
        assert_eq!(
            value["limits"],
            serde_json::json!({"duration_seconds":3600,"upload_bytes":268435456,"requests":1000,"text_characters":800000})
        );
        let json = serde_json::to_string(&plan).unwrap();
        assert!(!json.contains("synthetic-credential-reference"));
        assert!(!json.contains("credential_account"));
        assert!(core.list_meetings().unwrap().is_empty());
    }

    #[test]
    fn consent_expires_is_superseded_and_cannot_authorize_recording_itself() {
        let mut core = core();
        let first = core
            .prepare_session_processing_at(Request::LiveOnly {}, 100)
            .unwrap();
        assert_eq!(
            core.confirmed_session_processing_at(Some(&first.fingerprint), 399)
                .unwrap()
                .unwrap()
                .id,
            first.id
        );
        assert_eq!(
            core.confirmed_session_processing_at(Some(&first.fingerprint), 400)
                .unwrap_err()
                .code,
            "session_consent_changed"
        );
        let second = core
            .prepare_session_processing_at(Request::LiveOnly {}, 100)
            .unwrap();
        assert_ne!(first.fingerprint, second.fingerprint);
        assert_eq!(
            core.confirmed_session_processing_at(Some(&first.fingerprint), 101)
                .unwrap_err()
                .code,
            "session_consent_changed"
        );
        assert!(core
            .confirmed_session_processing_at(None, 101)
            .unwrap()
            .is_none());
        let options = crate::audio::CaptureOptions {
            microphone_id: String::new(),
            output_id: String::new(),
        };
        assert_eq!(
            core.start_desktop("No permission", options, false, Some(&second.fingerprint))
                .unwrap_err()
                .code,
            "consent_required"
        );
        assert_eq!(core.recording_state().status, CaptureStatus::Idle);
        assert!(core.list_meetings().unwrap().is_empty());
    }

    #[test]
    fn speech_edit_and_revert_invalidate_review_before_device_access() {
        let mut core = core();
        let plan = core
            .prepare_session_processing(Request::LiveOnly {})
            .unwrap();
        let original = core.settings().unwrap();
        core.save_stt_settings("de", "Fictional vocabulary", "base")
            .unwrap();
        core.save_stt_settings(
            &original.stt_language,
            &original.stt_prompt,
            &original.stt_model,
        )
        .unwrap();
        let options = crate::audio::CaptureOptions {
            microphone_id: String::new(),
            output_id: String::new(),
        };
        assert_eq!(
            core.start_desktop("Stale review", options, true, Some(&plan.fingerprint))
                .unwrap_err()
                .code,
            "session_consent_changed"
        );
        assert_eq!(core.recording_state().status, CaptureStatus::Idle);
        assert!(core.list_meetings().unwrap().is_empty());
    }

    #[test]
    fn failed_review_clears_the_old_grant_and_scopes_reject_unknown_fields() {
        let mut core = core();
        let plan = core
            .prepare_session_processing(Request::LiveOnly {})
            .unwrap();
        assert_eq!(
            core.prepare_session_processing(Request::Final {
                live: false,
                summary: Some(Template::General)
            })
            .unwrap_err()
            .code,
            "provider_model"
        );
        assert_eq!(
            core.confirmed_session_processing(Some(&plan.fingerprint))
                .unwrap_err()
                .code,
            "session_consent_changed"
        );
        assert!(
            serde_json::from_str::<Request>(r#"{"kind":"live_only","summary":"general-v1"}"#)
                .is_err()
        );
    }

    #[test]
    fn attached_consent_is_durable_and_cancel_is_revisioned_and_idempotent() {
        let mut core = core();
        let plan = core
            .prepare_session_processing(Request::Final {
                live: false,
                summary: None,
            })
            .unwrap();
        let id = attach_synthetic(&mut core, &plan);
        core.save_notes(&id, "Preserve this fictional draft", 0)
            .unwrap();
        let snapshot = core.session_processing(&id).unwrap().unwrap();
        assert_eq!((snapshot.state, snapshot.revision), (State::Prepared, 1));
        assert_eq!(snapshot.authorized_until - snapshot.started_at, 3600);
        assert_eq!(
            core.cancel_session_processing(&id, 2).unwrap_err().code,
            "session_processing_conflict"
        );
        let cancelled = core.cancel_session_processing(&id, 1).unwrap();
        assert_eq!((cancelled.state, cancelled.revision), (State::Cancelled, 2));
        let again = core.cancel_session_processing(&id, 1).unwrap();
        assert_eq!((again.state, again.revision), (State::Cancelled, 2));
        assert_eq!(
            core.get_meeting(&id).unwrap().user_markdown,
            "Preserve this fictional draft"
        );
        assert!(core
            .confirmed_session_processing(Some(&plan.fingerprint))
            .is_err());
    }

    #[test]
    fn provider_key_replacement_invalidates_persisted_consent() {
        let mut core = core();
        cloud_settings(&mut core);
        let plan = core
            .prepare_session_processing(Request::Final {
                live: false,
                summary: Some(Template::General),
            })
            .unwrap();
        let id = attach_synthetic(&mut core, &plan);
        let connection = core
            .settings()
            .unwrap()
            .saved_connections
            .into_iter()
            .find(|c| c.name == "Fictional text")
            .unwrap();
        core.save_api_connection(
            Some(&connection.id),
            &connection.name,
            &connection.base_url,
            Some("replacement-synthetic-reference"),
            Some(connection.revision),
        )
        .unwrap();
        let snapshot = core.session_processing(&id).unwrap().unwrap();
        assert_eq!(
            (snapshot.state, snapshot.revision),
            (State::ConsentRequired, 2)
        );
        let stored: String = core
            .db
            .query_row(
                "SELECT plan_json FROM processing_sessions WHERE meeting_id=?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!stored.contains("synthetic-reference"));
    }

    #[test]
    fn a_recording_transaction_cannot_publish_partial_or_duplicate_consent() {
        let mut core = core();
        let plan = core
            .prepare_session_processing(Request::LiveOnly {})
            .unwrap();
        {
            let tx = core.db.transaction().unwrap();
            tx.execute("INSERT INTO meetings(id,title,started_at,source,status) VALUES ('rollback','Fictional rollback','test','desktop','paused')", []).unwrap();
            attach(&tx, &plan, "rollback").unwrap();
            assert!(attach(&tx, &plan, "rollback").is_err());
        }
        assert_eq!(core.get_meeting("rollback").unwrap_err().code, "not_found");
        let count: i64 = core
            .db
            .query_row("SELECT COUNT(*) FROM processing_sessions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
        let id = attach_synthetic(&mut core, &plan);
        assert_eq!(
            core.session_processing(&id).unwrap().unwrap().state,
            State::Prepared
        );
    }

    #[test]
    fn restart_interrupts_consent_once_and_preserves_notes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        let id = {
            let mut core = Core::open(&path).unwrap();
            let plan = core
                .prepare_session_processing(Request::LiveOnly {})
                .unwrap();
            let id = attach_synthetic(&mut core, &plan);
            core.save_notes(&id, "Restart must retain these notes", 0)
                .unwrap();
            id
        };
        for _ in 0..2 {
            let core = Core::open(&path).unwrap();
            let snapshot = core.session_processing(&id).unwrap().unwrap();
            assert_eq!((snapshot.state, snapshot.revision), (State::Interrupted, 2));
            assert_eq!(
                core.get_meeting(&id).unwrap().user_markdown,
                "Restart must retain these notes"
            );
            assert!(core
                .confirmed_session_processing(Some(&snapshot.plan.fingerprint))
                .is_err());
            assert_eq!(core.recording_state().status, CaptureStatus::Idle);
        }
    }

    #[test]
    fn consent_is_not_attachable_to_other_sources_or_after_review_expiry() {
        let mut core = core();
        let id = core.create_note("Fictional existing note").unwrap();
        let plan = core
            .prepare_session_processing(Request::LiveOnly {})
            .unwrap();
        {
            let tx = core.db.transaction().unwrap();
            assert_eq!(
                attach(&tx, &plan, &id).unwrap_err().code,
                "session_processing"
            );
        }
        let expired = core
            .prepare_session_processing_at(Request::LiveOnly {}, 100)
            .unwrap();
        {
            let tx = core.db.transaction().unwrap();
            assert_eq!(
                attach(&tx, &expired, &id).unwrap_err().code,
                "session_consent_changed"
            );
        }
        assert!(core.session_processing(&id).unwrap().is_none());
        assert_eq!(core.get_meeting(&id).unwrap().meeting.source, "note");
    }

    #[test]
    fn unchanged_speech_settings_and_shortcuts_do_not_invalidate_consent() {
        let mut core = core();
        let plan = core
            .prepare_session_processing(Request::LiveOnly {})
            .unwrap();
        let id = attach_synthetic(&mut core, &plan);
        let original = core.settings().unwrap();
        core.save_stt_settings(
            &original.stt_language,
            &original.stt_prompt,
            &original.stt_model,
        )
        .unwrap();
        core.save_shortcuts("Control+Shift+F9", Some("Control+Shift+F10"))
            .unwrap();
        assert_eq!(
            core.session_processing(&id).unwrap().unwrap().state,
            State::Prepared
        );
        core.save_stt_mode(SttMode::Cloud).unwrap();
        let changed = core.session_processing(&id).unwrap().unwrap();
        assert_eq!(
            (changed.state, changed.revision),
            (State::ConsentRequired, 2)
        );
        core.save_stt_mode(SttMode::Local).unwrap();
        assert_eq!(
            core.session_processing(&id).unwrap().unwrap().state,
            State::ConsentRequired
        );
    }

    #[test]
    fn expired_durable_consent_needs_review_and_does_not_revive_on_repeated_reads() {
        let mut core = core();
        let plan = core
            .prepare_session_processing(Request::LiveOnly {})
            .unwrap();
        let id = attach_synthetic(&mut core, &plan);
        core.db.execute("UPDATE processing_sessions SET started_at=0,authorized_until=1 WHERE meeting_id=?1", [&id]).unwrap();
        for _ in 0..2 {
            let snapshot = core.session_processing(&id).unwrap().unwrap();
            assert_eq!(
                (snapshot.state, snapshot.revision),
                (State::ConsentRequired, 2)
            );
        }
        let cancelled = core.cancel_session_processing(&id, 2).unwrap();
        assert_eq!((cancelled.state, cancelled.revision), (State::Cancelled, 3));
    }

    #[test]
    fn upgrade_from_populated_v12_retains_output_search_and_provider_references() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("meetings.db");
        {
            let db = crate::storage::test_v11_database(&path);
            db.execute_batch(include_str!("../migrations/012_saved_connections.sql"))
                .unwrap();
            db.execute_batch("INSERT INTO meetings(id,title,started_at,source,status) VALUES ('existing','Fictional upgrade','test','fixture','stopped');
                INSERT INTO notes(meeting_id,user_markdown,revision) VALUES ('existing','Preserve the original notes',7);
                INSERT INTO segments(id,meeting_id,speaker,start_ms,end_ms,text,source,pass) VALUES (42,'existing','You',0,1000,'Persimmon original','fixture','final');
                INSERT INTO summaries(meeting_id,template_hash,model,provider,markdown) VALUES ('existing','general-v1','hand-written','fixture','Original summary');
                INSERT INTO saved_connections(id,name,base_url,credential_account,revision) VALUES ('original-provider','Fictional provider','https://provider.example/v1','existing-reference',3);
                UPDATE provider_assignments SET connection_id='original-provider',model='original-model',revision=2 WHERE role='llm';").unwrap();
        }
        for _ in 0..2 {
            let core = Core::open(&path).unwrap();
            let detail = core.get_meeting("existing").unwrap();
            assert_eq!(
                (detail.user_markdown.as_str(), detail.notes_revision),
                ("Preserve the original notes", 7)
            );
            assert_eq!(detail.segments[0].text, "Persimmon original");
            assert_eq!(detail.summary.as_deref(), Some("Original summary"));
            assert_eq!(
                core.search_meetings("Persimmon").unwrap()[0].meeting_id,
                "existing"
            );
            assert_eq!(
                core.settings().unwrap().saved_connections[0]
                    .credential_account
                    .as_deref(),
                Some("existing-reference")
            );
            assert_eq!(
                core.settings().unwrap().llm.unwrap().model.as_deref(),
                Some("original-model")
            );
            assert!(core.session_processing("existing").unwrap().is_none());
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
