mod action_items;
pub mod audio;
mod audio_timing;
mod capture_gate;
mod cloud_stt;
mod domain;
mod export;
mod library_answers;
mod live_audio;
mod llm;
mod model_library;
#[cfg(test)]
mod phase_three_tests;
mod processing_control;
mod providers;
mod question_threads;
mod recipes;
mod retrieval;
mod session_processing;
mod session_runtime;
mod session_workflow;
mod storage;
mod stt;
mod transcript_edits;

use domain::*;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use storage::Core;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

struct AppState {
    core: Mutex<Core>,
    provider_writes: Mutex<()>,
    startup_warning: Option<String>,
    allow_exit: AtomicBool,
}

async fn with_core<T, F>(app: AppHandle, changed: bool, operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&mut Core, &AppHandle) -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut core = state.core.lock().map_err(|_| {
            AppError::new(
                "internal",
                "The application state is unavailable. Restart OpenMeet.",
            )
        })?;
        let revision = core.recording_state().revision;
        let result = operation(&mut core, &app);
        if changed || core.recording_state().revision != revision {
            publish(&app, &core.recording_state());
        }
        drop(core);
        session_runtime::launch_pending(&app);
        result
    })
    .await
    .map_err(|_| AppError::new("worker", "The background operation failed."))?
}

fn publish(app: &AppHandle, state: &RecordingState) {
    if let Some(tray) = app.tray_by_id("recorder") {
        let label = match &state.status {
            CaptureStatus::Recording => "OpenMeet — RECORDING microphone + system audio",
            CaptureStatus::Paused => "OpenMeet — audio PAUSED",
            _ => "OpenMeet — capture preview, idle",
        };
        let _ = tray.set_tooltip(Some(label));
        let _ = tray.set_icon(Some(tray_image(&state.status)));
    }
    // Events are notifications only; commands always return authoritative state.
    let _ = app.emit("recording_state", state);
    let _ = app.emit("meeting_updated", ());
}

fn tray_image(status: &CaptureStatus) -> tauri::image::Image<'static> {
    let color = match status {
        CaptureStatus::Recording => [220, 50, 50, 255],
        CaptureStatus::Paused => [220, 150, 20, 255],
        _ => [50, 140, 110, 255],
    };
    let mut pixels = Vec::with_capacity(16 * 16 * 4);
    for y in 0_i32..16 {
        for x in 0_i32..16 {
            pixels.extend_from_slice(if (x - 8).pow(2) + (y - 8).pow(2) < 49 {
                &color
            } else {
                &[0, 0, 0, 0]
            });
        }
    }
    tauri::image::Image::new_owned(pixels, 16, 16)
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn tray_action(
    app: &AppHandle,
    action: impl FnOnce(&mut Core) -> Result<RecordingState> + Send + 'static,
) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = with_core(app.clone(), true, move |core, _| action(core)).await;
        if let Err(error) = result {
            show_window(&app);
            let _ = app.emit("backend_error", error.message);
        }
    });
}

/// Global shortcuts can pause/resume or stop. There is deliberately no start shortcut:
/// starting always goes through setup and consent.
fn shortcut_action(app: &AppHandle, pressed: Shortcut) {
    tray_action(app, move |core| {
        let stop = core.settings()?.stop_shortcut;
        if stop.and_then(|text| text.parse::<Shortcut>().ok()) == Some(pressed) {
            core.stop()
        } else {
            core.toggle_pause()
        }
    });
}

fn parse_shortcuts(pause: &str, stop: Option<&str>) -> Result<(Shortcut, Option<Shortcut>)> {
    let parse = |text: &str| -> Result<Shortcut> {
        if text.len() > 100 {
            return Err(AppError::new("invalid_shortcut", "Shortcut is too long."));
        }
        text.parse().map_err(|_| {
            AppError::new(
                "invalid_shortcut",
                "Use a shortcut such as CommandOrControl+Shift+Space.",
            )
        })
    };
    let pause = parse(pause)?;
    let stop = stop.map(parse).transpose()?;
    if stop == Some(pause) {
        return Err(AppError::new(
            "invalid_shortcut",
            "Use different shortcuts for pause and stop.",
        ));
    }
    Ok((pause, stop))
}

/// Names every shortcut that failed to register, since another app may own each chord.
fn shortcut_warning(pause: Option<&str>, stop: Option<&str>) -> Option<String> {
    let failed: Vec<String> = [("Pause", pause), ("Stop", stop)]
        .into_iter()
        .filter_map(|(name, chord)| chord.map(|chord| format!("{name} ({chord})")))
        .collect();
    (!failed.is_empty()).then(|| {
        format!(
            "Shortcut unavailable: {}. Another app may be using it. Use the on-screen controls and choose another shortcut in Settings.",
            failed.join(" and ")
        )
    })
}

#[tauri::command]
async fn list_meetings(app: AppHandle) -> Result<Vec<Meeting>> {
    with_core(app, false, |core, _| core.list_meetings()).await
}

#[tauri::command]
async fn get_meeting(app: AppHandle, id: String) -> Result<MeetingDetail> {
    with_core(app, false, move |core, _| core.get_meeting(&id)).await
}

#[tauri::command]
async fn get_recording_state(app: AppHandle) -> Result<RecordingState> {
    with_core(app, false, |core, _| Ok(core.recording_state())).await
}

#[tauri::command]
fn get_startup_warning(state: tauri::State<'_, AppState>) -> Option<String> {
    state.startup_warning.clone()
}

#[tauri::command]
async fn start_recording(
    app: AppHandle,
    title: String,
    consent: bool,
    devices: audio::CaptureOptions,
    processing_confirmation: Option<String>,
) -> Result<RecordingState> {
    with_core(app, true, move |core, _| {
        core.start_desktop(&title, devices, consent, processing_confirmation.as_deref())
    })
    .await
}

#[tauri::command]
async fn list_audio_devices() -> Result<audio::Devices> {
    tauri::async_runtime::spawn_blocking(audio::devices)
        .await
        .map_err(|_| AppError::new("audio", "Device discovery failed."))?
}

#[tauri::command]
async fn prepare_session_processing(
    app: AppHandle,
    request: session_processing::Request,
) -> Result<session_processing::Plan> {
    with_core(app, false, move |core, _| {
        core.prepare_session_processing(request)
    })
    .await
}

#[tauri::command]
async fn get_session_processing(
    app: AppHandle,
    id: String,
) -> Result<Option<session_processing::Snapshot>> {
    with_core(app, false, move |core, _| core.session_processing(&id)).await
}

#[tauri::command]
async fn cancel_session_processing(
    app: AppHandle,
    id: String,
    expected_revision: i64,
) -> Result<session_processing::Snapshot> {
    let owner = with_core(app.clone(), false, |core, _| {
        Ok(core.processing_owner.clone())
    })
    .await?;
    let worker_app = app.clone();
    let snapshot = blocking(move || {
        owner.cancel_session_with(&id, || {
            let state = worker_app.state::<AppState>();
            let mut core = state
                .core
                .lock()
                .map_err(|_| AppError::new("internal", "The local database is unavailable."))?;
            let snapshot = core.cancel_session_processing(&id, expected_revision)?;
            let run_id = snapshot.plan.id.clone();
            Ok((snapshot, run_id))
        })
    })
    .await?;
    let _ = app.emit("session_processing_changed", &snapshot);
    Ok(snapshot)
}

#[tauri::command]
async fn acknowledge_processing_notes(
    app: AppHandle,
    id: String,
    run_id: String,
    notes_barrier: String,
    expected_notes_revision: i64,
) -> Result<session_processing::Snapshot> {
    let result = with_core(app.clone(), false, move |core, _| {
        core.acknowledge_processing_notes(&id, &run_id, &notes_barrier, expected_notes_revision)
    })
    .await?;
    let _ = app.emit("session_processing_changed", &result);
    Ok(result)
}
#[tauri::command]
async fn prepare_session_retry(app: AppHandle, id: String) -> Result<session_processing::Plan> {
    with_core(app, false, move |core, _| core.prepare_session_retry(&id)).await
}
#[tauri::command]
async fn retry_session_processing(
    app: AppHandle,
    id: String,
    confirmation: String,
) -> Result<session_processing::Snapshot> {
    let target = id.clone();
    let result = with_core(app.clone(), false, move |core, _| {
        core.retry_session_processing(&id, &confirmation)
    })
    .await?;
    session_runtime::spawn(
        app.clone(),
        target,
        result.plan.id.clone(),
        None,
        std::sync::Arc::new(AtomicBool::new(false)),
    );
    let _ = app.emit("session_processing_changed", &result);
    Ok(result)
}

#[tauri::command]
async fn pause_recording(app: AppHandle) -> Result<RecordingState> {
    with_core(app, true, |core, _| core.pause()).await
}

#[tauri::command]
async fn resume_recording(app: AppHandle) -> Result<RecordingState> {
    with_core(app, true, |core, _| core.resume()).await
}

#[tauri::command]
async fn stop_recording(app: AppHandle) -> Result<RecordingState> {
    with_core(app, true, |core, _| core.stop()).await
}

#[tauri::command]
async fn save_notes(
    app: AppHandle,
    id: String,
    markdown: String,
    expected_revision: i64,
) -> Result<i64> {
    with_core(app, true, move |core, _| {
        core.save_notes(&id, &markdown, expected_revision)
    })
    .await
}

#[tauri::command]
async fn get_settings(app: AppHandle) -> Result<Settings> {
    with_core(app, false, |core, _| core.settings()).await
}

fn require_connection(settings: &Settings, role: ProviderRole) -> Result<ProviderConfig> {
    settings.connection(role).cloned().ok_or_else(|| {
        AppError::new(
            "provider_missing",
            "Save a provider connection in Settings first.",
        )
    })
}

#[tauri::command]
async fn provider_key_status(app: AppHandle, role: ProviderRole) -> Result<KeyStatus> {
    let account = with_core(app, false, move |core, _| {
        Ok(core
            .settings()?
            .connection(role)
            .and_then(|config| config.credential_account.clone()))
    })
    .await?;
    blocking(move || Ok(providers::key_status(account.as_deref()))).await
}

