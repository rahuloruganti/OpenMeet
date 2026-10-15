//! Durable session stages and request authorization. Engines never write these tables.
use crate::{
    domain::{AppError, CaptureStatus, Result, Segment},
    session_processing::{clock, Plan, Request, Scope, Snapshot, State},
    storage::Core,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Live,
    FinalizingAudio,
    Transcribing,
    AwaitingNotes,
    Summarizing,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
    ConsentRequired,
}
impl Stage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::FinalizingAudio => "finalizing_audio",
            Self::Transcribing => "transcribing",
            Self::AwaitingNotes => "awaiting_notes",
            Self::Summarizing => "summarizing",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
            Self::ConsentRequired => "consent_required",
        }
    }
    pub fn terminal(self) -> bool {
        matches!(
            self,
            Self::Completed
                | Self::Failed
                | Self::Cancelled
                | Self::Interrupted
                | Self::ConsentRequired
        )
    }
}
fn stage(value: &str) -> Result<Stage> {
    Ok(match value {
        "live" => Stage::Live,
        "finalizing_audio" => Stage::FinalizingAudio,
        "transcribing" => Stage::Transcribing,
        "awaiting_notes" => Stage::AwaitingNotes,
        "summarizing" => Stage::Summarizing,
        "completed" => Stage::Completed,
        "failed" => Stage::Failed,
        "cancelled" => Stage::Cancelled,
        "interrupted" => Stage::Interrupted,
        "consent_required" => Stage::ConsentRequired,
        _ => return Err(stale()),
    })
}
#[derive(Clone, Debug, Serialize)]
pub struct Provisional {
    pub id: String,
    pub chunk_id: i64,
    pub segment: Segment,
}
#[derive(Clone, Debug, Serialize)]
pub struct Workflow {
    pub run_id: String,
    pub attempt: i64,
    pub stage: Stage,
    pub error: Option<String>,
    pub live_incomplete: bool,
    pub transcript_done: bool,
    pub notes_barrier: Option<String>,
    pub notes_revision: Option<i64>,
    pub requests_used: i64,
    pub upload_bytes_used: i64,
    pub text_bytes_used: i64,
    pub provisional: Vec<Provisional>,
}
pub(crate) fn stale() -> AppError {
    AppError::new(
        "processing_cancelled",
        "Processing changed or was cancelled. Previous saved output is unchanged.",
    )
}
fn bump(db: &Connection, id: &str) -> Result<()> {
    db.execute(
        "UPDATE processing_sessions SET revision=revision+1 WHERE meeting_id=?1",
        [id],
    )?;
    Ok(())
}

