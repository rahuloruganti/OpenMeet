use crate::domain::*;
use std::{fs, io::Write, path::Path};
use uuid::Uuid;

fn banner(source: &str) -> &'static str {
    match source {
        "simulation" => "Simulation: no audio was recorded.",
        "fixture" => "Fictional sample: no audio was recorded and the summary is hand-written.",
        "desktop" => "Recorded on this device with the Windows capture preview. Audio files are not included in this export.",
        _ => "OpenMeet preview export.",
    }
}

/// Longest finalized track, e.g. "0:12:34"; None when no audio was captured.
fn duration(detail: &MeetingDetail) -> Option<String> {
    let seconds = detail
        .tracks
        .iter()
        .filter(|track| track.frames > 0 && track.sample_rate > 0)
        .map(|track| track.frames / i64::from(track.sample_rate))
        .max()?;
    Some(format!(
        "{}:{:02}:{:02}",
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60
    ))
}

pub fn render(detail: &MeetingDetail, options: &ExportOptions) -> String {
    // JSON-quoted strings are valid YAML double-quoted scalar values.
    let quote =
        |value: &str| serde_json::to_string(value).expect("string serialization is infallible");
    let mut output = format!(
        "---\ntitle: {}\ndate: {}\nmeeting_id: {}\nsource: {}\n",
        quote(&detail.meeting.title),
        quote(&detail.meeting.started_at),
        quote(&detail.meeting.id),
        quote(&detail.meeting.source),
    );
    if let Some(duration) = duration(detail) {
        output.push_str(&format!("duration: {}\n", quote(&duration)));
    }
    if options.summary && detail.summary.is_some() {
        if let Some(template) = &detail.summary_template {
            output.push_str(&format!("template: {}\n", quote(template)));
        }
        if let Some(model) = &detail.summary_model {
            output.push_str(&format!("model: {}\n", quote(model)));
        }
        if detail.summary_edited {
            output.push_str("summary_edited: true\n");
        }
    }
    if options.transcript {
        if detail
            .segment_meta
            .iter()
            .any(|meta| meta.original_text.is_some())
        {
            output.push_str("transcript_edited: true\n");
        }
        if let Some(provider) = &detail.transcript_provider {
            output.push_str(&format!("transcript_provider: {}\n", quote(provider)));
        }
        if let Some(model) = &detail.transcript_model {
            output.push_str(&format!("transcript_model: {}\n", quote(model)));
        }
    }
    let user_tags: String = detail
        .meeting
        .tags
        .iter()
        .map(|tag| format!(", {}", quote(tag)))
        .collect();
    output.push_str(&format!(
        "tags: [meeting{user_tags}]\n---\n\n> {}\n\n",
        banner(&detail.meeting.source)
    ));
    if options.summary {
        output.push_str(&format!(
            "## Summary\n%%ai-start%%\n{}\n%%ai-end%%\n\n",
            detail.summary.as_deref().unwrap_or("No summary generated.")
        ));
    }
    // User-edited tasks sit outside the AI markers and are exported whenever any exist.
    if !detail.action_items.is_empty() {
        output.push_str("## Tasks\n");
        for item in &detail.action_items {
            output.push_str(&format!(
                "- [{}] {} — Owner: {} — Due: {} — {}\n",
                if item.done { "x" } else { " " },
                item.text,
                item.owner.as_deref().unwrap_or("Unassigned"),
                item.due_date.as_deref().unwrap_or("not set"),
                if item.source == "summary" {
                    "From summary"
                } else {
                    "Added manually"
                }
            ));
        }
        output.push('\n');
    }
    output.push_str(&format!("## My notes\n{}\n", detail.user_markdown));
    if !options.transcript {
        return output;
    }
    output.push_str("\n## Transcript\n");
    if detail.segments.is_empty() {
        output.push_str("No transcript generated.\n");
    }
    if detail
        .segments
        .iter()
        .any(|segment| segment.timing == SegmentTiming::Untimed)
    {
        output.push_str("\nUntimed entries have no provider timestamps. Track order does not establish who spoke first.\n");
    }
    for segment in &detail.segments {
        let timing = match segment.timing {
            SegmentTiming::Timed { start_ms, .. } => format!("({:.1}s)", start_ms as f64 / 1000.0),
            SegmentTiming::Untimed => "(untimed)".into(),
        };
        output.push_str(&format!(
            "\n**{}** {}: {}\n",
            detail.speaker_names.label(&segment.speaker),
            timing,
            segment.text
        ));
    }
    output
}

