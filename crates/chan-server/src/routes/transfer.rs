//! Workspace-less file transfer for standalone-terminal windows.
//!
//! A standalone terminal (`kind=terminal`) has no workspace, so `cs upload` /
//! `cs download` cannot anchor at a workspace root. Per the scope decision,
//! transfers resolve against the terminal session's working directory with the
//! reach of the shell's own uid -- there is no extra sandbox wall, since the
//! terminal already grants that filesystem access. The `cs` CLI absolutizes the
//! path against its cwd (the session cwd) before it reaches the control socket;
//! the control socket sends that absolute path with its leading `/` stripped so
//! the SPA's existing transfer bubble builds clean `/api/files/...` URLs. These
//! handlers -- mounted only on the terminal tenant -- re-root that path at `/` and
//! read or write it directly, so no SPA change is needed.
//!
//! Downloads pre-flight readability before building the tarball.
//! Terminal uploads rely on their atomic writer as the authoritative
//! writability check; workspace uploads use
//! `Workspace::ensure_writable`.
//!
//! The configured transfer ceiling governs both directions on this tenant.
//! Single-file reads and writes are bounded by it and refuse past it; a
//! directory archive is bounded by lane admission and concurrency only, because
//! its size is not known until it has been built.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use axum::body::{Body, Bytes};
use axum::extract::{multipart::Field, Multipart, Path as AxumPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::stream;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::bulk_transfer::{BulkCancel, BulkOutcome, BulkTransferTenant};
use crate::error::{err, err_from};
use crate::routes::files::{
    content_disposition_archive, content_disposition_attachment, download_filename, query_flag,
    read_multipart_text_field, upload_leaf_filename,
};
use crate::static_assets::content_type_for;

/// Re-root a terminal-tenant `{*path}` (the control socket strips the leading
/// `/` before sending it) at the filesystem root. A standalone-terminal
/// transfer is uid-scoped, not workspace-scoped, so the path is always
/// absolute.
fn abs_from_terminal_path(path: &str) -> PathBuf {
    PathBuf::from("/").join(path.trim_start_matches('/'))
}

/// Pre-flight for download: every file under `abs` is openable for read and
/// every directory is listable. Fails fast on the first inaccessible entry so a
/// download never starts a tarball it cannot finish. The workspace path uses a
/// sibling guard in `files.rs` that walks via `Workspace::list` to match the
/// workspace tarball's `.chan`/`.git` filtering.
pub(crate) fn verify_readable_fs(abs: &Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(abs)
        .map_err(|e| format!("cannot access {}: {e}", abs.display()))?;
    if meta.file_type().is_symlink() {
        // The archive stores the link itself; don't follow it (and don't fault
        // on a dangling target).
        return Ok(());
    }
    if meta.is_dir() {
        let entries = std::fs::read_dir(abs)
            .map_err(|e| format!("cannot read directory {}: {e}", abs.display()))?;
        for entry in entries {
            let entry =
                entry.map_err(|e| format!("cannot read directory {}: {e}", abs.display()))?;
            verify_readable_fs(&entry.path())?;
        }
        Ok(())
    } else {
        std::fs::File::open(abs)
            .map(|_| ())
            .map_err(|e| format!("cannot read {}: {e}", abs.display()))
    }
}

/// A `std::io::Write` that forwards each tar chunk to a streaming HTTP body
/// over an mpsc channel. `blocking_send` provides backpressure (it blocks until
/// the response reader drains) and is also the cancel signal: once the client
/// disconnects the receiver drops, the send fails, and the tar build stops --
/// nothing is staged on disk, so a cancelled download leaves no trace.
pub(crate) struct TarChannelWriter {
    tx: mpsc::Sender<std::io::Result<Bytes>>,
    cancel: BulkCancel,
}

impl Write for TarChannelWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
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
        self.tx
            .blocking_send(Ok(Bytes::copy_from_slice(buf)))
            .map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::BrokenPipe, "client disconnected")
            })?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
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
/// look like ordinary reuse while doing it.
pub(crate) fn build_tar_into<F>(
    tx: &mpsc::Sender<std::io::Result<Bytes>>,
    cancel: &BulkCancel,
    build: F,
) where
    F: FnOnce(&mut tar::Builder<TarChannelWriter>) -> std::io::Result<()> + Send + 'static,
{
    let mut builder = tar::Builder::new(TarChannelWriter {
        tx: tx.clone(),
        cancel: cancel.clone(),
    });
    let result = build(&mut builder).and_then(|()| builder.finish());
    if let Err(e) = result {
        if e.kind() != std::io::ErrorKind::BrokenPipe {
            let _ = tx.blocking_send(Err(e));
        }
    }
}

