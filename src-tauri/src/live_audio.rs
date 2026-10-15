//! Live copies originate only in the recording writer after successful persistence.
use crate::{audio::Track, audio_timing::Block, domain::Result};
use std::{
    io::Write,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc,
    },
};
const MAX_SAMPLES: usize = 1_000_000;
const MAX_TIMING_ENTRIES: usize = 4096;
#[derive(Clone)]
pub struct Producer {
    sender: SyncSender<Chunk>,
    incomplete: Arc<AtomicBool>,
    next: Arc<AtomicU64>,
}
pub struct Chunk {
    pub kind: String,
    pub chunk_id: u64,
    pub generation: u64,
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: Vec<f32>,
    pub(crate) timing: Vec<Block>,
}
pub struct TempChunk {
    pub track: Track,
    _directory: tempfile::TempDir,
}
pub fn channel() -> (Producer, Receiver<Chunk>, Arc<AtomicBool>) {
    let (sender, receiver) = mpsc::sync_channel(3);
    let incomplete = Arc::new(AtomicBool::new(false));
    (
        Producer {
            sender,
            incomplete: incomplete.clone(),
            next: Arc::new(AtomicU64::new(0)),
        },
        receiver,
        incomplete,
    )
}
pub(crate) struct Accumulator {
    producer: Producer,
    chunk: Chunk,
}
impl Accumulator {
    pub(crate) fn new(producer: Producer, track: &Track) -> Self {
        Self {
            producer,
            chunk: Chunk {
                kind: track.kind.clone(),
                chunk_id: 0,
                generation: 0,
                sample_rate: track.sample_rate,
                channels: track.channels,
                samples: Vec::with_capacity(MAX_SAMPLES),
                timing: Vec::with_capacity(MAX_TIMING_ENTRIES),
            },
        }
    }
    pub(crate) fn accept(&mut self, samples: &[f32], generation: u64, capture_start_us: u64) {
        let discontinuity = self.chunk.timing.last().is_some_and(|last| {
            let expected = u128::from(last.capture_start_us)
                + u128::from(last.frames) * 1_000_000 / u128::from(self.chunk.sample_rate);
            expected.abs_diff(u128::from(capture_start_us))
                > u128::from(crate::audio_timing::CLOCK_TOLERANCE_US)
        });
        if discontinuity
            || self.chunk.timing.len() >= MAX_TIMING_ENTRIES
            || self.chunk.generation != generation
            || self.chunk.samples.len() + samples.len() > MAX_SAMPLES
        {
            self.flush();
        }
        self.chunk.generation = generation;
        // Coalesce adjacent packets so tiny callbacks cannot grow the timing index without bound.
        let offset = self.chunk.samples.len() as u64 / u64::from(self.chunk.channels);
        let frames = samples.len() as u64 / u64::from(self.chunk.channels);
        if let Some(last) = self.chunk.timing.last_mut().filter(|last| {
            u128::from(last.capture_start_us)
                + u128::from(last.frames) * 1_000_000 / u128::from(self.chunk.sample_rate)
                == u128::from(capture_start_us)
        }) {
            last.frames += frames;
        } else {
            self.chunk.timing.push(Block {
                frame_offset: offset,
                frames,
                capture_start_us,
                generation: Some(generation),
            });
        }
        self.chunk.samples.extend_from_slice(samples);
        let target = (u64::from(self.chunk.sample_rate) * u64::from(self.chunk.channels) * 10)
            .min(MAX_SAMPLES as u64) as usize;
        if self.chunk.samples.len() >= target {
            self.flush();
        }
    }
    pub(crate) fn flush(&mut self) {
        if self.chunk.samples.is_empty() {
            return;
        }
        let chunk = Chunk {
            kind: self.chunk.kind.clone(),
            chunk_id: self.producer.next.fetch_add(1, Ordering::Relaxed),
            generation: self.chunk.generation,
            sample_rate: self.chunk.sample_rate,
            channels: self.chunk.channels,
            samples: std::mem::replace(&mut self.chunk.samples, Vec::with_capacity(MAX_SAMPLES)),
            timing: std::mem::replace(
                &mut self.chunk.timing,
                Vec::with_capacity(MAX_TIMING_ENTRIES),
            ),
        };
        if self.producer.sender.try_send(chunk).is_err() {
            self.producer.incomplete.store(true, Ordering::SeqCst);
        }
    }
}
impl Chunk {
    pub fn materialize(&self) -> Result<TempChunk> {
        if self.sample_rate == 0
            || self.channels == 0
            || self.samples.is_empty()
            || !self
                .samples
                .len()
                .is_multiple_of(usize::from(self.channels))
        {
            return Err(crate::domain::AppError::new(
                "audio",
                "Live audio metadata is invalid.",
            ));
        }
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("audio.wav");
        let timing_path = directory.path().join("audio.timing.jsonl");
        let mut wav = hound::WavWriter::create(
            &path,
            hound::WavSpec {
                channels: self.channels,
                sample_rate: self.sample_rate,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            },
        )
        .map_err(|_| crate::domain::AppError::new("audio", "Could not create live audio copy."))?;
        for sample in &self.samples {
            wav.write_sample(*sample).map_err(|_| {
                crate::domain::AppError::new("audio", "Could not write live audio copy.")
            })?;
        }
        wav.finalize().map_err(|_| {
            crate::domain::AppError::new("audio", "Could not finalize live audio copy.")
        })?;
        let mut timing = std::fs::File::create(&timing_path)?;
        for block in &self.timing {
            serde_json::to_writer(&mut timing, block).map_err(|_| {
                crate::domain::AppError::new("audio", "Could not write live timing copy.")
            })?;
            writeln!(timing)?;
        }
        Ok(TempChunk {
            track: Track {
                kind: self.kind.clone(),
                path: path.to_string_lossy().into_owned(),
                timing_path: timing_path.to_string_lossy().into_owned(),
                device_name: "Accepted recording samples".into(),
                sample_rate: self.sample_rate,
                channels: self.channels,
                frames: (self.samples.len() / usize::from(self.channels)) as i64,
                dropped_frames: 0,
                finalized: true,
                size_bytes: Some(std::fs::metadata(path)?.len()),
            },
            _directory: directory,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn track() -> Track {
        Track {
            kind: "mic".into(),
            path: String::new(),
            timing_path: String::new(),
            device_name: "Synthetic".into(),
            sample_rate: 192000,
            channels: 1,
            frames: 0,
            dropped_frames: 0,
            finalized: false,
            size_bytes: None,
        }
    }
    #[test]
    fn sample_and_timing_limits_seal_before_accumulators_can_grow() {
        let (producer, receiver, incomplete) = channel();
        let mut accumulator = Accumulator::new(producer, &track());
        accumulator.accept(&vec![0.25; 600_000], 1, 0);
        accumulator.accept(&vec![0.5; 500_000], 1, 3_125_000);
        let sealed = receiver.try_recv().unwrap();
        assert_eq!(sealed.samples.len(), 600_000);
        assert_eq!(sealed.samples[599_999], 0.25);
        assert_eq!(accumulator.chunk.samples.len(), 500_000);
        accumulator.flush();
        assert_eq!(receiver.try_recv().unwrap().samples.len(), 500_000);
        for index in 0..4097 {
            accumulator.accept(&[0.75], 2, 10_000_000 + index * 6);
        }
        let sealed = receiver.try_recv().unwrap();
        assert_eq!(sealed.samples, vec![0.75; 4096]);
        assert_eq!(sealed.timing.len(), 4096);
        assert_eq!(accumulator.chunk.samples, [0.75]);
        assert!(accumulator.chunk.samples.capacity() <= 1_000_000);
        assert!(accumulator.chunk.timing.capacity() <= 4096);
        assert!(!incomplete.load(Ordering::SeqCst));
    }
}