/// `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (VTT) from a session time.
fn cue_time(ms: i64, separator: char) -> String {
    let ms = ms.max(0);
    format!(
        "{:02}:{:02}:{:02}{}{:03}",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        separator,
        ms % 1000
    )
}

/// `HH:MM:SS` for the plain-text transcript, or `untimed` when the engine gave no timing.
fn plain_time(ms: i64) -> String {
    let seconds = ms.max(0) / 1000;
    format!(
        "{:02}:{:02}:{:02}",
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60
    )
}

/// Collapses line breaks and runs of whitespace: a blank line inside an edited segment would
/// otherwise end an SRT/VTT cue early or split one text line in two.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// VTT cue text is markup, so `&`, `<` and `>` (which also rules out `-->`) are escaped.
fn vtt_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// A transcript file written beside the Markdown snapshot. SRT and VTT need a timestamp on every
/// segment, so an untimed transcript is refused instead of being given invented times.
pub fn render_transcript(detail: &MeetingDetail, format: TranscriptFormat) -> Result<String> {
    let untimed = || {
        AppError::new(
            "untimed_transcript",
            "This transcript has no engine timestamps, so it cannot be written as SRT or VTT. Nothing was exported. Turn off SRT and VTT in Settings → General → Transcript files to export this meeting, or re-transcribe with an engine that reports timings.",
        )
    };
    let speaker = |segment: &Segment| one_line(&detail.speaker_names.label(&segment.speaker));
    let mut output = String::new();
    match format {
        TranscriptFormat::Txt => {
            for segment in &detail.segments {
                let time = match segment.timing {
                    SegmentTiming::Timed { start_ms, .. } => plain_time(start_ms),
                    SegmentTiming::Untimed => "untimed".into(),
                };
                output.push_str(&format!(
                    "[{time}] {}: {}\n",
                    speaker(segment),
                    one_line(&segment.text)
                ));
            }
        }
        TranscriptFormat::Srt | TranscriptFormat::Vtt => {
            let srt = format == TranscriptFormat::Srt;
            if !srt {
                output.push_str("WEBVTT\n\n");
            }
            for (index, segment) in detail.segments.iter().enumerate() {
                let SegmentTiming::Timed { start_ms, end_ms } = segment.timing else {
                    return Err(untimed());
                };
                let separator = if srt { ',' } else { '.' };
                let times = format!(
                    "{} --> {}",
                    cue_time(start_ms, separator),
                    cue_time(end_ms.max(start_ms + 1), separator)
                );
                let (who, text) = (speaker(segment), one_line(&segment.text));
                output.push_str(&if srt {
                    format!("{}\n{times}\n{who}: {text}\n\n", index + 1)
                } else {
                    format!("{times}\n<v {}>{}\n\n", vtt_escape(&who), vtt_escape(&text))
                });
            }
        }
    }
    Ok(output)
}

fn safe_name(text: &str, max: usize) -> String {
    text.chars()
        .take(max)
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ' ') {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim()
        .to_string()
}