#[derive(Default, Deserialize)]
pub(crate) struct TerminalDownloadQuery {
    #[serde(default)]
    download: Option<String>,
}

/// What the plan resolved to, reported before the first byte so the response
/// headers can be chosen while the same job goes on to stream the body.
enum PlannedDownload {
    File { name: String },
    Directory { name: String },
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
/// job's own: it costs one open and no streamed byte, because the size it
/// refuses against is only knowable from a handle. Every early return past that
/// point drops the job, which cancels it and releases its slot.
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
                // A cancellation is forwarded rather than ending the stream.
                // Cancel does not mean the client is gone: `BulkTransferLane`'s
                // Drop cancels every active job at process shutdown, and a
                // client mid-download then is still connected and draining.
                // This response declares no length, so there is no promise to
                // fall short of, but a clean end is indistinguishable from a
                // complete transfer and hands the client a truncated file it
                // believes is whole. Forwarding is never worse: with the client
                // gone the send fails on the dropped receiver and nothing
                // happens, exactly as a silent return would.
                for next in reader.by_ref() {
                    if cancel.is_cancelled() {
                        let _ = tx.blocking_send(Err(std::io::Error::other(
                            "transfer cancelled before the file was fully streamed",
                        )));
                        return;
                    }
                    let terminal = next.is_err();
                    if tx.blocking_send(next.map(Bytes::from)).is_err() || terminal {
                        return;
                    }
                }
            }
            TerminalDownload::Directory { name } => {
                let build_name = name.clone();
                let build_abs = abs.clone();
                if plan_tx
                    .send(Ok(PlannedDownload::Directory { name }))
                    .is_err()
                {
                    return;
                }
                // Builds into this job's channel rather than through
                // `stream_tar_response_tracked`, which would submit again.
                build_tar_into(&tx, cancel, move |builder| {
                    builder.append_dir_all(&build_name, &build_abs)
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
        PlannedDownload::Directory { name } => (
            "application/x-tar".to_string(),
            content_disposition_archive(name),
        ),
    };
    let body = Body::from_stream(stream::unfold(
        (rx, job, alive_tx),
        |(mut rx, job, alive_tx)| async move {
            rx.recv()
                .await
                .map(|message| (message, (rx, job, alive_tx)))
        },
    ));
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CONTENT_DISPOSITION, disposition),
        ],
        body,
    )
        .into_response()
}

