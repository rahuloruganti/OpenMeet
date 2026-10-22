//! Second local speech engine: the sherpa-onnx VAD + offline ASR command (Windows x64) with
//! pinned Parakeet, Moonshine and SenseVoice models. Their ids start with `sherpa:`.
use super::{download, stt_error, Artifact, Block, Progress};
use crate::{
    domain::{Result, Segment, SegmentTiming, Settings},
    model_library::check_cancel,
};
use std::{
    ffi::OsString,
    fs::{self, File},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

pub(super) const PREFIX: &str = "sherpa:";
const MARKER: &str = ".release";
const EXE: &str = "sherpa-onnx-vad-with-offline-asr.exe";

// sherpa-onnx v1.13.8, statically linked runtime, no TTS (GitHub asset digests).
const ENGINE: Artifact = Artifact {
    name: "engine",
    file: "sherpa-onnx-v1.13.8-win-x64-shared-MT-Release-no-tts.tar.bz2",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-win-x64-shared-MT-Release-no-tts.tar.bz2",
    sha256: "4b0a94f7b5c606b1b64a19a831c2127559e4b3d34e195465ebc7be73d9ed4783",
    size: 23_271_851,
};
const ENGINE_FILES: [&str; 3] = [EXE, "onnxruntime.dll", "onnxruntime_providers_shared.dll"];
const VAD: Artifact = Artifact {
    name: "vad",
    file: "silero_vad.onnx",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
    sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
    size: 643_854,
};

pub(super) struct Model {
    pub(super) id: &'static str,
    archive: Artifact,
    files: &'static [&'static str],
    /// Model flags for the command, given the model folder and the spoken-language setting.
    args: fn(&Path, &str) -> Vec<OsString>,
}

fn flag(name: &str, value: impl AsRef<std::ffi::OsStr>) -> OsString {
    let mut arg = OsString::from(format!("--{name}="));
    arg.push(value);
    arg
}

pub(super) const MODELS: [Model; 3] = [
    Model {
        id: "sherpa:parakeet-v3",
        archive: Artifact {
            name: "model",
            file: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
            url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
            sha256: "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf",
            size: 487_170_055,
        },
        files: &["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
        args: |dir, _| {
            vec![
                flag("encoder", dir.join("encoder.int8.onnx")),
                flag("decoder", dir.join("decoder.int8.onnx")),
                flag("joiner", dir.join("joiner.int8.onnx")),
                flag("tokens", dir.join("tokens.txt")),
                flag("model-type", "nemo_transducer"),
            ]
        },
    },
    Model {
        id: "sherpa:moonshine-base-en",
        archive: Artifact {
            name: "model",
            file: "sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2",
            url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2",
            sha256: "43232c1d13013d37317163baec3135bd771a186a4356f28c889bab453bb0e891",
            size: 111_266_225,
        },
        files: &["encoder_model.ort", "decoder_model_merged.ort", "tokens.txt"],
        args: |dir, _| {
            vec![
                flag("moonshine-encoder", dir.join("encoder_model.ort")),
                flag("moonshine-merged-decoder", dir.join("decoder_model_merged.ort")),
                flag("tokens", dir.join("tokens.txt")),
            ]
        },
    },
    Model {
        id: "sherpa:sense-voice",
        archive: Artifact {
            name: "model",
            file: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2",
            url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2",
            sha256: "7305f7905bfcf77fa0b39388a313f3da35c68d971661a65475b56fb2162c8e63",
            size: 165_783_878,
        },
        files: &["model.int8.onnx", "tokens.txt"],
        args: |dir, language| {
            let language = if ["zh", "en", "ja", "ko", "yue"].contains(&language) {
                language
            } else {
                "auto"
            };
            vec![
                flag("sense-voice-model", dir.join("model.int8.onnx")),
                flag("tokens", dir.join("tokens.txt")),
                flag("sense-voice-language", language),
                flag("sense-voice-use-itn", "1"),
            ]
        },
    },
];

pub(super) fn model(id: &str) -> Option<&'static Model> {
    MODELS.iter().find(|model| model.id == id)
}

