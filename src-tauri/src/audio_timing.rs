//! Validated recording timing shared by local transcription, cloud preparation, and seeking.
use crate::{
    audio::Track,
    domain::{AppError, Result},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{BufRead, BufReader, Read},
};

const MAX_INDEX_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const CLOCK_TOLERANCE_US: u64 = 2000;
// ponytail: fixed bound from measured WASAPI/Bluetooth jitter (≤ 17 ms); raise if a device exceeds it.
const JITTER_US: u64 = 30_000;

fn error(message: &str) -> AppError {
    AppError::new("audio_timing", message)
}

fn unreadable(_: std::io::Error) -> AppError {
    error("The audio timing index could not be read. Originals and previous transcripts are unchanged.")
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Block {
    pub(crate) frame_offset: u64,
    pub(crate) frames: u64,
    pub(crate) capture_start_us: u64,
    #[serde(default)]
    pub(crate) generation: Option<u64>,
}

pub(crate) fn read(
    track: &Track,
    mut check_cancel: impl FnMut() -> Result<()>,
) -> Result<Vec<Block>> {
    check_cancel()?;
    if track.sample_rate == 0 || track.frames <= 0 {
        return Err(error("The recording has invalid timing metadata."));
    }
    let file = File::open(&track.timing_path).map_err(unreadable)?;
    if file.metadata().map_err(unreadable)?.len() > MAX_INDEX_BYTES {
        return Err(error(
            "The audio timing index exceeds the supported size. Originals and previous transcripts are unchanged.",
        ));
    }
    let mut reader = BufReader::new(file);
    let mut blocks: Vec<Block> = Vec::new();
    let mut offset = 0_u64;
    let mut consumed = 0_u64;
    let mut previous_raw_start = 0_u64;
    loop {
        if blocks.len().is_multiple_of(4096) {
            check_cancel()?;
        }
        let mut line = Vec::new();
        reader
            .by_ref()
            .take(1025)
            .read_until(b'\n', &mut line)
            .map_err(unreadable)?;
        if line.is_empty() {
            break;
        }
        consumed += line.len() as u64;
        if consumed > MAX_INDEX_BYTES {
            return Err(error("The audio timing index exceeds the supported size."));
        }
        if line.len() > 1024 {
            return Err(error(
                "The audio timing index is malformed. Originals and previous transcripts are unchanged.",
            ));
        }
        let mut block: Block = serde_json::from_slice(&line)
            .map_err(|_| error("The audio timing index is malformed. Originals and previous transcripts are unchanged."))?;
        let end_us = block
            .capture_start_us
            .checked_add(
                block
                    .frames
                    .checked_mul(1_000_000)
                    .ok_or_else(|| error("Invalid audio timing range."))?
                    / u64::from(track.sample_rate),
            )
            .ok_or_else(|| error("Invalid audio timing range."))?;
        if block.frame_offset != offset || block.frames == 0 || end_us / 1000 > i64::MAX as u64 {
            return Err(error(
                "The audio timing index does not match the recording. Originals and previous transcripts are unchanged.",
            ));
        }
        let raw_start = block.capture_start_us;
        if let Some(previous) = blocks.last() {
            let duration = |frames: u64| frames * 1_000_000 / u64::from(track.sample_rate);
            let previous_end = previous.capture_start_us + duration(previous.frames);
            // Packet stamps jitter by about ±11 ms on real devices, so judge overlap on the raw
            // stamps with JITTER_US, then lay jittered packets end to end. Larger gaps are kept.
            if raw_start.saturating_add(JITTER_US) < previous_raw_start + duration(previous.frames)
            {
                return Err(error(
                    "Audio timestamps overlap or move backwards. Originals and previous transcripts are unchanged.",
                ));
            }
            if raw_start <= previous_end + JITTER_US {
                block.capture_start_us = previous_end;
            }
        }
        previous_raw_start = raw_start;
        offset = offset
            .checked_add(block.frames)
            .ok_or_else(|| error("Invalid audio frame count."))?;
        blocks.push(block);
    }
    if blocks.is_empty() || offset != track.frames as u64 {
        return Err(error(
            "The audio timing index is incomplete. Originals and previous transcripts are unchanged.",
        ));
    }
    Ok(blocks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn track(path: &std::path::Path, frames: i64) -> Track {
        Track {
            kind: "mic".into(),
            path: "unused.wav".into(),
            timing_path: path.to_string_lossy().into(),
            device_name: "Synthetic".into(),
            sample_rate: 16000,
            channels: 1,
            frames,
            dropped_frames: 0,
            finalized: true,
            size_bytes: None,
        }
    }

    #[test]
    fn reads_complete_pause_timing_and_preserves_legacy_generation_omission() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("timing.jsonl");
        let original = b"{\"frame_offset\":0,\"frames\":16000,\"capture_start_us\":1000000,\"generation\":1}\n{\"frame_offset\":16000,\"frames\":16000,\"capture_start_us\":8000000}\n";
        fs::write(&path, original).unwrap();
        let blocks = read(&track(&path, 32000), || Ok(())).unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].generation, Some(1));
        assert_eq!(blocks[1].generation, None);
        assert_eq!(blocks[1].capture_start_us, 8_000_000);
        assert_eq!(fs::read(path).unwrap(), original);
    }

    #[test]
    fn lays_jittered_device_stamps_end_to_end_and_keeps_real_gaps() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("timing.jsonl");
        // Stamps from a real Bluetooth microphone: the third moves backwards by about 1 ms.
        let stamps = [43_218, 61_236, 60_296, 70_338, 5_000_000];
        let lines: String = stamps
            .iter()
            .enumerate()
            .map(|(i, us)| {
                format!(
                    "{{\"frame_offset\":{},\"frames\":160,\"capture_start_us\":{us},\"generation\":1}}\n",
                    i * 160
                )
            })
            .collect();
        fs::write(&path, lines).unwrap();
        let starts: Vec<u64> = read(&track(&path, 800), || Ok(()))
            .unwrap()
            .iter()
            .map(|block| block.capture_start_us)
            .collect();
        assert_eq!(starts, [43_218, 53_218, 63_218, 73_218, 5_000_000]);
    }

    #[test]
    fn rejects_missing_malformed_incomplete_and_out_of_order_timing_without_edits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("timing.jsonl");
        let track = track(&path, 32000);
        assert_eq!(read(&track, || Ok(())).err().unwrap().code, "audio_timing");
        for input in [
            "",
            "not json\n",
            "{\"frame_offset\":0,\"frames\":-1,\"capture_start_us\":0}\n",
            "{\"frame_offset\":0,\"frames\":0,\"capture_start_us\":0}\n",
            "{\"frame_offset\":1,\"frames\":32000,\"capture_start_us\":0}\n",
            "{\"frame_offset\":0,\"frames\":16000,\"capture_start_us\":0}\n",
            "{\"frame_offset\":0,\"frames\":32001,\"capture_start_us\":0}\n",
            "{\"frame_offset\":0,\"frames\":16000,\"capture_start_us\":1000000}\n{\"frame_offset\":16000,\"frames\":16000,\"capture_start_us\":0}\n",
            "{\"frame_offset\":0,\"frames\":16000,\"capture_start_us\":1000000}\n{\"frame_offset\":16000,\"frames\":16000,\"capture_start_us\":1500000}\n",
            "{\"frame_offset\":0,\"frames\":32000,\"capture_start_us\":0}\n{partial",
            "{\"frame_offset\":0,\"frames\":32000,\"capture_start_us\":18446744073709551615}\n",
        ] {
            fs::write(&path, input).unwrap();
            assert_eq!(read(&track, || Ok(())).err().unwrap().code, "audio_timing", "{input}");
            assert_eq!(fs::read(&path).unwrap(), input.as_bytes());
        }
        fs::write(&path, vec![b' '; 1025]).unwrap();
        assert!(read(&track, || Ok(())).is_err());
        let mut zero_rate = track.clone();
        zero_rate.sample_rate = 0;
        assert!(read(&zero_rate, || Ok(())).is_err());
    }

    #[test]
    fn bounds_index_size_and_checks_cancellation_before_file_access() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("timing.jsonl");
        let track = track(&path, 16000);
        let cancelled = read(&track, || {
            Err(AppError::new("stt_cancelled", "Synthetic cancellation"))
        });
        assert_eq!(cancelled.err().unwrap().code, "stt_cancelled");
        let file = File::create(&path).unwrap();
        file.set_len(MAX_INDEX_BYTES + 1).unwrap();
        assert!(read(&track, || Ok(())).is_err());
        assert_eq!(file.metadata().unwrap().len(), MAX_INDEX_BYTES + 1);
    }
}
