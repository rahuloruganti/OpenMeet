//! Synthetic workflow checks use real writer output without opening capture devices.
use crate::{
    audio::{self, Track},
    domain::{
        ExportOptions, FilenamePattern, ProviderRole, ProviderSelection, Segment, SegmentTiming,
    },
    export,
    live_audio::Chunk,
    llm::Template,
    session_processing::{self, Plan, Request, State},
    session_workflow::{self, Stage},
    storage::Core,
};
use rusqlite::params;
use std::path::Path;

fn attach(core: &mut Core, plan: &Plan, tracks: &[Track]) -> String {
    let id = core.create_note("Synthetic workflow verification").unwrap();
    core.db
        .execute(
            "UPDATE meetings SET source='desktop',status='paused' WHERE id=?1",
            [&id],
        )
        .unwrap();
    let tx = core.db.transaction().unwrap();
    session_processing::attach(&tx, plan, &id).unwrap();
    for track in tracks {
        tx.execute("INSERT INTO tracks(meeting_id,kind,path,timing_path,device_name,sample_rate,channels,frames,dropped_frames,finalized) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)", params![id,track.kind,track.path,track.timing_path,track.device_name,track.sample_rate,track.channels,track.frames,track.dropped_frames,track.finalized]).unwrap();
    }
    tx.commit().unwrap();
    id
}
fn stop(core: &mut Core, id: &str) {
    let tx = core.db.transaction().unwrap();
    tx.execute("UPDATE meetings SET status='stopped',started_at='2026-01-01T00:00:00Z',ended_at='2026-01-01T00:00:09Z' WHERE id=?1", [id]).unwrap();
    session_workflow::stopped(&tx, id, true, false).unwrap();
    tx.commit().unwrap();
}
fn review(core: &mut Core, summary: bool) -> Plan {
    if summary {
        let settings = core
            .save_api_connection(
                None,
                "Fictional text",
                "https://text.example/v1",
                Some("fictional-credential-reference"),
                None,
            )
            .unwrap();
        core.save_provider_assignment(
            ProviderRole::Llm,
            &ProviderSelection::Assigned {
                connection_id: settings.saved_connections[0].id.clone(),
                model: "fictional-text-model".into(),
            },
            None,
        )
        .unwrap();
    }
    core.prepare_session_processing(Request::Final {
        live: true,
        summary: summary.then_some(Template::General),
    })
    .unwrap()
}
fn segments_from_chunks(chunks: &[Chunk]) -> Vec<Segment> {
    let mut segments: Vec<_> = chunks
        .iter()
        .map(|chunk| {
            let materialized = chunk.materialize().unwrap();
            let samples = hound::WavReader::open(&materialized.track.path)
                .unwrap()
                .samples::<f32>()
                .map(|v| v.unwrap())
                .collect::<Vec<_>>();
            let text = match samples[0] {
                0.25 => "Microphone before pause",
                -0.25 => "System before pause",
                0.5 => "Microphone after pause",
                -0.5 => "System after pause",
                value => panic!("Unexpected synthetic signal {value}"),
            };
            assert_eq!(samples.len(), 1600);
            assert!(samples.iter().all(|sample| *sample == samples[0]));
            let timing = crate::audio_timing::read(&materialized.track, || Ok(())).unwrap();
            let start_ms = (timing[0].capture_start_us / 1000) as i64;
            Segment {
                speaker: if chunk.kind == "mic" { "You" } else { "Others" }.into(),
                timing: SegmentTiming::Timed {
                    start_ms,
                    end_ms: start_ms + 100,
                },
                text: text.into(),
            }
        })
        .collect();
    segments.sort_by_key(|segment| match segment.timing {
        SegmentTiming::Timed { start_ms, .. } => (start_ms, segment.speaker.clone()),
        SegmentTiming::Untimed => unreachable!(),
    });
    segments
}
fn export_options() -> ExportOptions {
    ExportOptions {
        transcript: true,
        summary: true,
        filename: FilenamePattern::Title,
        transcript_formats: Vec::new(),
    }
}
fn old_segment() -> Segment {
    Segment {
        speaker: "You".into(),
        timing: SegmentTiming::Timed {
            start_ms: 0,
            end_ms: 100,
        },
        text: "EarlierFinalOutput".into(),
    }
}

