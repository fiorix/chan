//! Workspace-less file transfer for standalone-terminal windows.
//!
//! A standalone terminal (`kind=terminal`) has no workspace, so `cs upload` /
//! `cs download` cannot anchor at a workspace root. Per the scope decision,
//! transfers resolve against the terminal session's working directory with the
//! reach of the shell's own uid -- there is no extra sandbox wall, since the
//! terminal already grants that filesystem access. The `cs` CLI absolutizes the
//! path against its cwd (the session cwd) before it reaches the control socket;
//! the control socket sends that absolute path with its leading `/` stripped so
//! the SPA's transfer bubble builds clean `/api/fs/...` URLs. These handlers
//! re-root that path at `/` and read or write it directly.
//!
//! Downloads pre-flight readability before building the tarball.
//! Terminal uploads rely on their atomic writer as the authoritative
//! writability check; workspace uploads use
//! `Workspace::ensure_writable`.
//!
//! The configured transfer ceiling governs both directions on this tenant.
//! Single-file reads and writes are bounded by it. Archive plans refuse when
//! the encoded archive bound already exceeds it. That bound assumes each
//! regular file's metadata length matches its content, and that every hole the
//! filesystem reports in a sparse file spans at least one 512-byte tar block.
//! The tar writer keeps a source that changes after preflight from passing the
//! ceiling mid-flight.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use axum::body::{Body, Bytes};
use axum::extract::{multipart::Field, Multipart, Path as AxumPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use futures::stream;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::bulk_transfer::{BulkCancel, BulkOutcome, BulkTransferTenant};
use crate::error::{err, err_from};
use crate::routes::files::{
    consume_transfer_body, content_disposition_archive, content_disposition_attachment,
    download_filename, is_active_content_path, query_flag, stream_upload_tracked,
    upload_leaf_filename, with_upload_destination, RequestBodyMessage, UploadDestinationParts,
};
use crate::static_assets::content_type_for;

const TAR_BLOCK_BYTES: u64 = 512;
pub(crate) const TAR_END_OF_ARCHIVE_BYTES: u64 = TAR_BLOCK_BYTES * 2;

fn tar_padded_size(size: u64) -> u64 {
    size.div_ceil(TAR_BLOCK_BYTES)
        .saturating_mul(TAR_BLOCK_BYTES)
}

fn tar_long_extension_size(path: &Path) -> u64 {
    let path_bytes = u64::try_from(path.as_os_str().as_encoded_bytes().len()).unwrap_or(u64::MAX);
    TAR_BLOCK_BYTES.saturating_add(tar_padded_size(path_bytes.saturating_add(1)))
}

/// Encoded size of one GNU tar entry, including any long-name or long-link
/// extension and content padding. Header setters make the fit decision so this
/// stays aligned with the tar builder rather than duplicating its thresholds.
pub(crate) fn tar_entry_encoded_size(
    archive_path: &Path,
    link_name: Option<&Path>,
    content_len: u64,
) -> u64 {
    let mut size = TAR_BLOCK_BYTES.saturating_add(tar_padded_size(content_len));
    let mut header = tar::Header::new_gnu();
    if header.set_path(archive_path).is_err() {
        size = size.saturating_add(tar_long_extension_size(archive_path));
    }
    if let Some(link_name) = link_name {
        let mut header = tar::Header::new_gnu();
        if header.set_link_name(link_name).is_err() {
            size = size.saturating_add(tar_long_extension_size(link_name));
        }
    }
    size
}

/// Capability root selected by a window-command transfer.
///
/// Normal Files operations omit this marker and use the tenant root. A
/// workspace window may select `filesystem` for a `cs` transfer whose absolute
/// path escapes its workspace; a terminal window always selects it.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TransferRoot {
    Workspace,
    Filesystem,
}

/// Re-root a terminal-tenant `{*path}` (the control socket strips the leading
/// `/` before sending it) at the filesystem root. A standalone-terminal
/// transfer is uid-scoped, not workspace-scoped, so the path is always
/// absolute.
fn abs_from_terminal_path(path: &str) -> PathBuf {
    PathBuf::from("/").join(path.trim_start_matches('/'))
}

/// Pre-flight for download: every file under `abs` is openable for read and
/// every directory is listable. Fails fast on the first inaccessible entry so a
/// stable source is checked before response headers. The workspace path uses a
/// sibling guard in `files.rs` that walks via `Workspace::list` to match the
/// workspace tarball's `.chan`/`.git` filtering. For trees whose regular files'
/// metadata lengths match their content, returns an encoded archive size bound
/// including entry headers, long-name and long-link extensions, content padding,
/// and termination blocks.
///
/// Regular files count their logical metadata length. A sparse file's tar entry
/// stays within that count when every hole the filesystem reports spans at
/// least one 512-byte tar block. Smaller holes can cost more in sparse
/// extension headers than they remove from the content, so on a filesystem
/// that reports them the returned size can fall short of the archive.
pub(crate) fn verify_readable_fs(abs: &Path) -> Result<u64, String> {
    let archive_name = download_filename(&abs.to_string_lossy());
    verify_readable_fs_entry(abs, Path::new(&archive_name), ArchiveEntryPosition::Root)
        .map(|size| size.saturating_add(TAR_END_OF_ARCHIVE_BYTES))
}

enum ArchiveEntryPosition {
    Root,
    Child,
}

fn verify_readable_fs_entry(
    abs: &Path,
    archive_path: &Path,
    position: ArchiveEntryPosition,
) -> Result<u64, String> {
    let meta = std::fs::symlink_metadata(abs)
        .map_err(|e| format!("cannot access {}: {e}", abs.display()))?;
    if meta.file_type().is_symlink() {
        // The archive stores the link itself; don't follow it (and don't fault
        // on a dangling target).
        let link_name =
            std::fs::read_link(abs).map_err(|e| format!("cannot read {}: {e}", abs.display()))?;
        return Ok(tar_entry_encoded_size(archive_path, Some(&link_name), 0));
    }
    if meta.is_dir() {
        let entries = std::fs::read_dir(abs)
            .map_err(|e| format!("cannot read directory {}: {e}", abs.display()))?;
        let header_path = match position {
            ArchiveEntryPosition::Root => archive_path.join(""),
            ArchiveEntryPosition::Child => archive_path.to_path_buf(),
        };
        let mut encoded_bytes = tar_entry_encoded_size(&header_path, None, 0);
        for entry in entries {
            let entry =
                entry.map_err(|e| format!("cannot read directory {}: {e}", abs.display()))?;
            encoded_bytes = encoded_bytes.saturating_add(verify_readable_fs_entry(
                &entry.path(),
                &archive_path.join(entry.file_name()),
                ArchiveEntryPosition::Child,
            )?);
        }
        Ok(encoded_bytes)
    } else {
        let metadata = std::fs::File::open(abs)
            .and_then(|file| file.metadata())
            .map_err(|e| format!("cannot read {}: {e}", abs.display()))?;
        let content_len = if metadata.is_file() {
            metadata.len()
        } else {
            0
        };
        Ok(tar_entry_encoded_size(archive_path, None, content_len))
    }
}

/// A `std::io::Write` that forwards each tar chunk to a streaming HTTP body
/// over an mpsc channel. Sends wait for capacity while checking cancellation
/// and abort when the configured no-progress timeout expires. The writer stops
/// with a body error after exactly `limit` bytes, and a dropped receiver stops
/// the build on the next write.
/// Nothing is staged on disk, so a bounded or cancelled download leaves no
/// artifact to clean up.
pub(crate) struct TarChannelWriter {
    tx: mpsc::Sender<std::io::Result<Bytes>>,
    cancel: BulkCancel,
    limit: u64,
    written: u64,
}

impl Write for TarChannelWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        // Checked per chunk so shutdown and explicit cancellation stop the
        // build promptly. A disconnect alone would also surface below when the
        // receiver is gone, but only once the next chunk is ready, which on a
        // large member can be far later than the cancel.
        if self.cancel.is_cancelled() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "transfer cancelled",
            ));
        }
        let remaining = self.limit.saturating_sub(self.written);
        if remaining == 0 {
            return Err(std::io::Error::other(format!(
                "archive reached the {} byte transfer ceiling before completion",
                self.limit
            )));
        }
        let allowed = usize::try_from(remaining)
            .map(|remaining| remaining.min(buf.len()))
            .unwrap_or(buf.len());
        self.cancel
            .send(&self.tx, Ok(Bytes::copy_from_slice(&buf[..allowed])))?;
        self.written = self
            .written
            .saturating_add(u64::try_from(allowed).unwrap_or(u64::MAX));
        Ok(allowed)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The job outcome carries aborts even when a full byte channel cannot accept
/// an error. Hyper may resume polling long after the worker released its slot.
pub(crate) fn download_body(
    rx: mpsc::Receiver<std::io::Result<Bytes>>,
    job: crate::bulk_transfer::BulkJob<()>,
    alive_tx: tokio::sync::oneshot::Sender<std::convert::Infallible>,
) -> Body {
    Body::from_stream(stream::unfold(
        (rx, Some(job), alive_tx),
        |(mut rx, mut job, alive_tx)| async move {
            if let Some(message) = rx.recv().await {
                return Some((message, (rx, job, alive_tx)));
            }
            match job.take()?.outcome().await {
                BulkOutcome::Done(()) => None,
                BulkOutcome::Cancelled => Some((
                    Err(std::io::Error::other("transfer aborted before completion")),
                    (rx, job, alive_tx),
                )),
            }
        },
    ))
}

/// Client-supplied tracking identity for one transfer. Both headers must be
/// present to opt in; a caller that sends neither is admitted and bounded
/// identically and simply receives no frames.
///
/// These are routing keys, not authorization claims. The socket that receives
/// the frames asserts its own `window_id` the same way, so validating one end
/// would manufacture an authority the other end does not have. The real
/// boundary is the workspace bearer that guards every route here.
pub(crate) struct TransferTracking {
    pub window_id: String,
    pub transfer_id: String,
}

impl TransferTracking {
    pub(crate) fn from_headers(headers: &axum::http::HeaderMap) -> Option<Self> {
        let value = |name| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
        };
        Some(Self {
            window_id: value("x-chan-window-id")?,
            transfer_id: value("x-chan-transfer-id")?,
        })
    }
}

