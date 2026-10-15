//! Local speech-to-text through a pinned whisper.cpp release.
//!
//! The engine and models are downloaded only on an explicit user action, size-capped and
//! SHA-256 verified, then run as a local subprocess. No audio leaves the device. Silero VAD
//! gates every track so silence is not "transcribed" into hallucinated text.
use crate::{
    audio::Track,
    audio_timing::{self, Block},
    domain::{AppError, Result, Segment, SegmentTiming, Settings},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

struct Artifact {
    name: &'static str,
    file: &'static str,
    url: &'static str,
    sha256: &'static str,
    size: u64,
}

// whisper.cpp release b5454, Windows x64 CPU build (asset digest published by GitHub).
const ENGINE: Artifact = Artifact {
    name: "engine",
    file: "whisper-bin-x64.zip",
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip",
    sha256: "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb",
    size: 8_928_640,
};
include!("stt_models.rs");
/// Whisper language codes offered in Settings; anything else is rejected before it reaches `-l`.
pub const LANGUAGES: [&str; 35] = [
    "auto", "ar", "ca", "cs", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "hr", "hu",
    "id", "it", "ja", "ko", "ms", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sv", "ta", "th", "tr",
    "uk", "ur", "vi", "zh",
];
const PROMPT_LIMIT: usize = 500;
const VAD: Artifact = Artifact {
    name: "vad",
    file: "ggml-silero-v5.1.2.bin",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
    sha256: "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
    size: 885_098,
};
const ENGINE_EXE: &str = "whisper-cli.exe";
const ENGINE_MARKER: &str = ".release";
const MAC_ENGINE_EXE: &str = "whisper-cli";
/// SHA-256 of the Apple Silicon `whisper-cli` built from whisper.cpp tag b5454
/// with Accelerate, not Metal. It is not a published download.
const MAC_ENGINE_SHA256: &str = "04a0fa1da7916eff12797438f61cb107b6fd7b0a9f0ce31bfe2b6b6adc0d6efe";

fn engine_filename() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        MAC_ENGINE_EXE
    } else {
        ENGINE_EXE
    }
}

fn engine_pin() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        MAC_ENGINE_SHA256
    } else {
        ENGINE.sha256
    }
}

fn speech_supported() -> bool {
    cfg!(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
    ))
}

#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub engine: bool,
    /// Whether the model selected in Settings is installed.
    pub model: bool,
    pub vad: bool,
    pub installed: bool,
    pub missing_bytes: u64,
    pub supported: bool,
    pub models: Vec<ModelStatus>,
    pub languages: &'static [&'static str],
}

#[derive(Clone, Debug, Serialize)]
pub struct ModelStatus {
    pub id: &'static str,
    pub size: u64,
    pub installed: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct TranscribeProgress {
    pub stage: &'static str,
    pub track: String,
    pub percent: u8,
}

#[derive(Clone, Debug, Serialize)]
pub struct Progress {
    pub stage: &'static str,
    pub downloaded: u64,
    pub total: u64,
}

fn engine_dir(root: &Path) -> PathBuf {
    root.join("engine")
}
fn models_dir(root: &Path) -> PathBuf {
    root.join("models")
}

fn model(id: &str) -> Result<&'static Artifact> {
    MODELS
        .iter()
        .find(|(name, _)| *name == id)
        .map(|(_, artifact)| artifact)
        .ok_or_else(|| AppError::new("stt_settings", "Choose one of the listed speech models."))
}

