//! Provider configuration validation, frozen credentials and bounded HTTP requests.
use crate::domain::{AppError, KeyStatus, ProviderConfig, Result};
use reqwest::{blocking::Client, redirect::Policy, StatusCode, Url};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, io::Read, time::Duration};

const KEYCHAIN_SERVICE: &str = "dev.openmeet.preview";
const MAX_KEY_LEN: usize = 4096;
const MAX_MODELS_BYTES: u64 = 4 * 1024 * 1024;
const MAX_MODELS: usize = 2000;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProviderModel {
    pub id: String,
}

// Credentials cannot be formatted or serialized, including in command failures.
pub struct Connection {
    base_url: String,
    model: Option<String>,
    key: String,
}

impl Connection {
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn model(&self) -> Result<&str> {
        self.model.as_deref().ok_or_else(|| {
            AppError::new(
                "provider_model_missing",
                "Choose and save a model in Settings first.",
            )
        })
    }

    pub(crate) fn key(&self) -> &str {
        &self.key
    }

    pub(crate) fn endpoint(&self, path: &str) -> Result<Url> {
        Url::parse(&format!("{}/{path}", self.base_url)).map_err(|_| invalid_url())
    }

    #[cfg(test)]
    pub(crate) fn for_test(base: &str, model: &str) -> Self {
        Self {
            base_url: validate_base_url(base).unwrap(),
            model: Some(model.into()),
            key: "synthetic-test-key".into(),
        }
    }
}

fn invalid_url() -> AppError {
    AppError::new(
        "provider_url",
        "Enter an HTTPS API base URL, or HTTP on localhost, without credentials, query parameters or a fragment.",
    )
}

pub fn validate_base_url(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 2048 || value.chars().any(char::is_whitespace) {
        return Err(invalid_url());
    }
    let url = Url::parse(value).map_err(|_| invalid_url())?;
    if (url.scheme() != "https" && !(url.scheme() == "http" && is_local_base(value)))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid_url());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

pub fn is_local_base(value: &str) -> bool {
    Url::parse(value).ok().is_some_and(|url| {
        url.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        })
    })
}

pub(crate) fn authorize(
    request: reqwest::blocking::RequestBuilder,
    key: &str,
) -> reqwest::blocking::RequestBuilder {
    if key.is_empty() {
        request
    } else {
        request.bearer_auth(key)
    }
}

pub fn validate_model(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 256
        || value.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(AppError::new(
            "provider_model",
            "Enter a nonempty model ID of at most 256 bytes without whitespace.",
        ));
    }
    Ok(())
}

fn valid_key(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_KEY_LEN && value.bytes().all(|b| b.is_ascii_graphic())
}

fn keychain_error(_: keyring::Error) -> AppError {
    AppError::new(
        "keychain_unavailable",
        "The OS credential store could not be used. Check Settings and try again.",
    )
}

fn entry(account: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(keychain_error)
}

pub fn key_status(account: Option<&str>) -> KeyStatus {
    let Some(account) = account else {
        return KeyStatus::Missing;
    };
    match entry(account).and_then(|entry| match entry.get_password() {
        Ok(_) => Ok(KeyStatus::Present),
        Err(keyring::Error::NoEntry) => Ok(KeyStatus::Missing),
        Err(error) => Err(keychain_error(error)),
    }) {
        Ok(status) => status,
        Err(_) => KeyStatus::Unavailable,
    }
}

pub fn store_key(key: &str) -> Result<String> {
    let key = key.trim();
    if !valid_key(key) {
        return Err(AppError::new(
            "provider_key",
            "Enter a valid API key without whitespace, at most 4096 bytes.",
        ));
    }
    let account = format!("connection-{}", uuid::Uuid::new_v4());
    entry(&account)?.set_password(key).map_err(keychain_error)?;
    Ok(account)
}

pub fn delete_key(account: &str) -> Result<()> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(keychain_error(error)),
    }
}

pub fn load_connection(config: &ProviderConfig) -> Result<Connection> {
    let base_url = validate_base_url(&config.base_url)?;
    if let Some(model) = config.model.as_deref() {
        validate_model(model)?;
    }
    if config.credential_account.is_none() && is_local_base(&base_url) {
        return Ok(Connection {
            base_url,
            model: config.model.clone(),
            key: String::new(),
        });
    }
    let account = config
        .credential_account
        .as_deref()
        .ok_or_else(missing_key)?;
    let key = match entry(account)?.get_password() {
        Ok(key) if valid_key(&key) => key,
        Ok(_) | Err(keyring::Error::NoEntry) => return Err(missing_key()),
        Err(error) => return Err(keychain_error(error)),
    };
    Ok(Connection {
        base_url,
        model: config.model.clone(),
        key,
    })
}

