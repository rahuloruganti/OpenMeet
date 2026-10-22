//! Explicit model discovery and verified file acquisition. Files never start inference servers.
use crate::{
    domain::{hex, AppError, Result},
    providers, stt,
};
use reqwest::{blocking::Client, redirect::Policy, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, MutexGuard,
    },
    time::Duration,
};

const MAX_ENTRIES: usize = 4096;
const MAX_MODELS: usize = 200;
const MAX_DEPTH: usize = 6;
const MAX_METADATA: u64 = 4 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024 * 1024;
/// Total bytes one sherpa-onnx folder download may take. Pinned folders are 110 MB to 500 MB.
const MAX_FOLDER_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_HUB_ITEMS: usize = 200;
const SPEECH_TAG: &str = "automatic-speech-recognition";
const HUB: &str = "https://huggingface.co";
/// Whole-request limit for one download; the largest pinned model is about 640 MB.
pub(crate) const TRANSFER_TIMEOUT: Duration = Duration::from_secs(30 * 60);
static ARTIFACTS: Mutex<()> = Mutex::new(());
static PUBLICATION: Mutex<()> = Mutex::new(());
static CANCEL: AtomicBool = AtomicBool::new(false);

pub(crate) struct ArtifactOperation {
    _owner: MutexGuard<'static, ()>,
}

impl ArtifactOperation {
    pub(crate) fn begin() -> Result<Self> {
        let owner = ARTIFACTS.try_lock().map_err(|_| {
            error("Another model download or import is running. Wait or cancel it first.")
        })?;
        CANCEL.store(false, Ordering::SeqCst);
        Ok(Self { _owner: owner })
    }
}

pub fn cancel_download() -> Result<()> {
    let _publication = PUBLICATION
        .lock()
        .map_err(|_| error("Model publication is unavailable."))?;
    CANCEL.store(true, Ordering::SeqCst);
    Ok(())
}

pub(crate) fn check_cancel() -> Result<()> {
    if CANCEL.load(Ordering::SeqCst) {
        return Err(AppError::new(
            "model_cancelled",
            "Model operation cancelled. No partial file was activated.",
        ));
    }
    Ok(())
}

fn error(message: impl Into<String>) -> AppError {
    AppError::new("model_library", message)
}

