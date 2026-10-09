use crate::domain::*;
use std::{fs, io::Write, path::Path};
use uuid::Uuid;

pub fn render(detail: &MeetingDetail) -> String {
    // JSON-quoted strings are valid YAML double-quoted scalar values.
    let quote =
        |value: &str| serde_json::to_string(value).expect("string serialization is infallible");
    let mut output = format!(
        "---\ntitle: {}\ndate: {}\nmeeting_id: {}\nsource: {}\ntags: [meeting]\n---\n\n> Foundation preview: {}. No audio was recorded by this build.\n\n## Summary\n%%ai-start%%\n{}\n%%ai-end%%\n\n## My notes\n{}\n\n## Transcript\n",
        quote(&detail.meeting.title), quote(&detail.meeting.started_at), quote(&detail.meeting.id),
        quote(&detail.meeting.source), detail.meeting.source,
        detail.summary.as_deref().unwrap_or("No summary generated."), detail.user_markdown,
    );
    if detail.segments.is_empty() {
        output.push_str("No transcript generated.\n");
    }
    for segment in &detail.segments {
        output.push_str(&format!(
            "\n**{}** ({:.1}s): {}\n",
            segment.speaker,
            segment.start_ms as f64 / 1000.0,
            segment.text
        ));
    }
    output
}

pub fn filename(detail: &MeetingDetail) -> Result<String> {
    let id = Uuid::parse_str(&detail.meeting.id)
        .map_err(|_| AppError::new("invalid_id", "The meeting ID is invalid."))?;
    let title: String = detail
        .meeting
        .title
        .chars()
        .take(64)
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ' ') {
                c
            } else {
                '-'
            }
        })
        .collect();
    // A fixed prefix and UUID avoid Windows device names and title collisions.
    Ok(format!("Meeting {} - {id}.md", title.trim()))
}

pub fn write_snapshot(detail: &MeetingDetail, vault: &Path) -> Result<ExportResult> {
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
    let output = render(detail);
    let original = folder.join(filename(detail)?);
    match fs::symlink_metadata(&original) {
        Ok(metadata)
            if metadata.file_type().is_file()
                && metadata.len() == output.len() as u64
                && fs::read(&original)? == output.as_bytes() =>
        {
            return Ok(ExportResult {
                path: original.to_string_lossy().into_owned(),
                created_copy: false,
            });
        }
        _ => {}
    }
    // shortcut: export immutable snapshots; add AI-block merging only with Phase 1D conflict tests.
    // persist_noclobber also protects files created between our check and publish.
    let mut target = original.clone();
    for _ in 0..3 {
        let mut temp = tempfile::NamedTempFile::new_in(&folder)?;
        temp.write_all(output.as_bytes())?;
        temp.as_file().sync_all()?;
        match temp.persist_noclobber(&target) {
            Ok(_) => {
                return Ok(ExportResult {
                    path: target.to_string_lossy().into_owned(),
                    created_copy: target != original,
                })
            }
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                target = folder.join(format!(
                    "Meeting {} - copy-{}.md",
                    detail.meeting.id,
                    Uuid::new_v4()
                ));
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

    #[test]
    fn export_preserves_external_edits_and_reuses_identical_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_fixture().unwrap();
        let detail = core.get_meeting(&id).unwrap();
        let first = write_snapshot(&detail, dir.path()).unwrap();
        assert_eq!(
            first.path,
            write_snapshot(&detail, dir.path()).unwrap().path
        );
        fs::write(&first.path, "External edits must survive").unwrap();
        let second = write_snapshot(&detail, dir.path()).unwrap();
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
    fn filenames_and_frontmatter_handle_untrusted_titles() {
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_fixture().unwrap();
        let mut detail = core.get_meeting(&id).unwrap();
        detail.meeting.title = "../CON:<bad>\"\n---\nkey: injected".into();
        let name = filename(&detail).unwrap();
        assert!(!name.chars().any(|c| "<>:\"/\\|?*\n".contains(c)));
        assert!(render(&detail).contains("\\n---\\nkey: injected"));
    }

    #[test]
    fn unwritable_destination_does_not_change_notes() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("Meetings"), "not a directory").unwrap();
        let mut core = Core::open(Path::new(":memory:")).unwrap();
        let id = core.create_fixture().unwrap();
        let detail = core.get_meeting(&id).unwrap();
        assert!(write_snapshot(&detail, dir.path()).is_err());
        assert_eq!(
            core.get_meeting(&id).unwrap().user_markdown,
            detail.user_markdown
        );
    }
}
