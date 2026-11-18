//! Blocking retrieval of an embedding model's pinned files. Each file is
//! fetched from its pinned commit into `snapshots/<commit>/<file>.part`,
//! hashed while it is written, and renamed into place once its sha256 and
//! size match the model table; `refs/main` then names the commit.

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use chan_tls::rustls::{self, ClientConfig};
use fs4::fs_std::FileExt;
use indicatif::{ProgressBar, ProgressStyle};
use sha2::{Digest, Sha256};
use thiserror::Error;
use ureq::{Agent, RedirectAuthHeaders, Response};
use url::Url;

use super::super::config::{self, EmbeddingModelInfo, ModelFile};
use super::{proxy_env_issue, repo_dir_name, EmbedError};

const ENDPOINT: &str = "https://huggingface.co";
/// The updater's connect bound. In place of its bound on the whole transfer,
/// a bound on each read: the weights run past a gigabyte, so a stalled
/// server ends a download and a slow one does not.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// The updater's user agent.
const USER_AGENT: &str = concat!("chan/", env!("CARGO_PKG_VERSION"));

#[cfg(test)]
type PublicationObserver = dyn Fn(&Path) + Send + Sync;

pub(super) struct Client {
    cache: PathBuf,
    endpoint: Url,
    token: Option<String>,
    progress: bool,
    models: &'static [EmbeddingModelInfo],
    read_timeout: Duration,
    proxy_from_env: bool,
    agent: OnceLock<Agent>,
    supplied_config: Option<ClientConfig>,
    // Tests remove a file the embedder has resolved before it is loaded.
    #[cfg(test)]
    publication_observer: Option<Box<PublicationObserver>>,
}