/// Bytes a model needs in total: the shared engine and VAD plus its own archive.
pub(super) fn total_size(model: &Model) -> u64 {
    ENGINE.size + VAD.size + model.archive.size
}

pub(super) fn supported() -> bool {
    cfg!(all(target_os = "windows", target_arch = "x86_64"))
}

fn folder(root: &Path) -> PathBuf {
    root.join("sherpa")
}
fn engine_dir(root: &Path) -> PathBuf {
    folder(root).join("engine")
}
fn model_dir(root: &Path, model: &Model) -> PathBuf {
    folder(root).join(model.id.trim_start_matches(PREFIX))
}

/// A folder holds a pinned archive's files only after extraction finished and wrote the marker.
fn complete(dir: &Path, artifact: &Artifact, files: &[&str]) -> bool {
    fs::read_to_string(dir.join(MARKER)).is_ok_and(|marker| marker.trim() == artifact.sha256)
        && files.iter().all(|file| dir.join(file).is_file())
}

pub(super) struct Installed {
    pub(super) engine: bool,
    pub(super) model: bool,
    pub(super) vad: bool,
    pub(super) missing_bytes: u64,
}

pub(super) fn installed(root: &Path, model: &Model) -> Installed {
    let engine = complete(&engine_dir(root), &ENGINE, &ENGINE_FILES);
    let model_ready = complete(&model_dir(root, model), &model.archive, model.files);
    let vad = fs::metadata(folder(root).join(VAD.file)).is_ok_and(|m| m.len() == VAD.size);
    let missing_bytes = [
        (engine, ENGINE.size),
        (model_ready, model.archive.size),
        (vad, VAD.size),
    ]
    .iter()
    .filter(|(have, _)| !have)
    .map(|(_, size)| size)
    .sum();
    Installed {
        engine,
        model: model_ready,
        vad,
        missing_bytes,
    }
}

/// Copies the wanted files out of a `.tar.bz2` by basename, so archive paths never choose
/// where a file lands. Fails, leaving no marker, unless every wanted file was found.
fn extract(archive: &Path, destination: &Path, wanted: &[&str]) -> Result<()> {
    let invalid = || stt_error("A downloaded speech archive could not be read.");
    fs::create_dir_all(destination)?;
    let mut tar = tar::Archive::new(bzip2::read::BzDecoder::new(File::open(archive)?));
    let mut found = Vec::new();
    for entry in tar.entries().map_err(|_| invalid())? {
        check_cancel()?;
        let mut entry = entry.map_err(|_| invalid())?;
        let path = entry.path().map_err(|_| invalid())?.into_owned();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        // The engine archive has the same DLLs under bin/ and lib/; the executable needs bin/.
        let in_bin = path.components().any(|part| part.as_os_str() == "bin");
        if !wanted.contains(&name)
            || found.iter().any(|seen| seen == name)
            || !entry.header().entry_type().is_file()
            || entry.size() > 2 * 1024 * 1024 * 1024
            || (name.ends_with(".dll") && !in_bin)
        {
            continue;
        }
        let name = name.to_string();
        let temporary = destination.join(format!("{name}.tmp"));
        std::io::copy(&mut entry, &mut File::create(&temporary)?)?;
        fs::rename(&temporary, destination.join(&name))?;
        found.push(name);
    }
    if wanted
        .iter()
        .any(|name| !found.iter().any(|seen| seen == name))
    {
        return Err(stt_error(
            "A downloaded speech archive did not contain the expected files.",
        ));
    }
    Ok(())
}