/// Build a tar into an already-admitted job's byte channel.
///
/// Deliberately submits nothing. The admission belongs to whoever owns the job
/// this runs inside, so a caller that already holds a slot can build an archive
/// without spending a second one. Wrapping this in its own `submit` again is
/// the one way a single request comes to consume two admissions, and it would
/// look like ordinary reuse while doing it. `limit` bounds the encoded archive,
/// including headers, padding, and termination blocks.
pub(crate) fn build_tar_into<F>(
    tx: &mpsc::Sender<std::io::Result<Bytes>>,
    cancel: &BulkCancel,
    limit: u64,
    build: F,
) where
    F: FnOnce(&mut tar::Builder<TarChannelWriter>) -> std::io::Result<()> + Send + 'static,
{
    let mut builder = tar::Builder::new(TarChannelWriter {
        tx: tx.clone(),
        cancel: cancel.clone(),
        limit,
        written: 0,
    });
    builder.follow_symlinks(false);
    let result = build(&mut builder).and_then(|()| builder.finish());
    if let Err(e) = result {
        if e.kind() != std::io::ErrorKind::BrokenPipe {
            let _ = cancel.send(tx, Err(e));
        }
    }
}

#[derive(Default, Deserialize)]
pub(crate) struct TerminalDownloadQuery {
    #[serde(default)]
    download: Option<String>,
    /// Consumed only by the standalone Files read this handler dispatches
    /// to on a bare GET; the download lane ignores it.
    #[serde(default)]
    stream: Option<String>,
}

/// What the plan resolved to, reported before the first byte so the response
/// headers can be chosen while the same job goes on to stream the body.
enum PlannedDownload {
    File { name: String },
    Archive { name: String },
}

/// Plan and stream one terminal download inside a SINGLE lane job.
///
/// Planning opens the file, or pre-flights a whole directory tree, which is
/// real work and belongs on the transfer lane rather than the pool that serves
/// editor saves and terminal spawns. Submitting the plan and the stream
/// separately would make one request consume two admissions against a bound
/// that counts requests, so the job reports its plan over a oneshot and then
/// keeps going into the body.
///
/// An admission refusal is returned before the job exists, so a declined
/// download has not opened a file or walked a tree. A ceiling refusal is the
/// job's own: a file costs one open and an archive costs its preflight walk, but
/// neither sends a byte. Every early return past that point drops the job, which
/// cancels it and releases its slot.
///
/// `limit` is the server-reported effective transfer ceiling, handed in for the
/// same reason the upload arm is handed it: the terminal tenant reads outside
/// any workspace and cannot inherit a workspace's budget, and one configured
/// ceiling has to govern both tenants rather than two that drift.
async fn stream_planned_download_tracked(
    bulk: &BulkTransferTenant,
    events: Option<tokio::sync::broadcast::Sender<String>>,
    tracking: Option<TransferTracking>,
    abs: PathBuf,
    limit: u64,
) -> Response {
    let (tx, rx) = mpsc::channel::<std::io::Result<Bytes>>(8);
    let (plan_tx, plan_rx) =
        tokio::sync::oneshot::channel::<Result<PlannedDownload, DownloadRefusal>>();
    let job = match bulk.submit(move |cancel| {
        let planned = match terminal_download_plan(&abs, limit) {
            Ok(planned) => planned,
            Err(refusal) => {
                let _ = plan_tx.send(Err(refusal));
                return;
            }
        };
        match planned {
            TerminalDownload::File { mut reader, name } => {
                if plan_tx.send(Ok(PlannedDownload::File { name })).is_err() {
                    return;
                }
                // The lane worker does the reading itself. Handing the reader
                // to a pool task would cost a slot and a task for one request.
                //
                for next in reader.by_ref() {
                    if cancel.is_cancelled() {
                        let _ = tx.try_send(Err(std::io::Error::other(
                            "transfer cancelled before the file was fully streamed",
                        )));
                        return;
                    }
                    let terminal = next.is_err();
                    if cancel.send(&tx, next.map(Bytes::from)).is_err() || terminal {
                        return;
                    }
                }
            }
            TerminalDownload::Archive { name, is_dir } => {
                #[cfg(test)]
                tests::grow_after_download_preflight(&abs);
                let build_name = name.clone();
                let build_abs = abs.clone();
                if plan_tx.send(Ok(PlannedDownload::Archive { name })).is_err() {
                    return;
                }
                // Builds into this job's channel rather than through
                // `stream_tar_response_tracked`, which would submit again.
                build_tar_into(&tx, cancel, limit, move |builder| {
                    if is_dir {
                        builder.append_dir_all(&build_name, &build_abs)
                    } else {
                        builder.append_path_with_name(&build_abs, &build_name)
                    }
                });
            }
        }
    }) {
        Ok(job) => job,
        Err(full) => return full.into_response(),
    };
    let (alive_tx, alive_rx) = tokio::sync::oneshot::channel::<std::convert::Infallible>();
    if let (Some(events), Some(tracking)) = (events, tracking) {
        crate::routes::ws::spawn_transfer_queue_reporter(
            events,
            tracking.window_id,
            tracking.transfer_id,
            job.tracker(),
            alive_rx,
        );
    }
    let planned = match plan_rx.await {
        Ok(Ok(planned)) => planned,
        // The plan ran on an admitted job, so a failure here is reported after
        // the transfer genuinely occupied a slot. Returning drops the job.
        Ok(Err(refusal)) => return err(refusal.status, refusal.message),
        Err(_) => {
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "download plan did not report".into(),
            )
        }
    };
    let (content_type, disposition) = match &planned {
        // No Content-Length on either arm: a tar has no known length, and a
        // file arm bounded by the ceiling still has none, because a ceiling is
        // a maximum rather than a count. The file may grow while it streams, so
        // the only length that could be declared is the one seen at open, which
        // is exactly the promise this path does not make.
        PlannedDownload::File { name } => (
            content_type_for(name).to_string(),
            content_disposition_attachment(name),
        ),
        PlannedDownload::Archive { name } => (
            "application/x-tar".to_string(),
            content_disposition_archive(name),
        ),
    };
    let body = download_body(rx, job, alive_tx);
    let mut response = (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CONTENT_DISPOSITION, disposition),
        ],
        body,
    )
        .into_response();
    // This mirrors the workspace download. Both arms are attachments, so
    // nosniff is unconditional. Only the file arm takes the sandbox CSP, kept
    // conditional on the active-content predicate; the archive arm always
    // declares a tar, whatever its root is named.
    response.headers_mut().insert(
        "x-content-type-options",
        "nosniff".parse().expect("static header value"),
    );
    if let PlannedDownload::File { name } = &planned {
        if is_active_content_path(name) {
            response.headers_mut().insert(
                header::CONTENT_SECURITY_POLICY,
                "sandbox".parse().expect("static header value"),
            );
        }
    }
    response
}

/// Stream one uid-filesystem download using the shared preflight and ceiling.
pub(crate) async fn filesystem_download_response(
    state: &std::sync::Arc<crate::state::AppState>,
    path: &str,
    headers: &axum::http::HeaderMap,
) -> Response {
    stream_planned_download_tracked(
        &state.bulk_transfer,
        Some(state.events_tx.clone()),
        TransferTracking::from_headers(headers),
        abs_from_terminal_path(path),
        state.library.transfer_max_bytes(),
    )
    .await
}

/// `GET /api/fs/{*path}?download=1` on the terminal tenant: stream the cwd /
/// uid-scoped file or a tar of the directory. Mounted only on the slim terminal
/// router, so `{*path}` is always a filesystem-absolute target (see
/// [`abs_from_terminal_path`]).
pub async fn api_terminal_read_file(
    State(state): State<std::sync::Arc<crate::state::AppState>>,
    AxumPath(path): AxumPath<String>,
    Query(query): Query<TerminalDownloadQuery>,
    headers: axum::http::HeaderMap,
) -> Response {
    // A bare GET is the standalone Files application's read lane: this
    // route owns the path, so the dispatch happens here rather than as a
    // second registration axum would refuse at router build. A tenant without
    // Files state fetches no file content inline; its only legitimate GET is the
    // download gesture.
    if !query_flag(&query.download) {
        if let Some(files) = state.standalone_files.clone() {
            return crate::routes::standalone_fs::standalone_read_file(
                state.bulk_transfer.stall_signal(),
                files,
                path,
                query_flag(&query.stream),
                &headers,
            )
            .await;
        }
        return err(
            StatusCode::BAD_REQUEST,
            "terminal file route requires ?download=1".into(),
        );
    }
    filesystem_download_response(&state, &path, &headers).await
}

/// One absolute regular-file stream, read lazily by whoever pulls it.
///
/// The handle is opened up front so a missing or unreadable target fails before
/// any header is sent, but no byte is read until `next()` is called, which lets
/// the caller do the reading on a thread it already owns rather than paying for
/// a producer of its own.
///
/// The read runs to EOF or to the effective transfer ceiling, whichever comes
/// first, and never to the byte count seen at open. Those are different bounds
/// and only the second would truncate a file that grew while it streamed: a
/// file may still grow freely below the ceiling, because this response declares
/// no `Content-Length` and so promises no length a live file could contradict.
/// What the ceiling forbids is passing it, which is why the count is kept here
/// rather than derived from the size the plan measured.
struct AbsoluteFileReader {
    file: Option<std::fs::File>,
    /// Size of the open handle, which the plan refuses against before any
    /// header is sent. Read from the handle rather than the path so it
    /// describes the file that will actually be streamed.
    size: u64,
    limit: u64,
    streamed: u64,
}

impl AbsoluteFileReader {
    fn open(abs: &Path, limit: u64) -> Result<Self, String> {
        let file =
            std::fs::File::open(abs).map_err(|e| format!("cannot read {}: {e}", abs.display()))?;
        let metadata = file
            .metadata()
            .map_err(|e| format!("cannot stat {}: {e}", abs.display()))?;
        if !metadata.is_file() {
            return Err(format!("not a regular file: {}", abs.display()));
        }
        Ok(Self {
            file: Some(file),
            size: metadata.len(),
            limit,
            streamed: 0,
        })
    }
}

impl Iterator for AbsoluteFileReader {
    type Item = std::io::Result<Vec<u8>>;

