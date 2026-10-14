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
        let block: Block = serde_json::from_slice(&line)
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
        if let Some(previous) = blocks.last() {
            let previous_end = previous.capture_start_us
                + previous.frames * 1_000_000 / u64::from(track.sample_rate);
            if block.capture_start_us < previous.capture_start_us
                || block.capture_start_us.saturating_add(CLOCK_TOLERANCE_US) < previous_end
            {
                return Err(error(
                    "Audio timestamps overlap or move backwards. Originals and previous transcripts are unchanged.",
                ));
            }
        }
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