#[tauri::command]
async fn save_api_connection(
    app: AppHandle,
    id: Option<String>,
    name: String,
    base_url: String,
    key_change: KeyChange,
    expected_revision: Option<i64>,
) -> Result<Settings> {
    let base_url = providers::validate_base_url(&base_url)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let _writer = state.provider_writes.lock().map_err(|_| AppError::new("provider", "Provider settings are unavailable."))?;
        let previous = {
            let core = state.core.lock().map_err(|_| AppError::new("internal", "Settings are unavailable."))?;
            id.as_deref().map(|id| core.api_connection(id)).transpose()?
        };
        if previous.as_ref().map(|config| config.revision) != expected_revision {
            return Err(plan_changed());
        }
        let old_account = previous.as_ref().and_then(|config| config.credential_account.clone());
        let account = match key_change {
            KeyChange::Keep => {
                if previous.as_ref().is_some_and(|config| config.base_url != base_url) {
                    if providers::is_local_base(&base_url) {
                        None
                    } else {
                    return Err(AppError::new("provider_key", "Enter a new API key when changing the provider URL. Nothing was saved."));
                    }
                } else {
                    old_account.clone()
                }
            }
            KeyChange::Replace { key } => Some(providers::store_key(&key)?),
            KeyChange::Remove => None,
        };
        let result = state.core.lock()
            .map_err(|_| AppError::new("internal", "Settings are unavailable."))
            .and_then(|mut core| core.save_api_connection(id.as_deref(), &name, &base_url, account.as_deref(), expected_revision));
        if result.is_err() {
            if account != old_account {
                if let Some(account) = &account { providers::delete_key(account).map_err(|_| AppError::new("provider_cleanup", "The connection was not saved, but its new credential could not be removed from the OS keychain."))?; }
            }
            return result;
        }
        if old_account != account {
            if let Some(old_account) = &old_account {
                let still_used = result.as_ref().is_ok_and(|settings| settings.saved_connections.iter().any(|c| c.credential_account.as_ref() == Some(old_account)));
                if !still_used { providers::delete_key(old_account).map_err(|_| AppError::new("provider_cleanup", "The connection was saved, but its previous credential could not be removed from the OS keychain. Reload Settings to see the current connection."))?; }
            }
        }
        result
    }).await
}

#[tauri::command]
async fn delete_api_connection(
    app: AppHandle,
    id: String,
    expected_revision: i64,
) -> Result<Settings> {
    blocking(move || {
        let state = app.state::<AppState>();
        let _writer = state.provider_writes.lock().map_err(|_| AppError::new("provider", "Provider settings are unavailable."))?;
        let (settings, account) = {
            let mut core = state.core.lock().map_err(|_| AppError::new("internal", "Settings are unavailable."))?;
            let account = core.api_connection(&id)?.credential_account;
            (core.delete_api_connection(&id,expected_revision)?,account)
        };
        if let Some(account) = account {
            if !settings.saved_connections.iter().any(|c| c.credential_account.as_deref() == Some(&account)) {
                providers::delete_key(&account).map_err(|_| AppError::new("provider_cleanup", "The connection was deleted, but its credential could not be removed from the OS keychain."))?;
            }
        }
        Ok(settings)
    }).await
}

#[tauri::command]
async fn api_connection_key_status(app: AppHandle, id: String) -> Result<KeyStatus> {
    let account = with_core(app, false, move |core, _| {
        Ok(core.api_connection(&id)?.credential_account)
    })
    .await?;
    blocking(move || Ok(providers::key_status(account.as_deref()))).await
}

#[tauri::command]
async fn save_provider_assignment(
    app: AppHandle,
    role: ProviderRole,
    selection: ProviderSelection,
    expected_revision: Option<i64>,
) -> Result<Settings> {
    with_core(app, false, move |core, _| {
        core.save_provider_assignment(role, &selection, expected_revision)
    })
    .await
}

#[tauri::command]
async fn list_api_connection_models(
    app: AppHandle,
    id: String,
    expected_revision: i64,
) -> Result<Vec<providers::ProviderModel>> {
    let lookup_id = id.clone();
    let config = with_core(app.clone(), false, move |core, _| {
        core.api_connection(&lookup_id)
    })
    .await?;
    if config.revision != expected_revision {
        return Err(plan_changed());
    }
    let models =
        blocking(move || providers::list_models(&providers::load_connection(&config.config())?))
            .await?;
    with_core(app, false, move |core, _| {
        if core.api_connection(&id)?.revision != expected_revision {
            return Err(plan_changed());
        }
        Ok(models)
    })
    .await
}

#[tauri::command]
async fn save_stt_mode(app: AppHandle, mode: SttMode) -> Result<Settings> {
    with_core(app, false, move |core, _| core.save_stt_mode(mode)).await
}

fn stt_root(app: &AppHandle) -> Result<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("stt"))
        .map_err(|_| AppError::new("stt", "The app data folder is unavailable."))
}

async fn stt_model(app: &AppHandle) -> Result<String> {
    with_core(app.clone(), false, |core, _| Ok(core.settings()?.stt_model)).await
}

#[tauri::command]
async fn stt_status(app: AppHandle) -> Result<stt::Status> {
    let root = stt_root(&app)?;
    let model = stt_model(&app).await?;
    Ok(stt::status(&root, &model))
}

/// Downloads the pinned engine and the selected model. Only runs on an explicit user action.
#[tauri::command]
async fn stt_install(app: AppHandle) -> Result<stt::Status> {
    let root = stt_root(&app)?;
    let model = stt_model(&app).await?;
    let emitter = app.clone();
    blocking(move || {
        stt::install(&root, &model, |progress| {
            let _ = emitter.emit("stt_progress", progress);
        })
    })
    .await
}

#[tauri::command]
async fn choose_model_folder(app: AppHandle) -> Result<Option<String>> {
    blocking(move || {
        app.dialog()
            .file()
            .set_title("Choose a folder to scan for local models")
            .blocking_pick_folder()
            .map(|folder| {
                folder
                    .into_path()
                    .map_err(|_| AppError::new("model_folder", "Choose a local folder."))?
                    .into_os_string()
                    .into_string()
                    .map_err(|_| {
                        AppError::new("model_folder", "Choose a folder with a Unicode path.")
                    })
            })
            .transpose()
    })
    .await
}

#[tauri::command]
async fn scan_local_models(
    app: AppHandle,
    folder: Option<String>,
) -> Result<model_library::ModelScan> {
    let folders = match folder {
        Some(folder) => vec![std::path::PathBuf::from(folder)],
        None => model_library::common_folders(
            &app.path()
                .home_dir()
                .map_err(|_| AppError::new("model_folder", "The home folder is unavailable."))?,
            &stt_root(&app)?,
        ),
    };
    blocking(move || Ok(model_library::scan(folders))).await
}

#[tauri::command]
async fn import_local_model(app: AppHandle, path: String) -> Result<model_library::ImportedModel> {
    let root = stt_root(&app)?;
    blocking(move || model_library::import_model(&root, Path::new(&path))).await
}

#[tauri::command]
async fn search_hf_models(query: String) -> Result<Vec<model_library::HubModel>> {
    blocking(move || model_library::search(&query)).await
}

#[tauri::command]
async fn list_hf_files(repo_id: String) -> Result<Vec<model_library::HubFile>> {
    blocking(move || model_library::list_files(&repo_id)).await
}

#[tauri::command]
async fn download_hf_model(
    app: AppHandle,
    file: model_library::HubFile,
) -> Result<model_library::DownloadedModel> {
    let root = stt_root(&app)?;
    let emitter = app.clone();
    blocking(move || {
        model_library::download(&root, file, |progress| {
            let _ = emitter.emit("model_library_progress", progress);
        })
    })
    .await
}

#[tauri::command]
async fn cancel_model_download() -> Result<()> {
    model_library::cancel_download()
}

/// The app is quitting or the summary/question provider changed since review.
fn llm_changed(core: &Core, config: &ProviderConfig) -> Result<bool> {
    Ok(core.quitting || core.settings()?.connection(ProviderRole::Llm) != Some(config))
}

fn plan_changed() -> AppError {
    AppError::new("processing_plan_changed", "The meeting or provider settings changed. Review and confirm again. Nothing new was sent or saved.")
}

fn processing_plan(
    config: &ProviderConfig,
    payload: &impl serde::Serialize,
    requests: usize,
    audio_bytes: u64,
    tracks: Vec<String>,
) -> Result<ProcessingPlan> {
    let model = config.model.as_deref().ok_or_else(|| {
        AppError::new(
            "provider_model",
            "Choose and save a model in Settings first.",
        )
    })?;
    let input = serde_json::to_vec(&(config, payload, requests, audio_bytes, &tracks))
        .map_err(|_| AppError::new("processing_plan", "The request could not be prepared."))?;
    Ok(ProcessingPlan {
        fingerprint: Sha256::digest(input)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        base_url: config.base_url.clone(),
        model: model.to_string(),
        requests,
        audio_bytes,
        tracks,
        excerpts: None,
    })
}

fn confirm(plan: &ProcessingPlan, confirmation: Option<&str>) -> Result<()> {
    match confirmation {
        None => Err(AppError::new(
            "consent_required",
            "Review and confirm the destination and content before sending.",
        )),
        Some(value) if value != plan.fingerprint => Err(plan_changed()),
        Some(_) => Ok(()),
    }
}

/// Prompt lines keep the "You"/"Others" label beside any user-given name, so the shared
/// rules about microphone and system audio still apply.
fn transcript_lines(segments: &[Segment], names: &SpeakerNames) -> Vec<String> {
    segments
        .iter()
        .map(|segment| {
            let speaker = names.label(&segment.speaker);
            match &segment.timing {
                SegmentTiming::Timed { start_ms, .. } => format!(
                    "[{}:{:02}] {}: {}",
                    start_ms / 60_000,
                    start_ms / 1000 % 60,
                    speaker,
                    segment.text
                ),
                SegmentTiming::Untimed => format!("{}: {}", speaker, segment.text),
            }
        })
        .collect()
}

fn finalized_tracks(detail: &MeetingDetail) -> Result<Vec<audio::Track>> {
    if matches!(detail.meeting.status.as_str(), "recording" | "paused") {
        return Err(AppError::new(
            "stt",
            "Stop the recording before transcribing it.",
        ));
    }
    if detail.tracks.iter().any(|track| !track.finalized) {
        return Err(AppError::new(
            "stt",
            "This recording has incomplete audio. Recover it before transcription.",
        ));
    }
    let tracks: Vec<_> = detail
        .tracks
        .iter()
        .filter(|track| track.frames > 0)
        .cloned()
        .collect();
    if tracks.is_empty() {
        return Err(AppError::new(
            "stt",
            "This meeting has no finalized audio tracks to transcribe.",
        ));
    }
    Ok(tracks)
}

fn audio_plan(
    config: &ProviderConfig,
    id: &str,
    settings: &Settings,
    plan: &cloud_stt::CloudPlan,
) -> Result<ProcessingPlan> {
    processing_plan(
        config,
        &(
            "transcribe",
            id,
            &settings.stt_language,
            &settings.stt_prompt,
            plan.fingerprint(),
        ),
        plan.requests,
        plan.bytes,
        plan.tracks.clone(),
    )
}

