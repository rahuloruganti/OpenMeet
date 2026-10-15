//! Two-track capture. Device callbacks only convert into bounded SPSC queues.
//! WAV and timing-index writes run on a dedicated owner thread, never a callback.
//! Windows opens an output device as loopback. macOS uses that same call only
//! when the output has no input, which is cpal's process-tap path.
use crate::domain::{AppError, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use ringbuf::{
    traits::{Consumer, Producer, Split},
    HeapCons, HeapRb,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime},
};

const BLOCK_SAMPLES: usize = 2048;
const QUEUE_BLOCKS: usize = 128;
const STREAM_ERROR: u32 = 1;
const OVERFLOW: u32 = 2;
const IO_ERROR: u32 = 4;
const SUSPENDED: u32 = 8;
const TIMESTAMP: u32 = 16;
const WORKER_ERROR: u32 = 32;
const CONTROL_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, Serialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct Devices {
    pub capture_supported: bool,
    pub microphones: Vec<AudioDevice>,
    pub outputs: Vec<AudioDevice>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOptions {
    pub microphone_id: String,
    pub output_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Track {
    pub kind: String,
    pub path: String,
    pub timing_path: String,
    pub device_name: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub frames: i64,
    pub dropped_frames: i64,
    pub finalized: bool,
    /// WAV size on disk when read back from storage; `None` while capturing or if the file is missing.
    #[serde(default)]
    pub size_bytes: Option<u64>,
}
#[derive(Clone, Debug, Serialize)]
pub struct TrackHealth {
    pub kind: String,
    pub frames: u64,
    pub dropped_frames: u64,
    pub gaps: u64,
    pub peak: f32,
    pub callback_age_ms: u64,
}
#[derive(Clone, Debug, Serialize)]
pub struct Health {
    pub error: Option<String>,
    pub tracks: Vec<TrackHealth>,
}
#[derive(Debug)]
pub struct Report {
    pub tracks: Vec<Track>,
    pub error: Option<String>,
}

fn audio_error(error: impl std::fmt::Display) -> AppError {
    AppError::new("audio", format!("Audio capture: {error}"))
}

pub fn devices() -> Result<Devices> {
    let host = cpal::default_host();
    let describe = |device: cpal::Device| -> Result<AudioDevice> {
        Ok(AudioDevice {
            id: device.id().map_err(audio_error)?.to_string(),
            name: device.to_string(),
        })
    };
    Ok(Devices {
        // CoreAudio output devices with no input use cpal's process tap. Duplex
        // devices are refused later so they are not recorded as Others.
        capture_supported: crate::capture_gate::supported(),
        microphones: host
            .input_devices()
            .map_err(audio_error)?
            .map(describe)
            .collect::<Result<_>>()?,
        outputs: host
            .output_devices()
            .map_err(audio_error)?
            .map(describe)
            .collect::<Result<_>>()?,
    })
}

struct Shared {
    start: Instant,
    recording: AtomicBool,
    stopping: AtomicBool,
    generation: AtomicU64,
    fault: AtomicU32,
    // First device error text (never audio content); set outside the data callback.
    detail: Mutex<Option<String>>,
    counters: [Counters; 2],
}
#[derive(Default)]
struct Counters {
    frames: AtomicU64,
    dropped: AtomicU64,
    // WASAPI data discontinuities (cpal Xrun): non-fatal gaps in captured audio.
    gaps: AtomicU64,
    peak: AtomicU32,
    last_callback: AtomicU64,
}
impl Shared {
    fn new() -> Self {
        Self {
            start: Instant::now(),
            recording: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            fault: AtomicU32::new(0),
            detail: Mutex::new(None),
            counters: [Counters::default(), Counters::default()],
        }
    }
    fn elapsed_us(&self) -> u64 {
        self.start.elapsed().as_micros() as u64
    }
    /// Microphone audio written so far. Paused or rejected packets never reach the
    /// counter, so this excludes paused time by construction (no wall clock involved).
    fn offset_ms(&self, rate: u32) -> i64 {
        let frames = self.counters[0].frames.load(Ordering::Relaxed);
        (frames.saturating_mul(1000) / u64::from(rate.max(1))).min(i64::MAX as u64) as i64
    }
    fn mute(&self) {
        self.recording.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
    fn fail(&self, reason: u32) {
        self.fault.fetch_or(reason, Ordering::SeqCst);
        self.recording.store(false, Ordering::SeqCst);
    }
    /// Called from the stream error callback, which runs on the audio thread:
    /// atomics and `try_lock` only. An Xrun is a gap in the audio, not a dead
    /// stream, so it is counted and capture continues; anything else is fatal.
    fn fail_stream(&self, index: usize, error: cpal::Error) {
        if error.kind() == cpal::ErrorKind::Xrun {
            self.counters[index].gaps.fetch_add(1, Ordering::Relaxed);
            return;
        }
        if let Ok(mut detail) = self.detail.try_lock() {
            if detail.is_none() {
                let track = if index == 0 {
                    "microphone"
                } else {
                    "system output"
                };
                let text: String = error.to_string().chars().take(200).collect();
                *detail = Some(format!("{track}: {text}"));
            }
        }
        self.fail(STREAM_ERROR);
    }
    fn error(&self) -> Option<String> {
        match self.fault.load(Ordering::SeqCst) {
            0 => None,
            bits if bits & IO_ERROR != 0 => Some("Audio disk write/finalization failed or WAV size limit reached. Stop and check free space; partial files are retained.".into()),
            bits if bits & OVERFLOW != 0 => Some("Audio queue overflowed. Both tracks paused; stop and start a new recording.".into()),
            bits if bits & SUSPENDED != 0 => Some("Capture was interrupted by sleep or a scheduling gap. Stop and start a new recording.".into()),
            bits if bits & TIMESTAMP != 0 => Some("A device reported timestamps that moved backwards, so capture timing cannot be trusted. Both tracks paused; stop and start a new recording.".into()),
            bits if bits & WORKER_ERROR != 0 => Some("The audio capture worker stopped responding. Capture is disabled; partial files are retained for recovery.".into()),
            _ => {
                let detail = self.detail.lock().ok().and_then(|d| d.clone());
                Some(match detail {
                    Some(detail) => format!("An audio device stopped responding ({detail}). Both tracks paused; stop, check permissions/devices, and start again."),
                    None => "An audio device stopped responding. Both tracks paused; stop, check permissions/devices, and start again.".into(),
                })
            }
        }
    }
}

#[derive(Clone)]
struct Block {
    samples: [f32; BLOCK_SAMPLES],
    len: usize,
    start_us: u64,
    generation: u64,
}

// A fixed-size packet and bounded queue mean callbacks allocate no audio buffers.
fn push_samples<T>(
    data: &[T],
    start_us: u64,
    channels: usize,
    rate: u32,
    shared: &Shared,
    index: usize,
    producer: &mut ringbuf::HeapProd<Block>,
) where
    T: cpal::Sample + Copy,
    f32: cpal::FromSample<T>,
{
    shared.counters[index]
        .last_callback
        .store(shared.elapsed_us(), Ordering::Relaxed);
    let generation = shared.generation.load(Ordering::SeqCst);
    if !shared.recording.load(Ordering::SeqCst) || shared.stopping.load(Ordering::SeqCst) {
        return;
    }
    let chunk_size = BLOCK_SAMPLES / channels * channels;
    let mut peak = 0_f32;
    for (chunk_index, chunk) in data.chunks(chunk_size).enumerate() {
        let mut block = Block {
            samples: [0.0; BLOCK_SAMPLES],
            len: chunk.len() / channels * channels,
            start_us: start_us
                + (chunk_index * chunk_size / channels) as u64 * 1_000_000 / u64::from(rate),
            generation,
        };
        for (out, sample) in block.samples.iter_mut().zip(chunk) {
            let value = sample.to_sample::<f32>();
            *out = if value.is_finite() {
                value.clamp(-1.0, 1.0)
            } else {
                0.0
            };
            peak = peak.max(out.abs());
        }
        if !shared.recording.load(Ordering::SeqCst)
            || shared.stopping.load(Ordering::SeqCst)
            || generation != shared.generation.load(Ordering::SeqCst)
        {
            return;
        }
        if producer.try_push(block).is_err() {
            shared.counters[index]
                .dropped
                .fetch_add((chunk.len() / channels) as u64, Ordering::Relaxed);
            shared.fail(OVERFLOW);
            return;
        }
    }
    shared.counters[index]
        .peak
        .store(peak.to_bits(), Ordering::Relaxed);
}

struct Input {
    device: cpal::Device,
    config: cpal::SupportedStreamConfig,
}
fn inputs(options: &CaptureOptions) -> Result<[Input; 2]> {
    if !crate::capture_gate::supported() {
        return Err(crate::capture_gate::unsupported_reason());
    }
    let host = cpal::default_host();
    let mic = host.input_devices().map_err(audio_error)?.find(|d| d.id().is_ok_and(|id| id.to_string() == options.microphone_id))
        .ok_or_else(|| audio_error("Selected microphone is unavailable. Enable microphone access or remote microphone redirection, then refresh devices."))?;
    let output = host
        .output_devices()
        .map_err(audio_error)?
        .find(|d| d.id().is_ok_and(|id| id.to_string() == options.output_id))
        .ok_or_else(|| {
            audio_error("Selected system-output device is unavailable. Refresh devices.")
        })?;
    #[cfg(target_os = "macos")]
    {
        crate::capture_gate::ensure_permissions()?;
        crate::capture_gate::reject_duplex_output(output.supports_input())?;
    }
    let mic_config = mic.default_input_config().map_err(audio_error)?;
    let output_config = output.default_output_config().map_err(audio_error)?;
    for config in [&mic_config, &output_config] {
        if config.channels() == 0
            || config.channels() > 8
            || !(8_000..=192_000).contains(&config.sample_rate())
        {
            return Err(audio_error(
                "This preview supports 1–8 channels at 8–192 kHz. Choose another device format.",
            ));
        }
    }
    Ok([
        Input {
            device: mic,
            config: mic_config,
        },
        Input {
            device: output,
            config: output_config,
        },
    ])
}

fn stream(
    input: &Input,
    shared: Arc<Shared>,
    index: usize,
) -> Result<(cpal::Stream, HeapCons<Block>)> {
    fn typed<T>(
        input: &Input,
        shared: Arc<Shared>,
        index: usize,
    ) -> Result<(cpal::Stream, HeapCons<Block>)>
    where
        T: cpal::SizedSample,
        f32: cpal::FromSample<T>,
    {
        let (mut producer, consumer) = HeapRb::<Block>::new(QUEUE_BLOCKS).split();
        let fault = shared.clone();
        let channels = usize::from(input.config.channels());
        let rate = input.config.sample_rate();
        let mut anchor: Option<(cpal::StreamInstant, u64)> = None;
        let stream = input
            .device
            .build_input_stream::<T, _, _>(
                input.config.config(),
                move |data, info| {
                    let stamp = info.timestamp();
                    let latency = stamp.callback.duration_since(stamp.capture).as_micros() as u64;
                    let (native, session_us) = *anchor.get_or_insert_with(|| {
                        (stamp.capture, shared.elapsed_us().saturating_sub(latency))
                    });
                    match stamp.capture.checked_duration_since(native) {
                        Some(delta) => push_samples(
                            data,
                            session_us + delta.as_micros() as u64,
                            channels,
                            rate,
                            &shared,
                            index,
                            &mut producer,
                        ),
                        None => shared.fail(TIMESTAMP),
                    }
                },
                move |error| fault.fail_stream(index, error),
                Some(Duration::from_secs(5)),
            )
            .map_err(audio_error)?;
        Ok((stream, consumer))
    }
    match input.config.sample_format() {
        cpal::SampleFormat::F32 => typed::<f32>(input, shared, index),
        cpal::SampleFormat::I16 => typed::<i16>(input, shared, index),
        cpal::SampleFormat::U16 => typed::<u16>(input, shared, index),
        cpal::SampleFormat::I32 => typed::<i32>(input, shared, index),
        cpal::SampleFormat::F64 => typed::<f64>(input, shared, index),
        format => Err(audio_error(format!(
            "Unsupported device sample format: {format:?}"
        ))),
    }
}

type LiveStreams = Vec<(cpal::Stream, HeapCons<Block>)>;
fn open_streams(inputs: &[Input; 2], shared: &Arc<Shared>) -> Result<LiveStreams> {
    let mut streams = Vec::new();
    for (index, input) in inputs.iter().enumerate() {
        streams.push(stream(input, shared.clone(), index)?);
    }
    // The shared gate remains closed until BOTH streams have started.
    for (stream, _) in &streams {
        stream.play().map_err(audio_error)?;
    }
    Ok(streams)
}

struct TrackWriter {
    track: Track,
    wav: hound::WavWriter<BufWriter<File>>,
    timing: BufWriter<File>,
    failed: bool,
    live: Option<crate::live_audio::Accumulator>,
}
impl TrackWriter {
    fn new(folder: &Path, kind: &str, input: &Input) -> Result<Self> {
        let (rate, channels) = (input.config.sample_rate(), input.config.channels());
        Self::create(folder, kind, input.device.to_string(), rate, channels)
    }
    fn create(
        folder: &Path,
        kind: &str,
        device_name: String,
        sample_rate: u32,
        channels: u16,
    ) -> Result<Self> {
        let path = folder.join(format!("{kind}.wav"));
        let timing_path = folder.join(format!("{kind}.timing.jsonl"));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        let wav = hound::WavWriter::new(
            BufWriter::new(file),
            hound::WavSpec {
                channels,
                sample_rate,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            },
        )
        .map_err(audio_error)?;
        let timing = BufWriter::new(
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&timing_path)?,
        );
        Ok(Self {
            wav,
            timing,
            failed: false,
            live: None,
            track: Track {
                kind: kind.into(),
                path: path.to_string_lossy().into_owned(),
                timing_path: timing_path.to_string_lossy().into_owned(),
                device_name,
                sample_rate,
                channels,
                frames: 0,
                dropped_frames: 0,
                finalized: false,
                size_bytes: None,
            },
        })
    }
    fn write(&mut self, block: &Block) -> Result<()> {
        let result = (|| {
            // Classic WAV has a 4 GiB size limit. Stop before overflowing the header.
            if u64::from(self.wav.len()) + block.len as u64 > (u64::from(u32::MAX) - 4096) / 4 {
                return Err(audio_error("WAV size limit reached"));
            }
            for sample in &block.samples[..block.len] {
                self.wav.write_sample(*sample).map_err(audio_error)?;
            }
            let frames = block.len as u64 / u64::from(self.track.channels);
            writeln!(
                self.timing,
                "{{\"frame_offset\":{},\"frames\":{},\"capture_start_us\":{},\"generation\":{}}}",
                self.track.frames, frames, block.start_us, block.generation
            )?;
            self.track.frames += frames as i64;
            if let Some(live) = &mut self.live {
                live.accept(
                    &block.samples[..block.len],
                    block.generation,
                    block.start_us,
                );
            }
            Ok(())
        })();
        self.failed |= result.is_err();
        result
    }
    fn checkpoint(&mut self) -> Result<()> {
        let result = (|| {
            self.wav.flush().map_err(audio_error)?;
            self.timing.flush()?;
            Ok(())
        })();
        self.failed |= result.is_err();
        result
    }
    fn finish(mut self, dropped: u64) -> Track {
        if let Some(live) = &mut self.live {
            live.flush();
        }
        self.track.dropped_frames = dropped.min(i64::MAX as u64) as i64;
        let timing_ok = self.timing.flush().is_ok();
        let wav_ok = self.wav.finalize().is_ok();
        self.track.finalized = !self.failed && timing_ok && wav_ok;
        self.track
    }
}

enum Command {
    Pause(mpsc::Sender<Result<()>>),
    Resume(mpsc::Sender<Result<()>>),
    Stop,
}
pub struct Session {
    shared: Arc<Shared>,
    commands: mpsc::Sender<Command>,
    thread: Option<JoinHandle<Report>>,
    pub tracks: Vec<Track>,
}
impl Session {
    pub fn prepare(
        folder: PathBuf,
        options: CaptureOptions,
        live: Option<crate::live_audio::Producer>,
    ) -> Result<Self> {
        let shared = Arc::new(Shared::new());
        let worker_shared = shared.clone();
        let (commands, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let handle = thread::Builder::new()
            .name("openmeet-audio".into())
            .spawn(move || worker(folder, options, worker_shared, rx, ready_tx, live))?;
        match ready_rx.recv_timeout(Duration::from_secs(20)) {
            Ok(Ok(tracks)) => Ok(Self {
                shared,
                commands,
                thread: Some(handle),
                tracks,
            }),
            Ok(Err(error)) => {
                let _ = handle.join();
                Err(error)
            }
            Err(_) => {
                let _ = commands.send(Command::Stop);
                Err(audio_error(
                    "Device initialization timed out. No recording was started.",
                ))
            }
        }
    }
    pub fn pause(&self) -> Result<()> {
        self.shared.mute(); // Immediately revoke queued/in-flight callbacks before waiting for disk work.
        self.request(Command::Pause)
    }
    pub fn resume(&self) -> Result<()> {
        if let Some(error) = self.shared.error() {
            return Err(audio_error(error));
        }
        self.request(Command::Resume)
    }
    fn request(&self, command: fn(mpsc::Sender<Result<()>>) -> Command) -> Result<()> {
        let (tx, rx) = mpsc::channel();
        self.commands
            .send(command(tx))
            .map_err(|error| self.worker_error(error))?;
        rx.recv_timeout(CONTROL_TIMEOUT)
            .map_err(|error| self.worker_error(error))?
    }
    fn worker_error(&self, reason: impl std::fmt::Display) -> AppError {
        self.shared.fail(WORKER_ERROR);
        let _ = self.commands.send(Command::Stop);
        audio_error(format!("Capture worker did not respond ({reason}). Capture is disabled; partial files are retained for recovery."))
    }
    pub fn offset_ms(&self) -> i64 {
        self.shared
            .offset_ms(self.tracks.first().map_or(0, |track| track.sample_rate))
    }
    pub fn health(&self) -> Health {
        Health {
            error: self.shared.error(),
            tracks: self
                .shared
                .counters
                .iter()
                .enumerate()
                .map(|(index, c)| TrackHealth {
                    kind: if index == 0 { "mic" } else { "system" }.into(),
                    frames: c.frames.load(Ordering::Relaxed),
                    dropped_frames: c.dropped.load(Ordering::Relaxed),
                    gaps: c.gaps.load(Ordering::Relaxed),
                    peak: if self.shared.recording.load(Ordering::SeqCst) {
                        f32::from_bits(c.peak.load(Ordering::Relaxed))
                    } else {
                        0.0
                    },
                    callback_age_ms: self
                        .shared
                        .elapsed_us()
                        .saturating_sub(c.last_callback.load(Ordering::Relaxed))
                        / 1000,
                })
                .collect(),
        }
    }
    pub fn stop(&mut self) -> Result<Report> {
        // Close callbacks immediately while still allowing the worker to drain pre-stop packets.
        self.shared.stopping.store(true, Ordering::SeqCst);
        let _ = self.commands.send(Command::Stop);
        let handle = self
            .thread
            .take()
            .ok_or_else(|| audio_error("Capture has already stopped"))?;
        let deadline = Instant::now() + STOP_TIMEOUT;
        while !handle.is_finished() {
            if Instant::now() >= deadline {
                self.thread = Some(handle);
                let error =
                    self.worker_error("stop timed out; retry Stop after the worker responds");
                return Err(AppError::new("audio_worker_busy", error.message));
            }
            thread::sleep(Duration::from_millis(10));
        }
        handle
            .join()
            .map_err(|_| self.worker_error("worker panicked"))
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.shared.mute();
        let _ = self.commands.send(Command::Stop);
    }
}

#[cfg(test)]
pub(crate) fn pending_writer_for_test(
    folder: &Path,
) -> (Session, mpsc::Sender<()>, mpsc::Receiver<()>) {
    fs::create_dir_all(folder).unwrap();
    let shared = Arc::new(Shared::new());
    shared.recording.store(true, Ordering::SeqCst);
    let mut writers: Vec<_> = ["mic", "system"]
        .into_iter()
        .map(|kind| TrackWriter::create(folder, kind, "Synthetic".into(), 16000, 1).unwrap())
        .collect();
    let tracks = writers.iter().map(|writer| writer.track.clone()).collect();
    let (commands, command_rx) = mpsc::channel();
    let (release, waiting) = mpsc::channel();
    let (finished, finished_rx) = mpsc::channel();
    let worker_shared = shared.clone();
    let worker = thread::spawn(move || {
        let _ = waiting.recv();
        drop(command_rx);
        // Represents a disk write already in progress before the stop request.
        for writer in &mut writers {
            writer
                .write(&Block {
                    samples: [0.25; BLOCK_SAMPLES],
                    len: 4,
                    start_us: 0,
                    generation: 0,
                })
                .unwrap();
        }
        let report = Report {
            tracks: writers.into_iter().map(|writer| writer.finish(0)).collect(),
            error: worker_shared.error(),
        };
        let _ = finished.send(());
        report
    });
    (
        Session {
            shared,
            commands,
            thread: Some(worker),
            tracks,
        },
        release,
        finished_rx,
    )
}

#[cfg(test)]
pub(crate) fn synthetic_pause_recording_for_test(
    folder: &Path,
) -> (Vec<Track>, Vec<crate::live_audio::Chunk>) {
    fs::create_dir_all(folder).unwrap();
    let shared = Shared::new();
    let (live, receiver, incomplete) = crate::live_audio::channel();
    let mut writers: Vec<_> = ["mic", "system"]
        .into_iter()
        .map(|kind| {
            let mut writer =
                TrackWriter::create(folder, kind, "Synthetic".into(), 16000, 1).unwrap();
            writer.live = Some(crate::live_audio::Accumulator::new(
                live.clone(),
                &writer.track,
            ));
            writer
        })
        .collect();
    let mut queues: Vec<_> = (0..2).map(|_| HeapRb::new(4).split()).collect();
    let mut chunks = Vec::new();
    shared.recording.store(true, Ordering::SeqCst);
    for (index, signal) in [0.25_f32, -0.25].into_iter().enumerate() {
        push_samples(
            &[signal; 1600],
            0,
            1,
            16000,
            &shared,
            index,
            &mut queues[index].0,
        );
        drain(index, &mut queues[index].1, &mut writers[index], &shared);
        writers[index].live.as_mut().unwrap().flush();
        chunks.extend(receiver.try_iter());
        push_samples(
            &[0.9_f32; 1600],
            200_000,
            1,
            16000,
            &shared,
            index,
            &mut queues[index].0,
        );
    }
    shared.mute();
    for (index, (producer, _)) in queues.iter_mut().enumerate() {
        push_samples(
            &[0.9_f32; 1600],
            4_000_000,
            1,
            16000,
            &shared,
            index,
            producer,
        );
    }
    shared.generation.fetch_add(1, Ordering::SeqCst);
    shared.recording.store(true, Ordering::SeqCst);
    for (index, signal) in [0.5_f32, -0.5].into_iter().enumerate() {
        push_samples(
            &[signal; 1600],
            8_000_000,
            1,
            16000,
            &shared,
            index,
            &mut queues[index].0,
        );
        drain(index, &mut queues[index].1, &mut writers[index], &shared);
        writers[index].live.as_mut().unwrap().flush();
        chunks.extend(receiver.try_iter());
    }
    shared.mute();
    let tracks = writers.into_iter().map(|writer| writer.finish(0)).collect();
    chunks.extend(receiver.try_iter());
    assert!(!incomplete.load(Ordering::SeqCst));
    (tracks, chunks)
}

fn accepted(block: &Block, shared: &Shared) -> bool {
    shared.recording.load(Ordering::SeqCst)
        && shared.fault.load(Ordering::SeqCst) == 0
        && block.generation == shared.generation.load(Ordering::SeqCst)
}

/// Writes every accepted queued packet for one track and publishes its frame count.
fn drain(index: usize, consumer: &mut HeapCons<Block>, writer: &mut TrackWriter, shared: &Shared) {
    while let Some(block) = consumer.try_pop() {
        if accepted(&block, shared) {
            if writer.write(&block).is_err() {
                shared.fail(IO_ERROR);
                break;
            }
            shared.counters[index]
                .frames
                .store(writer.track.frames as u64, Ordering::Relaxed);
        }
    }
}

fn worker(
    folder: PathBuf,
    options: CaptureOptions,
    shared: Arc<Shared>,
    commands: mpsc::Receiver<Command>,
    ready: mpsc::Sender<Result<Vec<Track>>>,
    live: Option<crate::live_audio::Producer>,
) -> Report {
    let initialized = (|| -> Result<([Input; 2], Vec<TrackWriter>, LiveStreams)> {
        let selected = inputs(&options)?;
        fs::create_dir(&folder)?; // UUID directory; never reuse or truncate prior recordings.
        let writers = vec![
            TrackWriter::new(&folder, "mic", &selected[0])?,
            TrackWriter::new(&folder, "system", &selected[1])?,
        ];
        let streams = open_streams(&selected, &shared)?;
        Ok((selected, writers, streams))
    })();
    let (mut selected, mut writers, mut streams) = match initialized {
        Ok(value) => value,
        Err(error) => {
            let message = error.message.clone();
            let _ = ready.send(Err(error));
            return Report {
                tracks: vec![],
                error: Some(message),
            };
        }
    };
    if let Some(producer) = live {
        for writer in &mut writers {
            writer.live = Some(crate::live_audio::Accumulator::new(
                producer.clone(),
                &writer.track,
            ));
        }
    }
    let _ = ready.send(Ok(writers.iter().map(|w| w.track.clone()).collect()));
    let mut checkpoint = Instant::now();
    let mut last_tick = SystemTime::now();
    loop {
        let mut stopping = false;
        match commands.try_recv() {
            Ok(Command::Stop) | Err(mpsc::TryRecvError::Disconnected) => stopping = true,
            Ok(Command::Pause(reply)) => {
                for writer in &mut writers {
                    if let Some(live) = &mut writer.live {
                        live.flush();
                    }
                }
                streams.clear(); // Drop native streams and their queued packets; no paused buffers survive resume.
                let result = writers.iter_mut().try_for_each(TrackWriter::checkpoint);
                if result.is_err() {
                    shared.fail(IO_ERROR);
                }
                let _ = reply.send(result);
            }
            Ok(Command::Resume(reply)) => {
                let result = (|| -> Result<()> {
                    streams.clear();
                    selected = inputs(&options)?;
                    for (input, writer) in selected.iter().zip(&writers) {
                        if input.config.sample_rate() != writer.track.sample_rate
                            || input.config.channels() != writer.track.channels
                        {
                            return Err(audio_error(
                                "Device format changed. Stop and start a new recording.",
                            ));
                        }
                    }
                    streams = open_streams(&selected, &shared)?;
                    if let Some(error) = shared.error() {
                        streams.clear();
                        return Err(audio_error(error));
                    }
                    shared.generation.fetch_add(1, Ordering::SeqCst);
                    shared.recording.store(true, Ordering::SeqCst);
                    last_tick = SystemTime::now();
                    Ok(())
                })();
                if result.is_err() {
                    streams.clear();
                    shared.mute();
                }
                let _ = reply.send(result);
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }
        if shared.recording.load(Ordering::SeqCst)
            && last_tick.elapsed().unwrap_or_default() > Duration::from_secs(2)
        {
            shared.fail(SUSPENDED);
        }
        last_tick = SystemTime::now();
        if shared.fault.load(Ordering::SeqCst) != 0 {
            streams.clear();
        }
        // On normal stop, stop producers first then drain already captured packets.
        if stopping {
            for (stream, _) in &streams {
                let _ = stream.pause();
            }
        }
        for (index, (_, consumer)) in streams.iter_mut().enumerate() {
            drain(index, consumer, &mut writers[index], &shared);
        }
        if stopping {
            break;
        }
        if checkpoint.elapsed() >= Duration::from_secs(1) {
            if writers
                .iter_mut()
                .try_for_each(TrackWriter::checkpoint)
                .is_err()
            {
                shared.fail(IO_ERROR);
            }
            checkpoint = Instant::now();
        }
        thread::sleep(Duration::from_millis(5));
    }
    shared.mute();
    drop(streams);
    let tracks: Vec<_> = writers
        .into_iter()
        .enumerate()
        .map(|(index, writer)| {
            writer.finish(shared.counters[index].dropped.load(Ordering::Relaxed))
        })
        .collect();
    if tracks.iter().any(|t| !t.finalized) {
        shared.fail(IO_ERROR);
    }
    Report {
        tracks,
        error: shared.error(),
    }
}

/// Writes a playable copy of a WAV whose header was never finalized (crash, power loss).
/// Sizes come from the actual file length, truncated to whole frames. The original is only read.
/// Assumes the data chunk is the last chunk, as hound writes it. Returns the frames in the copy.
pub fn repair_wav(original: &Path, copy: &Path) -> Result<i64> {
    use std::io::{Read, Seek, SeekFrom};
    let invalid = || audio_error("The audio file header is unreadable. Nothing was recovered.");
    let mut file = File::open(original)?;
    let length = file.metadata()?.len();
    let mut header = vec![0_u8; length.min(64 * 1024) as usize];
    file.read_exact(&mut header)?;
    if header.len() < 12 || &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Err(invalid());
    }
    let mut at = 12;
    let mut block_align = 0_u64;
    let data_start = loop {
        if at + 8 > header.len() {
            return Err(invalid());
        }
        let size = u32::from_le_bytes([
            header[at + 4],
            header[at + 5],
            header[at + 6],
            header[at + 7],
        ]) as usize;
        match &header[at..at + 4] {
            b"data" => break at + 8,
            // fmt layout: tag u16, channels u16, rate u32, byte rate u32, block align u16.
            b"fmt " if size >= 16 && at + 22 <= header.len() => {
                block_align = u64::from(u16::from_le_bytes([header[at + 20], header[at + 21]]));
            }
            _ => {}
        }
        at += 8 + size + size % 2;
    };
    if block_align == 0 {
        return Err(invalid());
    }
    // Both RIFF and data sizes are u32; never write a header that overflows them.
    let available = (length - data_start as u64).min(u64::from(u32::MAX) - data_start as u64);
    let data_len = available / block_align * block_align;
    let pad = data_len % 2;
    let mut fixed = header[..data_start].to_vec();
    fixed[4..8].copy_from_slice(&((data_start as u64 + data_len + pad - 8) as u32).to_le_bytes());
    fixed[data_start - 4..data_start].copy_from_slice(&(data_len as u32).to_le_bytes());
    let folder = copy.parent().ok_or_else(invalid)?;
    let mut temp = tempfile::NamedTempFile::new_in(folder)?;
    {
        let mut out = BufWriter::new(temp.as_file_mut());
        out.write_all(&fixed)?;
        file.seek(SeekFrom::Start(data_start as u64))?;
        if std::io::copy(&mut (&mut file).take(data_len), &mut out)? != data_len {
            return Err(invalid());
        }
        out.write_all(&[0; 1][..pad as usize])?;
        out.flush()?;
    }
    temp.as_file().sync_all()?;
    temp.persist_noclobber(copy).map_err(|error| {
        if error.error.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::new(
                "recovery_exists",
                format!(
                    "A recovered copy already exists at {}. Nothing was overwritten.",
                    copy.display()
                ),
            )
        } else {
            error.error.into()
        }
    })?;
    Ok((data_len / block_align) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_unresponsive_worker_returns(
        action: fn(&mut Session) -> Result<()>,
        deadline: Duration,
    ) {
        let shared = Arc::new(Shared::new());
        shared.recording.store(true, Ordering::SeqCst);
        let (commands, command_rx) = mpsc::channel();
        let (release, waiting) = mpsc::channel();
        let (finished, worker_finished) = mpsc::channel();
        let worker = thread::spawn(move || {
            let _ = waiting.recv();
            drop(command_rx);
            let _ = finished.send(());
            Report {
                tracks: vec![],
                error: None,
            }
        });
        let mut session = Session {
            shared: shared.clone(),
            commands,
            thread: Some(worker),
            tracks: vec![],
        };
        let (reply, result_rx) = mpsc::channel();
        let caller = thread::spawn(move || {
            let _ = reply.send(action(&mut session));
        });
        let result = result_rx.recv_timeout(deadline);
        // Release the synthetic worker before asserting so a failing test cannot leak it.
        let _ = release.send(());
        caller.join().unwrap();
        worker_finished
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        let error = result
            .expect("A stalled worker must not block recording controls")
            .unwrap_err();
        assert!(error.message.contains("worker"), "{}", error.message);
        assert!(!shared.recording.load(Ordering::SeqCst));
        assert!(shared.error().is_some());
    }

    #[test]
    fn unresponsive_worker_does_not_block_pause() {
        assert_unresponsive_worker_returns(|session| session.pause(), Duration::from_secs(6));
    }

    #[test]
    fn unresponsive_worker_does_not_block_resume() {
        assert_unresponsive_worker_returns(|session| session.resume(), Duration::from_secs(6));
    }

    #[test]
    fn unresponsive_worker_does_not_block_stop() {
        assert_unresponsive_worker_returns(
            |session| session.stop().map(|_| ()),
            Duration::from_secs(21),
        );
    }

    #[test]
    fn frontend_device_payload_preserves_both_ids() {
        let request = serde_json::json!({
            "title": "Untitled meeting",
            "consent": true,
            "devices": { "microphoneId": "mic", "outputId": "out" }
        });
        let options: CaptureOptions = serde_json::from_value(request["devices"].clone()).unwrap();
        assert_eq!(options.microphone_id, "mic");
        assert_eq!(options.output_id, "out");
        for invalid in [
            serde_json::json!({ "microphoneId": "mic" }),
            serde_json::json!({ "microphoneId": null, "outputId": "out" }),
            serde_json::json!({ "microphoneId": 42, "outputId": "out" }),
        ] {
            assert!(serde_json::from_value::<CaptureOptions>(invalid).is_err());
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "opens the microphone and a system-audio tap; run only when authorized"]
    fn macos_default_output_tap_records_a_played_tone() {
        let host = cpal::default_host();
        let mic = host.default_input_device().expect("no default microphone");
        let output = host.default_output_device().expect("no default output");
        assert!(
            !output.supports_input(),
            "default output {} has an input; this probe only covers the tap path",
            output
        );
        let options = CaptureOptions {
            microphone_id: mic.id().unwrap().to_string(),
            output_id: output.id().unwrap().to_string(),
        };
        let folder = tempfile::tempdir().unwrap();
        let tone = folder.path().join("tone.wav");
        write_probe_tone(&tone);
        let mut session = Session::prepare(folder.path().join("capture"), options, None)
            .expect("prepare should pass the permission and duplex gates");
        session.resume().expect("resume");
        let mut play = std::process::Command::new("afplay")
            .arg(&tone)
            .spawn()
            .expect("afplay");
        thread::sleep(Duration::from_secs(4));
        let _ = play.wait();
        let health = session.health();
        let report = session.stop().unwrap();
        assert!(
            report.error.is_none(),
            "{:?} health={health:?}",
            report.error
        );
        assert_eq!(report.tracks.len(), 2);
        for track in &report.tracks {
            assert!(track.finalized, "{track:?}");
            assert!(track.frames > 0, "{track:?} health={health:?}");
            let wav = hound::WavReader::open(&track.path).unwrap();
            let samples: Vec<f32> = wav
                .into_samples::<f32>()
                .map(|sample| sample.unwrap())
                .collect();
            let peak = samples
                .iter()
                .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
            eprintln!(
                "{} frames={} peak={peak:.4} path={}",
                track.kind, track.frames, track.path
            );
            if track.kind == "system" {
                assert!(
                    peak > 0.05,
                    "system tap was silent (peak {peak}). Permission or mute failure, not a pass. health={health:?}"
                );
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn write_probe_tone(path: &std::path::Path) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 48_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).unwrap();
        for i in 0..(48_000 * 3) {
            let sample = ((i as f32 / 48_000.0) * 1_000.0 * std::f32::consts::TAU).sin() * 0.4;
            writer
                .write_sample((sample * i16::MAX as f32) as i16)
                .unwrap();
        }
        writer.finalize().unwrap();
    }

    #[test]
    #[cfg(target_os = "windows")]
    #[ignore = "requires Windows audio devices; run with --ignored"]
    fn windows_devices_open_and_stop_writes_both_wavs() {
        let devices = devices().unwrap();
        assert!(devices.capture_supported);
        assert!(
            !devices.microphones.is_empty(),
            "No microphone endpoint is available. Enable microphone access or remote redirection."
        );
        assert!(
            !devices.outputs.is_empty(),
            "No system output endpoint is available."
        );
        // Default endpoints: that is where test audio actually plays.
        let host = cpal::default_host();
        let id = |d: Option<cpal::Device>| d.unwrap().id().unwrap().to_string();
        let options = CaptureOptions {
            microphone_id: id(host.default_input_device()),
            output_id: id(host.default_output_device()),
        };
        eprintln!("devices: {devices:?}\nselected: {options:?}");
        let folder = tempfile::tempdir().unwrap();
        let mut session = Session::prepare(folder.path().join("capture"), options, None).unwrap();
        // prepare() opens muted streams; the app's start() resumes immediately.
        session.resume().unwrap();
        thread::sleep(Duration::from_secs(1));
        let health = session.health();
        session.pause().unwrap();
        thread::sleep(Duration::from_millis(300));
        session.resume().unwrap();
        thread::sleep(Duration::from_millis(300));
        let report = session.stop().unwrap();
        assert!(report.error.is_none(), "{:?}", report.error);
        assert_eq!(report.tracks.len(), 2);
        for track in report.tracks {
            assert!(track.finalized);
            assert!(track.frames > 0, "{}: {:?}", track.kind, health);
            let wav = hound::WavReader::open(&track.path).unwrap();
            assert_eq!(wav.spec().channels, track.channels);
            assert_eq!(wav.len() as i64, track.frames * i64::from(track.channels));
        }
    }
    #[test]
    fn stream_failure_reports_which_device_and_why() {
        let shared = Shared::new();
        shared.recording.store(true, Ordering::SeqCst);
        // An Xrun is a recorded gap, never a stop.
        shared.fail_stream(0, cpal::ErrorKind::Xrun.into());
        assert!(shared.recording.load(Ordering::SeqCst));
        assert!(shared.error().is_none());
        assert_eq!(shared.counters[0].gaps.load(Ordering::Relaxed), 1);
        shared.fail_stream(1, cpal::ErrorKind::DeviceNotAvailable.into());
        shared.fail_stream(0, cpal::ErrorKind::Other.into());
        assert!(!shared.recording.load(Ordering::SeqCst));
        let message = shared.error().unwrap();
        assert!(message.contains("system output: The requested audio device is not available"));
        assert!(!message.contains("microphone:"));
        let timestamps = Shared::new();
        timestamps.fail(TIMESTAMP);
        assert!(timestamps.error().unwrap().contains("timestamps"));
    }
    #[test]
    fn paused_and_previous_generation_audio_is_never_accepted() {
        let shared = Shared::new();
        let (mut producer, mut consumer) = HeapRb::new(4).split();
        push_samples(&[0.5_f32; 4], 0, 1, 16000, &shared, 0, &mut producer);
        assert!(consumer.try_pop().is_none());
        shared.recording.store(true, Ordering::SeqCst);
        push_samples(&[0.5_f32; 4], 0, 1, 16000, &shared, 0, &mut producer);
        let old = consumer.try_pop().unwrap();
        assert!(accepted(&old, &shared));
        shared.mute();
        assert!(!accepted(&old, &shared));
        shared.recording.store(true, Ordering::SeqCst);
        assert!(!accepted(&old, &shared));
    }
    #[test]
    fn delayed_pre_pause_packets_never_reach_either_wav_after_resume() {
        for (index, kind) in ["mic", "system"].into_iter().enumerate() {
            let shared = Shared::new();
            let folder = tempfile::tempdir().unwrap();
            let mut writer =
                TrackWriter::create(folder.path(), kind, "Synthetic".into(), 16000, 1).unwrap();
            let (mut producer, mut consumer) = HeapRb::new(4).split();
            shared.recording.store(true, Ordering::SeqCst);
            push_samples(&[0.25_f32; 4], 0, 1, 16000, &shared, index, &mut producer);
            drain(index, &mut consumer, &mut writer, &shared);
            push_samples(&[0.75_f32; 4], 250, 1, 16000, &shared, index, &mut producer);
            let pending = consumer.try_pop().unwrap();
            let (release, waiting) = mpsc::channel();
            // Hold an old-generation packet at the callback's queue-publication boundary.
            let callback = thread::spawn(move || {
                waiting.recv_timeout(Duration::from_secs(5)).unwrap();
                assert!(producer.try_push(pending).is_ok());
                producer
            });
            shared.mute();
            shared.generation.fetch_add(1, Ordering::SeqCst);
            shared.recording.store(true, Ordering::SeqCst);
            release.send(()).unwrap();
            let mut producer = callback.join().unwrap();
            push_samples(
                &[0.5_f32; 4],
                1_000_000,
                1,
                16000,
                &shared,
                index,
                &mut producer,
            );
            drain(index, &mut consumer, &mut writer, &shared);
            let track = writer.finish(0);
            assert!(track.finalized);
            assert_eq!(track.frames, 8);
            let samples = hound::WavReader::open(&track.path)
                .unwrap()
                .samples::<f32>()
                .collect::<std::result::Result<Vec<_>, _>>()
                .unwrap();
            assert_eq!(samples, [0.25, 0.25, 0.25, 0.25, 0.5, 0.5, 0.5, 0.5]);
            let timing = fs::read_to_string(&track.timing_path).unwrap();
            let offsets: Vec<_> = timing
                .lines()
                .map(|line| {
                    serde_json::from_str::<serde_json::Value>(line).unwrap()["capture_start_us"]
                        .as_u64()
                        .unwrap()
                })
                .collect();
            assert_eq!(offsets, [0, 1_000_000]);
        }
    }

    #[test]
    fn synthetic_pause_recording_exposes_real_finalized_tracks_and_four_accepted_chunks() {
        let folder = tempfile::tempdir().unwrap();
        let (tracks, chunks) = synthetic_pause_recording_for_test(folder.path());
        assert_eq!(chunks.len(), 4);
        assert_eq!(tracks.len(), 2);
        for (index, (kind, before, after)) in [("mic", 0.25, 0.5), ("system", -0.25, -0.5)]
            .into_iter()
            .enumerate()
        {
            let track = &tracks[index];
            assert!(track.finalized);
            assert_eq!((track.kind.as_str(), track.frames), (kind, 3200));
            let samples = hound::WavReader::open(&track.path)
                .unwrap()
                .samples::<f32>()
                .map(|value| value.unwrap())
                .collect::<Vec<_>>();
            assert_eq!(samples, [vec![before; 1600], vec![after; 1600]].concat());
            let timing = crate::audio_timing::read(track, || Ok(())).unwrap();
            assert_eq!(
                timing
                    .iter()
                    .map(|block| (block.frame_offset, block.frames, block.capture_start_us))
                    .collect::<Vec<_>>(),
                [(0, 1600, 0), (1600, 1600, 8_000_000)]
            );
            assert_eq!(chunks[index].kind, kind);
            assert_eq!(chunks[index].samples, vec![before; 1600]);
            assert_eq!(chunks[index + 2].samples, vec![after; 1600]);
            assert_eq!(chunks[index + 2].timing[0].capture_start_us, 8_000_000);
            assert_ne!(chunks[index].generation, chunks[index + 2].generation);
            let materialized = chunks[index + 2].materialize().unwrap();
            let samples = hound::WavReader::open(&materialized.track.path)
                .unwrap()
                .samples::<f32>()
                .map(|value| value.unwrap())
                .collect::<Vec<_>>();
            assert_eq!(samples, vec![after; 1600]);
        }
    }

    #[test]
    fn live_chunks_materialize_only_accepted_samples_and_overflow_does_not_damage_recording() {
        let shared = Shared::new();
        let folder = tempfile::tempdir().unwrap();
        let mut writer =
            TrackWriter::create(folder.path(), "mic", "Synthetic".into(), 16000, 1).unwrap();
        let (live, receiver, incomplete) = crate::live_audio::channel();
        writer.live = Some(crate::live_audio::Accumulator::new(live, &writer.track));
        let (mut producer, mut consumer) = HeapRb::new(4).split();
        shared.recording.store(true, Ordering::SeqCst);
        push_samples(
            &[0.25_f32; 4],
            1_000_000,
            1,
            16000,
            &shared,
            0,
            &mut producer,
        );
        drain(0, &mut consumer, &mut writer, &shared);
        writer.live.as_mut().unwrap().flush();
        push_samples(
            &[0.75_f32; 4],
            1_000_250,
            1,
            16000,
            &shared,
            0,
            &mut producer,
        );
        shared.mute();
        shared.generation.fetch_add(1, Ordering::SeqCst);
        shared.recording.store(true, Ordering::SeqCst);
        drain(0, &mut consumer, &mut writer, &shared);
        for index in 0..4 {
            push_samples(
                &[0.5_f32; 4],
                2_000_000 + index * 250,
                1,
                16000,
                &shared,
                0,
                &mut producer,
            );
            drain(0, &mut consumer, &mut writer, &shared);
            writer.live.as_mut().unwrap().flush();
        }
        let track = writer.finish(0);
        assert!(track.finalized);
        let recorded = hound::WavReader::open(&track.path)
            .unwrap()
            .samples::<f32>()
            .map(|v| v.unwrap())
            .collect::<Vec<_>>();
        assert_eq!(recorded, [vec![0.25; 4], vec![0.5; 16]].concat());
        assert!(incomplete.load(Ordering::SeqCst));
        let chunks: Vec<_> = receiver.try_iter().collect();
        assert_eq!(chunks.len(), 3);
        let materialized = chunks[0].materialize().unwrap();
        let samples = hound::WavReader::open(&materialized.track.path)
            .unwrap()
            .samples::<f32>()
            .map(|v| v.unwrap())
            .collect::<Vec<_>>();
        assert_eq!(samples, [0.25; 4]);
        let timing = crate::audio_timing::read(&materialized.track, || Ok(())).unwrap();
        assert_eq!(
            (
                timing[0].frame_offset,
                timing[0].frames,
                timing[0].capture_start_us
            ),
            (0, 4, 1_000_000)
        );
        assert_eq!(chunks[1].samples, [0.5; 4]);
        assert_eq!(chunks[1].timing[0].capture_start_us, 2_000_000);
        assert_ne!(chunks[0].generation, chunks[1].generation);
    }

    #[test]
    fn timing_write_failure_keeps_the_track_incomplete_and_preserves_artifacts() {
        let shared = Shared::new();
        let folder = tempfile::tempdir().unwrap();
        let mut writer =
            TrackWriter::create(folder.path(), "mic", "Synthetic".into(), 16000, 1).unwrap();
        let (mut producer, mut consumer) = HeapRb::new(4).split();
        shared.recording.store(true, Ordering::SeqCst);
        push_samples(&[0.25_f32; 4], 0, 1, 16000, &shared, 0, &mut producer);
        drain(0, &mut consumer, &mut writer, &shared);
        writer.checkpoint().unwrap();
        let original_timing = fs::read(&writer.track.timing_path).unwrap();
        writer.timing = BufWriter::with_capacity(0, File::open(&writer.track.timing_path).unwrap());
        push_samples(&[0.75_f32; 4], 250, 1, 16000, &shared, 0, &mut producer);
        drain(0, &mut consumer, &mut writer, &shared);
        assert!(!shared.recording.load(Ordering::SeqCst));
        assert!(shared.error().unwrap().contains("disk write"));
        assert_eq!(shared.counters[0].frames.load(Ordering::Relaxed), 4);
        let track = writer.finish(0);
        assert!(
            !track.finalized,
            "A missing timing entry must not become a successful track at stop"
        );
        assert_eq!(fs::read(&track.timing_path).unwrap(), original_timing);
        let samples = hound::WavReader::open(&track.path)
            .unwrap()
            .samples::<f32>()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(samples, [0.25, 0.25, 0.25, 0.25, 0.75, 0.75, 0.75, 0.75]);
    }

    #[test]
    fn a_later_successful_flush_does_not_hide_an_earlier_checkpoint_failure() {
        let folder = tempfile::tempdir().unwrap();
        let mut writer =
            TrackWriter::create(folder.path(), "system", "Synthetic".into(), 16000, 1).unwrap();
        writer.timing = BufWriter::new(File::open(&writer.track.timing_path).unwrap());
        let shared = Shared::new();
        let (mut producer, mut consumer) = HeapRb::new(4).split();
        shared.recording.store(true, Ordering::SeqCst);
        push_samples(&[0.5_f32; 4], 0, 1, 16000, &shared, 1, &mut producer);
        drain(1, &mut consumer, &mut writer, &shared);
        assert!(writer.checkpoint().is_err());
        writer.timing = BufWriter::new(
            OpenOptions::new()
                .append(true)
                .open(&writer.track.timing_path)
                .unwrap(),
        );
        writer.checkpoint().unwrap();
        let track = writer.finish(0);
        assert!(!track.finalized);
        assert_eq!(track.frames, 4);
        assert_eq!(fs::read(&track.timing_path).unwrap(), b"");
        let samples = hound::WavReader::open(&track.path)
            .unwrap()
            .samples::<f32>()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(samples, [0.5; 4]);
    }

    #[test]
    fn paused_marker_samples_never_reach_prepared_cloud_uploads() {
        use crate::{cloud_stt, domain::SegmentTiming};
        let shared = Shared::new();
        let folder = tempfile::tempdir().unwrap();
        let mut writers: Vec<_> = ["mic", "system"]
            .into_iter()
            .map(|kind| {
                TrackWriter::create(folder.path(), kind, "Synthetic".into(), 16000, 1).unwrap()
            })
            .collect();
        let mut queues: Vec<_> = (0..2).map(|_| HeapRb::new(QUEUE_BLOCKS).split()).collect();
        shared.recording.store(true, Ordering::SeqCst);
        for (index, value) in [0.25_f32, -0.25].into_iter().enumerate() {
            push_samples(
                &vec![value; 16000],
                0,
                1,
                16000,
                &shared,
                index,
                &mut queues[index].0,
            );
            drain(index, &mut queues[index].1, &mut writers[index], &shared);
            push_samples(
                &[0.75_f32; 4],
                1_000_000,
                1,
                16000,
                &shared,
                index,
                &mut queues[index].0,
            );
        }
        shared.mute();
        for index in 0..2 {
            push_samples(
                &[0.9_f32; 4],
                2_000_000,
                1,
                16000,
                &shared,
                index,
                &mut queues[index].0,
            );
            drain(index, &mut queues[index].1, &mut writers[index], &shared);
        }
        shared.generation.fetch_add(1, Ordering::SeqCst);
        shared.recording.store(true, Ordering::SeqCst);
        for (index, value) in [0.5_f32, -0.5].into_iter().enumerate() {
            push_samples(
                &vec![value; 16000],
                8_000_000,
                1,
                16000,
                &shared,
                index,
                &mut queues[index].0,
            );
            drain(index, &mut queues[index].1, &mut writers[index], &shared);
        }
        let tracks: Vec<_> = writers.into_iter().map(|writer| writer.finish(0)).collect();
        assert!(tracks
            .iter()
            .all(|track| track.finalized && track.frames == 32000));
        let plan = cloud_stt::plan(&tracks).unwrap();
        assert_eq!(plan.requests, 4);
        let response = r#"{"text":"Fictional marker","segments":[{"text":"Fictional marker","start":0.0,"end":1.0}]}"#.to_string();
        let (connection, server, requests) = cloud_stt::tests::serve(vec![response; 4]);
        let segments = cloud_stt::transcribe(
            &connection,
            &tracks,
            "auto",
            "",
            &plan,
            &AtomicBool::new(false),
            |_, _| {},
            |_, _| Ok(()),
        )
        .unwrap();
        server.join().unwrap();
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 4);
        for (request, expected) in requests.iter().zip([8192_i16, 16384, -8192, -16384]) {
            let start = request
                .windows(4)
                .position(|bytes| bytes == b"RIFF")
                .unwrap();
            let reader = hound::WavReader::new(std::io::Cursor::new(&request[start..])).unwrap();
            assert_eq!(reader.spec().sample_rate, 16000);
            assert_eq!(reader.spec().channels, 1);
            let samples: Vec<i16> = reader
                .into_samples()
                .collect::<std::result::Result<_, _>>()
                .unwrap();
            assert_eq!(samples, vec![expected; 16000]);
        }
        let times: Vec<_> = segments
            .iter()
            .map(|segment| {
                let SegmentTiming::Timed { start_ms, end_ms } = segment.timing else {
                    panic!("Synthetic timed response lost its timing");
                };
                (segment.speaker.as_str(), start_ms, end_ms)
            })
            .collect();
        assert_eq!(
            times,
            [
                ("Others", 0, 1000),
                ("You", 0, 1000),
                ("Others", 8000, 9000),
                ("You", 8000, 9000)
            ]
        );
    }

    #[test]
    fn queue_overflow_disarms_both_tracks() {
        let shared = Shared::new();
        shared.recording.store(true, Ordering::SeqCst);
        let (mut producer, _consumer) = HeapRb::new(1).split();
        push_samples(
            &[0.5_f32; BLOCK_SAMPLES * 2],
            0,
            2,
            48000,
            &shared,
            0,
            &mut producer,
        );
        assert!(!shared.recording.load(Ordering::SeqCst));
        assert!(shared.error().unwrap().contains("overflowed"));
        assert_eq!(shared.counters[0].dropped.load(Ordering::Relaxed), 1024);
    }

    #[test]
    fn stop_rejects_new_callbacks_but_preserves_already_captured_samples() {
        let shared = Shared::new();
        shared.recording.store(true, Ordering::SeqCst);
        let folder = tempfile::tempdir().unwrap();
        let mut writer =
            TrackWriter::create(folder.path(), "mic", "Synthetic".into(), 16000, 1).unwrap();
        let (mut producer, mut consumer) = HeapRb::new(4).split();
        push_samples(&[0.25_f32; 4], 0, 1, 16000, &shared, 0, &mut producer);
        shared.stopping.store(true, Ordering::SeqCst);
        push_samples(&[0.75_f32; 4], 250, 1, 16000, &shared, 0, &mut producer);
        drain(0, &mut consumer, &mut writer, &shared);
        let track = writer.finish(0);
        assert!(track.finalized);
        let samples = hound::WavReader::open(&track.path)
            .unwrap()
            .samples::<f32>()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(samples, [0.25; 4]);
    }
    #[test]
    fn converts_samples_without_losing_frame_timing() {
        let shared = Shared::new();
        shared.recording.store(true, Ordering::SeqCst);
        let (mut producer, mut consumer) = HeapRb::new(4).split();
        push_samples(
            &[i16::MAX; BLOCK_SAMPLES * 2],
            100,
            2,
            48000,
            &shared,
            0,
            &mut producer,
        );
        let first = consumer.try_pop().unwrap();
        let second = consumer.try_pop().unwrap();
        assert!((first.samples[0] - 1.0).abs() < 0.001);
        assert_eq!(second.start_us, 100 + 1024 * 1_000_000 / 48000);
    }
    #[test]
    fn truncated_wavs_are_repaired_into_new_copies_with_whole_frames() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("synthetic.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 48000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let samples: Vec<f32> = (0..2000).map(|i| (i as f32 / 2000.0) - 0.5).collect();
        let mut writer = hound::WavWriter::create(&source, spec).unwrap();
        for sample in &samples {
            writer.write_sample(*sample).unwrap();
        }
        writer.finalize().unwrap();
        let mut finished = fs::read(&source).unwrap();
        let data_start = finished.windows(4).position(|w| w == b"data").unwrap() + 8;
        // An interrupted writer leaves zero (or stale) sizes in the header.
        finished[4..8].fill(0);
        finished[data_start - 4..data_start].fill(0);
        for (case, cut) in [
            data_start,               // header only
            data_start + 3,           // partial first sample
            data_start + 8 * 100,     // whole frames
            data_start + 8 * 250 + 5, // mid-frame
            finished.len(),           // nothing lost, header still broken
        ]
        .into_iter()
        .enumerate()
        {
            let original = dir.path().join(format!("mic-{case}.wav"));
            fs::write(&original, &finished[..cut]).unwrap();
            let copy = dir.path().join(format!("mic-{case}.recovered.wav"));
            let frames = repair_wav(&original, &copy).unwrap() as usize;
            assert_eq!(frames, (cut - data_start) / 8, "cut at {cut}");
            let mut reader = hound::WavReader::open(&copy).unwrap();
            assert_eq!(reader.spec(), spec);
            assert_eq!(reader.len() as usize, frames * 2);
            let recovered: Vec<f32> = reader.samples().map(|s| s.unwrap()).collect();
            assert_eq!(recovered, samples[..frames * 2]);
            assert_eq!(
                fs::read(&original).unwrap(),
                &finished[..cut],
                "original untouched"
            );
            assert_eq!(
                repair_wav(&original, &copy).unwrap_err().code,
                "recovery_exists"
            );
        }
        let garbage = dir.path().join("garbage.wav");
        fs::write(&garbage, b"not a wav file").unwrap();
        assert!(repair_wav(&garbage, &dir.path().join("garbage.recovered.wav")).is_err());
        assert!(!dir.path().join("garbage.recovered.wav").exists());
    }

    #[test]
    fn recording_offset_counts_written_frames_and_excludes_paused_audio() {
        let shared = Shared::new();
        let folder = tempfile::tempdir().unwrap();
        let mut writer =
            TrackWriter::create(folder.path(), "mic", "Synthetic".into(), 16000, 1).unwrap();
        let (mut producer, mut consumer) = HeapRb::new(QUEUE_BLOCKS).split();
        let second = [0.25_f32; 16000];
        shared.recording.store(true, Ordering::SeqCst);
        push_samples(&second, 0, 1, 16000, &shared, 0, &mut producer);
        drain(0, &mut consumer, &mut writer, &shared);
        assert_eq!(shared.offset_ms(16000), 1000);
        // A packet queued when the user pauses, then audio arriving while paused.
        push_samples(
            &[0.75_f32; 16000],
            1_000_000,
            1,
            16000,
            &shared,
            0,
            &mut producer,
        );
        shared.mute();
        push_samples(
            &[0.9_f32; 16000],
            2_000_000,
            1,
            16000,
            &shared,
            0,
            &mut producer,
        );
        drain(0, &mut consumer, &mut writer, &shared);
        assert_eq!(
            shared.offset_ms(16000),
            1000,
            "paused audio must not advance the offset"
        );
        // Resume (as the worker does): new generation, half a second more, ten seconds later.
        shared.generation.fetch_add(1, Ordering::SeqCst);
        shared.recording.store(true, Ordering::SeqCst);
        push_samples(
            &[0.5_f32; 8000],
            12_000_000,
            1,
            16000,
            &shared,
            0,
            &mut producer,
        );
        drain(0, &mut consumer, &mut writer, &shared);
        assert_eq!(shared.offset_ms(16000), 1500);
        assert_eq!(writer.track.frames, 24000);
        assert_eq!(
            shared.offset_ms(0),
            24_000_000,
            "a zero rate cannot divide by zero"
        );
        let track = writer.finish(0);
        assert!(track.finalized);
        let samples = hound::WavReader::open(&track.path)
            .unwrap()
            .samples::<f32>()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        let expected: Vec<_> = std::iter::repeat_n(0.25, 16000)
            .chain(std::iter::repeat_n(0.5, 8000))
            .collect();
        assert_eq!(
            samples, expected,
            "queued or paused marker samples must never reach the WAV"
        );
    }
}
