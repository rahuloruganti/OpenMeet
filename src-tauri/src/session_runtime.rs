//! Blocking session runner. Core owns every durable transition and publication.
use crate::{
    cloud_stt,
    domain::{CaptureStatus, ProviderRole, Result, Segment, Settings, SttMode},
    live_audio::Chunk,
    processing_control::Guard,
    session_processing::{Scope, State},
    session_workflow::{self, Stage},
    storage::Core,
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, TryRecvError},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter};

fn core<T>(app: &AppHandle, operation: impl FnOnce(&mut Core) -> Result<T>) -> Result<T> {
    operation(&mut *crate::lock_core(app)?)
}
pub(crate) fn notify(app: &AppHandle, id: &str) {
    if let Ok(Some(snapshot)) = core(app, |core| core.session_processing(id)) {
        let _ = app.emit("session_processing_changed", snapshot);
    }
}
pub(crate) fn launch_pending(app: &AppHandle) {
    let pending = core(app, |core| {
        if core.quitting {
            return Ok(None);
        }
        let Some((id, receiver, incomplete)) = core.live_receiver.take() else {
            return Ok(None);
        };
        Ok(core
            .processing_workflow(&id)?
            .map(|workflow| (id, workflow.run_id, receiver, incomplete)))
    });
    if let Ok(Some((id, run_id, receiver, incomplete))) = pending {
        spawn(app.clone(), id, run_id, Some(receiver), incomplete);
    }
}
pub(crate) fn spawn(
    app: AppHandle,
    id: String,
    run_id: String,
    receiver: Option<Receiver<Chunk>>,
    incomplete: Arc<AtomicBool>,
) {
    let failure_app = app.clone();
    let failure_id = id.clone();
    let failure_run = run_id.clone();
    if std::thread::Builder::new()
        .name("openmeet-processing".into())
        .spawn(move || run(&app, &id, &run_id, receiver, incomplete))
        .is_err()
    {
        let _ = core(&failure_app, |core| {
            core.fail_processing(&failure_id, &failure_run, "worker")
        });
        notify(&failure_app, &failure_id);
    }
}
fn run(
    app: &AppHandle,
    id: &str,
    run_id: &str,
    receiver: Option<Receiver<Chunk>>,
    incomplete: Arc<AtomicBool>,
) {
    loop {
        let snapshot = match core(app, |core| core.session_processing(id)) {
            Ok(Some(snapshot)) => snapshot,
            _ => return,
        };
        let Some(workflow) = snapshot.workflow else {
            return;
        };
        if workflow.run_id != run_id {
            return;
        }
        if snapshot.state != State::Prepared && !workflow.stage.terminal() {
            let _ = core(app, |core| {
                core.fail_processing(id, &workflow.run_id, "session_consent_changed")
            });
            notify(app, id);
            return;
        }
        if workflow.stage.terminal() {
            notify(app, id);
            return;
        }
        let result = match workflow.stage {
            Stage::Live => {
                if incomplete.load(Ordering::SeqCst) {
                    let _ = core(app, |core| core.mark_live_incomplete(id, &workflow.run_id));
                }
                let state = match core(app, |core| Ok(core.recording_state())) {
                    Ok(state) => state,
                    Err(_) => return,
                };
                if state.meeting_id.as_deref() != Some(id) {
                    return;
                }
                if state.status != CaptureStatus::Recording {
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                match receiver.as_ref().map(Receiver::try_recv) {
                    Some(Ok(chunk)) => {
                        let result = live(app, id, &workflow.run_id, &chunk);
                        if result.is_err() {
                            let _ =
                                core(app, |core| core.mark_live_incomplete(id, &workflow.run_id));
                        }
                        notify(app, id);
                        // Live failures never stop recording or prevent the final pass.
                        std::thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    Some(Err(TryRecvError::Empty | TryRecvError::Disconnected)) | None => {
                        std::thread::sleep(Duration::from_millis(100));
                        continue;
                    }
                }
            }
            Stage::FinalizingAudio => final_transcript(app, id, &workflow.run_id),
            Stage::AwaitingNotes => {
                if workflow.notes_revision.is_none() {
                    std::thread::sleep(Duration::from_millis(200));
                    continue;
                }
                summary(app, id, &workflow.run_id)
            }
            _ => Err(session_workflow::stale()),
        };
        if let Err(error) = result {
            let _ = core(app, |core| {
                core.fail_processing(id, &workflow.run_id, error.code)
            });
            notify(app, id);
            return;
        }
        notify(app, id);
    }
}
fn owner(app: &AppHandle, id: &str, run: &str) -> Result<Guard> {
    core(app, |core| Ok(core.processing_owner.clone()))?.begin_session(id, run)
}
fn speech(
    app: &AppHandle,
    id: &str,
    run: &str,
    stage: Stage,
    guard: &Guard,
    tracks: &[crate::audio::Track],
    settings: &Settings,
) -> Result<(Vec<Segment>, String, String)> {
    core(app, |core| {
        core.check_processing(id, run, stage, true).map(|_| ())
    })?;
    match settings.stt_mode {
        SttMode::Local => Ok((
            crate::stt::transcribe(
                &crate::stt_root(app)?,
                tracks,
                settings,
                guard.cancel(),
                |_, _| {},
            )?,
            "whisper".into(),
            settings.stt_model.clone(),
        )),
        SttMode::Cloud => {
            let config = crate::require_connection(settings, ProviderRole::CloudStt)?;
            let remote = crate::providers::load_connection(&config)?;
            let plan = cloud_stt::plan_cancellable(tracks, guard.cancel())?;
            let segments = cloud_stt::transcribe(
                &remote,
                tracks,
                &settings.stt_language,
                &settings.stt_prompt,
                &plan,
                guard.cancel(),
                |_, _| {},
                |fingerprint, bytes| {
                    core(app, |core| {
                        core.reserve_processing_request(id, run, stage, fingerprint, bytes, 0)
                    })
                },
            )?;
            Ok((segments, config.base_url, remote.model()?.into()))
        }
    }
}
fn live(app: &AppHandle, id: &str, run: &str, chunk: &Chunk) -> Result<()> {
    let guard = owner(app, id, run)?;
    let settings = core(app, |core| {
        core.check_processing(id, run, Stage::Live, true)?;
        core.live_cancellation = Some((id.into(), guard.cancellation_handle()));
        core.settings()
    })?;
    let materialized = chunk.materialize()?;
    let (segments, _, _) = speech(
        app,
        id,
        run,
        Stage::Live,
        &guard,
        std::slice::from_ref(&materialized.track),
        &settings,
    )?;
    guard.finish(|| {
        core(app, |core| {
            core.publish_provisional(id, run, &chunk.kind, chunk.chunk_id, &segments)
        })
    })
}
fn final_transcript(app: &AppHandle, id: &str, run: &str) -> Result<()> {
    let guard = owner(app, id, run)?;
    let (settings, tracks) = core(app, |core| {
        core.processing_stage(id, run, Stage::FinalizingAudio, Stage::Transcribing)?;
        let detail = core.get_meeting(id)?;
        Ok((core.settings()?, crate::finalized_tracks(&detail)?))
    })?;
    notify(app, id);
    let (segments, provider, model) = speech(
        app,
        id,
        run,
        Stage::Transcribing,
        &guard,
        &tracks,
        &settings,
    )?;
    guard.finish(|| {
        core(app, |core| {
            core.publish_final(id, run, &segments, &provider, &model)
        })
    })?;
    let _ = app.emit("meeting_updated", ());
    Ok(())
}
fn summary(app: &AppHandle, id: &str, run: &str) -> Result<()> {
    let guard = owner(app, id, run)?;
    let (notes, revision, segments, settings, template, system) = core(app, |core| {
        let snapshot = core.check_processing(id, run, Stage::AwaitingNotes, false)?;
        let Scope::Final {
            summary: Some(summary),
            ..
        } = snapshot.plan.scope
        else {
            return Err(session_workflow::stale());
        };
        core.processing_stage(id, run, Stage::AwaitingNotes, Stage::Summarizing)?;
        let (notes, revision) = core.frozen_processing_notes(id, run)?;
        let detail = core.get_meeting(id)?;
        Ok((
            notes,
            revision,
            (detail.segments, detail.speaker_names),
            core.settings()?,
            summary.template,
            crate::llm::summary_system(
                crate::llm::Structure::Builtin(summary.template),
                &summary.instructions,
            ),
        ))
    })?;
    notify(app, id);
    let config = crate::require_connection(&settings, ProviderRole::Llm)?;
    let remote = crate::providers::load_connection(&config)?;
    let (segments, names) = segments;
    let lines = crate::transcript_lines(&segments, &names);
    let markdown =
        crate::llm::summarize(&remote, &system, &notes, &lines, guard.cancel(), |body| {
            let fingerprint = crate::domain::sha256_hex(body);
            core(app, |core| {
                core.reserve_processing_request(
                    id,
                    run,
                    Stage::Summarizing,
                    &fingerprint,
                    0,
                    body.len(),
                )
            })
        })?;
    guard.finish(|| {
        core(app, |core| {
            core.publish_session_summary(
                id,
                run,
                revision,
                &segments,
                &config.base_url,
                remote.model()?,
                &markdown,
                template.id(),
            )
        })
    })?;
    let _ = app.emit("meeting_updated", ());
    Ok(())
}