fn same_stt_settings(current: &Settings, snapshot: &Settings) -> bool {
    current.stt_mode == snapshot.stt_mode
        && current.stt_language == snapshot.stt_language
        && current.stt_prompt == snapshot.stt_prompt
        && match snapshot.stt_mode {
            SttMode::Local => current.stt_model == snapshot.stt_model,
            SttMode::Cloud => current.cloud_stt == snapshot.cloud_stt,
        }
}

#[tauri::command]
async fn plan_transcription(app: AppHandle, id: String) -> Result<ProcessingPlan> {
    let (settings, tracks) = {
        let id = id.clone();
        with_core(app, false, move |core, _| {
            Ok((core.settings()?, finalized_tracks(&core.get_meeting(&id)?)?))
        })
        .await?
    };
    if settings.stt_mode != SttMode::Cloud {
        return Err(plan_changed());
    }
    let config = require_connection(&settings, ProviderRole::CloudStt)?;
    blocking(move || audio_plan(&config, &id, &settings, &cloud_stt::plan(&tracks)?)).await
}

#[tauri::command]
async fn transcribe_meeting(
    app: AppHandle,
    id: String,
    confirmation: Option<String>,
) -> Result<()> {
    let root = stt_root(&app)?;
    blocking(move || {
        let owner = {
            let state = app.state::<AppState>();
            let core = state
                .core
                .lock()
                .map_err(|_| AppError::new("internal", "The local database is unavailable."))?;
            core.processing_owner.clone()
        };
        let operation = owner.begin(&id)?;
        let cancel = operation.cancel();
        {
            let report = |track: &str, percent: u8| {
                let _ = app.emit(
                    "stt_progress",
                    stt::TranscribeProgress {
                        stage: "transcribing",
                        track: track.to_string(),
                        percent,
                    },
                );
            };
            report("preparing", 0);
            let (settings, tracks) = {
                let state = app.state::<AppState>();
                let core = state
                    .core
                    .lock()
                    .map_err(|_| AppError::new("internal", "The local database is unavailable."))?;
                (core.settings()?, finalized_tracks(&core.get_meeting(&id)?)?)
            };
            let (segments, provider, model) = match settings.stt_mode {
                SttMode::Local => {
                    if confirmation.is_some() {
                        return Err(plan_changed());
                    }
                    (
                        stt::transcribe(&root, &tracks, &settings, cancel, report)?,
                        "whisper".to_string(),
                        settings.stt_model.clone(),
                    )
                }
                SttMode::Cloud => {
                    let config = require_connection(&settings, ProviderRole::CloudStt)?;
                    let prepared = cloud_stt::plan_cancellable(&tracks, cancel)?;
                    confirm(
                        &audio_plan(&config, &id, &settings, &prepared)?,
                        confirmation.as_deref(),
                    )?;
                    {
                        let state = app.state::<AppState>();
                        let core = state
                            .core
                            .lock()
                            .map_err(|_| AppError::new("internal", "Settings are unavailable."))?;
                        if core.quitting || !same_stt_settings(&core.settings()?, &settings) {
                            return Err(plan_changed());
                        }
                    }
                    let remote = providers::load_connection(&config)?;
                    let model = remote.model()?.to_string();
                    let segments = cloud_stt::transcribe(
                        &remote,
                        &tracks,
                        &settings.stt_language,
                        &settings.stt_prompt,
                        &prepared,
                        cancel,
                        report,
                        |_, _| {
                            let state = app.state::<AppState>();
                            let core = state.core.lock().map_err(|_| {
                                AppError::new("internal", "Settings are unavailable.")
                            })?;
                            if core.quitting || !same_stt_settings(&core.settings()?, &settings) {
                                return Err(plan_changed());
                            }
                            Ok(())
                        },
                    )?;
                    (segments, remote.base_url().to_string(), model)
                }
            };
            operation.finish(|| {
                let state = app.state::<AppState>();
                let mut core = state
                    .core
                    .lock()
                    .map_err(|_| AppError::new("internal", "The local database is unavailable."))?;
                let current = core.settings()?;
                if core.quitting || !same_stt_settings(&current, &settings) {
                    return Err(plan_changed());
                }
                core.replace_transcript(&id, &segments, &provider, &model)?;
                publish(&app, &core.recording_state());
                Ok(())
            })
        }
    })
    .await
}

async fn text_snapshot(
    app: &AppHandle,
    id: &str,
) -> Result<(MeetingDetail, ProviderConfig, Vec<String>)> {
    let id = id.to_string();
    with_core(app.clone(), false, move |core, _| {
        let detail = core.get_meeting(&id)?;
        let lines = transcript_lines(&detail.segments, &detail.speaker_names);
        if detail.user_markdown.trim().is_empty() && lines.is_empty() {
            return Err(AppError::new(
                "summary_empty",
                "There are no notes or transcript to send. Nothing was sent.",
            ));
        }
        let config = require_connection(&core.settings()?, ProviderRole::Llm)?;
        Ok((detail, config, lines))
    })
    .await
}

fn text_plan(
    config: &ProviderConfig,
    detail: &MeetingDetail,
    lines: &[String],
    action: &str,
    option: &str,
    requests: usize,
) -> Result<ProcessingPlan> {
    processing_plan(
        config,
        &(
            action,
            &detail.meeting.id,
            detail.notes_revision,
            &detail.user_markdown,
            lines,
            option,
        ),
        requests,
        0,
        Vec::new(),
    )
}

/// The full system prompt is part of the consent fingerprint, so editing the template or
/// saved instructions after review requires a new confirmation.
async fn summary_prompt(app: &AppHandle, template: &str) -> Result<String> {
    let template = template.to_string();
    with_core(app.clone(), false, move |core, _| {
        llm::resolve_summary(&core.settings()?, &template)
    })
    .await
}

#[tauri::command]
async fn plan_summary(app: AppHandle, id: String, template: String) -> Result<ProcessingPlan> {
    let system = summary_prompt(&app, &template).await?;
    let (detail, config, lines) = text_snapshot(&app, &id).await?;
    text_plan(
        &config,
        &detail,
        &lines,
        "summary",
        &system,
        llm::summary_requests(&detail.user_markdown, &lines)?,
    )
}

fn manual_text_check(
    core: &Core,
    id: &str,
    config: &ProviderConfig,
    revision: i64,
    lines: &[String],
) -> Result<()> {
    let current = core.get_meeting(id)?;
    if llm_changed(core, config)?
        || current.notes_revision != revision
        || transcript_lines(&current.segments, &current.speaker_names) != lines
    {
        return Err(plan_changed());
    }
    Ok(())
}

#[tauri::command]
async fn generate_summary(
    app: AppHandle,
    id: String,
    template: String,
    confirmation: String,
) -> Result<()> {
    let system = summary_prompt(&app, &template).await?;
    let (detail, config, lines) = text_snapshot(&app, &id).await?;
    let plan = text_plan(
        &config,
        &detail,
        &lines,
        "summary",
        &system,
        llm::summary_requests(&detail.user_markdown, &lines)?,
    )?;
    confirm(&plan, Some(&confirmation))?;
    blocking(move || {
        let owner = {
            let state = app.state::<AppState>();
            let core = state.core.lock().map_err(|_| plan_changed())?;
            core.processing_owner.clone()
        };
        let operation = owner.begin(&id)?;
        let mut sent = 0;
        let markdown = llm::summarize(
            &providers::load_connection(&config)?,
            &system,
            &detail.user_markdown,
            &lines,
            operation.cancel(),
            |_| {
                let state = app.state::<AppState>();
                let core = state.core.lock().map_err(|_| plan_changed())?;
                manual_text_check(&core, &id, &config, detail.notes_revision, &lines)?;
                sent += 1;
                if sent > plan.requests {
                    return Err(plan_changed());
                }
                Ok(())
            },
        )?;
        operation.finish(|| {
            let state = app.state::<AppState>();
            let mut core = state.core.lock().map_err(|_| plan_changed())?;
            manual_text_check(&core, &id, &config, detail.notes_revision, &lines)?;
            core.save_summary(&id, &plan.base_url, &plan.model, &markdown, &template)?;
            publish(&app, &core.recording_state());
            Ok(())
        })
    })
    .await
}

#[tauri::command]
async fn edit_segment(
    app: AppHandle,
    meeting_id: String,
    segment_id: i64,
    base_text: String,
    text: String,
) -> Result<()> {
    with_core(app, false, move |core, _| {
        core.edit_segment(&meeting_id, segment_id, &base_text, &text)
    })
    .await
}

#[tauri::command]
async fn get_transcript_version(
    app: AppHandle,
    meeting_id: String,
    version_id: i64,
) -> Result<Vec<Segment>> {
    with_core(app, false, move |core, _| {
        core.transcript_version(&meeting_id, version_id)
    })
    .await
}

#[tauri::command]
async fn save_speaker_names(
    app: AppHandle,
    meeting_id: String,
    you: Option<String>,
    others: Option<String>,
) -> Result<SpeakerNames> {
    with_core(app, false, move |core, _| {
        core.save_speaker_names(&meeting_id, you.as_deref(), others.as_deref())
    })
    .await
}

#[tauri::command]
async fn save_summary_edit(
    app: AppHandle,
    meeting_id: String,
    base_id: i64,
    expected_latest_id: i64,
    markdown: String,
) -> Result<()> {
    with_core(app, false, move |core, _| {
        core.save_summary_edit(&meeting_id, base_id, expected_latest_id, &markdown)
    })
    .await
}

#[tauri::command]
async fn list_summaries(app: AppHandle, id: String) -> Result<Vec<SummaryVersion>> {
    with_core(app, false, move |core, _| core.list_summaries(&id)).await
}

type Chosen = Vec<std::collections::BTreeSet<usize>>;

/// Nothing in the selected content matched the question, so nothing is sent. The UI shows
/// this as an ordinary status message, not a failure.
fn insufficient_evidence() -> AppError {
    AppError::new(
        "insufficient_evidence",
        "No passages in the selected content matched your question. Nothing was sent.",
    )
}

