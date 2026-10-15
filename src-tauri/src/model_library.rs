//! Local speech-model library: a bounded, read-only disk scan for whisper.cpp model files and
//! explicit Hugging Face search/download. Nothing here runs without a user action.
use crate::{
    domain::{AppError, Result},
    providers::{client, read_capped},
    stt::{self, LocalModel},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

const MAX_DEPTH: usize = 12;
const MAX_FOUND: usize = 200;
const SCAN_BUDGET: Duration = Duration::from_secs(180);
const MIN_MODEL_BYTES: u64 = 1024 * 1024;
const MAX_DOWNLOAD_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_API_BYTES: u64 = 2 * 1024 * 1024;
const SKIP_DIRS: [&str; 6] = [
    "windows",
    "$recycle.bin",
    "system volume information",
    "node_modules",
    ".git",
    "target",
];
static CANCEL_SCAN: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Default, Serialize)]
pub struct ScanReport {
    pub found: Vec<LocalModel>,
    pub folders: usize,
    pub truncated: bool,
    pub cancelled: bool,
}

pub fn cancel_scan() {
    CANCEL_SCAN.store(true, Ordering::SeqCst);
}

/// whisper.cpp ggml header: magic "ggml", then n_vocab (51864..=51866) and n_audio_ctx (1500).
pub fn is_whisper_header(bytes: &[u8]) -> bool {
    let word = |at: usize| {
        bytes
            .get(at..at + 4)
            .map(|b| i32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    };
    bytes.get(..4) == Some(&[0x6c, 0x6d, 0x67, 0x67])
        && word(4).is_some_and(|vocab| (51864..=51866).contains(&vocab))
        && word(8) == Some(1500)
}

fn is_candidate_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".bin")
        && lower.contains("ggml")
        && !lower.contains("silero")
        && !lower.contains("vad")
}

fn read_header(path: &Path) -> Option<[u8; 12]> {
    let mut header = [0_u8; 12];
    File::open(path).ok()?.read_exact(&mut header).ok()?;
    Some(header)
}

pub fn model_id(path: &str) -> String {
    let digest = Sha256::digest(path.to_ascii_lowercase().as_bytes());
    format!(
        "local:{}",
        digest[..8]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

/// Builds a library entry if `path` is a readable whisper.cpp model.
pub fn describe(path: &Path, source: &str) -> Option<LocalModel> {
    let name = path.file_name()?.to_str()?.to_string();
    let size = fs::metadata(path).ok()?.len();
    let text = path.to_str()?.to_string();
    (size >= MIN_MODEL_BYTES && is_whisper_header(&read_header(path)?)).then(|| LocalModel {
        id: model_id(&text),
        name,
        path: text,
        size,
        source: source.to_string(),
        repo: None,
        revision: None,
        sha256: None,
        license: None,
    })
}

/// Cloud-only placeholders (OneDrive "online only") would be downloaded by reading them.
#[cfg(windows)]
fn cloud_placeholder(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & (0x1000 | 0x40_0000 | 0x4_0000) != 0
}
#[cfg(not(windows))]
fn cloud_placeholder(_: &fs::Metadata) -> bool {
    false
}

pub fn default_roots() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        ('C'..='Z')
            .map(|letter| PathBuf::from(format!("{letter}:\\")))
            .filter(|root| root.is_dir())
            .collect()
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .into_iter()
            .collect()
    }
}

/// Walks `roots` without following links or junctions, reading only 12 header bytes of files
/// that look like ggml models. Bounded by depth, result count and time.
pub fn scan(
    roots: Vec<PathBuf>,
    catalog_dir: &Path,
    mut progress: impl FnMut(usize, usize),
) -> ScanReport {
    CANCEL_SCAN.store(false, Ordering::SeqCst);
    let deadline = Instant::now() + SCAN_BUDGET;
    let mut report = ScanReport::default();
    let mut stack: Vec<(PathBuf, usize)> = roots.into_iter().map(|root| (root, 0)).collect();
    while let Some((folder, depth)) = stack.pop() {
        if CANCEL_SCAN.load(Ordering::SeqCst) {
            report.cancelled = true;
            break;
        }
        if Instant::now() > deadline || report.found.len() >= MAX_FOUND {
            report.truncated = true;
            break;
        }
        let Ok(entries) = fs::read_dir(&folder) else {
            continue;
        };
        report.folders += 1;
        if report.folders % 200 == 0 {
            progress(report.folders, report.found.len());
        }
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if kind.is_dir() {
                if depth < MAX_DEPTH && !SKIP_DIRS.contains(&name.to_ascii_lowercase().as_str()) {
                    stack.push((entry.path(), depth + 1));
                }
            } else if kind.is_file() && is_candidate_name(&name) {
                let path = entry.path();
                if path.parent() == Some(catalog_dir) && stt::is_catalog_file(&name) {
                    continue;
                }
                if entry.metadata().is_ok_and(|meta| cloud_placeholder(&meta)) {
                    continue;
                }
                if let Some(model) = describe(&path, "scan") {
                    report.found.push(model);
                }
            }
        }
    }
    progress(report.folders, report.found.len());
    report
}

