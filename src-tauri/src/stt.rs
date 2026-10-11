//! Local speech-to-text through a pinned whisper.cpp release.
//!
//! The engine and models are downloaded only on an explicit user action, size-capped and
//! SHA-256 verified, then run as a local subprocess. No audio leaves the device. Silero VAD
//! gates every track so silence is not "transcribed" into hallucinated text.
use crate::{
    audio::Track,
    domain::{AppError, Result, Segment},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, TryLockError},
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
// Multilingual "small": SHA-1 matches the whisper.cpp README; SHA-256 matches Hugging Face's LFS digest.
const MODEL: Artifact = Artifact {
    name: "model",
    file: "ggml-small.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    size: 487_601_967,
};
const VAD: Artifact = Artifact {
    name: "vad",
    file: "ggml-silero-v5.1.2.bin",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
    sha256: "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
    size: 885_098,
};
const ENGINE_EXE: &str = "whisper-cli.exe";
const ENGINE_MARKER: &str = ".release";

#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub engine: bool,
    pub model: bool,
    pub vad: bool,
    pub installed: bool,
    pub missing_bytes: u64,
    pub supported: bool,
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

pub fn status(root: &Path) -> Status {
    let engine = engine_dir(root).join(ENGINE_EXE).is_file()
        && fs::read_to_string(engine_dir(root).join(ENGINE_MARKER))
            .is_ok_and(|marker| marker.trim() == ENGINE.sha256);
    let present = |artifact: &Artifact| {
        fs::metadata(models_dir(root).join(artifact.file)).is_ok_and(|m| m.len() == artifact.size)
    };
    let (model, vad) = (present(&MODEL), present(&VAD));
    let missing = [(engine, ENGINE.size), (model, MODEL.size), (vad, VAD.size)]
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
        supported: cfg!(all(target_os = "windows", target_arch = "x86_64")),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn stt_error(message: impl Into<String>) -> AppError {
    AppError::new("stt", message)
}

fn download(
    client: &reqwest::blocking::Client,
    artifact: &Artifact,
    destination: &Path,
    mut progress: impl FnMut(u64),
) -> Result<()> {
    let part = destination.with_extension("part");
    let fail = |message: &str| {
        let _ = fs::remove_file(&part);
        stt_error(message.to_string())
    };
    let mut response = client.get(artifact.url).send().map_err(|_| {
        fail("Could not reach the download server. Check your connection and try again.")
    })?;
    if !response.status().is_success() {
        return Err(fail(&format!(
            "The download server returned HTTP {}.",
            response.status()
        )));
    }
    let mut file = File::create(&part)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut done = 0_u64;
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|_| fail("The download was interrupted. Partial data was discarded."))?;
        if read == 0 {
            break;
        }
        done += read as u64;
        if done > artifact.size {
            return Err(fail(
                "The download was larger than expected and was discarded.",
            ));
        }
        hasher.update(&buffer[..read]);
        file.write_all(&buffer[..read])
            .map_err(|_| fail("Could not write the download. Check free disk space."))?;
        progress(done);
    }
    file.flush()?;
    drop(file);
    if done != artifact.size || hex(&hasher.finalize()) != artifact.sha256 {
        return Err(fail(
            "The download failed its checksum and was discarded. Nothing was installed.",
        ));
    }
    fs::rename(&part, destination)?;
    Ok(())
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

/// Downloads whatever is missing. Each artifact is verified before it is installed.
pub fn install(root: &Path, mut report: impl FnMut(Progress)) -> Result<Status> {
    if !status(root).supported {
        return Err(stt_error(
            "Local speech-to-text is only set up for Windows x64 in this preview.",
        ));
    }
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.url().scheme() == "https" && attempt.previous().len() < 5 {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(3600))
        .build()
        .map_err(|_| stt_error("Could not prepare the download client."))?;
    fs::create_dir_all(models_dir(root))?;
    let before = status(root);
    let pending = [
        (before.engine, &ENGINE),
        (before.vad, &VAD),
        (before.model, &MODEL),
    ];
    for (present, artifact) in pending {
        if present {
            continue;
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
            let extracted = extract_engine(&destination, &engine_dir(root));
            let _ = fs::remove_file(&destination);
            extracted?;
            fs::write(engine_dir(root).join(ENGINE_MARKER), ENGINE.sha256)?;
        }
    }
    Ok(status(root))
}

#[derive(Deserialize)]
struct Block {
    frame_offset: i64,
    frames: i64,
    capture_start_us: i64,
}

fn read_index(path: &Path) -> Vec<Block> {
    // Malformed trailing lines (a partial file after a crash) are skipped, not fatal.
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// Maps a position in the WAV to the session timeline, honouring pause gaps.
fn session_ms(index: &[Block], rate: u32, audio_ms: i64) -> i64 {
    if index.is_empty() || rate == 0 {
        return audio_ms;
    }
    let rate = i64::from(rate);
    let frame = audio_ms * rate / 1000;
    let at = index
        .partition_point(|block| block.frame_offset <= frame)
        .saturating_sub(1);
    let block = &index[at];
    let within = (frame - block.frame_offset).clamp(0, block.frames);
    (block.capture_start_us + within * 1_000_000 / rate) / 1000
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
        let start = session_ms(index, rate, item.offsets.from.max(0));
        let end = session_ms(index, rate, item.offsets.to.max(item.offsets.from));
        segments.push(Segment {
            speaker: speaker.to_string(),
            start_ms: start,
            end_ms: end.max(start),
            text: text.to_string(),
        });
    }
    Ok(segments)
}