/// Transcript lines (per meeting, as line indexes) matching the question's keywords, best
/// match first with their neighbours, within `budget` bytes. `lines` are the meetings' full
/// transcript lines in the order of `details`.
fn pick_excerpts(
    core: &Core,
    details: &[&MeetingDetail],
    lines: &[Vec<String>],
    terms: &[String],
    budget: usize,
) -> Result<Chosen> {
    let ids: Vec<String> = details
        .iter()
        .map(|detail| detail.meeting.id.clone())
        .collect();
    // Search rowids are segment ids; `segment_meta` is aligned with the transcript lines.
    let position: std::collections::HashMap<i64, (usize, usize)> = details
        .iter()
        .enumerate()
        .flat_map(|(meeting, detail)| {
            detail
                .segment_meta
                .iter()
                .enumerate()
                .map(move |(line, meta)| (meta.id, (meeting, line)))
        })
        .collect();
    let hits: Vec<_> = core
        .transcript_hits(&ids, terms)?
        .into_iter()
        .filter_map(|id| position.get(&id).copied())
        .collect();
    let sizes: Vec<Vec<usize>> = lines
        .iter()
        .map(|meeting| meeting.iter().map(String::len).collect())
        .collect();
    Ok(retrieval::select(&hits, &sizes, budget))
}

/// What a question about one meeting sends: everything when it fits one request, otherwise
/// the notes and transcript excerpts selected locally by keyword match. Recomputed from
/// stored data at send time, so a change to anything sent is a changed plan.
#[derive(Clone, Debug, PartialEq)]
struct QuestionContent {
    notes: String,
    lines: Vec<String>,
    excerpts: Option<ExcerptSummary>,
}

fn question_content(
    core: &Core,
    detail: &MeetingDetail,
    question: &str,
    earlier: &[QuestionTurn],
) -> Result<QuestionContent> {
    llm::check_question(question, earlier)?;
    let lines = transcript_lines(&detail.segments, &detail.speaker_names);
    if llm::question_fits(&detail.user_markdown, &lines, question, earlier) {
        return Ok(QuestionContent {
            notes: detail.user_markdown.clone(),
            lines,
            excerpts: None,
        });
    }
    let terms = retrieval::terms(question);
    let notes = retrieval::notes_excerpt(&detail.user_markdown, &terms, llm::NOTES_SHARE);
    let chosen = pick_excerpts(
        core,
        &[detail],
        std::slice::from_ref(&lines),
        &terms,
        llm::question_budget(&notes, question, earlier),
    )?;
    if chosen[0].is_empty() && notes.is_empty() {
        return Err(insufficient_evidence());
    }
    Ok(QuestionContent {
        lines: retrieval::excerpt_lines(&lines, &chosen[0]),
        notes,
        excerpts: Some(retrieval::summary(&chosen)),
    })
}

/// The consent fingerprint binds exactly the text that will be sent.
fn question_plan(
    config: &ProviderConfig,
    detail: &MeetingDetail,
    content: &QuestionContent,
    block: &str,
) -> Result<ProcessingPlan> {
    let mut plan = processing_plan(
        config,
        &(
            "question",
            &detail.meeting.id,
            detail.notes_revision,
            &content.notes,
            &content.lines,
            block,
            content.excerpts.is_some(),
        ),
        1,
        0,
        Vec::new(),
    )?;
    plan.excerpts = content.excerpts.clone();
    Ok(plan)
}

async fn question_snapshot(
    app: &AppHandle,
    id: &str,
    question: &str,
    thread_id: Option<i64>,
) -> Result<(
    MeetingDetail,
    ProviderConfig,
    Vec<QuestionTurn>,
    QuestionContent,
)> {
    let (id, question) = (id.to_string(), question.to_string());
    with_core(app.clone(), false, move |core, _| {
        let detail = core.get_meeting(&id)?;
        if detail.user_markdown.trim().is_empty() && detail.segments.is_empty() {
            return Err(AppError::new(
                "summary_empty",
                "There are no notes or transcript to send. Nothing was sent.",
            ));
        }
        let config = require_connection(&core.settings()?, ProviderRole::Llm)?;
        let earlier = earlier_turns(&detail.question_threads, thread_id)?;
        let content = question_content(core, &detail, &question, &earlier)?;
        Ok((detail, config, earlier, content))
    })
    .await
}

/// The provider, notes revision, thread and sent content must all still match what was reviewed.
fn question_unchanged(
    core: &Core,
    id: &str,
    config: &ProviderConfig,
    reviewed: (&MeetingDetail, &QuestionContent),
    question: &str,
    thread: (Option<i64>, &[QuestionTurn]),
) -> Result<()> {
    let current = core.get_meeting(id)?;
    if llm_changed(core, config)?
        || current.notes_revision != reviewed.0.notes_revision
        || earlier_turns(&core.question_threads(id)?, thread.0)? != thread.1
        || question_content(core, &current, question, thread.1)
            .ok()
            .as_ref()
            != Some(reviewed.1)
    {
        return Err(plan_changed());
    }
    Ok(())
}

#[tauri::command]
async fn plan_question(
    app: AppHandle,
    id: String,
    question: String,
    thread_id: Option<i64>,
) -> Result<ProcessingPlan> {
    let (detail, config, earlier, content) =
        question_snapshot(&app, &id, &question, thread_id).await?;
    question_plan(
        &config,
        &detail,
        &content,
        &llm::question_block(&question, &earlier),
    )
}

/// Turns of the thread being continued; a thread that is missing or belongs to another
/// meeting is refused. Empty for a new question.
fn earlier_turns(threads: &[QuestionThread], thread_id: Option<i64>) -> Result<Vec<QuestionTurn>> {
    let Some(thread_id) = thread_id else {
        return Ok(Vec::new());
    };
    threads
        .iter()
        .find(|thread| thread.id == thread_id)
        .map(|thread| thread.turns.clone())
        .ok_or_else(|| AppError::new("not_found", "This question thread no longer exists."))
}

#[tauri::command]
async fn ask_meeting(
    app: AppHandle,
    id: String,
    question: String,
    thread_id: Option<i64>,
    confirmation: String,
) -> Result<QuestionThread> {
    let (detail, config, earlier, content) =
        question_snapshot(&app, &id, &question, thread_id).await?;
    let plan = question_plan(
        &config,
        &detail,
        &content,
        &llm::question_block(&question, &earlier),
    )?;
    confirm(&plan, Some(&confirmation))?;
    blocking(move || {
        let owner = {
            let state = app.state::<AppState>();
            let core = state.core.lock().map_err(|_| plan_changed())?;
            core.processing_owner.clone()
        };
        let operation = owner.begin(&id)?;
        // Content, provider, and the thread's turns must still match what was reviewed.
        let unchanged = |core: &Core| -> Result<()> {
            question_unchanged(
                core,
                &id,
                &config,
                (&detail, &content),
                &question,
                (thread_id, &earlier),
            )
        };
        let answer = llm::ask(
            &providers::load_connection(&config)?,
            &content.notes,
            &content.lines,
            content.excerpts.is_some(),
            &question,
            &earlier,
            operation.cancel(),
            |_| {
                let state = app.state::<AppState>();
                let core = state.core.lock().map_err(|_| plan_changed())?;
                unchanged(&core)
            },
        )?;
        operation.finish(|| {
            let state = app.state::<AppState>();
            let mut core = state.core.lock().map_err(|_| plan_changed())?;
            unchanged(&core)?;
            core.save_question_turn(
                &id,
                thread_id,
                question.trim(),
                &answer,
                &plan.base_url,
                &plan.model,
            )
        })
    })
    .await
}

/// The library scope: the ids as chosen, duplicates dropped, 1 to 20 of them.
fn library_ids(mut ids: Vec<String>) -> Result<Vec<String>> {
    let mut seen = std::collections::HashSet::new();
    ids.retain(|id| seen.insert(id.clone()));
    if ids.is_empty() || ids.len() > llm::MAX_LIBRARY_MEETINGS {
        return Err(AppError::new(
            "invalid_scope",
            format!(
                "Choose 1 to {} meetings. Nothing was sent.",
                llm::MAX_LIBRARY_MEETINGS
            ),
        ));
    }
    Ok(ids)
}

/// What a library question sends for each meeting, in scope order: the whole meetings when
/// they fit one request, otherwise only the excerpts selected locally by keyword match.
#[derive(Clone, Debug, PartialEq)]
struct LibraryScope {
    items: Vec<llm::LibraryItem>,
    excerpts: Option<ExcerptSummary>,
}