#[derive(Clone, Copy)]
pub(crate) struct ModelFile {
    pub id: &'static str,
    pub file: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

pub(crate) fn model_files() -> impl Iterator<Item = ModelFile> {
    MODELS.iter().map(|(id, artifact)| ModelFile {
        id,
        file: artifact.file,
        size: artifact.size,
        sha256: artifact.sha256,
    })
}

/// Checks transcription settings before they are stored or passed to the engine.
pub fn validate(language: &str, prompt: &str, model_id: &str) -> Result<()> {
    if !LANGUAGES.contains(&language) {
        return Err(AppError::new(
            "stt_settings",
            "Choose one of the listed transcription languages.",
        ));
    }
    if prompt.chars().count() > PROMPT_LIMIT || prompt.chars().any(char::is_control) {
        return Err(AppError::new(
            "stt_settings",
            "Keep the vocabulary hint to one line of at most 500 characters.",
        ));
    }
    model(model_id).map(|_| ())
}

pub fn status(root: &Path, model_id: &str) -> Status {
    let engine = engine_dir(root).join(engine_filename()).is_file()
        && fs::read_to_string(engine_dir(root).join(ENGINE_MARKER))
            .is_ok_and(|marker| marker.trim() == engine_pin());
    let present = |artifact: &Artifact| {
        fs::metadata(models_dir(root).join(artifact.file)).is_ok_and(|m| m.len() == artifact.size)
    };
    let selected = model(model_id).ok();
    let (model, vad) = (selected.is_some_and(present), present(&VAD));
    let model_size = selected.map_or(0, |artifact| artifact.size);
    let missing = [(engine, ENGINE.size), (model, model_size), (vad, VAD.size)]
        .iter()
        .filter(|(have, _)| !have)
        .map(|(_, size)| size)
        .sum();
    Status {
        engine,
        model,
        vad,
        installed: engine && model && vad,
        missing_bytes: missing,
        supported: speech_supported(),
        models: MODELS
            .iter()
            .map(|(id, artifact)| ModelStatus {
                id,
                size: artifact.size,
                installed: present(artifact),
            })
            .collect(),
        languages: &LANGUAGES,
    }
}

fn stt_error(message: impl Into<String>) -> AppError {
    AppError::new("stt", message)
}

fn download(
    client: &reqwest::blocking::Client,
    artifact: &Artifact,
    destination: &Path,
    progress: impl FnMut(u64),
) -> Result<()> {
    let fail = |message: &str| stt_error(message.to_string());
    let mut response = client.get(artifact.url).send().map_err(|_| {
        fail("Could not reach the download server. Check your connection and try again.")
    })?;
    if !response.status().is_success() {
        return Err(fail(&format!(
            "The download server returned HTTP {}.",
            response.status()
        )));
    }
    crate::model_library::copy_verified(
        &mut response,
        destination,
        artifact.size,
        artifact.sha256,
        progress,
    )
}

fn wanted_engine_file(name: &str) -> bool {
    name == ENGINE_EXE
        || name == "whisper.dll"
        || (name.starts_with("ggml") && name.ends_with(".dll"))
}

fn extract_engine(zip_path: &Path, destination: &Path) -> Result<()> {
    let mut archive = zip::ZipArchive::new(File::open(zip_path)?)
        .map_err(|_| stt_error("The engine archive is not a valid zip file."))?;
    fs::create_dir_all(destination)?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| stt_error("The engine archive could not be read."))?;
        // Basename only: archive paths never choose where a file lands.
        let Ok(full) = entry.name() else {
            continue;
        };
        let Some(name) = Path::new(&*full)
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_owned)
        else {
            continue;
        };
        if entry.is_dir() || !wanted_engine_file(&name) || entry.size() > 16 * 1024 * 1024 {
            continue;
        }
        let temporary = destination.join(format!("{name}.tmp"));
        std::io::copy(&mut entry, &mut File::create(&temporary)?)?;
        fs::rename(&temporary, destination.join(&name))?;
    }
    if !destination.join(ENGINE_EXE).is_file() {
        return Err(stt_error("The engine archive did not contain whisper-cli."));
    }
    Ok(())
}

/// Downloads whatever is missing for the selected model. Each artifact is verified before it
/// is installed. Other models already on disk are kept.
pub fn install(root: &Path, model_id: &str, mut report: impl FnMut(Progress)) -> Result<Status> {
    let selected = model(model_id)?;
    if !status(root, model_id).supported {
        return Err(stt_error(
            "Local speech-to-text needs Windows x64, or Apple Silicon with the local whisper.cpp b5454 build.",
        ));
    }
    let _operation = crate::model_library::ArtifactOperation::begin()?;
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.url().scheme() == "https" && attempt.previous().len() < 5 {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .connect_timeout(Duration::from_secs(15))
        .timeout(crate::model_library::TRANSFER_TIMEOUT)
        .build()
        .map_err(|_| stt_error("Could not prepare the download client."))?;
    fs::create_dir_all(models_dir(root))?;
    let before = status(root, model_id);
    let pending = [
        (before.engine, &ENGINE),
        (before.vad, &VAD),
        (before.model, selected),
    ];
    for (present, artifact) in pending {
        crate::model_library::check_cancel()?;
        if present {
            continue;
        }
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) && artifact.name == "engine" {
            return Err(stt_error(
                "The Mac speech engine is a local whisper.cpp b5454 build, not a download. It is not installed.",
            ));
        }
        let is_engine = artifact.name == ENGINE.name;
        let folder = if is_engine {
            root.to_path_buf()
        } else {
            models_dir(root)
        };
        let destination = folder.join(artifact.file);
        download(&client, artifact, &destination, |downloaded| {
            report(Progress {
                stage: artifact.name,
                downloaded,
                total: artifact.size,
            })
        })?;
        if is_engine {
            crate::model_library::check_cancel()?;
            let extracted = extract_engine(&destination, &engine_dir(root));
            let _ = fs::remove_file(&destination);
            extracted?;
            fs::write(engine_dir(root).join(ENGINE_MARKER), ENGINE.sha256)?;
        }
    }
    Ok(status(root, model_id))
}