    fn next(&mut self) -> Option<Self::Item> {
        let file = self.file.as_mut()?;
        let mut chunk = vec![0u8; chan_workspace::BINARY_STREAM_CHUNK_SIZE];
        match file.read(&mut chunk) {
            Ok(0) => {
                self.file = None;
                None
            }
            Ok(count) => {
                // Counted against the ceiling as bytes stream, not once from
                // the plan's measurement: appending to a file after it was
                // measured is otherwise enough to serve past the bound, and the
                // plan cannot see a write that has not happened yet.
                let attempted = self
                    .streamed
                    .saturating_add(u64::try_from(count).unwrap_or(u64::MAX));
                if attempted > self.limit {
                    // An error rather than a clean end. A stream that simply
                    // stops is indistinguishable from a complete transfer and
                    // hands the client a truncated file it believes is whole.
                    self.file = None;
                    return Some(Err(std::io::Error::other(format!(
                        "file grew past the {} byte transfer ceiling while streaming",
                        self.limit
                    ))));
                }
                self.streamed = attempted;
                chunk.truncate(count);
                Some(Ok(chunk))
            }
            Err(error) => {
                self.file = None;
                Some(Err(error))
            }
        }
    }
}

/// What a terminal download resolves to: an open-file reader already inside the
/// ceiling and carrying it, or a directory whose tree has been pre-flighted
/// readable, or an inert symlink, ready to archive.
enum TerminalDownload {
    File {
        reader: AbsoluteFileReader,
        name: String,
    },
    Archive {
        name: String,
        is_dir: bool,
    },
}

/// Why a download will not be served, carrying the status with the message.
///
/// A file past the ceiling and an unreadable path are both refusals returned
/// before a byte is streamed, but they are not the same failure and a caller
/// cannot act on them the same way. Keeping the status here is what lets one
/// place report both without inferring the kind from the wording.
#[cfg_attr(test, derive(Debug))]
struct DownloadRefusal {
    status: StatusCode,
    message: String,
}

impl DownloadRefusal {
    fn unreadable(message: String) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message,
        }
    }

    /// Names both numbers so a refusal is diagnosable from the response alone,
    /// without correlating it against a log or the server's configuration.
    fn over_ceiling(size: u64, limit: u64) -> Self {
        Self {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            message: format!(
                "download too large: {size} bytes exceeds the {limit} byte transfer ceiling"
            ),
        }
    }
}

fn terminal_download_plan(abs: &Path, limit: u64) -> Result<TerminalDownload, DownloadRefusal> {
    let meta = std::fs::symlink_metadata(abs).map_err(|e| {
        DownloadRefusal::unreadable(format!("cannot access {}: {e}", abs.display()))
    })?;
    let name = download_filename(&abs.to_string_lossy());
    if meta.is_dir() || meta.file_type().is_symlink() {
        // Pre-flight the whole tree before streaming so an unreadable entry or
        // encoded archive over the ceiling fails with a clear status before a
        // body starts. A source that changes after this walk remains bounded by
        // the tar writer.
        let encoded_bytes = verify_readable_fs(abs).map_err(DownloadRefusal::unreadable)?;
        if encoded_bytes > limit {
            return Err(DownloadRefusal::over_ceiling(encoded_bytes, limit));
        }
        Ok(TerminalDownload::Archive {
            name,
            is_dir: meta.is_dir(),
        })
    } else {
        // Opening happens before headers are sent. The reader keeps the exact file handle for synchronous chunk reads on the caller's thread.
        let reader = AbsoluteFileReader::open(abs, limit).map_err(DownloadRefusal::unreadable)?;
        // Refused here rather than mid-stream so an over-ceiling download costs
        // one open and produces a status the caller can act on, instead of a
        // 200 that aborts partway through a body.
        if reader.size > limit {
            return Err(DownloadRefusal::over_ceiling(reader.size, limit));
        }
        Ok(TerminalDownload::File { reader, name })
    }
}

#[derive(Serialize)]
#[cfg_attr(test, derive(Debug))]
struct TerminalUploadResponse {
    path: String,
    size: u64,
}

/// Query marker splitting the upload route's two contracts. `app=files`
/// selects the standalone File Browser lane; anything else (including a
/// missing marker) selects the `cs upload` lane. A plain string rather
/// than a typed enum so an unknown `app` value selects the `cs upload`
/// lane instead of failing to deserialize.
#[derive(Default, Deserialize)]
pub(crate) struct TerminalUploadQuery {
    #[serde(default)]
    app: Option<String>,
    #[serde(default)]
    w: Option<String>,
}

/// `POST /api/fs/upload` on the terminal tenant: write the uploaded file into
/// the cwd / uid-scoped `dir`. This is the `cs upload` lane, which has no
/// replace (`path`) flow: it targets a directory, not a file the user picked.
/// Mounted only on the terminal router, so `dir` is absolute.
///
/// `?app=files` dispatches to the standalone Files upload instead: this
/// route owns the path, so the fork happens here rather than as a second
/// registration axum would refuse at router build.
pub async fn api_terminal_upload_file(
    State(state): State<std::sync::Arc<crate::state::AppState>>,
    Query(query): Query<TerminalUploadQuery>,
    headers: axum::http::HeaderMap,
    multipart: Multipart,
) -> Response {
    if query.app.as_deref() == Some("files") {
        return crate::routes::standalone_fs::standalone_upload_file(
            state, query.w, headers, multipart,
        )
        .await;
    }
    filesystem_upload_response(state, headers, multipart).await
}

/// Stream one upload into an absolute directory of this uid's filesystem
/// through the terminal writer, under the library's transfer ceiling.
pub(crate) async fn filesystem_upload_response(
    state: std::sync::Arc<crate::state::AppState>,
    headers: axum::http::HeaderMap,
    mut multipart: Multipart,
) -> Response {
    with_upload_destination(
        &mut multipart,
        UploadDestinationParts::DirOnly,
        async |destination, field| {
            stream_terminal_upload(
                &state.bulk_transfer,
                Some(state.events_tx.clone()),
                TransferTracking::from_headers(&headers),
                abs_from_terminal_path(&destination.dir),
                destination.filename,
                state.library.transfer_max_bytes(),
                field,
            )
            .await
        },
    )
    .await
}

/// The terminal lane on the shared upload job; the writer is
/// `terminal_upload_stream_sync`.
///
/// `limit` is the server-reported effective transfer ceiling. The terminal
/// tenant writes outside any workspace, so it cannot inherit the budget
/// `Workspace::write_atomic_stream` applies and has to be handed the same
/// value explicitly; that is what keeps one configured ceiling governing both
/// tenants rather than two that drift.
async fn stream_terminal_upload(
    bulk: &BulkTransferTenant,
    events: Option<tokio::sync::broadcast::Sender<String>>,
    tracking: Option<TransferTracking>,
    abs_dir: PathBuf,
    filename: String,
    limit: u64,
    field: Field<'_>,
) -> Response {
    stream_upload_tracked(
        bulk,
        events,
        tracking,
        field,
        move |cancel, rx| terminal_upload_stream_sync(&abs_dir, &filename, rx, limit, cancel),
        err_from,
    )
    .await
}

/// Directory that a staged post-commit sync failure applies to.
///
/// Scoped to one directory rather than flipped globally: the upload tests run
/// in the same process and in parallel, and a staged failure must not reach a
/// neighbour's upload.
#[cfg(test)]
static FAIL_DIR_SYNC_FOR: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

/// fsync the directory that just accepted the upload's rename.
///
/// Wrapped rather than called inline so a test can stage the failure: a
/// directory that just accepted a rename from this process opens and flushes
/// fine, so the failure arm is otherwise unreachable from a test.
fn post_commit_sync_dir(abs_dir: &Path) -> chan_workspace::Result<()> {
    #[cfg(test)]
    {
        let staged = FAIL_DIR_SYNC_FOR
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if staged.as_deref() == Some(abs_dir) {
            return Err(chan_workspace::ChanError::Io("staged failure".into()));
        }
    }
    chan_workspace::fs_ops::sync_dir(abs_dir)
}

