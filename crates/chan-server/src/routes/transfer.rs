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

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use axum::body::{Body, Bytes};
use axum::extract::{multipart::Field, Multipart, Path as AxumPath, Query};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::stream;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

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
}

impl Write for TarChannelWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
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

/// Stream a tar archive straight to the response body, built on the fly by
/// `build` (no staged temp file). The caller is expected to have already
/// pre-flighted readability, so the build does not fail mid-stream under normal
/// conditions; a client disconnect stops it cleanly (BrokenPipe), and any other
/// late error is forwarded so the body fails rather than completing a truncated
/// archive silently.
pub(crate) fn stream_tar_response<F>(archive_name: String, build: F) -> Response
where
    F: FnOnce(&mut tar::Builder<TarChannelWriter>) -> std::io::Result<()> + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<std::io::Result<Bytes>>(8);
    tokio::task::spawn_blocking(move || {
        let mut builder = tar::Builder::new(TarChannelWriter { tx: tx.clone() });
        let result = build(&mut builder).and_then(|()| builder.finish());
        if let Err(e) = result {
            if e.kind() != std::io::ErrorKind::BrokenPipe {
                let _ = tx.blocking_send(Err(e));
            }
        }
    });
    let body = Body::from_stream(stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|message| (message, rx))
    }));
    (
        [
            (header::CONTENT_TYPE, "application/x-tar".to_string()),
            (
                header::CONTENT_DISPOSITION,
                content_disposition_archive(&archive_name),
            ),
        ],
        body,
    )
        .into_response()
}

#[derive(Default, Deserialize)]
pub(crate) struct TerminalDownloadQuery {
    #[serde(default)]
    download: Option<String>,
}

/// `GET /api/files/{*path}?download=1` on the terminal tenant: stream the cwd /
/// uid-scoped file or a tar of the directory. Mounted only on the slim terminal
/// router, so `{*path}` is always a filesystem-absolute target (see
/// [`abs_from_terminal_path`]).
pub async fn api_terminal_read_file(
    AxumPath(path): AxumPath<String>,
    Query(query): Query<TerminalDownloadQuery>,
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
    let abs = abs_from_terminal_path(&path);
    let plan_abs = abs.clone();
    let plan = tokio::task::spawn_blocking(move || terminal_download_plan(&plan_abs)).await;
    match plan {
        Ok(Ok(TerminalDownload::File { reader, name })) => {
            stream_terminal_file_response(&name, reader)
        }
        // The tree was pre-flighted readable in the plan; stream the tar on the
        // fly so a cancel is trace-free by construction (no staged temp).
        Ok(Ok(TerminalDownload::Directory { name })) => {
            let build_abs = abs;
            let build_name = name.clone();
            stream_tar_response(name, move |builder| {
                builder.append_dir_all(&build_name, &build_abs)
            })
        }
        // Pre-flight / IO failures are reported before any archive bytes go out.
        Ok(Err(message)) => err(StatusCode::BAD_REQUEST, message),
        Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    }
}

/// One absolute regular-file stream backed by a fixed-size bounded queue and
/// one owned producer thread. Dropping the consumer closes the queue and joins
/// the producer, so a disconnected response cannot leave a blocked reader
/// behind.
struct AbsoluteFileReader {
    size: u64,
    receiver: Option<std::sync::mpsc::Receiver<std::io::Result<Vec<u8>>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl AbsoluteFileReader {
    fn open(abs: &Path) -> Result<Self, String> {
        let mut file =
            std::fs::File::open(abs).map_err(|e| format!("cannot read {}: {e}", abs.display()))?;
        let metadata = file
            .metadata()
            .map_err(|e| format!("cannot stat {}: {e}", abs.display()))?;
        if !metadata.is_file() {
            return Err(format!("not a regular file: {}", abs.display()));
        }
        let (sender, receiver) = std::sync::mpsc::sync_channel::<std::io::Result<Vec<u8>>>(
            chan_workspace::BINARY_STREAM_QUEUE_DEPTH,
        );
        let worker = std::thread::Builder::new()
            .name("chan-terminal-byte-reader".into())
            .spawn(move || loop {
                let mut chunk = vec![0u8; chan_workspace::BINARY_STREAM_CHUNK_SIZE];
                let count = match file.read(&mut chunk) {
                    Ok(0) => return,
                    Ok(count) => count,
                    Err(error) => {
                        let _ = sender.send(Err(error));
                        return;
                    }
                };
                chunk.truncate(count);
                if sender.send(Ok(chunk)).is_err() {
                    return;
                }
            })
            .map_err(|e| format!("cannot start reader for {}: {e}", abs.display()))?;
        Ok(Self {
            size: metadata.len(),
            receiver: Some(receiver),
            worker: Some(worker),
        })
    }
}

impl Iterator for AbsoluteFileReader {
    type Item = std::io::Result<Vec<u8>>;

