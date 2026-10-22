//! Windows system track: process loopback of every app except OpenMeet's own process
//! tree. It follows audio to whichever endpoint renders it, so a Bluetooth headset that
//! switches to its hands-free endpoint during a call is still captured.
use super::{audio_error, push_samples, Block, Shared};
use crate::domain::Result;
use ringbuf::HeapProd;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use wasapi::{
    AudioCaptureClient, AudioClient, Direction, Handle, SampleType, StreamMode, WaveFormat,
};

pub(crate) const ID: &str = "app-audio";
pub(super) const NAME: &str = "All app audio (except OpenMeet)";
pub(super) const RATE: u32 = 48_000;
pub(super) const CHANNELS: u16 = 2;

pub(super) struct AppLoopback {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

struct Client {
    audio: AudioClient,
    capture: AudioCaptureClient,
    event: Handle,
}

fn open() -> Result<Client> {
    let failed = |error: wasapi::WasapiError| audio_error(format!("app audio: {error}"));
    wasapi::initialize_mta().ok().map_err(audio_error)?;
    let mut audio =
        AudioClient::new_application_loopback_client(std::process::id(), false).map_err(failed)?;
    let format = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        RATE as usize,
        usize::from(CHANNELS),
        None,
    );
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: 0,
    };
    audio
        .initialize_client(&format, &Direction::Capture, &mode)
        .map_err(failed)?;
    let event = audio.set_get_eventhandle().map_err(failed)?;
    let capture = audio.get_audiocaptureclient().map_err(failed)?;
    audio.start_stream().map_err(failed)?;
    Ok(Client {
        audio,
        capture,
        event,
    })
}

/// Reads packets on this thread into buffers allocated once, then hands them to the same
/// bounded queue the device callbacks use.
fn run(
    client: Client,
    stop: &AtomicBool,
    shared: &Shared,
    index: usize,
    producer: &mut HeapProd<Block>,
) {
    let second = RATE as usize * usize::from(CHANNELS);
    let (mut bytes, mut samples) = (vec![0_u8; second * 4], vec![0_f32; second]);
    // ponytail: anchored at the first read, so the engine latency (~10 ms) is a constant offset.
    let mut anchor: Option<(u64, u64)> = None;
    while !stop.load(Ordering::SeqCst) {
        if client.event.wait_for_event(100).is_err() {
            continue; // Nothing rendered in this period; check the stop flag again.
        }
        loop {
            let (frames, info) = match client
                .capture
                .get_next_packet_size()
                .and_then(|_| client.capture.read_from_device(&mut bytes))
            {
                Ok(read) => read,
                Err(error) => {
                    shared.fail_with(index, &error.to_string());
                    return;
                }
            };
            if frames == 0 {
                break;
            }
            let count = frames as usize * usize::from(CHANNELS);
            if info.flags.silent {
                samples[..count].fill(0.0);
            } else {
                for (sample, raw) in samples[..count].iter_mut().zip(bytes.as_chunks::<4>().0) {
                    *sample = f32::from_le_bytes(*raw);
                }
            }
            if info.flags.data_discontinuity {
                shared.counters[index].gaps.fetch_add(1, Ordering::Relaxed);
            }
            let stamp_us = info.timestamp / 10; // 100 ns units
            let (first, session_us) = *anchor.get_or_insert((stamp_us, shared.elapsed_us()));
            push_samples(
                &samples[..count],
                session_us + stamp_us.saturating_sub(first),
                usize::from(CHANNELS),
                RATE,
                shared,
                index,
                producer,
            );
        }
    }
    let _ = client.audio.stop_stream();
}

impl AppLoopback {
    pub(super) fn start(
        shared: Arc<Shared>,
        index: usize,
        mut producer: HeapProd<Block>,
    ) -> Result<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let (ready, started) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("openmeet-app-audio".into())
            .spawn(move || match open() {
                Ok(client) => {
                    let _ = ready.send(Ok(()));
                    run(client, &flag, &shared, index, &mut producer);
                }
                Err(error) => {
                    let _ = ready.send(Err(error));
                }
            })?;
        let mut loopback = Self {
            stop,
            thread: Some(thread),
        };
        match started.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(loopback),
            Ok(Err(error)) => Err(error),
            Err(_) => {
                loopback.thread = None; // Do not block on a stuck activation; the flag still ends it.
                Err(audio_error(
                    "App audio capture did not start. No recording was started.",
                ))
            }
        }
    }
    /// Stops new packets; the thread exits within one 100 ms wait.
    pub(super) fn pause(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for AppLoopback {
    fn drop(&mut self) {
        self.pause();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ringbuf::{
        traits::{Consumer, Split},
        HeapRb,
    };

    /// Native and explicitly authorized only: play audio from another process while it runs.
    #[test]
    #[ignore]
    fn app_audio_self_test() {
        let shared = Arc::new(Shared::new());
        shared.recording.store(true, Ordering::SeqCst);
        let (producer, mut consumer) = HeapRb::<Block>::new(super::super::QUEUE_BLOCKS).split();
        let loopback = AppLoopback::start(shared.clone(), 1, producer).unwrap();
        let (mut frames, mut peak, mut nonzero) = (0_usize, 0_f32, 0_usize);
        for half_second in 0..16 {
            let mut window = 0_f32;
            for _ in 0..50 {
                thread::sleep(Duration::from_millis(10));
                while let Some(block) = consumer.try_pop() {
                    frames += block.len / usize::from(CHANNELS);
                    for sample in &block.samples[..block.len] {
                        window = window.max(sample.abs());
                        nonzero += usize::from(*sample != 0.0);
                    }
                }
            }
            peak = peak.max(window);
            println!("{:>4.1}s peak {window:.4}", f64::from(half_second) / 2.0);
        }
        drop(loopback);
        println!("frames {frames}, non-zero samples {nonzero}, peak {peak:.4}");
        assert!(frames > 0, "no app audio frames");
    }
}
