//! Blocking retrieval of the three embedding files into the Hub cache layout.

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use chan_tls::rustls::{self, ClientConfig};
use fs4::fs_std::FileExt;
use indicatif::{ProgressBar, ProgressStyle};
use thiserror::Error;
use ureq::{Agent, RedirectAuthHeaders, Response};
use url::Url;

use super::{proxy_env_issue, repo_dir_name, EmbedError};

const ENDPOINT: &str = "https://huggingface.co";
const MAX_RELATIVE_REDIRECTS: usize = 5;

#[cfg(test)]
type PublicationObserver = dyn Fn(&Path) + Send + Sync;

pub(super) struct Client {
    cache: PathBuf,
    endpoint: Url,
    token: Option<String>,
    progress: bool,
    agents: OnceLock<Agents>,
    supplied_config: Option<ClientConfig>,
    // Tests observe the critical section without racing another downloader.
    #[cfg(test)]
    publication_observer: Option<Box<PublicationObserver>>,
}

struct Agents {
    metadata: Agent,
    payload: Agent,
}

impl Agents {
    fn new(config: ClientConfig, https_only: bool) -> Self {
        let config = Arc::new(config);
        let builder = || {
            ureq::AgentBuilder::new()
                .tls_config(Arc::clone(&config))
                .https_only(https_only)
                .try_proxy_from_env(true)
                .user_agent("unknown/None; hf-hub/0.4.3; rust/unknown")
        };
        Self {
            metadata: builder().redirects(0).build(),
            payload: builder()
                .redirect_auth_headers(RedirectAuthHeaders::SameHost)
                .build(),
        }
    }
}