#[test]
fn accepted_audio_provisional_isolation_and_atomic_final_publication() {
    let folder = tempfile::tempdir().unwrap();
    let (tracks, chunks) = audio::synthetic_pause_recording_for_test(&folder.path().join("audio"));
    let final_segments = segments_from_chunks(&chunks);
    assert_eq!(
        final_segments
            .iter()
            .map(|segment| segment.text.as_str())
            .collect::<Vec<_>>(),
        [
            "System before pause",
            "Microphone before pause",
            "System after pause",
            "Microphone after pause"
        ]
    );
    let mut core = Core::open(Path::new(":memory:")).unwrap();
    let plan = review(&mut core, false);
    let id = attach(&mut core, &plan, &tracks);
    core.replace_transcript(&id, &[old_segment()], "whisper", "earlier-model")
        .unwrap();
    core.save_notes(&id, "Preserved synthetic notes", 0)
        .unwrap();
    for chunk in &chunks {
        let mut preview = segments_from_chunks(std::slice::from_ref(chunk));
        preview[0].text = format!("PreviewOnlyZebra {}", preview[0].text);
        core.publish_provisional(&id, &plan.id, &chunk.kind, chunk.chunk_id, &preview)
            .unwrap();
    }
    let snapshot = core.session_processing(&id).unwrap().unwrap();
    assert_eq!(snapshot.workflow.as_ref().unwrap().provisional.len(), 4);
    assert_eq!(core.get_meeting(&id).unwrap().segments, [old_segment()]);
    assert!(core.search_meetings("PreviewOnlyZebra").unwrap().is_empty());
    assert_eq!(
        core.search_meetings("EarlierFinalOutput").unwrap()[0].meeting_id,
        id
    );
    let rendered = export::render(&core.get_meeting(&id).unwrap(), &export_options());
    assert!(rendered.contains("EarlierFinalOutput"));
    assert!(!rendered.contains("PreviewOnlyZebra"));
    stop(&mut core, &id);
    let barrier = core
        .processing_workflow(&id)
        .unwrap()
        .unwrap()
        .notes_barrier
        .unwrap();
    assert_eq!(
        core.acknowledge_processing_notes(&id, &plan.id, &barrier, 1)
            .unwrap_err()
            .code,
        "processing_cancelled"
    );
    let notes_snapshot: Option<String> = core
        .db
        .query_row(
            "SELECT notes_snapshot FROM processing_runs WHERE meeting_id=?1",
            [&id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(notes_snapshot, None);
    assert_eq!(
        core.get_meeting(&id).unwrap().user_markdown,
        "Preserved synthetic notes"
    );
    core.processing_stage(&id, &plan.id, Stage::FinalizingAudio, Stage::Transcribing)
        .unwrap();
    core.db.execute_batch("CREATE TEMP TRIGGER reject_final_publication BEFORE UPDATE OF transcript_done ON processing_runs WHEN NEW.transcript_done=1 BEGIN SELECT RAISE(ABORT,'synthetic publication failure'); END;").unwrap();
    assert!(core
        .publish_final(&id, &plan.id, &final_segments, "whisper", "final-model")
        .is_err());
    let unchanged = core.get_meeting(&id).unwrap();
    assert_eq!(unchanged.segments, [old_segment()]);
    assert_eq!(unchanged.transcript_model.as_deref(), Some("earlier-model"));
    assert!(core.transcript_versions(&id).unwrap().is_empty());
    let workflow = core.processing_workflow(&id).unwrap().unwrap();
    assert_eq!(
        (
            workflow.stage,
            workflow.transcript_done,
            workflow.provisional.len()
        ),
        (Stage::Transcribing, false, 4)
    );
    core.db
        .execute_batch("DROP TRIGGER reject_final_publication")
        .unwrap();
    core.publish_final(&id, &plan.id, &final_segments, "whisper", "final-model")
        .unwrap();
    let detail = core.get_meeting(&id).unwrap();
    assert_eq!(detail.segments, final_segments);
    assert_eq!(detail.user_markdown, "Preserved synthetic notes");
    assert_eq!(detail.transcript_model.as_deref(), Some("final-model"));
    let versions = core.transcript_versions(&id).unwrap();
    assert_eq!(
        (versions.len(), versions[0].model.as_deref()),
        (1, Some("earlier-model"))
    );
    let workflow = core.processing_workflow(&id).unwrap().unwrap();
    assert_eq!(
        (
            workflow.stage,
            workflow.transcript_done,
            workflow.provisional.len()
        ),
        (Stage::Completed, true, 0)
    );
    assert!(core
        .search_meetings("EarlierFinalOutput")
        .unwrap()
        .is_empty());
    assert_eq!(
        core.search_meetings("Microphone").unwrap()[0].meeting_id,
        id
    );
    let snapshot = export::write_snapshot(&detail, folder.path(), &export_options()).unwrap();
    let saved = std::fs::read_to_string(snapshot.path).unwrap();
    assert!(saved.contains("Microphone after pause"));
    assert!(!saved.contains("PreviewOnlyZebra"));
}

#[test]
fn request_budgets_are_atomic_and_retry_rejects_stale_identity_and_changed_horizon() {
    let mut core = Core::open(Path::new(":memory:")).unwrap();
    let mut plan = review(&mut core, false);
    plan.limits.requests = 2;
    plan.limits.upload_bytes = 10;
    plan.limits.text_bytes = 8;
    let id = attach(&mut core, &plan, &[]);
    stop(&mut core, &id);
    core.processing_stage(&id, &plan.id, Stage::FinalizingAudio, Stage::Transcribing)
        .unwrap();
    core.reserve_processing_request(&id, &plan.id, Stage::Transcribing, "first-payload", 6, 3)
        .unwrap();
    for (audio, text) in [(5, 0), (0, 6)] {
        assert_eq!(
            core.reserve_processing_request(
                &id,
                &plan.id,
                Stage::Transcribing,
                "denied",
                audio,
                text
            )
            .unwrap_err()
            .code,
            "processing_budget"
        );
    }
    core.reserve_processing_request(&id, &plan.id, Stage::Transcribing, "second-payload", 4, 5)
        .unwrap();
    assert_eq!(
        core.reserve_processing_request(&id, &plan.id, Stage::Transcribing, "third", 0, 0)
            .unwrap_err()
            .code,
        "processing_budget"
    );
    let workflow = core.processing_workflow(&id).unwrap().unwrap();
    assert_eq!(
        (
            workflow.requests_used,
            workflow.upload_bytes_used,
            workflow.text_bytes_used
        ),
        (2, 10, 8)
    );
    let reserved: Vec<String> = core
        .db
        .prepare("SELECT fingerprint FROM processing_requests WHERE meeting_id=?1 ORDER BY ordinal")
        .unwrap()
        .query_map([&id], |row| row.get(0))
        .unwrap()
        .map(|row| row.unwrap())
        .collect();
    assert_eq!(reserved, ["first-payload", "second-payload"]);
    core.fail_processing(&id, &plan.id, "processing_budget")
        .unwrap();
    core.db
        .execute(
            "UPDATE meetings SET ended_at='2026-01-01T05:00:00Z' WHERE id=?1",
            [&id],
        )
        .unwrap();
    assert_eq!(
        core.retry_session_processing(&id).unwrap_err().code,
        "processing_retry"
    );
    core.db
        .execute(
            "UPDATE meetings SET ended_at='2026-01-01T00:00:09Z' WHERE id=?1",
            [&id],
        )
        .unwrap();
    let restarted = core.retry_session_processing(&id).unwrap();
    let workflow = restarted.workflow.unwrap();
    assert_eq!(
        (workflow.attempt, workflow.requests_used, workflow.stage),
        (2, 0, Stage::FinalizingAudio)
    );
    assert_ne!(workflow.run_id, plan.id);
    assert_eq!(
        core.reserve_processing_request(&id, &plan.id, Stage::Transcribing, "old-run", 0, 0)
            .unwrap_err()
            .code,
        "processing_cancelled"
    );
    assert!(core.retry_session_processing(&id).is_err());
    core.db
        .execute(
            "UPDATE processing_sessions SET started_at=0,authorized_until=1 WHERE meeting_id=?1",
            [&id],
        )
        .unwrap();
    assert_eq!(
        core.session_processing(&id).unwrap().unwrap().state,
        State::ConsentRequired
    );
    assert!(core
        .check_processing(&id, &workflow.run_id, Stage::FinalizingAudio, false)
        .is_err());
}

#[test]
fn frozen_notes_reject_edits_and_summary_retry_keeps_completed_transcript() {
    let folder = tempfile::tempdir().unwrap();
    let (tracks, chunks) = audio::synthetic_pause_recording_for_test(&folder.path().join("audio"));
    let segments = segments_from_chunks(&chunks);
    let mut core = Core::open(Path::new(":memory:")).unwrap();
    let plan = review(&mut core, true);
    let id = attach(&mut core, &plan, &tracks);
    let revision = core.save_notes(&id, "Frozen synthetic notes", 0).unwrap();
    stop(&mut core, &id);
    let barrier = core
        .processing_workflow(&id)
        .unwrap()
        .unwrap()
        .notes_barrier
        .unwrap();
    assert_eq!(
        core.acknowledge_processing_notes(&id, &plan.id, "stale-barrier", revision)
            .unwrap_err()
            .code,
        "processing_cancelled"
    );
    assert_eq!(
        core.acknowledge_processing_notes(&id, &plan.id, &barrier, revision - 1)
            .unwrap_err()
            .code,
        "notes_conflict"
    );
    core.acknowledge_processing_notes(&id, &plan.id, &barrier, revision)
        .unwrap();
    core.processing_stage(&id, &plan.id, Stage::FinalizingAudio, Stage::Transcribing)
        .unwrap();
    core.publish_final(&id, &plan.id, &segments, "whisper", "synthetic")
        .unwrap();
    core.processing_stage(&id, &plan.id, Stage::AwaitingNotes, Stage::Summarizing)
        .unwrap();
    assert_eq!(
        core.frozen_processing_notes(&id, &plan.id).unwrap(),
        ("Frozen synthetic notes".into(), revision)
    );
    core.save_summary(&id, "fictional", "earlier", "Earlier summary", "general-v1")
        .unwrap();
    let changed_revision = core
        .save_notes(&id, "Edited while summary was running", revision)
        .unwrap();
    assert_eq!(
        core.publish_session_summary(
            &id,
            &plan.id,
            revision,
            &segments,
            "fictional",
            "text",
            "Stale summary",
            "general-v1"
        )
        .unwrap_err()
        .code,
        "notes_conflict"
    );
    assert_eq!(
        core.get_meeting(&id).unwrap().summary.as_deref(),
        Some("Earlier summary")
    );
    core.fail_processing(&id, &plan.id, "notes_conflict")
        .unwrap();
    let snapshot = core.retry_session_processing(&id).unwrap();
    let workflow = snapshot.workflow.unwrap();
    assert_eq!(
        (workflow.stage, workflow.transcript_done),
        (Stage::AwaitingNotes, true)
    );
    assert_eq!(core.get_meeting(&id).unwrap().segments, segments);
    assert!(core
        .acknowledge_processing_notes(&id, &plan.id, &barrier, changed_revision)
        .is_err());
    core.acknowledge_processing_notes(
        &id,
        &workflow.run_id,
        workflow.notes_barrier.as_deref().unwrap(),
        changed_revision,
    )
    .unwrap();
    core.processing_stage(
        &id,
        &workflow.run_id,
        Stage::AwaitingNotes,
        Stage::Summarizing,
    )
    .unwrap();
    assert_eq!(
        core.frozen_processing_notes(&id, &workflow.run_id).unwrap(),
        ("Edited while summary was running".into(), changed_revision)
    );
    core.publish_session_summary(
        &id,
        &workflow.run_id,
        changed_revision,
        &segments,
        "fictional",
        "text",
        "Reviewed summary",
        "general-v1",
    )
    .unwrap();
    assert_eq!(core.list_summaries(&id).unwrap().len(), 2);
    assert_eq!(
        core.get_meeting(&id).unwrap().summary.as_deref(),
        Some("Reviewed summary")
    );
    assert_eq!(
        core.processing_workflow(&id).unwrap().unwrap().stage,
        Stage::Completed
    );
}

#[test]
fn restart_interrupts_unfinished_work_and_preserves_saved_content() {
    let folder = tempfile::tempdir().unwrap();
    let database = folder.path().join("openmeet.sqlite");
    let (tracks, chunks) = audio::synthetic_pause_recording_for_test(&folder.path().join("audio"));
    let mut core = Core::open(&database).unwrap();
    let plan = review(&mut core, false);
    let id = attach(&mut core, &plan, &tracks);
    core.save_notes(&id, "Saved before restart", 0).unwrap();
    core.replace_transcript(&id, &[old_segment()], "whisper", "old")
        .unwrap();
    core.publish_provisional(
        &id,
        &plan.id,
        &chunks[0].kind,
        chunks[0].chunk_id,
        &segments_from_chunks(&chunks[..1]),
    )
    .unwrap();
    let before = core.session_processing(&id).unwrap().unwrap();
    drop(core);
    let core = Core::open(&database).unwrap();
    let snapshot = core.session_processing(&id).unwrap().unwrap();
    assert_eq!(snapshot.state, State::Interrupted);
    assert!(snapshot.revision > before.revision);
    let workflow = snapshot.workflow.unwrap();
    assert_eq!(
        (
            workflow.stage,
            workflow.requests_used,
            workflow.provisional.len()
        ),
        (Stage::Interrupted, 0, 1)
    );
    let detail = core.get_meeting(&id).unwrap();
    assert_eq!(detail.user_markdown, "Saved before restart");
    assert_eq!(detail.segments, [old_segment()]);
    assert_eq!(detail.tracks.len(), 2);
    assert!(detail
        .tracks
        .iter()
        .all(|track| Path::new(&track.path).exists()));
    assert!(core.processing_owner.is_idle());
    assert!(core
        .check_processing(&id, &plan.id, Stage::Live, false)
        .is_err());
}

type Observed = std::sync::Arc<std::sync::Mutex<(Vec<i16>, Vec<u8>)>>;

/// Loopback speech/chat engine that serves exactly `requests` calls, routed by path, and
/// records uploaded PCM markers and the last chat body.
fn loopback_engines(requests: usize) -> (String, Observed, std::thread::JoinHandle<()>) {
    use std::{
        io::{BufRead, BufReader, Cursor, Read, Write},
        net::TcpListener,
        thread,
        time::{Duration, Instant},
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let observed = Observed::default();
    let server_observed = observed.clone();
    let server = thread::spawn(move || {
        for index in 0..requests {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => panic!("Synthetic server received {index} requests: {error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(&stream);
            let mut headers = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                assert!(!line.is_empty());
                headers.push_str(&line.to_ascii_lowercase());
            }
            let length: usize = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            assert!(length < 1_048_576);
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let reply = if headers.starts_with("post /v1/audio/transcriptions ") {
                let offset = body.windows(4).position(|window| window == b"RIFF").unwrap();
                let mut wav = hound::WavReader::new(Cursor::new(&body[offset..])).unwrap();
                assert_eq!((wav.spec().sample_rate, wav.spec().channels, wav.spec().bits_per_sample), (16000, 1, 16));
                let samples = wav.samples::<i16>().map(|sample| sample.unwrap()).collect::<Vec<_>>();
                assert_eq!(samples.len(), 1600);
                assert!(samples.iter().all(|sample| *sample == samples[0]));
                let text = match samples[0] {
                    8192 => "Microphone before pause",
                    -8192 => "System before pause",
                    16384 => "Microphone after pause",
                    -16384 => "System after pause",
                    value => panic!("Paused marker or unexpected PCM uploaded: {value}"),
                };
                server_observed.lock().unwrap().0.push(samples[0]);
                serde_json::json!({"text":text,"segments":[{"start":0.0,"end":0.1,"text":text}]})
            } else {
                assert!(headers.starts_with("post /v1/chat/completions "));
                let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
                let content = json["messages"][1]["content"].as_str().unwrap();
                for expected in ["Frozen reviewed notes", "Microphone before pause", "System before pause", "Microphone after pause", "System after pause"] {
                    assert!(content.contains(expected), "Missing summary input {expected}");
                }
                server_observed.lock().unwrap().1 = body;
                serde_json::json!({"choices":[{"message":{"content":"## Summary\nBoth accepted tracks before and after pause. Frozen reviewed notes."}}]})
            }.to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",reply.len()).unwrap();
        }
    });
    (base, observed, server)
}

/// Assigns the loopback engine to cloud speech and text, then reviews live plus final with a summary.
fn loopback_plan(core: &mut Core, base: &str) -> Plan {
    let settings = core
        .save_api_connection(None, "Synthetic loopback engines", base, None, None)
        .unwrap();
    let connection_id = settings.saved_connections[0].id.clone();
    for (role, model) in [
        (ProviderRole::CloudStt, "synthetic-speech"),
        (ProviderRole::Llm, "synthetic-text"),
    ] {
        core.save_provider_assignment(
            role,
            &ProviderSelection::Assigned {
                connection_id: connection_id.clone(),
                model: model.into(),
            },
            None,
        )
        .unwrap();
    }
    core.save_stt_mode(crate::domain::SttMode::Cloud).unwrap();
    core.prepare_session_processing(Request::Final {
        live: true,
        summary: Some(Template::General),
    })
    .unwrap()
}

#[test]
fn actual_cloud_requests_from_saved_pcm_publish_final_summary_export_and_survive_restart() {
    use crate::{cloud_stt, llm, providers::Connection};
    use sha2::{Digest, Sha256};
    let (base, observed, server) = loopback_engines(5);
    let folder = tempfile::tempdir().unwrap();
    let database = folder.path().join("openmeet.sqlite");
    let (tracks, chunks) = audio::synthetic_pause_recording_for_test(&folder.path().join("audio"));
    let expected_segments = segments_from_chunks(&chunks);
    let mut core = Core::open(&database).unwrap();
    let plan = loopback_plan(&mut core, &base);
    let id = attach(&mut core, &plan, &tracks);
    for chunk in &chunks {
        core.publish_provisional(
            &id,
            &plan.id,
            &chunk.kind,
            chunk.chunk_id,
            &segments_from_chunks(std::slice::from_ref(chunk)),
        )
        .unwrap();
    }
    assert_eq!(
        core.processing_workflow(&id)
            .unwrap()
            .unwrap()
            .provisional
            .len(),
        4
    );
    assert!(core.get_meeting(&id).unwrap().segments.is_empty());
    let revision = core.save_notes(&id, "Frozen reviewed notes", 0).unwrap();
    stop(&mut core, &id);
    let barrier = core
        .processing_workflow(&id)
        .unwrap()
        .unwrap()
        .notes_barrier
        .unwrap();
    core.acknowledge_processing_notes(&id, &plan.id, &barrier, revision)
        .unwrap();
    core.processing_stage(&id, &plan.id, Stage::FinalizingAudio, Stage::Transcribing)
        .unwrap();
    let audio_plan = cloud_stt::plan(&tracks).unwrap();
    assert_eq!(audio_plan.requests(), 4);
    let guard = core.processing_owner.begin(&id).unwrap();
    let segments = cloud_stt::transcribe(
        &Connection::for_test(&base, "synthetic-speech"),
        &tracks,
        "auto",
        "",
        &audio_plan,
        guard.cancel(),
        |_, _| {},
        |fingerprint, bytes| {
            core.reserve_processing_request(
                &id,
                &plan.id,
                Stage::Transcribing,
                fingerprint,
                bytes,
                0,
            )
        },
    )
    .unwrap();
    assert_eq!(segments, expected_segments);
    guard
        .finish(|| core.publish_final(&id, &plan.id, &segments, &base, "synthetic-speech"))
        .unwrap();
    drop(guard);
    core.processing_stage(&id, &plan.id, Stage::AwaitingNotes, Stage::Summarizing)
        .unwrap();
    let (notes, frozen_revision) = core.frozen_processing_notes(&id, &plan.id).unwrap();
    let lines = crate::transcript_lines(
        &core.get_meeting(&id).unwrap().segments,
        &Default::default(),
    );
    let mut authorized_json = Vec::new();
    let guard = core.processing_owner.begin(&id).unwrap();
    let summary = llm::summarize(
        &Connection::for_test(&base, "synthetic-text"),
        &crate::llm::summary_system(crate::llm::Structure::Builtin(Template::General), ""),
        &notes,
        &lines,
        guard.cancel(),
        |body| {
            authorized_json = body.to_vec();
            let digest: String = Sha256::digest(body)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            core.reserve_processing_request(
                &id,
                &plan.id,
                Stage::Summarizing,
                &digest,
                0,
                body.len(),
            )
        },
    )
    .unwrap();
    guard
        .finish(|| {
            core.publish_session_summary(
                &id,
                &plan.id,
                frozen_revision,
                &segments,
                &base,
                "synthetic-text",
                &summary,
                Template::General.id(),
            )
        })
        .unwrap();
    drop(guard);
    server.join().unwrap();
    let observed = observed.lock().unwrap();
    assert_eq!(observed.0, [8192, 16384, -8192, -16384]);
    assert_eq!(authorized_json, observed.1);
    let workflow = core.processing_workflow(&id).unwrap().unwrap();
    assert_eq!(
        (
            workflow.stage,
            workflow.requests_used,
            workflow.upload_bytes_used,
            workflow.text_bytes_used
        ),
        (
            Stage::Completed,
            5,
            audio_plan.bytes() as i64,
            authorized_json.len() as i64
        )
    );
    assert!(workflow.provisional.is_empty());
    let detail = core.get_meeting(&id).unwrap();
    assert_eq!(
        detail.summary.as_deref(),
        Some("## Summary\nBoth accepted tracks before and after pause. Frozen reviewed notes.")
    );
    let snapshot = export::write_snapshot(&detail, folder.path(), &export_options()).unwrap();
    let markdown = std::fs::read_to_string(snapshot.path).unwrap();
    assert!(markdown.contains("Both accepted tracks before and after pause."));
    assert!(markdown.contains("(8.0s)"));
    drop(core);
    let core = Core::open(&database).unwrap();
    let reopened = core.session_processing(&id).unwrap().unwrap();
    assert_eq!(reopened.state, State::Prepared);
    assert_eq!(reopened.workflow.unwrap().stage, Stage::Completed);
    let detail = core.get_meeting(&id).unwrap();
    assert_eq!(detail.segments, expected_segments);
    assert_eq!(detail.user_markdown, "Frozen reviewed notes");
    assert_eq!(detail.summary.as_deref(), Some(summary.as_str()));
    assert!(!detail.summary_stale);
}

#[test]
fn cancel_during_final_upload_survives_restart_and_reviewed_retry_completes() {
    use crate::{cloud_stt, llm, providers::Connection};
    // One upload before cancellation, then four uploads and one summary after retry.
    let (base, observed, server) = loopback_engines(6);
    let folder = tempfile::tempdir().unwrap();
    let database = folder.path().join("openmeet.sqlite");
    let (tracks, chunks) = audio::synthetic_pause_recording_for_test(&folder.path().join("audio"));
    let expected_segments = segments_from_chunks(&chunks);
    let mut core = Core::open(&database).unwrap();
    let plan = loopback_plan(&mut core, &base);
    let id = attach(&mut core, &plan, &tracks);
    core.replace_transcript(&id, &[old_segment()], "whisper", "earlier-model")
        .unwrap();
    for chunk in &chunks {
        core.publish_provisional(
            &id,
            &plan.id,
            &chunk.kind,
            chunk.chunk_id,
            &segments_from_chunks(std::slice::from_ref(chunk)),
        )
        .unwrap();
    }
    let revision = core.save_notes(&id, "Frozen reviewed notes", 0).unwrap();
    stop(&mut core, &id);
    let barrier = core
        .processing_workflow(&id)
        .unwrap()
        .unwrap()
        .notes_barrier
        .unwrap();
    core.acknowledge_processing_notes(&id, &plan.id, &barrier, revision)
        .unwrap();
    core.processing_stage(&id, &plan.id, Stage::FinalizingAudio, Stage::Transcribing)
        .unwrap();
    let audio_plan = cloud_stt::plan(&tracks).unwrap();
    let owner = core.processing_owner.clone();
    let guard = owner.begin_session(&id, &plan.id).unwrap();
    let mut reserved = 0;
    // The user cancels while the second upload is about to be sent.
    let result = cloud_stt::transcribe(
        &Connection::for_test(&base, "synthetic-speech"),
        &tracks,
        "auto",
        "",
        &audio_plan,
        guard.cancel(),
        |_, _| {},
        |fingerprint, bytes| {
            if reserved == 1 {
                let revision = core.session_processing(&id)?.unwrap().revision;
                owner.cancel_session_with(&id, || {
                    let snapshot = core.cancel_session_processing(&id, revision)?;
                    Ok(((), snapshot.plan.id))
                })?;
            }
            reserved += 1;
            core.reserve_processing_request(
                &id,
                &plan.id,
                Stage::Transcribing,
                fingerprint,
                bytes,
                0,
            )
        },
    );
    assert!(result.is_err());
    assert!(guard.cancel().load(std::sync::atomic::Ordering::SeqCst));
    assert!(guard
        .finish(|| core.publish_final(&id, &plan.id, &expected_segments, &base, "late"))
        .is_err());
    drop(guard);
    assert_eq!(observed.lock().unwrap().0, [8192]);
    let workflow = core.processing_workflow(&id).unwrap().unwrap();
    assert_eq!(
        (
            workflow.stage,
            workflow.requests_used,
            workflow.transcript_done
        ),
        (Stage::Cancelled, 1, false)
    );
    let detail = core.get_meeting(&id).unwrap();
    assert_eq!(detail.segments, [old_segment()]);
    assert_eq!(detail.user_markdown, "Frozen reviewed notes");

    // Restart keeps the cancellation, replays nothing, and keeps audio and earlier output.
    drop(core);
    let mut core = Core::open(&database).unwrap();
    let snapshot = core.session_processing(&id).unwrap().unwrap();
    assert_eq!(snapshot.state, State::Cancelled);
    let workflow = snapshot.workflow.unwrap();
    assert_eq!(
        (workflow.stage, workflow.requests_used),
        (Stage::Cancelled, 1)
    );
    let detail = core.get_meeting(&id).unwrap();
    assert_eq!(detail.segments, [old_segment()]);
    assert!(detail
        .tracks
        .iter()
        .all(|track| Path::new(&track.path).exists()));
    assert_eq!(observed.lock().unwrap().0.len(), 1);

    // Another billable attempt needs an explicit retry and a new run identity.
    let workflow = core
        .retry_session_processing(&id)
        .unwrap()
        .workflow
        .unwrap();
    assert_ne!(workflow.run_id, plan.id);
    assert_eq!(
        (workflow.attempt, workflow.stage, workflow.requests_used),
        (2, Stage::FinalizingAudio, 0)
    );
    assert!(workflow.provisional.is_empty());
    assert_eq!(
        core.reserve_processing_request(&id, &plan.id, Stage::Transcribing, "old-run", 0, 0)
            .unwrap_err()
            .code,
        "processing_cancelled"
    );
    let run = workflow.run_id.clone();
    core.acknowledge_processing_notes(
        &id,
        &run,
        workflow.notes_barrier.as_deref().unwrap(),
        revision,
    )
    .unwrap();
    core.processing_stage(&id, &run, Stage::FinalizingAudio, Stage::Transcribing)
        .unwrap();
    let guard = core.processing_owner.begin_session(&id, &run).unwrap();
    let segments = cloud_stt::transcribe(
        &Connection::for_test(&base, "synthetic-speech"),
        &tracks,
        "auto",
        "",
        &audio_plan,
        guard.cancel(),
        |_, _| {},
        |fingerprint, bytes| {
            core.reserve_processing_request(&id, &run, Stage::Transcribing, fingerprint, bytes, 0)
        },
    )
    .unwrap();
    assert_eq!(segments, expected_segments);
    guard
        .finish(|| core.publish_final(&id, &run, &segments, &base, "synthetic-speech"))
        .unwrap();
    drop(guard);
    core.processing_stage(&id, &run, Stage::AwaitingNotes, Stage::Summarizing)
        .unwrap();
    let (notes, frozen_revision) = core.frozen_processing_notes(&id, &run).unwrap();
    let lines = crate::transcript_lines(
        &core.get_meeting(&id).unwrap().segments,
        &Default::default(),
    );
    let guard = core.processing_owner.begin_session(&id, &run).unwrap();
    let summary = llm::summarize(
        &Connection::for_test(&base, "synthetic-text"),
        &crate::llm::summary_system(crate::llm::Structure::Builtin(Template::General), ""),
        &notes,
        &lines,
        guard.cancel(),
        |body| {
            core.reserve_processing_request(&id, &run, Stage::Summarizing, "summary", 0, body.len())
        },
    )
    .unwrap();
    guard
        .finish(|| {
            core.publish_session_summary(
                &id,
                &run,
                frozen_revision,
                &segments,
                &base,
                "synthetic-text",
                &summary,
                Template::General.id(),
            )
        })
        .unwrap();
    drop(guard);
    server.join().unwrap();
    assert_eq!(
        observed.lock().unwrap().0,
        [8192, 8192, 16384, -8192, -16384]
    );
    let workflow = core.processing_workflow(&id).unwrap().unwrap();
    assert_eq!(
        (workflow.stage, workflow.attempt, workflow.requests_used),
        (Stage::Completed, 2, 5)
    );
    let detail = core.get_meeting(&id).unwrap();
    assert_eq!(detail.segments, expected_segments);
    assert_eq!(detail.summary.as_deref(), Some(summary.as_str()));
    assert!(!detail.summary_stale);
    let markdown = std::fs::read_to_string(
        export::write_snapshot(&detail, folder.path(), &export_options())
            .unwrap()
            .path,
    )
    .unwrap();
    assert!(markdown.contains("Microphone after pause"));
    assert!(!markdown.contains("EarlierFinalOutput"));
}