/// `GET /api/files/{*path}?download=1` on the terminal tenant: stream the cwd /
/// uid-scoped file or a tar of the directory. Mounted only on the slim terminal
/// router, so `{*path}` is always a filesystem-absolute target (see
/// [`abs_from_terminal_path`]).
pub async fn api_terminal_read_file(
    State(state): State<std::sync::Arc<crate::state::AppState>>,
    AxumPath(path): AxumPath<String>,
    Query(query): Query<TerminalDownloadQuery>,
    headers: axum::http::HeaderMap,
) -> Response {
    // The slim terminal tenant fetches no file content inline (no editor, no
    // file browser); the only legitimate GET here is the download gesture, so a
    // bare read is refused rather than serving arbitrary bytes.
    if !query_flag(&query.download) {
        return err(
            StatusCode::BAD_REQUEST,
            "terminal file route requires ?download=1".into(),
        );
    }
    stream_planned_download_tracked(
        &state.bulk_transfer,
        Some(state.events_tx.clone()),
        TransferTracking::from_headers(&headers),
        abs_from_terminal_path(&path),
        state.library.transfer_max_bytes(),
    )
    .await
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
/// readable and is ready to stream.
enum TerminalDownload {
    File {
        reader: AbsoluteFileReader,
        name: String,
    },
    Directory {
        name: String,
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
    let meta = std::fs::metadata(abs).map_err(|e| {
        DownloadRefusal::unreadable(format!("cannot access {}: {e}", abs.display()))
    })?;
    let name = download_filename(&abs.to_string_lossy());
    if meta.is_dir() {
        // Pre-flight the whole tree before streaming so an unreadable entry
        // fails fast with a clear status instead of truncating a streamed
        // archive mid-flight.
        //
        // No ceiling refusal on this arm: an archive has no size until it has
        // been built, so bounding it is cumulative accounting during the build
        // rather than a check the plan can make.
        verify_readable_fs(abs).map_err(DownloadRefusal::unreadable)?;
        Ok(TerminalDownload::Directory { name })
    } else {
        // Opening happens before headers are sent. The returned reader keeps
        // the exact file handle and bounded producer alive.
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

/// `POST /api/files/upload` on the terminal tenant: write the uploaded file into
/// the cwd / uid-scoped `dir`. No replace (`path`) flow -- the slim tenant has no
/// file browser. Mounted only on the terminal router, so `dir` is absolute.
pub async fn api_terminal_upload_file(
    State(state): State<std::sync::Arc<crate::state::AppState>>,
    headers: axum::http::HeaderMap,
    mut multipart: Multipart,
) -> Response {
    let mut dir = String::new();
    let mut dir_seen = false;
    loop {
        match multipart.next_field().await {
            Ok(Some(field)) => {
                let name = field.name().unwrap_or("").to_owned();
                match name.as_str() {
                    "file" => {
                        if !dir_seen {
                            return err(
                                StatusCode::BAD_REQUEST,
                                "`dir` must precede the streaming `file` part".into(),
                            );
                        }
                        let filename = field.file_name().unwrap_or("").to_owned();
                        let abs_dir = abs_from_terminal_path(&dir);
                        return stream_terminal_upload(
                            &state.bulk_transfer,
                            Some(state.events_tx.clone()),
                            TransferTracking::from_headers(&headers),
                            abs_dir,
                            filename,
                            state.library.transfer_max_bytes(),
                            field,
                        )
                        .await;
                    }
                    "dir" => match read_multipart_text_field(field).await {
                        Ok(s) => {
                            dir = s;
                            dir_seen = true;
                        }
                        Err(e) => {
                            return err(StatusCode::BAD_REQUEST, format!("multipart read: {e}"))
                        }
                    },
                    _ => {}
                }
            }
            Ok(None) => break,
            Err(e) => return err(StatusCode::BAD_REQUEST, format!("multipart parse: {e}")),
        }
    }

    err(
        StatusCode::BAD_REQUEST,
        "missing `file` part in multipart body".into(),
    )
}

enum TerminalUploadMessage {
    Chunk(Bytes),
    Complete,
    Failed(String),
}

/// Admit one terminal upload and write it inside a SINGLE lane job.
///
/// The job is the writer. It is admitted before the first body byte is pulled,
/// so a refusal has read nothing, opened nothing, and left no temp file, and
/// the disk work runs on the transfer lane rather than the pool that serves
/// editor saves and terminal spawns. The async half only moves the multipart
/// field into the job's bounded channel; that channel is also the backpressure,
/// so a queued upload stalls its sender instead of buffering the body.
///
/// Returning early drops the job, which cancels it and releases its slot.
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
    mut field: Field<'_>,
) -> Response {
    let (tx, rx) = mpsc::channel(8);
    let job = match bulk
        .submit(move |cancel| terminal_upload_stream_sync(&abs_dir, &filename, rx, limit, cancel))
    {
        Ok(job) => job,
        Err(full) => return full.into_response(),
    };
    let (_alive_tx, alive_rx) = tokio::sync::oneshot::channel::<std::convert::Infallible>();
    if let (Some(events), Some(tracking)) = (events, tracking) {
        crate::routes::ws::spawn_transfer_queue_reporter(
            events,
            tracking.window_id,
            tracking.transfer_id,
            job.tracker(),
            alive_rx,
        );
    }
    loop {
        let message = match field.chunk().await {
            Ok(Some(bytes)) => TerminalUploadMessage::Chunk(bytes),
            Ok(None) => TerminalUploadMessage::Complete,
            Err(error) => TerminalUploadMessage::Failed(error.to_string()),
        };
        let terminal = !matches!(message, TerminalUploadMessage::Chunk(_));
        if tx.send(message).await.is_err() || terminal {
            break;
        }
    }
    drop(tx);
    match job.outcome().await {
        BulkOutcome::Done(Ok(response)) => Json(response).into_response(),
        BulkOutcome::Done(Err(error)) => err_from(&error),
        // Cancellation, lane shutdown, and a panicked job are reported
        // identically and cannot be told apart here. All three mean the write
        // did not complete and nothing was persisted, so the caller is told to
        // retry rather than given a result that never existed.
        BulkOutcome::Cancelled => err(
            StatusCode::SERVICE_UNAVAILABLE,
            "upload did not complete".into(),
        ),
    }
}

fn terminal_upload_stream_sync(
    abs_dir: &Path,
    original_name: &str,
    mut rx: mpsc::Receiver<TerminalUploadMessage>,
    limit: u64,
    cancel: &BulkCancel,
) -> chan_workspace::Result<TerminalUploadResponse> {
    let metadata = std::fs::metadata(abs_dir)
        .map_err(|error| chan_workspace::ChanError::Io(error.to_string()))?;
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
    let mut temp = tempfile::NamedTempFile::new_in(abs_dir)
        .map_err(|error| chan_workspace::ChanError::Io(error.to_string()))?;
    let mut written = 0u64;
    loop {
        match rx.blocking_recv() {
            Some(TerminalUploadMessage::Chunk(bytes)) => {
                // Checked per chunk rather than once at the start: an abandoned
                // upload must return its admission slot within one chunk's work
                // instead of holding it for a transfer nobody is waiting on. The
                // temp file is dropped unpersisted, so nothing is left behind.
                if cancel.is_cancelled() {
                    return Err(chan_workspace::ChanError::Io(
                        "upload cancelled before it completed".into(),
                    ));
                }
                let attempted =
                    written.saturating_add(u64::try_from(bytes.len()).unwrap_or(u64::MAX));
                if attempted > limit {
                    return Err(chan_workspace::ChanError::WriteTooLarge {
                        kind: "bytes",
                        size: attempted,
                        limit,
                    });
                }
                temp.write_all(&bytes)
                    .map_err(|error| chan_workspace::ChanError::Io(error.to_string()))?;
                written = attempted;
            }
            Some(TerminalUploadMessage::Complete) => break,
            Some(TerminalUploadMessage::Failed(error)) => {
                return Err(chan_workspace::ChanError::Io(format!(
                    "multipart read failed: {error}"
                )));
            }
            None => {
                return Err(chan_workspace::ChanError::Io(
                    "multipart body ended before completion".into(),
                ));
            }
        }
    }
    temp.as_file()
        .sync_all()
        .map_err(|error| chan_workspace::ChanError::Io(format!("fsync tmp: {error}")))?;
    temp.persist_noclobber(&target)
        .map_err(|error| chan_workspace::ChanError::Io(error.error.to_string()))?;
    std::fs::File::open(abs_dir)
        .and_then(|dir| dir.sync_all())
        .map_err(|error| chan_workspace::ChanError::Io(format!("fsync dir: {error}")))?;
    Ok(TerminalUploadResponse {
        path: target.display().to_string(),
        size: written,
    })
}

#[cfg(test)]
fn terminal_upload_sync(
    abs_dir: &Path,
    original_name: &str,
    bytes: &[u8],
) -> Result<TerminalUploadResponse, String> {
    let leaf = upload_leaf_filename(original_name).map_err(|e| e.to_string())?;
    let target = abs_dir.join(&leaf);
    if target.exists() {
        return Err(format!("already exists: {}", target.display()));
    }
    // `atomic_write` writes a temp file and renames, so a failure leaves no
    // partial file at `target`.
    chan_workspace::fs_ops::atomic_write(&target, bytes)
        .map_err(|e| format!("cannot write {}: {e}", target.display()))?;
    Ok(TerminalUploadResponse {
        path: target.display().to_string(),
        size: bytes.len() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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

        tx.send(TerminalUploadMessage::Chunk(Bytes::from_static(b"first")))
            .await
            .unwrap();
        tx.send(TerminalUploadMessage::Chunk(Bytes::from_static(b"second")))
            .await
            .unwrap();

        job.cancel();

        // Sent after the flag, so the writer cannot reach `Complete` without
        // having read a chunk with cancellation already visible to it.
        for _ in 0..4 {
            let _ = tx
                .send(TerminalUploadMessage::Chunk(Bytes::from_static(b"more")))
                .await;
        }
        let _ = tx.send(TerminalUploadMessage::Complete).await;
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

        tx.send(TerminalUploadMessage::Chunk(Bytes::from_static(b"first")))
            .await
            .unwrap();
        // Capacity 1, so this returns only once the writer has taken the first
        // chunk: the flag below is therefore set strictly after the writer
        // entered its loop, which a check placed before the loop would already
        // have passed.
        tx.send(TerminalUploadMessage::Chunk(Bytes::from_static(b"second")))
            .await
            .unwrap();

        flag.store(true, std::sync::atomic::Ordering::SeqCst);

        for _ in 0..4 {
            let _ = tx
                .send(TerminalUploadMessage::Chunk(Bytes::from_static(b"more")))
                .await;
        }
        let _ = tx.send(TerminalUploadMessage::Complete).await;
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
    fn terminal_upload_writes_into_dir_and_refuses_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        let resp = terminal_upload_sync(dir.path(), "note.txt", b"hello").unwrap();
        assert_eq!(resp.size, 5);
        assert_eq!(
            std::fs::read(dir.path().join("note.txt")).unwrap(),
            b"hello"
        );
        // A second upload of the same name is refused (no silent overwrite).
        let again = terminal_upload_sync(dir.path(), "note.txt", b"world").unwrap_err();
        assert!(again.contains("already exists"), "{again}");
        assert_eq!(
            std::fs::read(dir.path().join("note.txt")).unwrap(),
            b"hello"
        );
    }

    #[test]
    fn terminal_upload_writes_nothing_when_destination_is_unwritable() {
        // A path whose parent is a file, not a directory: the dest cannot be a
        // writable directory, so the upload must fail before writing.
        let dir = tempfile::tempdir().unwrap();
        let as_file = dir.path().join("file");
        std::fs::write(&as_file, b"x").unwrap();
        let under_file = as_file.join("sub");
        let e = terminal_upload_sync(&under_file, "x.txt", b"data").unwrap_err();
        let lower = e.to_ascii_lowercase();
        assert!(
            lower.contains("cannot access destination") || lower.contains("not a directory"),
            "{e}"
        );
        assert_eq!(std::fs::read(&as_file).unwrap(), b"x");
    }

    #[test]
    fn terminal_stream_upload_overflow_removes_temp_and_target() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel(8);
        tx.blocking_send(TerminalUploadMessage::Chunk(Bytes::from_static(b"12345")))
            .unwrap();
        tx.blocking_send(TerminalUploadMessage::Chunk(Bytes::from_static(b"67890")))
            .unwrap();
        tx.blocking_send(TerminalUploadMessage::Complete).unwrap();
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
        tx.blocking_send(TerminalUploadMessage::Chunk(Bytes::from_static(b"partial")))
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
            TerminalDownload::Directory { .. } => panic!("expected a file payload"),
        }
        // A directory pre-flights readable and is marked for streaming; the
        // stream builds a real tar via the same `append_dir_all` the download
        // job hands `build_tar_into`.
        match terminal_download_plan(dir.path(), u64::MAX).unwrap() {
            TerminalDownload::Directory { name } => {
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
        };
        let e = writer.write(b"data").unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::BrokenPipe);
    }

    #[test]
    fn tar_channel_writer_stops_on_cancellation_before_touching_the_channel() {
        // Cancellation must stop the build even when the reader is still
        // draining, which is what makes a shutdown prompt rather than
        // dependent on the next chunk filling the channel.
        let (tx, mut rx) = mpsc::channel::<std::io::Result<Bytes>>(1);
        let cancel = crate::bulk_transfer::test_support::cancelled();
        let mut writer = TarChannelWriter { tx, cancel };
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
    async fn a_terminal_directory_download_streams_a_valid_tar_on_the_fly() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"a").unwrap();
        std::fs::write(dir.path().join("b.txt"), b"b").unwrap();

        let bulk = crate::state::test_support::make_test_bulk_transfer_tenant();
        let resp =
            stream_planned_download_tracked(&bulk, None, None, dir.path().to_path_buf(), u64::MAX)
                .await;

        assert_eq!(
            resp.headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("application/x-tar"),
            "a directory download declares itself an archive"
        );
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
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