// ---- Hugging Face ----

#[derive(Debug, Serialize)]
pub struct HfRepo {
    pub id: String,
    pub downloads: u64,
    pub likes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct HfFile {
    pub name: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Serialize)]
pub struct HfRepoFiles {
    pub repo: String,
    /// Commit the files were listed at; downloads are pinned to it.
    pub revision: String,
    pub license: Option<String>,
    pub files: Vec<HfFile>,
}

fn hf_error(message: &str) -> AppError {
    AppError::new("huggingface", message)
}

fn valid_segment(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 100
        && text != "."
        && text != ".."
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn valid_repo(repo: &str) -> bool {
    repo.split_once('/')
        .is_some_and(|(owner, name)| valid_segment(owner) && valid_segment(name))
}

fn valid_revision(revision: &str) -> bool {
    revision.len() == 40 && revision.chars().all(|c| c.is_ascii_hexdigit())
}

fn get_json<T: serde::de::DeserializeOwned>(url: &str, query: &[(&str, &str)]) -> Result<T> {
    let unreachable =
        || hf_error("Could not reach Hugging Face. Check your connection and try again.");
    let response = client(Duration::from_secs(20))
        .map_err(|_| unreachable())?
        .get(
            reqwest::Url::parse_with_params(url, query)
                .map_err(|_| hf_error("The search could not be prepared."))?,
        )
        .send()
        .map_err(|_| unreachable())?;
    if !response.status().is_success() {
        return Err(hf_error(&format!(
            "Hugging Face returned HTTP {}.",
            response.status()
        )));
    }
    let bytes = read_capped(response, MAX_API_BYTES)
        .ok_or_else(|| hf_error("Hugging Face returned an unexpectedly large response."))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| hf_error("Hugging Face returned an unsupported response."))
}

pub fn search(query: &str) -> Result<Vec<HfRepo>> {
    let query = query.trim();
    if query.chars().count() < 2
        || query.chars().count() > 80
        || query.chars().any(char::is_control)
    {
        return Err(hf_error("Enter 2 to 80 characters to search for."));
    }
    #[derive(Deserialize)]
    struct Item {
        id: String,
        #[serde(default)]
        downloads: u64,
        #[serde(default)]
        likes: u64,
        #[serde(default)]
        private: bool,
    }
    let items: Vec<Item> = get_json(
        "https://huggingface.co/api/models",
        &[
            ("search", query),
            ("limit", "20"),
            ("sort", "downloads"),
            ("direction", "-1"),
        ],
    )?;
    Ok(items
        .into_iter()
        .filter(|item| !item.private && valid_repo(&item.id))
        .map(|item| HfRepo {
            id: item.id,
            downloads: item.downloads,
            likes: item.likes,
        })
        .collect())
}

/// Lists the downloadable `.bin` files of a public repo at its current commit, with the
/// SHA-256 and size Hugging Face publishes for each LFS file.
pub fn repo_files(repo: &str) -> Result<HfRepoFiles> {
    if !valid_repo(repo) {
        return Err(hf_error(
            "That is not a valid Hugging Face repository name.",
        ));
    }
    #[derive(Deserialize)]
    struct Info {
        sha: String,
        #[serde(default)]
        private: bool,
        #[serde(default)]
        gated: serde_json::Value,
        #[serde(default, rename = "cardData")]
        card: Option<Card>,
    }
    #[derive(Deserialize)]
    struct Card {
        license: Option<serde_json::Value>,
    }
    #[derive(Deserialize)]
    struct Entry {
        #[serde(rename = "type")]
        kind: String,
        path: String,
        lfs: Option<Lfs>,
    }
    #[derive(Deserialize)]
    struct Lfs {
        oid: String,
        size: u64,
    }
    let info: Info = get_json(&format!("https://huggingface.co/api/models/{repo}"), &[])?;
    if info.private
        || !matches!(
            info.gated,
            serde_json::Value::Bool(false) | serde_json::Value::Null
        )
    {
        return Err(hf_error(
            "Private and gated repositories are not supported. Download those files yourself and use the scan.",
        ));
    }
    if !valid_revision(&info.sha) {
        return Err(hf_error("Hugging Face returned an unexpected revision."));
    }
    let entries: Vec<Entry> = get_json(
        &format!("https://huggingface.co/api/models/{repo}/tree/{}", info.sha),
        &[],
    )?;
    let files = entries
        .into_iter()
        .filter(|entry| entry.kind == "file" && valid_segment(&entry.path))
        .filter(|entry| entry.path.to_ascii_lowercase().ends_with(".bin"))
        .filter_map(|entry| {
            let lfs = entry.lfs?;
            (lfs.size >= MIN_MODEL_BYTES
                && lfs.size <= MAX_DOWNLOAD_BYTES
                && lfs.oid.len() == 64
                && lfs.oid.chars().all(|c| c.is_ascii_hexdigit()))
            .then(|| HfFile {
                name: entry.path,
                size: lfs.size,
                sha256: lfs.oid.to_ascii_lowercase(),
            })
        })
        .collect();
    Ok(HfRepoFiles {
        repo: repo.to_string(),
        revision: info.sha,
        license: info.card.and_then(|card| match card.license? {
            serde_json::Value::String(text) => Some(text),
            _ => None,
        }),
        files,
    })
}