/// Maps a position in the WAV to the session timeline, honouring pause gaps.
fn session_ms(index: &[Block], rate: u32, audio_ms: i64, end: bool) -> i64 {
    if index.is_empty() || rate == 0 {
        return audio_ms;
    }
    let frame = u128::from(audio_ms.max(0) as u64) * u128::from(rate) / 1000;
    let at = index
        .partition_point(|block| {
            if end {
                u128::from(block.frame_offset) < frame
            } else {
                u128::from(block.frame_offset) <= frame
            }
        })
        .saturating_sub(1);
    let block = &index[at];
    let within = frame
        .saturating_sub(u128::from(block.frame_offset))
        .min(u128::from(block.frames));
    ((u128::from(block.capture_start_us) + within * 1_000_000 / u128::from(rate)) / 1000)
        .min(i64::MAX as u128) as i64
}

/// A time inside a pause gap lands on the first frame recorded after it.
fn file_ms(index: &[Block], rate: u32, session_ms: i64) -> i64 {
    if index.is_empty() || rate == 0 {
        return session_ms.max(0);
    }
    let session_us = u128::from(session_ms.max(0) as u64) * 1000;
    let at = index.partition_point(|block| u128::from(block.capture_start_us) <= session_us);
    let Some(block) = at.checked_sub(1).map(|at| &index[at]) else {
        return 0;
    };
    let within = ((session_us - u128::from(block.capture_start_us)) * u128::from(rate) / 1_000_000)
        .min(u128::from(block.frames));
    ((u128::from(block.frame_offset) + within) * 1000 / u128::from(rate)).min(i64::MAX as u128)
        as i64
}

/// Reject missing or damaged pause timing instead of inventing a seek position.
pub fn track_file_ms(track: &Track, session_ms: i64) -> Result<i64> {
    let index = audio_timing::read(track, || Ok(()))?;
    Ok(file_ms(&index, track.sample_rate, session_ms))
}

#[derive(Deserialize)]
struct Output {
    transcription: Vec<Item>,
}
#[derive(Deserialize)]
struct Item {
    offsets: Offsets,
    text: String,
}
#[derive(Deserialize)]
struct Offsets {
    from: i64,
    to: i64,
}

fn parse_output(json: &[u8], speaker: &str, rate: u32, index: &[Block]) -> Result<Vec<Segment>> {
    let output: Output = serde_json::from_slice(json)
        .map_err(|_| stt_error("The speech engine returned unreadable output."))?;
    let mut segments = Vec::new();
    for item in output.transcription {
        let text = item.text.trim();
        // Non-speech markers such as [MUSIC] or (silence) are not transcript content.
        let marker = (text.starts_with('[') && text.ends_with(']'))
            || (text.starts_with('(') && text.ends_with(')'));
        if text.is_empty() || marker {
            continue;
        }
        let start = session_ms(index, rate, item.offsets.from.max(0), false);
        let end = session_ms(index, rate, item.offsets.to.max(item.offsets.from), true);
        segments.push(Segment {
            speaker: speaker.to_string(),
            timing: SegmentTiming::Timed {
                start_ms: start,
                end_ms: end.max(start),
            },
            text: text.to_string(),
        });
    }
    Ok(segments)
}

fn cancelled() -> AppError {
    AppError::new(
        "stt_cancelled",
        "Transcription was cancelled. The previous transcript was kept.",
    )
}

/// Parses whisper-cli `-pp` lines such as `whisper_print_progress_callback: progress =  45%`.
fn parse_progress(line: &str) -> Option<u8> {
    let (_, rest) = line.split_once("progress =")?;
    let percent: u8 = rest.trim().strip_suffix('%')?.trim().parse().ok()?;
    (percent <= 100).then_some(percent)
}