fn library_scope(core: &Core, ids: &[String], question: &str) -> Result<LibraryScope> {
    let details = ids
        .iter()
        .map(|id| {
            core.get_meeting(id).map_err(|error| {
                if error.code == "not_found" {
                    AppError::new(
                        "invalid_scope",
                        "A selected meeting no longer exists. Nothing was sent.",
                    )
                } else {
                    error
                }
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let full: Vec<llm::LibraryItem> = details
        .iter()
        .map(|detail| llm::LibraryItem {
            id: detail.meeting.id.clone(),
            lines: transcript_lines(&detail.segments, &detail.speaker_names),
            title: detail.meeting.title.clone(),
            started_at: detail.meeting.started_at.clone(),
            notes_revision: detail.notes_revision,
            notes: detail.user_markdown.clone(),
        })
        .collect();
    llm::check_library(&full, question)?;
    if llm::library_fits(&full, question) {
        return Ok(LibraryScope {
            items: full,
            excerpts: None,
        });
    }
    let terms = retrieval::terms(question);
    let share = llm::NOTES_SHARE / full.len();
    let mut items: Vec<llm::LibraryItem> = full
        .iter()
        .map(|item| llm::LibraryItem {
            notes: retrieval::notes_excerpt(&item.notes, &terms, share),
            lines: Vec::new(),
            ..item.clone()
        })
        .collect();
    let lines: Vec<Vec<String>> = full.into_iter().map(|item| item.lines).collect();
    let chosen = pick_excerpts(
        core,
        &details.iter().collect::<Vec<_>>(),
        &lines,
        &terms,
        llm::library_budget(&items, question),
    )?;
    if chosen.iter().all(std::collections::BTreeSet::is_empty)
        && items.iter().all(|item| item.notes.is_empty())
    {
        return Err(insufficient_evidence());
    }
    for ((item, all), picked) in items.iter_mut().zip(&lines).zip(&chosen) {
        item.lines = retrieval::excerpt_lines(all, picked);
    }
    Ok(LibraryScope {
        items,
        excerpts: Some(retrieval::summary(&chosen)),
    })
}

/// The consent fingerprint binds exactly the text that will be sent.
fn library_plan(
    config: &ProviderConfig,
    scope: &LibraryScope,
    question: &str,
) -> Result<ProcessingPlan> {
    let mut plan = processing_plan(
        config,
        &(
            "library",
            question.trim(),
            &scope.items,
            scope.excerpts.is_some(),
        ),
        1,
        0,
        Vec::new(),
    )?;
    plan.excerpts = scope.excerpts.clone();
    Ok(plan)
}

/// Every scoped meeting's sent text must still match what was reviewed.
fn library_unchanged(core: &Core, ids: &[String], question: &str, scope: &LibraryScope) -> bool {
    library_scope(core, ids, question).is_ok_and(|now| now == *scope)
}

fn library_check(
    core: &Core,
    ids: &[String],
    config: &ProviderConfig,
    question: &str,
    scope: &LibraryScope,
) -> Result<()> {
    if llm_changed(core, config)? || !library_unchanged(core, ids, question, scope) {
        return Err(plan_changed());
    }
    Ok(())
}

async fn library_snapshot(
    app: &AppHandle,
    meeting_ids: Vec<String>,
    question: &str,
) -> Result<(Vec<String>, LibraryScope, ProviderConfig)> {
    let ids = library_ids(meeting_ids)?;
    let question = question.to_string();
    with_core(app.clone(), false, move |core, _| {
        let scope = library_scope(core, &ids, &question)?;
        let config = require_connection(&core.settings()?, ProviderRole::Llm)?;
        Ok((ids, scope, config))
    })
    .await
}

#[tauri::command]
async fn plan_library_question(
    app: AppHandle,
    meeting_ids: Vec<String>,
    question: String,
) -> Result<ProcessingPlan> {
    let (_, scope, config) = library_snapshot(&app, meeting_ids, &question).await?;
    llm::validate_library(&scope.items, &question)?;
    library_plan(&config, &scope, &question)
}

/// One request over the chosen meetings; the answer is saved with its scope and returned.
#[tauri::command]
async fn ask_library(
    app: AppHandle,
    meeting_ids: Vec<String>,
    question: String,
    confirmation: String,
) -> Result<LibraryAnswer> {
    let (ids, scope, config) = library_snapshot(&app, meeting_ids, &question).await?;
    llm::validate_library(&scope.items, &question)?;
    let plan = library_plan(&config, &scope, &question)?;
    confirm(&plan, Some(&confirmation))?;
    blocking(move || {
        let owner = {
            let state = app.state::<AppState>();
            let core = state.core.lock().map_err(|_| plan_changed())?;
            core.processing_owner.clone()
        };
        let operation = owner.begin("library")?;
        let unchanged = || {
            let state = app.state::<AppState>();
            let core = state.core.lock().map_err(|_| plan_changed())?;
            library_check(&core, &ids, &config, &question, &scope)
        };
        let answer = llm::ask_library(
            &providers::load_connection(&config)?,
            &scope.items,
            scope.excerpts.is_some(),
            &question,
            operation.cancel(),
            |_| unchanged(),
        )?;
        operation.finish(|| {
            let state = app.state::<AppState>();
            let mut core = state.core.lock().map_err(|_| plan_changed())?;
            library_check(&core, &ids, &config, &question, &scope)?;
            core.save_library_answer(&ids, question.trim(), &answer, &plan.base_url, &plan.model)
        })
    })
    .await
}

#[tauri::command]
async fn list_library_answers(app: AppHandle) -> Result<Vec<LibraryAnswer>> {
    with_core(app, false, |core, _| core.library_answers()).await
}

#[tauri::command]
async fn delete_library_answer(app: AppHandle, id: i64) -> Result<Vec<LibraryAnswer>> {
    with_core(app, false, move |core, _| core.delete_library_answer(id)).await
}

/// The consent fingerprint binds the provider, the selected text and the request.
fn rewrite_plan(config: &ProviderConfig, text: &str, request: &str) -> Result<ProcessingPlan> {
    llm::check_rewrite(text, request)?;
    processing_plan(config, &("rewrite", text, request.trim()), 1, 0, Vec::new())
}

#[tauri::command]
async fn plan_rewrite(app: AppHandle, text: String, request: String) -> Result<ProcessingPlan> {
    let config = with_core(app, false, |core, _| {
        require_connection(&core.settings()?, ProviderRole::Llm)
    })
    .await?;
    rewrite_plan(&config, &text, &request)
}

/// Sends only the selected text and request; the rewrite is returned for the user to accept.
#[tauri::command]
async fn rewrite_text(
    app: AppHandle,
    text: String,
    request: String,
    confirmation: String,
) -> Result<String> {
    let (config, owner) = with_core(app.clone(), false, |core, _| {
        Ok((
            require_connection(&core.settings()?, ProviderRole::Llm)?,
            core.processing_owner.clone(),
        ))
    })
    .await?;
    confirm(
        &rewrite_plan(&config, &text, &request)?,
        Some(&confirmation),
    )?;
    blocking(move || {
        let operation = owner.begin("rewrite")?;
        let unchanged = || {
            let state = app.state::<AppState>();
            let core = state.core.lock().map_err(|_| plan_changed())?;
            if llm_changed(&core, &config)? {
                return Err(plan_changed());
            }
            Ok(())
        };
        let rewritten = llm::rewrite(
            &providers::load_connection(&config)?,
            &text,
            &request,
            operation.cancel(),
            |_| unchanged(),
        )?;
        operation.finish(|| {
            unchanged()?;
            Ok(rewritten)
        })
    })
    .await
}

#[tauri::command]
async fn save_recipe(
    app: AppHandle,
    id: Option<String>,
    name: String,
    prompt: String,
) -> Result<Settings> {
    with_core(app, false, move |core, _| {
        core.save_recipe(id.as_deref(), &name, &prompt)
    })
    .await
}

#[tauri::command]
async fn delete_recipe(app: AppHandle, id: String) -> Result<Settings> {
    with_core(app, false, move |core, _| core.delete_recipe(&id)).await
}

#[tauri::command]
async fn delete_question_thread(
    app: AppHandle,
    meeting_id: String,
    thread_id: i64,
) -> Result<Vec<QuestionThread>> {
    with_core(app, false, move |core, _| {
        core.delete_question_thread(&meeting_id, thread_id)
    })
    .await
}

/// Runs blocking network, disk, or subprocess work off the async runtime.
async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| AppError::new("task", "The background task could not be completed."))?
}

#[tauri::command]
async fn save_settings(
    app: AppHandle,
    pause_shortcut: String,
    stop_shortcut: Option<String>,
) -> Result<Settings> {
    with_core(app, false, move |core, app| {
        let stop_text = stop_shortcut
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty());
        let (pause, stop) = parse_shortcuts(&pause_shortcut, stop_text)?;
        let saved = core.settings()?;
        let old = [
            Some(saved.pause_shortcut.as_str()),
            saved.stop_shortcut.as_deref(),
        ]
        .map(|text| text.and_then(|text| text.parse::<Shortcut>().ok()));
        let next = [Some(pause), stop];
        let shortcuts = app.global_shortcut();
        if old == next && next.iter().flatten().all(|s| shortcuts.is_registered(*s)) {
            return core.settings();
        }
        // Release both old shortcuts first so pause and stop can swap; restore them on failure.
        for shortcut in old.iter().flatten() {
            if shortcuts.is_registered(*shortcut) {
                let _ = shortcuts.unregister(*shortcut);
            }
        }
        let result = next
            .iter()
            .flatten()
            .try_for_each(|shortcut| {
                shortcuts.register(*shortcut).map_err(|_| {
                    AppError::new(
                        "shortcut_unavailable",
                        "This shortcut could not be registered. Choose another combination.",
                    )
                })
            })
            .and_then(|()| core.save_shortcuts(&pause_shortcut, stop_text));
        if result.is_err() {
            for shortcut in next.iter().flatten() {
                if shortcuts.is_registered(*shortcut) {
                    let _ = shortcuts.unregister(*shortcut);
                }
            }
            for shortcut in old.iter().flatten() {
                let _ = shortcuts.register(*shortcut);
            }
        }
        result
    })
    .await
}

#[tauri::command]
async fn choose_vault_folder(app: AppHandle) -> Result<Settings> {
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("Choose a folder for meeting notes")
            .blocking_pick_folder()
    })
    .await
    .map_err(|_| AppError::new("dialog", "The folder picker failed."))?;
    with_core(app, false, move |core, _| match picked {
        Some(file) => {
            let path = file
                .into_path()
                .map_err(|_| AppError::new("invalid_folder", "Choose a local folder."))?;
            core.save_vault(&path)
        }
        None => core.settings(),
    })
    .await
}

#[tauri::command]
async fn export_meeting(app: AppHandle, id: String) -> Result<ExportResult> {
    with_core(app, false, move |core, _| {
        let settings = core.settings()?;
        let folder = settings.vault_folder.ok_or_else(|| {
            AppError::new("no_vault", "Choose an export folder in Settings first.")
        })?;
        export::write_snapshot(
            &core.get_meeting(&id)?,
            Path::new(&folder),
            &settings.export,
        )
    })
    .await
}

#[tauri::command]
async fn close_application(app: AppHandle) -> Result<()> {
    // The frontend flushes notes before invoking this command.
    let owner = with_core(app.clone(), false, |core, _| {
        Ok(core.processing_owner.clone())
    })
    .await?;
    owner.cancel_active();
    with_core(app.clone(), true, |core, _| {
        core.quitting = true;
        core.stop()?;
        core.interrupt_processing()
    })
    .await?;
    let idle = blocking(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !owner.is_idle() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        Ok(owner.is_idle())
    })
    .await?;
    if !idle {
        return Err(AppError::new(
            "processing_busy",
            "Processing is stopping. Notes are saved; wait briefly and choose Save and quit again.",
        ));
    }
    app.state::<AppState>()
        .allow_exit
        .store(true, Ordering::Release);
    app.exit(0);
    Ok(())
}

#[tauri::command]
async fn create_note(app: AppHandle, title: String) -> Result<String> {
    with_core(app, true, move |core, _| core.create_note(&title)).await
}

#[tauri::command]
async fn audio_usage(app: AppHandle) -> Result<u64> {
    with_core(app, false, |core, _| core.audio_usage()).await
}

#[tauri::command]
async fn delete_audio(app: AppHandle, id: String) -> Result<()> {
    with_core(app, true, move |core, _| core.delete_audio(&id)).await
}

#[tauri::command]
async fn delete_meeting(app: AppHandle, id: String) -> Result<()> {
    with_core(app, true, move |core, _| core.delete_meeting(&id)).await
}

#[tauri::command]
async fn search_meetings(app: AppHandle, query: String) -> Result<Vec<SearchHit>> {
    with_core(app, false, move |core, _| core.search_meetings(&query)).await
}

#[tauri::command]
async fn rename_meeting(app: AppHandle, id: String, title: String) -> Result<String> {
    with_core(app, true, move |core, _| core.rename_meeting(&id, &title)).await
}

