//! Bounded cloud transcription of frozen WAV chunks, with honest optional timestamps.
use crate::{
    audio::Track,
    audio_timing::{self, Block, CLOCK_TOLERANCE_US},
    domain::{hex, sha256_hex, AppError, Result, Segment, SegmentTiming},
    providers::{check_status, client, read_capped, Connection},
};
use reqwest::blocking::multipart::{Form, Part};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufReader, Read},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

const MAX_CHUNK_BYTES: u64 = 16 * 1024 * 1024;
const MAX_REQUESTS: usize = 200;
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
const WAV_HEADER_BYTES: u64 = 44;

struct Chunk {
    path: PathBuf,
    start: u64,
    frames: u64,
    bytes: u64,
    digest: [u8; 32],
}
struct PreparedTrack {
    kind: String,
    rate: u32,
    index: Vec<Block>,
    chunks: Vec<Chunk>,
}

pub struct CloudPlan {
    pub bytes: u64,
    pub requests: usize,
    pub tracks: Vec<String>,
    fingerprint: String,
    input: Vec<u8>,
    prepared: Vec<PreparedTrack>,
    _scratch: tempfile::TempDir,
}

impl CloudPlan {
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
}

fn error(message: &str) -> AppError {
    AppError::new("cloud_stt", message)
}
fn changed() -> AppError {
    error("The audio or chunk plan changed. Review and confirm transcription again; nothing was sent.")
}
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(AppError::new("stt_cancelled", "Transcription was cancelled. The previous transcript is unchanged. Audio already uploaded cannot be recalled."))
    } else {
        Ok(())
    }
}
fn audio_error(_: impl std::fmt::Display) -> AppError {
    error("Recorded audio could not be read or prepared. Originals and the previous transcript are unchanged.")
}

fn chunk_ranges(index: &[Block], rate: u32, channels: u16, cap: u64) -> Vec<(u64, u64)> {
    let frames_per_chunk = ((cap - WAV_HEADER_BYTES) / (u64::from(channels) * 2))
        .min(u64::from(rate) * 300)
        .max(1);
    let mut ranges = Vec::new();
    let mut start = 0;
    let mut length = 0;
    for (position, block) in index.iter().enumerate() {
        if let Some(previous) = position.checked_sub(1).map(|i| &index[i]) {
            let end = previous.capture_start_us + previous.frames * 1_000_000 / u64::from(rate);
            let gap = block.capture_start_us.saturating_sub(end);
            if length > 0 && (previous.generation != block.generation || gap > CLOCK_TOLERANCE_US) {
                ranges.push((start, length));
                start += length;
                length = 0;
            }
        }
        let mut remaining = block.frames;
        while remaining > 0 {
            let take = remaining.min(frames_per_chunk - length);
            length += take;
            remaining -= take;
            if length == frames_per_chunk {
                ranges.push((start, length));
                start += length;
                length = 0;
            }
        }
    }
    if length > 0 {
        ranges.push((start, length));
    }
    ranges
}

fn file_digest(path: &Path, cancel: &AtomicBool) -> Result<[u8; 32]> {
    let mut file = File::open(path).map_err(audio_error)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        cancelled(cancel)?;
        let count = file.read(&mut buffer).map_err(audio_error)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hash.finalize().into())
}