    fn next(&mut self) -> Option<Self::Item> {
        self.receiver.as_ref()?.recv().ok()
    }
}

impl Drop for AbsoluteFileReader {
    fn drop(&mut self) {
        self.receiver.take();
        if let Some(worker) = self.worker.take() {
            if worker.join().is_err() {
                tracing::warn!("terminal bounded file reader producer panicked");
            }
        }
    }
}

/// What a terminal download resolves to: a bounded open-file reader, or a
/// directory whose tree has been pre-flighted readable and is ready to stream.
enum TerminalDownload {
    File {
        reader: AbsoluteFileReader,
        name: String,
    },
    Directory {
        name: String,
    },
}

fn terminal_download_plan(abs: &Path) -> Result<TerminalDownload, String> {
    let meta =
        std::fs::metadata(abs).map_err(|e| format!("cannot access {}: {e}", abs.display()))?;
    let name = download_filename(&abs.to_string_lossy());
    if meta.is_dir() {
        // Pre-flight the whole tree before streaming so an unreadable entry
        // fails fast with a clear status instead of truncating a streamed
        // archive mid-flight.
        verify_readable_fs(abs)?;
        Ok(TerminalDownload::Directory { name })
    } else {
        // Opening happens before headers are sent. The returned reader keeps
        // the exact file handle and bounded producer alive.
        let reader = AbsoluteFileReader::open(abs)?;
        Ok(TerminalDownload::File { reader, name })
    }
}

fn stream_terminal_file_response(path: &str, reader: AbsoluteFileReader) -> Response {
    stream_terminal_file_response_inner(path, reader, None)
}

#[cfg(test)]
fn stream_terminal_file_response_with_completion(
    path: &str,
    reader: AbsoluteFileReader,
) -> (Response, tokio::sync::oneshot::Receiver<()>) {
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    (
        stream_terminal_file_response_inner(path, reader, Some(done_tx)),
        done_rx,
    )
}

fn stream_terminal_file_response_inner(
    path: &str,
    mut reader: AbsoluteFileReader,
    completion: Option<tokio::sync::oneshot::Sender<()>>,
) -> Response {
    let size = reader.size;
    let (tx, rx) =
        mpsc::channel::<std::io::Result<Bytes>>(chan_workspace::BINARY_STREAM_QUEUE_DEPTH);
    tokio::task::spawn_blocking(move || {
        for next in reader.by_ref() {
            let terminal = next.is_err();
            let message = next.map(Bytes::from);
            if tx.blocking_send(message).is_err() || terminal {
                break;
            }
        }
        drop(reader);
        if let Some(completion) = completion {
            let _ = completion.send(());
        }
    });
    let body = Body::from_stream(stream::unfold(rx, |mut rx| async {
        rx.recv().await.map(|message| (message, rx))
    }));
    (
        [
            (header::CONTENT_TYPE, content_type_for(path).to_string()),
            (
                header::CONTENT_DISPOSITION,
                content_disposition_attachment(path),
            ),
            (header::CONTENT_LENGTH, size.to_string()),
        ],
        body,
    )
        .into_response()
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
pub async fn api_terminal_upload_file(mut multipart: Multipart) -> Response {
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
                        return match stream_terminal_upload(abs_dir, filename, field).await {
                            Ok(response) => Json(response).into_response(),
                            Err(error) => err_from(&error),
                        };
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

async fn stream_terminal_upload(
    abs_dir: PathBuf,
    filename: String,
    mut field: Field<'_>,
) -> chan_workspace::Result<TerminalUploadResponse> {
    let (tx, rx) = mpsc::channel(8);
    let consumer = tokio::task::spawn_blocking(move || {
        terminal_upload_stream_sync(&abs_dir, &filename, rx, chan_workspace::BYTES_WRITE_LIMIT)
    });
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
    consumer
        .await
        .map_err(|error| chan_workspace::ChanError::Io(error.to_string()))?
}

fn terminal_upload_stream_sync(
    abs_dir: &Path,
    original_name: &str,
    mut rx: mpsc::Receiver<TerminalUploadMessage>,
    limit: u64,
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
        let app = Router::new().route("/upload", post(api_terminal_upload_file));

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

        let error = terminal_upload_stream_sync(dir.path(), "large.bin", rx, 8).unwrap_err();

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

        let error = terminal_upload_stream_sync(dir.path(), "cancelled.bin", rx, 1024).unwrap_err();

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

        match terminal_download_plan(&dir.path().join("one.txt")).unwrap() {
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
        // stream builds a real tar via the same `append_dir_all` the handler
        // hands `stream_tar_response`.
        match terminal_download_plan(dir.path()).unwrap() {
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
        let missing = match terminal_download_plan(&dir.path().join("missing")) {
            Err(error) => error,
            Ok(_) => panic!("missing download must fail"),
        };
        assert!(missing.contains("cannot access"), "{missing}");
    }

    #[tokio::test]
    async fn dropping_terminal_file_response_joins_the_bounded_reader() {
        let dir = tempfile::tempdir().unwrap();
        let size = chan_workspace::BINARY_STREAM_CHUNK_SIZE
            * (chan_workspace::BINARY_STREAM_QUEUE_DEPTH + 16);
        let path = dir.path().join("disconnect.bin");
        std::fs::write(&path, vec![0x44; size]).unwrap();
        let reader = match terminal_download_plan(&path).unwrap() {
            TerminalDownload::File { reader, .. } => reader,
            TerminalDownload::Directory { .. } => panic!("expected file"),
        };
        let (response, completed) =
            stream_terminal_file_response_with_completion("disconnect.bin", reader);

        drop(response);

        tokio::time::timeout(std::time::Duration::from_secs(2), completed)
            .await
            .expect("bounded terminal reader must stop after response drop")
            .expect("completion sender must fire");
    }

    #[test]
    fn tar_channel_writer_signals_broken_pipe_when_the_receiver_is_gone() {
        // A cancelled download drops the body receiver; the next tar write must
        // fail so the build stops (nothing staged on disk = no trace).
        let (tx, rx) = mpsc::channel::<std::io::Result<Bytes>>(1);
        drop(rx);
        let mut writer = TarChannelWriter { tx };
        let e = writer.write(b"data").unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::BrokenPipe);
    }

    #[tokio::test]
    async fn stream_tar_response_streams_a_valid_tar_on_the_fly() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"a").unwrap();
        std::fs::write(dir.path().join("b.txt"), b"b").unwrap();
        let src = dir.path().to_path_buf();

        let resp = stream_tar_response("arc".into(), move |b| b.append_dir_all("arc", &src));
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