fn terminal_upload_stream_sync(
    abs_dir: &Path,
    original_name: &str,
    mut rx: mpsc::Receiver<RequestBodyMessage>,
    limit: u64,
    cancel: &BulkCancel,
) -> chan_workspace::Result<TerminalUploadResponse> {
    let metadata = std::fs::metadata(abs_dir).map_err(chan_workspace::ChanError::from)?;
    if !metadata.is_dir() {
        return Err(chan_workspace::ChanError::Io(format!(
            "destination is not a directory: {}",
            abs_dir.display()
        )));
    }
    let leaf = upload_leaf_filename(original_name)?;
    let target = abs_dir.join(&leaf);
    if target.exists() {
        return Err(chan_workspace::ChanError::PathAlreadyExists(
            target.display().to_string(),
        ));
    }
    let mut temp =
        tempfile::NamedTempFile::new_in(abs_dir).map_err(chan_workspace::ChanError::from)?;
    let mut written = 0u64;
    consume_transfer_body(&mut rx, cancel, |bytes| {
        // Checked per chunk rather than once at the start: an abandoned
        // upload must return its admission slot within one chunk's work
        // instead of holding it for a transfer nobody is waiting on. The
        // temp file is dropped unpersisted, so nothing is left behind.
        if cancel.is_cancelled() {
            return Err(chan_workspace::ChanError::Io(
                "upload cancelled before it completed".into(),
            ));
        }
        let attempted = written.saturating_add(u64::try_from(bytes.len()).unwrap_or(u64::MAX));
        if attempted > limit {
            return Err(chan_workspace::ChanError::WriteTooLarge {
                kind: "bytes",
                size: attempted,
                limit,
            });
        }
        temp.write_all(bytes)
            .map_err(chan_workspace::ChanError::from)?;
        written = attempted;
        Ok(())
    })?;
    temp.as_file()
        .sync_all()
        .map_err(|error| chan_workspace::ChanError::io_with_context(error, "fsync tmp"))?;
    temp.persist_noclobber(&target)
        .map_err(|error| chan_workspace::ChanError::from(error.error))?;
    // Post-commit: `persist_noclobber` already renamed the file into place, so
    // a failed directory fsync means the dirent may not survive a power loss,
    // not that the upload did not happen. Failing the response here reports
    // "nothing happened" about a file that is on disk, and the retry it invites
    // is refused by the already-exists check above, leaving the user unable to
    // redo an upload that in fact succeeded. Logged instead of discarded so a
    // filesystem that cannot flush is still visible in the server log.
    if let Err(error) = post_commit_sync_dir(abs_dir) {
        tracing::warn!(
            dir = %abs_dir.display(),
            error = %error,
            "terminal upload committed but its directory fsync failed"
        );
    }
    Ok(TerminalUploadResponse {
        path: target.display().to_string(),
        size: written,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    static GROW_AFTER_DOWNLOAD_PREFLIGHT: std::sync::Mutex<Vec<(PathBuf, Vec<u8>)>> =
        std::sync::Mutex::new(Vec::new());

    fn schedule_growth_after_download_preflight(path: &Path, bytes: Vec<u8>) {
        GROW_AFTER_DOWNLOAD_PREFLIGHT
            .lock()
            .unwrap()
            .push((path.to_path_buf(), bytes));
    }

    pub(super) fn grow_after_download_preflight(path: &Path) {
        let bytes = {
            let mut pending = GROW_AFTER_DOWNLOAD_PREFLIGHT.lock().unwrap();
            pending
                .iter()
                .position(|(candidate, _)| candidate == path)
                .map(|index| pending.swap_remove(index).1)
        };
        if let Some(bytes) = bytes {
            std::fs::write(path.join("grew-after-preflight.bin"), bytes).unwrap();
        }
    }

    fn terminal_upload(
        abs_dir: &Path,
        original_name: &str,
        bytes: &[u8],
    ) -> chan_workspace::Result<TerminalUploadResponse> {
        let (tx, rx) = mpsc::channel(2);
        tx.try_send(RequestBodyMessage::Chunk(Bytes::copy_from_slice(bytes)))
            .unwrap();
        tx.try_send(RequestBodyMessage::Complete).unwrap();
        drop(tx);
        terminal_upload_stream_sync(
            abs_dir,
            original_name,
            rx,
            8192,
            &crate::bulk_transfer::test_support::uncancelled(),
        )
    }

    #[tokio::test]
    async fn terminal_multipart_upload_streams_after_directory_metadata() {
        use axum::http::Request;
        use axum::routing::post;
        use axum::Router;
        use tower::ServiceExt;

        let dir = tempfile::tempdir().unwrap();
        let boundary = "terminal-upload-boundary";
        let rooted_dir = dir.path().display().to_string();
        let body = format!(
            "--{boundary}\r\n\
             Content-Disposition: form-data; name=\"dir\"\r\n\r\n\
             {rooted_dir}\r\n\
             --{boundary}\r\n\
             Content-Disposition: form-data; name=\"file\"; filename=\"note.bin\"\r\n\r\n\
             terminal-stream\r\n\
             --{boundary}--\r\n"
        );
        // The shared test lane is right here: this test admits one job and
        // never saturates, so it cannot refuse admission for a concurrent test.
        let app = Router::new()
            .route("/upload", post(api_terminal_upload_file))
            .with_state(crate::state::test_support::make_test_state(false));

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/upload")
                    .header(
                        header::CONTENT_TYPE,
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            std::fs::read(dir.path().join("note.bin")).unwrap(),
            b"terminal-stream"
        );
    }

    /// Post one hand-built multipart body to the terminal tenant's real
    /// router, so the pin covers the mount and the dispatch, not a handler
    /// called by hand.
    async fn post_terminal_upload(boundary: &str, body: String) -> Response {
        use axum::http::Request;
        use tower::ServiceExt;

        let app = crate::terminal_router(crate::state::test_support::make_test_state(false));
        app.oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/fs/upload")
                .header(
                    header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap()
    }

    async fn error_body(response: Response) -> String {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        body["error"].as_str().unwrap().to_owned()
    }

    /// The `dir` part precedes the streaming `file` part. A body that leads
    /// with the file is refused before a byte is written, and the refusal
    /// names the one destination part this lane accepts. The `file` part
    /// carries no filename, so a lane that admitted it anyway would stop at
    /// the leaf-name check, before a temp file exists, with an empty `dir`
    /// (the filesystem root) as its destination.
    #[tokio::test]
    async fn terminal_upload_prologue_refuses_file_before_dir() {
        let dir = tempfile::tempdir().unwrap();
        let boundary = "terminal-prologue-file-first";
        let rooted_dir = dir.path().display().to_string();
        let body = format!(
            "--{boundary}\r\n\
             Content-Disposition: form-data; name=\"file\"\r\n\r\n\
             no-write\r\n\
             --{boundary}\r\n\
             Content-Disposition: form-data; name=\"dir\"\r\n\r\n\
             {rooted_dir}\r\n\
             --{boundary}--\r\n"
        );

        let response = post_terminal_upload(boundary, body).await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            error_body(response).await,
            "`dir` must precede the streaming `file` part"
        );
    }

    /// This lane has no replace flow, so a `path` part is not a destination:
    /// a body carrying `path` and `file` but no `dir` is refused like one with
    /// no destination at all. Counting `path` would admit the upload with an
    /// empty `dir`, which resolves to the filesystem root; the `file` part
    /// carries no filename so that such a lane stops at the leaf-name check
    /// instead of writing there.
    #[tokio::test]
    async fn terminal_upload_prologue_ignores_path_and_refuses_file_without_dir() {
        let dir = tempfile::tempdir().unwrap();
        let boundary = "terminal-prologue-path";
        let rooted_path = dir.path().join("unrooted.bin").display().to_string();
        let body = format!(
            "--{boundary}\r\n\
             Content-Disposition: form-data; name=\"path\"\r\n\r\n\
             {rooted_path}\r\n\
             --{boundary}\r\n\
             Content-Disposition: form-data; name=\"file\"\r\n\r\n\
             no-write\r\n\
             --{boundary}--\r\n"
        );

        let response = post_terminal_upload(boundary, body).await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            error_body(response).await,
            "`dir` must precede the streaming `file` part"
        );
    }

    #[tokio::test]
    async fn terminal_upload_reports_the_commit_when_its_directory_fsync_fails() {
        use axum::http::Request;
        use axum::routing::post;
        use axum::Router;
        use tower::ServiceExt;

        let dir = tempfile::tempdir().unwrap();
        // The rename is the commit point; the directory fsync after it is
        // durability, not success. Stage that fsync failing and the file is
        // still on disk, so the caller must be told the upload happened.
        *FAIL_DIR_SYNC_FOR
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(dir.path().to_path_buf());
        let boundary = "terminal-upload-dirsync-boundary";
        let rooted_dir = dir.path().display().to_string();
        let body = format!(
            "--{boundary}\r\n\
             Content-Disposition: form-data; name=\"dir\"\r\n\r\n\
             {rooted_dir}\r\n\
             --{boundary}\r\n\
             Content-Disposition: form-data; name=\"file\"; filename=\"note.bin\"\r\n\r\n\
             committed-bytes\r\n\
             --{boundary}--\r\n"
        );
        let app = Router::new()
            .route("/upload", post(api_terminal_upload_file))
            .with_state(crate::state::test_support::make_test_state(false));

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/upload")
                    .header(
                        header::CONTENT_TYPE,
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        *FAIL_DIR_SYNC_FOR
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            std::fs::read(dir.path().join("note.bin")).unwrap(),
            b"committed-bytes"
        );
    }

    /// A multipart body carrying a single `file` part, so a test can reach
    /// `stream_terminal_upload` directly instead of through the router. Going
    /// through the router would put the upload on the shared test lane, which
    /// must never be saturated: filling it refuses admission for whatever else
    /// is running at that moment, and the red surfaces in an unrelated test.
    async fn file_field_multipart(boundary: &str, filename: &str, content: &str) -> Multipart {
        use axum::extract::FromRequest;

        let body = format!(
            "--{boundary}\r\n\
             Content-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n\r\n\
             {content}\r\n\
             --{boundary}--\r\n"
        );
        let request = axum::http::Request::builder()
            .method("POST")
            .uri("/upload")
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Body::from(body))
            .unwrap();
        Multipart::from_request(request, &()).await.unwrap()
    }

    /// Both sides of the admission bound, because a refusal on its own can pass
    /// for the wrong reason: the same upload must succeed once the lane drains,
    /// which is what pins the 503 to the bound rather than to a broken route.
    ///
    /// The refused target directory does not exist, so if the refusal ever
    /// stopped preceding the write this test would fail with a write error
    /// instead of a 503.
    #[tokio::test]
    async fn a_terminal_upload_refused_at_the_bound_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("not-here");
        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
        let (releases, held) = crate::bulk_transfer::test_support::saturate_admission(&bulk);

        let mut refused_body = file_field_multipart("refused-upload", "declined.bin", "body").await;
        let refused_field = refused_body.next_field().await.unwrap().unwrap();
        let refused = stream_terminal_upload(
            &bulk,
            None,
            None,
            missing.clone(),
            "declined.bin".into(),
            u64::MAX,
            refused_field,
        )
        .await;
        assert_eq!(
            refused.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "a full lane must refuse the upload rather than write it"
        );
        assert_eq!(
            refused
                .headers()
                .get(header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok()),
            Some("1"),
            "a refusal must tell the caller when to come back"
        );
        assert!(
            !missing.exists(),
            "a refused upload must not touch its destination"
        );
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            0,
            "a refused upload must leave no target and no temp file"
        );

        // Awaiting every held job is proof the slots are free, where dropping
        // the senders and continuing would only be a guess about timing.
        drop(releases);
        for job in held {
            let _ = job.outcome().await;
        }

        let mut admitted_body =
            file_field_multipart("admitted-upload", "admitted.bin", "body").await;
        let admitted_field = admitted_body.next_field().await.unwrap().unwrap();
        let admitted = stream_terminal_upload(
            &bulk,
            None,
            None,
            dir.path().to_path_buf(),
            "admitted.bin".into(),
            u64::MAX,
            admitted_field,
        )
        .await;
        assert_eq!(
            admitted.status(),
            StatusCode::OK,
            "the same upload must succeed once the lane has capacity"
        );
        assert_eq!(
            std::fs::read(dir.path().join("admitted.bin")).unwrap(),
            b"body"
        );
    }

    /// The writer must observe cancellation BETWEEN chunks rather than once
    /// before the loop, or an abandoned upload holds its slot for the length of
    /// the transfer instead of the length of one chunk.
    ///
    /// Channel capacity 1 is what makes that discriminating: the second send
    /// returns only after the writer has taken the first chunk out of the
    /// buffer, so the flag is set strictly after the writer entered the loop. A
    /// start-only check would already have passed and would persist the file.
    #[tokio::test]
    async fn a_cancelled_terminal_upload_stops_between_chunks_and_leaves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("aborted.bin");
        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();

        let (tx, rx) = mpsc::channel(1);
        let abs_dir = dir.path().to_path_buf();
        let job = bulk
            .submit(move |cancel| {
                // The ceiling is not what this test is about, so it is set
                // out of the way rather than at a value a chunk could reach.
                terminal_upload_stream_sync(&abs_dir, "aborted.bin", rx, u64::MAX, cancel)
            })
            .expect("an idle lane admits");

        tx.send(RequestBodyMessage::Chunk(Bytes::from_static(b"first")))
            .await
            .unwrap();
        tx.send(RequestBodyMessage::Chunk(Bytes::from_static(b"second")))
            .await
            .unwrap();

        job.cancel();

        // Sent after the flag, so the writer cannot reach `Complete` without
        // having read a chunk with cancellation already visible to it.
        for _ in 0..4 {
            let _ = tx
                .send(RequestBodyMessage::Chunk(Bytes::from_static(b"more")))
                .await;
        }
        let _ = tx.send(RequestBodyMessage::Complete).await;
        drop(tx);

        assert!(
            matches!(job.outcome().await, BulkOutcome::Cancelled),
            "a cancelled job reports no result"
        );
        assert!(
            !target.exists(),
            "a cancelled upload must not persist its target"
        );
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            0,
            "a cancelled upload must leave no temp file behind"
        );
    }

    /// The ceiling on the terminal tenant, from both sides. This path writes
    /// outside any workspace, so it cannot inherit the workspace budget and is
    /// handed the effective value instead; that hand-off is what this pins.
    #[tokio::test]
    async fn transfer_cap_admits_the_exact_ceiling_and_refuses_one_byte_over() {
        const CAP: u64 = 4096;
        let dir = tempfile::tempdir().unwrap();
        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();

        let mut exact_body =
            file_field_multipart("cap-exact", "exact.bin", &"z".repeat(CAP as usize)).await;
        let exact_field = exact_body.next_field().await.unwrap().unwrap();
        let exact = stream_terminal_upload(
            &bulk,
            None,
            None,
            dir.path().to_path_buf(),
            "exact.bin".into(),
            CAP,
            exact_field,
        )
        .await;
        assert_eq!(
            exact.status(),
            StatusCode::OK,
            "an upload of exactly the effective ceiling must be accepted"
        );
        assert_eq!(
            std::fs::metadata(dir.path().join("exact.bin"))
                .unwrap()
                .len(),
            CAP
        );

        let mut over_body =
            file_field_multipart("cap-over", "over.bin", &"z".repeat(CAP as usize + 1)).await;
        let over_field = over_body.next_field().await.unwrap().unwrap();
        let over = stream_terminal_upload(
            &bulk,
            None,
            None,
            dir.path().to_path_buf(),
            "over.bin".into(),
            CAP,
            over_field,
        )
        .await;
        assert_eq!(
            over.status(),
            StatusCode::PAYLOAD_TOO_LARGE,
            "one byte past the effective ceiling must be refused"
        );
        assert!(
            !dir.path().join("over.bin").exists(),
            "a refused upload must leave no target"
        );
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            1,
            "a refused upload must leave no temp file beside the accepted one"
        );
    }

    /// The same cadence at the writer's own seam, with no lane involved.
    ///
    /// Worth having next to the job-level test because it is the shape any
    /// other admitted writer or reader can copy: a flippable signal removes the
    /// need to admit a job just to obtain a `BulkCancel`, and it is what lets a
    /// test observe the per-chunk check instead of only the eventual stop.
    #[tokio::test]
    async fn the_upload_writer_observes_cancellation_between_chunks_at_its_seam() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel(1);
        let (cancel, flag) = crate::bulk_transfer::test_support::cancel_switch();
        let abs_dir = dir.path().to_path_buf();
        let writer = std::thread::spawn(move || {
            terminal_upload_stream_sync(&abs_dir, "seam.bin", rx, u64::MAX, &cancel)
        });

        tx.send(RequestBodyMessage::Chunk(Bytes::from_static(b"first")))
            .await
            .unwrap();
        // Capacity 1, so this returns only once the writer has taken the first
        // chunk: the flag below is therefore set strictly after the writer
        // entered its loop, which a check placed before the loop would already
        // have passed.
        tx.send(RequestBodyMessage::Chunk(Bytes::from_static(b"second")))
            .await
            .unwrap();

        flag.store(true, std::sync::atomic::Ordering::SeqCst);

        for _ in 0..4 {
            let _ = tx
                .send(RequestBodyMessage::Chunk(Bytes::from_static(b"more")))
                .await;
        }
        let _ = tx.send(RequestBodyMessage::Complete).await;
        drop(tx);

        let error = writer.join().unwrap().unwrap_err();
        assert!(
            error.to_string().contains("cancelled"),
            "the writer must stop on the flag, not finish: {error}"
        );
        assert!(
            !dir.path().join("seam.bin").exists(),
            "a cancelled write must not persist its target"
        );
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            0,
            "a cancelled write must leave no temp file behind"
        );
    }

    #[test]
    fn abs_from_terminal_path_reroots_at_filesystem_root() {
        assert_eq!(
            abs_from_terminal_path("home/u/proj/foo.txt"),
            PathBuf::from("/home/u/proj/foo.txt")
        );
        // Defensive: a leading slash (shouldn't happen -- the control socket
        // strips it) is tolerated, not doubled.
        assert_eq!(
            abs_from_terminal_path("/etc/hosts"),
            PathBuf::from("/etc/hosts")
        );
    }

    #[test]
    fn verify_readable_fs_passes_a_readable_tree_and_names_an_unreadable_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"a").unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("b.txt"), b"b").unwrap();
        assert!(verify_readable_fs(dir.path()).is_ok());

        let missing = dir.path().join("nope.txt");
        let e = verify_readable_fs(&missing).unwrap_err();
        assert!(e.contains("nope.txt"), "error should name the path: {e}");
    }

    #[test]
    fn terminal_archive_preflight_matches_the_real_encoded_size() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("empty")).unwrap();
        std::fs::create_dir_all(dir.path().join("nested/deeper")).unwrap();

        for size in [0, 1, 511, 512, 513] {
            std::fs::write(
                dir.path().join(format!("size-{size}.bin")),
                vec![0x5a; size],
            )
            .unwrap();
        }

        let archive_name = download_filename(&dir.path().to_string_lossy());
        for path_len in [99, 100, 101, 180] {
            let leaf = "p".repeat(path_len - archive_name.len() - 1);
            std::fs::write(dir.path().join(leaf), b"x").unwrap();
        }

        let long_dir = "q".repeat(255);
        let long_file_len = 512usize
            .checked_sub(archive_name.len() + 1 + long_dir.len() + 1)
            .expect("archive path prefix leaves room for a 512-byte path fixture");
        let long_file = "r".repeat(long_file_len);
        let long_archive_path = Path::new(&archive_name).join(&long_dir).join(&long_file);
        assert_eq!(long_archive_path.as_os_str().as_encoded_bytes().len(), 512);
        std::fs::create_dir(dir.path().join(&long_dir)).unwrap();
        std::fs::write(dir.path().join(&long_dir).join(&long_file), b"x").unwrap();

        #[cfg(unix)]
        {
            for target_len in [99, 100, 101, 180] {
                std::os::unix::fs::symlink(
                    "t".repeat(target_len),
                    dir.path().join(format!("link-{target_len}")),
                )
                .unwrap();
            }
            let long_link = "l".repeat(101);
            let long_target = "t".repeat(101);
            assert!(Path::new(&archive_name).join(&long_link).as_os_str().len() > 100);
            std::os::unix::fs::symlink(long_target, dir.path().join(long_link)).unwrap();
        }

        let planned = verify_readable_fs(dir.path()).unwrap();
        let mut bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut bytes);
            builder.follow_symlinks(false);
            builder.append_dir_all(&archive_name, dir.path()).unwrap();
            builder.finish().unwrap();
        }

        assert_eq!(planned, bytes.len() as u64);
    }

    fn assert_terminal_directory_root_size_matches_builder(root_name_len: usize) {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("d".repeat(root_name_len));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("f"), b"").unwrap();

        let archive_name = download_filename(&root.to_string_lossy());
        let planned = verify_readable_fs(&root).unwrap();
        let mut bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut bytes);
            builder.follow_symlinks(false);
            builder.append_dir_all(&archive_name, &root).unwrap();
            builder.finish().unwrap();
        }

        assert_eq!(
            planned,
            bytes.len() as u64,
            "{root_name_len}-byte directory root: planned={planned}, real={}",
            bytes.len()
        );
    }

    #[test]
    fn terminal_archive_preflight_matches_a_99_byte_directory_root() {
        assert_terminal_directory_root_size_matches_builder(99);
    }

    #[test]
    fn terminal_archive_preflight_matches_a_100_byte_directory_root() {
        assert_terminal_directory_root_size_matches_builder(100);
    }

    #[tokio::test]
    async fn archive_writer_stops_after_exactly_the_encoded_byte_ceiling() {
        const CAP: u64 = 1300;
        let (tx, mut rx) = mpsc::channel(8);
        let cancel = crate::bulk_transfer::test_support::uncancelled();

        build_tar_into(&tx, &cancel, CAP, |builder| {
            let mut header = tar::Header::new_gnu();
            header.set_size(513);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, "payload.bin", &[0x5a; 513][..])
        });
        drop(tx);

        let mut delivered = 0usize;
        let mut body_error = None;
        while let Some(next) = rx.recv().await {
            match next {
                Ok(bytes) => delivered += bytes.len(),
                Err(error) => body_error = Some(error.to_string()),
            }
        }

        assert_eq!(delivered, CAP as usize);
        assert!(
            body_error
                .as_deref()
                .is_some_and(|message| message.contains("1300 byte transfer ceiling")),
            "the writer must report the encoded-byte ceiling: {body_error:?}"
        );
    }

    #[test]
    fn terminal_upload_writes_into_dir_and_refuses_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        let resp = terminal_upload(dir.path(), "note.txt", b"hello").unwrap();
        assert_eq!(resp.size, 5);
        assert_eq!(
            std::fs::read(dir.path().join("note.txt")).unwrap(),
            b"hello"
        );
        // A second upload of the same name is refused (no silent overwrite).
        let error = terminal_upload(dir.path(), "note.txt", b"world").unwrap_err();
        assert!(
            matches!(
                &error,
                chan_workspace::ChanError::PathAlreadyExists(path)
                    if path == &dir.path().join("note.txt").display().to_string()
            ),
            "{error:?}"
        );
        assert_eq!(
            std::fs::read(dir.path().join("note.txt")).unwrap(),
            b"hello"
        );
    }

    #[test]
    fn terminal_upload_writes_nothing_when_destination_is_unwritable() {
        // Refuse both a regular file and a path beneath it as upload directories.
        let dir = tempfile::tempdir().unwrap();
        let as_file = dir.path().join("file");
        std::fs::write(&as_file, b"x").unwrap();
        let error = terminal_upload(&as_file, "x.txt", b"data").unwrap_err();
        assert!(
            error.to_string().contains("destination is not a directory"),
            "{error}"
        );
        let under_file = as_file.join("sub");
        let error = terminal_upload(&under_file, "x.txt", b"data").unwrap_err();
        #[cfg(unix)]
        assert!(
            matches!(&error, chan_workspace::ChanError::Io(message)
                if message.to_ascii_lowercase().contains("not a directory")),
            "{error:?}"
        );
        #[cfg(not(unix))]
        assert!(
            matches!(error, chan_workspace::ChanError::NotFound(_)),
            "{error:?}"
        );
        assert_eq!(std::fs::read(&as_file).unwrap(), b"x");
    }

    #[test]
    fn stalled_terminal_upload_aborts_without_a_sender() {
        let dir = tempfile::tempdir().unwrap();
        let target_dir = dir.path().to_path_buf();
        let (tx, rx) = mpsc::channel(1);
        tx.try_send(RequestBodyMessage::Chunk(Bytes::from_static(b"partial")))
            .unwrap();
        let cancel = crate::bulk_transfer::test_support::with_stall_timeout(
            std::time::Duration::from_millis(25),
        );
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let result = terminal_upload_stream_sync(&target_dir, "stalled.bin", rx, 8192, &cancel);
            let _ = done_tx.send(result);
        });
        let result = done_rx.recv_timeout(std::time::Duration::from_secs(1));
        drop(tx);
        let error = result
            .expect("upload kept waiting for a stalled client")
            .unwrap_err();
        thread.join().unwrap();
        assert!(error.to_string().contains("stalled"), "{error}");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn stalled_terminal_upload_returns_without_more_body_bytes() {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            let dir = tempfile::tempdir().unwrap();
            let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
            let bulk = bulk.with_stall_timeout(std::time::Duration::from_millis(25));
            let mut multipart = crate::bulk_transfer::test_support::stalled_multipart().await;
            let field = multipart.next_field().await.unwrap().unwrap();
            let response = tokio::time::timeout(
                std::time::Duration::from_secs(1),
                stream_terminal_upload(
                    &bulk,
                    None,
                    None,
                    dir.path().to_path_buf(),
                    "stalled.bin".into(),
                    8192,
                    field,
                ),
            )
            .await
            .expect("upload response waited for more client bytes");
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        })
        .await
        .unwrap();
    }

    #[test]
    fn terminal_stream_upload_overflow_removes_temp_and_target() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel(8);
        tx.blocking_send(RequestBodyMessage::Chunk(Bytes::from_static(b"12345")))
            .unwrap();
        tx.blocking_send(RequestBodyMessage::Chunk(Bytes::from_static(b"67890")))
            .unwrap();
        tx.blocking_send(RequestBodyMessage::Complete).unwrap();
        drop(tx);

        let error = terminal_upload_stream_sync(
            dir.path(),
            "large.bin",
            rx,
            8,
            &crate::bulk_transfer::test_support::uncancelled(),
        )
        .unwrap_err();

        assert!(matches!(
            error,
            chan_workspace::ChanError::WriteTooLarge { .. }
        ));
        assert!(!dir.path().join("large.bin").exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn terminal_stream_upload_disconnect_removes_temp_and_target() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel(8);
        tx.blocking_send(RequestBodyMessage::Chunk(Bytes::from_static(b"partial")))
            .unwrap();
        drop(tx);

        let error = terminal_upload_stream_sync(
            dir.path(),
            "cancelled.bin",
            rx,
            1024,
            &crate::bulk_transfer::test_support::uncancelled(),
        )
        .unwrap_err();

        assert!(error.to_string().contains("before completion"));
        assert!(!dir.path().join("cancelled.bin").exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    /// The 500 for a sender that goes away mid-body names the request body in
    /// the words every upload lane uses for that failure, and the temp file
    /// is gone with the target untouched.
    #[tokio::test]
    async fn terminal_upload_reports_a_dropped_sender_as_the_body_ending_early() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel(8);
        tx.try_send(RequestBodyMessage::Chunk(Bytes::from_static(b"partial")))
            .unwrap();
        drop(tx);

        let target_dir = dir.path().to_path_buf();
        let cancel = crate::bulk_transfer::test_support::uncancelled();
        let error = tokio::task::spawn_blocking(move || {
            terminal_upload_stream_sync(&target_dir, "dropped.bin", rx, 1024, &cancel)
        })
        .await
        .unwrap()
        .unwrap_err();
        let response = err_from(&error);

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            error_body(response).await,
            "io error: request body ended before completion"
        );
        assert!(!dir.path().join("dropped.bin").exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn verify_readable_fs_rejects_an_unreadable_file_before_tarring() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, b"x").unwrap();
        std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root bypasses permission bits; only assert when the chmod truly denies
        // (skip under a root test runner).
        if std::fs::File::open(&secret).is_ok() {
            return;
        }
        let e = verify_readable_fs(dir.path()).unwrap_err();
        assert!(e.contains("secret.txt"), "error should name the file: {e}");
    }

    #[test]
    fn terminal_single_file_download_plan_never_owns_a_whole_file_vec() {
        let source = include_str!("transfer.rs");
        let owned_file_pattern = concat!("File { bytes: ", "Vec<u8>, name: String }");
        let collecting_read_pattern = concat!("std::fs::", "read(abs)");
        assert!(
            !source.contains(owned_file_pattern),
            "terminal downloads must carry a bounded reader, not a whole-file Vec"
        );
        assert!(
            !source.contains(collecting_read_pattern),
            "terminal downloads must never collect the absolute file before responding"
        );
    }

    #[test]
    fn terminal_download_plan_streams_a_file_and_marks_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let content = vec![0x5a; chan_workspace::BINARY_STREAM_CHUNK_SIZE.saturating_mul(2) + 17];
        std::fs::write(dir.path().join("one.txt"), &content).unwrap();

        match terminal_download_plan(&dir.path().join("one.txt"), u64::MAX).unwrap() {
            TerminalDownload::File { mut reader, name } => {
                let chunks: std::io::Result<Vec<Vec<u8>>> = reader.by_ref().collect();
                let chunks = chunks.unwrap();
                assert_eq!(
                    chunks.iter().map(Vec::len).collect::<Vec<_>>(),
                    [
                        chan_workspace::BINARY_STREAM_CHUNK_SIZE,
                        chan_workspace::BINARY_STREAM_CHUNK_SIZE,
                        17,
                    ]
                );
                assert_eq!(chunks.concat(), content);
                assert_eq!(name, "one.txt");
            }
            TerminalDownload::Archive { .. } => panic!("expected a file payload"),
        }
        // A directory pre-flights readable and is marked for streaming; the
        // stream builds a real tar via the same `append_dir_all` the download
        // job hands `build_tar_into`.
        match terminal_download_plan(dir.path(), u64::MAX).unwrap() {
            TerminalDownload::Archive { name, .. } => {
                let mut buf = Vec::new();
                {
                    let mut b = tar::Builder::new(&mut buf);
                    b.append_dir_all(&name, dir.path()).unwrap();
                    b.finish().unwrap();
                }
                assert!(!buf.is_empty());
            }
            TerminalDownload::File { .. } => panic!("expected a directory"),
        }
        let missing = match terminal_download_plan(&dir.path().join("missing"), u64::MAX) {
            Err(error) => error,
            Ok(_) => panic!("missing download must fail"),
        };
        assert!(
            missing.message.contains("cannot access"),
            "{}",
            missing.message
        );
        assert_eq!(
            missing.status,
            StatusCode::BAD_REQUEST,
            "an unreadable path is not a ceiling refusal"
        );
    }

    /// Dropping the response must release the lane slot, because the job handle
    /// rides in the body's state and nowhere else. A slot held for a client that
    /// is gone is indistinguishable from a busy lane, and the bound would drift
    /// down one admission per abandoned download.
    ///
    /// Both sides are asserted rather than only the release: the lane refuses
    /// while the download holds its slot, and admits again once the response is
    /// dropped. Checking only the second would pass against a lane that never
    /// filled.
    #[tokio::test]
    async fn dropping_a_download_response_releases_its_lane_slot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("disconnect.bin");
        // Large enough that the job is still streaming, not finished, when the
        // response drops. A file that drained in one send would release its
        // slot on its own and prove nothing about the drop.
        std::fs::write(
            &path,
            vec![0x44; chan_workspace::BINARY_STREAM_CHUNK_SIZE * 16],
        )
        .unwrap();

        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();

        // Hold ONE active slot, so the download takes the other and actually
        // runs. The lane is filled around the download rather than before it:
        // saturating first and then freeing a slot does not work, because
        // dropping a waiting job's release frees nothing (that closure never
        // runs, so it never observes its sender being gone) and a download
        // admitted behind a full queue would never reach a worker to hold a
        // slot at all.
        let (hold_release, hold_park) = std::sync::mpsc::channel::<()>();
        let _held_active = bulk
            .submit(move |_| {
                let _ = hold_park.recv();
            })
            .expect("an idle lane admits");

        let response =
            stream_planned_download_tracked(&bulk, None, None, path.clone(), u64::MAX).await;
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "the download must be admitted and running, not refused"
        );
        assert!(
            response.headers().get(header::CONTENT_LENGTH).is_none(),
            "the ceiling bounds this stream but is not its length, so the response promises none"
        );

        // Fill the rest of the lane behind the running download, so the refusal
        // below is caused by the download holding the second active slot.
        let mut fillers = Vec::new();
        let mut filler_releases = Vec::new();
        loop {
            let (release, park) = std::sync::mpsc::channel::<()>();
            match bulk.submit(move |_| {
                let _ = park.recv();
            }) {
                Ok(job) => {
                    filler_releases.push(release);
                    fillers.push(job);
                }
                Err(_) => break,
            }
        }
        assert!(
            bulk.submit(|_| {}).is_err(),
            "the lane must be full while the download holds its slot"
        );

        drop(response);

        // Awaited rather than asserted immediately. An active job's slot returns
        // once the running closure observes the cancellation flag, which is a
        // per-chunk cadence rather than an instant, so an immediate assertion
        // would be testing timing instead of release.
        let mut readmitted = false;
        for _ in 0..200 {
            if let Ok(job) = bulk.submit(|_| {}) {
                drop(job);
                readmitted = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            readmitted,
            "dropping the response must cancel the download and return its slot"
        );

        drop(filler_releases);
        drop(hold_release);
    }

    /// A refusal must cost the caller nothing: no slot, and no work done on the
    /// target before the refusal is returned. The path is not even opened,
    /// because `submit` refuses before the job that would open it exists.
    ///
    /// Both sides again: the lane admits the download when a slot is free and
    /// refuses it when none is, so the test distinguishes a real bound from a
    /// route that happens to be failing for some other reason.
    #[tokio::test]
    async fn a_download_refused_at_the_bound_reads_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("declined.bin");
        std::fs::write(&path, b"payload").unwrap();
        // Unreadable content would fail the PLAN, so if the refusal ever stopped
        // preceding the plan this test would fail with a 400 rather than a 503.
        let missing = dir.path().join("not-here.bin");

        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
        let (_releases, _held) = crate::bulk_transfer::test_support::saturate_admission(&bulk);

        let refused = stream_planned_download_tracked(&bulk, None, None, missing, u64::MAX).await;
        assert_eq!(
            refused.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "a full lane must refuse rather than plan"
        );
        assert_eq!(
            refused
                .headers()
                .get(header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok()),
            Some("1"),
            "a refusal must tell the caller when to come back"
        );
    }

    /// The effective ceiling on the download arm, from both sides, in the shape
    /// the upload arm already uses: exactly the ceiling is served, one byte past
    /// it is refused.
    ///
    /// The refused body is asserted, not just the status. A bare 413 tells the
    /// caller a number was exceeded without saying which number or by how much,
    /// and a refusal nobody can act on is the reason this test reads the message.
    #[tokio::test]
    async fn a_terminal_download_serves_the_exact_ceiling_and_refuses_one_byte_over() {
        const CAP: u64 = 4096;
        let dir = tempfile::tempdir().unwrap();
        let exact = dir.path().join("exact.bin");
        std::fs::write(&exact, vec![0x7e; CAP as usize]).unwrap();
        let over = dir.path().join("over.bin");
        std::fs::write(&over, vec![0x7e; CAP as usize + 1]).unwrap();

        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();

        let served = stream_planned_download_tracked(&bulk, None, None, exact, CAP).await;
        assert_eq!(
            served.status(),
            StatusCode::OK,
            "a download of exactly the effective ceiling must be served"
        );
        let body = axum::body::to_bytes(served.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            body.len() as u64,
            CAP,
            "the served download must carry the whole file, not a truncated prefix"
        );

        let refused = stream_planned_download_tracked(&bulk, None, None, over, CAP).await;
        assert_eq!(
            refused.status(),
            StatusCode::PAYLOAD_TOO_LARGE,
            "one byte past the effective ceiling must be refused"
        );
        let message = String::from_utf8(
            axum::body::to_bytes(refused.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(
            message.contains("4097") && message.contains("4096"),
            "the refusal must name the size and the ceiling it exceeded: {message}"
        );
    }

    /// The file arm keeps the sandbox CSP conditional on `is_active_content_path`
    /// and sets `x-content-type-options: nosniff` unconditionally on every
    /// attachment. HTML and SVG are sandboxed and never sniffed; a raster image
    /// and an ordinary binary carry nosniff but no CSP; HTML bytes under a
    /// non-active extension are not sandboxed but are still never sniffed.
    #[tokio::test]
    async fn a_terminal_file_download_sandboxes_only_active_content() {
        let dir = tempfile::tempdir().unwrap();
        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();

        for (name, content_type, content, sandboxed) in [
            (
                "page.html",
                "text/html; charset=utf-8",
                &b"<script>top.chan = 1</script>"[..],
                true,
            ),
            (
                "figure.svg",
                "image/svg+xml",
                &b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>1</script></svg>"[..],
                true,
            ),
            (
                "page.txt",
                "text/plain; charset=utf-8",
                &b"<script>top.chan = 1</script>"[..],
                false,
            ),
            ("photo.png", "image/png", &b"\x89PNG\r\n\x1a\n"[..], false),
            (
                "bundle.zip",
                "application/octet-stream",
                &b"PK\x03\x04"[..],
                false,
            ),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, content).unwrap();

            let response = stream_planned_download_tracked(&bulk, None, None, path, u64::MAX).await;
            assert_eq!(response.status(), StatusCode::OK, "{name}");
            let headers = response.headers().clone();
            let value = |header_name: &str| {
                headers
                    .get(header_name)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned)
            };
            assert_eq!(
                value("content-type").as_deref(),
                Some(content_type),
                "{name}"
            );
            assert_eq!(
                value("content-disposition"),
                Some(format!("attachment; filename=\"{name}\"")),
                "{name}"
            );
            assert_eq!(
                value("content-security-policy").as_deref(),
                sandboxed.then_some("sandbox"),
                "{name}: {headers:?}"
            );
            assert_eq!(
                value("x-content-type-options").as_deref(),
                Some("nosniff"),
                "{name}: {headers:?}"
            );
            let streamed = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            assert_eq!(streamed.as_ref(), content, "{name}");
        }
    }

    #[tokio::test]
    async fn a_terminal_archive_refuses_a_tree_known_over_the_ceiling() {
        const CAP: u64 = 2048;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("over.bin"), vec![0x7e; CAP as usize + 1]).unwrap();
        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();

        let response =
            stream_planned_download_tracked(&bulk, None, None, dir.path().to_path_buf(), CAP).await;

        assert_eq!(
            response.status(),
            StatusCode::PAYLOAD_TOO_LARGE,
            "a tree already known past the ceiling must be refused before streaming"
        );
        let message = String::from_utf8(
            axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(
            message.contains("4608") && message.contains("2048"),
            "the refusal must name the encoded archive size and its ceiling: {message}"
        );
    }

    #[tokio::test]
    async fn a_terminal_archive_over_the_ceiling_by_framing_is_refused_before_the_body() {
        const CAP: u64 = 2048;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("exact.bin"), vec![0x7e; CAP as usize]).unwrap();
        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();

        let response =
            stream_planned_download_tracked(&bulk, None, None, dir.path().to_path_buf(), CAP).await;
        assert_eq!(
            response.status(),
            StatusCode::PAYLOAD_TOO_LARGE,
            "tar framing over the ceiling must be refused before streaming"
        );
        let message = String::from_utf8(
            axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(
            message.contains("4096") && message.contains("2048"),
            "the refusal must name the encoded archive size and its ceiling: {message}"
        );
    }

    #[tokio::test]
    async fn a_terminal_archive_with_a_100_byte_root_is_refused_at_the_planned_ceiling() {
        const ARCHIVE_CEILING: u64 = 3072;
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("d".repeat(100));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("f"), b"").unwrap();
        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();

        let response =
            stream_planned_download_tracked(&bulk, None, None, root, ARCHIVE_CEILING).await;

        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn a_terminal_archive_body_uses_the_configured_ceiling_after_preflight() {
        use futures::StreamExt;

        const CAP: u64 = 2048;
        let root = tempfile::tempdir().unwrap();
        schedule_growth_after_download_preflight(root.path(), vec![0x5a; CAP as usize]);
        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();

        let response =
            stream_planned_download_tracked(&bulk, None, None, root.path().to_path_buf(), CAP)
                .await;
        assert_eq!(response.status(), StatusCode::OK);

        let mut stream = response.into_body().into_data_stream();
        let mut delivered = 0usize;
        let mut body_error = None;
        while let Some(chunk) =
            tokio::time::timeout(std::time::Duration::from_secs(5), stream.next())
                .await
                .unwrap()
        {
            match chunk {
                Ok(bytes) => delivered += bytes.len(),
                Err(error) => {
                    body_error = Some(error.to_string());
                    break;
                }
            }
        }

        assert_eq!(delivered, CAP as usize);
        assert!(
            body_error
                .as_deref()
                .is_some_and(|message| message.contains("2048 byte transfer ceiling")),
            "the route must report its configured ceiling: {body_error:?}"
        );
    }

    /// The bound has to survive a file that grows after the plan measured it,
    /// or appending to a file is enough to walk past the ceiling. Opening at the
    /// ceiling and extending before the first pull is exactly the case a
    /// plan-time size check cannot see.
    ///
    /// Both sides at the same seam: a file that stays at the ceiling streams to
    /// EOF, so the error above is attributable to the growth rather than to a
    /// reader that refuses its last chunk.
    #[test]
    fn the_download_reader_stops_when_a_growing_file_passes_the_ceiling() {
        const CAP: u64 = 8;
        let dir = tempfile::tempdir().unwrap();

        let steady = dir.path().join("steady.bin");
        std::fs::write(&steady, b"12345678").unwrap();
        let chunks: std::io::Result<Vec<Vec<u8>>> = AbsoluteFileReader::open(&steady, CAP)
            .unwrap()
            .by_ref()
            .collect();
        assert_eq!(
            chunks.expect("a file at the ceiling must stream").concat(),
            b"12345678",
            "a file that stays at the ceiling must stream to EOF"
        );

        let growing = dir.path().join("growing.bin");
        std::fs::write(&growing, b"12345678").unwrap();
        let mut reader = AbsoluteFileReader::open(&growing, CAP).unwrap();
        std::fs::write(&growing, b"12345678and then some more").unwrap();

        let error = loop {
            match reader.next() {
                Some(Ok(_)) => continue,
                Some(Err(error)) => break error,
                None => panic!("a file grown past the ceiling must not stream to EOF"),
            }
        };
        assert!(
            error.to_string().contains("ceiling"),
            "the reader must name the bound it stopped at: {error}"
        );
    }

    /// Laziness is the property the lane depends on: no byte may be read before
    /// the consumer pulls, so the thread that pulls is the thread that reads.
    #[test]
    fn terminal_reader_reads_nothing_before_the_first_pull() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lazy.bin");
        std::fs::write(&path, vec![0x7a; chan_workspace::BINARY_STREAM_CHUNK_SIZE]).unwrap();

        let mut reader = AbsoluteFileReader::open(&path, u64::MAX).unwrap();
        // Replacing the contents after open but before the first pull is
        // visible only to a reader that had not already buffered them.
        std::fs::write(&path, vec![0x5b; chan_workspace::BINARY_STREAM_CHUNK_SIZE]).unwrap();

        let first = reader.next().expect("a chunk is available").unwrap();
        // `all` is true on an empty slice, so the emptiness check is what stops
        // this passing without having read anything.
        assert!(!first.is_empty());
        assert!(
            first.iter().all(|byte| *byte == 0x5b),
            "the reader buffered before its first pull"
        );
    }

    #[test]
    fn tar_channel_writer_signals_broken_pipe_when_the_receiver_is_gone() {
        // A cancelled download drops the body receiver; the next tar write must
        // fail so the build stops (nothing staged on disk = no trace).
        let (tx, rx) = mpsc::channel::<std::io::Result<Bytes>>(1);
        drop(rx);
        let mut writer = TarChannelWriter {
            tx,
            cancel: crate::bulk_transfer::test_support::uncancelled(),
            limit: u64::MAX,
            written: 0,
        };
        let e = writer.write(b"data").unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::BrokenPipe);
    }

    #[test]
    fn stalled_tar_writer_aborts_without_a_reader() {
        let (tx, rx) = mpsc::channel(1);
        tx.try_send(Ok(Bytes::from_static(b"full"))).unwrap();
        let cancel = crate::bulk_transfer::test_support::with_stall_timeout(
            std::time::Duration::from_millis(25),
        );
        let observed = cancel.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let mut writer = TarChannelWriter {
                tx,
                cancel,
                limit: u64::MAX,
                written: 0,
            };
            let _ = done_tx.send(writer.write(b"blocked"));
        });
        let result = done_rx.recv_timeout(std::time::Duration::from_secs(1));
        drop(rx);
        let error = result
            .expect("tar writer stayed blocked on a full channel")
            .unwrap_err();
        thread.join().unwrap();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(observed.is_cancelled());
    }

    #[test]
    fn stalled_file_send_aborts_without_a_reader() {
        let (tx, rx) = mpsc::channel::<std::io::Result<Bytes>>(1);
        tx.try_send(Ok(Bytes::from_static(b"full"))).unwrap();
        let cancel = crate::bulk_transfer::test_support::with_stall_timeout(
            std::time::Duration::from_millis(25),
        );
        let observed = cancel.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let _ = done_tx.send(cancel.send(&tx, Ok(Bytes::from_static(b"blocked"))));
        });
        let result = done_rx.recv_timeout(std::time::Duration::from_secs(1));
        drop(rx);
        let error = result
            .expect("file send stayed blocked on a full channel")
            .unwrap_err();
        thread.join().unwrap();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(observed.is_cancelled());
    }

    #[tokio::test]
    async fn stalled_terminal_download_releases_its_slot_and_errors() {
        for archive in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("large.bin");
            std::fs::write(
                &path,
                vec![0x44; chan_workspace::BINARY_STREAM_CHUNK_SIZE * 16],
            )
            .unwrap();
            let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
            let bulk = bulk.with_stall_timeout(std::time::Duration::from_millis(250));
            let response = tokio::time::timeout(
                std::time::Duration::from_secs(3),
                stream_planned_download_tracked(
                    &bulk,
                    None,
                    None,
                    if archive {
                        dir.path().to_path_buf()
                    } else {
                        path
                    },
                    u64::MAX,
                ),
            )
            .await
            .unwrap();
            crate::bulk_transfer::test_support::assert_stalled_download_releases_slot(
                &bulk, response,
            )
            .await;
        }
    }

    #[test]
    fn tar_channel_writer_stops_on_cancellation_before_touching_the_channel() {
        // Cancellation must stop the build even when the reader is still
        // draining, which is what makes a shutdown prompt rather than
        // dependent on the next chunk filling the channel.
        let (tx, mut rx) = mpsc::channel::<std::io::Result<Bytes>>(1);
        let cancel = crate::bulk_transfer::test_support::cancelled();
        let mut writer = TarChannelWriter {
            tx,
            cancel,
            limit: u64::MAX,
            written: 0,
        };
        let e = writer.write(b"data").unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::BrokenPipe);
        assert!(
            rx.try_recv().is_err(),
            "a cancelled write must not enqueue archive bytes"
        );
    }

    /// The archive arm's refusal, which costs more than the file arm's because
    /// the work it declines is a whole-tree pre-flight rather than one open.
    ///
    /// The tree holds an unreadable file, so the pre-flight cannot succeed: a
    /// refusal that stopped preceding the plan would surface as a 400 naming
    /// that file instead of a 503, which is what makes the assertion about the
    /// refusal's position rather than merely about its status.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_archive_refused_at_the_bound_walks_nothing() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, b"a").unwrap();
        std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root bypasses permission bits, which would leave the pre-flight able
        // to succeed and the test unable to discriminate.
        if std::fs::File::open(&secret).is_ok() {
            return;
        }

        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
        let (releases, _held) = crate::bulk_transfer::test_support::saturate_admission(&bulk);

        let refused =
            stream_planned_download_tracked(&bulk, None, None, dir.path().to_path_buf(), u64::MAX)
                .await;

        assert_eq!(
            refused.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "a full lane must refuse before walking the tree it declined to archive"
        );
        assert_eq!(
            refused
                .headers()
                .get(header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok()),
            Some("1")
        );

        drop(releases);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn terminal_dangling_symlinks_download_as_links() {
        check_symlink_archive(false).await;
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn terminal_oversized_symlink_targets_download_as_links() {
        check_symlink_archive(true).await;
    }

    #[cfg(unix)]
    async fn check_symlink_archive(oversized: bool) {
        const CAP: u64 = 4096;
        let root = tempfile::tempdir().unwrap();
        let tree = root.path().join("tree");
        std::fs::create_dir(&tree).unwrap();
        std::fs::write(tree.join("ordinary.txt"), b"hello").unwrap();
        let target = if oversized {
            let target = root.path().join("large.bin");
            std::fs::write(&target, vec![b'x'; CAP as usize * 2]).unwrap();
            target
        } else {
            root.path().join("missing")
        };
        std::os::unix::fs::symlink(&target, tree.join("link")).unwrap();
        let planned = verify_readable_fs(&tree).unwrap();
        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
        let response = stream_planned_download_tracked(&bulk, None, None, tree, CAP).await;
        assert_eq!(response.status(), StatusCode::OK);
        use futures::StreamExt;
        let mut stream = response.into_body().into_data_stream();
        let mut bytes = Vec::new();
        let mut failure = None;
        while let Some(chunk) =
            tokio::time::timeout(std::time::Duration::from_secs(5), stream.next())
                .await
                .unwrap()
        {
            match chunk {
                Ok(chunk) => bytes.extend_from_slice(&chunk),
                Err(error) => {
                    failure = Some(error.to_string());
                    break;
                }
            }
        }
        eprintln!(
            "oversized={oversized}, status=200, streamed={}, body_error={failure:?}",
            bytes.len()
        );
        assert!(failure.is_none(), "archive must complete");
        assert_eq!(planned, bytes.len() as u64);
        assert!(bytes.len() as u64 <= CAP);
        let mut archive = tar::Archive::new(bytes.as_slice());
        let mut found = false;
        let mut payload = 0;
        for entry in archive.entries().unwrap() {
            let entry = entry.unwrap();
            payload += entry.size();
            if entry.path().unwrap().as_ref() == Path::new("tree/link") {
                assert!(entry.header().entry_type().is_symlink());
                assert_eq!(entry.link_name().unwrap().unwrap().as_ref(), target);
                assert_eq!(entry.size(), 0);
                found = true;
            }
        }
        assert!(found);
        assert_eq!(payload, 5);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_top_level_symlinks_download_as_links() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("directory");
        std::fs::create_dir(&directory).unwrap();
        let large = directory.join("large.bin");
        std::fs::write(&large, vec![0; 8192]).unwrap();
        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
        for (name, target) in [
            ("dangling", root.path().join("missing")),
            ("file", large),
            ("dir", directory),
        ] {
            let link = root.path().join(name);
            std::os::unix::fs::symlink(&target, &link).unwrap();
            let planned = verify_readable_fs(&link).unwrap();
            let response = stream_planned_download_tracked(&bulk, None, None, link, 4096).await;
            assert_eq!(response.status(), StatusCode::OK, "top-level {name}");
            assert_eq!(
                response.headers()[header::CONTENT_TYPE],
                "application/x-tar"
            );
            let bytes = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
            assert_eq!(planned, bytes.len() as u64);
            let mut archive = tar::Archive::new(bytes.as_ref());
            let entries: Vec<_> = archive.entries().unwrap().map(Result::unwrap).collect();
            assert_eq!(entries.len(), 1);
            assert!(entries[0].header().entry_type().is_symlink());
            assert_eq!(entries[0].link_name().unwrap().unwrap().as_ref(), target);
        }
    }

    /// A terminal directory download declares a tar, streams it on the fly and
    /// is an attachment, so it carries `x-content-type-options: nosniff`. It
    /// carries no sandbox CSP, because the archive arm always declares
    /// `application/x-tar` whatever its root is named. The root here is named
    /// with an active-content extension, so the absent CSP is the archive arm's
    /// doing and not the predicate's. The name is asserted as a suffix because
    /// `download_filename` splits on `/` only, so a Windows absolute path keeps
    /// its separators as `_`.
    #[tokio::test]
    async fn a_terminal_directory_download_streams_a_valid_tar_on_the_fly() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("tree.html");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), b"a").unwrap();
        std::fs::write(dir.join("b.txt"), b"b").unwrap();

        let bulk = crate::state::test_support::make_test_bulk_transfer_tenant();
        let resp = stream_planned_download_tracked(&bulk, None, None, dir, u64::MAX).await;

        let headers = resp.headers().clone();
        assert_eq!(
            headers
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("application/x-tar"),
            "a directory download declares itself an archive"
        );
        let disposition = headers
            .get(header::CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(
            disposition.starts_with("attachment; filename=\"")
                && disposition.ends_with("tree.html.tar\""),
            "a directory download is an attachment: {disposition:?}"
        );
        assert_eq!(
            headers
                .get("x-content-type-options")
                .and_then(|v| v.to_str().ok()),
            Some("nosniff"),
            "{headers:?}"
        );
        assert!(
            headers.get(header::CONTENT_SECURITY_POLICY).is_none(),
            "the archive arm takes no sandbox CSP: {headers:?}"
        );
        let bytes = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            axum::body::to_bytes(resp.into_body(), usize::MAX),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!bytes.is_empty());
        let mut archive = tar::Archive::new(std::io::Cursor::new(&bytes[..]));
        let names: Vec<String> = archive
            .entries()
            .unwrap()
            .map(|e| e.unwrap().path().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(
            names.iter().any(|n| n.contains("a.txt")),
            "streamed tar should contain the entries: {names:?}"
        );
    }
}