#[tauri::command]
async fn set_meeting_tags(
    app: AppHandle,
    meeting_id: String,
    tags: Vec<String>,
) -> Result<Vec<String>> {
    with_core(app, false, move |core, _| {
        core.set_meeting_tags(&meeting_id, &tags)
    })
    .await
}

#[tauri::command]
async fn save_processing_default(
    app: AppHandle,
    mode: String,
    summary: Option<String>,
) -> Result<Settings> {
    with_core(app, false, move |core, _| {
        core.save_processing_default(&mode, summary.as_deref())
    })
    .await
}

#[tauri::command]
async fn save_summary_default(app: AppHandle, template: String) -> Result<Settings> {
    with_core(app, false, move |core, _| {
        core.save_summary_default(&template)
    })
    .await
}

#[tauri::command]
async fn save_default_devices(
    app: AppHandle,
    microphone_id: String,
    output_id: String,
) -> Result<Settings> {
    with_core(app, false, move |core, _| {
        core.save_default_devices(&microphone_id, &output_id)
    })
    .await
}

#[tauri::command]
async fn save_export_options(app: AppHandle, options: ExportOptions) -> Result<Settings> {
    with_core(app, false, move |core, _| {
        core.save_export_options(&options)
    })
    .await
}

#[tauri::command]
async fn save_action_item(
    app: AppHandle,
    meeting_id: String,
    item_id: Option<i64>,
    text: String,
    owner: Option<String>,
    due_date: Option<String>,
    done: bool,
) -> Result<Vec<ActionItem>> {
    with_core(app, false, move |core, _| {
        core.save_action_item(
            &meeting_id,
            item_id,
            &text,
            owner.as_deref(),
            due_date.as_deref(),
            done,
        )
    })
    .await
}

#[tauri::command]
async fn delete_action_item(
    app: AppHandle,
    meeting_id: String,
    item_id: i64,
) -> Result<Vec<ActionItem>> {
    with_core(app, false, move |core, _| {
        core.delete_action_item(&meeting_id, item_id)
    })
    .await
}

#[tauri::command]
async fn import_action_items(
    app: AppHandle,
    meeting_id: String,
    summary_id: i64,
) -> Result<Vec<ActionItem>> {
    with_core(app, false, move |core, _| {
        core.import_action_items(&meeting_id, summary_id)
    })
    .await
}

#[tauri::command]
async fn save_summary_instructions(app: AppHandle, instructions: String) -> Result<Settings> {
    with_core(app, false, move |core, _| {
        core.save_summary_instructions(&instructions)
    })
    .await
}

#[tauri::command]
async fn save_summary_template(
    app: AppHandle,
    id: Option<String>,
    name: String,
    instructions: String,
) -> Result<Settings> {
    with_core(app, false, move |core, _| {
        core.save_summary_template(id.as_deref(), &name, &instructions)
    })
    .await
}

#[tauri::command]
async fn delete_summary_template(app: AppHandle, id: String) -> Result<Settings> {
    with_core(app, false, move |core, _| core.delete_summary_template(&id)).await
}

#[tauri::command]
async fn cancel_transcription(app: AppHandle) -> Result<bool> {
    let owner = with_core(app, false, |core, _| Ok(core.processing_owner.clone())).await?;
    Ok(owner.cancel_active())
}

#[tauri::command]
async fn save_stt_settings(
    app: AppHandle,
    language: String,
    prompt: String,
    model: String,
) -> Result<Settings> {
    with_core(app, false, move |core, _| {
        core.save_stt_settings(&language, &prompt, &model)
    })
    .await
}

/// Writes repaired copies of an interrupted recording's unfinished WAVs; originals are never modified.
#[tauri::command]
async fn recover_audio(app: AppHandle, id: String) -> Result<()> {
    let tracks = {
        let id = id.clone();
        with_core(app.clone(), false, move |core, _| {
            core.recoverable_tracks(&id)
        })
        .await?
    };
    for (kind, original, copy) in tracks {
        // Copying can take a while; do it without holding the recording/storage lock.
        let target = copy.clone();
        let frames = blocking(move || audio::repair_wav(&original, &target)).await?;
        let id = id.clone();
        with_core(app.clone(), true, move |core, _| {
            core.mark_recovered(&id, &kind, &copy, frames)
        })
        .await?;
    }
    Ok(())
}