fn copy_samples(
    reader: &mut hound::WavReader<BufReader<File>>,
    writer: &mut hound::WavWriter<std::io::BufWriter<File>>,
    count: u64,
    cancel: &AtomicBool,
) -> Result<()> {
    let spec = reader.spec();
    let mut write = |sample: f64| -> Result<()> {
        if !sample.is_finite() {
            return Err(error(
                "The audio contains invalid samples. Nothing was sent.",
            ));
        }
        writer
            .write_sample((sample.clamp(-1.0, 1.0) * 32767.0).round() as i16)
            .map_err(audio_error)
    };
    match spec.sample_format {
        hound::SampleFormat::Float => {
            let mut samples = reader.samples::<f32>();
            for index in 0..count {
                if index.is_multiple_of(2048) {
                    cancelled(cancel)?;
                }
                let sample = samples
                    .next()
                    .ok_or_else(|| audio_error("short WAV"))?
                    .map_err(audio_error)?;
                write(f64::from(sample))?;
            }
        }
        hound::SampleFormat::Int => {
            let scale = (1_u64 << (spec.bits_per_sample - 1)) as f64;
            let mut samples = reader.samples::<i32>();
            for index in 0..count {
                if index.is_multiple_of(2048) {
                    cancelled(cancel)?;
                }
                let sample = samples
                    .next()
                    .ok_or_else(|| audio_error("short WAV"))?
                    .map_err(audio_error)?;
                write(f64::from(sample) / scale)?;
            }
        }
    }
    Ok(())
}

pub fn plan(tracks: &[Track]) -> Result<CloudPlan> {
    prepare(tracks, MAX_CHUNK_BYTES, &AtomicBool::new(false))
}

pub fn plan_cancellable(tracks: &[Track], cancel: &AtomicBool) -> Result<CloudPlan> {
    prepare(tracks, MAX_CHUNK_BYTES, cancel)
}

fn prepare(tracks: &[Track], cap: u64, cancel: &AtomicBool) -> Result<CloudPlan> {
    cancelled(cancel)?;
    if tracks.is_empty() || tracks.len() > 2 || cap <= WAV_HEADER_BYTES + 64 {
        return Err(error(
            "Choose a meeting with finalized microphone or system audio.",
        ));
    }
    let input = serde_json::to_vec(tracks).map_err(|_| audio_error("track metadata"))?;
    let mut fingerprint = Sha256::new();
    fingerprint.update(&input);
    let scratch = tempfile::tempdir().map_err(audio_error)?;
    let mut prepared = Vec::new();
    let mut requests = 0;
    let mut bytes = 0_u64;
    let mut kinds = Vec::new();
    for (track_number, track) in tracks.iter().enumerate() {
        cancelled(cancel)?;
        if !track.finalized
            || track.frames <= 0
            || track.sample_rate == 0
            || track.channels == 0
            || !matches!(track.kind.as_str(), "mic" | "system")
            || kinds.contains(&track.kind)
        {
            return Err(error(
                "The selected audio tracks are invalid or incomplete. Nothing was sent.",
            ));
        }
        let metadata = fs::metadata(&track.path).map_err(audio_error)?;
        let mut reader = hound::WavReader::open(&track.path).map_err(audio_error)?;
        let spec = reader.spec();
        if spec.sample_rate != track.sample_rate
            || spec.channels != track.channels
            || u64::from(reader.duration()) != track.frames as u64
            || !matches!(
                (spec.sample_format, spec.bits_per_sample),
                (hound::SampleFormat::Float, 32) | (hound::SampleFormat::Int, 8 | 16 | 24 | 32)
            )
        {
            return Err(error(
                "The WAV format does not match the recording metadata. Nothing was sent.",
            ));
        }
        let index = audio_timing::read(track, || cancelled(cancel))?;
        fingerprint.update(serde_json::to_vec(&index).map_err(|_| audio_error("index"))?);
        let ranges = chunk_ranges(&index, track.sample_rate, track.channels, cap);
        requests += ranges.len();
        if requests > MAX_REQUESTS {
            return Err(error(
                "This recording would require more than 200 cloud requests. Nothing was sent.",
            ));
        }
        let mut chunks = Vec::new();
        for (chunk_number, (start, frames)) in ranges.into_iter().enumerate() {
            cancelled(cancel)?;
            let path = scratch
                .path()
                .join(format!("{track_number}-{chunk_number}.wav"));
            let mut writer = hound::WavWriter::create(
                &path,
                hound::WavSpec {
                    channels: spec.channels,
                    sample_rate: spec.sample_rate,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                },
            )
            .map_err(audio_error)?;
            copy_samples(
                &mut reader,
                &mut writer,
                frames * u64::from(spec.channels),
                cancel,
            )?;
            writer.finalize().map_err(audio_error)?;
            let size = fs::metadata(&path).map_err(audio_error)?.len();
            if size > cap {
                return Err(error(
                    "An audio chunk exceeded the upload size limit. Nothing was sent.",
                ));
            }
            let digest = file_digest(&path, cancel)?;
            fingerprint.update(start.to_le_bytes());
            fingerprint.update(frames.to_le_bytes());
            fingerprint.update(digest);
            bytes = bytes
                .checked_add(size)
                .ok_or_else(|| audio_error("audio size"))?;
            chunks.push(Chunk {
                path,
                start,
                frames,
                bytes: size,
                digest,
            });
        }
        let after = fs::metadata(&track.path).map_err(audio_error)?;
        if after.len() != metadata.len() || after.modified().ok() != metadata.modified().ok() {
            return Err(changed());
        }
        kinds.push(track.kind.clone());
        prepared.push(PreparedTrack {
            kind: track.kind.clone(),
            rate: track.sample_rate,
            index,
            chunks,
        });
    }
    cancelled(cancel)?;
    Ok(CloudPlan {
        bytes,
        requests,
        tracks: kinds,
        fingerprint: hex(&fingerprint.finalize()),
        input,
        prepared,
        _scratch: scratch,
    })
}