fn missing_key() -> AppError {
    AppError::new(
        "provider_key_missing",
        "No usable API key is saved for this provider. Add one in Settings.",
    )
}

pub(crate) fn client(timeout: Duration) -> reqwest::Result<Client> {
    Client::builder()
        .redirect(Policy::none())
        .connect_timeout(timeout.min(Duration::from_secs(5)))
        .timeout(timeout)
        .build()
}

pub(crate) fn read_capped(response: reqwest::blocking::Response, max: u64) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    response.take(max + 1).read_to_end(&mut body).ok()?;
    (body.len() as u64 <= max).then_some(body)
}

pub(crate) fn check_status(status: StatusCode) -> Result<()> {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(AppError::new("provider_unauthorized", "The provider rejected the API key. Check the saved key and its permissions.")),
        StatusCode::TOO_MANY_REQUESTS => Err(AppError::new("provider_rate_limited", "The provider is rate limiting requests. Wait and retry explicitly.")),
        status if !status.is_success() => Err(AppError::new("provider_response", format!("The provider returned HTTP {status}. Check endpoint and model compatibility; nothing was saved."))),
        _ => Ok(()),
    }
}

#[derive(Deserialize)]
struct Catalog {
    data: Vec<ModelItem>,
    #[serde(default)]
    has_more: bool,
}
#[derive(Deserialize)]
struct ModelItem {
    id: String,
}

pub fn list_models(connection: &Connection) -> Result<Vec<ProviderModel>> {
    let url = connection.endpoint("models")?;
    fetch_models(url.as_str(), connection.key(), Duration::from_secs(15))
}