/// Downloads and verifies what the model still needs, then unpacks archives into place.
pub(super) fn install(
    root: &Path,
    model: &Model,
    client: &reqwest::blocking::Client,
    report: &mut impl FnMut(Progress),
) -> Result<()> {
    fs::create_dir_all(folder(root))?;
    let before = installed(root, model);
    let unpack = [
        (before.engine, &ENGINE, engine_dir(root), &ENGINE_FILES[..]),
        (
            before.model,
            &model.archive,
            model_dir(root, model),
            model.files,
        ),
    ];
    if !before.vad {
        check_cancel()?;
        download(client, &VAD, &folder(root).join(VAD.file), |downloaded| {
            report(Progress {
                stage: VAD.name,
                downloaded,
                total: VAD.size,
            })
        })?;
    }
    for (present, artifact, destination, files) in unpack {
        check_cancel()?;
        if present {
            continue;
        }
        let archive = folder(root).join(artifact.file);
        download(client, artifact, &archive, |downloaded| {
            report(Progress {
                stage: artifact.name,
                downloaded,
                total: artifact.size,
            })
        })?;
        let _ = fs::remove_file(destination.join(MARKER));
        let extracted = extract(&archive, &destination, files);
        let _ = fs::remove_file(&archive);
        extracted?;
        fs::write(destination.join(MARKER), artifact.sha256)?;
    }
    Ok(())
}