#[derive(Deserialize)]
struct Response {
    text: String,
    segments: Option<Vec<ResponseSegment>>,
}
#[derive(Deserialize)]
struct ResponseSegment {
    start: f64,
    end: f64,
    text: String,
}

fn session_ms(track: &PreparedTrack, frame: u64, end: bool) -> Result<i64> {
    let at = track
        .index
        .partition_point(|block| {
            if end {
                block.frame_offset < frame
            } else {
                block.frame_offset <= frame
            }
        })
        .saturating_sub(1);
    let block = &track.index[at];
    let within = frame.saturating_sub(block.frame_offset).min(block.frames);
    let us = block.capture_start_us + within * 1_000_000 / u64::from(track.rate);
    i64::try_from(us / 1000).map_err(|_| error("The transcription timestamp is out of range."))
}

fn parse_response(bytes: &[u8], track: &PreparedTrack, chunk: &Chunk) -> Result<Vec<Segment>> {
    let invalid = || {
        error("The provider returned an unsupported transcription response. The previous transcript is unchanged.")
    };
    let response: Response = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    let speaker = if track.kind == "mic" { "You" } else { "Others" };
    if let Some(segments) = response.segments {
        let mut result = Vec::new();
        let duration = chunk.frames as f64 / f64::from(track.rate);
        for segment in segments {
            if !segment.start.is_finite()
                || !segment.end.is_finite()
                || segment.start < 0.0
                || segment.end < segment.start
                || segment.end > duration + 0.001
            {
                return Err(invalid());
            }
            let text = segment.text.trim();
            if text.is_empty() {
                continue;
            }
            let first = chunk.start
                + (segment.start * f64::from(track.rate))
                    .round()
                    .min(chunk.frames as f64) as u64;
            let last = chunk.start
                + (segment.end * f64::from(track.rate))
                    .round()
                    .min(chunk.frames as f64) as u64;
            let start_ms = session_ms(track, first, false)?;
            let end_ms = session_ms(track, last, true)?.max(start_ms);
            result.push(Segment {
                speaker: speaker.into(),
                text: text.into(),
                timing: SegmentTiming::Timed { start_ms, end_ms },
            });
        }
        if result.is_empty() && !response.text.trim().is_empty() {
            return Err(invalid());
        }
        Ok(result)
    } else {
        let text = response.text.trim();
        Ok(if text.is_empty() {
            Vec::new()
        } else {
            vec![Segment {
                speaker: speaker.into(),
                text: text.into(),
                timing: SegmentTiming::Untimed,
            }]
        })
    }
}