/// Maps a transcript (session) time to a position in one track's WAV for seeking playback.
#[tauri::command]
async fn audio_position(app: AppHandle, id: String, kind: String, session_ms: i64) -> Result<i64> {
    let detail = with_core(app, false, move |core, _| core.get_meeting(&id)).await?;
    let track = detail
        .tracks
        .into_iter()
        .find(|track| track.kind == kind)
        .ok_or_else(|| AppError::new("not_found", "That audio track does not exist."))?;
    blocking(move || stt::track_file_ms(&track, session_ms)).await
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_window(app)
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        shortcut_action(app, *shortcut);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let folder = app.path().app_data_dir()?;
            std::fs::create_dir_all(&folder)?;
            let core = Core::open(&folder.join("meetings.db"))?;
            let settings = core.settings()?;
            let pause_failed = app
                .global_shortcut()
                .register(settings.pause_shortcut.as_str())
                .is_err();
            let stop_failed = settings
                .stop_shortcut
                .as_deref()
                .is_some_and(|stop| app.global_shortcut().register(stop).is_err());
            let startup_warning = shortcut_warning(
                pause_failed.then_some(settings.pause_shortcut.as_str()),
                settings.stop_shortcut.as_deref().filter(|_| stop_failed),
            );
            app.manage(AppState {
                core: Mutex::new(core),
                provider_writes: Mutex::new(()),
                startup_warning,
                allow_exit: AtomicBool::new(false),
            });
            let show = MenuItem::with_id(app, "show", "Open OpenMeet", true, None::<&str>)?;
            let pause =
                MenuItem::with_id(app, "pause", "Pause / resume recording", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "Stop recording", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Save notes and quit…", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &pause, &stop, &quit])?;
            TrayIconBuilder::with_id("recorder")
                .icon(tray_image(&CaptureStatus::Idle))
                .tooltip("OpenMeet — capture preview, idle")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_window(app),
                    "pause" => tray_action(app, Core::toggle_pause),
                    "stop" => tray_action(app, Core::stop),
                    "quit" => {
                        show_window(app);
                        let _ = app.emit("request_close", ());
                    }
                    _ => {}
                })
                .build(app)?;
            let monitor_app = app.handle().clone();
            std::thread::spawn(move || {
                let revisions = std::sync::Arc::new(Mutex::new(std::collections::HashMap::new()));
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let result =
                        tauri::async_runtime::block_on(with_core(monitor_app.clone(), false, {
                            let revisions = revisions.clone();
                            move |core, app| {
                                let mut revisions =
                                    revisions.lock().unwrap_or_else(|p| p.into_inner());
                                core.poll_audio()?;
                                if let Some(health) = core.audio_health() {
                                    let _ = app.emit("audio_health", health);
                                }
                                let rows = {
                                    let mut query = core.db.prepare(
                                        "SELECT meeting_id,revision FROM processing_sessions",
                                    )?;
                                    let rows = query.query_map([], |r| {
                                        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
                                    })?;
                                    rows.collect::<std::result::Result<Vec<_>, _>>()?
                                };
                                revisions
                                    .retain(|id, _| rows.iter().any(|(current, _)| current == id));
                                for (id, revision) in rows {
                                    if revisions.get(&id) != Some(&revision) {
                                        if let Some(snapshot) = core.session_processing(&id)? {
                                            revisions.insert(id, snapshot.revision);
                                            let _ =
                                                app.emit("session_processing_changed", snapshot);
                                        }
                                    }
                                }
                                Ok(())
                            }
                        }));
                    if let Err(error) = result {
                        let _ = monitor_app.emit("backend_error", error.message);
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("request_close", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_meetings,
            get_meeting,
            get_recording_state,
            get_startup_warning,
            start_recording,
            pause_recording,
            resume_recording,
            stop_recording,
            prepare_session_processing,
            get_session_processing,
            cancel_session_processing,
            acknowledge_processing_notes,
            prepare_session_retry,
            retry_session_processing,
            save_notes,
            get_settings,
            save_settings,
            choose_vault_folder,
            export_meeting,
            close_application,
            list_audio_devices,
            provider_key_status,
            save_api_connection,
            delete_api_connection,
            api_connection_key_status,
            save_provider_assignment,
            list_api_connection_models,
            save_stt_mode,
            plan_transcription,
            plan_question,
            plan_library_question,
            stt_status,
            stt_install,
            transcribe_meeting,
            generate_summary,
            create_note,
            audio_usage,
            delete_audio,
            delete_meeting,
            search_meetings,
            plan_summary,
            list_summaries,
            save_summary_edit,
            save_speaker_names,
            edit_segment,
            get_transcript_version,
            ask_meeting,
            ask_library,
            delete_question_thread,
            rename_meeting,
            set_meeting_tags,
            save_export_options,
            save_processing_default,
            save_summary_default,
            save_default_devices,
            save_summary_instructions,
            save_summary_template,
            delete_summary_template,
            save_recipe,
            delete_recipe,
            list_library_answers,
            delete_library_answer,
            plan_rewrite,
            rewrite_text,
            save_action_item,
            delete_action_item,
            import_action_items,
            recover_audio,
            cancel_transcription,
            save_stt_settings,
            audio_position,
            choose_model_folder,
            scan_local_models,
            import_local_model,
            search_hf_models,
            list_hf_files,
            download_hf_model,
            cancel_model_download,
        ])
        .build(tauri::generate_context!())
        .expect("OpenMeet could not start. Check the local database and desktop permissions.");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. }
            if !app.state::<AppState>().allow_exit.load(Ordering::Acquire) =>
        {
            api.prevent_exit();
            show_window(app);
            let _ = app.emit("request_close", ());
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_warning_names_each_failed_shortcut() {
        assert_eq!(shortcut_warning(None, None), None);
        let pause = shortcut_warning(Some("Ctrl+Shift+Space"), None).unwrap();
        assert!(pause.starts_with("Shortcut unavailable: Pause (Ctrl+Shift+Space). Another"));
        let stop = shortcut_warning(None, Some("Alt+S")).unwrap();
        assert!(stop.starts_with("Shortcut unavailable: Stop (Alt+S). Another"));
        let both = shortcut_warning(Some("Ctrl+Shift+Space"), Some("Alt+S")).unwrap();
        assert!(
            both.starts_with("Shortcut unavailable: Pause (Ctrl+Shift+Space) and Stop (Alt+S).")
        );
    }

    #[test]
    fn summary_consent_binds_the_resolved_template_and_instructions() {
        let mut core = Core::open(std::path::Path::new(":memory:")).unwrap();
        let id = core.create_note("Fictional summary consent").unwrap();
        core.save_notes(&id, "Fictional notes", 0).unwrap();
        let detail = core.get_meeting(&id).unwrap();
        let config = ProviderConfig {
            base_url: "https://provider.example/v1".into(),
            model: Some("model-a".into()),
            revision: 1,
            credential_account: Some("private-reference".into()),
        };
        let settings = core
            .save_summary_template(None, "Retro", "## Went well")
            .unwrap();
        let template = settings.summary_templates[0].id.clone();
        let plan_for = |settings: &Settings| {
            let system = llm::resolve_summary(settings, &template).unwrap();
            text_plan(&config, &detail, &[], "summary", &system, 1).unwrap()
        };
        let reviewed = plan_for(&settings);
        confirm(&plan_for(&settings), Some(&reviewed.fingerprint)).unwrap();
        let edited = core
            .save_summary_template(Some(&template), "Retro", "## Changed")
            .unwrap();
        assert!(confirm(&plan_for(&edited), Some(&reviewed.fingerprint)).is_err());
        let instructed = core.save_summary_instructions("Be brief.").unwrap();
        let reviewed = plan_for(&instructed);
        let changed = core.save_summary_instructions("Be detailed.").unwrap();
        assert!(confirm(&plan_for(&changed), Some(&reviewed.fingerprint)).is_err());
        let deleted = core.delete_summary_template(&template).unwrap();
        assert_eq!(
            llm::resolve_summary(&deleted, &template).unwrap_err().code,
            "summary_template_missing"
        );
    }

    #[test]
    fn question_consent_binds_earlier_turns_and_refuses_other_meetings_threads() {
        let mut core = Core::open(std::path::Path::new(":memory:")).unwrap();
        let (id, other) = (
            core.create_note("Fictional question consent").unwrap(),
            core.create_note("Another fictional meeting").unwrap(),
        );
        core.save_notes(&id, "Fictional notes", 0).unwrap();
        let config = ProviderConfig {
            base_url: "https://provider.example/v1".into(),
            model: Some("model-a".into()),
            revision: 1,
            credential_account: Some("private-reference".into()),
        };
        let thread = core
            .save_question_turn(&id, None, "Budget?", "40k", "p", "m")
            .unwrap();
        let plan_for = |core: &Core, thread_id: Option<i64>| {
            let detail = core.get_meeting(&id).unwrap();
            let earlier = earlier_turns(&detail.question_threads, thread_id).unwrap();
            let block = llm::question_block("Why?", &earlier);
            text_plan(&config, &detail, &[], "question", &block, 1).unwrap()
        };
        let reviewed = plan_for(&core, Some(thread.id));
        confirm(
            &plan_for(&core, Some(thread.id)),
            Some(&reviewed.fingerprint),
        )
        .unwrap();
        assert!(confirm(&plan_for(&core, None), Some(&reviewed.fingerprint)).is_err());
        core.save_question_turn(&id, Some(thread.id), "Owner?", "Rahul", "p", "m")
            .unwrap();
        assert!(confirm(
            &plan_for(&core, Some(thread.id)),
            Some(&reviewed.fingerprint)
        )
        .is_err());
        let foreign = core.get_meeting(&other).unwrap().question_threads;
        assert_eq!(
            earlier_turns(&foreign, Some(thread.id)).unwrap_err().code,
            "not_found"
        );
    }

    #[test]
    fn library_scope_is_explicit_ordered_and_bound_to_every_meetings_sent_text() {
        let mut core = Core::open(std::path::Path::new(":memory:")).unwrap();
        let (a, b, outside) = (
            core.create_note("Alpha").unwrap(),
            core.create_note("Beta").unwrap(),
            core.create_note("Outside").unwrap(),
        );
        core.save_notes(&a, "Alpha notes", 0).unwrap();
        core.save_notes(&outside, "Private elsewhere", 0).unwrap();
        let segment = |text: &str| Segment {
            speaker: "You".into(),
            timing: SegmentTiming::Timed {
                start_ms: 61_000,
                end_ms: 62_000,
            },
            text: text.into(),
        };
        core.replace_transcript(&b, &[segment("Beta words")], "p", "m")
            .unwrap();
        let config = ProviderConfig {
            base_url: "https://provider.example/v1".into(),
            model: Some("model-a".into()),
            revision: 1,
            credential_account: Some("private-reference".into()),
        };
        // Duplicates collapse in first-seen order; empty, oversized and unknown scopes are refused.
        let ids = library_ids(vec![b.clone(), a.clone(), b.clone()]).unwrap();
        assert_eq!(ids, [b.clone(), a.clone()]);
        assert_eq!(library_ids(vec![]).unwrap_err().code, "invalid_scope");
        let many: Vec<String> = (0..=llm::MAX_LIBRARY_MEETINGS)
            .map(|n| n.to_string())
            .collect();
        assert_eq!(library_ids(many).unwrap_err().code, "invalid_scope");
        assert_eq!(
            library_scope(&core, &["missing".into()], "Why?")
                .unwrap_err()
                .code,
            "invalid_scope"
        );

        let scope = library_scope(&core, &ids, "Why?").unwrap();
        assert_eq!(scope.excerpts, None);
        let items = &scope.items;
        assert_eq!(
            items
                .iter()
                .map(|item| item.title.as_str())
                .collect::<Vec<_>>(),
            ["Beta", "Alpha"]
        );
        assert_eq!(items[0].lines, ["[1:01] You: Beta words"]);
        assert_eq!(items[1].notes, "Alpha notes");
        let sent = serde_json::to_string(&items).unwrap();
        assert!(!sent.contains("Private elsewhere") && !sent.contains("Outside"));

        let reviewed = library_plan(&config, &scope, " Why? ").unwrap();
        let same = library_plan(
            &config,
            &library_scope(&core, &ids, "Why?").unwrap(),
            "Why?",
        )
        .unwrap();
        confirm(&same, Some(&reviewed.fingerprint)).unwrap();
        assert!(library_unchanged(&core, &ids, "Why?", &scope));
        // The unselected meeting may change freely; either selected meeting may not.
        core.save_notes(&outside, "Edited elsewhere", 1).unwrap();
        assert!(library_unchanged(&core, &ids, "Why?", &scope));
        for change in ["notes", "transcript", "title", "order", "question"] {
            let (mut now, mut question) = (ids.clone(), "Why?");
            match change {
                "notes" => {
                    core.save_notes(&a, "Alpha notes edited", 1).unwrap();
                }
                "transcript" => core
                    .replace_transcript(&b, &[segment("Changed words")], "p", "m")
                    .unwrap(),
                "title" => {
                    core.rename_meeting(&b, "Renamed").unwrap();
                }
                "order" => now.reverse(),
                _ => question = "Who?",
            }
            let current = library_scope(&core, &now, question).unwrap();
            let plan = library_plan(&config, &current, question).unwrap();
            assert_eq!(
                confirm(&plan, Some(&reviewed.fingerprint))
                    .unwrap_err()
                    .code,
                "processing_plan_changed",
                "{change}"
            );
            if matches!(change, "notes" | "transcript" | "title") {
                assert!(!library_unchanged(&core, &ids, "Why?", &scope), "{change}");
            }
        }
        // With no saved LLM connection the settings check also refuses.
        let fresh = library_scope(&core, &ids, "Why?").unwrap();
        assert_eq!(
            library_check(&core, &ids, &config, "Why?", &fresh)
                .unwrap_err()
                .code,
            "processing_plan_changed"
        );
    }

    #[test]
    fn consent_binds_destination_model_revision_and_content() {
        let mut config = ProviderConfig {
            base_url: "https://provider.example/v1".into(),
            model: Some("model-a".into()),
            revision: 1,
            credential_account: Some("private-reference".into()),
        };
        let plan = processing_plan(&config, &("summary", "original notes"), 1, 0, vec![]).unwrap();
        assert_eq!(
            (plan.base_url.as_str(), plan.model.as_str(), plan.requests),
            ("https://provider.example/v1", "model-a", 1)
        );
        assert_eq!(confirm(&plan, None).unwrap_err().code, "consent_required");
        confirm(&plan, Some(&plan.fingerprint)).unwrap();
        for change in ["destination", "model", "credential", "content"] {
            let mut changed_config = config.clone();
            let mut notes = "original notes";
            match change {
                "destination" => changed_config.base_url = "https://different.example/v1".into(),
                "model" => changed_config.model = Some("model-b".into()),
                "credential" => changed_config.revision += 1,
                _ => notes = "updated notes",
            }
            let changed =
                processing_plan(&changed_config, &("summary", notes), 1, 0, vec![]).unwrap();
            assert_eq!(
                confirm(&changed, Some(&plan.fingerprint)).unwrap_err().code,
                "processing_plan_changed"
            );
        }
        config.model = None;
        assert_eq!(
            processing_plan(&config, &"content", 1, 0, vec![])
                .unwrap_err()
                .code,
            "provider_model"
        );
    }

    #[test]
    fn untimed_transcript_text_has_no_invented_time_citations() {
        let entries = [
            Segment {
                speaker: "You".into(),
                text: "Timed words".into(),
                timing: SegmentTiming::Timed {
                    start_ms: 61_000,
                    end_ms: 62_000,
                },
            },
            Segment {
                speaker: "Others".into(),
                text: "Untimed words".into(),
                timing: SegmentTiming::Untimed,
            },
        ];
        assert_eq!(
            transcript_lines(&entries, &SpeakerNames::default()),
            ["[1:01] You: Timed words", "Others: Untimed words"]
        );
        let names = SpeakerNames {
            you: Some("Rahul".into()),
            others: None,
        };
        assert_eq!(
            transcript_lines(&entries, &names),
            ["[1:01] Rahul (You): Timed words", "Others: Untimed words"]
        );
    }

    #[test]
    fn cloud_upload_checks_mode_language_vocabulary_and_connection_before_sending() {
        let core = Core::open(Path::new(":memory:")).unwrap();
        let mut snapshot = core.settings().unwrap();
        snapshot.stt_mode = SttMode::Cloud;
        snapshot.cloud_stt = Some(ProviderConfig {
            base_url: "https://speech.example/v1".into(),
            model: Some("speech-model".into()),
            revision: 1,
            credential_account: Some("test-reference".into()),
        });
        assert!(same_stt_settings(&snapshot, &snapshot));
        for change in ["mode", "language", "vocabulary", "connection"] {
            let mut current = snapshot.clone();
            match change {
                "mode" => current.stt_mode = SttMode::Local,
                "language" => current.stt_language = "de".into(),
                "vocabulary" => current.stt_prompt = "changed".into(),
                _ => current.cloud_stt.as_mut().unwrap().revision += 1,
            }
            assert!(!same_stt_settings(&current, &snapshot), "{change}");
        }
        let mut current = snapshot.clone();
        current.stt_model = "base".into();
        assert!(
            same_stt_settings(&current, &snapshot),
            "inactive local model does not reroute cloud audio"
        );
    }

    #[test]
    fn stop_shortcut_is_optional_and_must_differ_from_pause() {
        let (pause, stop) = parse_shortcuts("CommandOrControl+Shift+Space", None).unwrap();
        assert_eq!(stop, None);
        let (_, stop) =
            parse_shortcuts("CommandOrControl+Shift+Space", Some("Alt+Shift+S")).unwrap();
        assert!(stop.is_some_and(|stop| stop != pause));
        for (pause, stop) in [
            (
                "CommandOrControl+Shift+Space",
                Some("CommandOrControl+Shift+Space"),
            ),
            // Same keys spelled differently are still the same shortcut.
            ("Ctrl+Shift+Space", Some("Shift+Control+Space")),
            ("CommandOrControl+Shift+Space", Some("not a shortcut")),
            ("", None),
        ] {
            assert_eq!(
                parse_shortcuts(pause, stop).unwrap_err().code,
                "invalid_shortcut",
                "{pause} / {stop:?}"
            );
        }
        assert!(parse_shortcuts(&"A+".repeat(60), None).is_err());
    }

    /// A fictional meeting of `count` one-second lines ("filler N"); `special` replaces the
    /// text of chosen lines.
    fn long_meeting(
        core: &mut Core,
        title: &str,
        count: usize,
        filler: &str,
        special: &[(usize, &str)],
    ) -> String {
        let id = core.create_note(title).unwrap();
        let segments: Vec<Segment> = (0..count)
            .map(|n| Segment {
                speaker: "Others".into(),
                timing: SegmentTiming::Timed {
                    start_ms: n as i64 * 1000,
                    end_ms: n as i64 * 1000 + 500,
                },
                text: special
                    .iter()
                    .find(|(at, _)| *at == n)
                    .map_or_else(|| format!("{filler} {n}"), |(_, text)| text.to_string()),
            })
            .collect();
        core.replace_transcript(&id, &segments, "whisper", "small")
            .unwrap();
        id
    }

    fn filler() -> String {
        format!("filler {}", "x".repeat(100))
    }

    fn config() -> ProviderConfig {
        ProviderConfig {
            base_url: "https://provider.example/v1".into(),
            model: Some("m".into()),
            revision: 1,
            credential_account: None,
        }
    }

    fn full_lines(detail: &MeetingDetail) -> Vec<String> {
        transcript_lines(&detail.segments, &detail.speaker_names)
    }

    #[test]
    fn long_meeting_question_sends_hits_with_neighbours_in_order_and_binds_them() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = long_meeting(
            &mut core,
            "Long",
            1500,
            &filler(),
            &[
                (700, "Persimmon budget approved at 40k"),
                (1200, "Then the persimmon rollout starts"),
            ],
        );
        let detail = core.get_meeting(&id).unwrap();
        let all = full_lines(&detail);
        assert!(!llm::question_fits("", &all, "q", &[]));
        let question = "What was the persimmon budget?";
        let content = question_content(&core, &detail, question, &[]).unwrap();
        assert_eq!(
            content.excerpts,
            Some(ExcerptSummary {
                segments: 10,
                meetings: 1
            })
        );
        assert_eq!(all[700], "[11:40] Others: Persimmon budget approved at 40k");
        let expected: Vec<String> = all[698..=702]
            .iter()
            .chain(["…".to_string()].iter())
            .chain(all[1198..=1202].iter())
            .cloned()
            .collect();
        assert_eq!(content.lines, expected);
        assert!(content.notes.is_empty());
        // Words from a hostile question are quoted text, never FTS5 syntax.
        let hostile = "persimmon\" OR NEAR( budget* AND body:x";
        assert!(question_content(&core, &detail, hostile, &[])
            .unwrap()
            .excerpts
            .is_some());

        // The fingerprint binds the excerpted lines: editing one changes the plan ...
        let block = llm::question_block(question, &[]);
        let plan = question_plan(&config(), &detail, &content, &block).unwrap();
        assert_eq!(plan.excerpts, content.excerpts);
        let edit = |core: &mut Core, line: usize, text: &str| {
            let detail = core.get_meeting(&id).unwrap();
            core.edit_segment(
                &id,
                detail.segment_meta[line].id,
                &detail.segments[line].text,
                text,
            )
            .unwrap();
            let detail = core.get_meeting(&id).unwrap();
            let content = question_content(core, &detail, question, &[]).unwrap();
            let plan = question_plan(&config(), &detail, &content, &block).unwrap();
            (content, plan)
        };
        let (edited, edited_plan) = edit(&mut core, 700, "Persimmon budget approved at 45k");
        assert_ne!(edited, content);
        assert_ne!(edited_plan.fingerprint, plan.fingerprint);
        // ... while a line that is not sent can change without invalidating the review.
        let (same, same_plan) = edit(&mut core, 10, "Something else entirely");
        assert_eq!(same, edited);
        assert_eq!(same_plan.fingerprint, edited_plan.fingerprint);
    }

    #[test]
    fn excerpts_respect_the_budget_without_cutting_a_line() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let dense = format!("persimmon {}", "x".repeat(400));
        let id = long_meeting(&mut core, "Dense", 1500, &dense, &[]);
        let detail = core.get_meeting(&id).unwrap();
        let all = full_lines(&detail);
        let content = question_content(&core, &detail, "persimmon?", &[]).unwrap();
        let sent = content.lines.join("\n").len();
        assert!(sent > 0 && sent <= llm::question_budget("", "persimmon?", &[]));
        assert!(content
            .lines
            .iter()
            .all(|line| line == "…" || all.contains(line)));
        assert!(llm::validate_question(&content.notes, &content.lines, "persimmon?", &[]).is_ok());
    }

    #[test]
    fn question_without_a_match_is_insufficient_evidence_and_sends_nothing() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = long_meeting(&mut core, "Long", 1500, &filler(), &[]);
        let detail = core.get_meeting(&id).unwrap();
        // The command stops here, before a request exists to send.
        let error = question_content(&core, &detail, "What about zucchini?", &[]).unwrap_err();
        assert_eq!(error.code, "insufficient_evidence");
        assert!(error.message.ends_with("Nothing was sent."));
        // A question with no usable words matches nothing either.
        assert_eq!(
            question_content(&core, &detail, "Why is it so?", &[])
                .unwrap_err()
                .code,
            "insufficient_evidence"
        );
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        // Matching notes alone are enough evidence to ask.
        core.save_notes(&id, "The zucchini plan is final", detail.notes_revision)
            .unwrap();
        let detail = core.get_meeting(&id).unwrap();
        let content = question_content(&core, &detail, "What about zucchini?", &[]).unwrap();
        assert_eq!(content.notes, "The zucchini plan is final");
        assert!(content.lines.is_empty());
        assert_eq!(content.excerpts.map(|e| e.segments), Some(0));
    }

    #[test]
    fn short_meeting_still_sends_the_full_content() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = long_meeting(&mut core, "Short", 5, "line", &[]);
        let detail = core.get_meeting(&id).unwrap();
        core.save_notes(&id, "My notes", detail.notes_revision)
            .unwrap();
        let detail = core.get_meeting(&id).unwrap();
        let content = question_content(&core, &detail, "Anything unrelated?", &[]).unwrap();
        assert_eq!(content.excerpts, None);
        assert_eq!(content.notes, "My notes");
        assert_eq!(content.lines, full_lines(&detail));
        let plan = question_plan(&config(), &detail, &content, "q").unwrap();
        assert_eq!(plan.excerpts, None);
    }

    #[test]
    fn library_over_budget_sends_excerpts_across_meetings() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let a = long_meeting(
            &mut core,
            "Alpha",
            700,
            &filler(),
            &[(300, "Persimmon budget approved")],
        );
        let b = long_meeting(&mut core, "Beta", 700, &filler(), &[]);
        let c = long_meeting(
            &mut core,
            "Gamma",
            700,
            &filler(),
            &[(650, "The persimmon budget doubled")],
        );
        let ids = vec![a.clone(), b, c];
        let question = "persimmon budget";
        let scope = library_scope(&core, &ids, question).unwrap();
        assert_eq!(
            scope.excerpts,
            Some(ExcerptSummary {
                segments: 10,
                meetings: 2
            })
        );
        // Refs stay M1..M3 in scope order; the meeting without a match sends no transcript.
        assert_eq!(scope.items.len(), 3);
        assert!(scope.items[0]
            .lines
            .contains(&"[5:00] Others: Persimmon budget approved".to_string()));
        assert!(scope.items[1].lines.is_empty());
        assert!(scope.items[2]
            .lines
            .contains(&"[10:50] Others: The persimmon budget doubled".to_string()));
        assert!(llm::validate_library(&scope.items, question).is_ok());
        let plan = library_plan(&config(), &scope, question).unwrap();
        assert_eq!(plan.excerpts, scope.excerpts);
        assert!(library_unchanged(&core, &ids, question, &scope));
        // Editing an excerpted segment changes what is sent, so the review is void.
        let detail = core.get_meeting(&a).unwrap();
        core.edit_segment(
            &a,
            detail.segment_meta[300].id,
            &detail.segments[300].text,
            "Persimmon budget rejected",
        )
        .unwrap();
        assert!(!library_unchanged(&core, &ids, question, &scope));
        let changed = library_scope(&core, &ids, question).unwrap();
        assert_ne!(
            library_plan(&config(), &changed, question)
                .unwrap()
                .fingerprint,
            plan.fingerprint
        );
        assert_eq!(
            library_scope(&core, &ids, "zucchini").unwrap_err().code,
            "insufficient_evidence"
        );
    }

    #[test]
    fn small_library_scope_still_sends_every_meeting_in_full() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let a = long_meeting(&mut core, "Alpha", 4, "one", &[]);
        let b = long_meeting(&mut core, "Beta", 4, "two", &[]);
        let scope = library_scope(&core, &[a.clone(), b], "Unrelated words?").unwrap();
        assert_eq!(scope.excerpts, None);
        assert_eq!(
            scope.items[0].lines,
            full_lines(&core.get_meeting(&a).unwrap())
        );
        assert_eq!(scope.items[1].lines.len(), 4);
    }
}