impl Core {
    pub(crate) fn processing_workflow(&self, id: &str) -> Result<Option<Workflow>> {
        let row = self.db.query_row("SELECT run_id,attempt,stage,error,live_incomplete,transcript_done,notes_barrier,notes_revision,requests_used,upload_bytes_used,text_bytes_used FROM processing_runs WHERE meeting_id=?1", [id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,bool>(4)?,r.get::<_,bool>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,Option<i64>>(7)?,r.get::<_,i64>(8)?,r.get::<_,i64>(9)?,r.get::<_,i64>(10)?))).optional()?;
        let Some((
            run_id,
            attempt,
            status,
            error,
            live_incomplete,
            transcript_done,
            notes_barrier,
            notes_revision,
            requests_used,
            upload_bytes_used,
            text_bytes_used,
        )) = row
        else {
            return Ok(None);
        };
        let mut query = self.db.prepare("SELECT id,chunk_id,segment_json FROM processing_provisional WHERE meeting_id=?1 AND run_id=?2 ORDER BY chunk_id,id LIMIT 200")?;
        let rows = query.query_map(params![id, run_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut provisional = Vec::new();
        for row in rows {
            let (id, chunk_id, json) = row?;
            provisional.push(Provisional {
                id,
                chunk_id,
                segment: serde_json::from_str(&json).map_err(|_| stale())?,
            });
        }
        Ok(Some(Workflow {
            run_id,
            attempt,
            stage: stage(&status)?,
            error,
            live_incomplete,
            transcript_done,
            notes_barrier,
            notes_revision,
            requests_used,
            upload_bytes_used,
            text_bytes_used,
            provisional,
        }))
    }

    pub(crate) fn check_processing(
        &self,
        id: &str,
        run: &str,
        expected: Stage,
        dispatch: bool,
    ) -> Result<Snapshot> {
        if self.quitting {
            return Err(stale());
        }
        let snapshot = self.session_processing(id)?.ok_or_else(stale)?;
        let workflow = snapshot.workflow.as_ref().ok_or_else(stale)?;
        if snapshot.state != State::Prepared || workflow.run_id != run || workflow.stage != expected
        {
            return Err(stale());
        }
        let current: i64 = self.db.query_row(
            "SELECT revision FROM processing_configuration WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        if current != snapshot.plan.configuration_revision || clock()? >= snapshot.authorized_until
        {
            return Err(stale());
        }
        let allowed = match &snapshot.plan.scope {
            Scope::LiveOnly { .. } => expected == Stage::Live,
            Scope::Final { live, summary, .. } => match expected {
                Stage::Live => *live,
                Stage::Summarizing => summary.is_some(),
                Stage::FinalizingAudio | Stage::Transcribing | Stage::AwaitingNotes => true,
                _ => false,
            },
        };
        if !allowed {
            return Err(stale());
        }
        if expected == Stage::Live {
            let recording = self.recording_state();
            if dispatch
                && (recording.meeting_id.as_deref() != Some(id)
                    || recording.status != CaptureStatus::Recording)
            {
                return Err(AppError::new(
                    "processing_paused",
                    "Live dispatch is paused.",
                ));
            }
            if clock()? > snapshot.started_at + i64::from(snapshot.plan.limits.duration_seconds) {
                return Err(AppError::new(
                    "processing_budget",
                    "The live processing duration limit was reached. Recording continues.",
                ));
            }
        }
        Ok(snapshot)
    }

    pub(crate) fn processing_stage(
        &mut self,
        id: &str,
        run: &str,
        expected: Stage,
        next: Stage,
    ) -> Result<()> {
        self.check_processing(id, run, expected, false)?;
        let tx = self.db.transaction()?;
        if tx.execute("UPDATE processing_runs SET stage=?1,error=NULL WHERE meeting_id=?2 AND run_id=?3 AND stage=?4", params![next.as_str(),id,run,expected.as_str()])? != 1 { return Err(stale()); }
        bump(&tx, id)?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn reserve_processing_request(
        &mut self,
        id: &str,
        run: &str,
        expected: Stage,
        fingerprint: &str,
        audio_bytes: u64,
        text_bytes: usize,
    ) -> Result<()> {
        let snapshot = self.check_processing(id, run, expected, true)?;
        let workflow = snapshot.workflow.ok_or_else(stale)?;
        let audio = i64::try_from(audio_bytes).map_err(|_| stale())?;
        let text = i64::try_from(text_bytes).map_err(|_| stale())?;
        let requests = workflow.requests_used.checked_add(1).ok_or_else(stale)?;
        let uploaded = workflow
            .upload_bytes_used
            .checked_add(audio)
            .ok_or_else(stale)?;
        let texts = workflow
            .text_bytes_used
            .checked_add(text)
            .ok_or_else(stale)?;
        if requests > i64::from(snapshot.plan.limits.requests)
            || uploaded > i64::try_from(snapshot.plan.limits.upload_bytes).map_err(|_| stale())?
            || texts > i64::from(snapshot.plan.limits.text_bytes)
        {
            return Err(AppError::new("processing_budget", "The session request, audio, or text budget was exhausted. Review before retrying; recording continues."));
        }
        let tx = self.db.transaction()?;
        tx.execute("INSERT INTO processing_requests(meeting_id,run_id,ordinal,fingerprint,audio_bytes,text_bytes) VALUES (?1,?2,?3,?4,?5,?6)",params![id,run,requests,fingerprint,audio,text])?;
        tx.execute("UPDATE processing_runs SET requests_used=?1,upload_bytes_used=?2,text_bytes_used=?3 WHERE meeting_id=?4 AND run_id=?5",params![requests,uploaded,texts,id,run])?;
        bump(&tx, id)?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn mark_live_incomplete(&mut self, id: &str, run: &str) -> Result<()> {
        let tx = self.db.transaction()?;
        if tx.execute("UPDATE processing_runs SET live_incomplete=1,error='Live preview is incomplete. Final transcription uses the saved audio.' WHERE meeting_id=?1 AND run_id=?2 AND live_incomplete=0 AND stage='live'",params![id,run])? !=0 { bump(&tx,id)?; }
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn publish_provisional(
        &mut self,
        id: &str,
        run: &str,
        kind: &str,
        chunk_id: u64,
        segments: &[Segment],
    ) -> Result<()> {
        self.check_processing(id, run, Stage::Live, false)?;
        let existing:i64=self.db.query_row("SELECT COALESCE(SUM(length(CAST(segment_json AS BLOB))),0) FROM processing_provisional WHERE meeting_id=?1",[id],|r|r.get(0))?;
        let encoded = segments
            .iter()
            .enumerate()
            .map(|(index, segment)| {
                Ok((
                    format!("{run}:{kind}:{chunk_id}:{index}"),
                    serde_json::to_string(segment).map_err(|_| stale())?,
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        if existing
            + encoded
                .iter()
                .map(|(_, json)| json.len() as i64)
                .sum::<i64>()
            > 1_048_576
            || encoded.len() > 200
        {
            return self.mark_live_incomplete(id, run);
        }
        let tx = self.db.transaction()?;
        for (key, json) in encoded {
            tx.execute("INSERT OR IGNORE INTO processing_provisional(id,meeting_id,run_id,chunk_id,segment_json) VALUES (?1,?2,?3,?4,?5)",params![key,id,run,i64::try_from(chunk_id).map_err(|_|stale())?,json])?;
        }
        tx.execute("DELETE FROM processing_provisional WHERE meeting_id=?1 AND id NOT IN (SELECT id FROM processing_provisional WHERE meeting_id=?1 ORDER BY chunk_id DESC,id DESC LIMIT 200)",[id])?;
        bump(&tx, id)?;
        tx.commit()?;
        Ok(())
    }

    pub fn acknowledge_processing_notes(
        &mut self,
        id: &str,
        run: &str,
        barrier: &str,
        revision: i64,
    ) -> Result<Snapshot> {
        let snapshot = self.session_processing(id)?.ok_or_else(stale)?;
        let workflow = snapshot.workflow.as_ref().ok_or_else(stale)?;
        self.check_processing(id, run, workflow.stage, false)?;
        if !matches!(
            snapshot.plan.scope,
            Scope::Final {
                summary: Some(_),
                ..
            }
        ) || workflow.run_id != run
            || workflow.notes_barrier.as_deref() != Some(barrier)
            || workflow.stage.terminal()
        {
            return Err(stale());
        }
        if let Some(saved) = workflow.notes_revision {
            return if saved == revision {
                Ok(snapshot)
            } else {
                Err(AppError::new(
                    "notes_conflict",
                    "The saved-note acknowledgement changed. Refresh before retrying.",
                ))
            };
        }
        let detail = self.get_meeting(id)?;
        if detail.meeting.status != "stopped" || detail.notes_revision != revision {
            return Err(AppError::new(
                "notes_conflict",
                "Save the meeting notes before acknowledging processing.",
            ));
        }
        let tx = self.db.transaction()?;
        tx.execute("UPDATE processing_runs SET notes_revision=?1,notes_snapshot=?2 WHERE meeting_id=?3 AND run_id=?4",params![revision,detail.user_markdown,id,run])?;
        bump(&tx, id)?;
        tx.commit()?;
        self.session_processing(id)?.ok_or_else(stale)
    }

    pub(crate) fn publish_final(
        &mut self,
        id: &str,
        run: &str,
        segments: &[Segment],
        provider: &str,
        model: &str,
    ) -> Result<()> {
        let snapshot = self.check_processing(id, run, Stage::Transcribing, false)?;
        let summary = matches!(
            snapshot.plan.scope,
            Scope::Final {
                summary: Some(_),
                ..
            }
        );
        let tx = self.db.transaction()?;
        crate::storage::replace_transcript_in(&tx, id, segments, provider, model)?;
        tx.execute(
            "DELETE FROM processing_provisional WHERE meeting_id=?1",
            [id],
        )?;
        tx.execute("UPDATE processing_runs SET transcript_done=1,stage=?1,error=NULL WHERE meeting_id=?2 AND run_id=?3",params![if summary {"awaiting_notes"} else {"completed"},id,run])?;
        bump(&tx, id)?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn frozen_processing_notes(&self, id: &str, run: &str) -> Result<(String, i64)> {
        self.check_processing(id, run, Stage::Summarizing, false)?;
        let row:(Option<String>,Option<i64>)=self.db.query_row("SELECT notes_snapshot,notes_revision FROM processing_runs WHERE meeting_id=?1 AND run_id=?2",params![id,run],|r|Ok((r.get(0)?,r.get(1)?)))?;
        match row {
            (Some(notes), Some(revision)) => Ok((notes, revision)),
            _ => Err(stale()),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn publish_session_summary(
        &mut self,
        id: &str,
        run: &str,
        revision: i64,
        segments: &[Segment],
        provider: &str,
        model: &str,
        markdown: &str,
        template: &str,
    ) -> Result<()> {
        self.check_processing(id, run, Stage::Summarizing, false)?;
        let detail = self.get_meeting(id)?;
        if detail.notes_revision != revision || detail.segments != segments {
            return Err(AppError::new("notes_conflict","Meeting content changed during summary generation. Previous summary is unchanged; review before retrying."));
        }
        let tx = self.db.transaction()?;
        tx.execute("INSERT INTO summaries(meeting_id,template_hash,model,provider,markdown) VALUES (?1,?2,?3,?4,?5)",params![id,template,model,provider,markdown])?;
        tx.execute("UPDATE processing_runs SET stage='completed',error=NULL WHERE meeting_id=?1 AND run_id=?2",params![id,run])?;
        bump(&tx, id)?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn fail_processing(&mut self, id: &str, run: &str, code: &str) -> Result<()> {
        let (stage,message)=match code {
            "processing_cancelled"|"session_consent_changed" => ("consent_required","Processing permission changed. Review before retrying."),
            "processing_budget" => ("failed","The session processing limit was reached. Review before retrying."),
            "notes_conflict" => ("failed","Notes or transcript changed. Previous output is unchanged; review before retrying."),
            _ => ("failed","Processing failed. Original audio, notes, and earlier output are preserved. Review before retrying; a previous request may already have been billed."),
        };
        let tx = self.db.transaction()?;
        if tx.execute("UPDATE processing_runs SET stage=?1,error=?2 WHERE meeting_id=?3 AND run_id=?4 AND stage NOT IN ('completed','cancelled','interrupted')",params![stage,message,id,run])? !=0 {bump(&tx,id)?;}
        tx.commit()?;
        Ok(())
    }

    fn check_retry_audio_horizon(&self, id: &str, seconds: u32) -> Result<()> {
        let detail = self.get_meeting(id)?;
        let duration: Option<f64> = self.db.query_row(
            "SELECT (julianday(ended_at)-julianday(started_at))*86400 FROM meetings WHERE id=?1 AND status='stopped'",
            [id], |row| row.get(0),
        ).optional()?.flatten();
        if detail.meeting.source != "desktop"
            || duration
                .is_none_or(|duration| duration < 0.0 || duration > f64::from(seconds) + 0.001)
            || detail.tracks.iter().any(|track| {
                track.sample_rate == 0
                    || track.frames < 0
                    || track.frames as f64 / f64::from(track.sample_rate) > f64::from(seconds)
            })
        {
            return Err(AppError::new("processing_retry", "This recording exceeds the session review or is not finalized. Use manual transcription with its exact saved-audio review."));
        }
        Ok(())
    }

    pub fn prepare_session_retry(&mut self, id: &str) -> Result<Plan> {
        let snapshot = self.session_processing(id)?.ok_or_else(stale)?;
        self.check_retry_audio_horizon(id, snapshot.plan.limits.duration_seconds)?;
        let workflow = snapshot.workflow.ok_or_else(stale)?;
        if !workflow.stage.terminal() || workflow.stage == Stage::Completed {
            return Err(stale());
        }
        let request=match snapshot.plan.scope { Scope::Final {summary,..}=>Request::Final {live:false,summary:summary.map(|s|s.template)}, Scope::LiveOnly {..}=>return Err(AppError::new("processing_retry","A stopped live-only preview cannot restart. Use manual final transcription instead.")) };
        let mut plan = self.prepare_session_processing(request)?;
        plan.meeting_id = Some(id.into());
        crate::session_processing::seal(&mut plan)?;
        self.pending_processing = Some(plan.clone());
        Ok(plan)
    }

    pub fn retry_session_processing(&mut self, id: &str, confirmation: &str) -> Result<Snapshot> {
        let plan = self
            .confirmed_session_processing(Some(confirmation))?
            .ok_or_else(stale)?;
        if plan.meeting_id.as_deref() != Some(id)
            || self.get_meeting(id)?.meeting.status != "stopped"
        {
            return Err(stale());
        }
        self.check_retry_audio_horizon(id, plan.limits.duration_seconds)?;
        let previous = self
            .session_processing(id)?
            .and_then(|s| s.workflow)
            .ok_or_else(stale)?;
        if !previous.stage.terminal() || previous.stage == Stage::Completed {
            return Err(stale());
        }
        let now = clock()?;
        let barrier = Uuid::new_v4().to_string();
        let tx = self.db.transaction()?;
        tx.execute("UPDATE processing_sessions SET id=?1,plan_json=?2,state='prepared',revision=revision+1,started_at=?3,authorized_until=?4 WHERE meeting_id=?5",params![plan.id,serde_json::to_string(&plan).map_err(|_|stale())?,now,now+i64::from(plan.limits.post_stop_seconds),id])?;
        tx.execute("UPDATE processing_runs SET run_id=?1,attempt=attempt+1,stage=?2,error=NULL,notes_barrier=?3,notes_revision=NULL,notes_snapshot=NULL,requests_used=0,upload_bytes_used=0,text_bytes_used=0 WHERE meeting_id=?4",params![plan.id,if previous.transcript_done {"awaiting_notes"} else {"finalizing_audio"},barrier,id])?;
        tx.execute(
            "DELETE FROM processing_provisional WHERE meeting_id=?1",
            [id],
        )?;
        tx.commit()?;
        self.pending_processing = None;
        self.session_processing(id)?.ok_or_else(stale)
    }

    pub(crate) fn interrupt_processing(&mut self) -> Result<()> {
        self.quitting = true;
        let tx = self.db.transaction()?;
        tx.execute("UPDATE processing_sessions SET state='interrupted',revision=revision+1 WHERE state='prepared' AND meeting_id IN (SELECT meeting_id FROM processing_runs WHERE stage NOT IN ('completed','failed','cancelled','interrupted','consent_required'))",[])?;
        tx.execute("UPDATE processing_runs SET stage='interrupted',error='Processing stopped when the app closed. Review before retrying.' WHERE stage NOT IN ('completed','failed','cancelled','interrupted','consent_required')",[])?;
        tx.commit()?;
        Ok(())
    }
}

pub(crate) fn stopped(tx: &Transaction<'_>, id: &str, success: bool, quitting: bool) -> Result<()> {
    let json: Option<String> = tx
        .query_row(
            "SELECT plan_json FROM processing_sessions WHERE meeting_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(json) = json else {
        return Ok(());
    };
    let plan: Plan = serde_json::from_str(&json).map_err(|_| stale())?;
    let started: i64 = tx.query_row(
        "SELECT started_at FROM processing_sessions WHERE meeting_id=?1",
        [id],
        |r| r.get(0),
    )?;
    let now = clock()?;
    let (stage, error) = if quitting {
        (
            "interrupted",
            Some("Processing stopped when the app closed. Review before retrying."),
        )
    } else if !success {
        (
            "failed",
            Some("Audio finalization failed. Recover complete audio before retrying processing."),
        )
    } else if now > started + i64::from(plan.limits.duration_seconds) {
        ("consent_required",Some("Recording exceeded the reviewed processing duration. Review before submitting its audio."))
    } else if matches!(plan.scope, Scope::LiveOnly { .. }) {
        ("completed", None)
    } else {
        ("finalizing_audio", None)
    };
    if tx.execute("UPDATE processing_runs SET stage=?1,error=?2,notes_barrier=?3 WHERE meeting_id=?4 AND stage='live'",params![stage,error,Uuid::new_v4().to_string(),id])? !=0 {
        tx.execute("UPDATE processing_sessions SET authorized_until=MIN(authorized_until,?1),revision=revision+1 WHERE meeting_id=?2",params![now+i64::from(plan.limits.post_stop_seconds),id])?;
    }
    Ok(())
}