// Held for the whole run so only one transcription uses the CPU at a time.
static BUSY: Mutex<()> = Mutex::new(());

fn run_engine(root: &Path, track: &Track) -> Result<Vec<Segment>> {
    let scratch = tempfile::tempdir()?;
    let output_base = scratch.path().join("out");
    let log_path = scratch.path().join("engine.log");
    let threads = std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .min(8);
    let mut command = Command::new(engine_dir(root).join(ENGINE_EXE));
    command
        .current_dir(engine_dir(root))
        .arg("-m")
        .arg(models_dir(root).join(MODEL.file))
        .arg("--vad")
        .arg("-vm")
        .arg(models_dir(root).join(VAD.file))
        .arg("-f")
        .arg(&track.path)
        .arg("-oj")
        .arg("-of")
        .arg(&output_base)
        .args(["-l", "auto", "-np", "-sns", "-t"])
        .arg(threads.to_string())
        .stdin(Stdio::null())
        // Transcript text is printed to stdout; it is parsed from the JSON file instead.
        .stdout(Stdio::null())
        .stderr(File::create(&log_path)?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .map_err(|_| stt_error("The speech engine could not be started."))?;
    // Generous bound: 4x the audio length plus two minutes.
    let audio_secs = (track.frames.max(0) as u64) / u64::from(track.sample_rate.max(1));
    let deadline = Instant::now() + Duration::from_secs(120 + 4 * audio_secs);
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| stt_error("The speech engine stopped unexpectedly."))?
        {
            break status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(stt_error(
                "Transcription timed out and was stopped. Nothing was saved.",
            ));
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    if !status.success() {
        let tail: String = fs::read_to_string(&log_path)
            .unwrap_or_default()
            .lines()
            .rev()
            .take(2)
            .collect::<Vec<_>>()
            .join(" | ");
        return Err(stt_error(format!(
            "The speech engine failed ({status}). {}",
            tail.chars().take(200).collect::<String>()
        )));
    }
    let json = fs::read(output_base.with_extension("json"))
        .map_err(|_| stt_error("The speech engine produced no output."))?;
    let speaker = if track.kind == "mic" { "You" } else { "Others" };
    parse_output(
        &json,
        speaker,
        track.sample_rate,
        &read_index(Path::new(&track.timing_path)),
    )
}

/// Transcribes finalized tracks one at a time. Nothing is returned (or saved) on failure.
pub fn transcribe(root: &Path, tracks: &[Track]) -> Result<Vec<Segment>> {
    if !status(root).installed {
        return Err(stt_error(
            "The speech engine and models are not installed. Download them in Settings first.",
        ));
    }
    let _guard = match BUSY.try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(TryLockError::WouldBlock) => {
            return Err(stt_error(
                "A transcription is already running. Wait for it to finish.",
            ))
        }
    };
    let mut segments = Vec::new();
    for track in tracks {
        segments.extend(run_engine(root, track)?);
    }
    segments.sort_by(|a, b| {
        (a.start_ms, &a.speaker, a.end_ms).cmp(&(b.start_ms, &b.speaker, b.end_ms))
    });
    Ok(segments)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(frame_offset: i64, frames: i64, capture_start_us: i64) -> Block {
        Block {
            frame_offset,
            frames,
            capture_start_us,
        }
    }

    #[test]
    fn positions_map_through_the_timing_index_across_pauses() {
        // 16 kHz, one second per block: two contiguous seconds, a six-second pause, one more.
        let index = [
            block(0, 16000, 1_000_000),
            block(16000, 16000, 2_000_000),
            block(32000, 16000, 8_000_000), // resumed after a pause
        ];
        assert_eq!(session_ms(&index, 16000, 0), 1000);
        assert_eq!(session_ms(&index, 16000, 750), 1750);
        assert_eq!(session_ms(&index, 16000, 1000), 2000);
        assert_eq!(session_ms(&index, 16000, 2250), 8250);
        // Past the final block clamps to its end instead of extrapolating.
        assert_eq!(session_ms(&index, 16000, 99_000), 9000);
        assert_eq!(session_ms(&[], 16000, 1234), 1234);
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
        assert_eq!((segments[1].start_ms, segments[1].end_ms), (3000, 3500));
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
        let initial = status(dir.path());
        assert!(!initial.installed);
        assert_eq!(initial.missing_bytes, ENGINE.size + MODEL.size + VAD.size);
        fs::create_dir_all(engine_dir(dir.path())).unwrap();
        fs::write(engine_dir(dir.path()).join(ENGINE_EXE), b"x").unwrap();
        // Executable alone, with no release marker, is not trusted.
        assert!(!status(dir.path()).engine);
        fs::write(engine_dir(dir.path()).join(ENGINE_MARKER), ENGINE.sha256).unwrap();
        assert!(status(dir.path()).engine);
        fs::create_dir_all(models_dir(dir.path())).unwrap();
        fs::write(models_dir(dir.path()).join(VAD.file), b"short").unwrap();
        assert!(!status(dir.path()).vad);
    }
}