#[derive(Debug, Error)]
enum DownloadError {
    #[error("request error: {0}")]
    Request(#[from] Box<ureq::Error>),
    #[error("I/O error {0}")]
    Io(#[from] io::Error),
    #[error("Header {0} is missing")]
    MissingHeader(&'static str),
    #[error("Header {0} is invalid")]
    InvalidHeader(&'static str),
    #[error("Invalid part file - corrupted file")]
    InvalidResume,
    #[error("Lock acquisition failed: {0}")]
    LockAcquisition(PathBuf),
    #[error("too many relative redirects")]
    RedirectLimit,
    #[error("invalid model cache path")]
    InvalidPath,
    #[error("TLS configuration: {0}")]
    Tls(#[from] chan_tls::Error),
}

impl DownloadError {
    fn into_embed(self) -> EmbedError {
        if let Some((var, value)) = proxy_env_issue() {
            return EmbedError::ProxyConfig { var, value };
        }
        let certificate = certificate_failure(&self);
        let message = self.to_string();
        if certificate {
            EmbedError::Certificate(message)
        } else {
            EmbedError::HfHub(message)
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

struct Metadata {
    commit: String,
    etag: String,
    size: u64,
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
            agents: OnceLock::new(),
            supplied_config: None,
            #[cfg(test)]
            publication_observer: None,
        })
    }

    #[cfg(test)]
    fn with_config(cache: &Path, endpoint: &str, config: ClientConfig) -> Self {
        Self {
            cache: cache.to_owned(),
            endpoint: Url::parse(endpoint).expect("the test endpoint is a URL"),
            token: None,
            progress: false,
            agents: OnceLock::new(),
            supplied_config: Some(config),
            publication_observer: None,
        }
    }

    fn agents(&self) -> Result<&Agents, DownloadError> {
        if let Some(agents) = self.agents.get() {
            return Ok(agents);
        }
        let config = match &self.supplied_config {
            Some(config) => config.clone(),
            None => chan_tls::client_config()?,
        };
        let agents = Agents::new(config, self.endpoint.scheme() == "https");
        Ok(self.agents.get_or_init(|| agents))
    }

    pub(super) fn get(&self, model: &str, filename: &str) -> Result<PathBuf, EmbedError> {
        self.get_inner(model, filename)
            .map_err(DownloadError::into_embed)
    }

    fn get_inner(&self, model: &str, filename: &str) -> Result<PathBuf, DownloadError> {
        if !model.split('/').all(model_component) || !filename_component(filename) {
            return Err(DownloadError::InvalidPath);
        }
        let repo = self.cache.join(repo_dir_name(model));
        if let Some(path) = cached(&repo, filename) {
            return Ok(path);
        }
        let url = self
            .endpoint
            .join(&format!("{model}/resolve/main/{filename}"))
            .map_err(|_| DownloadError::InvalidPath)?;
        let metadata = self.metadata(&url)?;
        let blobs = repo.join("blobs");
        std::fs::create_dir_all(&blobs)?;
        let blob = blobs.join(&metadata.etag);
        let _lock = lock_blob(&blob)?;

        // The other downloader may have completed while we waited. Keep the
        // lock through publication, including the Windows rename fallback.
        if let Some(path) = cached(&repo, filename) {
            return Ok(path);
        }
        if !std::fs::metadata(&blob).is_ok_and(|file| file.is_file() && file.len() == metadata.size)
        {
            self.download(&url, &blob, metadata.size, filename)?;
        }
        let snapshot = repo.join("snapshots").join(&metadata.commit);
        std::fs::create_dir_all(&snapshot)?;
        let pointer = snapshot.join(filename);
        #[cfg(test)]
        if let Some(observer) = &self.publication_observer {
            observer(&blob);
        }
        publish_blob(&blob, &pointer, symlink_file)?;
        publish_ref(&repo, &metadata.commit)?;
        #[cfg(test)]
        if let Some(observer) = &self.publication_observer {
            observer(&blob);
        }
        Ok(pointer)
    }

    fn request(&self, agent: &Agent, url: &Url) -> ureq::Request {
        let mut request = agent.get(url.as_str());
        if url.host_str() == self.endpoint.host_str()
            && (self.endpoint.scheme() != "https" || url.scheme() == "https")
        {
            if let Some(token) = &self.token {
                request = request.set("Authorization", &format!("Bearer {token}"));
            }
        }
        request
    }

    fn metadata(&self, url: &Url) -> Result<Metadata, DownloadError> {
        let agents = self.agents()?;
        let mut current = url.clone();
        let mut followed = 0;
        let response = loop {
            let response = self
                .request(&agents.metadata, &current)
                .set("Range", "bytes=0-0")
                .call()
                .map_err(Box::new)?;
            if matches!(response.status(), 301 | 302 | 303 | 307 | 308) {
                let location = header(&response, "Location")?;
                let next = current
                    .join(location)
                    .map_err(|_| DownloadError::InvalidHeader("Location"))?;
                if Url::parse(location).is_err() && !location.starts_with("//") {
                    if followed == MAX_RELATIVE_REDIRECTS {
                        return Err(DownloadError::RedirectLimit);
                    }
                    followed += 1;
                    current = next;
                    continue;
                }
            }
            break response;
        };
        let etag = response
            .header("x-linked-etag")
            .or_else(|| response.header("etag"))
            .ok_or(DownloadError::MissingHeader("etag"))?
            .replace('"', "");
        let commit = header(&response, "x-repo-commit")?.to_owned();
        if !identifier(&etag) {
            return Err(DownloadError::InvalidHeader("etag"));
        }
        if !identifier(&commit) {
            return Err(DownloadError::InvalidHeader("x-repo-commit"));
        }
        let response = if (300..400).contains(&response.status()) {
            let location = current
                .join(header(&response, "Location")?)
                .map_err(|_| DownloadError::InvalidHeader("Location"))?;
            self.request(&agents.payload, &location)
                .set("Range", "bytes=0-0")
                .call()
                .map_err(Box::new)?
        } else {
            response
        };
        let range = header(&response, "Content-Range")?;
        let size = range
            .rsplit_once('/')
            .and_then(|(_, total)| total.parse().ok())
            .ok_or(DownloadError::InvalidHeader("Content-Range"))?;
        Ok(Metadata { commit, etag, size })
    }

    fn download(
        &self,
        url: &Url,
        blob: &Path,
        size: u64,
        filename: &str,
    ) -> Result<(), DownloadError> {
        let part = blob.with_extension("part");
        let mut file = open_part(&part)?;
        let mut start = file.metadata()?.len();
        if start > size {
            file.set_len(0)?;
            file.rewind()?;
            start = 0;
        }
        let progress = self.progress.then(|| progress_bar(size, start, filename));
        if start != size {
            let response = self
                .request(&self.agents()?.payload, url)
                .set("Range", &format!("bytes={start}-"))
                .call()
                .map_err(Box::new)?;
            if response.status() == 200 && start != 0 {
                // A proxy may ignore Range and send the whole blob. Validate
                // it before replacing the prefix, while retaining the lock.
                validate_resume(&response, 0, size)?;
                file.set_len(0)?;
                file.rewind()?;
                start = 0;
                if let Some(progress) = &progress {
                    progress.set_position(0);
                }
            } else {
                validate_resume(&response, start, size)?;
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
                    file.set_len(start)?;
                    return Err(DownloadError::InvalidResume);
                }
                file.write_all(&buffer[..read])?;
                remaining -= read as u64;
                if let Some(progress) = &progress {
                    progress.inc(read as u64);
                }
            }
        }
        file.sync_all()?;
        drop(file);
        std::fs::rename(&part, blob)?;
        if let Some(progress) = progress {
            progress.finish();
        }
        Ok(())
    }
}

fn open_part(path: &Path) -> io::Result<File> {
    // Windows append-only handles cannot truncate a corrupt or ignored-range
    // partial. The blob lock serializes these seekable writes.
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(path)?;
    file.seek(SeekFrom::End(0))?;
    Ok(file)
}

fn header<'a>(response: &'a Response, name: &'static str) -> Result<&'a str, DownloadError> {
    response
        .header(name)
        .ok_or(DownloadError::MissingHeader(name))
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn model_component(value: &str) -> bool {
    !value.is_empty()
        && !matches!(value, "." | "..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn filename_component(value: &str) -> bool {
    matches!(
        value,
        "config.json" | "tokenizer.json" | "model.safetensors"
    )
}

fn cached(repo: &Path, filename: &str) -> Option<PathBuf> {
    let commit = std::fs::read_to_string(repo.join("refs/main")).ok()?;
    if !identifier(&commit) {
        return None;
    }
    let pointer = repo.join("snapshots").join(commit).join(filename);
    pointer.is_file().then_some(pointer)
}

struct BlobLock(File);

impl Drop for BlobLock {
    fn drop(&mut self) {
        // A descriptor inherited by a child must not extend this download's
        // critical section after its owner releases the guard.
        let _ = FileExt::unlock(&self.0);
    }
}

fn lock_blob(blob: &Path) -> Result<BlobLock, DownloadError> {
    let path = blob.with_extension("lock");
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)?;
    for attempt in 0..=5 {
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => return Ok(BlobLock(file)),
            Err(error) if error.kind() == fs4::lock_contended_error().kind() => {
                if attempt < 5 {
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err(DownloadError::LockAcquisition(path))
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

fn publish_blob(
    blob: &Path,
    pointer: &Path,
    symlink: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    if pointer.is_file() {
        return Ok(());
    }
    let name = blob
        .file_name()
        .ok_or_else(|| io::Error::other("blob has no filename"))?;
    let relative = Path::new("..").join("..").join("blobs").join(name);
    match symlink(&relative, pointer) {
        Ok(()) => Ok(()),
        Err(error) if symlink_unavailable(&error) => std::fs::rename(blob, pointer),
        Err(error) => Err(error),
    }
}

fn symlink_unavailable(error: &io::Error) -> bool {
    #[cfg(windows)]
    if error.raw_os_error() == Some(windows_sys::Win32::Foundation::ERROR_PRIVILEGE_NOT_HELD as i32)
    {
        return true;
    }
    matches!(
        error.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::Unsupported
    )
}

#[cfg(unix)]
fn symlink_file(source: &Path, destination: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(source, destination)
}

#[cfg(windows)]
fn symlink_file(source: &Path, destination: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_file(source, destination)
}

fn publish_ref(repo: &Path, commit: &str) -> io::Result<()> {
    let refs = repo.join("refs");
    std::fs::create_dir_all(&refs)?;
    // Normal file attributes survive std's rename; tempfile's persist clears
    // its temporary attribute but cannot replace an open reader on Windows.
    let mut builder = tempfile::Builder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o600));
    }
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
