//! Windows two-track capture. Device callbacks only convert into bounded SPSC queues.
//! WAV and timing-index writes run on a dedicated owner thread, never a callback.
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
        // CoreAudio duplex outputs need a separately validated tap adapter, not input capture.
        capture_supported: cfg!(target_os = "windows"),
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
    if !shared.recording.load(Ordering::SeqCst) {
        return;
    }
    let generation = shared.generation.load(Ordering::SeqCst);
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
        if !shared.recording.load(Ordering::SeqCst) {
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
    if !cfg!(target_os = "windows") {
        return Err(audio_error(
            "Real capture is currently Windows-only. macOS tap validation is still pending.",
        ));
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
        Ok(())
    }
    fn checkpoint(&mut self) -> Result<()> {
        self.wav.flush().map_err(audio_error)?;
        self.timing.flush()?;
        Ok(())
    }
    fn finish(mut self, dropped: u64) -> Track {
        self.track.dropped_frames = dropped.min(i64::MAX as u64) as i64;
        let timing_ok = self.timing.flush().is_ok();
        let wav_ok = self.wav.finalize().is_ok();
        self.track.finalized = timing_ok && wav_ok;
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
    pub fn prepare(folder: PathBuf, options: CaptureOptions) -> Result<Self> {
        let shared = Arc::new(Shared::new());
        let worker_shared = shared.clone();
        let (commands, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let handle = thread::Builder::new()
            .name("openmeet-audio".into())
            .spawn(move || worker(folder, options, worker_shared, rx, ready_tx))?;
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
        let (tx, rx) = mpsc::channel();
        self.commands
            .send(Command::Pause(tx))
            .map_err(audio_error)?;
        rx.recv().map_err(audio_error)?
    }
    pub fn resume(&self) -> Result<()> {
        if let Some(error) = self.shared.error() {
            return Err(audio_error(error));
        }
        let (tx, rx) = mpsc::channel();
        self.commands
            .send(Command::Resume(tx))
            .map_err(audio_error)?;
        rx.recv().map_err(audio_error)?
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
        let _ = self.commands.send(Command::Stop);
        let handle = self
            .thread
            .take()
            .ok_or_else(|| audio_error("Capture has already stopped"))?;
        handle
            .join()
            .map_err(|_| audio_error("Capture worker failed; partial files are retained"))
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.shared.mute();
        let _ = self.commands.send(Command::Stop);
    }
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
    let _ = ready.send(Ok(writers.iter().map(|w| w.track.clone()).collect()));
    let mut checkpoint = Instant::now();
    let mut last_tick = SystemTime::now();
    loop {
        let mut stopping = false;
        match commands.try_recv() {
            Ok(Command::Stop) | Err(mpsc::TryRecvError::Disconnected) => stopping = true,
            Ok(Command::Pause(reply)) => {
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

    #[test]
    fn frontend_device_payload_preserves_both_ids() {
        let request = serde_json::json!({
            "title": "Untitled meeting",
            "simulation": false,
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
        let mut session = Session::prepare(folder.path().join("capture"), options).unwrap();
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
        // A packet in flight when the user pauses, then audio arriving while paused.
        push_samples(&second, 1_000_000, 1, 16000, &shared, 0, &mut producer);
        shared.mute();
        push_samples(&second, 2_000_000, 1, 16000, &shared, 0, &mut producer);
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
            &second[..8000],
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
    }
}