pub fn filename(detail: &MeetingDetail, options: &ExportOptions) -> Result<String> {
    let id = Uuid::parse_str(&detail.meeting.id)
        .map_err(|_| AppError::new("invalid_id", "The meeting ID is invalid."))?;
    let title = safe_name(&detail.meeting.title, 64);
    // A fixed prefix (or leading date) and UUID avoid Windows device names and title collisions.
    Ok(match options.filename {
        FilenamePattern::Title => format!("Meeting {title} - {id}.md"),
        // ponytail: UTC date from started_at; use the local date if users find midnight meetings misfiled.
        FilenamePattern::DateTitle => format!(
            "{} {title} - {id}.md",
            safe_name(&detail.meeting.started_at, 10)
        ),
    })
}

pub fn write_snapshot(
    detail: &MeetingDetail,
    vault: &Path,
    options: &ExportOptions,
) -> Result<ExportResult> {
    let vault = vault.canonicalize()?;
    let folder = vault.join("Meetings");
    fs::create_dir_all(&folder)?;
    let folder = folder.canonicalize()?;
    if !folder.starts_with(&vault) {
        return Err(AppError::new(
            "unsafe_path",
            "The Meetings folder resolves outside the selected folder.",
        ));
    }
    let output = render(detail, options);
    // Render every requested transcript before publishing anything, so an untimed transcript
    // refuses the export instead of leaving a partial set of files behind. A meeting with no
    // transcript gets no empty transcript files.
    let mut transcripts = Vec::new();
    for format in options
        .transcript_formats
        .iter()
        .filter(|_| !detail.segments.is_empty())
    {
        transcripts.push((*format, render_transcript(detail, *format)?));
    }
    let original = folder.join(filename(detail, options)?);
    let (markdown, created_copy) = publish(&folder, original, output.as_bytes())?;
    let mut transcript_paths = Vec::new();
    for (format, content) in transcripts {
        // The stem is the Markdown snapshot's, so one export shares a name.
        let target = markdown.with_extension(format.as_str());
        let (path, _) = publish(&folder, target, content.as_bytes())?;
        transcript_paths.push(path.to_string_lossy().into_owned());
    }
    Ok(ExportResult {
        path: markdown.to_string_lossy().into_owned(),
        created_copy,
        transcript_paths,
    })
}