/// The engine reads plain PCM only, so each track is copied as 16-bit mono at its own rate
/// (frame positions, and so timing, are unchanged).
fn mono_pcm16(source: &Path, destination: &Path, cancel: &AtomicBool) -> Result<()> {
    let unreadable = || stt_error("A recording could not be read for transcription.");
    let mut reader = hound::WavReader::open(source).map_err(|_| unreadable())?;
    let spec = reader.spec();
    let channels = usize::from(spec.channels.max(1));
    let mut writer = hound::WavWriter::create(
        destination,
        hound::WavSpec {
            channels: 1,
            sample_rate: spec.sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .map_err(|_| unreadable())?;
    let scale = match spec.sample_format {
        hound::SampleFormat::Float => 1.0,
        hound::SampleFormat::Int => 1.0 / (1_i64 << (spec.bits_per_sample - 1)) as f32,
    };
    let mut frame = Vec::with_capacity(channels);
    let samples: Box<dyn Iterator<Item = std::result::Result<f32, hound::Error>>> =
        match spec.sample_format {
            hound::SampleFormat::Float => Box::new(reader.samples::<f32>()),
            hound::SampleFormat::Int => Box::new(
                reader
                    .samples::<i32>()
                    .map(|sample| sample.map(|v| v as f32)),
            ),
        };
    for (index, sample) in samples.enumerate() {
        if index % (1 << 20) == 0 && cancel.load(Ordering::SeqCst) {
            return Err(super::cancelled());
        }
        frame.push(sample.map_err(|_| unreadable())? * scale);
        if frame.len() == channels {
            let mixed = frame.iter().sum::<f32>() / channels as f32;
            writer
                .write_sample((mixed.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16)
                .map_err(|_| unreadable())?;
            frame.clear();
        }
    }
    writer.finalize().map_err(|_| unreadable())
}

/// Builds the command for one track; `output_base` is in the run's scratch folder.
pub(super) fn command(
    root: &Path,
    settings: &Settings,
    track: &crate::audio::Track,
    output_base: &Path,
    cancel: &AtomicBool,
) -> Result<std::process::Command> {
    let model = model(&settings.stt_model)
        .ok_or_else(|| stt_error("Choose one of the listed speech models."))?;
    let wav = output_base.with_extension("wav");
    mono_pcm16(Path::new(&track.path), &wav, cancel)?;
    let threads = std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .min(8);
    let mut command = std::process::Command::new(engine_dir(root).join(EXE));
    command
        .current_dir(engine_dir(root))
        .arg(flag("silero-vad-model", folder(root).join(VAD.file)))
        .args((model.args)(
            &model_dir(root, model),
            &settings.stt_language,
        ))
        .arg(flag("num-threads", threads.to_string()))
        .arg(&wav);
    Ok(command)
}

/// One `start -- end: text` line per voiced segment, in seconds of the track file.
fn line_times(line: &str) -> Option<(f64, f64, &str)> {
    let (times, text) = line.split_once(": ")?;
    let (start, end) = times.split_once(" -- ")?;
    Some((
        start.trim().parse().ok()?,
        end.trim().parse().ok()?,
        text.trim(),
    ))
}

/// Progress from the end of the last finished segment, in percent of the track.
pub(super) fn progress(output: &[u8], seconds: f64) -> Option<u8> {
    let text = String::from_utf8_lossy(output);
    let (_, end, _) = text.lines().filter_map(line_times).next_back()?;
    (seconds > 0.0).then(|| ((end / seconds) * 100.0).clamp(0.0, 100.0) as u8)
}

pub(super) fn parse(output: &[u8], speaker: &str, rate: u32, index: &[Block]) -> Vec<Segment> {
    String::from_utf8_lossy(output)
        .lines()
        .filter_map(line_times)
        .filter(|(_, _, text)| !text.is_empty())
        .map(|(start, end, text)| {
            // Rounded: 0.512 * 1000 is not exactly 512 in binary floating point.
            let start_ms = super::session_ms(index, rate, (start * 1000.0).round() as i64, false);
            let end_ms = super::session_ms(index, rate, (end * 1000.0).round() as i64, true);
            Segment {
                speaker: speaker.to_string(),
                timing: SegmentTiming::Timed {
                    start_ms,
                    end_ms: end_ms.max(start_ms),
                },
                text: text.to_string(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_lines_become_timed_segments_and_progress() {
        let index = [Block {
            frame_offset: 0,
            frames: 16000 * 20,
            capture_start_us: 5_000_000,
            generation: Some(1),
        }];
        let output = b"0.512 -- 2.304: Hello there\n3.000 -- 3.100: \nnoise line\n10.000 -- 12.500: Budget is approved\n";
        let segments = parse(output, "Others", 16000, &index);
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[1].text, "Budget is approved");
        assert!(matches!(
            segments[0].timing,
            SegmentTiming::Timed {
                start_ms: 5512,
                end_ms: 7304
            }
        ));
        assert_eq!(progress(output, 25.0), Some(50));
        assert_eq!(progress(b"Started\n", 25.0), None);
    }

    #[test]
    fn tracks_are_copied_as_mono_pcm16_with_the_same_frames() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("system.wav");
        let mut writer = hound::WavWriter::create(
            &source,
            hound::WavSpec {
                channels: 2,
                sample_rate: 48000,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            },
        )
        .unwrap();
        for _ in 0..480 {
            writer.write_sample(0.5_f32).unwrap();
            writer.write_sample(-0.25_f32).unwrap();
        }
        writer.finalize().unwrap();
        let copy = dir.path().join("mono.wav");
        mono_pcm16(&source, &copy, &AtomicBool::new(false)).unwrap();
        let reader = hound::WavReader::open(&copy).unwrap();
        assert_eq!(
            (
                reader.spec().channels,
                reader.spec().bits_per_sample,
                reader.duration()
            ),
            (1, 16, 480)
        );
        let first: i16 = hound::WavReader::open(&copy)
            .unwrap()
            .samples::<i16>()
            .next()
            .unwrap()
            .unwrap();
        assert_eq!(first, (0.125 * f32::from(i16::MAX)) as i16);
    }

    #[test]
    fn archives_yield_only_wanted_files_by_basename() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("model.tar.bz2");
        {
            let encoder = bzip2::write::BzEncoder::new(
                File::create(&archive).unwrap(),
                bzip2::Compression::fast(),
            );
            let mut tar = tar::Builder::new(encoder);
            for (path, body) in [
                ("pack/tokens.txt", &b"a 1"[..]),
                ("pack/test_wavs/0.wav", &b"RIFF"[..]),
                ("pack/lib/onnxruntime.dll", &b"lib"[..]),
                ("pack/bin/onnxruntime.dll", &b"bin"[..]),
            ] {
                let mut header = tar::Header::new_gnu();
                header.set_size(body.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                tar.append_data(&mut header, path, body).unwrap();
            }
            tar.into_inner().unwrap().finish().unwrap();
        }
        let out = dir.path().join("out");
        extract(&archive, &out, &["tokens.txt", "onnxruntime.dll"]).unwrap();
        assert_eq!(fs::read(out.join("onnxruntime.dll")).unwrap(), b"bin");
        assert!(out.join("tokens.txt").is_file() && !out.join("0.wav").exists());
        assert!(extract(&archive, &dir.path().join("x"), &["missing.onnx"]).is_err());
    }
}
