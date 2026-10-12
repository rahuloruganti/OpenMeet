pub mod audio;
mod domain;
mod export;
mod merge;
mod storage;
mod stt;

use domain::*;
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
        result
    })
    .await
    .map_err(|_| AppError::new("worker", "The background operation failed."))?
}

fn publish(app: &AppHandle, state: &RecordingState) {
    if let Some(tray) = app.tray_by_id("recorder") {
        let label = match (&state.status, state.source.as_deref()) {
            (CaptureStatus::Recording, Some("desktop")) => {
                "OpenMeet — RECORDING microphone + system audio"
            }
            (CaptureStatus::Paused, Some("desktop")) => "OpenMeet — audio PAUSED",
            (CaptureStatus::Recording, _) => "OpenMeet — SIMULATION (no audio)",
            (CaptureStatus::Paused, _) => "OpenMeet — simulation paused",
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

fn tray_action(app: &AppHandle, stop: bool) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = with_core(app.clone(), true, move |core, _| {
            if stop {
                core.stop()
            } else {
                core.toggle_pause()
            }
        })
        .await;
        if let Err(error) = result {
            show_window(&app);
            let _ = app.emit("backend_error", error.message);
        }
    });
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
    simulation: bool,
    consent: bool,
    devices: Option<audio::CaptureOptions>,
) -> Result<RecordingState> {
    with_core(app, true, move |core, _| {
        if simulation {
            core.start(&title)
        } else {
            core.start_desktop(
                &title,
                devices.ok_or_else(|| {
                    AppError::new("audio_devices", "Choose microphone and system output.")
                })?,
                consent,
            )
        }
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
async fn create_fixture_meeting(app: AppHandle) -> Result<String> {
    with_core(app, true, |core, _| core.create_fixture()).await
}

#[tauri::command]
async fn get_settings(app: AppHandle) -> Result<Settings> {
    with_core(app, false, |core, _| core.settings()).await
}

#[tauri::command]
async fn merge_key_status() -> Result<bool> {
    blocking(merge::key_present).await
}

#[tauri::command]
async fn import_merge_key() -> Result<bool> {
    blocking(|| merge::import_key_from_env().map(|()| true)).await
}

#[tauri::command]
async fn delete_merge_key() -> Result<bool> {
    blocking(|| merge::delete_key().map(|()| false)).await
}

#[tauri::command]
async fn list_merge_models() -> Result<Vec<merge::MergeModel>> {
    blocking(merge::list_models).await
}

#[tauri::command]
async fn save_merge_model(app: AppHandle, model: String) -> Result<Settings> {
    // Network discovery must not hold the recording/storage mutex.
    let available: Vec<String> = list_merge_models()
        .await?
        .into_iter()
        .filter(|candidate| candidate.available)
        .map(|candidate| candidate.model)
        .collect();
    with_core(app, false, move |core, _| {
        core.save_merge_model(&model, &available)
    })
    .await
}

fn stt_root(app: &AppHandle) -> Result<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("stt"))
        .map_err(|_| AppError::new("stt", "The app data folder is unavailable."))
}

#[tauri::command]
async fn stt_status(app: AppHandle) -> Result<stt::Status> {
    let root = stt_root(&app)?;
    Ok(stt::status(&root))
}

/// Downloads the pinned engine and models. Only runs on an explicit user action.
#[tauri::command]
async fn stt_install(app: AppHandle) -> Result<stt::Status> {
    let root = stt_root(&app)?;
    let emitter = app.clone();
    blocking(move || {
        stt::install(&root, |progress| {
            let _ = emitter.emit("stt_progress", progress);
        })
    })
    .await
}

#[tauri::command]
async fn transcribe_meeting(app: AppHandle, id: String) -> Result<()> {
    let root = stt_root(&app)?;
    let detail = {
        let id = id.clone();
        with_core(app.clone(), false, move |core, _| core.get_meeting(&id)).await?
    };
    if matches!(detail.meeting.status.as_str(), "recording" | "paused") {
        return Err(AppError::new(
            "stt",
            "Stop the recording before transcribing it.",
        ));
    }
    let tracks: Vec<audio::Track> = detail
        .tracks
        .into_iter()
        .filter(|track| track.finalized && track.frames > 0)
        .collect();
    if tracks.is_empty() {
        return Err(AppError::new(
            "stt",
            "This meeting has no finalized audio tracks to transcribe.",
        ));
    }
    let segments = blocking(move || stt::transcribe(&root, &tracks)).await?;
    with_core(app, true, move |core, _| {
        core.replace_transcript(&id, &segments)
    })
    .await
}

/// Sends notes + transcript TEXT (never audio) to Merge. Requires explicit consent each call.
#[tauri::command]
async fn generate_summary(app: AppHandle, id: String, consent: bool) -> Result<()> {
    if !consent {
        return Err(AppError::new(
            "consent_required",
            "Confirm what will be sent before generating a summary.",
        ));
    }
    let (detail, settings) = {
        let id = id.clone();
        with_core(app.clone(), false, move |core, _| {
            Ok((core.get_meeting(&id)?, core.settings()?))
        })
        .await?
    };
    let model = settings.merge_model.ok_or_else(|| {
        AppError::new(
            "merge_model_missing",
            "Choose a Merge model in Settings first.",
        )
    })?;
    let transcript = detail
        .segments
        .iter()
        .map(|segment| {
            format!(
                "[{}:{:02}] {}: {}",
                segment.start_ms / 60_000,
                segment.start_ms / 1000 % 60,
                segment.speaker,
                segment.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let notes = detail.user_markdown.clone();
    if notes.trim().is_empty() && transcript.is_empty() {
        return Err(AppError::new(
            "summary_empty",
            "There are no notes or transcript to summarize. Nothing was sent.",
        ));
    }
    let used_model = model.clone();
    let markdown = blocking(move || merge::summarize(&model, &notes, &transcript)).await?;
    with_core(app, true, move |core, _| {
        core.save_summary(&id, "merge", &used_model, &markdown)
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
async fn save_settings(app: AppHandle, pause_shortcut: String) -> Result<Settings> {
    with_core(app, false, move |core, app| {
        if pause_shortcut.len() > 100 {
            return Err(AppError::new("invalid_shortcut", "Shortcut is too long."));
        }
        let next: Shortcut = pause_shortcut.parse().map_err(|_| {
            AppError::new(
                "invalid_shortcut",
                "Use a shortcut such as CommandOrControl+Shift+Space.",
            )
        })?;
        let old = core.settings()?.pause_shortcut;
        let shortcuts = app.global_shortcut();
        let old_parsed: Shortcut = old
            .parse()
            .map_err(|_| AppError::new("invalid_shortcut", "The saved shortcut is invalid."))?;
        if next == old_parsed && shortcuts.is_registered(next) {
            return core.settings();
        }
        shortcuts.register(next).map_err(|_| {
            AppError::new(
                "shortcut_unavailable",
                "This shortcut could not be registered. Choose another combination.",
            )
        })?;
        if let Err(error) = core.save_shortcut(&pause_shortcut) {
            let _ = shortcuts.unregister(next);
            return Err(error);
        }
        if old_parsed != next
            && shortcuts.is_registered(old_parsed)
            && shortcuts.unregister(old_parsed).is_err()
        {
            let _ = shortcuts.unregister(next);
            core.save_shortcut(&old)?;
            return Err(AppError::new(
                "shortcut_unavailable",
                "Could not replace the old shortcut. Restart before trying again.",
            ));
        }
        core.settings()
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
    with_core(app.clone(), true, |core, _| core.stop().map(|_| ())).await?;
    app.state::<AppState>()
        .allow_exit
        .store(true, Ordering::Release);
    app.exit(0);
    Ok(())
}

#[tauri::command]
async fn rename_meeting(app: AppHandle, id: String, title: String) -> Result<String> {
    with_core(app, true, move |core, _| core.rename_meeting(&id, &title)).await
}

#[tauri::command]
async fn save_export_options(app: AppHandle, options: ExportOptions) -> Result<Settings> {
    with_core(app, false, move |core, _| {
        core.save_export_options(&options)
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

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show_window(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, _, event| {
            if event.state == ShortcutState::Pressed { tray_action(app, false); }
        }).build())
        .setup(|app| {
            let folder = app.path().app_data_dir()?;
            std::fs::create_dir_all(&folder)?;
            let core = Core::open(&folder.join("meetings.db"))?;
            let shortcut = core.settings()?.pause_shortcut;
            let startup_warning = app.global_shortcut().register(shortcut.as_str()).err().map(|_| "Pause shortcut unavailable. Use the on-screen controls and choose another shortcut in Settings.".to_string());
            app.manage(AppState { core: Mutex::new(core), startup_warning, allow_exit: AtomicBool::new(false) });
            let show = MenuItem::with_id(app, "show", "Open OpenMeet", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "Pause / resume recording", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "Stop recording", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Save notes and quit…", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &pause, &stop, &quit])?;
            TrayIconBuilder::with_id("recorder")
                .icon(tray_image(&CaptureStatus::Idle))
                .tooltip("OpenMeet — capture preview, idle")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_window(app),
                    "pause" => tray_action(app, false),
                    "stop" => tray_action(app, true),
                    "quit" => { show_window(app); let _ = app.emit("request_close", ()); }
                    _ => {}
                })
                .build(app)?;
            let monitor_app = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(500));
                let result = tauri::async_runtime::block_on(with_core(
                    monitor_app.clone(),
                    false,
                    |core, app| {
                        core.poll_audio()?;
                        if let Some(health) = core.audio_health() { let _ = app.emit("audio_health", health); }
                        Ok(())
                    },
                ));
                if let Err(error) = result { let _ = monitor_app.emit("backend_error", error.message); }
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
            list_meetings, get_meeting, get_recording_state, get_startup_warning,
            start_recording, pause_recording, resume_recording, stop_recording,
            save_notes, create_fixture_meeting, get_settings, save_settings,
            choose_vault_folder, export_meeting, close_application, list_audio_devices,
            merge_key_status, import_merge_key, delete_merge_key, list_merge_models,
            save_merge_model,
            stt_status, stt_install, transcribe_meeting, generate_summary,
            rename_meeting, save_export_options, recover_audio,
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
