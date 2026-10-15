//! Explicit model discovery and verified file acquisition. Files never start inference servers.
use crate::{
    domain::{AppError, Result},
    providers, stt,
};
use reqwest::{blocking::Client, redirect::Policy, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, VecDeque},
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
const HUB: &str = "https://huggingface.co";
pub(crate) const TRANSFER_TIMEOUT: Duration = Duration::from_secs(15);
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
                let Ok(kind) = child.file_type() else {
                    continue;
                };
                if kind.is_dir() {
                    if depth < max_depth {
                        pending.push_back((path, depth + 1));
                    } else {
                        result.truncated = true;
                        status = "Depth limit reached";
                    }
                    continue;
                }
                // Hugging Face snapshots link to blobs. Follow files only inside the approved root.
                let Ok(resolved) = fs::canonicalize(&path) else {
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
        return Err(error("This file does not match a supported Whisper model size. GGUF models need an external server."));
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

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
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

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HubModel {
    pub id: String,
    pub license: Option<String>,
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
        .append_pair("limit", "20")
        .append_pair("full", "true");
    let results: Vec<HubMetadata> = fetch_json(url)?;
    if results.len() > 20 {
        return Err(error("Model search returned too many results."));
    }
    Ok(results
        .into_iter()
        .filter(|item| {
            valid_repo(&item.id) && !item.private && (item.gated.is_null() || item.gated == false)
        })
        .map(|item| HubModel {
            id: item.id,
            license: license_name(item.card),
        })
        .collect())
}

pub fn list_files(repo: &str) -> Result<Vec<HubFile>> {
    list_files_at(HUB, repo, None)
}

fn list_files_at(base: &str, repo: &str, revision: Option<&str>) -> Result<Vec<HubFile>> {
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

fn parse_files(metadata: HubMetadata, repo: &str, requested: Option<&str>) -> Result<Vec<HubFile>> {
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
    let mut files = Vec::new();
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
        let name = sibling.rfilename.rsplit('/').next().unwrap_or("");
        let catalog = stt::model_files().find(|file| {
            repo == "ggerganov/whisper.cpp"
                && sibling.rfilename == file.file
                && lfs.size == file.size
                && lfs.sha256 == file.sha256
        });
        let complete_gguf =
            name.ends_with(".gguf") && !name.contains("-of-") && !name.contains(".part");
        if catalog.is_none() && !complete_gguf {
            continue;
        }
        files.push(HubFile {
            repo_id: repo.into(),
            revision: revision.clone(),
            filename: sibling.rfilename,
            size: lfs.size,
            sha256: lfs.sha256,
            license: license.clone(),
            model_id: catalog.map(|file| file.id.into()),
        });
    }
    if files.len() > 200 {
        return Err(error(
            "This repository has too many supported files. Use a smaller repository.",
        ));
    }
    Ok(files)
}

fn download_client() -> Result<Client> {
    Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(TRANSFER_TIMEOUT)
        .redirect(Policy::custom(|attempt| {
            let url = attempt.url();
            let allowed = url.scheme() == "https"
                && url.port_or_known_default() == Some(443)
                && url.username().is_empty()
                && url.password().is_none()
                && url.host_str().is_some_and(|host| {
                    host == "huggingface.co"
                        || host.ends_with(".huggingface.co")
                        || host.ends_with(".hf.co")
                });
            if allowed && attempt.previous().len() < 5 {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|_| error("Cannot prepare the model download."))
}

pub fn download(
    root: &Path,
    proposed: HubFile,
    mut progress: impl FnMut(Progress),
) -> Result<DownloadedModel> {
    download_at(root, proposed, &mut progress, HUB, &download_client()?)
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
        .into_iter()
        .find(|file| file == &proposed)
        .ok_or_else(|| error("Model metadata changed. Refresh and confirm the download again."))?;
    check_cancel()?;
    let folder = if approved.model_id.is_some() {
        managed_folder(root, &["models"])?
    } else {
        managed_folder(root, &["library", &approved.sha256])?
    };
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
        serde_json::json!({"id":"team/model","sha":"a".repeat(40),"gated":false,"private":false,"cardData":{"license":"apache-2.0"},"siblings":[{"rfilename":"model.gguf","size":bytes.len(),"lfs":{"size":bytes.len(),"sha256":hex(&Sha256::digest(bytes))}}]})
    }

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
    fn metadata_pins_only_complete_public_files_and_rejects_path_traversal() {
        let raw = serde_json::json!({"id":"team/model", "sha":"a".repeat(40), "private":false, "gated":false, "cardData":{"license":"apache-2.0"}, "siblings":[
            {"rfilename":"model.gguf","size":10,"lfs":{"size":10,"sha256":"b".repeat(64)}},
            {"rfilename":"model-00001-of-00002.gguf","size":10,"lfs":{"size":10,"sha256":"b".repeat(64)}},
            {"rfilename":"../escape.gguf","size":10,"lfs":{"size":10,"sha256":"b".repeat(64)}},
            {"rfilename":"unhashed.gguf","size":10}
        ]});
        let files = parse_files(
            serde_json::from_value(raw.clone()).unwrap(),
            "team/model",
            None,
        )
        .unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].filename, "model.gguf");
        assert_eq!(files[0].license.as_deref(), Some("apache-2.0"));
        assert!(files[0].model_id.is_none());
        let mut private = raw.clone();
        private["gated"] = serde_json::json!("auto");
        assert!(parse_files(serde_json::from_value(private).unwrap(), "team/model", None).is_err());
        assert!(parse_files(
            serde_json::from_value(raw).unwrap(),
            "team/model",
            Some(&"c".repeat(40))
        )
        .is_err());
        for name in [
            "../model.gguf",
            "folder/../model.gguf",
            "C:\\model.gguf",
            "/root.gguf",
            "file.gguf.",
        ] {
            assert!(!valid_filename(name));
        }
        for repo in ["../escape", "bad", "a/b/c", "a/.hidden"] {
            assert!(!valid_repo(repo));
        }
    }

    #[test]
    fn verified_copy_cancellation_checksum_and_collisions_preserve_originals() {
        let _serial = TEST_OPERATIONS.lock().unwrap();
        let _operation = ArtifactOperation::begin().unwrap();
        let tree = tempfile::tempdir().unwrap();
        let path = tree.path().join("model.gguf");
        let bytes = b"GGUFsynthetic";
        let hash = hex(&Sha256::digest(bytes));
        copy_verified(&mut &bytes[..], &path, bytes.len() as u64, &hash, |_| {}).unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert!(copy_verified(&mut &bytes[..], &path, bytes.len() as u64, &hash, |_| {}).is_err());
        let bad = tree.path().join("bad.gguf");
        assert!(copy_verified(
            &mut &bytes[..],
            &bad,
            bytes.len() as u64,
            &"0".repeat(64),
            |_| {}
        )
        .is_err());
        assert!(!bad.exists());
        let cancelled = tree.path().join("cancel.gguf");
        assert_eq!(
            copy_verified(
                &mut &bytes[..],
                &cancelled,
                bytes.len() as u64,
                &hash,
                |_| {
                    cancel_download().unwrap();
                }
            )
            .unwrap_err()
            .code,
            "model_cancelled"
        );
        assert!(!cancelled.exists());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(fs::read_dir(tree.path()).unwrap().count(), 1);
    }

    #[test]
    fn imports_a_verified_copy_preserving_source_and_existing_destination() {
        let _serial = TEST_OPERATIONS.lock().unwrap();
        let source = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let path = source.path().join("fixture.bin");
        let bytes = b"synthetic-whisper";
        fs::write(&path, bytes).unwrap();
        let catalog = [stt::ModelFile {
            id: "tiny",
            file: "ggml-tiny.bin",
            size: bytes.len() as u64,
            sha256: "e86db380c435333cc4dbda278b99f6b306e949043da88469228700eebbc99829",
        }];
        assert_eq!(
            import_with_catalog(root.path(), &path, &catalog)
                .unwrap()
                .model_id,
            "tiny"
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let destination = root.path().join("models/ggml-tiny.bin");
        assert_eq!(fs::read(&destination).unwrap(), bytes);
        assert!(import_with_catalog(root.path(), &path, &catalog).is_err());
        fs::write(&path, b"corrupted-whisper").unwrap();
        assert!(import_with_catalog(root.path(), &path, &catalog).is_err());
        assert_eq!(fs::read(&destination).unwrap(), bytes);
        assert_eq!(fs::read_dir(root.path().join("models")).unwrap().count(), 1);
    }

    #[test]
    fn explicit_hub_requests_are_bounded_and_never_send_credentials() {
        let metadata = metadata_for(b"GGUFsynthetic");
        let (base, task) = mock_hub(vec![
            serde_json::to_vec(&vec![metadata.clone()]).unwrap(),
            serde_json::to_vec(&metadata).unwrap(),
        ]);
        let results = search_at(&base, "fixture").unwrap();
        assert_eq!(
            results,
            vec![HubModel {
                id: "team/model".into(),
                license: Some("apache-2.0".into())
            }]
        );
        let files = list_files_at(&base, &results[0].id, None).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].revision, "a".repeat(40));
        assert_eq!(
            task.join().unwrap(),
            [
                "GET /api/models?search=fixture&limit=20&full=true HTTP/1.1",
                "GET /api/models/team/model?blobs=true HTTP/1.1"
            ]
        );
        assert!(search_at(&base, "").is_err());
        assert!(list_files_at(&base, "../escape", None).is_err());
    }

    #[test]
    fn hub_download_pins_metadata_persists_provenance_and_rejects_changed_consent() {
        let _serial = TEST_OPERATIONS.lock().unwrap();
        let bytes = b"GGUFsynthetic";
        let metadata = metadata_for(bytes);
        let proposed = parse_files(
            serde_json::from_value(metadata.clone()).unwrap(),
            "team/model",
            None,
        )
        .unwrap()
        .remove(0);
        let root = tempfile::tempdir().unwrap();
        let (base, task) = mock_hub(vec![serde_json::to_vec(&metadata).unwrap(), bytes.to_vec()]);
        let client = providers::client(Duration::from_secs(2)).unwrap();
        let result = download_at(root.path(), proposed.clone(), |_| {}, &base, &client).unwrap();
        let requests = task.join().unwrap();
        assert_eq!(
            requests[0],
            format!(
                "GET /api/models/team/model/revision/{}?blobs=true HTTP/1.1",
                "a".repeat(40)
            )
        );
        assert_eq!(
            requests[1],
            format!(
                "GET /team/model/resolve/{}/model.gguf HTTP/1.1",
                "a".repeat(40)
            )
        );
        assert_eq!(fs::read(&result.path).unwrap(), bytes);
        assert!(result.model_id.is_none());
        let manifest: HubFile = serde_json::from_slice(
            &fs::read(Path::new(&result.path).with_file_name("model.gguf.openmeet.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest, proposed);
        let (base, task) = mock_hub(vec![serde_json::to_vec(&metadata).unwrap()]);
        let mut changed = proposed.clone();
        changed.license = Some("different".into());
        assert!(download_at(root.path(), changed, |_| {}, &base, &client).is_err());
        assert_eq!(task.join().unwrap().len(), 1);
        assert_eq!(fs::read(&result.path).unwrap(), bytes);
    }

    #[test]
    fn hub_download_cancellation_and_checksum_failure_never_publish() {
        let _serial = TEST_OPERATIONS.lock().unwrap();
        let bytes = b"GGUFsynthetic";
        let metadata = metadata_for(bytes);
        let proposed = parse_files(
            serde_json::from_value(metadata.clone()).unwrap(),
            "team/model",
            None,
        )
        .unwrap()
        .remove(0);
        let client = providers::client(Duration::from_secs(2)).unwrap();
        for cancel in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let body = if cancel {
                bytes.to_vec()
            } else {
                b"GGUFcorrupted".to_vec()
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
            let folder = root.path().join("library").join(&proposed.sha256);
            assert_eq!(fs::read_dir(folder).unwrap().count(), 0);
        }
    }

    #[test]
    fn stalled_body_releases_the_operation_after_cancel_and_read_timeout() {
        let _serial = TEST_OPERATIONS.lock().unwrap();
        let bytes = b"GGUFsynthetic";
        let metadata = metadata_for(bytes);
        let proposed = parse_files(
            serde_json::from_value(metadata.clone()).unwrap(),
            "team/model",
            None,
        )
        .unwrap()
        .remove(0);
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