#[allow(clippy::too_many_arguments)]
pub fn transcribe(
    connection: &Connection,
    tracks: &[Track],
    language: &str,
    prompt: &str,
    plan: &CloudPlan,
    cancel: &AtomicBool,
    mut report: impl FnMut(&str, u8),
    mut before_request: impl FnMut(&str, u64) -> Result<()>,
) -> Result<Vec<Segment>> {
    cancelled(cancel)?;
    if serde_json::to_vec(tracks).map_err(|_| changed())? != plan.input {
        return Err(changed());
    }
    if (language != "auto"
        && (language.is_empty()
            || language.len() > 16
            || !language
                .bytes()
                .all(|b| b.is_ascii_alphabetic() || b == b'-')))
        || prompt.chars().count() > 500
    {
        return Err(error(
            "The speech language or vocabulary setting is invalid. Nothing was sent.",
        ));
    }
    let url = connection.endpoint("audio/transcriptions")?;
    let model = connection.model()?;
    let unreachable = || {
        error("Cannot reach the transcription provider. Check its API base URL and connection. The previous transcript is unchanged.")
    };
    let http = client(Duration::from_secs(120)).map_err(|_| unreachable())?;
    let mut entries = Vec::new();
    for track in &plan.prepared {
        report(&track.kind, 0);
        for (index, chunk) in track.chunks.iter().enumerate() {
            cancelled(cancel)?;
            if file_digest(&chunk.path, cancel)? != chunk.digest {
                return Err(changed());
            }
            let file = File::open(&chunk.path).map_err(audio_error)?;
            let part = Part::reader_with_length(file, chunk.bytes)
                .file_name("audio.wav")
                .mime_str("audio/wav")
                .map_err(|_| audio_error("multipart"))?;
            let mut form = Form::new()
                .text("model", model.to_string())
                .text("response_format", "json")
                .part("file", part);
            if language != "auto" {
                form = form.text("language", language.to_string());
            }
            if !prompt.trim().is_empty() {
                form = form.text("prompt", prompt.trim().to_string());
            }
            cancelled(cancel)?;
            let identity = serde_json::to_vec(&(chunk.digest, model, language, prompt.trim()))
                .map_err(|_| changed())?;
            let fingerprint = sha256_hex(identity);
            before_request(&fingerprint, chunk.bytes)?;
            cancelled(cancel)?;
            let response = crate::providers::authorize(http.post(url.clone()), connection.key())
                .multipart(form)
                .send();
            cancelled(cancel)?;
            let response = response.map_err(|_| unreachable())?;
            check_status(response.status())?;
            let bytes = read_capped(response, MAX_RESPONSE_BYTES);
            cancelled(cancel)?;
            let bytes = bytes.ok_or_else(|| error("The transcription response was unreadable or too large. The previous transcript is unchanged."))?;
            entries.extend(parse_response(&bytes, track, chunk)?);
            report(&track.kind, ((index + 1) * 100 / track.chunks.len()) as u8);
        }
    }
    cancelled(cancel)?;
    if entries
        .iter()
        .all(|entry| matches!(entry.timing, SegmentTiming::Timed { .. }))
    {
        entries.sort_by(|a, b| {
            let start = |segment: &Segment| match segment.timing {
                SegmentTiming::Timed { start_ms, .. } => start_ms,
                SegmentTiming::Untimed => 0,
            };
            (start(a), &a.speaker).cmp(&(start(b), &b.speaker))
        });
    }
    Ok(entries)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::{
        io::{BufRead, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
        thread,
    };

    fn synthetic(root: &Path, kind: &str, frames: u32) -> Track {
        let path = root.join(format!("{kind}.wav"));
        let timing = root.join(format!("{kind}.jsonl"));
        let mut writer = hound::WavWriter::create(
            &path,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16000,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            },
        )
        .unwrap();
        for _ in 0..frames {
            writer.write_sample(0.25_f32).unwrap();
        }
        writer.finalize().unwrap();
        fs::write(&timing, format!("{{\"frame_offset\":0,\"frames\":{frames},\"capture_start_us\":0,\"generation\":1}}\n")).unwrap();
        Track {
            kind: kind.into(),
            path: path.to_str().unwrap().into(),
            timing_path: timing.to_str().unwrap().into(),
            device_name: "Synthetic".into(),
            sample_rate: 16000,
            channels: 1,
            frames: i64::from(frames),
            dropped_frames: 0,
            finalized: true,
            size_bytes: None,
        }
    }

    pub(crate) type ReceivedRequests = Arc<Mutex<Vec<Vec<u8>>>>;

    pub(crate) fn serve(
        responses: Vec<String>,
    ) -> (Connection, thread::JoinHandle<()>, ReceivedRequests) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let connection = Connection::for_test(
            &format!("http://{}/custom/v1", listener.local_addr().unwrap()),
            "custom-stt",
        );
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let worker = thread::spawn(move || {
            for body in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(&stream);
                let mut head = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    head.push_str(&line);
                    if line == "\r\n" {
                        break;
                    }
                }
                let size: usize = head
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|s| s.trim().parse().unwrap())
                    })
                    .unwrap();
                let mut raw = vec![0; size];
                reader.read_exact(&mut raw).unwrap();
                let mut request = head.into_bytes();
                request.extend(raw);
                log.lock().unwrap().push(request);
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
        });
        (connection, worker, seen)
    }

    #[test]
    fn authorization_denial_or_cancellation_never_opens_http_connection() {
        let dir = tempfile::tempdir().unwrap();
        let tracks = [synthetic(dir.path(), "mic", 1600)];
        let plan = plan(&tracks).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let connection = Connection::for_test(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            "fictional",
        );
        let cancel = AtomicBool::new(false);
        let mut authorized = None;
        let error = transcribe(
            &connection,
            &tracks,
            "auto",
            "",
            &plan,
            &cancel,
            |_, _| {},
            |digest, bytes| {
                authorized = Some((digest.to_string(), bytes));
                Err(AppError::new("denied", "Denied"))
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "denied");
        let (digest, bytes) = authorized.unwrap();
        assert_eq!(digest.len(), 64);
        assert_eq!(bytes, plan.bytes);
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        let error = transcribe(
            &connection,
            &tracks,
            "auto",
            "",
            &plan,
            &cancel,
            |_, _| {},
            |_, _| {
                cancel.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "stt_cancelled");
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn chunks_are_bounded_split_pauses_and_fingerprint_frozen_audio() {
        let dir = tempfile::tempdir().unwrap();
        let track = synthetic(dir.path(), "mic", 32000);
        fs::write(&track.timing_path, "{\"frame_offset\":0,\"frames\":16000,\"capture_start_us\":1000000,\"generation\":1}\n{\"frame_offset\":16000,\"frames\":16000,\"capture_start_us\":6000000,\"generation\":2}\n").unwrap();
        let tracks = [track.clone()];
        let first = prepare(&tracks, 16044, &AtomicBool::new(false)).unwrap();
        let second = prepare(&tracks, 16044, &AtomicBool::new(false)).unwrap();
        assert_eq!(first.requests, 4);
        assert_eq!(first.bytes, 64176);
        assert_eq!(first.fingerprint(), second.fingerprint());
        assert!(first.prepared[0]
            .chunks
            .iter()
            .all(|chunk| chunk.bytes <= 16044));
        let chunk = &first.prepared[0].chunks[2];
        let entries = parse_response(
            br#"{"text":"resumed","segments":[{"text":"resumed","start":0.0,"end":0.5}]}"#,
            &first.prepared[0],
            chunk,
        )
        .unwrap();
        assert!(matches!(
            entries[0].timing,
            SegmentTiming::Timed {
                start_ms: 6000,
                end_ms: 6500
            }
        ));
        fs::write(&track.timing_path, "broken").unwrap();
        assert!(plan(&tracks).is_err());
    }

    #[test]
    fn separate_tracks_send_multipart_and_plain_json_is_untimed() {
        let dir = tempfile::tempdir().unwrap();
        let tracks = [
            synthetic(dir.path(), "mic", 1600),
            synthetic(dir.path(), "system", 1600),
        ];
        let plan = plan(&tracks).unwrap();
        let (connection, worker, seen) = serve(vec![
            r#"{"text":"You said hello"}"#.into(),
            r#"{"text":"They said hello"}"#.into(),
        ]);
        let entries = transcribe(
            &connection,
            &tracks,
            "en",
            "OpenMeet",
            &plan,
            &AtomicBool::new(false),
            |_, _| {},
            |_, _| Ok(()),
        )
        .unwrap();
        worker.join().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].speaker, "You");
        assert_eq!(entries[1].speaker, "Others");
        assert!(entries
            .iter()
            .all(|entry| matches!(entry.timing, SegmentTiming::Untimed)));
        for raw in seen.lock().unwrap().iter() {
            let text = String::from_utf8_lossy(raw);
            assert!(text.starts_with("POST /custom/v1/audio/transcriptions HTTP/1.1"));
            assert!(text.contains("name=\"model\"") && text.contains("custom-stt"));
            assert!(text.contains("name=\"language\"") && text.contains("OpenMeet"));
            assert!(text.contains("filename=\"audio.wav\"") && text.contains("RIFF"));
            assert!(!text.contains(dir.path().to_str().unwrap()));
        }
    }

    #[test]
    fn cancellation_prevents_additional_chunks_and_no_partial_result_returns() {
        let dir = tempfile::tempdir().unwrap();
        let tracks = [synthetic(dir.path(), "mic", 1600)];
        let plan = prepare(&tracks, 1644, &AtomicBool::new(false)).unwrap();
        assert_eq!(plan.requests, 2);
        let (connection, worker, seen) = serve(vec![r#"{"text":"first"}"#.into()]);
        let cancel = AtomicBool::new(false);
        let result = transcribe(
            &connection,
            &tracks,
            "auto",
            "",
            &plan,
            &cancel,
            |_, progress| {
                if progress > 0 {
                    cancel.store(true, Ordering::SeqCst);
                }
            },
            |_, _| Ok(()),
        );
        worker.join().unwrap();
        assert_eq!(result.unwrap_err().code, "stt_cancelled");
        assert_eq!(
            plan_cancellable(&tracks, &cancel).err().unwrap().code,
            "stt_cancelled"
        );
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert_eq!(
            transcribe(
                &connection,
                &tracks,
                "auto",
                "",
                &plan,
                &cancel,
                |_, _| {},
                |_, _| Ok(()),
            )
            .unwrap_err()
            .code,
            "stt_cancelled"
        );
    }

    #[test]
    fn timing_errors_and_malformed_responses_preserve_no_output() {
        let dir = tempfile::tempdir().unwrap();
        let track = synthetic(dir.path(), "mic", 1600);
        let plan = plan(std::slice::from_ref(&track)).unwrap();
        let prepared = &plan.prepared[0];
        let chunk = &prepared.chunks[0];
        for bytes in [
            br#"{"text":"x","segments":[{"text":"x","start":-1,"end":0.1}]}"#.as_slice(),
            br#"{"text":"x","segments":[{"text":"x","start":0.2,"end":0.3}]}"#.as_slice(),
            br#"{"text":"x","segments":[{"text":"x","start":0.1,"end":0}]}"#.as_slice(),
            br#"{"text":"x","segments":[]}"#.as_slice(),
            br#"{"text":"x","segments":[{"text":"x","start":1e999,"end":1e999}]}"#.as_slice(),
            b"not json".as_slice(),
        ] {
            assert!(parse_response(bytes, prepared, chunk).is_err());
        }
        let output = parse_response(br#"{"text":""}"#, prepared, chunk).unwrap();
        assert!(output.is_empty());
        fs::write(
            &track.timing_path,
            "{\"frame_offset\":0,\"frames\":1500,\"capture_start_us\":0}\n",
        )
        .unwrap();
        assert!(super::plan(&[track]).is_err());
    }
}