/// Writes `content` to `original` without overwriting: an identical file is reused, and any other
/// existing file pushes the write to a fresh copy name.
fn publish(
    folder: &Path,
    original: std::path::PathBuf,
    content: &[u8],
) -> Result<(std::path::PathBuf, bool)> {
    match fs::symlink_metadata(&original) {
        Ok(metadata)
            if metadata.file_type().is_file()
                && metadata.len() == content.len() as u64
                && fs::read(&original)? == content =>
        {
            return Ok((original, false));
        }
        _ => {}
    }
    // shortcut: export immutable snapshots; add AI-block merging only with Phase 1D conflict tests.
    // persist_noclobber also protects files created between our check and publish.
    let stem = original
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Meeting".into());
    let suffix = original
        .extension()
        .map(|extension| extension.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut target = original.clone();
    for _ in 0..3 {
        let mut temp = tempfile::NamedTempFile::new_in(folder)?;
        temp.write_all(content)?;
        temp.as_file().sync_all()?;
        match temp.persist_noclobber(&target) {
            Ok(_) => return Ok((target.clone(), target != original)),
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                target = folder.join(format!("{stem} - copy-{}.{suffix}", Uuid::new_v4()));
            }
            Err(error) => return Err(error.error.into()),
        }
    }
    Err(AppError::new(
        "export_conflict",
        "Could not reserve an export filename. Try exporting again.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Core;

    const ALL: ExportOptions = ExportOptions {
        transcript: true,
        summary: true,
        filename: FilenamePattern::Title,
        transcript_formats: Vec::new(),
    };

    #[test]
    fn export_preserves_external_edits_and_reuses_identical_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_fixture().unwrap();
        let detail = core.get_meeting(&id).unwrap();
        let first = write_snapshot(&detail, dir.path(), &ALL).unwrap();
        assert_eq!(
            first.path,
            write_snapshot(&detail, dir.path(), &ALL).unwrap().path
        );
        fs::write(&first.path, "External edits must survive").unwrap();
        let second = write_snapshot(&detail, dir.path(), &ALL).unwrap();
        assert!(second.created_copy);
        assert_ne!(first.path, second.path);
        assert_eq!(
            fs::read_to_string(&first.path).unwrap(),
            "External edits must survive"
        );
        assert!(fs::read_to_string(second.path)
            .unwrap()
            .contains(&detail.user_markdown));
    }

    #[test]
    fn transcript_files_are_written_beside_the_markdown_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_note("Fictional subtitle export").unwrap();
        core.replace_transcript(
            &id,
            &[
                Segment {
                    speaker: "You".into(),
                    timing: SegmentTiming::Timed {
                        start_ms: 1200,
                        end_ms: 2500,
                    },
                    text: " Hello ".into(),
                },
                Segment {
                    speaker: "Others".into(),
                    timing: SegmentTiming::Timed {
                        start_ms: 3_605_000,
                        end_ms: 3_606_500,
                    },
                    // An edited segment can carry blank lines and markup characters.
                    text: "World <b> &\n\nagain".into(),
                },
            ],
            "whisper",
            "small",
        )
        .unwrap();
        let detail = core.get_meeting(&id).unwrap();
        let options = ExportOptions {
            transcript: true,
            summary: false,
            filename: FilenamePattern::Title,
            transcript_formats: vec![
                TranscriptFormat::Txt,
                TranscriptFormat::Srt,
                TranscriptFormat::Vtt,
            ],
        };
        let result = write_snapshot(&detail, dir.path(), &options).unwrap();
        assert_eq!(result.transcript_paths.len(), 3);
        assert!(result.path.ends_with(".md"));
        assert!(result.transcript_paths[0].ends_with(".txt"));
        assert!(result.transcript_paths[1].ends_with(".srt"));
        assert!(result.transcript_paths[2].ends_with(".vtt"));
        // Same stem as the snapshot, so one export is one set of files.
        let stem = Path::new(&result.path).file_stem().unwrap().to_owned();
        for path in &result.transcript_paths {
            assert_eq!(Path::new(path).file_stem().unwrap(), stem);
        }
        assert_eq!(
            fs::read_to_string(&result.transcript_paths[0]).unwrap(),
            "[00:00:01] You: Hello\n[01:00:05] Others: World <b> & again\n"
        );
        let srt = fs::read_to_string(&result.transcript_paths[1]).unwrap();
        assert!(
            srt.starts_with("1\n00:00:01,200 --> 00:00:02,500\nYou: Hello\n\n"),
            "{srt}"
        );
        assert!(
            srt.contains("2\n01:00:05,000 --> 01:00:06,500\nOthers: World <b> & again\n\n"),
            "{srt}"
        );
        let vtt = fs::read_to_string(&result.transcript_paths[2]).unwrap();
        assert!(
            vtt.starts_with("WEBVTT\n\n00:00:01.200 --> 00:00:02.500\n<v You>Hello\n\n"),
            "{vtt}"
        );
        assert!(
            vtt.ends_with("<v Others>World &lt;b&gt; &amp; again\n\n"),
            "{vtt}"
        );
        // A repeated export reuses the same files instead of piling up copies.
        assert_eq!(
            write_snapshot(&detail, dir.path(), &options)
                .unwrap()
                .transcript_paths,
            result.transcript_paths
        );
        // A meeting without a transcript gets no empty transcript files.
        let empty = core.create_note("Fictional notes only").unwrap();
        let detail = core.get_meeting(&empty).unwrap();
        assert!(write_snapshot(&detail, dir.path(), &options)
            .unwrap()
            .transcript_paths
            .is_empty());
    }

    #[test]
    fn untimed_transcripts_refuse_srt_and_vtt_and_write_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_note("Fictional untimed export").unwrap();
        core.replace_transcript(
            &id,
            &[Segment {
                speaker: "You".into(),
                timing: SegmentTiming::Untimed,
                text: "No timing".into(),
            }],
            "cloud",
            "whisper-1",
        )
        .unwrap();
        let detail = core.get_meeting(&id).unwrap();
        let options = ExportOptions {
            transcript: true,
            summary: false,
            filename: FilenamePattern::Title,
            transcript_formats: vec![TranscriptFormat::Txt, TranscriptFormat::Srt],
        };
        let failure = write_snapshot(&detail, dir.path(), &options).unwrap_err();
        assert_eq!(failure.code, "untimed_transcript");
        let meetings = dir.path().join("Meetings");
        let written = fs::read_dir(&meetings)
            .map(|entries| entries.count())
            .unwrap_or(0);
        assert_eq!(
            written, 0,
            "a refused export writes neither the snapshot nor a transcript file"
        );
        // Text alone is still allowed, and says which lines carry no timing.
        let text = ExportOptions {
            transcript_formats: vec![TranscriptFormat::Txt],
            ..options
        };
        let result = write_snapshot(&detail, dir.path(), &text).unwrap();
        assert_eq!(
            fs::read_to_string(&result.transcript_paths[0]).unwrap(),
            "[untimed] You: No timing\n"
        );
    }

    #[test]
    fn speaker_names_validate_persist_and_label_the_export() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_note("Fictional named speakers").unwrap();
        core.replace_transcript(
            &id,
            &[
                Segment {
                    speaker: "You".into(),
                    timing: SegmentTiming::Timed {
                        start_ms: 0,
                        end_ms: 100,
                    },
                    text: "Hello".into(),
                },
                Segment {
                    speaker: "Others".into(),
                    timing: SegmentTiming::Untimed,
                    text: "Hi".into(),
                },
            ],
            "whisper",
            "small",
        )
        .unwrap();
        let unnamed = render(&core.get_meeting(&id).unwrap(), &ALL);
        assert!(unnamed.contains("\n**You** (0.0s): Hello\n"));
        for bad in ["Two\nlines", &"n".repeat(81) as &str] {
            assert_eq!(
                core.save_speaker_names(&id, Some(bad), None)
                    .unwrap_err()
                    .code,
                "speaker_name"
            );
        }
        assert_eq!(
            core.save_speaker_names("missing", Some("Rahul"), None)
                .unwrap_err()
                .code,
            "not_found"
        );
        let names = core
            .save_speaker_names(&id, Some(" Rahul "), Some("Client team"))
            .unwrap();
        assert_eq!(names.you.as_deref(), Some("Rahul"));
        let detail = core.get_meeting(&id).unwrap();
        assert_eq!(detail.segments[0].speaker, "You");
        let named = render(&detail, &ALL);
        assert!(named.contains("\n**Rahul (You)** (0.0s): Hello\n"));
        assert!(named.contains("\n**Client team (Others)** (untimed): Hi\n"));
        let cleared = core.save_speaker_names(&id, Some(""), None).unwrap();
        assert_eq!(cleared, SpeakerNames::default());
        assert_eq!(render(&core.get_meeting(&id).unwrap(), &ALL), unnamed);
        core.save_speaker_names(&id, Some("Rahul"), None).unwrap();
        core.delete_meeting(&id).unwrap();
        let left: i64 = core
            .db
            .query_row("SELECT COUNT(*) FROM speaker_names", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn user_tags_follow_meeting_in_frontmatter_and_are_quoted() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_note("Fictional tagged export").unwrap();
        let plain = render(&core.get_meeting(&id).unwrap(), &ALL);
        assert!(plain.contains("tags: [meeting]\n---"));
        core.set_meeting_tags(&id, &["Client".into(), "Q4 \"plan\"".into()])
            .unwrap();
        let tagged = render(&core.get_meeting(&id).unwrap(), &ALL);
        assert!(tagged.contains("tags: [meeting, \"Client\", \"Q4 \\\"plan\\\"\"]\n---"));
    }

    #[test]
    fn tasks_export_outside_ai_markers_with_explicit_unknowns() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_note("Fictional tasks").unwrap();
        assert!(!render(&core.get_meeting(&id).unwrap(), &ALL).contains("## Tasks"));
        core.save_action_item(&id, None, "Send the deck", None, None, false)
            .unwrap();
        core.save_action_item(
            &id,
            None,
            "Book a room",
            Some("Sam"),
            Some("2026-11-02"),
            true,
        )
        .unwrap();
        let summary_off = ExportOptions {
            summary: false,
            ..ALL
        };
        for options in [ALL, summary_off] {
            let rendered = render(&core.get_meeting(&id).unwrap(), &options);
            let tasks = rendered.find("## Tasks").unwrap();
            assert!(rendered.rfind("%%ai-end%%").is_none_or(|end| end < tasks));
            assert!(rendered.contains(
                "- [ ] Send the deck — Owner: Unassigned — Due: not set — Added manually\n"
            ));
            assert!(rendered
                .contains("- [x] Book a room — Owner: Sam — Due: 2026-11-02 — Added manually\n"));
        }
    }

    #[test]
    fn filenames_and_frontmatter_handle_untrusted_titles() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_fixture().unwrap();
        let mut detail = core.get_meeting(&id).unwrap();
        detail.meeting.title = "../CON:<bad>\"\n---\nkey: injected".into();
        let name = filename(&detail, &ALL).unwrap();
        assert!(!name.chars().any(|c| "<>:\"/\\|?*\n".contains(c)));
        assert!(render(&detail, &ALL).contains("\\n---\\nkey: injected"));
    }

    #[test]
    fn unwritable_destination_does_not_change_notes() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("Meetings"), "not a directory").unwrap();
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_fixture().unwrap();
        let detail = core.get_meeting(&id).unwrap();
        assert!(write_snapshot(&detail, dir.path(), &ALL).is_err());
        assert_eq!(
            core.get_meeting(&id).unwrap().user_markdown,
            detail.user_markdown
        );
    }

    #[test]
    fn simulation_banner_says_no_audio_was_recorded() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.start("Simulated").unwrap().meeting_id.unwrap();
        core.stop().unwrap();
        let text = render(&core.get_meeting(&id).unwrap(), &ALL);
        assert!(text.contains("> Simulation: no audio was recorded."));
        assert!(!text.contains("duration:"));
    }

    #[test]
    fn fixture_banner_says_sample_and_hand_written() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_fixture().unwrap();
        let text = render(&core.get_meeting(&id).unwrap(), &ALL);
        assert!(text.contains("> Fictional sample: no audio was recorded"));
        assert!(text.contains("hand-written"));
    }

    #[test]
    fn desktop_banner_does_not_claim_missing_audio_and_reports_duration() {
        let core = Core::open(Path::new(":memory:")).unwrap();
        core.db
            .execute_batch(
                "INSERT INTO meetings(id, title, started_at, ended_at, source, status) VALUES ('6f9619ff-8b86-d011-b42d-00cf4fc964ff', 'Recorded', '2026-10-09T10:00:00Z', '2026-10-09T11:00:00Z', 'desktop', 'stopped');
                 INSERT INTO notes(meeting_id) VALUES ('6f9619ff-8b86-d011-b42d-00cf4fc964ff');
                 INSERT INTO tracks(meeting_id, kind, path, timing_path, device_name, sample_rate, channels, frames, finalized) VALUES
                   ('6f9619ff-8b86-d011-b42d-00cf4fc964ff', 'mic', 'mic.wav', 'mic.timing.jsonl', 'Fictional mic', 48000, 1, 3624000, 1),
                   ('6f9619ff-8b86-d011-b42d-00cf4fc964ff', 'system', 'system.wav', 'system.timing.jsonl', 'Fictional out', 44100, 2, 44100, 1);",
            )
            .unwrap();
        let detail = core
            .get_meeting("6f9619ff-8b86-d011-b42d-00cf4fc964ff")
            .unwrap();
        let text = render(&detail, &ALL);
        assert!(!text.to_lowercase().contains("no audio was recorded"));
        assert!(text.contains("> Recorded on this device"));
        assert!(text.contains("duration: \"0:01:15\"\n"));
        assert!(!text.contains("model:"), "no summary, no model");
    }

    #[test]
    fn export_options_render_each_combination() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_fixture().unwrap();
        let detail = core.get_meeting(&id).unwrap();
        for transcript in [true, false] {
            for summary in [true, false] {
                for pattern in [FilenamePattern::Title, FilenamePattern::DateTitle] {
                    let options = ExportOptions {
                        transcript,
                        summary,
                        filename: pattern,
                        transcript_formats: Vec::new(),
                    };
                    let text = render(&detail, &options);
                    let case = format!("{options:?}");
                    assert!(text.starts_with("---\ntitle: "), "{case}");
                    assert!(text.contains(&detail.user_markdown), "{case}");
                    assert_eq!(text.contains("## Summary"), summary, "{case}");
                    assert_eq!(text.contains("%%ai-start%%"), summary, "{case}");
                    assert_eq!(text.contains("template: \"fixture\"\n"), summary, "{case}");
                    assert_eq!(
                        text.contains("model: \"hand-written\"\n"),
                        summary,
                        "{case}"
                    );
                    assert_eq!(text.contains("## Transcript"), transcript, "{case}");
                    assert_eq!(
                        text.contains(&detail.segments[0].text),
                        transcript,
                        "{case}"
                    );
                    let name = filename(&detail, &options).unwrap();
                    assert!(name.ends_with(&format!(" - {id}.md")), "{case}");
                    match pattern {
                        FilenamePattern::Title => {
                            assert!(name.starts_with("Meeting Sample"), "{case}: {name}")
                        }
                        FilenamePattern::DateTitle => assert!(
                            name.starts_with(&format!(
                                "{} Sample",
                                &detail.meeting.started_at[..10]
                            )),
                            "{case}: {name}"
                        ),
                    }
                }
            }
        }
    }

    #[test]
    fn filename_pattern_is_a_closed_set_at_the_serde_boundary() {
        let parsed: ExportOptions = serde_json::from_value(
            serde_json::json!({ "transcript": false, "summary": true, "filename": "date_title" }),
        )
        .unwrap();
        assert_eq!(parsed.filename, FilenamePattern::DateTitle);
        for invalid in ["../evil", "Title", "", "date title"] {
            assert!(serde_json::from_value::<ExportOptions>(serde_json::json!({
                "transcript": true, "summary": true, "filename": invalid
            }))
            .is_err());
        }
    }

    #[test]
    fn untimed_transcript_exports_provenance_without_invented_timestamps() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_note("Untimed transcript").unwrap();
        core.replace_transcript(
            &id,
            &[
                Segment {
                    speaker: "You".into(),
                    text: "Local track words".into(),
                    timing: SegmentTiming::Untimed,
                },
                Segment {
                    speaker: "Others".into(),
                    text: "Remote track words".into(),
                    timing: SegmentTiming::Untimed,
                },
            ],
            "https://speech.example/v1",
            "speech-model",
        )
        .unwrap();
        let detail = core.get_meeting(&id).unwrap();
        let text = render(&detail, &ALL);
        assert!(text.contains("transcript_provider: \"https://speech.example/v1\""));
        assert!(text.contains("transcript_model: \"speech-model\""));
        assert!(text.contains("**You** (untimed): Local track words"));
        assert!(text.contains("**Others** (untimed): Remote track words"));
        assert!(!text.contains("(0.0s)"));
        let without = render(
            &detail,
            &ExportOptions {
                transcript: false,
                ..ALL
            },
        );
        assert!(!without.contains("transcript_provider"));
        assert!(!without.contains("speech-model"));
        assert!(!without.contains("Local track words"));
    }
}