fn fetch_models(url: &str, key: &str, timeout: Duration) -> Result<Vec<ProviderModel>> {
    let unreachable = || {
        AppError::new(
            "provider_unreachable",
            "Cannot reach the provider. Check the API base URL and your connection.",
        )
    };
    let invalid = || {
        AppError::new("provider_models", "The provider returned an unsupported model list. Enter a model ID manually if discovery is unavailable.")
    };
    let response = authorize(client(timeout).map_err(|_| unreachable())?.get(url), key)
        .send()
        .map_err(|_| unreachable())?;
    check_status(response.status())?;
    let bytes = read_capped(response, MAX_MODELS_BYTES).ok_or_else(invalid)?;
    let catalog: Catalog = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if catalog.has_more || catalog.data.len() > MAX_MODELS {
        return Err(invalid());
    }
    let ids: BTreeSet<String> = catalog
        .data
        .into_iter()
        .map(|item| item.id)
        .filter(|id| validate_model(id).is_ok())
        .collect();
    Ok(ids.into_iter().map(|id| ProviderModel { id }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "uses native credential storage with a new synthetic entry only"]
    fn windows_keychain_round_trip_uses_only_new_synthetic_credentials() {
        let account = store_key("openmeet-synthetic-key-one").unwrap();
        let result = std::panic::catch_unwind(|| {
            assert_eq!(key_status(Some(&account)), KeyStatus::Present);
            let config = ProviderConfig {
                base_url: "https://provider.example/v1".into(),
                model: Some("synthetic-model".into()),
                revision: 1,
                credential_account: Some(account.clone()),
            };
            assert!(load_connection(&config).unwrap().key() == "openmeet-synthetic-key-one");
            entry(&account)
                .unwrap()
                .set_password("openmeet-synthetic-key-two")
                .unwrap();
            assert!(load_connection(&config).unwrap().key() == "openmeet-synthetic-key-two");
        });
        // Only this test-created account is removed, including after an assertion failure.
        delete_key(&account).unwrap();
        result.unwrap();
        assert_eq!(key_status(Some(&account)), KeyStatus::Missing);
    }

    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        thread,
    };

    fn serve(body: &str, status: &str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/custom/v1", listener.local_addr().unwrap());
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(&stream);
            let mut head = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                head.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }
            let _ = stream.write_all(response.as_bytes());
            head
        });
        (url, worker)
    }

    #[test]
    fn model_discovery_preserves_base_path_and_uses_generic_ids() {
        let (url, worker) = serve(
            r#"{"data":[{"id":"z/model"},{"id":"a"},{"id":"a"},{"id":"bad id"}]}"#,
            "200 OK",
        );
        let models = list_models(&Connection::for_test(&url, "manual-model")).unwrap();
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["a", "z/model"]
        );
        let request = worker.join().unwrap().to_ascii_lowercase();
        assert!(request.starts_with("get /custom/v1/models http/1.1"));
        assert!(request.contains("authorization: bearer synthetic-test-key"));
        validate_model("unlisted/custom-model").unwrap();
    }

    #[test]
    fn invalid_discovery_and_provider_errors_do_not_expose_credentials() {
        for (body, status, expected) in [
            ("garbage", "200 OK", "provider_models"),
            (
                r#"{"data":[{"model":"merge-only-shape"}]}"#,
                "200 OK",
                "provider_models",
            ),
            (
                r#"{"data":[],"has_more":true}"#,
                "200 OK",
                "provider_models",
            ),
            (
                "raw secret body",
                "401 Unauthorized",
                "provider_unauthorized",
            ),
            ("", "429 Too Many Requests", "provider_rate_limited"),
        ] {
            let (url, worker) = serve(body, status);
            let error = list_models(&Connection::for_test(&url, "m")).unwrap_err();
            worker.join().unwrap();
            assert_eq!(error.code, expected);
            assert!(
                !error.message.contains("synthetic-test-key")
                    && !error.message.contains("raw secret")
            );
        }
        let (url, worker) = serve(&"x".repeat(MAX_MODELS_BYTES as usize + 1), "200 OK");
        assert_eq!(
            list_models(&Connection::for_test(&url, "m"))
                .unwrap_err()
                .code,
            "provider_models"
        );
        worker.join().unwrap();
    }

    #[test]
    fn redirects_never_receive_credentials() {
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let source = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", source.local_addr().unwrap());
        let location = destination.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let (mut stream, _) = source.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(&stream);
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
            }
            write!(stream, "HTTP/1.1 302 Found\r\nLocation: http://{location}/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        assert_eq!(
            list_models(&Connection::for_test(&url, "m"))
                .unwrap_err()
                .code,
            "provider_response"
        );
        worker.join().unwrap();
        assert_eq!(
            destination.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn validation_sanitizes_urls_keys_and_models() {
        assert_eq!(
            validate_base_url("https://provider.example/custom/v1/").unwrap(),
            "https://provider.example/custom/v1"
        );
        for url in [
            "http://provider.example/v1",
            "https://user:secret@provider.example/v1",
            "https://provider.example/v1?key=secret",
            "https://provider.example/#secret",
            "file:///secret",
            "https://provider.example/line\nbreak",
        ] {
            let error = validate_base_url(url).unwrap_err();
            assert_eq!(error.code, "provider_url");
            assert!(!error.message.contains("secret"));
        }
        for model in ["", "with space", "line\nbreak", &"x".repeat(257)] {
            assert!(validate_model(model).is_err());
        }
        for key in ["", "has space", "line\nbreak", &"x".repeat(MAX_KEY_LEN + 1)] {
            assert!(!valid_key(key));
        }
        assert!(valid_key("sk-synthetic"));
    }

    #[test]
    fn local_servers_allow_http_and_no_key_without_weakening_remote_validation() {
        for base in [
            "http://localhost:1234/v1",
            "http://127.0.0.1:8080/v1",
            "http://[::1]:11434/v1",
        ] {
            let config = ProviderConfig {
                base_url: base.into(),
                model: Some("local-model".into()),
                revision: 1,
                credential_account: None,
            };
            assert!(is_local_base(base));
            assert!(load_connection(&config).unwrap().key().is_empty());
        }
        for base in [
            "http://192.168.1.2/v1",
            "http://localhost.example/v1",
            "http://127.0.0.1.example/v1",
            "http://0.0.0.0/v1",
        ] {
            assert!(validate_base_url(base).is_err());
        }
        let config = ProviderConfig {
            base_url: "https://provider.example/v1".into(),
            model: None,
            revision: 1,
            credential_account: None,
        };
        assert_eq!(
            load_connection(&config).err().unwrap().code,
            "provider_key_missing"
        );
        let (url, worker) = serve(r#"{"data":[{"id":"local-model"}]}"#, "200 OK");
        let config = ProviderConfig {
            base_url: url,
            ..config
        };
        let connection = load_connection(&config).unwrap();
        assert_eq!(list_models(&connection).unwrap()[0].id, "local-model");
        assert!(!worker
            .join()
            .unwrap()
            .to_ascii_lowercase()
            .contains("authorization:"));
    }
}