/// Downloads one file pinned to the listed commit. The caller's displayed `sha256`/`size` must
/// match what Hugging Face reports now, so consent is bound to the exact content.
pub fn download(
    models_dir: &Path,
    repo: &str,
    file: &str,
    sha256: &str,
    size: u64,
    progress: impl FnMut(u64),
) -> Result<LocalModel> {
    let listed = repo_files(repo)?;
    let entry = listed
        .files
        .iter()
        .find(|item| item.name == file && item.sha256 == sha256 && item.size == size)
        .ok_or_else(|| {
            AppError::new(
                "processing_plan_changed",
                "The file changed on Hugging Face. Search again and review it before downloading.",
            )
        })?;
    fs::create_dir_all(models_dir)?;
    let local_name = format!("{}--{}", repo.replace('/', "_"), entry.name);
    let destination = models_dir.join(&local_name);
    if destination.exists() {
        return Err(hf_error(
            "That file is already in the models folder. Rescan to add it.",
        ));
    }
    let url = format!(
        "https://huggingface.co/{repo}/resolve/{}/{}",
        listed.revision, entry.name
    );
    stt::download_verified(
        &stt::download_client()?,
        &url,
        entry.size,
        &entry.sha256,
        &destination,
        progress,
    )?;
    let Some(mut model) = describe(&destination, "huggingface") else {
        let _ = fs::remove_file(&destination);
        return Err(hf_error(
            "That file is not a whisper.cpp speech model and was discarded.",
        ));
    };
    model.repo = Some(repo.to_string());
    model.revision = Some(listed.revision);
    model.sha256 = Some(entry.sha256.clone());
    model.license = listed.license;
    Ok(model)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(vocab: i32, ctx: i32) -> Vec<u8> {
        let mut bytes = vec![0x6c, 0x6d, 0x67, 0x67];
        bytes.extend(vocab.to_le_bytes());
        bytes.extend(ctx.to_le_bytes());
        bytes
    }

    #[test]
    fn header_check_accepts_only_whisper_models() {
        assert!(is_whisper_header(&header(51865, 1500)));
        assert!(is_whisper_header(&header(51866, 1500)));
        assert!(!is_whisper_header(&header(32000, 1500)));
        assert!(!is_whisper_header(&header(51865, 512)));
        assert!(!is_whisper_header(b"GGUF"));
    }

    #[test]
    fn scan_finds_models_skips_vad_and_unlisted_folders_and_respects_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a").join("b");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(dir.path().join("node_modules")).unwrap();
        let mut model = header(51865, 1500);
        model.resize(MIN_MODEL_BYTES as usize + 1, 0);
        fs::write(nested.join("ggml-custom.bin"), &model).unwrap();
        fs::write(nested.join("ggml-silero-v5.bin"), &model).unwrap();
        fs::write(dir.path().join("node_modules").join("ggml-x.bin"), &model).unwrap();
        fs::write(nested.join("ggml-llama.bin"), vec![0_u8; 2_000_000]).unwrap();
        let report = scan(vec![dir.path().to_path_buf()], Path::new("none"), |_, _| {});
        assert_eq!(report.found.len(), 1);
        assert_eq!(report.found[0].name, "ggml-custom.bin");
        assert!(report.found[0].id.starts_with("local:"));
    }

    #[test]
    fn library_models_can_be_selected_and_are_pruned_when_the_file_disappears() {
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = header(51865, 1500);
        bytes.resize(MIN_MODEL_BYTES as usize + 1, 0);
        let path = dir.path().join("ggml-mine.bin");
        fs::write(&path, &bytes).unwrap();
        let model = describe(&path, "scan").unwrap();
        let mut core = crate::storage::Core::open(Path::new(":memory:")).unwrap();
        assert!(core.save_stt_settings("auto", "", &model.id).is_err());
        core.add_local_models(std::slice::from_ref(&model), false)
            .unwrap();
        let settings = core.save_stt_settings("auto", "", &model.id).unwrap();
        assert_eq!(settings.stt_model, model.id);
        let status = stt::status_with(dir.path(), &model.id, &core.local_models().unwrap());
        assert!(status.model);
        fs::remove_file(&path).unwrap();
        core.add_local_models(&[], true).unwrap();
        assert!(core.local_models().unwrap().is_empty());
    }

    #[test]
    fn repo_and_file_names_are_validated() {
        assert!(valid_repo("ggerganov/whisper.cpp"));
        assert!(!valid_repo("../etc"));
        assert!(!valid_repo("a/b/c"));
        assert!(!valid_segment("..") && !valid_segment("a b"));
        assert!(valid_revision(&"a".repeat(40)) && !valid_revision("main"));
    }
}