fn managed_folder(root: &Path, parts: &[&str]) -> Result<PathBuf> {
    fs::create_dir_all(root)?;
    let root = fs::canonicalize(root)?;
    let mut folder = root.clone();
    for part in parts {
        folder.push(part);
        match fs::symlink_metadata(&folder) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(error("A managed model folder is a link or is not a directory. Existing files were preserved."));
            }
            Ok(_) => {}
            Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&folder)?
            }
            Err(failure) => return Err(failure.into()),
        }
        if !fs::canonicalize(&folder)?.starts_with(&root) {
            return Err(error(
                "Managed model folders must stay inside OpenMeet's speech folder.",
            ));
        }
    }
    Ok(folder)
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelFormat {
    Whisper,
    Gguf,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
pub struct LocalModel {
    pub path: String,
    pub format: ModelFormat,
    pub size: u64,
    pub model_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ScanFolder {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct ModelScan {
    pub models: Vec<LocalModel>,
    pub folders: Vec<ScanFolder>,
    pub truncated: bool,
}

pub fn common_folders(home: &Path, stt_root: &Path) -> Vec<PathBuf> {
    vec![
        stt_root.join("models"),
        stt_root.join("library"),
        home.join(".cache/whisper"),
        home.join(".cache/huggingface/hub"),
        home.join(".ollama/models/blobs"),
        home.join(".lmstudio/models"),
        home.join(".cache/lm-studio/models"),
    ]
}

pub fn scan(folders: Vec<PathBuf>) -> ModelScan {
    scan_with_limits(folders, MAX_ENTRIES, MAX_MODELS, MAX_DEPTH)
}

fn scan_with_limits(
    folders: Vec<PathBuf>,
    max_entries: usize,
    max_models: usize,
    max_depth: usize,
) -> ModelScan {
    let mut result = ModelScan {
        models: Vec::new(),
        folders: Vec::new(),
        truncated: false,
    };
    let mut seen = BTreeSet::new();
    let mut entries = 0;
    for folder in folders {
        let mut status = "Scanned";
        let Ok(root) = fs::canonicalize(&folder) else {
            result.folders.push(ScanFolder {
                path: folder.to_string_lossy().into(),
                status: "Missing or inaccessible".into(),
            });
            continue;
        };
        if !root.is_dir() {
            result.folders.push(ScanFolder {
                path: folder.to_string_lossy().into(),
                status: "Not a folder".into(),
            });
            continue;
        }
        let mut pending = VecDeque::from([(root.clone(), 0)]);
        let mut visited = BTreeSet::from([root.clone()]);
        while let Some((directory, depth)) = pending.pop_front() {
            let Ok(children) = fs::read_dir(&directory) else {
                status = "Some folders inaccessible";
                continue;
            };
            for child in children {
                if entries >= max_entries || result.models.len() >= max_models {
                    result.truncated = true;
                    status = "Scan limit reached";
                    break;
                }
                entries += 1;
                let Ok(child) = child else {
                    status = "Some entries inaccessible";
                    continue;
                };
                let path = child.path();
                let kind = child.file_type();
                // Windows reports a junction as a link, not a directory, so decide by what the
                // entry resolves to. Hugging Face snapshots also link each file to a blob.
                let resolved = fs::canonicalize(&path).ok();
                let is_folder = match (&resolved, &kind) {
                    (Some(target), _) => target.is_dir(),
                    (None, Ok(kind)) => kind.is_dir(),
                    (None, Err(_)) => false,
                };
                if is_folder {
                    // Only a folder that resolves inside the approved root is read, and each one is
                    // walked once, so a link that leaves the root or points back at a parent costs
                    // nothing.
                    let Some(target) = resolved else {
                        status = "Some folders inaccessible";
                        continue;
                    };
                    if !target.starts_with(&root) || !visited.insert(target.clone()) {
                        continue;
                    }
                    if depth < max_depth {
                        pending.push_back((target, depth + 1));
                    } else {
                        result.truncated = true;
                        status = "Depth limit reached";
                    }
                    continue;
                }
                // Follow files only inside the approved root.
                let Some(resolved) = resolved else {
                    continue;
                };
                if !resolved.starts_with(&root) || !resolved.is_file() {
                    continue;
                }
                let Ok(metadata) = fs::metadata(&resolved) else {
                    continue;
                };
                let name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("");
                let mut magic = [0_u8; 4];
                if File::open(&resolved)
                    .and_then(|mut file| file.read_exact(&mut magic))
                    .is_err()
                {
                    continue;
                }
                let candidate = stt::model_files()
                    .find(|file| file.file == name && file.size == metadata.len());
                let format = if &magic == b"GGUF" {
                    ModelFormat::Gguf
                } else if &magic == b"ggml" || &magic == b"lmgg" {
                    ModelFormat::Whisper
                } else if name.ends_with(".bin")
                    || name.ends_with(".gguf")
                    || name.ends_with(".safetensors")
                {
                    ModelFormat::Unknown
                } else {
                    continue;
                };
                if seen.insert(resolved.clone()) {
                    result.models.push(LocalModel {
                        path: resolved.to_string_lossy().into(),
                        format,
                        size: metadata.len(),
                        model_id: candidate.map(|file| file.id.into()),
                    });
                }
            }
            if entries >= max_entries || result.models.len() >= max_models {
                break;
            }
        }
        if entries >= max_entries || result.models.len() >= max_models {
            result.truncated = true;
            status = "Scan limit reached";
        }
        result.folders.push(ScanFolder {
            path: folder.to_string_lossy().into(),
            status: status.into(),
        });
    }
    result
        .models
        .sort_by(|left, right| left.path.cmp(&right.path));
    result
}

#[derive(Debug, Serialize)]
pub struct ImportedModel {
    pub model_id: String,
}

pub fn import_model(root: &Path, path: &Path) -> Result<ImportedModel> {
    import_with_catalog(root, path, &stt::model_files().collect::<Vec<_>>())
}

fn import_with_catalog(
    root: &Path,
    path: &Path,
    catalog: &[stt::ModelFile],
) -> Result<ImportedModel> {
    let _operation = ArtifactOperation::begin()?;
    let mut input = File::open(path)
        .map_err(|_| error("Cannot open that model file. Scan its folder again."))?;
    let size = input.metadata()?.len();
    let candidates: Vec<_> = catalog
        .iter()
        .copied()
        .filter(|file| file.size == size)
        .collect();
    if candidates.is_empty() {
        return Err(error("This file does not match a pinned Whisper model size. Other Whisper files can be used in place."));
    }
    // Hash the copy, not a prior read of a file that may change while it is imported.
    let folder = managed_folder(root, &["models"])?;
    let mut temporary = tempfile::NamedTempFile::new_in(&folder)?;
    let hash = stream_hash(&mut input, &mut temporary, size, |_| {})?;
    let approved = candidates
        .into_iter()
        .find(|file| file.sha256 == hash)
        .ok_or_else(|| {
            error(
                "The file does not match a pinned Whisper checksum. Existing files were preserved.",
            )
        })?;
    temporary.as_file().sync_all()?;
    publish(temporary, &folder.join(approved.file))?;
    Ok(ImportedModel {
        model_id: approved.id.into(),
    })
}

fn stream_hash(
    reader: &mut impl Read,
    writer: &mut impl Write,
    size: u64,
    mut progress: impl FnMut(u64),
) -> Result<String> {
    let mut hash = Sha256::new();
    let mut done = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        check_cancel()?;
        let read = match reader.read(&mut buffer) {
            Ok(read) => read,
            Err(_) => {
                check_cancel()?;
                return Err(error(
                    "Model transfer interrupted. Retry explicitly; existing files were preserved.",
                ));
            }
        };
        if read == 0 {
            break;
        }
        done += read as u64;
        if done > size {
            return Err(error("The model file is larger than its pinned size."));
        }
        hash.update(&buffer[..read]);
        writer
            .write_all(&buffer[..read])
            .map_err(|_| error("Cannot write the model file. Check available disk space."))?;
        progress(done);
    }
    check_cancel()?;
    if done != size {
        return Err(error(
            "The model file is incomplete. Nothing was activated.",
        ));
    }
    Ok(hex(&hash.finalize()))
}

fn publish(temporary: tempfile::NamedTempFile, destination: &Path) -> Result<()> {
    let _publication = PUBLICATION
        .lock()
        .map_err(|_| error("Model publication is unavailable."))?;
    check_cancel()?;
    temporary.persist_noclobber(destination).map_err(|_| error("A file already exists at the destination, or publication failed. Existing files were preserved. Choose another model or inspect the destination."))?;
    Ok(())
}

pub(crate) fn copy_verified(
    reader: &mut impl Read,
    destination: &Path,
    size: u64,
    sha256: &str,
    progress: impl FnMut(u64),
) -> Result<()> {
    publish(
        verified_temporary(reader, destination, size, sha256, progress)?,
        destination,
    )
}

fn verified_temporary(
    reader: &mut impl Read,
    destination: &Path,
    size: u64,
    sha256: &str,
    progress: impl FnMut(u64),
) -> Result<tempfile::NamedTempFile> {
    let directory = destination
        .parent()
        .ok_or_else(|| error("Model destination is unavailable."))?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    if stream_hash(reader, &mut temporary, size, progress)? != sha256 {
        return Err(error(
            "The model checksum did not match. Nothing was activated.",
        ));
    }
    temporary.as_file().sync_all()?;
    Ok(temporary)
}

/// What a repository's file names say it holds. Search uses names only; downloads re-check.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HubKind {
    WhisperGgml,
    SherpaOnnx,
    Other,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HubModel {
    pub id: String,
    pub license: Option<String>,
    pub kind: HubKind,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct HubFile {
    pub repo_id: String,
    pub revision: String,
    pub filename: String,
    pub size: u64,
    pub sha256: String,
    pub license: Option<String>,
    pub model_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SherpaLayout {
    /// encoder, decoder and joiner ONNX files plus tokens.txt (Parakeet-style transducers).
    Transducer,
    /// encoder and merged decoder plus tokens.txt (Moonshine).
    Moonshine,
    /// One model*.onnx plus tokens.txt (SenseVoice-style).
    SingleModel,
}

/// One complete sherpa-onnx model folder. Every file is pinned by its LFS size and SHA-256.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct HubFolder {
    pub repo_id: String,
    pub revision: String,
    /// Folder inside the repository; empty for the repository root.
    pub folder: String,
    pub layout: SherpaLayout,
    pub license: Option<String>,
    pub files: Vec<HubFile>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct HubListing {
    /// Whisper ggml files (`ggml-*.bin`) anywhere in the repository.
    pub files: Vec<HubFile>,
    pub folders: Vec<HubFolder>,
}

#[derive(Debug, Serialize)]
pub struct DownloadedFolder {
    pub path: String,
    pub files: usize,
    /// The speech model id Settings uses for this folder (`sherpa-dir:<name>`).
    pub model_id: String,
}

#[derive(Debug, Serialize)]
pub struct DownloadedModel {
    pub path: String,
    pub model_id: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct Progress {
    pub downloaded: u64,
    pub total: u64,
}

#[derive(Deserialize)]
struct CardData {
    license: Option<serde_json::Value>,
}

fn license_name(card: Option<CardData>) -> Option<String> {
    card.and_then(|card| card.license)
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|value| value.len() <= 200 && !value.chars().any(char::is_control))
}

#[derive(Deserialize)]
struct HubMetadata {
    id: String,
    sha: Option<String>,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    gated: serde_json::Value,
    #[serde(rename = "cardData")]
    card: Option<CardData>,
    pipeline_tag: Option<String>,
    #[serde(default)]
    siblings: Vec<Sibling>,
}

#[derive(Deserialize)]
struct Sibling {
    rfilename: String,
    size: Option<u64>,
    lfs: Option<Lfs>,
}
#[derive(Deserialize)]
struct Lfs {
    size: u64,
    sha256: String,
}

fn valid_repo(repo: &str) -> bool {
    repo.len() <= 200
        && repo.split('/').count() == 2
        && repo.split('/').all(|part| {
            !part.is_empty()
                && !part.starts_with('.')
                && !part.ends_with('.')
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
}

fn valid_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_filename(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.split('/').all(|part| {
            !part.is_empty()
                && !part.starts_with('.')
                && !part.ends_with(['.', ' '])
                && !matches!(
                    part.split('.')
                        .next()
                        .unwrap_or("")
                        .to_ascii_uppercase()
                        .as_str(),
                    "CON"
                        | "PRN"
                        | "AUX"
                        | "NUL"
                        | "COM1"
                        | "COM2"
                        | "COM3"
                        | "COM4"
                        | "COM5"
                        | "COM6"
                        | "COM7"
                        | "COM8"
                        | "COM9"
                        | "LPT1"
                        | "LPT2"
                        | "LPT3"
                        | "LPT4"
                        | "LPT5"
                        | "LPT6"
                        | "LPT7"
                        | "LPT8"
                        | "LPT9"
                )
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_ .".contains(&b))
        })
}

fn api_url(base: &str, parts: &[&str]) -> Result<Url> {
    let mut url = Url::parse(base).map_err(|_| error("Invalid model service address."))?;
    url.path_segments_mut()
        .map_err(|_| error("Invalid model service address."))?
        .extend(parts);
    Ok(url)
}

fn fetch_json<T: serde::de::DeserializeOwned>(url: Url) -> Result<T> {
    let response = providers::client(Duration::from_secs(15))
        .map_err(|_| error("Cannot prepare model search."))?
        .get(url)
        .send()
        .map_err(|_| error("Cannot reach Hugging Face. Retry explicitly."))?;
    providers::check_status(response.status())?;
    let data = providers::read_capped(response, MAX_METADATA)
        .ok_or_else(|| error("The model listing exceeds the supported response limit."))?;
    serde_json::from_slice(&data)
        .map_err(|_| error("The model service returned unsupported metadata."))
}

pub fn search(query: &str) -> Result<Vec<HubModel>> {
    search_at(HUB, query)
}

fn search_at(base: &str, query: &str) -> Result<Vec<HubModel>> {
    let query = query.trim();
    if query.is_empty() || query.len() > 100 || query.chars().any(char::is_control) {
        return Err(error("Enter a model search of 1–100 bytes."));
    }
    let mut url = api_url(base, &["api", "models"])?;
    url.query_pairs_mut()
        .append_pair("search", query)
        .append_pair("pipeline_tag", SPEECH_TAG)
        .append_pair("limit", "20")
        .append_pair("full", "true");
    let results: Vec<HubMetadata> = fetch_json(url)?;
    if results.len() > 20 {
        return Err(error("Model search returned too many results."));
    }
    Ok(results
        .into_iter()
        .filter(|item| {
            valid_repo(&item.id)
                && !item.private
                && (item.gated.is_null() || item.gated == false)
                && item
                    .pipeline_tag
                    .as_deref()
                    .is_none_or(|tag| tag == SPEECH_TAG)
        })
        .map(|item| HubModel {
            kind: kind_of(&item.siblings),
            id: item.id,
            license: license_name(item.card),
        })
        .collect())
}

fn split_path(path: &str) -> (&str, &str) {
    path.rsplit_once('/').unwrap_or(("", path))
}

fn is_ggml(name: &str) -> bool {
    name.starts_with("ggml-") && name.ends_with(".bin")
}

/// Matches one sherpa-onnx layout by the file names in one folder. Each role needs exactly one
/// file, so an ambiguous folder (say, int8 and full-precision encoders) is not offered.
pub(crate) fn sherpa_layout<'a>(names: &[&'a str]) -> Option<(SherpaLayout, Vec<&'a str>)> {
    let only = |matches: &dyn Fn(&str) -> bool| -> Option<&'a str> {
        let mut found = names.iter().copied().filter(|name| matches(name));
        let first = found.next()?;
        found.next().is_none().then_some(first)
    };
    let tokens = only(&|name| name == "tokens.txt")?;
    let onnx = |name: &str| name.ends_with(".onnx");
    let onnx_or_ort = |name: &str| onnx(name) || name.ends_with(".ort");
    if let (Some(encoder), Some(decoder), Some(joiner)) = (
        only(&|name| name.starts_with("encoder") && onnx(name)),
        only(&|name| name.starts_with("decoder") && onnx(name)),
        only(&|name| name.starts_with("joiner") && onnx(name)),
    ) {
        return Some((
            SherpaLayout::Transducer,
            vec![encoder, decoder, joiner, tokens],
        ));
    }
    if let (Some(encoder), Some(decoder)) = (
        only(&|name| name.starts_with("encoder") && onnx_or_ort(name)),
        only(&|name| name.starts_with("decoder_model_merged") && onnx_or_ort(name)),
    ) {
        return Some((SherpaLayout::Moonshine, vec![encoder, decoder, tokens]));
    }
    let model = only(&|name| name.starts_with("model") && onnx(name))?;
    Some((SherpaLayout::SingleModel, vec![model, tokens]))
}

fn kind_of(siblings: &[Sibling]) -> HubKind {
    let names: Vec<&str> = siblings
        .iter()
        .map(|sibling| sibling.rfilename.as_str())
        .filter(|name| valid_filename(name))
        .collect();
    let mut folders: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for name in &names {
        let (folder, base) = split_path(name);
        folders.entry(folder).or_default().push(base);
    }
    if folders.values().any(|bases| sherpa_layout(bases).is_some()) {
        HubKind::SherpaOnnx
    } else if names.iter().any(|name| is_ggml(split_path(name).1)) {
        HubKind::WhisperGgml
    } else {
        HubKind::Other
    }
}

pub fn list_files(repo: &str) -> Result<HubListing> {
    list_files_at(HUB, repo, None)
}

fn list_files_at(base: &str, repo: &str, revision: Option<&str>) -> Result<HubListing> {
    if !valid_repo(repo) || revision.is_some_and(|value| !valid_hex(value, 40)) {
        return Err(error("Invalid model repository or revision."));
    }
    let mut parts = vec!["api", "models"];
    parts.extend(repo.split('/'));
    if let Some(revision) = revision {
        parts.extend(["revision", revision]);
    }
    let mut url = api_url(base, &parts)?;
    url.query_pairs_mut().append_pair("blobs", "true");
    let metadata: HubMetadata = fetch_json(url)?;
    parse_files(metadata, repo, revision)
}

fn parse_files(metadata: HubMetadata, repo: &str, requested: Option<&str>) -> Result<HubListing> {
    if metadata.id != repo
        || metadata.private
        || !(metadata.gated.is_null() || metadata.gated == false)
        || metadata.siblings.len() > 2000
    {
        return Err(error(
            "Only bounded public, ungated model repositories are supported.",
        ));
    }
    let revision = metadata
        .sha
        .filter(|value| valid_hex(value, 40))
        .ok_or_else(|| error("The model repository has no pinned commit revision."))?;
    if requested.is_some_and(|requested| requested != revision) {
        return Err(error("The model revision changed. Refresh its files."));
    }
    let license = license_name(metadata.card);
    let mut listing = HubListing {
        files: Vec::new(),
        folders: Vec::new(),
    };
    let mut by_folder: BTreeMap<String, Vec<HubFile>> = BTreeMap::new();
    for sibling in metadata.siblings {
        if !valid_filename(&sibling.rfilename) {
            continue;
        }
        let Some(lfs) = sibling.lfs else {
            continue;
        };
        if sibling.size != Some(lfs.size)
            || lfs.size < 4
            || lfs.size > MAX_FILE_BYTES
            || !valid_hex(&lfs.sha256, 64)
        {
            continue;
        }
        let (folder, name) = split_path(&sibling.rfilename);
        let folder = folder.to_string();
        let catalog = stt::model_files()
            .find(|known| {
                known.file == name && known.size == lfs.size && known.sha256 == lfs.sha256
            })
            .map(|known| known.id.to_string());
        let whisper = is_ggml(name);
        let file = HubFile {
            repo_id: repo.into(),
            revision: revision.clone(),
            filename: sibling.rfilename,
            size: lfs.size,
            sha256: lfs.sha256,
            license: license.clone(),
            model_id: catalog,
        };
        if whisper {
            listing.files.push(file.clone());
        }
        by_folder.entry(folder).or_default().push(file);
    }
    // A sherpa-onnx folder is offered only when every file its layout needs is present with
    // an LFS checksum; a partial folder is not a model.
    for (folder, candidates) in by_folder {
        let names: Vec<&str> = candidates
            .iter()
            .map(|file| split_path(&file.filename).1)
            .collect();
        let Some((layout, needed)) = sherpa_layout(&names) else {
            continue;
        };
        let needed: Vec<String> = needed.into_iter().map(str::to_owned).collect();
        let files: Vec<HubFile> = candidates
            .into_iter()
            .filter(|file| {
                needed
                    .iter()
                    .any(|name| name == split_path(&file.filename).1)
            })
            .collect();
        if files.iter().map(|file| file.size).sum::<u64>() > MAX_FOLDER_BYTES {
            continue;
        }
        listing.folders.push(HubFolder {
            repo_id: repo.into(),
            revision: revision.clone(),
            folder,
            layout,
            license: license.clone(),
            files,
        });
    }
    if listing.files.len() > MAX_HUB_ITEMS || listing.folders.len() > MAX_HUB_ITEMS {
        return Err(error(
            "This repository has too many supported files. Use a smaller repository.",
        ));
    }
    Ok(listing)
}

/// Blocking client for model and engine downloads: a 15 second connect timeout, the shared
/// transfer timeout, and at most five redirects, each accepted only when `allowed` approves it.
pub(crate) fn download_client(allowed: fn(&Url) -> bool) -> Result<Client> {
    Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(TRANSFER_TIMEOUT)
        .redirect(Policy::custom(move |attempt| {
            if allowed(attempt.url()) && attempt.previous().len() < 5 {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|_| error("Cannot prepare the model download."))
}

/// Hugging Face hosts over HTTPS with no credentials and the default port.
fn huggingface_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|host| {
            host == "huggingface.co"
                || host.ends_with(".huggingface.co")
                || host.ends_with(".hf.co")
        })
}

pub fn download(
    root: &Path,
    proposed: HubFile,
    mut progress: impl FnMut(Progress),
) -> Result<DownloadedModel> {
    download_at(
        root,
        proposed,
        &mut progress,
        HUB,
        &download_client(huggingface_url)?,
    )
}

fn download_at(
    root: &Path,
    proposed: HubFile,
    mut progress: impl FnMut(Progress),
    base: &str,
    client: &Client,
) -> Result<DownloadedModel> {
    let _operation = ArtifactOperation::begin()?;
    let approved = list_files_at(base, &proposed.repo_id, Some(&proposed.revision))?
        .files
        .into_iter()
        .find(|file| file == &proposed)
        .ok_or_else(|| error("Model metadata changed. Refresh and confirm the download again."))?;
    check_cancel()?;
    let folder = managed_folder(root, &["models"])?;
    let filename = approved
        .filename
        .rsplit('/')
        .next()
        .ok_or_else(|| error("Invalid model filename."))?;
    let destination = folder.join(filename);
    if destination.exists() {
        return Err(error(
            "This destination already exists. It was preserved. Scan local models to inspect it.",
        ));
    }
    let mut parts: Vec<&str> = approved.repo_id.split('/').collect();
    parts.extend(["resolve", &approved.revision]);
    parts.extend(approved.filename.split('/'));
    let url = api_url(base, &parts)?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|_| error("Cannot download this model. Existing files were preserved."))?;
    providers::check_status(response.status())?;
    if response
        .content_length()
        .is_some_and(|size| size != approved.size)
    {
        return Err(error(
            "The model download size differs from its pinned metadata.",
        ));
    }
    let temporary = verified_temporary(
        &mut response,
        &destination,
        approved.size,
        &approved.sha256,
        |downloaded| {
            progress(Progress {
                downloaded,
                total: approved.size,
            })
        },
    )?;
    let manifest_path = destination.with_file_name(format!("{filename}.openmeet.json"));
    let mut manifest = tempfile::NamedTempFile::new_in(&folder)?;
    serde_json::to_writer_pretty(&mut manifest, &approved)
        .map_err(|_| error("Cannot prepare the model provenance manifest."))?;
    manifest.as_file().sync_all()?;
    let _publication = PUBLICATION
        .lock()
        .map_err(|_| error("Model publication is unavailable."))?;
    check_cancel()?;
    if manifest_path.exists() || destination.exists() {
        return Err(error(
            "The model destination or manifest already exists. Existing files were preserved.",
        ));
    }
    temporary
        .persist_noclobber(&destination)
        .map_err(|_| error("Model publication failed. Existing files were preserved."))?;
    manifest.persist_noclobber(&manifest_path).map_err(|_| error("The verified model file was saved, but its provenance manifest could not be published. Scan the library before retrying."))?;
    Ok(DownloadedModel {
        path: destination.to_string_lossy().into(),
        model_id: approved.model_id,
    })
}

pub fn download_folder(
    root: &Path,
    proposed: HubFolder,
    mut progress: impl FnMut(Progress),
) -> Result<DownloadedFolder> {
    download_folder_at(
        root,
        proposed,
        &mut progress,
        HUB,
        &download_client(huggingface_url)?,
    )
}

fn folder_name(folder: &HubFolder) -> String {
    let repo = folder.repo_id.replace('/', "--");
    if folder.folder.is_empty() {
        repo
    } else {
        format!("{repo}--{}", folder.folder.replace('/', "--"))
    }
}

/// All-or-nothing: every file is staged and verified in a hidden folder, which is renamed into
/// `sherpa/custom/` only after the last checksum passed. Any failure leaves no folder behind.
fn download_folder_at(
    root: &Path,
    proposed: HubFolder,
    mut progress: impl FnMut(Progress),
    base: &str,
    client: &Client,
) -> Result<DownloadedFolder> {
    let _operation = ArtifactOperation::begin()?;
    let approved = list_files_at(base, &proposed.repo_id, Some(&proposed.revision))?
        .folders
        .into_iter()
        .find(|folder| folder == &proposed)
        .ok_or_else(|| error("Model metadata changed. Refresh and confirm the download again."))?;
    check_cancel()?;
    let total: u64 = approved.files.iter().map(|file| file.size).sum();
    let custom = managed_folder(root, &["sherpa", "custom"])?;
    let destination = custom.join(folder_name(&approved));
    if destination.exists() {
        return Err(error(
            "This folder already exists. It was preserved. Scan local models to inspect it.",
        ));
    }
    let staging = tempfile::Builder::new()
        .prefix(".staging-")
        .tempdir_in(&custom)?;
    let mut done = 0_u64;
    for file in &approved.files {
        let filename = file
            .filename
            .rsplit('/')
            .next()
            .ok_or_else(|| error("Invalid model filename."))?;
        let target = staging.path().join(filename);
        let mut parts: Vec<&str> = approved.repo_id.split('/').collect();
        parts.extend(["resolve", &approved.revision]);
        parts.extend(file.filename.split('/'));
        let mut response = client
            .get(api_url(base, &parts)?)
            .send()
            .map_err(|_| error("Cannot download this model. Existing files were preserved."))?;
        providers::check_status(response.status())?;
        if response
            .content_length()
            .is_some_and(|size| size != file.size)
        {
            return Err(error(
                "The model download size differs from its pinned metadata.",
            ));
        }
        let temporary = verified_temporary(&mut response, &target, file.size, &file.sha256, |n| {
            progress(Progress {
                downloaded: done + n,
                total,
            })
        })?;
        temporary
            .persist_noclobber(&target)
            .map_err(|_| error("Model publication failed. Nothing was activated."))?;
        done += file.size;
    }
    let manifest = serde_json::to_vec_pretty(&approved)
        .map_err(|_| error("Cannot prepare the model provenance manifest."))?;
    fs::write(staging.path().join("openmeet-source.json"), manifest)?;
    let _publication = PUBLICATION
        .lock()
        .map_err(|_| error("Model publication is unavailable."))?;
    check_cancel()?;
    if destination.exists() {
        return Err(error(
            "This folder already exists. It was preserved. Scan local models to inspect it.",
        ));
    }
    let staged = staging.keep();
    fs::rename(&staged, &destination).map_err(|_| {
        let _ = fs::remove_dir_all(&staged);
        error("Folder publication failed. Existing files were preserved.")
    })?;
    Ok(DownloadedFolder {
        model_id: stt::custom_model_id(&folder_name(&approved)),
        path: destination.to_string_lossy().into(),
        files: approved.files.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{net::TcpListener, thread, time::Instant};

    static TEST_OPERATIONS: Mutex<()> = Mutex::new(());

    fn mock_hub(responses: Vec<Vec<u8>>) -> (String, thread::JoinHandle<Vec<String>>) {
        mock_hub_responses(responses.into_iter().map(|body| (body, false)).collect())
    }

    fn mock_hub_responses(
        responses: Vec<(Vec<u8>, bool)>,
    ) -> (String, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = thread::spawn(move || {
            let mut requests = Vec::new();
            for (body, stall) in responses {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(failure) if failure.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline, "Expected explicit model request");
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(failure) => panic!("{failure}"),
                    }
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    assert_eq!(socket.read(&mut byte).unwrap(), 1);
                    request.push(byte[0]);
                    assert!(request.len() < 8192);
                }
                let request = String::from_utf8(request).unwrap();
                assert!(!request.to_ascii_lowercase().contains("authorization:"));
                requests.push(request.lines().next().unwrap().into());
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                if stall {
                    socket.write_all(&body[..4]).unwrap();
                    socket.flush().unwrap();
                    thread::sleep(Duration::from_millis(200));
                    let _ = socket.write_all(&body[4..]);
                } else {
                    socket.write_all(&body).unwrap();
                }
            }
            requests
        });
        (base, task)
    }

    fn metadata_for(bytes: &[u8]) -> serde_json::Value {
        serde_json::json!({"id":"team/model","sha":"a".repeat(40),"gated":false,"private":false,"pipeline_tag":SPEECH_TAG,"cardData":{"license":"apache-2.0"},"siblings":[{"rfilename":"ggml-model.bin","size":bytes.len(),"lfs":{"size":bytes.len(),"sha256":hex(&Sha256::digest(bytes))}}]})
    }

    /// A repository whose every file is LFS-pinned, as the Hub reports them.
    fn repo_metadata(id: &str, files: &[(&str, &[u8])]) -> serde_json::Value {
        let siblings: Vec<_> = files
            .iter()
            .map(|(name, bytes)| {
                serde_json::json!({"rfilename": name, "size": bytes.len(), "lfs": {"size": bytes.len(), "sha256": hex(&Sha256::digest(bytes))}})
            })
            .collect();
        serde_json::json!({"id":id,"sha":"a".repeat(40),"gated":false,"private":false,"pipeline_tag":SPEECH_TAG,"cardData":{"license":"apache-2.0"},"siblings":siblings})
    }

    fn parse(value: serde_json::Value) -> Result<HubListing> {
        parse_files(serde_json::from_value(value).unwrap(), "team/model", None)
    }

    const TRANSDUCER: [(&str, &[u8]); 4] = [
        ("encoder.onnx", b"enc!"),
        ("decoder.onnx", b"dec!"),
        ("joiner.onnx", b"joi!"),
        ("tokens.txt", b"tok!"),
    ];

    #[test]
    fn scan_reports_formats_roots_and_global_limits() {
        let tree = tempfile::tempdir().unwrap();
        fs::create_dir(tree.path().join("nested")).unwrap();
        fs::write(tree.path().join("a.gguf"), b"GGUFfixture").unwrap();
        fs::write(tree.path().join("nested/b.bin"), b"not a model").unwrap();
        let result = scan(vec![tree.path().into(), tree.path().join("missing")]);
        assert_eq!(result.models.len(), 2);
        assert_eq!(result.models[0].format, ModelFormat::Gguf);
        assert_eq!(result.models[1].format, ModelFormat::Unknown);
        assert!(result.models.iter().all(|model| model.model_id.is_none()));
        assert_eq!(result.folders[1].status, "Missing or inaccessible");
        assert!(!result.truncated);
        let limited = scan_with_limits(vec![tree.path().into()], 1, 1, 0);
        assert!(limited.truncated);
        assert!(limited.models.len() <= 1);
    }

    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        // cmd.exe rejects forward slashes inside a path as switches.
        let windows_path = |path: &Path| path.to_string_lossy().replace('/', "\\");
        let output = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(windows_path(link))
            .arg(windows_path(target))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction {link:?} -> {target:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(windows)]
    #[test]
    fn scan_follows_directory_junctions_inside_the_root_and_never_outside() {
        let inside = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let deep = inside.path().join("a/b/moved");
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("model.gguf"), b"GGUFinside").unwrap();
        fs::write(outside.path().join("secret.gguf"), b"GGUFoutside").unwrap();
        junction(&inside.path().join("cache"), &deep);
        junction(&inside.path().join("other"), outside.path());
        // A depth limit hides the real folder, so only the junction at the root can reach the model.
        let result = scan_with_limits(vec![inside.path().into()], 100, 100, 1);
        assert_eq!(
            result.models.len(),
            1,
            "the junction inside the root is followed once; the one outside is refused"
        );
        assert_eq!(result.models[0].format, ModelFormat::Gguf);
        assert!(
            result.models[0].path.ends_with("model.gguf"),
            "{}",
            result.models[0].path
        );
    }

    #[cfg(windows)]
    #[test]
    fn scan_does_not_descend_into_a_link_that_leaves_the_root() {
        let inside = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        for index in 0..20 {
            fs::write(outside.path().join(format!("f{index}.txt")), b"x").unwrap();
        }
        junction(&inside.path().join("other"), outside.path());
        let result = scan_with_limits(vec![inside.path().into()], 10, 10, 6);
        assert!(result.models.is_empty());
        assert!(
            !result.truncated,
            "a linked folder outside the root is not read at all"
        );
    }

    #[cfg(windows)]
    #[test]
    fn scan_of_a_junctioned_root_and_a_junction_loop_terminates() {
        let tree = tempfile::tempdir().unwrap();
        let real = tree.path().join("real");
        fs::create_dir_all(real.join("models")).unwrap();
        fs::write(real.join("models/model.gguf"), b"GGUFinside").unwrap();
        junction(&real.join("loop"), &real);
        junction(&tree.path().join("root"), &real);
        let result = scan(vec![tree.path().join("root")]);
        assert_eq!(
            result.models.len(),
            1,
            "a selected junctioned root is scanned, and a loop is walked once"
        );
    }

    #[cfg(unix)]
    #[test]
    fn scan_never_follows_file_links_outside_the_requested_root() {
        let inside = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.gguf"), b"GGUFoutside").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.gguf"),
            inside.path().join("link.gguf"),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), inside.path().join("other")).unwrap();
        let result = scan(vec![inside.path().into()]);
        assert!(result.models.is_empty());
    }

    #[test]
    fn search_asks_only_for_speech_models_and_says_what_each_result_holds() {
        let whisper = repo_metadata("team/whisper", &[("ggml-model.bin", b"ggmlsynthetic")]);
        let sherpa = repo_metadata("team/sherpa", &TRANSDUCER);
        let other = repo_metadata("team/other", &[("model.safetensors", b"x")]);
        let mut text = repo_metadata("team/text", &[("ggml-model.bin", b"ggmlsynthetic")]);
        text["pipeline_tag"] = "text-generation".into();
        let (base, task) = mock_hub(vec![serde_json::to_vec(&vec![
            whisper, sherpa, other, text,
        ])
        .unwrap()]);
        let results = search_at(&base, "fixture").unwrap();
        assert_eq!(
            results
                .iter()
                .map(|model| (model.id.as_str(), model.kind))
                .collect::<Vec<_>>(),
            vec![
                ("team/whisper", HubKind::WhisperGgml),
                ("team/sherpa", HubKind::SherpaOnnx),
                ("team/other", HubKind::Other),
            ]
        );
        assert_eq!(
            task.join().unwrap(),
            ["GET /api/models?search=fixture&pipeline_tag=automatic-speech-recognition&limit=20&full=true HTTP/1.1"]
        );
        assert!(search_at(&base, "").is_err());
    }

    #[test]
    fn ggml_files_from_any_repository_are_offered_but_gguf_is_not() {
        let listing = parse(metadata_for(b"ggmlsynthetic")).unwrap();
        assert_eq!(listing.files.len(), 1);
        assert_eq!(listing.files[0].filename, "ggml-model.bin");
        assert_eq!(listing.files[0].license.as_deref(), Some("apache-2.0"));
        assert!(listing.files[0].model_id.is_none());
        assert!(listing.folders.is_empty());
        let gguf = parse(repo_metadata(
            "team/model",
            &[("model.gguf", b"GGUFsynthetic")],
        ))
        .unwrap();
        assert!(gguf.files.is_empty() && gguf.folders.is_empty());
    }

    #[test]
    fn metadata_pins_only_complete_files_and_rejects_path_traversal() {
        let raw = serde_json::json!({"id":"team/model", "sha":"a".repeat(40), "private":false, "gated":false, "cardData":{"license":"apache-2.0"}, "siblings":[
            {"rfilename":"ggml-model.bin","size":10,"lfs":{"size":10,"sha256":"b".repeat(64)}},
            {"rfilename":"../ggml-escape.bin","size":10,"lfs":{"size":10,"sha256":"b".repeat(64)}},
            {"rfilename":"ggml-unhashed.bin","size":10},
            {"rfilename":"model.gguf","size":10,"lfs":{"size":10,"sha256":"b".repeat(64)}}
        ]});
        let listing = parse(raw.clone()).unwrap();
        assert_eq!(listing.files.len(), 1);
        assert_eq!(listing.files[0].filename, "ggml-model.bin");
        let mut private = raw.clone();
        private["gated"] = serde_json::json!("auto");
        assert!(parse(private).is_err());
        assert!(parse_files(
            serde_json::from_value(raw).unwrap(),
            "team/model",
            Some(&"c".repeat(40))
        )
        .is_err());
        for name in [
            "../model.bin",
            "folder/../model.bin",
            "C:\\model.bin",
            "/root.bin",
            "file.bin.",
        ] {
            assert!(!valid_filename(name));
        }
        for repo in ["../escape", "bad", "a/b/c", "a/.hidden"] {
            assert!(!valid_repo(repo));
        }
    }

    #[test]
    fn sherpa_layouts_need_their_complete_file_set() {
        let (layout, needed) = sherpa_layout(&[
            "encoder.onnx",
            "decoder.onnx",
            "joiner.onnx",
            "tokens.txt",
            "README.md",
        ])
        .unwrap();
        assert_eq!(layout, SherpaLayout::Transducer);
        assert_eq!(needed.len(), 4);
        assert_eq!(
            sherpa_layout(&[
                "encoder_model.ort",
                "decoder_model_merged.ort",
                "tokens.txt"
            ])
            .unwrap()
            .0,
            SherpaLayout::Moonshine
        );
        assert_eq!(
            sherpa_layout(&["model.int8.onnx", "tokens.txt"]).unwrap().0,
            SherpaLayout::SingleModel
        );
        assert!(sherpa_layout(&["encoder.onnx", "decoder.onnx", "tokens.txt"]).is_none());
        assert!(sherpa_layout(&[
            "encoder.int8.onnx",
            "encoder.onnx",
            "decoder.onnx",
            "joiner.onnx",
            "tokens.txt"
        ])
        .is_none());
        assert!(sherpa_layout(&["model.onnx", "README.md"]).is_none());
    }

    #[test]
    fn partial_or_unpinned_sherpa_folders_are_not_offered() {
        let partial = parse(repo_metadata("team/model", &TRANSDUCER[..3])).unwrap();
        assert!(partial.folders.is_empty());
        let mut unpinned = repo_metadata("team/model", &TRANSDUCER);
        unpinned["siblings"][3]
            .as_object_mut()
            .unwrap()
            .remove("lfs");
        assert!(parse(unpinned).unwrap().folders.is_empty());
        let complete = parse(repo_metadata("team/model", &TRANSDUCER)).unwrap();
        assert_eq!(complete.folders.len(), 1);
        assert_eq!(complete.folders[0].files.len(), 4);
    }

    #[test]
    fn ggml_downloads_go_to_models_and_publish_only_with_the_pinned_sha256() {
        let _serial = TEST_OPERATIONS.lock().unwrap();
        let bytes = b"ggmlsynthetic";
        let metadata = metadata_for(bytes);
        let proposed = parse(metadata.clone()).unwrap().files.remove(0);
        let root = tempfile::tempdir().unwrap();
        let client = providers::client(Duration::from_secs(2)).unwrap();
        let (base, task) = mock_hub(vec![serde_json::to_vec(&metadata).unwrap(), bytes.to_vec()]);
        let result = download_at(root.path(), proposed.clone(), |_| {}, &base, &client).unwrap();
        let requests = task.join().unwrap();
        assert_eq!(
            requests[1],
            format!(
                "GET /team/model/resolve/{}/ggml-model.bin HTTP/1.1",
                "a".repeat(40)
            )
        );
        assert!(Path::new(&result.path).ends_with(Path::new("models").join("ggml-model.bin")));
        assert_eq!(fs::read(&result.path).unwrap(), bytes);
        assert!(result.model_id.is_none());
        assert!(Path::new(&result.path)
            .with_file_name("ggml-model.bin.openmeet.json")
            .is_file());

        let root = tempfile::tempdir().unwrap();
        let mut wrong = metadata.clone();
        wrong["siblings"][0]["lfs"]["sha256"] = "0".repeat(64).into();
        let wrong_proposal = parse(wrong.clone()).unwrap().files.remove(0);
        // The Hub now says the wrong checksum, so the re-listed file matches and the body must fail.
        let (base, task) = mock_hub(vec![serde_json::to_vec(&wrong).unwrap(), bytes.to_vec()]);
        assert!(download_at(root.path(), wrong_proposal, |_| {}, &base, &client).is_err());
        task.join().unwrap();
        assert_eq!(fs::read_dir(root.path().join("models")).unwrap().count(), 0);
    }

    #[test]
    fn sherpa_folder_is_published_only_when_every_file_verifies() {
        let _serial = TEST_OPERATIONS.lock().unwrap();
        let metadata = repo_metadata("team/model", &TRANSDUCER);
        let proposed = parse(metadata.clone()).unwrap().folders.remove(0);
        let client = providers::client(Duration::from_secs(2)).unwrap();
        let root = tempfile::tempdir().unwrap();
        // The third file is corrupted; the fourth is never requested and nothing is published.
        let (base, task) = mock_hub(vec![
            serde_json::to_vec(&metadata).unwrap(),
            b"enc!".to_vec(),
            b"dec!".to_vec(),
            b"XXXX".to_vec(),
        ]);
        assert!(download_folder_at(root.path(), proposed.clone(), |_| {}, &base, &client).is_err());
        task.join().unwrap();
        assert_eq!(
            fs::read_dir(root.path().join("sherpa/custom"))
                .unwrap()
                .count(),
            0
        );

        let mut responses = vec![serde_json::to_vec(&metadata).unwrap()];
        responses.extend(TRANSDUCER.iter().map(|(_, bytes)| bytes.to_vec()));
        let (base, task) = mock_hub(responses);
        let result = download_folder_at(root.path(), proposed, |_| {}, &base, &client).unwrap();
        task.join().unwrap();
        let folder = PathBuf::from(&result.path);
        assert!(folder.ends_with(Path::new("sherpa").join("custom").join("team--model")));
        for (name, bytes) in TRANSDUCER {
            assert_eq!(fs::read(folder.join(name)).unwrap(), bytes);
        }
        assert!(folder.join("openmeet-source.json").is_file());
        assert_eq!(result.files, 4);
        assert_eq!(
            fs::read_dir(root.path().join("sherpa/custom"))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn explicit_hub_requests_are_bounded_and_never_send_credentials() {
        let metadata = metadata_for(b"ggmlsynthetic");
        let (base, task) = mock_hub(vec![
            serde_json::to_vec(&vec![metadata.clone()]).unwrap(),
            serde_json::to_vec(&metadata).unwrap(),
        ]);
        let results = search_at(&base, "fixture").unwrap();
        assert_eq!(
            results,
            vec![HubModel {
                id: "team/model".into(),
                license: Some("apache-2.0".into()),
                kind: HubKind::WhisperGgml,
            }]
        );
        let listing = list_files_at(&base, &results[0].id, None).unwrap();
        assert_eq!(listing.files.len(), 1);
        assert_eq!(listing.files[0].revision, "a".repeat(40));
        assert_eq!(
            task.join().unwrap(),
            [
                "GET /api/models?search=fixture&pipeline_tag=automatic-speech-recognition&limit=20&full=true HTTP/1.1",
                "GET /api/models/team/model?blobs=true HTTP/1.1"
            ]
        );
        assert!(list_files_at(&base, "../escape", None).is_err());
    }

    #[test]
    fn hub_download_cancellation_and_checksum_failure_never_publish() {
        let _serial = TEST_OPERATIONS.lock().unwrap();
        let bytes = b"ggmlsynthetic";
        let metadata = metadata_for(bytes);
        let proposed = parse(metadata.clone()).unwrap().files.remove(0);
        let client = providers::client(Duration::from_secs(2)).unwrap();
        for cancel in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let body = if cancel {
                bytes.to_vec()
            } else {
                b"ggmlcorrupted".to_vec()
            };
            let (base, task) = mock_hub(vec![serde_json::to_vec(&metadata).unwrap(), body]);
            let result = download_at(
                root.path(),
                proposed.clone(),
                |_| {
                    if cancel {
                        cancel_download().unwrap();
                    }
                },
                &base,
                &client,
            );
            assert!(result.is_err());
            task.join().unwrap();
            assert!(scan(vec![root.path().into()]).models.is_empty());
            assert_eq!(fs::read_dir(root.path().join("models")).unwrap().count(), 0);
        }
    }

    #[test]
    fn unavailable_hub_and_size_mismatch_never_publish() {
        let _serial = TEST_OPERATIONS.lock().unwrap();
        let bytes = b"ggmlsynthetic";
        let metadata = metadata_for(bytes);
        let proposed = parse(metadata.clone()).unwrap().files.remove(0);
        let client = providers::client(Duration::from_secs(2)).unwrap();
        let root = tempfile::tempdir().unwrap();
        // Bind then drop the listener so the port refuses connections.
        let closed = format!(
            "http://{}",
            TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
        );
        assert!(search_at(&closed, "fixture").is_err());
        assert!(download_at(root.path(), proposed.clone(), |_| {}, &closed, &client).is_err());
        let (base, task) = mock_hub(vec![
            serde_json::to_vec(&metadata).unwrap(),
            b"ggmlsynthetic-longer".to_vec(),
        ]);
        let error = download_at(root.path(), proposed, |_| {}, &base, &client).unwrap_err();
        assert!(error.message.contains("size differs"));
        task.join().unwrap();
        assert!(scan(vec![root.path().into()]).models.is_empty());
        assert!(ArtifactOperation::begin().is_ok());
    }

    #[test]
    fn stalled_body_releases_the_operation_after_cancel_and_read_timeout() {
        let _serial = TEST_OPERATIONS.lock().unwrap();
        let bytes = b"ggmlsynthetic";
        let metadata = metadata_for(bytes);
        let proposed = parse(metadata.clone()).unwrap().files.remove(0);
        let (base, task) = mock_hub_responses(vec![
            (serde_json::to_vec(&metadata).unwrap(), false),
            (bytes.to_vec(), true),
        ]);
        let root = tempfile::tempdir().unwrap();
        let client = providers::client(Duration::from_millis(30)).unwrap();
        let result = download_at(
            root.path(),
            proposed,
            |_| {
                cancel_download().unwrap();
            },
            &base,
            &client,
        );
        assert_eq!(result.unwrap_err().code, "model_cancelled");
        task.join().unwrap();
        assert!(scan(vec![root.path().into()]).models.is_empty());
        assert!(
            ArtifactOperation::begin().is_ok(),
            "The cancelled owner must release the shared artifact lock"
        );
    }
}