#[derive(Debug, Error)]
enum DownloadError {
    #[error("request error: {0}")]
    Request(#[from] Box<ureq::Error>),
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("the server's reply does not continue the partial download")]
    InvalidResume,
    #[error("{model} has no pinned {file}")]
    Unpinned { model: String, file: String },
    #[error("{file} does not match its pinned sha256 {expected}: got {actual}")]
    Digest {
        file: &'static str,
        expected: &'static str,
        actual: String,
    },
    #[error("model URL: {0}")]
    Url(#[from] url::ParseError),
    #[error("TLS configuration: {0}")]
    Tls(#[from] chan_tls::Error),
}

impl DownloadError {
    fn into_embed(self) -> EmbedError {
        // An unusable proxy variable explains a failed request, and nothing
        // that failed before or without one.
        if let DownloadError::Request(_) = self {
            if let Some((var, value)) = proxy_env_issue() {
                return EmbedError::ProxyConfig { var, value };
            }
        }
        let certificate = certificate_failure(&self);
        let message = self.to_string();
        if certificate {
            EmbedError::Certificate(message)
        } else {
            EmbedError::Download(message)
        }
    }
}

fn certificate_failure(mut error: &(dyn std::error::Error + 'static)) -> bool {
    loop {
        if matches!(
            error.downcast_ref::<rustls::Error>(),
            Some(rustls::Error::InvalidCertificate(_))
        ) {
            return true;
        }
        // io::Error's source can skip the inner error itself, so inspect it
        // before following the rest of the transport's source chain.
        if let Some(inner) = error
            .downcast_ref::<io::Error>()
            .and_then(io::Error::get_ref)
        {
            error = inner;
        } else if let Some(source) = error.source() {
            error = source;
        } else {
            return false;
        }
    }
}

impl Client {
    pub(super) fn new(cache: &Path) -> Result<Self, EmbedError> {
        let token = dirs::home_dir()
            .and_then(|home| std::fs::read_to_string(home.join(".cache/huggingface/token")).ok())
            .map(|token| token.trim().to_owned())
            .filter(|token| !token.is_empty());
        Ok(Self {
            cache: cache.to_owned(),
            endpoint: Url::parse(ENDPOINT).expect("the fixed Hub endpoint is a URL"),
            token,
            progress: true,
            models: config::embedding_models(),
            read_timeout: READ_TIMEOUT,
            proxy_from_env: true,
            agent: OnceLock::new(),
            supplied_config: None,
            #[cfg(test)]
            publication_observer: None,
        })
    }

    /// A client of `endpoint` on `config` that goes direct whatever proxy the
    /// environment names, so a developer's or CI's proxy cannot reach the
    /// loopback servers tests download from.
    #[cfg(test)]
    fn with_config(cache: &Path, endpoint: &str, config: ClientConfig) -> Self {
        Self {
            cache: cache.to_owned(),
            endpoint: Url::parse(endpoint).expect("the test endpoint is a URL"),
            token: None,
            progress: false,
            models: config::embedding_models(),
            read_timeout: READ_TIMEOUT,
            proxy_from_env: false,
            agent: OnceLock::new(),
            supplied_config: Some(config),
            publication_observer: None,
        }
    }

    /// This client with `models` in place of chan's model table.
    #[cfg(test)]
    fn pinned(mut self, models: &'static [EmbeddingModelInfo]) -> Self {
        self.models = models;
        self
    }

    fn agent(&self) -> Result<&Agent, DownloadError> {
        if let Some(agent) = self.agent.get() {
            return Ok(agent);
        }
        let config = match &self.supplied_config {
            Some(config) => config.clone(),
            None => chan_tls::client_config()?,
        };
        let agent = ureq::AgentBuilder::new()
            .tls_config(Arc::new(config))
            .https_only(self.endpoint.scheme() == "https")
            .timeout_connect(CONNECT_TIMEOUT)
            .timeout_read(self.read_timeout)
            .try_proxy_from_env(self.proxy_from_env)
            .user_agent(USER_AGENT)
            .redirect_auth_headers(RedirectAuthHeaders::SameHost)
            .build();
        Ok(self.agent.get_or_init(|| agent))
    }

    pub(super) fn get(&self, model: &str, filename: &str) -> Result<PathBuf, EmbedError> {
        self.get_inner(model, filename)
            .map_err(DownloadError::into_embed)
    }

    fn get_inner(&self, model: &str, filename: &str) -> Result<PathBuf, DownloadError> {
        let (info, file) = self.pin(model, filename)?;
        let repo = self.cache.join(repo_dir_name(model));
        if let Some(path) = cached(&repo, info, filename) {
            return Ok(path);
        }
        let snapshot = repo.join("snapshots").join(info.revision);
        std::fs::create_dir_all(&snapshot)?;
        let path = snapshot.join(file.name);
        let _lock = lock(&snapshot.join(format!("{}.lock", file.name)))?;
        // The other downloader may have completed while we waited.
        if !path.is_file() {
            let url = self
                .endpoint
                .join(&format!("{model}/resolve/{}/{}", info.revision, file.name))?;
            self.download(&url, file, &path)?;
        }
        publish_ref(&repo, info.revision)?;
        #[cfg(test)]
        if let Some(observer) = &self.publication_observer {
            observer(&path);
        }
        Ok(path)
    }

    /// Refuse a model whose table entry pins no copy of a file the embedder
    /// reads, before any of its files is asked for. A model the table does
    /// not hold is refused by `get`.
    pub(super) fn require_published(&self, model: &str) -> Result<(), EmbedError> {
        let Some(info) = self.models.iter().find(|info| info.id == model) else {
            return Ok(());
        };
        match config::MODEL_FILES
            .into_iter()
            .find(|name| !info.files.iter().any(|file| file.name == *name))
        {
            Some(file) => Err(EmbedError::Unpublished {
                model: model.to_owned(),
                file,
            }),
            None => Ok(()),
        }
    }

    /// Whether every file of `model` the cache holds, where `get` would read
    /// it, has its pinned sha256 and size. A missing file does not.
    pub(super) fn files_match_their_pins(&self, model: &str) -> Result<bool, EmbedError> {
        let Some(info) = self.models.iter().find(|info| info.id == model) else {
            return Ok(false);
        };
        let repo = self.cache.join(repo_dir_name(model));
        for file in info.files {
            match cached(&repo, info, file.name) {
                Some(path) if matches_pin(&path, file)? => {}
                _ => return Ok(false),
            }
        }
        Ok(true)
    }

    fn pin(
        &self,
        model: &str,
        filename: &str,
    ) -> Result<(&'static EmbeddingModelInfo, &'static ModelFile), DownloadError> {
        self.models
            .iter()
            .find(|info| info.id == model)
            .and_then(|info| {
                let file = info.files.iter().find(|file| file.name == filename)?;
                Some((info, file))
            })
            .ok_or_else(|| DownloadError::Unpinned {
                model: model.to_owned(),
                file: filename.to_owned(),
            })
    }

    fn request(&self, url: &Url) -> Result<ureq::Request, DownloadError> {
        let mut request = self.agent()?.get(url.as_str());
        if let Some(token) = &self.token {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
        Ok(request)
    }

    fn download(&self, url: &Url, file: &ModelFile, path: &Path) -> Result<(), DownloadError> {
        let part_path = path.with_file_name(format!("{}.part", file.name));
        let mut part = open_part(&part_path)?;
        let mut start = part.metadata()?.len();
        if start > file.size {
            part.set_len(0)?;
            part.rewind()?;
            start = 0;
        }
        let progress = self
            .progress
            .then(|| progress_bar(file.size, start, file.name));
        let mut fresh = start == 0;
        loop {
            let actual = self.transfer(url, file, &mut part, start, progress.as_ref())?;
            if actual == file.sha256 {
                break;
            }
            // Bytes of the right length that hash wrong cannot be resumed.
            part.set_len(0)?;
            part.rewind()?;
            if fresh {
                return Err(DownloadError::Digest {
                    file: file.name,
                    expected: file.sha256,
                    actual,
                });
            }
            // The kept prefix may be what was wrong: fetch the whole file
            // once more before failing.
            fresh = true;
            start = 0;
            if let Some(progress) = &progress {
                progress.set_position(0);
            }
        }
        part.sync_all()?;
        drop(part);
        std::fs::rename(&part_path, path)?;
        if let Some(progress) = progress {
            progress.finish();
        }
        Ok(())
    }

    /// Fill `part` from its first `start` bytes to `file`'s pinned size, and
    /// return the sha256 of all of it.
    fn transfer(
        &self,
        url: &Url,
        file: &ModelFile,
        part: &mut File,
        mut start: u64,
        progress: Option<&ProgressBar>,
    ) -> Result<String, DownloadError> {
        let size = file.size;
        let mut hasher = Sha256::new();
        hash_prefix(part, start, &mut hasher)?;
        if start != size {
            let response = self
                .request(url)?
                .set("Range", &format!("bytes={start}-"))
                .call()
                .map_err(Box::new)?;
            // A proxy may ignore Range and send the whole file, as a 200 or
            // as a 206 of every byte. Validate it before replacing the
            // prefix, while retaining the lock.
            let whole = start != 0
                && (response.status() == 200
                    || response.header("Content-Range")
                        == Some(format!("bytes 0-{}/{size}", size - 1).as_str()));
            if let Err(error) = validate_resume(&response, if whole { 0 } else { start }, size) {
                // A reply at another range cannot continue the part, and the
                // same request would meet it again: the next attempt starts
                // clean.
                part.set_len(0)?;
                return Err(error);
            }
            if whole {
                part.set_len(0)?;
                part.rewind()?;
                start = 0;
                hasher = Sha256::new();
                if let Some(progress) = progress {
                    progress.set_position(0);
                }
            }
            let mut reader = response.into_reader();
            let mut remaining = size - start;
            let mut buffer = [0; 64 * 1024];
            loop {
                let read = reader.read(&mut buffer)?;
                if read == 0 {
                    if remaining != 0 {
                        return Err(io::Error::new(
                            io::ErrorKind::UnexpectedEof,
                            "model download ended before its advertised size",
                        )
                        .into());
                    }
                    break;
                }
                if read as u64 > remaining {
                    part.set_len(start)?;
                    return Err(DownloadError::InvalidResume);
                }
                part.write_all(&buffer[..read])?;
                hasher.update(&buffer[..read]);
                remaining -= read as u64;
                if let Some(progress) = progress {
                    progress.inc(read as u64);
                }
            }
        }
        Ok(format!("{:x}", hasher.finalize()))
    }
}

fn open_part(path: &Path) -> io::Result<File> {
    // Windows append-only handles cannot truncate a corrupt or ignored-range
    // partial. The file lock serializes these seekable writes.
    let mut file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(path)?;
    file.seek(SeekFrom::End(0))?;
    Ok(file)
}

/// Feed the part's first `len` bytes to `hasher`, leaving its cursor at `len`.
fn hash_prefix(part: &mut File, len: u64, hasher: &mut Sha256) -> io::Result<()> {
    part.rewind()?;
    if hash_into(&mut (&mut *part).take(len), hasher)? != len {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "the partial download shrank while it was hashed",
        ));
    }
    Ok(())
}

/// Feed everything `reader` yields to `hasher`; the byte count.
fn hash_into(reader: &mut impl Read, hasher: &mut Sha256) -> io::Result<u64> {
    let mut buffer = [0; 64 * 1024];
    let mut total = 0;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok(total);
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
}

/// Whether the file at `path` has `file`'s pinned size and sha256.
fn matches_pin(path: &Path, file: &ModelFile) -> io::Result<bool> {
    let mut reader = File::open(path)?;
    if reader.metadata()?.len() != file.size {
        return Ok(false);
    }
    let mut hasher = Sha256::new();
    hash_into(&mut reader, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()) == file.sha256)
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// The snapshot that holds every file the model pins: the pinned one, or
/// else the one `refs/main` names. An earlier chan wrote its cache at
/// whatever commit `main` was then, with each file a link into `blobs/` or,
/// without links, renamed into place; both read here.
fn complete_snapshot(repo: &Path, model: &EmbeddingModelInfo) -> Option<PathBuf> {
    let complete = |snapshot: &Path| {
        model
            .files
            .iter()
            .all(|file| snapshot.join(file.name).is_file())
    };
    let snapshots = repo.join("snapshots");
    let pinned = snapshots.join(model.revision);
    if complete(&pinned) {
        return Some(pinned);
    }
    let commit = std::fs::read_to_string(repo.join("refs/main")).ok()?;
    if !identifier(&commit) {
        return None;
    }
    let named = snapshots.join(commit);
    complete(&named).then_some(named)
}

/// The cached copy of `filename`. All of a model's files come from one
/// snapshot: the complete one, or else the pinned one a download is filling.
fn cached(repo: &Path, model: &EmbeddingModelInfo, filename: &str) -> Option<PathBuf> {
    if let Some(snapshot) = complete_snapshot(repo, model) {
        return Some(snapshot.join(filename));
    }
    let filling = repo.join("snapshots").join(model.revision).join(filename);
    filling.is_file().then_some(filling)
}

struct FileLock(File);

impl Drop for FileLock {
    fn drop(&mut self) {
        // A descriptor inherited by a child must not extend this download's
        // critical section after its owner releases the guard.
        let _ = FileExt::unlock(&self.0);
    }
}

fn lock(path: &Path) -> Result<FileLock, DownloadError> {
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    // Waits while another download of the file runs. The holder's requests
    // are bounded by the agent's timeouts, so a stalled holder lets go.
    FileExt::lock_exclusive(&file)?;
    Ok(FileLock(file))
}

fn validate_resume(response: &Response, start: u64, size: u64) -> Result<(), DownloadError> {
    match response.status() {
        200 if start == 0 => {}
        206 => {
            let expected = format!("bytes {start}-{}/{size}", size - 1);
            if response.header("Content-Range") != Some(expected.as_str()) {
                return Err(DownloadError::InvalidResume);
            }
        }
        _ => return Err(DownloadError::InvalidResume),
    }
    if let Some(length) = response.header("Content-Length") {
        if length.parse::<u64>().ok() != Some(size - start) {
            return Err(DownloadError::InvalidResume);
        }
    }
    Ok(())
}

fn progress_bar(size: u64, start: u64, filename: &str) -> ProgressBar {
    let bar = ProgressBar::new(size);
    bar.set_style(
        ProgressStyle::with_template(
            "{msg} [{elapsed_precise}] [{wide_bar}] {bytes}/{total_bytes} {bytes_per_sec} ({eta})",
        )
        .expect("the download progress template is valid"),
    );
    bar.set_message(filename.to_owned());
    bar.set_position(start);
    bar
}

fn publish_ref(repo: &Path, commit: &str) -> io::Result<()> {
    let refs = repo.join("refs");
    std::fs::create_dir_all(&refs)?;
    // The temporary carries tempfile's temporary attribute on Windows; the
    // helper clears it on publish, so the reference keeps normal attributes.
    let builder = tempfile::Builder::new();
    let mut temporary = builder.tempfile_in(&refs)?;
    temporary.write_all(commit.as_bytes())?;
    temporary.as_file().sync_all()?;
    crate::fs_ops::persist_tempfile(temporary, &refs.join("main"))?;
    Ok(())
}

#[cfg(all(test, unix))]
mod cache_layout_tests;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod tls_tests;

#[cfg(test)]
mod publication_tests;
