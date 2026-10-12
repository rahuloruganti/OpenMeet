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
async fn transcribe_meeting(app: AppHandle, id: String) -> Result<()> {
    let root = stt_root(&app)?;
    let (detail, settings) = {
        let id = id.clone();
        with_core(app.clone(), false, move |core, _| {
            Ok((core.get_meeting(&id)?, core.settings()?))
        })
        .await?
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
    let emitter = app.clone();
    // A failed or cancelled run returns early here, so the previous transcript is kept.
    let segments = blocking(move || {
        stt::transcribe(&root, &tracks, &settings, |track, percent| {
            let progress = stt::TranscribeProgress {
                stage: "transcribing",
                track: track.to_string(),
                percent,
            };
            let _ = emitter.emit("stt_progress", progress);
        })
    })
    .await?;
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
        let folder = core.settings()?.vault_folder.ok_or_else(|| {
            AppError::new("no_vault", "Choose an export folder in Settings first.")
        })?;
        export::write_snapshot(&core.get_meeting(&id)?, Path::new(&folder))
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
fn cancel_transcription() -> bool {
    stt::cancel()
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

/// Maps a transcript (session) time to a position in one track's WAV for seeking playback.
#[tauri::command]
async fn audio_position(app: AppHandle, id: String, kind: String, session_ms: i64) -> Result<i64> {
    let detail = with_core(app, false, move |core, _| core.get_meeting(&id)).await?;
    let track = detail
        .tracks
        .into_iter()
        .find(|track| track.kind == kind)
        .ok_or_else(|| AppError::new("not_found", "That audio track does not exist."))?;
    blocking(move || Ok(stt::track_file_ms(&track, session_ms))).await
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show_window(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, shortcut, event| {
            if event.state == ShortcutState::Pressed { shortcut_action(app, *shortcut); }
        }).build())
        .setup(|app| {
            let folder = app.path().app_data_dir()?;
            std::fs::create_dir_all(&folder)?;
            let core = Core::open(&folder.join("meetings.db"))?;
            let settings = core.settings()?;
            let pause_failed = app.global_shortcut().register(settings.pause_shortcut.as_str()).is_err();
            let stop_failed = settings.stop_shortcut.as_deref().is_some_and(|stop| app.global_shortcut().register(stop).is_err());
            let startup_warning = (pause_failed || stop_failed).then(|| format!("{} shortcut unavailable. Use the on-screen controls and choose another shortcut in Settings.", if pause_failed { "Pause" } else { "Stop" }));
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
                    "pause" => tray_action(app, Core::toggle_pause),
                    "stop" => tray_action(app, Core::stop),
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
            cancel_transcription, save_stt_settings, audio_position,
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
}