fn engine_command(
    root: &Path,
    settings: &Settings,
    track: &Track,
    output_base: &Path,
) -> Result<Command> {
    validate(
        &settings.stt_language,
        &settings.stt_prompt,
        &settings.stt_model,
    )?;
    let threads = std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .min(8);
    let mut command = Command::new(engine_dir(root).join(engine_filename()));
    command
        .current_dir(engine_dir(root))
        .arg("-m")
        .arg(models_dir(root).join(model(&settings.stt_model)?.file))
        .arg("--vad")
        .arg("-vm")
        .arg(models_dir(root).join(VAD.file))
        .arg("-f")
        .arg(&track.path)
        .arg("-oj")
        .arg("-of")
        .arg(output_base)
        .args(["-l", settings.stt_language.as_str()])
        .args(["-np", "-pp", "-sns", "-t"])
        .arg(threads.to_string());
    if !settings.stt_prompt.is_empty() {
        command.args(["--prompt", settings.stt_prompt.as_str()]);
    }
    Ok(command)
}

fn run_engine(
    mut command: Command,
    track: &Track,
    index: &[Block],
    scratch: &Path,
    output_base: &Path,
    cancel: &AtomicBool,
    mut report: impl FnMut(u8),
) -> Result<Vec<Segment>> {
    if cancel.load(Ordering::SeqCst) {
        return Err(cancelled());
    }
    let log_path = scratch.join("engine.log");
    command
        .stdin(Stdio::null())
        // Transcript text is printed to stdout; it is parsed from the JSON file instead.
        .stdout(Stdio::null())
        // Progress lines go to stderr; the log is read back incrementally below.
        .stderr(File::create(&log_path)?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .map_err(|_| stt_error("The speech engine could not be started."))?;
    let mut log = File::open(&log_path)?;
    let mut pending = Vec::new();
    // Generous bound: 4x the audio length plus two minutes.
    let audio_secs = (track.frames.max(0) as u64) / u64::from(track.sample_rate.max(1));
    let deadline = Instant::now() + Duration::from_secs(120 + 4 * audio_secs);
    let status = loop {
        let exited = child
            .try_wait()
            .map_err(|_| stt_error("The speech engine stopped unexpectedly."))?;
        let _ = log.read_to_end(&mut pending);
        while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            if let Some(percent) = parse_progress(&String::from_utf8_lossy(&line)) {
                report(percent);
            }
        }
        if let Some(status) = exited {
            break status;
        }
        let stop = if cancel.load(Ordering::SeqCst) {
            Some(AppError::new(
                "stt_cancelled",
                "Transcription was cancelled. Nothing was saved; the previous transcript is unchanged.",
            ))
        } else if Instant::now() > deadline {
            Some(stt_error(
                "Transcription timed out and was stopped. Nothing was saved.",
            ))
        } else {
            None
        };
        if let Some(error) = stop {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    if cancel.load(Ordering::SeqCst) {
        return Err(cancelled());
    }
    if !status.success() {
        return Err(stt_error(format!("The speech engine failed ({status}).")));
    }
    let json = fs::read(output_base.with_extension("json"))
        .map_err(|_| stt_error("The speech engine produced no output."))?;
    let speaker = if track.kind == "mic" { "You" } else { "Others" };
    parse_output(&json, speaker, track.sample_rate, index)
}

/// Runs one engine process per track inside the transcription run. Nothing is returned on failure
/// or cancellation, so callers never replace an existing transcript with partial output.
fn run_tracks(
    tracks: &[Track],
    cancel: &AtomicBool,
    mut command_for: impl FnMut(&Track, &Path) -> Result<Command>,
    mut report: impl FnMut(&str, u8),
) -> Result<Vec<Segment>> {
    let mut segments = Vec::new();
    for track in tracks {
        let index = audio_timing::read(track, || {
            if cancel.load(Ordering::SeqCst) {
                Err(cancelled())
            } else {
                Ok(())
            }
        })?;
        let scratch = tempfile::tempdir()?;
        let output_base = scratch.path().join("out");
        let command = command_for(track, &output_base)?;
        segments.extend(run_engine(
            command,
            track,
            &index,
            scratch.path(),
            &output_base,
            cancel,
            |percent| report(&track.kind, percent),
        )?);
    }
    let times = |segment: &Segment| match segment.timing {
        SegmentTiming::Timed { start_ms, end_ms } => (start_ms, end_ms),
        SegmentTiming::Untimed => (i64::MAX, i64::MAX),
    };
    segments.sort_by(|a, b| {
        (times(a).0, &a.speaker, times(a).1).cmp(&(times(b).0, &b.speaker, times(b).1))
    });
    if cancel.load(Ordering::SeqCst) {
        return Err(cancelled());
    }
    Ok(segments)
}

/// Transcribes finalized tracks one at a time. Nothing is returned (or saved) on failure.
pub fn transcribe(
    root: &Path,
    tracks: &[Track],
    settings: &Settings,
    cancel: &AtomicBool,
    report: impl FnMut(&str, u8),
) -> Result<Vec<Segment>> {
    if cancel.load(Ordering::SeqCst) {
        return Err(cancelled());
    }
    if !status(root, &settings.stt_model).installed {
        return Err(stt_error(
            "The speech engine and the selected model are not installed. Download them in Settings first.",
        ));
    }
    run_tracks(
        tracks,
        cancel,
        |track, output_base| engine_command(root, settings, track, output_base),
        report,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    use std::sync::Mutex;
    static ENGINE_TESTS: Mutex<()> = Mutex::new(());

    fn block(frame_offset: u64, frames: u64, capture_start_us: u64) -> Block {
        Block {
            frame_offset,
            frames,
            capture_start_us,
            generation: None,
        }
    }

    #[test]
    fn missing_timing_is_rejected_before_creating_a_local_engine_command() {
        let _test = ENGINE_TESTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let track = Track {
            kind: "mic".into(),
            path: dir.path().join("unused.wav").to_string_lossy().into(),
            timing_path: dir.path().join("missing.jsonl").to_string_lossy().into(),
            device_name: "Synthetic".into(),
            sample_rate: 16000,
            channels: 1,
            frames: 16000,
            dropped_frames: 0,
            finalized: true,
            size_bytes: None,
        };
        let result = run_tracks(
            &[track],
            &AtomicBool::new(false),
            |_, _| panic!("Invalid timing reached engine setup"),
            |_, _| {},
        );
        assert_eq!(result.unwrap_err().code, "audio_timing");
    }

    #[test]
    fn a_segment_ending_at_a_pause_does_not_extend_into_the_resumed_audio() {
        let index = [block(0, 16000, 1_000_000), block(16000, 16000, 8_000_000)];
        let output = parse_output(
            br#"{"transcription":[{"offsets":{"from":0,"to":1000},"text":"Before pause"},{"offsets":{"from":1000,"to":1500},"text":"After resume"}]}"#,
            "You", 16000, &index,
        ).unwrap();
        assert_eq!(
            output[0].timing,
            SegmentTiming::Timed {
                start_ms: 1000,
                end_ms: 2000
            }
        );
        assert_eq!(
            output[1].timing,
            SegmentTiming::Timed {
                start_ms: 8000,
                end_ms: 8500
            }
        );
    }

    #[test]
    fn seeking_rejects_damaged_timing_and_clamps_extreme_requested_times() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("timing.jsonl");
        let track = Track {
            kind: "mic".into(),
            path: "unused.wav".into(),
            timing_path: path.to_string_lossy().into(),
            device_name: "Synthetic".into(),
            sample_rate: 16000,
            channels: 1,
            frames: 32000,
            dropped_frames: 0,
            finalized: true,
            size_bytes: None,
        };
        assert_eq!(
            track_file_ms(&track, 8250).unwrap_err().code,
            "audio_timing"
        );
        fs::write(&path, "{\"frame_offset\":0,\"frames\":16000,\"capture_start_us\":1000000}\n{\"frame_offset\":16000,\"frames\":16000,\"capture_start_us\":8000000}\n").unwrap();
        assert_eq!(track_file_ms(&track, 8250).unwrap(), 1250);
        assert_eq!(track_file_ms(&track, 5000).unwrap(), 1000);
        assert_eq!(track_file_ms(&track, i64::MAX).unwrap(), 2000);
        assert_eq!(track_file_ms(&track, i64::MIN).unwrap(), 0);
        fs::write(&path, "{partial").unwrap();
        assert_eq!(
            track_file_ms(&track, 8250).unwrap_err().code,
            "audio_timing"
        );
    }

    #[test]
    fn positions_map_through_the_timing_index_across_pauses() {
        // 16 kHz, one second per block: two contiguous seconds, a six-second pause, one more.
        let index = [
            block(0, 16000, 1_000_000),
            block(16000, 16000, 2_000_000),
            block(32000, 16000, 8_000_000), // resumed after a pause
        ];
        assert_eq!(session_ms(&index, 16000, 0, false), 1000);
        assert_eq!(session_ms(&index, 16000, 750, false), 1750);
        assert_eq!(session_ms(&index, 16000, 1000, false), 2000);
        assert_eq!(session_ms(&index, 16000, 2250, false), 8250);
        // Past the final block clamps to its end instead of extrapolating.
        assert_eq!(session_ms(&index, 16000, 99_000, false), 9000);
        assert_eq!(session_ms(&[], 16000, 1234, false), 1234);
    }

    #[test]
    fn engine_json_becomes_labelled_segments_without_markers_or_blanks() {
        let json = br#"{"transcription":[
            {"offsets":{"from":0,"to":1500},"text":" Hello there. "},
            {"offsets":{"from":1500,"to":2000},"text":" [BLANK_AUDIO]"},
            {"offsets":{"from":2000,"to":2500},"text":" (music) "},
            {"offsets":{"from":2500,"to":2400},"text":"  "},
            {"offsets":{"from":3000,"to":3500},"text":"Bye"}
        ]}"#;
        let segments = parse_output(json, "Others", 16000, &[]).unwrap();
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].text, "Hello there.");
        assert_eq!(segments[0].speaker, "Others");
        assert_eq!(
            segments[1].timing,
            SegmentTiming::Timed {
                start_ms: 3000,
                end_ms: 3500
            }
        );
        assert_eq!(
            parse_output(b"not json", "You", 16000, &[])
                .unwrap_err()
                .code,
            "stt"
        );
    }

    #[test]
    fn engine_extraction_keeps_only_known_files_and_never_escapes_the_folder() {
        use zip::write::SimpleFileOptions;
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("engine.zip");
        {
            let mut writer = zip::ZipWriter::new(File::create(&archive).unwrap());
            let options = SimpleFileOptions::default();
            for name in [
                "Release/whisper-cli.exe",
                "Release/whisper.dll",
                "Release/ggml-cpu-x64.dll",
                "Release/main.exe",
                "../../escape.dll",
                "Release/llama.dll",
            ] {
                writer.start_file(name, options).unwrap();
                writer.write_all(b"x").unwrap();
            }
            writer.finish().unwrap();
        }
        let target = dir.path().join("engine");
        extract_engine(&archive, &target).unwrap();
        let mut names: Vec<_> = fs::read_dir(&target)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(
            names,
            ["ggml-cpu-x64.dll", "whisper-cli.exe", "whisper.dll"]
        );
        assert!(!dir.path().join("escape.dll").exists());
        // An archive without the CLI is rejected rather than half-installed.
        let empty = dir.path().join("empty.zip");
        zip::ZipWriter::new(File::create(&empty).unwrap())
            .finish()
            .unwrap();
        assert!(extract_engine(&empty, &dir.path().join("none")).is_err());
    }

    #[test]
    fn status_requires_matching_marker_and_exact_model_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let small = model("small").unwrap();
        let initial = status(dir.path(), "small");
        assert!(!initial.installed);
        assert_eq!(initial.missing_bytes, ENGINE.size + small.size + VAD.size);
        fs::create_dir_all(engine_dir(dir.path())).unwrap();
        fs::write(engine_dir(dir.path()).join(engine_filename()), b"x").unwrap();
        // Executable alone, with no release marker, is not trusted.
        assert!(!status(dir.path(), "small").engine);
        fs::write(engine_dir(dir.path()).join(ENGINE_MARKER), engine_pin()).unwrap();
        assert!(status(dir.path(), "small").engine);
        fs::create_dir_all(models_dir(dir.path())).unwrap();
        fs::write(models_dir(dir.path()).join(VAD.file), b"short").unwrap();
        assert!(!status(dir.path(), "small").vad);
    }

    fn stored_settings() -> Settings {
        crate::storage::Core::open(Path::new(":memory:"))
            .unwrap()
            .settings()
            .unwrap()
    }

    #[test]
    fn session_times_map_back_to_file_times_across_a_pause() {
        // Same index as above: 0–2 s recorded, paused 3–8 s of session time, 1 s more.
        let index = [
            block(0, 16000, 1_000_000),
            block(16000, 16000, 2_000_000),
            block(32000, 16000, 8_000_000),
        ];
        assert_eq!(file_ms(&index, 16000, 1750), 750);
        assert_eq!(file_ms(&index, 16000, 8250), 2250);
        // Inside the pause gap: the first frame recorded after it.
        assert_eq!(file_ms(&index, 16000, 5000), 2000);
        // Before capture began, and past the end, clamp to the file.
        assert_eq!(file_ms(&index, 16000, 500), 0);
        assert_eq!(file_ms(&index, 16000, 99_000), 3000);
        for audio in [0, 250, 1000, 1999, 2000, 2600, 3000] {
            assert_eq!(
                file_ms(&index, 16000, session_ms(&index, 16000, audio, false)),
                audio
            );
        }
        assert_eq!(file_ms(&[], 16000, 1234), 1234);
        assert_eq!(file_ms(&[], 16000, -5), 0);
    }

    #[test]
    fn engine_arguments_follow_the_transcription_settings() {
        let root = Path::new("stt-root");
        let track = Track {
            kind: "mic".into(),
            path: "mic.wav".into(),
            timing_path: "mic.timing.jsonl".into(),
            device_name: "Synthetic".into(),
            sample_rate: 16000,
            channels: 1,
            frames: 16000,
            dropped_frames: 0,
            finalized: true,
            size_bytes: None,
        };
        let args = |settings: &Settings| -> Vec<String> {
            engine_command(root, settings, &track, Path::new("out"))
                .unwrap()
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect()
        };
        let after = |args: &[String], flag: &str| {
            let at = args.iter().position(|arg| arg == flag).unwrap();
            args[at + 1].clone()
        };
        let defaults = args(&stored_settings());
        assert_eq!(after(&defaults, "-l"), "auto");
        assert!(after(&defaults, "-m").ends_with("ggml-small.bin"));
        assert!(defaults.contains(&"-pp".to_string()));
        assert!(!defaults.contains(&"--prompt".to_string()));
        let mut custom = stored_settings();
        custom.stt_language = "de".into();
        custom.stt_prompt = "Okta, Kubernetes, Priya".into();
        custom.stt_model = "large-v3-turbo".into();
        let custom_args = args(&custom);
        assert_eq!(after(&custom_args, "-l"), "de");
        assert_eq!(after(&custom_args, "--prompt"), "Okta, Kubernetes, Priya");
        assert!(after(&custom_args, "-m").ends_with("ggml-large-v3-turbo.bin"));
        // A tampered setting never reaches the command line.
        custom.stt_language = "de; rm".into();
        assert_eq!(
            engine_command(root, &custom, &track, Path::new("out"))
                .unwrap_err()
                .code,
            "stt_settings"
        );
    }

    #[test]
    fn progress_lines_are_parsed_and_noise_is_ignored() {
        assert_eq!(
            parse_progress("whisper_print_progress_callback: progress =  45%\r\n"),
            Some(45)
        );
        assert_eq!(parse_progress("progress = 100%"), Some(100));
        for noise in [
            "progress = 250%",
            "progress = -1%",
            "whisper_init: loading model",
            "progress = 45",
            "",
        ] {
            assert_eq!(parse_progress(noise), None, "{noise}");
        }
    }

    #[test]
    fn status_reports_each_model_and_unknown_settings_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(models_dir(dir.path())).unwrap();
        let base = model("base").unwrap();
        File::create(models_dir(dir.path()).join(base.file))
            .unwrap()
            .set_len(base.size)
            .unwrap();
        let small = status(dir.path(), "small");
        assert!(!small.model);
        let installed: Vec<_> = small.models.iter().map(|m| (m.id, m.installed)).collect();
        assert_eq!(installed.len(), 33);
        assert!(installed.contains(&("base", true)));
        assert!(installed.contains(&("small", false)));
        assert!(installed.contains(&("tiny-q5_1", false)));
        assert!(status(dir.path(), "base").model);
        assert!(!status(dir.path(), "huge").model);
        assert!(small.languages.contains(&"auto"));
        assert!(validate("auto", "", "small").is_ok());
        assert_eq!(
            validate("xx", "", "small").unwrap_err().code,
            "stt_settings"
        );
        assert_eq!(validate("en", "", "huge").unwrap_err().code, "stt_settings");
        assert_eq!(
            install(dir.path(), "huge", |_| {}).unwrap_err().code,
            "stt_settings"
        );
    }

    #[test]
    fn fake_engine_reports_progress_and_cancel_keeps_the_previous_transcript() {
        let _test = ENGINE_TESTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let json =
            r#"{"transcription":[{"offsets":{"from":0,"to":500},"text":" Fictional words"}]}"#;
        #[cfg(windows)]
        let (script, body) = (
            dir.path().join("fake-engine.cmd"),
            format!(
                "@echo off\r\n\
                 echo whisper_print_progress_callback: progress =  10%% 1>&2\r\n\
                 if \"%~1\"==\"slow\" ping -n 30 127.0.0.1 >nul\r\n\
                 echo whisper_print_progress_callback: progress = 100%% 1>&2\r\n\
                 >\"%~2.json\" echo {json}\r\n"
            ),
        );
        #[cfg(not(windows))]
        let (script, body) = (
            dir.path().join("fake-engine.sh"),
            format!(
                "echo 'whisper_print_progress_callback: progress =  10%' >&2\n\
                 [ \"$1\" = slow ] && sleep 30\n\
                 echo 'whisper_print_progress_callback: progress = 100%' >&2\n\
                 printf '%s' '{json}' > \"$2.json\"\n"
            ),
        );
        fs::write(&script, body).unwrap();
        let fake = move |mode: &'static str| {
            let script = script.clone();
            move |_: &Track, output_base: &Path| -> Result<Command> {
                #[cfg(windows)]
                let mut command = Command::new(&script);
                #[cfg(not(windows))]
                let mut command = {
                    let mut command = Command::new("sh");
                    command.arg(&script);
                    command
                };
                command.arg(mode).arg(output_base);
                Ok(command)
            }
        };
        let track = Track {
            kind: "mic".into(),
            path: "mic.wav".into(),
            timing_path: dir.path().join("timing.jsonl").to_string_lossy().into(),
            device_name: "Synthetic".into(),
            sample_rate: 16000,
            channels: 1,
            frames: 16000,
            dropped_frames: 0,
            finalized: true,
            size_bytes: None,
        };

        fs::write(
            &track.timing_path,
            "{\"frame_offset\":0,\"frames\":16000,\"capture_start_us\":0}\n",
        )
        .unwrap();

        let mut seen = Vec::new();
        let cancel = AtomicBool::new(false);
        let segments = run_tracks(
            std::slice::from_ref(&track),
            &cancel,
            fake("fast"),
            |kind, percent| seen.push((kind.to_string(), percent)),
        )
        .unwrap();
        assert_eq!(seen, [("mic".to_string(), 10), ("mic".to_string(), 100)]);
        assert_eq!(segments.len(), 1);
        assert_eq!(
            (segments[0].speaker.as_str(), segments[0].text.as_str()),
            ("You", "Fictional words")
        );

        let mut core = crate::storage::Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_fixture().unwrap();
        core.replace_transcript(
            &id,
            &[Segment {
                speaker: "Others".into(),
                timing: SegmentTiming::Timed {
                    start_ms: 0,
                    end_ms: 10,
                },
                text: "Earlier run".into(),
            }],
            "whisper",
            "small",
        )
        .unwrap();
        let (progress_tx, progress_rx) = std::sync::mpsc::channel();
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let worker = std::thread::spawn({
            let cancel = cancel.clone();
            let track = track.clone();
            move || {
                run_tracks(&[track], &cancel, fake("slow"), move |_, percent| {
                    let _ = progress_tx.send(percent);
                })
            }
        });
        assert_eq!(
            progress_rx.recv_timeout(Duration::from_secs(20)).unwrap(),
            10
        );
        let cancelled_at = Instant::now();
        cancel.store(true, Ordering::SeqCst);
        let result = worker.join().unwrap();
        assert!(
            cancelled_at.elapsed() < Duration::from_secs(10),
            "the engine was killed"
        );
        // Same order as `transcribe_meeting`: the transcript is replaced only on success.
        let saved =
            result.and_then(|segments| core.replace_transcript(&id, &segments, "whisper", "small"));
        assert_eq!(saved.unwrap_err().code, "stt_cancelled");
        assert!(progress_rx.try_iter().all(|percent| percent != 100));
        let texts: Vec<_> = core
            .get_meeting(&id)
            .unwrap()
            .segments
            .into_iter()
            .map(|segment| segment.text)
            .collect();
        assert!(texts.contains(&"Earlier run".to_string()));
        assert_eq!(texts.len(), 3, "two fixture segments plus the earlier run");
    }
}
