//! Per-file CRUD: list, read (text or binary), write (with optional
//! CAS), create (file or dir), delete, move.

use std::{convert::Infallible, sync::Arc};

use axum::body::{Body, Bytes};
use axum::extract::{multipart::Field, Multipart, Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use chan_workspace::{AtomicWriteKind, BoundedFileReader, FileStat};

use crate::doc_sessions::{flush_session, DocSession, HttpReplaceOutcome as DocHttpReplaceOutcome};
use crate::error::{err, err_from, err_state};
use crate::scene_sessions::scene::SceneError;
use crate::scene_sessions::{
    flush_session as flush_scene_session, HttpReplaceOutcome as SceneHttpReplaceOutcome,
    SceneSession,
};
use crate::self_writes::{check_write_preconditions, WritePreconditionError, WritePreconditions};
use crate::state::AppState;
use crate::static_assets::content_type_for;

enum ReadFileResult {
    Text {
        content: String,
        mtime: Option<i64>,
        mtime_ns: Option<i64>,
        writable: bool,
        path_class: Option<chan_workspace::PathClass>,
    },
    Binary,
    TooLarge {
        size: u64,
        limit: u64,
    },
}

/// Tree entry shape on the wire. Adds a `kind` discriminator on top
/// of chan-workspace's `TreeEntry` so the file browser, search overlay,
/// and graph inspector can render the right glyph + chip without a
/// per-file resolve round-trip. Six kinds (`document`, `contact`,
/// `text`, `media`, `binary`, `pending`) for regular files; absent on
/// directory entries (the frontend keys off `is_dir` for those).
///
/// Mapping (see `project_kind` below):
///   - `FileClass::EditableText` + contact frontmatter -> `contact`
///   - `FileClass::EditableText` + Markdown (`.md`)     -> `document`
///   - `FileClass::EditableText` non-Markdown (`.txt`)  -> `text`
///   - `FileClass::Text`                               -> `text`
///   - `FileClass::Image` / `FileClass::Pdf`           -> `media`
///   - `FileClass::Other` -> `pending`; a content sniff in
///     `list_files_sync` then resolves it to `text` (valid UTF-8, no
///     NUL) or `binary` for per-directory listings.
///
/// PDFs are media: the frontend's fullscreen viewer (state/pdfViewer.ts)
/// handles them via `<embed type="application/pdf">`. chan-workspace keeps
/// `FileClass::Pdf` as a distinct variant so a future iteration that
/// renders PDFs differently from images (per-page extract, OCR, ...)
/// can re-distinguish without revisiting the wire shape.
#[derive(Serialize)]
pub(crate) struct TreeEntryView {
    pub(crate) path: String,
    pub(crate) is_dir: bool,
    pub(crate) mtime: Option<i64>,
    pub(crate) size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) path_class: Option<chan_workspace::PathClass>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) kind: Option<&'static str>,
}

/// Map a regular-file path (and its contact flag) to the wire kind
/// string. Returns `None` for directories so the existing serializer
/// drops the field on dir entries.
pub(crate) fn project_kind(path: &str, is_dir: bool, is_contact: bool) -> Option<&'static str> {
    if is_dir {
        return None;
    }
    if is_contact {
        return Some("contact");
    }
    Some(match chan_workspace::fs_ops::classify(path) {
        // Only Markdown (.md) is a graph "document" (graphed + wikilinked).
        // .txt stays editable + BM25-searchable but is not a document node,
        // so it rides the "text" wire kind alongside source/config text.
        // Keyed off `is_markdown_file` to stay in lockstep with the graph
        // ingest gate (`Workspace::rebuild_graph` / `index_file_inner`).
        chan_workspace::FileClass::EditableText
            if chan_workspace::fs_ops::is_markdown_file(path) =>
        {
            "document"
        }
        chan_workspace::FileClass::EditableText | chan_workspace::FileClass::Text => "text",
        chan_workspace::FileClass::Image | chan_workspace::FileClass::Pdf => "media",
        // Unknown extension/basename: the path alone can't tell text
        // from binary. Emit "pending" rather than prejudging "binary";
        // per-directory listings resolve it with a content sniff (see
        // `list_files_sync`), so the file browser still shows a final
        // "text"/"binary" kind. Only the recursive whole-tree listing
        // (image picker) leaves it "pending", and that caller reads
        // media kinds only.
        chan_workspace::FileClass::Other => "pending",
    })
}

#[derive(Deserialize)]
pub struct ListFilesQuery {
    /// Optional directory to list non-recursively. Missing preserves
    /// the legacy recursive listing for callers that still need a
    /// whole-workspace snapshot.
    #[serde(default)]
    pub(crate) dir: Option<String>,
}

pub async fn api_list_files(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListFilesQuery>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(e) => return err_state(&e),
    };
    let result = tokio::task::spawn_blocking(move || list_files_sync(&workspace, query)).await;

    match result {
        Ok(Ok(out)) => Json(out).into_response(),
        Ok(Err(e)) => err_from(&e),
        Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    }
}

fn list_files_sync(
    workspace: &chan_workspace::Workspace,
    query: ListFilesQuery,
) -> chan_workspace::Result<Vec<TreeEntryView>> {
    // An open capability handle can outlive an unlinked root and read back as
    // an empty directory. Distinguish that terminal condition from a genuine
    // empty workspace so the File Browser renders an unavailable-root error.
    workspace.ensure_root_available()?;
    let tree = if let Some(dir) = query.dir.as_deref() {
        list_dir_entries(workspace, dir)?
    } else {
        // The browser still reflects live disk, but it should not
        // recursively enumerate build/dependency trees that the workspace's
        // own indexing policy already treats as noise (`target/`,
        // `node_modules/`, ...). Repo roots can otherwise spend startup
        // walking hundreds of thousands of uninteresting files before the
        // user sees anything.
        //
        // The drafts dir (`.Drafts/` by default) is a real in-root
        // directory and lists like any other folder; the File Browser
        // shows it once a draft exists.
        chan_workspace::fs_ops::list_tree_filtered(workspace.root(), workspace.walk_filter())?
    };
    // Pull the contact-kind set in one shot; a single SQL scan beats N
    // per-path node_kind lookups on big workspaces.
    let contact_paths: std::collections::HashSet<String> = match workspace.contacts() {
        Ok(rows) => rows.into_iter().map(|c| c.rel_path).collect(),
        Err(_) => std::collections::HashSet::new(),
    };
    let mut out: Vec<TreeEntryView> = tree
        .into_iter()
        .map(|e| TreeEntryView {
            kind: project_kind(&e.path, e.is_dir, contact_paths.contains(&e.path)),
            path_class: path_class_for_wire(workspace, &e.path),
            path: e.path,
            is_dir: e.is_dir,
            mtime: e.mtime,
            size: e.size,
        })
        .collect();
    // Resolve the path-only "pending" kind with a bounded content
    // sniff, but only for per-directory listings (the file browser).
    // It lists one directory at a time, so this stays a handful of
    // 8 KiB reads per expand. The recursive whole-tree listing (no
    // `dir`, used by the image picker) is left untouched so we never
    // sniff the entire tree; its consumer reads media kinds only.
    if query.dir.is_some() {
        for entry in out.iter_mut() {
            if entry.kind == Some("pending") {
                entry.kind = Some(if workspace.sniff_is_text(&entry.path) {
                    "text"
                } else {
                    "binary"
                });
            }
        }
    }
    Ok(out)
}

fn list_dir_entries(
    workspace: &chan_workspace::Workspace,
    dir: &str,
) -> chan_workspace::Result<Vec<chan_workspace::TreeEntry>> {
    let rel = normalize_dir_query(dir)?;
    let children = workspace.list(&rel)?;
    let mut out = Vec::with_capacity(children.len());
    for child in children {
        if child.is_dir && workspace.walk_filter().is_excluded(&child.name) {
            continue;
        }
        let path = join_rel(&rel, &child.name);
        let stat = match workspace.stat(&path) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(%path, ?e, "list_dir_entries: stat failed; skipping");
                continue;
            }
        };
        out.push(chan_workspace::TreeEntry {
            path,
            is_dir: stat.is_dir,
            mtime: stat.mtime,
            size: if stat.is_dir { 0 } else { stat.size },
        });
    }
    Ok(out)
}

pub(crate) fn normalize_dir_query(dir: &str) -> chan_workspace::Result<String> {
    let trimmed = dir.trim_matches('/');
    if trimmed.is_empty() || trimmed == "." {
        return Ok(String::new());
    }
    chan_workspace::fs_ops::validate_rel(trimmed)?;
    Ok(trimmed.to_string())
}

pub(crate) fn join_rel(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

#[derive(Serialize)]
pub(crate) struct FileResponse {
    pub(crate) path: String,
    pub(crate) content: String,
    pub(crate) mtime: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) mtime_ns: Option<String>,
    pub(crate) authority_version: Option<u64>,
    pub(crate) disk_conflicted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) path_class: Option<chan_workspace::PathClass>,
    /// Filesystem-level writability. False when the path lacks the
    /// user-write bit (e.g. `chmod -w`); the editor uses this to
    /// lock the per-tab read mode regardless of user choice. Sourced
    /// from `metadata().permissions().readonly()` on the resolved
    /// workspace-internal path so symlink escapes are still refused
    /// upstream by chan-workspace.
    pub(crate) writable: bool,
    /// One server-owned threshold shared by buffered editor reads and the
    /// incremental indexer. The chunked read still reports it so clients can
    /// explain why an oversized file remains streamable but is not indexed.
    pub(crate) max_editable_bytes: u64,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum FileStreamEvent<'a> {
    Meta {
        path: &'a str,
        size: u64,
        mtime: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        mtime_ns: Option<String>,
        authority_version: Option<u64>,
        disk_conflicted: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        path_class: Option<chan_workspace::PathClass>,
        writable: bool,
        max_editable_bytes: u64,
    },
    Chunk {
        content: &'a str,
        bytes: usize,
    },
    Done,
    Error {
        error: String,
    },
}

pub(crate) enum FileStreamMessage {
    Data(Bytes),
    Error(chan_workspace::ChanError),
}

fn path_class_for_wire(
    workspace: &chan_workspace::Workspace,
    rel: &str,
) -> Option<chan_workspace::PathClass> {
    match chan_workspace::fs_ops::classify_path(workspace.root(), rel) {
        Ok(class) => Some(class),
        Err(e) => {
            tracing::warn!(%rel, ?e, "path classification failed");
            None
        }
    }
}

/// Project the canonical strict write preflight onto read metadata.
/// Every caller already runs on a blocking worker.
fn workspace_path_writable(workspace: &chan_workspace::Workspace, rel: &str) -> bool {
    workspace.ensure_writable(rel).is_ok()
}

fn read_file_sync(
    workspace: &chan_workspace::Workspace,
    path: &str,
) -> chan_workspace::Result<ReadFileResult> {
    // Image / PDF paths are consumed by `<img>` / `<embed>` tags
    // pointing at this route, so they come back as raw bytes with an
    // image content-type REGARDLESS of what their content looks like.
    // Without this gate an SVG (XML text) passes the editable-text
    // content sniff below and ships as the editor's JSON envelope --
    // making every `<img src=.../api/files/x.svg>` render broken
    // while binary formats (png/jpg) work fine. FileClass::Image's
    // own contract is read-only via `read` / `write_bytes`.
    match chan_workspace::fs_ops::classify(path) {
        chan_workspace::fs_ops::FileClass::Image | chan_workspace::fs_ops::FileClass::Pdf => {
            return Ok(ReadFileResult::Binary);
        }
        chan_workspace::fs_ops::FileClass::Other if !workspace.sniff_is_text(path) => {
            return Ok(ReadFileResult::Binary);
        }
        _ => {}
    }
    let stat = workspace.stat(path)?;
    if stat.size > chan_workspace::TEXT_WRITE_LIMIT {
        return Ok(ReadFileResult::TooLarge {
            size: stat.size,
            limit: chan_workspace::TEXT_WRITE_LIMIT,
        });
    }
    // `read_text_with_stat` applies the content-aware editable gate, so
    // an extensionless / odd-suffix text file (`.zshrc`, `*.service`)
    // reads as text here. A genuinely binary file fails the gate with
    // `NotEditableText`; that is the only error we swallow into a binary
    // read. Any other error (invalid UTF-8 deeper than the sniff window,
    // I/O failure) propagates so the editor sees the real cause.
    match workspace.read_text_with_stat(path) {
        Ok((content, stat)) => Ok(ReadFileResult::Text {
            content,
            mtime: stat.mtime,
            mtime_ns: stat.mtime_ns,
            writable: workspace_path_writable(workspace, path),
            path_class: path_class_for_wire(workspace, path),
        }),
        Err(chan_workspace::ChanError::NotEditableText(_)) => Ok(ReadFileResult::Binary),
        Err(e) => Err(e),
    }
}

pub(crate) fn ndjson_bytes(event: &FileStreamEvent<'_>) -> Result<Bytes, serde_json::Error> {
    let mut line = serde_json::to_vec(event)?;
    line.push(b'\n');
    Ok(Bytes::from(line))
}

pub(crate) fn ndjson_error_bytes(error: String) -> Bytes {
    match ndjson_bytes(&FileStreamEvent::Error { error }) {
        Ok(bytes) => bytes,
        Err(e) => Bytes::from(format!(
            "{{\"type\":\"error\",\"error\":\"failed to encode stream error: {e}\"}}\n"
        )),
    }
}

fn stream_read_file_sync<F>(
    workspace: &chan_workspace::Workspace,
    path: &str,
    mut emit: F,
) -> chan_workspace::Result<()>
where
    F: FnMut(Bytes) -> bool,
{
    let mut encode_error = None;
    let result = workspace.read_text_with_stat_chunked(
        path,
        chan_workspace::TEXT_READ_CHUNK_SIZE,
        |event| {
            let event = match event {
                chan_workspace::TextReadEvent::Meta(stat) => FileStreamEvent::Meta {
                    path,
                    size: stat.size,
                    mtime: stat.mtime,
                    mtime_ns: stat.mtime_ns.map(|ns| ns.to_string()),
                    authority_version: None,
                    disk_conflicted: false,
                    path_class: path_class_for_wire(workspace, path),
                    writable: workspace_path_writable(workspace, path),
                    max_editable_bytes: chan_workspace::TEXT_WRITE_LIMIT,
                },
                chan_workspace::TextReadEvent::Chunk(content) => FileStreamEvent::Chunk {
                    content,
                    bytes: content.len(),
                },
                chan_workspace::TextReadEvent::Done => FileStreamEvent::Done,
            };
            match ndjson_bytes(&event) {
                Ok(bytes) => emit(bytes),
                Err(e) => {
                    encode_error = Some(chan_workspace::ChanError::Io(format!(
                        "failed to encode file stream event: {e}"
                    )));
                    false
                }
            }
        },
    );
    result?;
    if let Some(e) = encode_error {
        Err(e)
    } else {
        Ok(())
    }
}

pub(crate) enum BinaryPlan {
    Full(BoundedFileReader),
    Partial(BoundedFileReader),
    Unsatisfiable(FileStat),
}

/// What a workspace download resolves to: a bounded file plan, or a directory
/// whose tree has been pre-flighted readable and is ready to stream.
enum DownloadPayload {
    File(BinaryPlan),
    Directory,
}

fn download_path_sync(
    workspace: &chan_workspace::Workspace,
    path: &str,
    range_header: Option<&str>,
) -> chan_workspace::Result<DownloadPayload> {
    let stat = workspace.stat(path)?;
    if stat.is_dir {
        // Pre-flight the tree before streaming so an unreadable entry fails fast
        // with a clear "cannot read X" status instead of truncating a streamed
        // archive mid-flight.
        let payload_bytes = verify_readable_workspace_tree(workspace, path)
            .map_err(chan_workspace::ChanError::Io)?;
        let limit = workspace.transfer_max_bytes();
        if payload_bytes > limit {
            return Err(chan_workspace::ChanError::WriteTooLarge {
                kind: "archive",
                size: payload_bytes,
                limit,
            });
        }
        Ok(DownloadPayload::Directory)
    } else {
        binary_plan_sync(workspace, path, range_header).map(DownloadPayload::File)
    }
}

/// Header-shaped facts from an admitted download plan, carried out of the job
/// so the route can build headers while the reader stays inside the job that
/// streams it. Mirrors `BinaryPlan`'s variants rather than flattening them:
/// the whole-file case and a `Range` that happens to span the whole file
/// produce identical bytes and an identical `Content-Length`, and differ only
/// in status and `Content-Range`, so the Full-versus-Partial decision
/// `RangeOutcome` already made is carried here rather than re-derived from
/// `start` and `len`, which cannot distinguish them.
enum PlannedWorkspaceDownload {
    Full {
        len: u64,
        stat: FileStat,
    },
    Partial {
        start: u64,
        len: u64,
        stat: FileStat,
    },
    Unsatisfiable {
        stat: FileStat,
    },
    Directory {
        name: String,
    },
}

/// Admit one workspace download to the transfer lane and stream it.
///
/// Planning opens the file or pre-flights a whole tree, which is real work and
/// belongs on the transfer lane rather than the pool serving editor saves and
/// terminal spawns. Plan and stream ride ONE admission: the job reports its
/// plan over a oneshot so headers can be built, then keeps going into the body.
/// Submitting them separately would make a single request cost two admissions
/// against a bound that counts requests.
///
/// An admission refusal is returned before the job exists, so a declined
/// download has not opened a file or walked a tree. A plan refusal runs inside
/// the admitted job but precedes the first response byte. Past that point every
/// early return drops the job, which cancels it and releases its slot.
async fn stream_planned_workspace_download_tracked(
    bulk: &crate::bulk_transfer::BulkTransferTenant,
    events: Option<tokio::sync::broadcast::Sender<String>>,
    tracking: Option<crate::routes::transfer::TransferTracking>,
    workspace: Arc<chan_workspace::Workspace>,
    path: String,
    range_header: Option<String>,
) -> Response {
    let (tx, rx) = mpsc::channel::<std::io::Result<Bytes>>(8);
    let (plan_tx, plan_rx) =
        tokio::sync::oneshot::channel::<chan_workspace::Result<PlannedWorkspaceDownload>>();
    let archive_name = download_filename(&path);
    // The job takes the request path; headers are built from this copy.
    let header_path = path.clone();
    let job = match bulk.submit(move |cancel| {
        let payload = match download_path_sync(&workspace, &path, range_header.as_deref()) {
            Ok(payload) => payload,
            Err(e) => {
                let _ = plan_tx.send(Err(e));
                return;
            }
        };
        match payload {
            DownloadPayload::File(plan) => {
                // The reader carries the framing, so the declared length and
                // the streamed bytes come from the same `slice()`.
                let (planned, reader) = match plan {
                    BinaryPlan::Full(reader) => {
                        let (_, len) = reader.slice();
                        let stat = reader.stat().clone();
                        (PlannedWorkspaceDownload::Full { len, stat }, Some(reader))
                    }
                    BinaryPlan::Partial(reader) => {
                        let (start, len) = reader.slice();
                        let stat = reader.stat().clone();
                        (
                            PlannedWorkspaceDownload::Partial { start, len, stat },
                            Some(reader),
                        )
                    }
                    BinaryPlan::Unsatisfiable(stat) => {
                        (PlannedWorkspaceDownload::Unsatisfiable { stat }, None)
                    }
                };
                if plan_tx.send(Ok(planned)).is_err() {
                    return;
                }
                let Some(reader) = reader else { return };
                send_reader_into(&tx, cancel, reader);
            }
            DownloadPayload::Directory => {
                let limit = workspace.transfer_max_bytes();
                let build_ws = workspace;
                let build_path = path;
                let build_name = archive_name;
                if plan_tx
                    .send(Ok(PlannedWorkspaceDownload::Directory {
                        name: build_name.clone(),
                    }))
                    .is_err()
                {
                    return;
                }
                // Builds into this job's channel rather than through
                // `stream_tar_response_tracked`, which would submit again.
                crate::routes::transfer::build_tar_into(&tx, cancel, limit, move |builder| {
                    append_dir_to_archive(builder, &build_ws, &build_path, &build_name)
                        .map_err(|e| std::io::Error::other(e.to_string()))
                });
            }
        }
    }) {
        Ok(job) => job,
        Err(full) => return full.into_response(),
    };
    let (alive_tx, alive_rx) = tokio::sync::oneshot::channel::<Infallible>();
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
        Ok(Err(error @ chan_workspace::ChanError::WriteTooLarge { .. })) => {
            return err_from(&error)
        }
        Ok(Err(error)) => return err(StatusCode::BAD_REQUEST, error.to_string()),
        Err(_) => {
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "download plan did not report".into(),
            )
        }
    };
    let body = Body::from_stream(stream::unfold(
        (rx, job, alive_tx),
        |(mut rx, job, alive_tx)| async move {
            rx.recv()
                .await
                .map(|message| (message, (rx, job, alive_tx)))
        },
    ));
    planned_workspace_download_response(&path_for_headers(&planned, &header_path), planned, body)
}

/// Drain a bounded reader into the job's channel on the calling thread, which
/// is the lane worker. Handing the reader to a pool task instead would cost a
/// slot AND a task for one request.
///
/// Cancellation is checked once per chunk, so an abandoned download releases
/// its slot after at most one chunk's work rather than after the whole file.
///
/// Neither a read error nor a cancellation may end this stream cleanly. The
/// declared length is already on the wire, so a clean end answers with fewer
/// bytes than promised, which is the silent truncation the length exists to
/// prevent. A read error, which is what a mid-read shrink produces, is
/// forwarded; so is a cancellation, because cancel does not mean the client is
/// gone: `BulkTransferLane`'s Drop cancels every active job at process
/// shutdown, and a client mid-download then is still connected and draining.
/// Forwarding is never worse than returning. With the client gone the send
/// fails on the dropped receiver and nothing happens, exactly as a silent
/// return would; with the client live the body fails instead of completing
/// short.
fn send_reader_into(
    tx: &mpsc::Sender<std::io::Result<Bytes>>,
    cancel: &crate::bulk_transfer::BulkCancel,
    mut reader: BoundedFileReader,
) {
    for next in reader.by_ref() {
        if cancel.is_cancelled() {
            let _ = tx.blocking_send(Err(std::io::Error::other(
                "transfer cancelled before the declared length was streamed",
            )));
            return;
        }
        let message = next
            .map(Bytes::from)
            .map_err(|error| std::io::Error::other(error.to_string()));
        let terminal = message.is_err();
        if tx.blocking_send(message).is_err() || terminal {
            return;
        }
    }
}

/// The response path's view of the download name. A file keeps the request
/// path so content sniffing and disposition match what was asked for; an
/// archive is named for the directory it wraps.
fn path_for_headers(planned: &PlannedWorkspaceDownload, path: &str) -> String {
    match planned {
        PlannedWorkspaceDownload::Directory { name } => name.clone(),
        _ => path.to_string(),
    }
}

/// Build the download response from the carried plan facts. Header framing
/// comes from the same `slice()` the job is streaming, never from a second
/// stat, so `Content-Length` cannot disagree with the bytes.
fn planned_workspace_download_response(
    name: &str,
    planned: PlannedWorkspaceDownload,
    body: Body,
) -> Response {
    let mut response = match planned {
        PlannedWorkspaceDownload::Full { len, stat } => {
            let mut response = Response::new(body);
            response.headers_mut().insert(
                header::CONTENT_LENGTH,
                len.to_string()
                    .parse()
                    .expect("file size is a valid header"),
            );
            response.headers_mut().insert(
                header::ETAG,
                strong_file_etag(&stat)
                    .parse()
                    .expect("etag is header-safe"),
            );
            response
        }
        PlannedWorkspaceDownload::Partial { start, len, stat } => {
            let total = stat.size;
            let mut response = Response::new(body);
            *response.status_mut() = StatusCode::PARTIAL_CONTENT;
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                format!("bytes {start}-{}/{total}", start + len - 1)
                    .parse()
                    .expect("content range is header-safe"),
            );
            response.headers_mut().insert(
                header::CONTENT_LENGTH,
                len.to_string()
                    .parse()
                    .expect("file size is a valid header"),
            );
            response.headers_mut().insert(
                header::ETAG,
                strong_file_etag(&stat)
                    .parse()
                    .expect("etag is header-safe"),
            );
            response
        }
        PlannedWorkspaceDownload::Unsatisfiable { stat } => {
            let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                format!("bytes */{}", stat.size)
                    .parse()
                    .expect("content range is header-safe"),
            );
            response.headers_mut().insert(
                header::ETAG,
                strong_file_etag(&stat)
                    .parse()
                    .expect("etag is header-safe"),
            );
            response
        }
        PlannedWorkspaceDownload::Directory { name } => {
            let mut response = Response::new(body);
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                "application/x-tar".parse().expect("static header value"),
            );
            response.headers_mut().insert(
                header::CONTENT_DISPOSITION,
                content_disposition_archive(&name)
                    .parse()
                    .expect("archive filename is header-safe"),
            );
            return response;
        }
    };
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        content_type_for(name)
            .parse()
            .expect("known content type is header-safe"),
    );
    response
        .headers_mut()
        .insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        content_disposition_attachment(name)
            .parse()
            .expect("download filename is header-safe"),
    );
    if is_active_content_path(name) {
        response.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            "sandbox".parse().expect("static header value"),
        );
        response.headers_mut().insert(
            "x-content-type-options",
            "nosniff".parse().expect("static header value"),
        );
    }
    response
}

/// Unadmitted whole-plan download, retained for the plan-shape tests. The
/// served download path admits to the transfer lane instead, so this has no
/// production caller.
#[cfg(test)]
fn stream_binary_download(path: &str, plan: BinaryPlan) -> Response {
    stream_binary_plan(path, plan, true, None)
}

#[cfg(test)]
fn stream_binary_download_with_completion(
    path: &str,
    reader: BoundedFileReader,
) -> (Response, tokio::sync::oneshot::Receiver<()>) {
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    (
        stream_binary_plan(path, BinaryPlan::Full(reader), true, Some(done_tx)),
        done_rx,
    )
}

pub(crate) fn stream_binary_plan(
    path: &str,
    plan: BinaryPlan,
    attachment: bool,
    completion: Option<tokio::sync::oneshot::Sender<()>>,
) -> Response {
    let mut response = match plan {
        BinaryPlan::Full(reader) => {
            let len = reader.slice().1;
            let etag = strong_file_etag(reader.stat());
            let mut response = Response::new(bounded_reader_body(reader, completion));
            response.headers_mut().insert(
                header::CONTENT_LENGTH,
                len.to_string()
                    .parse()
                    .expect("file size is a valid header"),
            );
            response
                .headers_mut()
                .insert(header::ETAG, etag.parse().expect("etag is header-safe"));
            response
        }
        BinaryPlan::Partial(reader) => {
            let total = reader.stat().size;
            let etag = strong_file_etag(reader.stat());
            let (start, len) = reader.slice();
            let mut response = Response::new(bounded_reader_body(reader, completion));
            *response.status_mut() = StatusCode::PARTIAL_CONTENT;
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                format!("bytes {start}-{}/{total}", start + len - 1)
                    .parse()
                    .expect("content range is header-safe"),
            );
            response.headers_mut().insert(
                header::CONTENT_LENGTH,
                len.to_string()
                    .parse()
                    .expect("file size is a valid header"),
            );
            response
                .headers_mut()
                .insert(header::ETAG, etag.parse().expect("etag is header-safe"));
            response
        }
        BinaryPlan::Unsatisfiable(stat) => {
            let etag = strong_file_etag(&stat);
            let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                format!("bytes */{}", stat.size)
                    .parse()
                    .expect("content range is header-safe"),
            );
            response
                .headers_mut()
                .insert(header::ETAG, etag.parse().expect("etag is header-safe"));
            response
        }
    };
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        content_type_for(path)
            .parse()
            .expect("known content type is header-safe"),
    );
    response
        .headers_mut()
        .insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    if attachment || is_active_content_path(path) {
        response.headers_mut().insert(
            header::CONTENT_DISPOSITION,
            content_disposition_attachment(path)
                .parse()
                .expect("download filename is header-safe"),
        );
    }
    if is_active_content_path(path) {
        response.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            "sandbox".parse().expect("static header value"),
        );
        response.headers_mut().insert(
            "x-content-type-options",
            "nosniff".parse().expect("static header value"),
        );
    }
    response
}

fn strong_file_etag(stat: &FileStat) -> String {
    let modified = stat
        .mtime_ns
        .or_else(|| stat.mtime.map(|secs| secs.saturating_mul(1_000_000_000)));
    format!("\"{:x}-{}\"", stat.size, modified.unwrap_or_default())
}

/// Bridge a bounded reader onto a response body through a small async
/// channel. The blocking side owns the reader, so an aborted response
/// drops the channel, which stops the bridge and joins the reader's
/// producer thread; no file handle outlives its response.
fn bounded_reader_body(
    mut reader: BoundedFileReader,
    completion: Option<tokio::sync::oneshot::Sender<()>>,
) -> Body {
    let (tx, rx) = mpsc::channel::<std::io::Result<Bytes>>(8);
    tokio::task::spawn_blocking(move || {
        for next in reader.by_ref() {
            let message = next
                .map(Bytes::from)
                .map_err(|error| std::io::Error::other(error.to_string()));
            let terminal = message.is_err();
            if tx.blocking_send(message).is_err() || terminal {
                break;
            }
        }
        // Dropping the bounded reader closes its sync queue and joins the
        // owned producer before the optional test completion fires.
        drop(reader);
        if let Some(completion) = completion {
            let _ = completion.send(());
        }
    });
    Body::from_stream(stream::unfold(rx, |mut rx| async {
        rx.recv().await.map(|message| (message, rx))
    }))
}

/// Pre-flight for a directory download: confirm every file in the tree we will
/// tar is readable before any archive work. Walks via `Workspace::list` so it
/// visits exactly the entries `append_dir_to_archive` will (same `.chan` /
/// `.git` filter), and opens each backing file to check read permission without
/// pulling its bytes (the archive reads them next). Returns the member bytes
/// known at preflight so the plan can refuse a tree already past the ceiling.
fn verify_readable_workspace_tree(
    workspace: &chan_workspace::Workspace,
    rel: &str,
) -> std::result::Result<u64, String> {
    let mut payload_bytes = 0u64;
    for child in workspace
        .list(rel)
        .map_err(|e| format!("cannot read directory {rel}: {e}"))?
    {
        let child_rel = join_rel(rel.trim_matches('/'), &child.name);
        let child_bytes = if child.is_dir {
            verify_readable_workspace_tree(workspace, &child_rel)?
        } else {
            let file = std::fs::File::open(workspace.root().join(&child_rel))
                .map_err(|e| format!("cannot read {child_rel}: {e}"))?;
            file.metadata()
                .map_err(|e| format!("cannot read metadata for {child_rel}: {e}"))?
                .len()
        };
        payload_bytes = payload_bytes.saturating_add(child_bytes);
    }
    Ok(payload_bytes)
}

pub(crate) fn download_filename(path: &str) -> String {
    let raw = path
        .rsplit('/')
        .find(|segment| !segment.is_empty())
        .unwrap_or("download");
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch == '"' || ch == '\\' || ch == ':' || ch.is_control() {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    if out.trim().is_empty() {
        "download".to_string()
    } else {
        out
    }
}

pub(crate) fn content_disposition_attachment(path: &str) -> String {
    format!("attachment; filename=\"{}\"", download_filename(path))
}

fn download_archive_filename(path: &str) -> String {
    let name = download_filename(path);
    if name.to_ascii_lowercase().ends_with(".tar") {
        name
    } else {
        format!("{name}.tar")
    }
}

pub(crate) fn content_disposition_archive(path: &str) -> String {
    format!(
        "attachment; filename=\"{}\"",
        download_archive_filename(path)
    )
}

/// Append a workspace directory tree to a tar builder. Generic over the writer
/// so the same walk feeds both the on-the-fly download stream (a channel-backed
/// writer) and tests (a `Vec`). Walks via `Workspace::list` to honor the
/// workspace's `.chan`/`.git` filter.
pub(crate) fn append_dir_to_archive<W: std::io::Write>(
    builder: &mut tar::Builder<W>,
    workspace: &chan_workspace::Workspace,
    source_rel: &str,
    archive_rel: &str,
) -> chan_workspace::Result<()> {
    append_archive_dir(builder, archive_rel)?;
    for child in workspace.list(source_rel)? {
        let child_source = join_rel(source_rel.trim_matches('/'), &child.name);
        let child_archive = join_rel(archive_rel, &child.name);
        if child.is_dir {
            append_dir_to_archive(builder, workspace, &child_source, &child_archive)?;
        } else {
            let reader = workspace.read_bytes_bounded(&child_source)?;
            append_archive_file(builder, &child_archive, reader)?;
        }
    }
    Ok(())
}

fn append_archive_dir<W: std::io::Write>(
    builder: &mut tar::Builder<W>,
    archive_rel: &str,
) -> chan_workspace::Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Directory);
    header.set_size(0);
    header.set_mode(0o755);
    header.set_cksum();
    builder.append_data(&mut header, archive_rel, std::io::empty())?;
    Ok(())
}

fn append_archive_file<W: std::io::Write>(
    builder: &mut tar::Builder<W>,
    archive_rel: &str,
    reader: BoundedFileReader,
) -> chan_workspace::Result<()> {
    let size = reader.stat().size;
    let mut header = tar::Header::new_gnu();
    header.set_size(size);
    header.set_mode(0o644);
    header.set_cksum();
    builder.append_data(&mut header, archive_rel, BoundedReaderIo::new(reader))?;
    Ok(())
}

struct BoundedReaderIo {
    reader: BoundedFileReader,
    chunk: Vec<u8>,
    offset: usize,
}

impl BoundedReaderIo {
    fn new(reader: BoundedFileReader) -> Self {
        Self {
            reader,
            chunk: Vec::new(),
            offset: 0,
        }
    }
}

impl std::io::Read for BoundedReaderIo {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            if self.offset < self.chunk.len() {
                let count = buf.len().min(self.chunk.len() - self.offset);
                buf[..count].copy_from_slice(&self.chunk[self.offset..self.offset + count]);
                self.offset += count;
                return Ok(count);
            }
            match self.reader.next() {
                Some(Ok(chunk)) => {
                    self.chunk = chunk;
                    self.offset = 0;
                }
                Some(Err(error)) => return Err(std::io::Error::other(error.to_string())),
                None => return Ok(0),
            }
        }
    }
}

/// Outcome of resolving a request's `Range` header against a file's size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RangeOutcome {
    /// No header, a non-`bytes` unit, a syntactically invalid value, or
    /// a multi-range request: serve the complete file as a plain 200.
    /// RFC 9110 requires ignoring invalid `Range` headers and allows
    /// answering any `Range` with the full representation.
    Full,
    /// One satisfiable byte range, resolved to a concrete window.
    Slice { start: u64, len: u64 },
    /// A syntactically valid range no byte of the file satisfies: 416.
    Unsatisfiable,
}

/// Resolve a `Range` header value against `size`. Single-range
/// `bytes=` forms only (`A-B`, `A-`, `-N`); anything else degrades to
/// `Full`, never to an error, because a range-blind response is always
/// a correct one.
pub(crate) fn resolve_range(header: Option<&str>, size: u64) -> RangeOutcome {
    let Some(value) = header else {
        return RangeOutcome::Full;
    };
    let Some(spec) = value.trim().strip_prefix("bytes=") else {
        return RangeOutcome::Full;
    };
    let spec = spec.trim();
    if spec.contains(',') {
        return RangeOutcome::Full;
    }
    let Some((start_text, end_text)) = spec.split_once('-') else {
        return RangeOutcome::Full;
    };
    if start_text.is_empty() {
        // Suffix form `-N`: the final N bytes. `-0` is well-formed but
        // matches nothing, as does any suffix of an empty file.
        let Ok(suffix) = end_text.parse::<u64>() else {
            return RangeOutcome::Full;
        };
        if suffix == 0 || size == 0 {
            return RangeOutcome::Unsatisfiable;
        }
        let start = size.saturating_sub(suffix);
        return RangeOutcome::Slice {
            start,
            len: size - start,
        };
    }
    let Ok(start) = start_text.parse::<u64>() else {
        return RangeOutcome::Full;
    };
    if start >= size {
        return RangeOutcome::Unsatisfiable;
    }
    if end_text.is_empty() {
        // Open form `A-`: from A to EOF.
        return RangeOutcome::Slice {
            start,
            len: size - start,
        };
    }
    let Ok(end) = end_text.parse::<u64>() else {
        return RangeOutcome::Full;
    };
    if end < start {
        return RangeOutcome::Full;
    }
    RangeOutcome::Slice {
        start,
        len: end.min(size - 1) - start + 1,
    }
}

/// Resolve one file into a bounded whole/slice reader. A second stat from the
/// opened handle remains authoritative for response framing when the file
/// changes between range planning and open.
fn binary_plan_sync(
    workspace: &chan_workspace::Workspace,
    path: &str,
    range_header: Option<&str>,
) -> chan_workspace::Result<BinaryPlan> {
    let stat = workspace.stat(path)?;
    // A directory reaches the whole-file open so it fails with the canonical
    // not-a-regular-file error instead of resolving a range against a
    // directory size.
    let outcome = if stat.is_dir {
        RangeOutcome::Full
    } else {
        resolve_range(range_header, stat.size)
    };
    match outcome {
        RangeOutcome::Full => workspace.read_bytes_bounded(path).map(BinaryPlan::Full),
        RangeOutcome::Slice { start, len } => workspace
            .read_bytes_bounded_slice(path, start, len)
            .map(|reader| {
                // The handle's own window is authoritative; a file truncated
                // between stat and open can empty it, and an empty 206 is a lie.
                if reader.slice().1 == 0 {
                    BinaryPlan::Unsatisfiable(reader.stat().clone())
                } else {
                    BinaryPlan::Partial(reader)
                }
            }),
        RangeOutcome::Unsatisfiable => Ok(BinaryPlan::Unsatisfiable(stat)),
    }
}

/// Serve any binary file with uniform bounded range semantics. The response
/// advertises a strong validator derived from the opened representation's size
/// and nanosecond mtime. Fixed-length readers ignore later growth and turn
/// shrinkage into a body error, so a successful transfer always matches its
/// declared framing.
async fn binary_stream_response(
    workspace: Arc<chan_workspace::Workspace>,
    path: String,
    range_header: Option<String>,
    attachment: bool,
) -> Response {
    let plan_path = path.clone();
    let plan = tokio::task::spawn_blocking(move || {
        binary_plan_sync(&workspace, &plan_path, range_header.as_deref())
    })
    .await;
    let plan = match plan {
        Ok(Ok(plan)) => plan,
        Ok(Err(e)) => return err_from(&e),
        Err(join) => return err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    };
    stream_binary_plan(&path, plan, attachment, None)
}

#[cfg(test)]
async fn media_stream_response(
    workspace: Arc<chan_workspace::Workspace>,
    path: String,
    range_header: Option<String>,
) -> Response {
    binary_stream_response(workspace, path, range_header, false).await
}

#[derive(Default, Deserialize)]
pub struct ReadFileQuery {
    #[serde(default)]
    download: Option<String>,
    #[serde(default)]
    stream: Option<String>,
    #[serde(default)]
    root: Option<crate::routes::transfer::TransferRoot>,
}

pub(crate) fn query_flag(value: &Option<String>) -> bool {
    matches!(
        value.as_deref(),
        Some("1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON")
    )
}

pub async fn api_read_file(
    State(state): State<Arc<AppState>>,
    AxumPath(path): AxumPath<String>,
    Query(query): Query<ReadFileQuery>,
    headers: HeaderMap,
) -> Response {
    if query.root == Some(crate::routes::transfer::TransferRoot::Filesystem) {
        if !query_flag(&query.download) {
            return err(
                StatusCode::BAD_REQUEST,
                "filesystem root is available only for transfers".into(),
            );
        }
        return crate::routes::transfer::filesystem_download_response(&state, &path, &headers)
            .await;
    }
    // Editable-text files (.md / .txt) come back as FileResponse
    // JSON since the frontend's editor wants the content as a
    // string. Anything else (images, attachments) comes back as
    // raw bytes with a sniffed Content-Type so `<img src=...>`
    // pointing at /api/files/<path> resolves correctly.
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(e) => return err_state(&e),
    };
    // A live doc session is the authority for this path: every read
    // mode serves the session text under the session CAS token, so a
    // client about to attach sees exactly the bytes its snapshot will
    // carry, and an old client's read-modify-PUT loop stays
    // token-consistent with the PUT divert below.
    if let Some(session) = state.doc_sessions.get(&path) {
        let view = session.http_read_view();
        return read_via_session(
            &workspace,
            view.content,
            view.disk_mtime_ns,
            view.authority_version,
            view.disk_conflicted,
            &path,
            &query,
        )
        .await;
    }
    // Same divert for a live scene session: every read mode serves the
    // scene's file form (exactly what a flush would write) under the
    // session token.
    if let Some(session) = state.scene_sessions.get(&path) {
        let view = session.http_read_view();
        return read_via_session(
            &workspace,
            view.content,
            view.disk_mtime_ns,
            view.authority_version,
            view.disk_conflicted,
            &path,
            &query,
        )
        .await;
    }
    let range_header = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if query_flag(&query.download) {
        // Plan and stream ride one admission on the transfer lane. Planning
        // opens a file or walks a tree, so leaving it on the ambient pool is
        // what made bulk transfer draw from the pool serving editor saves and
        // terminal spawns. The tree is still pre-flighted readable inside the
        // plan, and the tar streams on the fly, so a cancel stages nothing.
        return stream_planned_workspace_download_tracked(
            &state.bulk_transfer,
            Some(state.events_tx.clone()),
            crate::routes::transfer::TransferTracking::from_headers(&headers),
            workspace,
            path,
            range_header,
        )
        .await;
    }

    if query_flag(&query.stream) {
        return stream_read_file_response(workspace, path).await;
    }

    let read_workspace = workspace.clone();
    let path_for_read = path.clone();
    let result =
        tokio::task::spawn_blocking(move || read_file_sync(&read_workspace, &path_for_read)).await;

    match result {
        Ok(Ok(ReadFileResult::Text {
            content,
            mtime,
            mtime_ns,
            writable,
            path_class,
        })) => Json(FileResponse {
            path_class,
            path,
            content,
            mtime,
            mtime_ns: mtime_ns.map(|ns| ns.to_string()),
            authority_version: None,
            disk_conflicted: false,
            writable,
            max_editable_bytes: chan_workspace::TEXT_WRITE_LIMIT,
        })
        .into_response(),
        Ok(Ok(ReadFileResult::Binary)) => {
            binary_stream_response(workspace, path, range_header, false).await
        }
        Ok(Ok(ReadFileResult::TooLarge { size, limit })) => err(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "file is {size} bytes; buffered editor reads are limited to {limit} bytes; use ?stream=1"
            ),
        ),
        Ok(Err(e)) => err_from(&e),
        Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ConflictResolutionAction {
    Reload,
    Overwrite,
}

#[derive(Deserialize)]
pub struct ConflictResolutionBody {
    path: String,
    action: ConflictResolutionAction,
}

/// Resolve retained disk divergence explicitly. Ordinary PUT remains
/// non-destructive while a session is conflicted; this route is the
/// only HTTP surface that may choose either retained side.
pub async fn api_resolve_session_conflict(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ConflictResolutionBody>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(e) => return err_state(&e),
    };

    if let Some(session) = state.doc_sessions.get(&body.path) {
        let resolved = match body.action {
            // Reload deliberately works in EVERY session state, not
            // just conflicts: it is the editor's "force reload from
            // disk", and it must adopt the live disk rather than a
            // retained capture that may lag further external writes.
            ConflictResolutionAction::Reload => session.reload_from_disk(&workspace).await,
            ConflictResolutionAction::Overwrite => {
                session
                    .overwrite_conflict(&workspace, &state.self_writes)
                    .await
            }
        };
        if !resolved {
            return err(
                StatusCode::CONFLICT,
                "document session conflict could not be resolved".into(),
            );
        }
        session.persist_recovery(&workspace).await;
        let view = session.http_read_view();
        return read_via_session(
            &workspace,
            view.content,
            view.disk_mtime_ns,
            view.authority_version,
            view.disk_conflicted,
            &body.path,
            &ReadFileQuery::default(),
        )
        .await;
    }

    if let Some(session) = state.scene_sessions.get(&body.path) {
        let resolved = match body.action {
            ConflictResolutionAction::Reload => session.reload_conflict(),
            ConflictResolutionAction::Overwrite => {
                session
                    .overwrite_conflict(&workspace, &state.self_writes)
                    .await
            }
        };
        if !resolved {
            return err(
                StatusCode::CONFLICT,
                "scene session conflict could not be resolved".into(),
            );
        }
        session.persist_recovery(&workspace).await;
        let view = session.http_read_view();
        return read_via_session(
            &workspace,
            view.content,
            view.disk_mtime_ns,
            view.authority_version,
            view.disk_conflicted,
            &body.path,
            &ReadFileQuery::default(),
        )
        .await;
    }

    // NOT_FOUND, not CONFLICT: the client's fallback decision hinges on
    // this. With no live session a plain re-fetch reads the disk
    // honestly; after a failed resolve on a LIVE session the diverted
    // GET would re-serve the authority, so the client must not fall
    // back there.
    err(
        StatusCode::NOT_FOUND,
        "path has no live document or scene session".into(),
    )
}

pub(crate) fn is_active_content_path(path: &str) -> bool {
    matches!(
        path.rsplit('.')
            .next()
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("svg" | "svgz" | "html" | "htm" | "xhtml" | "xml" | "pdf")
    )
}

/// Serve an attached path from its live session (doc or scene):
/// authority content under the session CAS token, in whichever of the
/// three read modes the query picked. The wire shapes are identical to
/// the disk path's, so the SPA and scripts cannot tell an attached
/// read from a disk read.
async fn read_via_session(
    workspace: &Arc<chan_workspace::Workspace>,
    content: String,
    token: Option<i64>,
    authority_version: u64,
    disk_conflicted: bool,
    path: &str,
    query: &ReadFileQuery,
) -> Response {
    let mtime = token.map(|ns| ns / 1_000_000_000);
    let mtime_ns = token.map(|ns| ns.to_string());
    if query_flag(&query.download) {
        return (
            [
                (header::CONTENT_TYPE, content_type_for(path).to_string()),
                (
                    header::CONTENT_DISPOSITION,
                    content_disposition_attachment(path),
                ),
            ],
            content,
        )
            .into_response();
    }
    // Classification and the write-bit probe touch the filesystem;
    // keep them off the async worker like every other read path.
    let ws = workspace.clone();
    let rel = path.to_string();
    let meta = tokio::task::spawn_blocking(move || {
        (
            path_class_for_wire(&ws, &rel),
            workspace_path_writable(&ws, &rel),
        )
    })
    .await;
    let (path_class, writable) = match meta {
        Ok(meta) => meta,
        Err(join) => return err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    };
    if query_flag(&query.stream) {
        // Meta + ONE chunk + Done: the authority text is already in
        // memory, so chunking buys nothing, but the frame sequence
        // matches the disk stream exactly.
        let frames = [
            ndjson_bytes(&FileStreamEvent::Meta {
                path,
                size: content.len() as u64,
                mtime,
                mtime_ns: mtime_ns.clone(),
                authority_version: Some(authority_version),
                disk_conflicted,
                path_class,
                writable,
                max_editable_bytes: chan_workspace::TEXT_WRITE_LIMIT,
            }),
            ndjson_bytes(&FileStreamEvent::Chunk {
                content: &content,
                bytes: content.len(),
            }),
            ndjson_bytes(&FileStreamEvent::Done),
        ];
        let mut body = Vec::new();
        for frame in frames {
            match frame {
                Ok(bytes) => body.extend_from_slice(&bytes),
                Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            }
        }
        return ([(header::CONTENT_TYPE, "application/x-ndjson")], body).into_response();
    }
    Json(FileResponse {
        path_class,
        path: path.to_string(),
        content,
        mtime,
        mtime_ns,
        authority_version: Some(authority_version),
        disk_conflicted,
        writable,
        max_editable_bytes: chan_workspace::TEXT_WRITE_LIMIT,
    })
    .into_response()
}

async fn stream_read_file_response(
    workspace: Arc<chan_workspace::Workspace>,
    path: String,
) -> Response {
    let (tx, mut rx) = mpsc::channel::<FileStreamMessage>(8);
    let path_for_read = path.clone();
    tokio::task::spawn_blocking(move || {
        let result = stream_read_file_sync(&workspace, &path_for_read, |bytes| {
            tx.blocking_send(FileStreamMessage::Data(bytes)).is_ok()
        });
        if let Err(e) = result {
            let _ = tx.blocking_send(FileStreamMessage::Error(e));
        }
    });

    let first = match rx.recv().await {
        Some(FileStreamMessage::Data(bytes)) => bytes,
        Some(FileStreamMessage::Error(e)) => return err_from(&e),
        None => {
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "file stream ended before metadata".into(),
            )
        }
    };
    let rest = stream::unfold(rx, |mut rx| async {
        rx.recv().await.map(|message| {
            let bytes = match message {
                FileStreamMessage::Data(bytes) => bytes,
                FileStreamMessage::Error(e) => ndjson_error_bytes(e.to_string()),
            };
            (Ok::<Bytes, Infallible>(bytes), rx)
        })
    });
    let body =
        Body::from_stream(stream::once(async move { Ok::<Bytes, Infallible>(first) }).chain(rest));
    ([(header::CONTENT_TYPE, "application/x-ndjson")], body).into_response()
}

#[derive(Default, Deserialize)]
pub struct WriteFileQuery {
    /// Legacy second-resolution disk CAS token.
    #[serde(default)]
    expected_mtime: Option<i64>,
    /// Preferred nanosecond disk CAS token. It remains a decimal
    /// string on the wire so browser clients never round it.
    #[serde(default)]
    expected_mtime_ns: Option<String>,
    /// Version of the live document or scene authority observed by
    /// the caller. Required with a disk token for changed content
    /// whenever an attached authority exists.
    #[serde(default)]
    authority_version: Option<u64>,
}

#[cfg(test)]
#[derive(Deserialize)]
pub struct WriteBody {
    content: String,
    expected_mtime: Option<i64>,
    expected_mtime_ns: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct WriteResponse {
    /// Mtime after the write. Frontend stores this as the next
    /// CAS token for subsequent saves so the client and disk stay
    /// in lock-step without an extra stat round-trip.
    pub(crate) mtime: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) mtime_ns: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) authority_version: Option<u64>,
    pub(crate) disk_conflicted: bool,
}

#[derive(Serialize)]
struct WriteConflictBody {
    /// Mtime currently on disk, returned so the client knows what
    /// token to use on a follow-up "overwrite" attempt without a
    /// separate stat call. None when the file disappeared between
    /// the client's last fetch and now (rare; treat as "create
    /// fresh" on the retry).
    current_mtime: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_mtime_ns: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_authority_version: Option<u64>,
    disk_conflicted: bool,
}

pub(crate) fn write_precondition_response(
    status: StatusCode,
    current_mtime_ns: Option<i64>,
    current_authority_version: Option<u64>,
    disk_conflicted: bool,
) -> Response {
    (
        status,
        Json(WriteConflictBody {
            current_mtime: current_mtime_ns.map(|ns| ns / 1_000_000_000),
            current_mtime_ns: current_mtime_ns.map(|ns| ns.to_string()),
            current_authority_version,
            disk_conflicted,
        }),
    )
        .into_response()
}

fn session_write_conflict_response(
    current_mtime_ns: Option<i64>,
    current_authority_version: u64,
    disk_conflicted: bool,
) -> Response {
    write_precondition_response(
        StatusCode::CONFLICT,
        current_mtime_ns,
        Some(current_authority_version),
        disk_conflicted,
    )
}

pub(crate) enum RequestBodyMessage {
    Chunk(Bytes),
    Complete,
    Failed(String),
}

async fn feed_request_body(body: Body, tx: mpsc::Sender<RequestBodyMessage>) {
    let mut stream = body.into_data_stream();
    while let Some(next) = stream.next().await {
        let message = match next {
            Ok(bytes) => RequestBodyMessage::Chunk(bytes),
            Err(error) => RequestBodyMessage::Failed(error.to_string()),
        };
        let terminal = matches!(message, RequestBodyMessage::Failed(_));
        if tx.send(message).await.is_err() || terminal {
            return;
        }
    }
    let _ = tx.send(RequestBodyMessage::Complete).await;
}

pub(crate) fn consume_request_body(
    rx: &mut mpsc::Receiver<RequestBodyMessage>,
    mut write_chunk: impl FnMut(&[u8]) -> chan_workspace::Result<()>,
) -> chan_workspace::Result<()> {
    loop {
        match rx.blocking_recv() {
            Some(RequestBodyMessage::Chunk(bytes)) => write_chunk(&bytes)?,
            Some(RequestBodyMessage::Complete) => return Ok(()),
            Some(RequestBodyMessage::Failed(error)) => {
                return Err(chan_workspace::ChanError::Io(format!(
                    "request body read failed: {error}"
                )));
            }
            None => {
                return Err(chan_workspace::ChanError::Io(
                    "request body ended before completion".into(),
                ));
            }
        }
    }
}

struct TextAccumulator {
    text: String,
    utf8_tail: Vec<u8>,
    written: u64,
    limit: u64,
}

impl TextAccumulator {
    fn new(limit: u64) -> Self {
        Self {
            text: String::new(),
            utf8_tail: Vec::with_capacity(4),
            written: 0,
            limit,
        }
    }

    fn write_chunk(&mut self, chunk: &[u8]) -> chan_workspace::Result<()> {
        let attempted = self
            .written
            .saturating_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX));
        if attempted > self.limit {
            return Err(chan_workspace::ChanError::WriteTooLarge {
                kind: "text",
                size: attempted,
                limit: self.limit,
            });
        }
        let mut offset = 0usize;
        if !self.utf8_tail.is_empty() {
            let needed = utf8_width(self.utf8_tail[0])
                .ok_or_else(invalid_request_utf8)?
                .saturating_sub(self.utf8_tail.len());
            if chunk.len() < needed {
                self.utf8_tail.extend_from_slice(chunk);
                self.written = attempted;
                return Ok(());
            }
            self.utf8_tail.extend_from_slice(&chunk[..needed]);
            let text = std::str::from_utf8(&self.utf8_tail).map_err(|_| invalid_request_utf8())?;
            self.text.push_str(text);
            self.utf8_tail.clear();
            offset = needed;
        }
        match std::str::from_utf8(&chunk[offset..]) {
            Ok(text) => self.text.push_str(text),
            Err(error) if error.error_len().is_none() => {
                let valid = &chunk[offset..offset + error.valid_up_to()];
                self.text
                    .push_str(std::str::from_utf8(valid).expect("valid_up_to is valid UTF-8"));
                self.utf8_tail
                    .extend_from_slice(&chunk[offset + error.valid_up_to()..]);
            }
            Err(_) => return Err(invalid_request_utf8()),
        }
        self.written = attempted;
        Ok(())
    }

    fn finish(self) -> chan_workspace::Result<String> {
        if self.utf8_tail.is_empty() {
            Ok(self.text)
        } else {
            Err(invalid_request_utf8())
        }
    }
}

fn utf8_width(first: u8) -> Option<usize> {
    match first {
        0x00..=0x7f => Some(1),
        0xc2..=0xdf => Some(2),
        0xe0..=0xef => Some(3),
        0xf0..=0xf4 => Some(4),
        _ => None,
    }
}

fn invalid_request_utf8() -> chan_workspace::ChanError {
    chan_workspace::ChanError::Io("raw text write body is not valid UTF-8".into())
}

pub(crate) async fn read_multipart_text_field(
    mut field: Field<'_>,
) -> chan_workspace::Result<String> {
    const METADATA_LIMIT: u64 = 64 * 1024;
    let mut accumulator = TextAccumulator::new(METADATA_LIMIT);
    while let Some(bytes) = field
        .chunk()
        .await
        .map_err(|error| chan_workspace::ChanError::Io(error.to_string()))?
    {
        accumulator.write_chunk(&bytes)?;
    }
    accumulator.finish()
}

pub(crate) async fn accumulate_text_body(body: Body, limit: u64) -> chan_workspace::Result<String> {
    let (tx, mut rx) = mpsc::channel(8);
    let consumer = tokio::task::spawn_blocking(move || {
        let mut accumulator = TextAccumulator::new(limit);
        consume_request_body(&mut rx, |chunk| accumulator.write_chunk(chunk))?;
        accumulator.finish()
    });
    feed_request_body(body, tx).await;
    consumer
        .await
        .map_err(|error| chan_workspace::ChanError::Io(error.to_string()))?
}

async fn write_streamed_text(
    workspace: Arc<chan_workspace::Workspace>,
    path: String,
    preconditions: WritePreconditions,
    self_writes: Arc<crate::self_writes::SelfWrites>,
    body: Body,
) -> chan_workspace::Result<FileStat> {
    let (tx, mut rx) = mpsc::channel(8);
    let consumer = tokio::task::spawn_blocking(move || {
        let writable = workspace.ensure_writable(&path)?;
        let current_mtime_ns = writable.stat.as_ref().and_then(|stat| stat.mtime_ns);
        match check_write_preconditions(current_mtime_ns, None, false, preconditions) {
            Ok(()) => {}
            Err(WritePreconditionError::Conflict) => {
                return Err(chan_workspace::ChanError::WriteConflict { current_mtime_ns });
            }
            Err(WritePreconditionError::Required) => {
                return Err(chan_workspace::ChanError::Io(
                    "disk write unexpectedly required an authority precondition".into(),
                ));
            }
        }
        let mut reservation = None;
        let result = workspace.write_atomic_stream(&path, AtomicWriteKind::Text, |sink| {
            consume_request_body(&mut rx, |chunk| sink.write_chunk(chunk))?;
            reservation = Some(self_writes.reserve_after_preflight(&path));
            Ok(())
        });
        match result {
            Ok(stat) => Ok(stat),
            Err(error) => {
                if let Some(reservation) = reservation {
                    self_writes.cancel(reservation);
                }
                Err(error)
            }
        }
    });
    feed_request_body(body, tx).await;
    consumer
        .await
        .map_err(|error| chan_workspace::ChanError::Io(error.to_string()))?
}

pub async fn api_write_file(
    State(state): State<Arc<AppState>>,
    AxumPath(path): AxumPath<String>,
    Query(query): Query<WriteFileQuery>,
    body: Body,
) -> Response {
    let expected_mtime_ns = match parse_optional_mtime_ns(query.expected_mtime_ns.as_deref()) {
        Ok(mtime_ns) => mtime_ns,
        Err(message) => return err(StatusCode::BAD_REQUEST, message),
    };
    let preconditions = WritePreconditions {
        expected_mtime: query.expected_mtime,
        expected_mtime_ns,
        authority_version: query.authority_version,
    };
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(e) => return err_state(&e),
    };
    // A live doc session is the authority for this path: divert the
    // write into the session. CAS runs against the SESSION token (the
    // same token the GET divert serves and flush frames carry), the
    // body lands as a synthetic `$http` update fanned live to every
    // attachment, and the reply awaits a forced flush so a 200 keeps
    // meaning "bytes on disk". flush_session notes the self-write
    // itself, so the early note below stays disk-path-only.
    //
    // Exception: a session in the removed state (file deleted)
    // deliberately flushes nothing, so an equal-content PUT
    // would 200 with the file still absent. A PUT there is an explicit
    // re-create intent: take the classic disk path below (which
    // recreates) and let the reconciler fold the new file back into
    // the session. Conflicted sessions always stay on the divert,
    // including a delete conflict whose disk token is None.
    if let Some(session) = state.doc_sessions.get(&path) {
        if session.diverts_http_write() {
            let view = session.http_write_view();
            if view.conflict_mtime_ns.is_some() {
                return session_write_conflict_response(
                    view.conflict_mtime_ns.flatten(),
                    view.authority_version,
                    true,
                );
            }
            let content = match accumulate_text_body(body, view.write_budget).await {
                Ok(content) => content,
                Err(error) => return err_from(&error),
            };
            return write_via_session(&state, &workspace, &session, preconditions, &content).await;
        }
    }
    // Same divert for a live scene session: CAS against the session
    // token, the body becomes the scene authority through the replace
    // semantics, and the reply awaits a forced flush. The removed-state
    // fall-through matches the doc divert above.
    if let Some(session) = state.scene_sessions.get(&path) {
        if session.diverts_http_write() {
            let view = session.http_write_view();
            if view.conflict_mtime_ns.is_some() {
                return session_write_conflict_response(
                    view.conflict_mtime_ns.flatten(),
                    view.authority_version,
                    true,
                );
            }
            let content = match accumulate_text_body(body, view.write_budget).await {
                Ok(content) => content,
                Err(error) => return err_from(&error),
            };
            return write_via_scene_session(&state, &workspace, &session, preconditions, &content)
                .await;
        }
    }
    let result = write_streamed_text(
        workspace,
        path,
        preconditions,
        Arc::clone(&state.self_writes),
        body,
    )
    .await;
    let stat = match result {
        Ok(stat) => stat,
        Err(chan_workspace::ChanError::WriteConflict { current_mtime_ns }) => {
            return write_precondition_response(
                StatusCode::CONFLICT,
                current_mtime_ns,
                None,
                false,
            );
        }
        Err(error) => return err_from(&error),
    };
    Json(WriteResponse {
        mtime: stat.mtime,
        mtime_ns: stat.mtime_ns.map(|ns| ns.to_string()),
        authority_version: None,
        disk_conflicted: false,
    })
    .into_response()
}

/// Write an attached path through its doc session: CAS against the
/// session token, apply as a `$http` update, force and await a flush,
/// answer with the post-flush token. Status shapes (200 WriteResponse,
/// 409 WriteConflictBody) match the disk path exactly; a failed forced
/// flush answers 503 with the content retained in the session. One
/// deliberate divergence from the disk path: a stale token whose body
/// is byte-identical to the authority text answers 200 (token-adopt)
/// instead of 409, because equal bytes cannot lose an update. An
/// unresolved session conflict takes precedence and always answers 409
/// with the conflicting disk token.
async fn write_via_session(
    state: &Arc<AppState>,
    workspace: &Arc<chan_workspace::Workspace>,
    session: &Arc<DocSession>,
    preconditions: WritePreconditions,
    content: &str,
) -> Response {
    match session.apply_http_replace("$http", content, preconditions) {
        Ok(DocHttpReplaceOutcome::Applied) => {}
        Ok(DocHttpReplaceOutcome::PreconditionRequired {
            current_version,
            disk_mtime_ns,
        }) => {
            return write_precondition_response(
                StatusCode::PRECONDITION_REQUIRED,
                disk_mtime_ns,
                Some(current_version),
                false,
            );
        }
        Ok(DocHttpReplaceOutcome::Stale {
            current_version,
            disk_mtime_ns,
        }) => {
            return session_write_conflict_response(disk_mtime_ns, current_version, false);
        }
        Ok(DocHttpReplaceOutcome::Conflicted { disk_mtime_ns }) => {
            let version = session.http_write_view().authority_version;
            return session_write_conflict_response(disk_mtime_ns, version, true);
        }
        Err(e) => {
            // DocTooLarge is the only reachable variant here:
            // replace_diff trims on char boundaries and spans the
            // document exactly.
            return err(StatusCode::PAYLOAD_TOO_LARGE, e.to_string());
        }
    }
    // A conflict that arrives between replace and flush is still a
    // 409. Other failed forced flushes answer 503: the content is
    // authoritative in the session and every client (a retried PUT
    // re-applies idempotently), but a 200 must keep meaning "bytes on
    // disk".
    if !flush_session(session, workspace, &state.self_writes).await {
        let view = session.http_write_view();
        if let Some(disk_mtime_ns) = view.conflict_mtime_ns {
            return session_write_conflict_response(disk_mtime_ns, view.authority_version, true);
        }
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "doc session accepted the write but the disk flush failed; retry".into(),
        );
    }
    let view = session.http_write_view();
    Json(WriteResponse {
        mtime: view.disk_mtime_ns.map(|ns| ns / 1_000_000_000),
        mtime_ns: view.disk_mtime_ns.map(|ns| ns.to_string()),
        authority_version: Some(view.authority_version),
        disk_conflicted: false,
    })
    .into_response()
}

/// Write an attached path through its scene session: CAS against the
/// session token, adopt the body as the scene authority (bumped
/// versions and tombstones fan live to every canvas), force and await
/// a flush, answer with the post-flush token. Status shapes match the
/// disk path. An unresolved session conflict takes precedence and
/// answers 409 with the conflicting disk token; otherwise a body that
/// is not a usable scene is a 400 and never touches the session.
async fn write_via_scene_session(
    state: &Arc<AppState>,
    workspace: &Arc<chan_workspace::Workspace>,
    session: &Arc<SceneSession>,
    preconditions: WritePreconditions,
    content: &str,
) -> Response {
    match session.apply_http_replace(content, preconditions) {
        Ok(SceneHttpReplaceOutcome::Applied) => {}
        Ok(SceneHttpReplaceOutcome::PreconditionRequired {
            current_version,
            disk_mtime_ns,
        }) => {
            return write_precondition_response(
                StatusCode::PRECONDITION_REQUIRED,
                disk_mtime_ns,
                Some(current_version),
                false,
            );
        }
        Ok(SceneHttpReplaceOutcome::Stale {
            current_version,
            disk_mtime_ns,
        }) => {
            return session_write_conflict_response(disk_mtime_ns, current_version, false);
        }
        Ok(SceneHttpReplaceOutcome::Conflicted { disk_mtime_ns }) => {
            let version = session.http_write_view().authority_version;
            return session_write_conflict_response(disk_mtime_ns, version, true);
        }
        Err(e) => {
            return match e {
                SceneError::Invalid(_) => err(StatusCode::BAD_REQUEST, e.to_string()),
                SceneError::TooLarge { .. } => err(StatusCode::PAYLOAD_TOO_LARGE, e.to_string()),
            };
        }
    }
    // A conflict that arrives between replace and flush is still a
    // 409. Other failed forced flushes answer 503: the content is
    // authoritative in the session and every client (a retried PUT
    // re-applies idempotently), but a 200 must keep meaning "bytes on
    // disk".
    if !flush_scene_session(session, workspace, &state.self_writes).await {
        let view = session.http_write_view();
        if let Some(disk_mtime_ns) = view.conflict_mtime_ns {
            return session_write_conflict_response(disk_mtime_ns, view.authority_version, true);
        }
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "scene session accepted the write but the disk flush failed; retry".into(),
        );
    }
    let view = session.http_write_view();
    Json(WriteResponse {
        mtime: view.disk_mtime_ns.map(|ns| ns / 1_000_000_000),
        mtime_ns: view.disk_mtime_ns.map(|ns| ns.to_string()),
        authority_version: Some(view.authority_version),
        disk_conflicted: false,
    })
    .into_response()
}

pub(crate) fn parse_optional_mtime_ns(value: Option<&str>) -> Result<Option<i64>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Err("expected_mtime_ns must be a decimal nanosecond timestamp".into());
    }
    value
        .parse::<i64>()
        .map(Some)
        .map_err(|_| "expected_mtime_ns must be a decimal nanosecond timestamp".into())
}

#[cfg(test)]
fn write_file_sync(
    workspace: &chan_workspace::Workspace,
    path: &str,
    expected_mtime: Option<i64>,
    expected_mtime_ns: Option<i64>,
    content: &str,
) -> chan_workspace::Result<(Option<i64>, Option<i64>)> {
    let writable = workspace.ensure_writable(path)?;
    let current_mtime_ns = writable.stat.as_ref().and_then(|stat| stat.mtime_ns);
    check_write_preconditions(
        current_mtime_ns,
        None,
        false,
        WritePreconditions {
            expected_mtime,
            expected_mtime_ns,
            authority_version: None,
        },
    )
    .map_err(|_| chan_workspace::ChanError::WriteConflict { current_mtime_ns })?;
    workspace.write_text(path, content)?;
    let stat = workspace.stat(path)?;
    Ok((stat.mtime, stat.mtime_ns))
}

#[derive(Deserialize)]
pub struct CreateBody {
    pub(crate) path: String,
    pub(crate) is_dir: bool,
    /// Optional initial contents for files. Ignored for directories.
    pub(crate) content: Option<String>,
}

pub async fn api_create_file(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateBody>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(e) => return err_state(&e),
    };
    let path = body.path.clone();
    // Record the self-write before the blocking create so the
    // watcher's echo is suppressed without racing the await; see
    // api_write_file for the full rationale.
    state.self_writes.note(&path);
    let result = tokio::task::spawn_blocking(move || create_file_sync(&workspace, body)).await;
    match result {
        Ok(Ok(())) => StatusCode::CREATED.into_response(),
        Ok(Err(e)) => err_from(&e),
        Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    }
}

fn create_file_sync(
    workspace: &chan_workspace::Workspace,
    body: CreateBody,
) -> chan_workspace::Result<()> {
    if create_target_exists(workspace, &body.path) {
        return Err(chan_workspace::ChanError::PathAlreadyExists(body.path));
    }
    if body.is_dir {
        workspace.create_dir(&body.path)
    } else {
        workspace.write_text(&body.path, &body.content.unwrap_or_default())
    }
}

fn create_target_exists(workspace: &chan_workspace::Workspace, path: &str) -> bool {
    workspace.stat(path).is_ok()
}

#[derive(Debug, Serialize)]
pub(crate) struct UploadFileResponse {
    pub(crate) path: String,
    pub(crate) size: u64,
}

pub async fn api_upload_file(
    State(state): State<Arc<AppState>>,
    Query(root): Query<UploadRootQuery>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Response {
    if root.root == Some(crate::routes::transfer::TransferRoot::Filesystem) {
        return crate::routes::transfer::filesystem_upload_response(state, headers, multipart)
            .await;
    }
    workspace_upload_response(state, headers, multipart).await
}

#[derive(Default, Deserialize)]
pub struct UploadRootQuery {
    #[serde(default)]
    root: Option<crate::routes::transfer::TransferRoot>,
}

async fn workspace_upload_response(
    state: Arc<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Response {
    let mut dir = String::new();
    let mut replace_path: Option<String> = None;
    let mut destination_seen = false;
    loop {
        match multipart.next_field().await {
            Ok(Some(field)) => {
                let name = field.name().unwrap_or("").to_owned();
                match name.as_str() {
                    "file" => {
                        if !destination_seen {
                            return err(
                                StatusCode::BAD_REQUEST,
                                "`dir` or `path` must precede the streaming `file` part".into(),
                            );
                        }
                        let filename = field.file_name().unwrap_or("").to_owned();
                        let workspace = match state.try_workspace() {
                            Ok(workspace) => workspace,
                            Err(e) => return err_state(&e),
                        };
                        return stream_workspace_upload(
                            &state.bulk_transfer,
                            Some(state.events_tx.clone()),
                            crate::routes::transfer::TransferTracking::from_headers(&headers),
                            workspace,
                            Arc::clone(&state.self_writes),
                            UploadDestination {
                                dir,
                                replace_path,
                                filename,
                            },
                            field,
                        )
                        .await;
                    }
                    "dir" => match read_multipart_text_field(field).await {
                        Ok(s) => {
                            dir = s;
                            destination_seen = true;
                        }
                        Err(e) => {
                            return err(StatusCode::BAD_REQUEST, format!("multipart read: {e}"));
                        }
                    },
                    "path" => match read_multipart_text_field(field).await {
                        Ok(s) => {
                            replace_path = Some(s);
                            destination_seen = true;
                        }
                        Err(e) => {
                            return err(StatusCode::BAD_REQUEST, format!("multipart read: {e}"));
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

/// Admit one workspace upload and write it inside a SINGLE lane job.
///
/// Mirrors the terminal upload: the job is the writer, admitted before the
/// first body byte is pulled, so a refusal has read nothing and resolved no
/// destination, and the async half only moves the multipart field into the
/// job's bounded channel. Returning early drops the job, which cancels it and
/// releases its slot.
/// Where one upload lands, as the multipart parts named it and before the
/// target is resolved. Grouped so the admitted path stays inside clippy's
/// argument budget without an allow.
pub(crate) struct UploadDestination {
    pub(crate) dir: String,
    pub(crate) replace_path: Option<String>,
    pub(crate) filename: String,
}

async fn stream_workspace_upload(
    bulk: &crate::bulk_transfer::BulkTransferTenant,
    events: Option<tokio::sync::broadcast::Sender<String>>,
    tracking: Option<crate::routes::transfer::TransferTracking>,
    workspace: Arc<chan_workspace::Workspace>,
    self_writes: Arc<crate::self_writes::SelfWrites>,
    destination: UploadDestination,
    mut field: Field<'_>,
) -> Response {
    let (tx, mut rx) = mpsc::channel(8);
    let job = match bulk.submit(move |cancel| {
        workspace_upload_stream_sync(&workspace, &self_writes, &destination, &mut rx, cancel)
    }) {
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
            Ok(Some(bytes)) => RequestBodyMessage::Chunk(bytes),
            Ok(None) => RequestBodyMessage::Complete,
            Err(error) => RequestBodyMessage::Failed(error.to_string()),
        };
        let terminal = !matches!(message, RequestBodyMessage::Chunk(_));
        if tx.send(message).await.is_err() || terminal {
            break;
        }
    }
    drop(tx);
    match job.outcome().await {
        crate::bulk_transfer::BulkOutcome::Done(Ok(upload)) => Json(upload).into_response(),
        crate::bulk_transfer::BulkOutcome::Done(Err(error)) => err_from(&error),
        // Cancellation, lane shutdown and a panicked job are reported
        // identically and cannot be told apart here. All three mean the write
        // did not complete and nothing was persisted.
        crate::bulk_transfer::BulkOutcome::Cancelled => err(
            StatusCode::SERVICE_UNAVAILABLE,
            "upload did not complete".into(),
        ),
    }
}

fn workspace_upload_stream_sync(
    workspace: &chan_workspace::Workspace,
    self_writes: &crate::self_writes::SelfWrites,
    destination: &UploadDestination,
    rx: &mut mpsc::Receiver<RequestBodyMessage>,
    cancel: &crate::bulk_transfer::BulkCancel,
) -> chan_workspace::Result<UploadFileResponse> {
    let rel = workspace_upload_target(
        workspace,
        &destination.dir,
        destination.replace_path.as_deref(),
        &destination.filename,
    )?;
    let mut reservation = None;
    let result = workspace.write_atomic_stream(&rel, AtomicWriteKind::Bytes, |sink| {
        // Checked per chunk rather than once, so an abandoned upload returns
        // its admission slot within one chunk's work. The atomic writer's temp
        // file is discarded on this error, so nothing is left behind and the
        // target is untouched.
        consume_request_body(rx, |chunk| {
            if cancel.is_cancelled() {
                return Err(chan_workspace::ChanError::Io(
                    "upload cancelled before it completed".into(),
                ));
            }
            sink.write_chunk(chunk)
        })?;
        reservation = Some(self_writes.reserve_after_preflight(&rel));
        Ok(())
    });
    match result {
        Ok(stat) => Ok(UploadFileResponse {
            path: rel,
            size: stat.size,
        }),
        Err(error) => {
            if let Some(reservation) = reservation {
                self_writes.cancel(reservation);
            }
            Err(error)
        }
    }
}

fn workspace_upload_target(
    workspace: &chan_workspace::Workspace,
    dir: &str,
    replace_path: Option<&str>,
    original_name: &str,
) -> chan_workspace::Result<String> {
    if let Some(path) = replace_path {
        let trimmed = path.trim_matches('/');
        chan_workspace::fs_ops::validate_rel(trimmed)?;
        let stat = workspace.stat(trimmed)?;
        if stat.is_dir {
            return Err(chan_workspace::ChanError::Io(format!(
                "not a file: {trimmed}"
            )));
        }
        return Ok(trimmed.to_string());
    }

    let dir = normalize_dir_query(dir)?;
    if !dir.is_empty() {
        let stat = workspace.stat(&dir)?;
        if !stat.is_dir {
            return Err(chan_workspace::ChanError::Io(format!(
                "not a directory: {dir}"
            )));
        }
    }
    let filename = upload_leaf_filename(original_name)?;
    let rel = join_rel(&dir, &filename);
    if create_target_exists(workspace, &rel) {
        return Err(chan_workspace::ChanError::PathAlreadyExists(rel));
    }
    Ok(rel)
}

#[cfg(test)]
fn replace_file_sync(
    workspace: &chan_workspace::Workspace,
    path: &str,
    bytes: &[u8],
) -> chan_workspace::Result<UploadFileResponse> {
    let trimmed = path.trim_matches('/');
    chan_workspace::fs_ops::validate_rel(trimmed)?;
    let stat = workspace.stat(trimmed)?;
    if stat.is_dir {
        return Err(chan_workspace::ChanError::Io(format!(
            "not a file: {trimmed}"
        )));
    }
    workspace.ensure_writable(trimmed)?;
    workspace.write_bytes(trimmed, bytes)?;
    Ok(UploadFileResponse {
        path: trimmed.to_string(),
        size: bytes.len() as u64,
    })
}

#[cfg(test)]
fn upload_file_sync(
    workspace: &chan_workspace::Workspace,
    dir: &str,
    original_name: &str,
    bytes: &[u8],
) -> chan_workspace::Result<UploadFileResponse> {
    let dir = normalize_dir_query(dir)?;
    if !dir.is_empty() {
        let stat = workspace.stat(&dir)?;
        if !stat.is_dir {
            return Err(chan_workspace::ChanError::Io(format!(
                "not a directory: {dir}"
            )));
        }
    }
    let filename = upload_leaf_filename(original_name)?;
    let rel = join_rel(&dir, &filename);
    if create_target_exists(workspace, &rel) {
        return Err(chan_workspace::ChanError::PathAlreadyExists(rel));
    }
    workspace.ensure_writable(&rel)?;
    workspace.write_bytes(&rel, bytes)?;
    Ok(UploadFileResponse {
        path: rel,
        size: bytes.len() as u64,
    })
}

pub(crate) fn upload_leaf_filename(original_name: &str) -> chan_workspace::Result<String> {
    let leaf = original_name
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim();
    if leaf.is_empty() {
        return Err(chan_workspace::ChanError::PathEmpty);
    }
    if leaf == "." || leaf == ".." || leaf.contains('\0') {
        return Err(chan_workspace::ChanError::PathEscape);
    }
    chan_workspace::fs_ops::validate_rel(leaf)?;
    Ok(leaf.to_string())
}

#[cfg(test)]
#[cfg_attr(not(target_os = "linux"), allow(unused_imports, dead_code))]
mod file_browser_listing_tests {
    use super::{
        append_dir_to_archive, create_target_exists, download_path_sync, list_dir_entries,
        list_files_sync, replace_file_sync, upload_file_sync, upload_leaf_filename,
        workspace_path_writable, DownloadPayload, ListFilesQuery,
    };

    #[test]
    fn list_files_sync_surfaces_drafts_dir_as_normal_in_root_folder() {
        // The drafts dir is a real in-root directory now, so the File
        // Browser lists it like any other folder (no metadata escape
        // hatch, no synthetic hiding) in both the recursive whole-tree
        // listing and the per-directory root listing.
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        std::fs::write(root.path().join("note.md"), "hi").unwrap();
        workspace
            .write_text(".Drafts/untitled-1/draft.md", "# draft\n")
            .unwrap();

        // Recursive whole-tree listing (dir = None) descends into .Drafts.
        let recursive = list_files_sync(&workspace, ListFilesQuery { dir: None }).unwrap();
        assert!(recursive
            .iter()
            .any(|entry| entry.path == ".Drafts/untitled-1/draft.md"));
        assert!(recursive.iter().any(|entry| entry.path == "note.md"));

        // Per-directory root listing (dir = "") shows .Drafts as a child.
        let root_dir = list_files_sync(
            &workspace,
            ListFilesQuery {
                dir: Some(String::new()),
            },
        )
        .unwrap();
        assert!(root_dir
            .iter()
            .any(|entry| entry.path == ".Drafts" && entry.is_dir));
        assert!(root_dir.iter().any(|entry| entry.path == "note.md"));
    }

    #[test]
    fn list_files_sync_distinguishes_missing_root_from_empty_workspace() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        let root_path = workspace.root().to_path_buf();
        std::fs::remove_dir_all(&root_path).expect("remove harness-owned workspace");

        let error = match list_files_sync(
            &workspace,
            ListFilesQuery {
                dir: Some(String::new()),
            },
        ) {
            Err(error) => error,
            Ok(_) => panic!("a missing root must not look like an empty file tree"),
        };
        assert!(
            matches!(
                error,
                chan_workspace::ChanError::WorkspaceRootMissing(ref missing)
                    if missing == &root_path
            ),
            "unexpected listing error: {error}"
        );
        assert!(!root_path.exists(), "listing recreated the workspace root");
    }

    #[test]
    fn list_dir_entries_lists_inside_drafts_dir() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace
            .write_text(".Drafts/untitled-1/draft.md", "# draft\n")
            .unwrap();

        let entries = list_dir_entries(&workspace, ".Drafts").unwrap();

        assert!(entries
            .iter()
            .any(|entry| entry.path == ".Drafts/untitled-1" && entry.is_dir));
    }

    #[test]
    fn create_target_exists_counts_directories_as_collisions() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.create_dir("notes").unwrap();

        assert!(create_target_exists(&workspace, "notes"));
        assert!(!create_target_exists(&workspace, "missing"));
    }

    #[test]
    fn upload_file_sync_writes_binary_with_original_leaf_name() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.create_dir("assets").unwrap();

        let uploaded = upload_file_sync(&workspace, "assets", "photo 1.PNG", &[1, 2, 3]).unwrap();

        assert_eq!(uploaded.path, "assets/photo 1.PNG");
        assert_eq!(uploaded.size, 3);
        assert_eq!(workspace.read("assets/photo 1.PNG").unwrap(), vec![1, 2, 3]);
    }

    #[test]
    fn upload_file_sync_rejects_existing_target() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.write_bytes("same.bin", b"old").unwrap();

        let err = upload_file_sync(&workspace, "", "same.bin", b"new").unwrap_err();

        assert!(matches!(err, chan_workspace::ChanError::PathAlreadyExists(p) if p == "same.bin"));
        assert_eq!(workspace.read("same.bin").unwrap(), b"old");
    }

    #[test]
    fn download_path_sync_archives_a_readable_directory_tree() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.create_dir("docs").unwrap();
        workspace.write_bytes("docs/a.txt", b"a").unwrap();
        workspace.write_bytes("docs/b.txt", b"b").unwrap();

        // The readability pre-flight passes for an ordinary tree; the stream
        // then builds the tar via the same append_dir_to_archive walk.
        let payload = download_path_sync(&workspace, "docs", None).unwrap();
        assert!(matches!(payload, DownloadPayload::Directory));
        let mut bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut bytes);
            append_dir_to_archive(&mut builder, &workspace, "docs", "docs").unwrap();
            builder.finish().unwrap();
        }
        assert!(!bytes.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn download_path_sync_preflights_an_unreadable_workspace_file() {
        use std::os::unix::fs::PermissionsExt;
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.create_dir("docs").unwrap();
        workspace.write_bytes("docs/secret.txt", b"x").unwrap();
        let secret = root.path().join("docs/secret.txt");
        std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root bypasses permission bits; only assert when the chmod truly denies.
        if std::fs::File::open(&secret).is_ok() {
            return;
        }
        let message = match download_path_sync(&workspace, "docs", None) {
            Ok(_) => panic!("expected an unreadable-file error"),
            Err(e) => e.to_string(),
        };
        assert!(
            message.contains("secret.txt"),
            "error should name the file: {message}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn canonical_preflight_rejects_an_unwritable_upload_destination() {
        use std::os::unix::fs::PermissionsExt;
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.create_dir("locked").unwrap();
        let locked = root.path().join("locked");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
        let err = upload_file_sync(&workspace, "locked", "x.txt", b"data").unwrap_err();
        let message = err.to_string();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(message.contains("read-only"), "{message}");
        assert!(
            !root.path().join("locked/x.txt").exists(),
            "a rejected upload writes nothing"
        );
    }

    #[cfg(unix)]
    #[test]
    fn writable_metadata_projects_the_canonical_preflight() {
        use std::os::unix::fs::PermissionsExt;

        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.write_text("note.md", "old").unwrap();
        workspace.create_dir("notes").unwrap();

        assert!(workspace_path_writable(&workspace, "note.md"));
        assert!(!workspace_path_writable(&workspace, "notes"));

        let note = root.path().join("note.md");
        std::fs::set_permissions(&note, std::fs::Permissions::from_mode(0o444)).unwrap();
        assert!(!workspace_path_writable(&workspace, "note.md"));

        std::fs::set_permissions(&note, std::fs::Permissions::from_mode(0o644)).unwrap();
    }

    #[test]
    fn replace_file_sync_overwrites_existing_file() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.write_text("same.md", "old").unwrap();

        let uploaded = replace_file_sync(&workspace, "same.md", b"new").unwrap();

        assert_eq!(uploaded.path, "same.md");
        assert_eq!(uploaded.size, 3);
        assert_eq!(workspace.read_text("same.md").unwrap(), "new");
    }

    #[test]
    fn replace_file_sync_rejects_non_utf8_for_text_file() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.write_text("same.md", "old").unwrap();

        let err = replace_file_sync(&workspace, "same.md", &[0xff, 0xfe]).unwrap_err();

        assert!(err
            .to_string()
            .contains("non-UTF-8 bytes to editable text file"));
        assert_eq!(workspace.read_text("same.md").unwrap(), "old");
    }

    #[test]
    fn replace_file_sync_rejects_directory_target() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.create_dir("notes").unwrap();

        let err = replace_file_sync(&workspace, "notes", b"new").unwrap_err();

        assert!(err.to_string().contains("not a file: notes"));
    }

    #[test]
    fn upload_leaf_filename_uses_basename_and_rejects_empty_names() {
        assert_eq!(
            upload_leaf_filename(r"C:\tmp\report.pdf").unwrap(),
            "report.pdf"
        );
        assert!(matches!(
            upload_leaf_filename(""),
            Err(chan_workspace::ChanError::PathEmpty)
        ));
        assert!(matches!(
            upload_leaf_filename(".."),
            Err(chan_workspace::ChanError::PathEscape)
        ));
    }
}

#[cfg(test)]
mod write_tests {
    use super::*;

    #[test]
    fn read_file_sync_returns_editable_text_metadata() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.write_text("note.md", "hello").unwrap();

        let result = read_file_sync(&workspace, "note.md").unwrap();

        match result {
            ReadFileResult::Text {
                content,
                mtime,
                mtime_ns,
                writable,
                path_class,
            } => {
                assert_eq!(content, "hello");
                assert!(mtime.is_some());
                assert!(mtime_ns.is_some());
                assert!(writable);
                assert_eq!(
                    path_class.map(|class| class.kind),
                    Some(chan_workspace::PathKind::RegularFile)
                );
            }
            ReadFileResult::Binary | ReadFileResult::TooLarge { .. } => {
                panic!("expected editable text result")
            }
        }
    }

    #[test]
    fn read_file_sync_returns_binary_bytes() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        std::fs::write(root.path().join("image.bin"), [0, 1, 2, 3]).unwrap();

        let result = read_file_sync(&workspace, "image.bin").unwrap();

        assert!(matches!(result, ReadFileResult::Binary));
    }

    #[test]
    fn read_file_sync_serves_svg_as_binary_despite_text_content() {
        // An SVG is XML text and would pass the editable-text content
        // sniff, but Image-class paths must come back as raw bytes so
        // `<img src=/api/files/x.svg>` renders (the route pairs the
        // Binary arm with content_type_for -> image/svg+xml). The
        // editor never opens Image-class paths as text, so nothing
        // loses the text view. Fragment-bearing embeds
        // (`./x.svg#w=250`) never reach this layer: the widget strips
        // the fragment from the fetch URL client-side.
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n";
        std::fs::write(root.path().join("logo.svg"), svg).unwrap();

        assert!(matches!(
            read_file_sync(&workspace, "logo.svg").unwrap(),
            ReadFileResult::Binary
        ));
    }

    #[test]
    fn read_file_sync_sniffs_unknown_extension_text_as_text() {
        // An odd-suffix text file the extension classifier can't
        // type (here `.service`) must still open in the editor. Created
        // via std::fs because write_text only creates known-text paths.
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        std::fs::write(
            root.path().join("deploy.service"),
            "[Unit]\nDescription=demo\n",
        )
        .unwrap();

        match read_file_sync(&workspace, "deploy.service").unwrap() {
            ReadFileResult::Text { content, .. } => {
                assert_eq!(content, "[Unit]\nDescription=demo\n");
            }
            ReadFileResult::Binary | ReadFileResult::TooLarge { .. } => {
                panic!("expected sniffed text result")
            }
        }
    }

    #[test]
    fn buffered_text_read_reports_the_shared_editable_limit() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        std::fs::File::create(root.path().join("oversized.md"))
            .unwrap()
            .set_len(chan_workspace::TEXT_WRITE_LIMIT + 1)
            .unwrap();

        assert!(matches!(
            read_file_sync(&workspace, "oversized.md").unwrap(),
            ReadFileResult::TooLarge {
                size,
                limit: chan_workspace::TEXT_WRITE_LIMIT,
            } if size == chan_workspace::TEXT_WRITE_LIMIT + 1
        ));
    }

    #[test]
    fn list_files_sync_resolves_pending_kind_per_dir() {
        // Per-directory listings sniff Other-class files so the file
        // browser shows a final text/binary kind, never "pending".
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        std::fs::create_dir(root.path().join("cfg")).unwrap();
        std::fs::write(root.path().join("cfg/zshrc-like"), "export A=1\n").unwrap();
        std::fs::write(root.path().join("cfg/blob"), [0u8, 1, 2, 0]).unwrap();

        let out = list_files_sync(
            &workspace,
            ListFilesQuery {
                dir: Some("cfg".to_string()),
            },
        )
        .unwrap();

        let kind_of = |name: &str| {
            out.iter()
                .find(|e| e.path == format!("cfg/{name}"))
                .and_then(|e| e.kind)
        };
        assert_eq!(kind_of("zshrc-like"), Some("text"));
        assert_eq!(kind_of("blob"), Some("binary"));
    }

    #[test]
    fn stream_read_file_sync_emits_meta_chunks_done_in_order() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.write_text("note.md", "hello").unwrap();
        let mut lines = Vec::new();

        stream_read_file_sync(&workspace, "note.md", |bytes| {
            lines.push(String::from_utf8(bytes.to_vec()).unwrap());
            true
        })
        .unwrap();

        let events: Vec<serde_json::Value> = lines
            .iter()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(events[0]["type"], "meta");
        assert_eq!(events[0]["path"], "note.md");
        assert_eq!(events[0]["size"], 5);
        assert_eq!(events[0]["authority_version"], serde_json::Value::Null);
        assert_eq!(events[0]["disk_conflicted"], false);
        assert_eq!(events[1]["type"], "chunk");
        assert_eq!(events[1]["content"], "hello");
        assert_eq!(events[2]["type"], "done");
    }

    #[test]
    fn stream_read_file_sync_preserves_utf8_across_chunk_boundaries() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        let content = format!(
            "{}é-tail",
            "a".repeat(chan_workspace::TEXT_READ_CHUNK_SIZE - 1)
        );
        workspace.write_text("split.md", &content).unwrap();
        let mut chunks = String::new();

        stream_read_file_sync(&workspace, "split.md", |bytes| {
            let event: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            if event["type"] == "chunk" {
                chunks.push_str(event["content"].as_str().unwrap());
            }
            true
        })
        .unwrap();

        assert_eq!(chunks, content);
    }

    #[test]
    fn stream_read_file_sync_stops_when_emit_returns_false() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.write_text("note.md", "hello").unwrap();
        let mut lines = 0usize;

        stream_read_file_sync(&workspace, "note.md", |_| {
            lines += 1;
            false
        })
        .unwrap();

        assert_eq!(lines, 1);
    }

    #[test]
    fn query_flag_accepts_stream_one() {
        assert!(query_flag(&Some("1".to_string())));
        assert!(query_flag(&Some("true".to_string())));
        assert!(!query_flag(&None));
        assert!(!query_flag(&Some("0".to_string())));
    }

    #[test]
    fn download_path_sync_returns_editable_text_bytes() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.write_text("notes/readme.md", "hello\n").unwrap();

        let payload = download_path_sync(&workspace, "notes/readme.md", None).unwrap();

        match payload {
            DownloadPayload::File(BinaryPlan::Full(reader)) => {
                let chunks: chan_workspace::Result<Vec<Vec<u8>>> = reader.collect();
                assert_eq!(chunks.unwrap().concat(), b"hello\n");
            }
            DownloadPayload::File(_) => panic!("expected a full-file download"),
            DownloadPayload::Directory => panic!("expected file download"),
        }
    }

    #[test]
    fn single_file_download_plan_never_owns_a_whole_file_vec() {
        let source = include_str!("files.rs");
        assert!(
            !source.contains("enum DownloadPayload {\n    File(Vec<u8>)"),
            "single-file downloads must carry the workspace's bounded reader, not a whole-file Vec"
        );
    }

    #[test]
    fn plain_binary_read_plan_never_owns_a_whole_file_vec() {
        let source = include_str!("files.rs");
        let binary_vec = concat!("Binary(Vec", "<u8>)");
        let unbounded_fallback = concat!("workspace.read(path).map(", "ReadFileResult::Binary)");
        assert!(
            !source.contains(binary_vec),
            "plain binary reads must carry a bounded plan, not whole-file bytes"
        );
        assert!(
            !source.contains(unbounded_fallback),
            "plain binary fallbacks must not call the unbounded read primitive"
        );
    }

    #[test]
    fn workspace_archive_walk_never_owns_a_whole_member_vec() {
        let source = include_str!("files.rs");
        let unbounded_member = concat!("let bytes = workspace.", "read(&child_source)?");
        assert!(
            !source.contains(unbounded_member),
            "workspace tar members must stream from a bounded reader"
        );
    }

    #[test]
    fn multipart_upload_handlers_never_collect_file_fields() {
        let workspace_route = include_str!("files.rs");
        let terminal_route = include_str!("transfer.rs");
        let collecting_pattern = concat!("let bytes = match field.", "bytes().await");
        let collecting_text_pattern = concat!("field.", "text().await");
        assert!(
            !workspace_route.contains(collecting_pattern),
            "workspace multipart files must be consumed chunk by chunk"
        );
        assert!(
            !terminal_route.contains(collecting_pattern),
            "terminal multipart files must be consumed chunk by chunk"
        );
        assert!(!workspace_route.contains(collecting_text_pattern));
        assert!(!terminal_route.contains(collecting_text_pattern));
    }

    #[test]
    fn route_table_delegates_streaming_limits_to_semantic_sinks() {
        let route_table = include_str!("../lib.rs");
        assert_eq!(
            route_table.matches("DefaultBodyLimit::disable()").count(),
            4
        );
        assert!(route_table.contains("post(api_upload_file).layer(DefaultBodyLimit::disable())"));
        assert!(route_table.contains(
            "post(crate::routes::transfer::api_terminal_upload_file)\n                .layer(DefaultBodyLimit::disable())"
        ));
        assert!(route_table.contains("put(api_write_file).layer(DefaultBodyLimit::disable())"));
        assert!(route_table.contains(
            "put(crate::routes::standalone_fs::api_standalone_write_file)\n                .layer(DefaultBodyLimit::disable())"
        ));
    }

    /// A multipart body naming a destination and one file part, so a test can
    /// drive the upload route without a router.
    async fn upload_multipart(
        boundary: &str,
        dir: &str,
        filename: &str,
        content: &str,
    ) -> Multipart {
        use axum::extract::FromRequest;

        let body = format!(
            "--{boundary}\r\n\
             Content-Disposition: form-data; name=\"dir\"\r\n\r\n\
             {dir}\r\n\
             --{boundary}\r\n\
             Content-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n\r\n\
             {content}\r\n\
             --{boundary}--\r\n"
        );
        let request = axum::http::Request::builder()
            .method("POST")
            .uri("/api/files/upload")
            .body(Body::from(body))
            .map(|mut request| {
                request.headers_mut().insert(
                    header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}")
                        .parse()
                        .unwrap(),
                );
                request
            })
            .unwrap();
        Multipart::from_request(request, &()).await.unwrap()
    }

    /// Both sides of the bound on the workspace upload: a saturated lane
    /// refuses it and nothing is written, and the same upload succeeds once the
    /// lane drains. Checking only the refusal would pass against a route that
    /// was broken for an unrelated reason.
    #[tokio::test]
    async fn a_workspace_upload_refused_at_the_bound_writes_nothing() {
        let (lane, saturator) = crate::bulk_transfer::test_support::isolated_tenant();
        let (_cfg, root, state) =
            super::doc_divert_tests::divert_app_with_tenant(lane.tenant(), None);
        let (releases, held) = crate::bulk_transfer::test_support::saturate_admission(&saturator);

        let refused = super::api_upload_file(
            State(Arc::clone(&state)),
            Query(super::UploadRootQuery::default()),
            HeaderMap::new(),
            upload_multipart("refused-upload", "", "declined.bin", "payload").await,
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
            !root.path().join("declined.bin").exists(),
            "a refused upload must not create its target"
        );

        // Awaiting the held jobs is proof the slots are free, where dropping
        // the senders and continuing would only be a guess about timing.
        drop(releases);
        for job in held {
            let _ = job.outcome().await;
        }

        let admitted = super::api_upload_file(
            State(Arc::clone(&state)),
            Query(super::UploadRootQuery::default()),
            HeaderMap::new(),
            upload_multipart("admitted-upload", "", "admitted.bin", "payload").await,
        )
        .await;
        assert_eq!(
            admitted.status(),
            StatusCode::OK,
            "the same upload must succeed once the lane has capacity"
        );
        assert_eq!(
            std::fs::read(root.path().join("admitted.bin")).unwrap(),
            b"payload"
        );
    }

    /// The copy/move asymmetry is deliberate, so it is pinned from both sides
    /// rather than left as a comment. A copy moves bytes and rides the lane; a
    /// move is a rename plus a link-rewrite walk and must stay off it, or an
    /// ordinary file-browser drag would wait behind two large downloads.
    #[tokio::test]
    async fn a_copy_batch_is_admitted_and_a_move_is_deliberately_not() {
        let (lane, saturator) = crate::bulk_transfer::test_support::isolated_tenant();
        let (_cfg, root, state) =
            super::doc_divert_tests::divert_app_with_tenant(lane.tenant(), None);
        let workspace = state.try_workspace().unwrap();
        workspace.write_bytes("copied.bin", b"payload").unwrap();
        workspace.write_bytes("moved.bin", b"payload").unwrap();
        std::fs::create_dir(root.path().join("dest")).unwrap();

        let (releases, held) = crate::bulk_transfer::test_support::saturate_admission(&saturator);

        let copied = super::api_fs_transfer(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Json(TransferBody {
                op: TransferOp::Copy,
                sources: vec!["copied.bin".into()],
                dest_dir: "dest".into(),
            }),
        )
        .await;
        assert_eq!(
            copied.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "a copy moves bytes, so a full lane must refuse it"
        );
        assert!(
            !root.path().join("dest").join("copied.bin").exists(),
            "a refused copy must not have written anything"
        );

        let moved = super::api_fs_transfer(
            State(Arc::clone(&state)),
            HeaderMap::new(),
            Json(TransferBody {
                op: TransferOp::Move,
                sources: vec!["moved.bin".into()],
                dest_dir: "dest".into(),
            }),
        )
        .await;
        assert_eq!(
            moved.status(),
            StatusCode::OK,
            "a move holds no admission, so a full lane must not block it"
        );
        assert!(
            root.path().join("dest").join("moved.bin").exists(),
            "the move must have completed while the lane was full"
        );

        drop(releases);
        for job in held {
            let _ = job.outcome().await;
        }
    }

    /// The ceiling at the route, from both sides: the upload that lands
    /// exactly on the configured value succeeds, and the one byte past it is
    /// refused with the target untouched and no temp file left behind.
    ///
    /// Asserting only the refusal would pass against a ceiling lower than the
    /// test believes, which is the failure mode a one-sided boundary test
    /// cannot see.
    #[tokio::test]
    async fn transfer_cap_admits_the_exact_ceiling_and_refuses_one_byte_over() {
        const CAP: u64 = 4096;
        let (lane, _saturator) = crate::bulk_transfer::test_support::isolated_tenant();
        let (_cfg, root, state) =
            super::doc_divert_tests::divert_app_with_tenant(lane.tenant(), Some(CAP));

        let exact = super::api_upload_file(
            State(Arc::clone(&state)),
            Query(super::UploadRootQuery::default()),
            HeaderMap::new(),
            upload_multipart("cap-exact", "", "exact.bin", &"z".repeat(CAP as usize)).await,
        )
        .await;
        assert_eq!(
            exact.status(),
            StatusCode::OK,
            "an upload of exactly the configured ceiling must be accepted"
        );
        assert_eq!(
            std::fs::metadata(root.path().join("exact.bin"))
                .unwrap()
                .len(),
            CAP
        );

        let over = super::api_upload_file(
            State(Arc::clone(&state)),
            Query(super::UploadRootQuery::default()),
            HeaderMap::new(),
            upload_multipart("cap-over", "", "over.bin", &"z".repeat(CAP as usize + 1)).await,
        )
        .await;
        assert_eq!(
            over.status(),
            StatusCode::PAYLOAD_TOO_LARGE,
            "one byte past the configured ceiling must be refused"
        );
        assert!(
            !root.path().join("over.bin").exists(),
            "a refused upload must leave no target"
        );
        assert_eq!(
            std::fs::read_dir(root.path())
                .unwrap()
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.file_name() != ".chan")
                .count(),
            1,
            "a refused upload must leave no temp file beside the accepted one"
        );
    }

    #[tokio::test]
    async fn workspace_upload_rejects_overflow_progressively_without_a_partial_target() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        // A small configured ceiling, so overflow is reached in a few chunks
        // instead of by writing the default multi-gigabyte cap. That the test
        // can choose it at all is the point of the ceiling being configuration.
        const CAP: u64 = 4 * 1024 * 1024;
        let config_path = cfg.path().join("config.toml");
        std::fs::write(
            &config_path,
            format!("workspaces = []\n[transfer]\nmax_bytes = {CAP}\n"),
        )
        .unwrap();
        let lib = chan_workspace::Library::open_at(config_path).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        let self_writes = Arc::new(crate::self_writes::SelfWrites::new());
        let (tx, mut rx) = mpsc::channel(8);
        let ws = Arc::clone(&workspace);
        let writes = Arc::clone(&self_writes);
        let consumer = tokio::task::spawn_blocking(move || {
            workspace_upload_stream_sync(
                &ws,
                &writes,
                &UploadDestination {
                    dir: String::new(),
                    replace_path: None,
                    filename: "too-large.bin".into(),
                },
                &mut rx,
                &crate::bulk_transfer::test_support::uncancelled(),
            )
        });
        let chunk = Bytes::from(vec![0x5a; 1024 * 1024]);
        let attempts = CAP / chunk.len() as u64 + 2;
        for _ in 0..attempts {
            if tx
                .send(RequestBodyMessage::Chunk(chunk.clone()))
                .await
                .is_err()
            {
                break;
            }
        }
        let _ = tx.send(RequestBodyMessage::Complete).await;
        drop(tx);

        let error = consumer.await.unwrap().unwrap_err();

        assert!(matches!(
            error,
            chan_workspace::ChanError::WriteTooLarge { .. }
        ));
        assert!(!root.path().join("too-large.bin").exists());
        assert!(!self_writes.should_suppress("too-large.bin"));
        assert!(
            workspace.list("").unwrap().is_empty(),
            "the rejected atomic upload must remove its temp"
        );
    }

    #[tokio::test]
    async fn disconnected_workspace_upload_keeps_replacement_and_removes_temp() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.write_bytes("same.bin", b"old").unwrap();
        let self_writes = Arc::new(crate::self_writes::SelfWrites::new());
        let (tx, mut rx) = mpsc::channel(8);
        let ws = Arc::clone(&workspace);
        let writes = Arc::clone(&self_writes);
        let consumer = tokio::task::spawn_blocking(move || {
            workspace_upload_stream_sync(
                &ws,
                &writes,
                &UploadDestination {
                    dir: String::new(),
                    replace_path: Some("same.bin".into()),
                    filename: "ignored.bin".into(),
                },
                &mut rx,
                &crate::bulk_transfer::test_support::uncancelled(),
            )
        });
        tx.send(RequestBodyMessage::Chunk(Bytes::from_static(b"new")))
            .await
            .unwrap();
        drop(tx);

        assert!(consumer.await.unwrap().is_err());
        assert_eq!(workspace.read("same.bin").unwrap(), b"old");
        assert!(!self_writes.should_suppress("same.bin"));
        assert_eq!(workspace.list("").unwrap().len(), 1);
    }

    #[tokio::test]
    async fn binary_download_stream_is_byte_exact_with_attachment_metadata() {
        use axum::body::to_bytes;

        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        let expected: Vec<u8> = (0..(chan_workspace::BINARY_STREAM_CHUNK_SIZE * 2 + 17))
            .map(|index| (index % 251) as u8)
            .collect();
        workspace.write_bytes("large.bin", &expected).unwrap();
        let plan = match download_path_sync(&workspace, "large.bin", None).unwrap() {
            DownloadPayload::File(plan) => plan,
            DownloadPayload::Directory => panic!("expected file download"),
        };

        let response = stream_binary_download("large.bin", plan);

        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        assert_eq!(
            response.headers()[header::CONTENT_DISPOSITION],
            "attachment; filename=\"large.bin\""
        );
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            expected.len().to_string()
        );
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
        assert!(response.headers().contains_key(header::ETAG));
        let actual = to_bytes(response.into_body(), expected.len() + 1)
            .await
            .unwrap();
        assert_eq!(actual.as_ref(), expected);
    }

    #[tokio::test]
    async fn download_ranges_cover_first_last_and_clamped_end() {
        use axum::body::to_bytes;

        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        let source = b"0123456789";
        workspace.write_bytes("resume.bin", source).unwrap();

        for (range, expected_range, expected) in [
            ("bytes=0-0", "bytes 0-0/10", &source[0..1]),
            ("bytes=9-", "bytes 9-9/10", &source[9..10]),
            ("bytes=7-99", "bytes 7-9/10", &source[7..10]),
        ] {
            let plan = match download_path_sync(&workspace, "resume.bin", Some(range)).unwrap() {
                DownloadPayload::File(plan) => plan,
                DownloadPayload::Directory => panic!("expected file download"),
            };
            let response = stream_binary_download("resume.bin", plan);
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(response.headers()[header::CONTENT_RANGE], expected_range);
            assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
            assert!(response.headers().contains_key(header::ETAG));
            let body = to_bytes(response.into_body(), expected.len() + 1)
                .await
                .unwrap();
            assert_eq!(body.as_ref(), expected);
        }
    }

    #[tokio::test]
    async fn download_strong_validator_changes_with_the_file() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.write_bytes("resume.bin", b"before").unwrap();

        let first = match download_path_sync(&workspace, "resume.bin", None).unwrap() {
            DownloadPayload::File(plan) => stream_binary_download("resume.bin", plan),
            DownloadPayload::Directory => panic!("expected file download"),
        };
        let first_etag = first.headers()[header::ETAG].clone();
        assert!(!first_etag.to_str().unwrap().starts_with("W/"));
        drop(first);

        workspace
            .write_bytes("resume.bin", b"after-change")
            .unwrap();
        let second = match download_path_sync(&workspace, "resume.bin", None).unwrap() {
            DownloadPayload::File(plan) => stream_binary_download("resume.bin", plan),
            DownloadPayload::Directory => panic!("expected file download"),
        };
        assert_ne!(second.headers()[header::ETAG], first_etag);
    }

    #[test]
    fn resolve_range_covers_the_single_range_forms() {
        use RangeOutcome::*;

        // Well-formed, satisfiable.
        assert_eq!(
            resolve_range(Some("bytes=0-499"), 1000),
            Slice { start: 0, len: 500 }
        );
        assert_eq!(
            resolve_range(Some("bytes=500-"), 1000),
            Slice {
                start: 500,
                len: 500
            }
        );
        assert_eq!(
            resolve_range(Some("bytes=-200"), 1000),
            Slice {
                start: 800,
                len: 200
            }
        );
        // End clamps to EOF; oversized suffix means the whole file.
        assert_eq!(
            resolve_range(Some("bytes=900-4096"), 1000),
            Slice {
                start: 900,
                len: 100
            }
        );
        assert_eq!(
            resolve_range(Some("bytes=-4096"), 1000),
            Slice {
                start: 0,
                len: 1000
            }
        );
        // Single byte.
        assert_eq!(
            resolve_range(Some("bytes=0-0"), 1000),
            Slice { start: 0, len: 1 }
        );

        // Unsatisfiable: start at or past EOF, zero suffix, empty file.
        assert_eq!(resolve_range(Some("bytes=1000-"), 1000), Unsatisfiable);
        assert_eq!(resolve_range(Some("bytes=2000-2100"), 1000), Unsatisfiable);
        assert_eq!(resolve_range(Some("bytes=-0"), 1000), Unsatisfiable);
        assert_eq!(resolve_range(Some("bytes=0-"), 0), Unsatisfiable);

        // Ignored: absent, other units, malformed, inverted, multi-range.
        assert_eq!(resolve_range(None, 1000), Full);
        assert_eq!(resolve_range(Some("items=0-4"), 1000), Full);
        assert_eq!(resolve_range(Some("bytes=abc-"), 1000), Full);
        assert_eq!(resolve_range(Some("bytes=12"), 1000), Full);
        assert_eq!(resolve_range(Some("bytes=500-100"), 1000), Full);
        assert_eq!(resolve_range(Some("bytes=0-1,5-9"), 1000), Full);
    }

    fn media_workspace(
        source: &[u8],
    ) -> (
        tempfile::TempDir,
        tempfile::TempDir,
        Arc<chan_workspace::Workspace>,
    ) {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.write_bytes("clip.mp4", source).unwrap();
        (cfg, root, workspace)
    }

    fn media_source() -> Vec<u8> {
        (0..(chan_workspace::BINARY_STREAM_CHUNK_SIZE * 2 + 311))
            .map(|index| (index % 251) as u8)
            .collect()
    }

    #[tokio::test]
    async fn media_get_without_range_streams_the_whole_file_with_accept_ranges() {
        use axum::body::to_bytes;

        let source = media_source();
        let (_cfg, _root, workspace) = media_workspace(&source);

        let response = media_stream_response(workspace, "clip.mp4".into(), None).await;

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "video/mp4");
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            source.len().to_string()
        );
        assert!(!response.headers().contains_key(header::CONTENT_DISPOSITION));
        let actual = to_bytes(response.into_body(), source.len() + 1)
            .await
            .unwrap();
        assert_eq!(actual.as_ref(), source);
    }

    #[tokio::test]
    async fn media_range_request_streams_the_exact_slice_as_206() {
        use axum::body::to_bytes;

        let source = media_source();
        let (_cfg, _root, workspace) = media_workspace(&source);
        let start = chan_workspace::BINARY_STREAM_CHUNK_SIZE - 7;
        let end = chan_workspace::BINARY_STREAM_CHUNK_SIZE + 12;

        let response = media_stream_response(
            workspace,
            "clip.mp4".into(),
            Some(format!("bytes={start}-{end}")),
        )
        .await;

        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(
            response.headers()[header::CONTENT_RANGE],
            format!("bytes {start}-{end}/{}", source.len())
        );
        let len = end - start + 1;
        assert_eq!(response.headers()[header::CONTENT_LENGTH], len.to_string());
        let actual = to_bytes(response.into_body(), len + 1).await.unwrap();
        assert_eq!(actual.as_ref(), &source[start..=end]);
    }

    #[tokio::test]
    async fn media_open_and_suffix_ranges_resolve_against_eof() {
        use axum::body::to_bytes;

        let source = media_source();
        let (_cfg, _root, workspace) = media_workspace(&source);
        let start = source.len() - 300;

        let open_ended = media_stream_response(
            workspace.clone(),
            "clip.mp4".into(),
            Some(format!("bytes={start}-")),
        )
        .await;
        assert_eq!(open_ended.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            open_ended.headers()[header::CONTENT_RANGE],
            format!("bytes {start}-{}/{}", source.len() - 1, source.len())
        );
        let tail = to_bytes(open_ended.into_body(), 301).await.unwrap();
        assert_eq!(tail.as_ref(), &source[start..]);

        let suffix =
            media_stream_response(workspace, "clip.mp4".into(), Some("bytes=-300".into())).await;
        assert_eq!(suffix.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            suffix.headers()[header::CONTENT_RANGE],
            format!("bytes {start}-{}/{}", source.len() - 1, source.len())
        );
        let suffix_bytes = to_bytes(suffix.into_body(), 301).await.unwrap();
        assert_eq!(suffix_bytes.as_ref(), &source[start..]);
    }

    #[tokio::test]
    async fn media_unsatisfiable_range_is_416_and_invalid_range_degrades_to_full() {
        use axum::body::to_bytes;

        let source = media_source();
        let (_cfg, _root, workspace) = media_workspace(&source);

        let unsatisfiable = media_stream_response(
            workspace.clone(),
            "clip.mp4".into(),
            Some(format!("bytes={}-", source.len())),
        )
        .await;
        assert_eq!(unsatisfiable.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            unsatisfiable.headers()[header::CONTENT_RANGE],
            format!("bytes */{}", source.len())
        );

        let ignored =
            media_stream_response(workspace, "clip.mp4".into(), Some("bytes=0-1,5-9".into())).await;
        assert_eq!(ignored.status(), StatusCode::OK);
        let actual = to_bytes(ignored.into_body(), source.len() + 1)
            .await
            .unwrap();
        assert_eq!(actual.as_ref(), source);
    }

    #[tokio::test]
    async fn media_response_refuses_a_directory_with_a_media_extension() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        std::fs::create_dir(root.path().join("weird.mp4")).unwrap();

        let response =
            media_stream_response(workspace, "weird.mp4".into(), Some("bytes=0-".into())).await;

        assert!(response.status().is_client_error() || response.status().is_server_error());
        assert_ne!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_ne!(response.status(), StatusCode::PARTIAL_CONTENT);
    }

    #[tokio::test]
    async fn dropping_binary_download_body_joins_the_bounded_reader() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        let size = chan_workspace::BINARY_STREAM_CHUNK_SIZE
            * (chan_workspace::BINARY_STREAM_QUEUE_DEPTH + 16);
        workspace
            .write_bytes("disconnect.bin", &vec![0x5a; size])
            .unwrap();
        let reader = match download_path_sync(&workspace, "disconnect.bin", None).unwrap() {
            DownloadPayload::File(BinaryPlan::Full(reader)) => reader,
            DownloadPayload::File(_) => panic!("expected a full-file download"),
            DownloadPayload::Directory => panic!("expected file download"),
        };
        let (response, completed) =
            stream_binary_download_with_completion("disconnect.bin", reader);

        drop(response);

        tokio::time::timeout(std::time::Duration::from_secs(2), completed)
            .await
            .expect("disconnect must stop the bridge and join the bounded reader")
            .expect("download bridge completion sender dropped");
    }

    /// Build a registered workspace over a temp root, returning it with the
    /// guards that must outlive it.
    fn admitted_download_workspace() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        Arc<chan_workspace::Workspace>,
    ) {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        (cfg, root, workspace)
    }

    fn admitted_download_workspace_with_cap(
        cap: u64,
    ) -> (
        tempfile::TempDir,
        tempfile::TempDir,
        Arc<chan_workspace::Workspace>,
    ) {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let config_path = cfg.path().join("config.toml");
        std::fs::write(
            &config_path,
            format!("workspaces = []\n[transfer]\nmax_bytes = {cap}\n"),
        )
        .unwrap();
        let lib = chan_workspace::Library::open_at(config_path).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        (cfg, root, workspace)
    }

    #[tokio::test]
    async fn a_workspace_archive_refuses_a_tree_known_over_the_ceiling() {
        const CAP: u64 = 2048;
        let (_cfg, root, workspace) = admitted_download_workspace_with_cap(CAP);
        workspace.create_dir("archive").unwrap();
        std::fs::write(
            root.path().join("archive/over.bin"),
            vec![0x7e; CAP as usize + 1],
        )
        .unwrap();
        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();

        let response = stream_planned_workspace_download_tracked(
            &bulk,
            None,
            None,
            workspace,
            "archive".into(),
            None,
        )
        .await;

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
            message.contains("2049") && message.contains("2048"),
            "the refusal must name the known payload and its ceiling: {message}"
        );
    }

    #[tokio::test]
    async fn a_workspace_archive_errors_the_body_at_the_ceiling() {
        const CAP: u64 = 2048;
        let (_cfg, _root, workspace) = admitted_download_workspace_with_cap(CAP);
        workspace.create_dir("archive").unwrap();
        workspace
            .write_bytes("archive/exact.bin", &vec![0x7e; CAP as usize])
            .unwrap();
        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();

        let response = stream_planned_workspace_download_tracked(
            &bulk,
            None,
            None,
            workspace,
            "archive".into(),
            None,
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "a tree whose payload is at the ceiling cannot be refused before the tar is built"
        );

        let mut body = response.into_body().into_data_stream();
        let mut delivered = 0usize;
        let mut body_error = None;
        while let Some(next) = body.next().await {
            match next {
                Ok(bytes) => delivered += bytes.len(),
                Err(error) => {
                    body_error = Some(error.to_string());
                    break;
                }
            }
        }

        let body_error = body_error.expect("the archive body must fail rather than complete");
        assert_eq!(
            delivered, CAP as usize,
            "the body must stop after exactly the configured number of bytes"
        );
        assert!(
            body_error.contains("ceiling"),
            "the body error must name the enforced bound: {body_error}"
        );
    }

    #[tokio::test]
    async fn whole_file_range_and_no_range_differ_in_status_not_in_bytes() {
        use axum::body::to_bytes;

        // The discriminating case for the Full-versus-Partial decision. A
        // `Range` spanning the whole file yields the SAME bytes and the SAME
        // Content-Length as no `Range` at all; only the status and
        // Content-Range differ. So a test that asserts the payload passes even
        // if the two cases are collapsed, which is why this asserts neither
        // body alone but the headers that actually carry the distinction.
        let (_cfg, root, workspace) = admitted_download_workspace();
        std::fs::write(root.path().join("whole.bin"), b"0123456789").unwrap();
        let bulk = crate::state::test_support::make_test_bulk_transfer_tenant();

        let full = stream_planned_workspace_download_tracked(
            &bulk,
            None,
            None,
            workspace.clone(),
            "whole.bin".into(),
            None,
        )
        .await;
        assert_eq!(full.status(), StatusCode::OK);
        assert!(
            full.headers().get(header::CONTENT_RANGE).is_none(),
            "a download with no Range must not answer with Content-Range"
        );
        assert_eq!(full.headers()[header::CONTENT_LENGTH], "10");

        let partial = stream_planned_workspace_download_tracked(
            &bulk,
            None,
            None,
            workspace,
            "whole.bin".into(),
            Some("bytes=0-".into()),
        )
        .await;
        assert_eq!(
            partial.status(),
            StatusCode::PARTIAL_CONTENT,
            "a Range covering the whole file is still a Range request"
        );
        assert_eq!(partial.headers()[header::CONTENT_RANGE], "bytes 0-9/10");
        assert_eq!(partial.headers()[header::CONTENT_LENGTH], "10");

        // Stated as an assertion rather than a comment: the bodies really are
        // identical, so anything asserting them cannot tell these cases apart.
        let full_bytes = to_bytes(full.into_body(), usize::MAX).await.unwrap();
        let partial_bytes = to_bytes(partial.into_body(), usize::MAX).await.unwrap();
        assert_eq!(full_bytes, partial_bytes);
        assert_eq!(&full_bytes[..], b"0123456789");
    }

    #[tokio::test]
    async fn admitted_download_declares_the_length_it_streams() {
        use axum::body::to_bytes;

        let (_cfg, root, workspace) = admitted_download_workspace();
        std::fs::write(root.path().join("sized.bin"), vec![7u8; 4096]).unwrap();
        let bulk = crate::state::test_support::make_test_bulk_transfer_tenant();

        let response = stream_planned_workspace_download_tracked(
            &bulk,
            None,
            None,
            workspace,
            "sized.bin".into(),
            Some("bytes=100-199".into()),
        )
        .await;
        let declared: usize = response.headers()[header::CONTENT_LENGTH]
            .to_str()
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(
            response.headers()[header::CONTENT_RANGE],
            "bytes 100-199/4096"
        );

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            body.len(),
            declared,
            "the declared length must equal the bytes streamed"
        );
        assert_eq!(declared, 100);
    }

    #[tokio::test]
    async fn admitted_shrink_fails_the_body_rather_than_completing_short() {
        use axum::body::to_bytes;

        // The interaction between the declared length and the shrink error.
        // The length is already on the wire when the reader reports its
        // shortfall, so ending the stream cleanly would answer 200 with fewer
        // bytes than promised. The body must fail instead.
        let (_cfg, root, workspace) = admitted_download_workspace();
        let declared = chan_workspace::BINARY_STREAM_CHUNK_SIZE * 256;
        let path = root.path().join("shrinking.bin");
        std::fs::File::create(&path)
            .unwrap()
            .set_len(declared as u64)
            .unwrap();
        let bulk = crate::state::test_support::make_test_bulk_transfer_tenant();

        let response = stream_planned_workspace_download_tracked(
            &bulk,
            None,
            None,
            workspace,
            "shrinking.bin".into(),
            None,
        )
        .await;
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            declared.to_string()
        );

        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_len(0)
            .unwrap();

        assert!(
            to_bytes(response.into_body(), declared + 1).await.is_err(),
            "an admitted transfer must fail rather than complete short of its declared length"
        );
    }

    #[tokio::test]
    async fn admitted_download_refuses_at_the_bound_without_opening_the_file() {
        let (_cfg, root, workspace) = admitted_download_workspace();
        let path = root.path().join("declined.bin");
        std::fs::write(&path, b"payload").unwrap();
        // Unreadable: if the refusal opened it, the plan would fail with a
        // permission error and the status would not be 503.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        }

        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
        let (releases, _held) = crate::bulk_transfer::test_support::saturate_admission(&bulk);

        let response = stream_planned_workspace_download_tracked(
            &bulk,
            None,
            None,
            workspace,
            "declined.bin".into(),
            None,
        )
        .await;

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response
                .headers()
                .get(header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok()),
            Some("1")
        );

        drop(releases);
    }

    #[test]
    fn send_reader_into_forwards_a_read_error_instead_of_ending_the_stream() {
        // The shrink path at the seam: the error must arrive as an item, not
        // as the end of the stream. A bridge that dropped it would leave the
        // response completing cleanly under its declared length.
        let (_cfg, root, workspace) = admitted_download_workspace();
        let declared = chan_workspace::BINARY_STREAM_CHUNK_SIZE * 4;
        let path = root.path().join("seam.bin");
        std::fs::File::create(&path)
            .unwrap()
            .set_len(declared as u64)
            .unwrap();
        let reader = match download_path_sync(&workspace, "seam.bin", None).unwrap() {
            DownloadPayload::File(BinaryPlan::Full(reader)) => reader,
            _ => panic!("expected a whole-file plan"),
        };
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(0)
            .unwrap();

        let (tx, mut rx) = mpsc::channel::<std::io::Result<Bytes>>(8);
        let cancel = crate::bulk_transfer::test_support::uncancelled();
        std::thread::spawn(move || send_reader_into(&tx, &cancel, reader));

        let mut saw_error = false;
        while let Some(message) = rx.blocking_recv() {
            if message.is_err() {
                saw_error = true;
            }
        }
        assert!(
            saw_error,
            "a shrink must reach the body as an error item, not as a clean end"
        );
    }

    /// A job cancelled before it reads sends no DATA, but it does send the
    /// error that ends the body. Sending nothing at all is what a client
    /// receives as a clean end, and on a length-declaring response that is a
    /// short body presented as a complete one.
    #[test]
    fn send_reader_into_sends_no_data_but_does_fail_when_cancelled() {
        let (_cfg, root, workspace) = admitted_download_workspace();
        std::fs::write(root.path().join("cancelled.bin"), vec![1u8; 4096]).unwrap();
        let reader = match download_path_sync(&workspace, "cancelled.bin", None).unwrap() {
            DownloadPayload::File(BinaryPlan::Full(reader)) => reader,
            _ => panic!("expected a whole-file plan"),
        };

        let (tx, mut rx) = mpsc::channel::<std::io::Result<Bytes>>(8);
        let cancel = crate::bulk_transfer::test_support::cancelled();
        std::thread::spawn(move || send_reader_into(&tx, &cancel, reader));

        let first = rx
            .blocking_recv()
            .expect("a cancelled job must not end cleanly");
        assert!(
            first.is_err(),
            "the only item a cancelled job sends is the error that fails the body"
        );
        assert!(
            rx.blocking_recv().is_none(),
            "nothing follows the error, and no data chunk is ever sent"
        );
    }

    /// The cadence, which is the half of the cancellation contract whose
    /// violation actually leaks a slot. A check hoisted above the loop stops a
    /// job cancelled before it started and never stops one cancelled while it
    /// runs, so an abandoned transfer holds its admission until the file
    /// finishes naturally, the effective bound drifts down over a session, and
    /// nothing ever errors. The lane merely looks busy.
    ///
    /// The test above cannot see that, because a pre-set signal is caught by
    /// both shapes. Capacity 1 is what makes this one discriminate: the writer
    /// blocks until the test takes a chunk, so cancelling after the first
    /// receive happens strictly after any pre-loop check would have run and
    /// passed. Only a per-iteration check can still stop it.
    #[tokio::test]
    async fn send_reader_into_stops_when_cancelled_mid_stream() {
        const CHUNKS: usize = 64;
        let (_cfg, root, workspace) = admitted_download_workspace();
        std::fs::write(
            root.path().join("long.bin"),
            vec![7u8; chan_workspace::BINARY_STREAM_CHUNK_SIZE * CHUNKS],
        )
        .unwrap();
        let plan = |workspace: &chan_workspace::Workspace| match download_path_sync(
            workspace, "long.bin", None,
        )
        .unwrap()
        {
            DownloadPayload::File(BinaryPlan::Full(reader)) => reader,
            _ => panic!("expected a whole-file plan"),
        };

        // Its own lane. This does not saturate, but the writer holds an
        // admission slot while blocked on the capacity-1 channel, which on the
        // shared test lane would occupy capacity for every other test running
        // at that moment.
        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();

        // The control, and it is what stops the assertion below from passing
        // vacuously: an uncancelled run over the same file must deliver every
        // chunk. Without it, a reader that ended early for any unrelated reason
        // would satisfy the low count and prove nothing about cancellation.
        let control_reader = plan(&workspace);
        let (control_tx, mut control_rx) = mpsc::channel::<std::io::Result<Bytes>>(1);
        let control = bulk
            .submit(move |cancel| send_reader_into(&control_tx, cancel, control_reader))
            .expect("an idle lane admits");
        let mut control_delivered = 0;
        while control_rx.recv().await.is_some() {
            control_delivered += 1;
        }
        let _ = control.outcome().await;
        assert_eq!(
            control_delivered, CHUNKS,
            "an uncancelled reader must deliver the whole file, or the count below means nothing"
        );

        let reader = plan(&workspace);
        let (tx, mut rx) = mpsc::channel::<std::io::Result<Bytes>>(1);
        let job = bulk
            .submit(move |cancel| send_reader_into(&tx, cancel, reader))
            .expect("an idle lane admits");

        assert!(
            rx.recv().await.is_some(),
            "the first chunk is what proves the writer is already inside the loop"
        );

        job.cancel();

        let mut delivered = 1;
        while rx.recv().await.is_some() {
            delivered += 1;
        }
        // Not an exact count: a chunk or two may be in flight between the
        // cancel and the writer's next check, and pinning that exactly would be
        // brittle for no gain. The discrimination is a handful against 64.
        assert!(
            delivered <= 4,
            "cancelled mid-stream, the reader delivered {delivered} of {CHUNKS} chunks; \
             a full-count delivery means the cancellation check was hoisted out of the \
             per-chunk loop, which leaks the admission slot for the rest of the transfer"
        );
    }
    /// Cancel is not synonymous with "the client is gone". `BulkTransferLane`'s
    /// Drop stores `true` into every active job's cancel flag at process
    /// shutdown, so a client mid-download at that moment is connected and
    /// draining. On this arm the response has already declared its
    /// `Content-Length`, so a silent stop answers 200 with fewer bytes than
    /// promised, which is the truncation the declared length exists to prevent.
    ///
    /// Asserting only that the stream ended does NOT discriminate: it ends
    /// under both shapes. The assertion has to be that an error item reaches
    /// the channel, which is what makes the body fail instead of complete.
    #[tokio::test]
    async fn cancelled_length_declaring_stream_fails_rather_than_ending_clean() {
        const CHUNKS: usize = 64;
        let (_cfg, root, workspace) = admitted_download_workspace();
        std::fs::write(
            root.path().join("cancelled-live.bin"),
            vec![3u8; chan_workspace::BINARY_STREAM_CHUNK_SIZE * CHUNKS],
        )
        .unwrap();
        let reader = match download_path_sync(&workspace, "cancelled-live.bin", None).unwrap() {
            DownloadPayload::File(BinaryPlan::Full(reader)) => reader,
            _ => panic!("expected a whole-file plan"),
        };

        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
        // Capacity 1: the writer is provably inside its loop once the first
        // chunk has been taken, so the cancel lands mid-stream.
        let (tx, mut rx) = mpsc::channel::<std::io::Result<Bytes>>(1);
        let job = bulk
            .submit(move |cancel| send_reader_into(&tx, cancel, reader))
            .expect("admitted");

        assert!(
            rx.recv().await.is_some_and(|first| first.is_ok()),
            "the first chunk must arrive before the cancel"
        );

        job.cancel();

        // The client is still draining here, which is the shutdown case.
        let mut saw_error = false;
        let mut delivered = 1;
        while let Some(message) = rx.recv().await {
            delivered += 1;
            if message.is_err() {
                saw_error = true;
            }
        }
        assert!(
            delivered < CHUNKS,
            "the cancel must stop the stream well before the file ends"
        );
        assert!(
            saw_error,
            "a cancelled transfer on a length-declaring response must fail the \
             body with an error item; ending cleanly answers 200 with fewer \
             bytes than the declared Content-Length promised"
        );
    }

    #[tokio::test]
    async fn shrinking_download_fails_instead_of_completing_short() {
        use axum::body::to_bytes;

        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        let declared = chan_workspace::BINARY_STREAM_CHUNK_SIZE * 256;
        let path = root.path().join("shrinking.bin");
        std::fs::File::create(&path)
            .unwrap()
            .set_len(declared as u64)
            .unwrap();
        let plan = match download_path_sync(&workspace, "shrinking.bin", None).unwrap() {
            DownloadPayload::File(plan) => plan,
            DownloadPayload::Directory => panic!("expected file download"),
        };
        let response = stream_binary_download("shrinking.bin", plan);
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            declared.to_string()
        );

        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_len(0)
            .unwrap();

        assert!(
            to_bytes(response.into_body(), declared + 1).await.is_err(),
            "a source shrink must fail the framed transfer"
        );
    }

    #[cfg(unix)]
    #[test]
    fn bounded_file_download_refuses_special_paths_and_keeps_directories_separate() {
        use std::os::unix::fs::symlink;

        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.create_dir("dir").unwrap();
        workspace.write_bytes("target.bin", b"x").unwrap();
        symlink("target.bin", root.path().join("link.bin")).unwrap();

        assert!(matches!(
            download_path_sync(&workspace, "dir", None).unwrap(),
            DownloadPayload::Directory
        ));
        assert!(download_path_sync(&workspace, "link.bin", None).is_err());
    }

    #[test]
    fn download_path_sync_archives_directory_tree() {
        use std::collections::BTreeMap;
        use std::io::Read;

        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.create_dir("notes").unwrap();
        workspace.create_dir("notes/deep").unwrap();
        workspace.write_text("notes/readme.md", "hello\n").unwrap();
        workspace
            .write_text("notes/deep/todo.txt", "todo\n")
            .unwrap();

        let payload = download_path_sync(&workspace, "notes", None).unwrap();
        assert!(matches!(payload, DownloadPayload::Directory));

        // The stream builds the archive via append_dir_to_archive; assert its
        // contents through the same walk.
        let mut bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut bytes);
            append_dir_to_archive(&mut builder, &workspace, "notes", "notes").unwrap();
            builder.finish().unwrap();
        }
        let mut archive = tar::Archive::new(std::io::Cursor::new(bytes));
        let mut files = BTreeMap::new();
        for entry in archive.entries().unwrap() {
            let mut entry = entry.unwrap();
            if !entry.header().entry_type().is_file() {
                continue;
            }
            let path = entry.path().unwrap().to_string_lossy().into_owned();
            let mut body = String::new();
            entry.read_to_string(&mut body).unwrap();
            files.insert(path, body);
        }

        assert_eq!(
            files.get("notes/readme.md").map(String::as_str),
            Some("hello\n")
        );
        assert_eq!(
            files.get("notes/deep/todo.txt").map(String::as_str),
            Some("todo\n")
        );
    }

    #[test]
    fn download_content_disposition_uses_safe_basename() {
        assert_eq!(
            content_disposition_attachment("notes/readme.md"),
            "attachment; filename=\"readme.md\"",
        );
        assert_eq!(
            content_disposition_attachment("notes/bad\"name.md"),
            "attachment; filename=\"bad_name.md\"",
        );
        assert_eq!(
            content_disposition_archive("notes/bad:name"),
            "attachment; filename=\"bad_name.tar\"",
        );
    }

    #[test]
    fn api_read_file_wraps_sync_workspace_reads_in_spawn_blocking() {
        let source = include_str!("files.rs");

        assert!(source.contains("read_file_sync(&read_workspace, &path_for_read)"));
        assert!(source.contains("download_path_sync(&plan_ws, &plan_path, plan_range.as_deref())"));
    }

    #[test]
    fn api_list_files_wraps_sync_workspace_walk_in_spawn_blocking() {
        let source = include_str!("files.rs");

        assert!(source
            .contains("tokio::task::spawn_blocking(move || list_files_sync(&workspace, query))"));
    }

    #[test]
    fn api_create_and_delete_wrap_sync_workspace_io_in_spawn_blocking() {
        let source = include_str!("files.rs");

        assert!(source
            .contains("tokio::task::spawn_blocking(move || create_file_sync(&workspace, body))"));
        assert!(source
            .contains("tokio::task::spawn_blocking(move || workspace.remove(&path_for_remove))"));
    }

    #[test]
    fn create_file_sync_rejects_existing_directory_collision() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.create_dir("notes").unwrap();

        let err = create_file_sync(
            &workspace,
            CreateBody {
                path: "notes".to_string(),
                is_dir: false,
                content: Some("body".to_string()),
            },
        )
        .unwrap_err();

        assert!(matches!(
            err,
            chan_workspace::ChanError::PathAlreadyExists(_)
        ));
    }

    #[test]
    fn write_file_sync_reports_seconds_conflict() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.write_text("note.md", "v1").unwrap();

        let err = write_file_sync(&workspace, "note.md", Some(0), None, "v2").unwrap_err();

        assert!(matches!(
            err,
            chan_workspace::ChanError::WriteConflict {
                current_mtime_ns: Some(_)
            }
        ));
        assert_eq!(workspace.read_text("note.md").unwrap(), "v1");
    }

    #[test]
    fn write_file_sync_reports_nanosecond_conflict() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.write_text("note.md", "v1").unwrap();

        let err = write_file_sync(&workspace, "note.md", None, Some(0), "v2").unwrap_err();

        assert!(matches!(
            err,
            chan_workspace::ChanError::WriteConflict {
                current_mtime_ns: Some(_)
            }
        ));
        assert_eq!(workspace.read_text("note.md").unwrap(), "v1");
    }

    #[test]
    fn write_file_sync_returns_new_mtime() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();

        let (mtime, mtime_ns) = write_file_sync(&workspace, "note.md", None, None, "v1").unwrap();

        assert!(mtime.is_some());
        assert!(mtime_ns.is_some());
        assert_eq!(workspace.read_text("note.md").unwrap(), "v1");
    }

    #[test]
    fn write_file_sync_accepts_matching_nanosecond_token() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.write_text("note.md", "v1").unwrap();
        let ns = workspace.stat("note.md").unwrap().mtime_ns.unwrap();

        let (_mtime, mtime_ns) =
            write_file_sync(&workspace, "note.md", Some(0), Some(ns), "v2").unwrap();

        assert!(mtime_ns.is_some());
        assert_eq!(workspace.read_text("note.md").unwrap(), "v2");
    }

    #[test]
    fn parse_optional_mtime_ns_rejects_bad_values() {
        assert_eq!(parse_optional_mtime_ns(None).unwrap(), None);
        assert_eq!(parse_optional_mtime_ns(Some("123")).unwrap(), Some(123));
        assert!(parse_optional_mtime_ns(Some("")).is_err());
        assert!(parse_optional_mtime_ns(Some("nope")).is_err());
    }
}

pub async fn api_delete_file(
    State(state): State<Arc<AppState>>,
    AxumPath(path): AxumPath<String>,
) -> Response {
    // chan-workspace's Workspace::remove handles files and EMPTY directories.
    // Recursive deletion of a non-empty directory is a deliberate
    // foot-gun guard; supporting it here would require either a new
    // chan-workspace API (`Workspace::remove_recursive`) or a server-side walk
    // that issues per-leaf removes. Tracked for a follow-up; current
    // behavior is "error out, frontend resolves the leaves itself".
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(e) => return err_state(&e),
    };
    // Register the self-write before the blocking remove so the
    // watcher's Removed event is suppressed without racing the await
    // (see api_write_file - noting after the await leaks a phantom
    // external-edit/removal event).
    state.self_writes.note(&path);
    let path_for_remove = path.clone();
    match tokio::task::spawn_blocking(move || workspace.remove(&path_for_remove)).await {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(e)) => err_from(&e),
        Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    }
}

#[derive(Deserialize)]
pub struct MoveBody {
    pub(crate) from: String,
    pub(crate) to: String,
}

pub async fn api_move(State(state): State<Arc<AppState>>, Json(body): Json<MoveBody>) -> Response {
    // Run the rename + link-rewrite pass on a blocking thread; the
    // rewrite walks N source files synchronously and can take a few
    // hundred ms on big directory moves. Keeping it off the tokio
    // worker pool avoids blocking other requests during the walk.
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(e) => return err_state(&e),
    };
    let from = body.from.clone();
    let to = body.to.clone();
    // Rename emits two notify events on most kernels (a Removed at
    // `from` and a Created at `to`); the rewrite pass also touches
    // every rewritten source. Note the endpoints before the blocking
    // rename (paths known up front) and the rewritten sources inside
    // the task as the rewrite reports them - all BEFORE the await
    // returns, so neither half of any pair fires a phantom external-
    // edit prompt (noting after the await raced the watcher; see
    // api_write_file).
    state.self_writes.note(&body.from);
    state.self_writes.note(&body.to);
    let self_writes = Arc::clone(&state.self_writes);
    let outcome = match tokio::task::spawn_blocking(move || {
        let outcome = workspace.rename_with_link_rewrite(&from, &to)?;
        for path in &outcome.rewritten {
            self_writes.note(path);
        }
        Ok::<_, chan_workspace::ChanError>(outcome)
    })
    .await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return err_from(&e),
        Err(join) => return err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    };
    Json(MoveResponse {
        renamed: outcome.renamed,
        rewritten: outcome.rewritten,
        conflicts: outcome.conflicts,
    })
    .into_response()
}

#[derive(Serialize)]
pub(crate) struct MoveResponse {
    pub(crate) renamed: Vec<(String, String)>,
    pub(crate) rewritten: Vec<String>,
    pub(crate) conflicts: Vec<String>,
}

/// Multi-entry move/copy for the File Browser clipboard + multi-drag
/// (FB capabilities). `op` selects move (cut/paste, drag) vs copy
/// (copy/paste); `sources` are the workspace-rooted POSIX paths of the
/// selection; `dest_dir` is the target directory ("" = workspace root).
#[derive(Deserialize)]
pub struct TransferBody {
    pub(crate) op: TransferOp,
    pub(crate) sources: Vec<String>,
    pub(crate) dest_dir: String,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferOp {
    Move,
    Copy,
}

#[derive(Serialize, Default)]
pub(crate) struct TransferResponse {
    /// Per-source outcome, in request order: the final destination path
    /// each source landed at (after collision suffixing) plus the op.
    pub(crate) moved: Vec<TransferItem>,
    /// Sources skipped because the destination equals the source's
    /// current parent (a no-op move) or the source escaped the workspace.
    pub(crate) skipped: Vec<String>,
    /// Link-rewrite CAS conflicts accumulated across all moved entries.
    pub(crate) conflicts: Vec<String>,
}

#[derive(Serialize)]
pub(crate) struct TransferItem {
    pub(crate) from: String,
    pub(crate) to: String,
}

/// Basename of a workspace-rooted POSIX path.
pub(crate) fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Parent dir of a workspace-rooted POSIX path ("" for a top-level entry).
pub(crate) fn parent_dir(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[..i],
        None => "",
    }
}

pub async fn api_fs_transfer(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<TransferBody>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(e) => return err_state(&e),
    };
    let dest_dir = body.dest_dir.trim_end_matches('/').to_string();
    let op = body.op;
    let sources = body.sources.clone();
    let self_writes = Arc::clone(&state.self_writes);

    // A copy moves bytes and is admitted to the transfer lane. A move is not,
    // and that is deliberate rather than an omission: it is a rename plus a
    // link-rewrite walk over markdown, which is metadata-sized work, and
    // putting it behind a two-slot bound would make an ordinary file-browser
    // drag wait behind two multi-gigabyte downloads. The lane exists to keep
    // interactive work ahead of bulk work, so admitting a move would invert it.
    let result = match op {
        TransferOp::Copy => {
            let job = match state.bulk_transfer.submit(move |cancel| {
                fs_transfer_batch_sync(
                    &workspace,
                    &self_writes,
                    op,
                    &dest_dir,
                    &sources,
                    Some(cancel),
                )
            }) {
                Ok(job) => job,
                Err(full) => return full.into_response(),
            };
            let (_alive_tx, alive_rx) = tokio::sync::oneshot::channel::<std::convert::Infallible>();
            if let Some(tracking) =
                crate::routes::transfer::TransferTracking::from_headers(&headers)
            {
                crate::routes::ws::spawn_transfer_queue_reporter(
                    state.events_tx.clone(),
                    tracking.window_id,
                    tracking.transfer_id,
                    job.tracker(),
                    alive_rx,
                );
            }
            match job.outcome().await {
                crate::bulk_transfer::BulkOutcome::Done(result) => result,
                crate::bulk_transfer::BulkOutcome::Cancelled => {
                    return err(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "copy did not complete".into(),
                    )
                }
            }
        }
        TransferOp::Move => {
            match tokio::task::spawn_blocking(move || {
                fs_transfer_batch_sync(&workspace, &self_writes, op, &dest_dir, &sources, None)
            })
            .await
            {
                Ok(result) => result,
                Err(join) => {
                    return err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string());
                }
            }
        }
    };

    let resp = match result {
        Ok(v) => v,
        Err(e) => return err_from(&e),
    };
    Json(resp).into_response()
}

/// Run one copy or move batch synchronously.
///
/// Every created, moved and rewritten path is noted HERE, as each workspace op
/// reports it, so the watcher's Created/Removed events are suppressed before
/// the caller's await returns. Noting them afterwards raced the watcher into
/// firing phantom external-edit prompts on files the user may have open. The
/// watcher still emits the events; the scoped `fs` registry routes them to
/// subscribed File Browser instances and the Graph.
///
/// `cancel` is `Some` only on the admitted copy path; a move holds no
/// admission, so it has no signal to observe.
fn fs_transfer_batch_sync(
    workspace: &chan_workspace::Workspace,
    self_writes: &crate::self_writes::SelfWrites,
    op: TransferOp,
    dest_dir: &str,
    sources: &[String],
    cancel: Option<&crate::bulk_transfer::BulkCancel>,
) -> chan_workspace::Result<TransferResponse> {
    let mut resp = TransferResponse::default();
    for src in sources {
        // Checked per source, so an abandoned batch returns its admission slot
        // at the next entry rather than at the end of the batch. One entry is
        // the finest granularity available here: `Workspace::copy` owns the
        // per-file work and takes no cancellation signal, so a single very
        // large file still holds its slot until that file finishes.
        if cancel.is_some_and(|cancel| cancel.is_cancelled()) {
            return Err(chan_workspace::ChanError::Io(
                "transfer cancelled before it completed".into(),
            ));
        }
        let name = basename(src);
        // A move into the source's own current parent is a no-op
        // (and would otherwise resolve a needless " copy" suffix).
        if op == TransferOp::Move && parent_dir(src) == dest_dir {
            resp.skipped.push(src.clone());
            continue;
        }
        // Resolve a non-colliding destination name; both copy and a
        // cut-into-a-collision get a Finder-style " copy" suffix so
        // we never overwrite.
        let dest = workspace.resolve_free_name(dest_dir, name)?;
        match op {
            TransferOp::Move => {
                let outcome = workspace.rename_with_link_rewrite(src, &dest)?;
                for (from, to) in &outcome.renamed {
                    self_writes.note(from);
                    self_writes.note(to);
                }
                for path in &outcome.rewritten {
                    self_writes.note(path);
                }
                resp.conflicts.extend(outcome.conflicts);
            }
            TransferOp::Copy => {
                let outcome = workspace.copy(src, &dest)?;
                for path in &outcome.created {
                    self_writes.note(path);
                }
            }
        }
        self_writes.note(src);
        self_writes.note(&dest);
        resp.moved.push(TransferItem {
            from: src.clone(),
            to: dest,
        });
    }
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only Markdown (.md) is the `document` wire kind; .txt is editable +
    /// searchable but rides `text` alongside source/config files. Contacts
    /// and directories take their own branches ahead of the classifier.
    #[test]
    fn project_kind_marks_only_markdown_as_document() {
        assert_eq!(project_kind("notes/a.md", false, false), Some("document"));
        assert_eq!(project_kind("notes/plain.txt", false, false), Some("text"));
        assert_eq!(project_kind("src/main.rs", false, false), Some("text"));
        assert_eq!(project_kind("logo.png", false, false), Some("media"));
        // Unknown extension is "pending" from the path alone; the
        // per-directory listing sniff (list_files_sync) resolves it to
        // text/binary. project_kind is path-only and never sniffs.
        assert_eq!(project_kind("archive.zip", false, false), Some("pending"));
        // Contact frontmatter wins over the .md document mapping.
        assert_eq!(
            project_kind("contacts/alex.md", false, true),
            Some("contact")
        );
        // Directories carry no wire kind.
        assert_eq!(project_kind("notes", true, false), None);
    }

    #[test]
    fn file_response_serializes_path_class_for_inspector_payload() {
        let response = FileResponse {
            path: "notes/a.md".to_string(),
            content: "hello".to_string(),
            mtime: Some(1),
            mtime_ns: Some("1000000000".to_string()),
            authority_version: None,
            disk_conflicted: false,
            path_class: Some(chan_workspace::PathClass {
                kind: chan_workspace::PathKind::RegularFile,
                permission: chan_workspace::PathPermission::ReadWrite,
                link_count: 2,
                target: None,
                target_escapes_workspace: false,
            }),
            writable: true,
            max_editable_bytes: chan_workspace::TEXT_WRITE_LIMIT,
        };

        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["path_class"]["kind"], "regular_file");
        assert_eq!(value["path_class"]["permission"], "read_write");
        assert_eq!(value["path_class"]["link_count"], 2);
        assert_eq!(
            value["max_editable_bytes"],
            chan_workspace::TEXT_WRITE_LIMIT
        );
    }

    #[test]
    fn tree_entry_serializes_path_class_for_file_browser_inspector() {
        let entry = TreeEntryView {
            path: "alias.md".to_string(),
            is_dir: false,
            mtime: None,
            size: 0,
            path_class: Some(chan_workspace::PathClass {
                kind: chan_workspace::PathKind::Symlink,
                permission: chan_workspace::PathPermission::ReadWrite,
                link_count: 1,
                target: Some(std::path::PathBuf::from("/etc/hosts")),
                target_escapes_workspace: true,
            }),
            kind: Some("binary"),
        };

        let value = serde_json::to_value(entry).unwrap();
        assert_eq!(value["path_class"]["kind"], "symlink");
        assert_eq!(value["path_class"]["target"], "/etc/hosts");
        assert_eq!(value["path_class"]["target_escapes_workspace"], true);
    }

    #[test]
    fn transfer_body_deserializes_the_fb_clipboard_wire_shape() {
        // The FB clipboard + multi-drag posts this shape; pin it so a
        // wire change is an explicit edit, not silent client breakage.
        let body: TransferBody = serde_json::from_value(serde_json::json!({
            "op": "copy",
            "sources": ["notes/a.md", "notes/sub"],
            "dest_dir": "archive"
        }))
        .unwrap();
        assert!(matches!(body.op, TransferOp::Copy));
        assert_eq!(body.sources, vec!["notes/a.md", "notes/sub"]);
        assert_eq!(body.dest_dir, "archive");

        let mv: TransferBody = serde_json::from_value(serde_json::json!({
            "op": "move",
            "sources": ["x.md"],
            "dest_dir": ""
        }))
        .unwrap();
        assert!(matches!(mv.op, TransferOp::Move));
    }

    #[test]
    fn basename_and_parent_dir_split_workspace_rooted_paths() {
        assert_eq!(basename("notes/sub/a.md"), "a.md");
        assert_eq!(basename("top.md"), "top.md");
        assert_eq!(parent_dir("notes/sub/a.md"), "notes/sub");
        assert_eq!(parent_dir("top.md"), "");
    }

    #[cfg(unix)]
    #[test]
    fn directory_listing_keeps_symlink_with_path_class() {
        use std::os::unix::fs::symlink;

        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        std::fs::write(root.path().join("note.md"), "hi").unwrap();
        symlink("note.md", root.path().join("alias.md")).unwrap();

        let entries = list_dir_entries(&workspace, "").unwrap();
        assert!(entries.iter().any(|entry| entry.path == "alias.md"));
        let class = path_class_for_wire(&workspace, "alias.md").expect("symlink path class");
        assert_eq!(class.kind, chan_workspace::PathKind::Symlink);
    }
}

#[cfg(test)]
mod doc_divert_tests {
    use std::collections::HashMap;
    use std::convert::Infallible;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, RwLock};

    use axum::body::{to_bytes, Body, Bytes};
    use axum::extract::{Path as AxumPath, Query, State};
    use axum::http::{header, HeaderMap, Request, StatusCode};
    use axum::Json;
    use chan_workspace::{SearchAggression, WatchEvent, WatchKind};
    use serde_json::Value;
    use tempfile::TempDir;
    use tokio::sync::{broadcast, watch};
    use tower::ServiceExt;

    use super::{
        api_read_file, api_write_file as api_write_file_raw, ReadFileQuery, WriteBody,
        WriteFileQuery,
    };
    use crate::doc_sessions::changes::{replace_diff, UpdateJson};
    use crate::self_writes::SelfWrites;
    use crate::state::{AppState, WorkspaceCell};
    use crate::terminal_sessions::{Registry as TerminalRegistry, RegistryConfig};
    use crate::{EditorPrefs, ServerConfig};

    pub(super) fn divert_app() -> (TempDir, TempDir, Arc<AppState>) {
        divert_app_with_tenant(
            crate::state::test_support::make_test_bulk_transfer_tenant(),
            None,
        )
    }

    /// `divert_app` over a caller-supplied tenant, for tests that saturate
    /// admission and therefore must not use the shared test lane. The caller
    /// keeps the lane alive; dropping it shuts the workers down.
    ///
    /// `transfer_cap` configures the workspace's effective transfer ceiling, so
    /// a route-level boundary test can cross it without writing gigabytes.
    pub(super) fn divert_app_with_tenant(
        bulk: crate::bulk_transfer::BulkTransferTenant,
        transfer_cap: Option<u64>,
    ) -> (TempDir, TempDir, Arc<AppState>) {
        let cfg = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let config_path = cfg.path().join("config.toml");
        if let Some(cap) = transfer_cap {
            std::fs::write(
                &config_path,
                format!("workspaces = []\n[transfer]\nmax_bytes = {cap}\n"),
            )
            .unwrap();
        }
        let lib = chan_workspace::Library::open_at(config_path).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();

        let (events_tx, _) = broadcast::channel::<String>(1);
        let (index_events_tx, _) = broadcast::channel::<chan_workspace::WatchEvent>(1);
        let indexer = Arc::new(crate::indexer::Indexer::spawn(
            workspace.clone(),
            index_events_tx.subscribe(),
            false,
            SearchAggression::Conservative,
            Arc::new(chan_workspace::NoProgress),
        ));
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        std::mem::forget(shutdown_tx);

        let state = Arc::new(AppState {
            library: lib,
            workspace_root: root.path().to_path_buf(),
            workspace_cell: Arc::new(RwLock::new(Some(WorkspaceCell {
                workspace,
                watch_handle: None,
                indexer,
            }))),
            token: None,
            prefix: Arc::new(RwLock::new(String::new())),
            settings_disabled: false,
            last_activity: Arc::new(AtomicU64::new(0)),
            events_tx,
            index_events_tx,
            server_config: Mutex::new(ServerConfig::default()),
            editor_prefs: Mutex::new(EditorPrefs::default()),
            config_revision: AtomicU64::new(1),
            config_write_serial: Mutex::new(()),
            self_writes: Arc::new(SelfWrites::new()),
            terminal_sessions: Arc::new(TerminalRegistry::new(RegistryConfig {
                workspace_root: root.path().to_path_buf(),
                mcp_socket_path: None,
                control_socket_path: None,
                terminal: ServerConfig::default().terminal,
            })),
            doc_sessions: Arc::new(crate::doc_sessions::DocRegistry::new()),
            scene_sessions: Arc::new(crate::scene_sessions::SceneRegistry::new()),
            shutdown_rx,
            scope_registry: Arc::new(crate::bus::ScopeRegistry::new()),
            survey_bus: Arc::new(crate::survey::SurveyBus::new()),
            window_bus: Arc::new(crate::window_bus::WindowBus::new()),
            handover_bus: Arc::new(crate::handover_bus::HandoverBus::new()),
            ephemeral_sessions: Mutex::new(HashMap::new()),
            ephemeral_files_sessions: Mutex::new(HashMap::new()),
            terminal_session_dir: None,
            window_presence: Arc::new(crate::window_presence::WindowPresence::new()),
            session_registry: Arc::new(crate::session_presence::SessionRegistry::new()),
            pending_window_commands: std::sync::Arc::new(Default::default()),
            window_transfers: Arc::new(crate::window_transfers::WindowTransfers::new()),
            window_titles: Arc::new(crate::window_titles::WindowTitles::new()),
            bulk_transfer: bulk,
            instance_id: "test-instance".to_string(),
            standalone_files: None,
        });
        (cfg, root, state)
    }

    pub(super) async fn body_json(resp: axum::response::Response) -> Value {
        let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    pub(super) async fn raw_put(
        state: State<Arc<AppState>>,
        path: AxumPath<String>,
        content: String,
        expected_mtime: Option<i64>,
        expected_mtime_ns: Option<String>,
        authority_version: Option<u64>,
    ) -> axum::response::Response {
        raw_put_body(
            state,
            path,
            Body::from(content),
            expected_mtime,
            expected_mtime_ns,
            authority_version,
        )
        .await
    }

    #[tokio::test]
    async fn multipart_upload_streams_after_destination_metadata() {
        let (_cfg, root, state) = divert_app();
        state.try_workspace().unwrap().create_dir("docs").unwrap();
        let router = crate::router(state.clone());
        let boundary = "chan-upload-boundary";
        let body = format!(
            "--{boundary}\r\n\
             Content-Disposition: form-data; name=\"dir\"\r\n\r\n\
             docs\r\n\
             --{boundary}\r\n\
             Content-Disposition: form-data; name=\"file\"; filename=\"note.bin\"\r\n\
             Content-Type: application/octet-stream\r\n\r\n\
             streamed-bytes\r\n\
             --{boundary}--\r\n"
        );

        let response = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/files/upload")
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
        let response_body = body_json(response).await;
        assert_eq!(response_body["path"], "docs/note.bin");
        assert_eq!(
            std::fs::read(root.path().join("docs/note.bin")).unwrap(),
            b"streamed-bytes"
        );

        let file_first = format!(
            "--{boundary}\r\n\
             Content-Disposition: form-data; name=\"file\"; filename=\"wrong.bin\"\r\n\r\n\
             no-write\r\n\
             --{boundary}\r\n\
             Content-Disposition: form-data; name=\"dir\"\r\n\r\n\
             docs\r\n\
             --{boundary}--\r\n"
        );
        let response = crate::router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/files/upload")
                    .header(
                        header::CONTENT_TYPE,
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .body(Body::from(file_first))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(!root.path().join("wrong.bin").exists());
        assert!(!root.path().join("docs/wrong.bin").exists());
    }

    #[tokio::test]
    async fn workspace_router_serves_the_fs_namespace_and_files_alias() {
        let (_cfg, _root, state) = divert_app();
        state
            .try_workspace()
            .unwrap()
            .write_text("alias.md", "namespace probe")
            .unwrap();
        let app = crate::router(state);

        for namespace in ["fs", "files"] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/{namespace}/alias.md"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(body_json(response).await["content"], "namespace probe");
        }
    }

    pub(super) async fn raw_put_body(
        state: State<Arc<AppState>>,
        path: AxumPath<String>,
        body: Body,
        expected_mtime: Option<i64>,
        expected_mtime_ns: Option<String>,
        authority_version: Option<u64>,
    ) -> axum::response::Response {
        api_write_file_raw(
            state,
            path,
            Query(WriteFileQuery {
                expected_mtime,
                expected_mtime_ns,
                authority_version,
            }),
            body,
        )
        .await
    }

    pub(super) async fn api_write_file(
        state: State<Arc<AppState>>,
        path: AxumPath<String>,
        Json(body): Json<WriteBody>,
    ) -> axum::response::Response {
        let rel = path.0.clone();
        let authority_version = state
            .0
            .doc_sessions
            .get(&rel)
            .map(|session| session.http_write_view().authority_version)
            .or_else(|| {
                state
                    .0
                    .scene_sessions
                    .get(&rel)
                    .map(|session| session.http_write_view().authority_version)
            });
        raw_put(
            state,
            path,
            body.content,
            body.expected_mtime,
            body.expected_mtime_ns,
            authority_version,
        )
        .await
    }

    /// A legacy-oversize file's save must reach the workspace's own
    /// size check: axum's 2 MiB default body limit would otherwise
    /// reject every save of a >2 MiB document before the handler runs,
    /// defeating the max(prev_size, limit) legacy rule with an opaque
    /// HTTP-layer error. Mirrors window.rs's reply-body test.
    #[tokio::test]
    async fn put_files_accepts_legacy_oversize_bodies() {
        let (_cfg, root, state) = divert_app();
        let prev = "y".repeat(3 * 1024 * 1024);
        std::fs::write(root.path().join("legacy.md"), &prev).unwrap();
        let token_ns = state
            .try_workspace()
            .unwrap()
            .stat("legacy.md")
            .unwrap()
            .mtime_ns
            .unwrap();
        let router = crate::router(state);

        // 2.5 MiB body: under prev_size (allowed by the legacy rule),
        // over axum's 2 MiB default (rejected without the raised
        // DefaultBodyLimit on the route).
        let shrunk = "z".repeat(5 * 1024 * 1024 / 2);
        let uri = format!("/api/files/legacy.md?expected_mtime_ns={}", token_ns);
        let resp = router
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(uri)
                    .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
                    .body(Body::from(shrunk.clone()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "the raised DefaultBodyLimit on PUT /api/files was removed"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("legacy.md")).unwrap(),
            shrunk
        );
    }

    #[tokio::test]
    async fn svg_read_is_an_attached_sandboxed_resource() {
        let (_cfg, root, state) = divert_app();
        std::fs::write(
            root.path().join("active.svg"),
            r#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#,
        )
        .unwrap();

        let resp = api_read_file(
            State(state),
            AxumPath("active.svg".to_string()),
            Query(ReadFileQuery::default()),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CONTENT_DISPOSITION).unwrap(),
            "attachment; filename=\"active.svg\""
        );
        assert_eq!(
            resp.headers().get("content-security-policy").unwrap(),
            "sandbox"
        );
        assert_eq!(
            resp.headers().get("x-content-type-options").unwrap(),
            "nosniff"
        );
    }

    #[tokio::test]
    async fn get_divert_serves_authority_text_and_session_token_in_all_modes() {
        let (_cfg, root, state) = divert_app();
        let workspace = state.try_workspace().unwrap();
        workspace.write_text("n.md", "disk v1\n").unwrap();

        let mut handle = state
            .doc_sessions
            .attach(&workspace, "n.md", "win-1", None)
            .await
            .unwrap();
        let _frames = handle.take_frames();
        // Live edit, not yet flushed: authority and disk now differ.
        handle
            .push(
                0,
                vec![UpdateJson {
                    client_id: "c-1".into(),
                    changes: replace_diff("disk v1\n", "live v2\n"),
                }],
            )
            .unwrap();
        let token = handle.session().token().expect("seeded token");
        let authority_version = handle.session().http_write_view().authority_version;

        // Plain JSON: authority text under the session token.
        let resp = api_read_file(
            State(state.clone()),
            AxumPath("n.md".to_string()),
            Query(ReadFileQuery {
                download: None,
                stream: None,
                root: None,
            }),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["content"], "live v2\n");
        assert_eq!(v["mtime_ns"], token.to_string());
        assert_eq!(v["authority_version"], authority_version);
        assert_eq!(v["disk_conflicted"], false);
        assert_eq!(v["writable"], true);

        // Stream: Meta + ONE Chunk + Done, same token, same text; the
        // shape is indistinguishable from the disk stream.
        let resp = api_read_file(
            State(state.clone()),
            AxumPath("n.md".to_string()),
            Query(ReadFileQuery {
                download: None,
                stream: Some("1".into()),
                root: None,
            }),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let lines: Vec<Value> = std::str::from_utf8(&bytes)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 3, "{lines:?}");
        assert_eq!(lines[0]["type"], "meta");
        assert_eq!(lines[0]["mtime_ns"], token.to_string());
        assert_eq!(lines[0]["authority_version"], authority_version);
        assert_eq!(lines[0]["disk_conflicted"], false);
        assert_eq!(lines[0]["size"].as_u64(), Some("live v2\n".len() as u64));
        assert_eq!(lines[1]["type"], "chunk");
        assert_eq!(lines[1]["content"], "live v2\n");
        assert_eq!(lines[2]["type"], "done");

        // Download: raw authority bytes with attachment headers.
        let resp = api_read_file(
            State(state.clone()),
            AxumPath("n.md".to_string()),
            Query(ReadFileQuery {
                download: Some("1".into()),
                stream: None,
                root: None,
            }),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(resp.headers().get(header::CONTENT_DISPOSITION).is_some());
        let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert_eq!(std::str::from_utf8(&bytes).unwrap(), "live v2\n");

        // Disk still holds v1: reads never touch it while attached.
        assert_eq!(
            std::fs::read_to_string(root.path().join("n.md")).unwrap(),
            "disk v1\n"
        );
    }

    #[tokio::test]
    async fn put_divert_cas_matrix() {
        let (_cfg, root, state) = divert_app();
        let workspace = state.try_workspace().unwrap();
        workspace.write_text("n.md", "one\n").unwrap();
        let mut handle = state
            .doc_sessions
            .attach(&workspace, "n.md", "win-1", None)
            .await
            .unwrap();
        let mut frames = handle.take_frames();
        let session = handle.session().clone();
        let token0 = session.token().expect("seeded token");

        // Wrong ns token: 409 carrying the SESSION token, nothing
        // applied anywhere.
        let resp = api_write_file(
            State(state.clone()),
            AxumPath("n.md".into()),
            Json(WriteBody {
                content: "x\n".into(),
                expected_mtime: None,
                expected_mtime_ns: Some((token0 + 1).to_string()),
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        let v = body_json(resp).await;
        assert_eq!(v["current_mtime_ns"], token0.to_string());
        assert_eq!(session.authority_view().0, "one\n");

        // Correct ns token: 200, $http update fanned live, disk
        // flushed, reply carries the post-flush session token.
        let resp = api_write_file(
            State(state.clone()),
            AxumPath("n.md".into()),
            Json(WriteBody {
                content: "two\n".into(),
                expected_mtime: None,
                expected_mtime_ns: Some(token0.to_string()),
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        // Coherence, not delta: coarse filesystem clocks can hand
        // back-to-back writes identical mtimes, so the pin is that the
        // reply token IS the session token, whatever its value.
        let token1 = session.token().expect("post-flush token");
        assert_eq!(v["mtime_ns"], token1.to_string());
        assert_eq!(session.authority_view().0, "two\n");
        assert_eq!(
            std::fs::read_to_string(root.path().join("n.md")).unwrap(),
            "two\n"
        );
        let mut saw_http = false;
        while let Ok(raw) = frames.try_recv() {
            let f: Value = serde_json::from_str(&raw).unwrap();
            if f["type"] == "updates" && f["updates"][0]["clientID"] == "$http" {
                saw_http = true;
            }
        }
        assert!(saw_http, "attached clients must see the PUT as $http");

        // Legacy seconds token, matching: accepted.
        let resp = api_write_file(
            State(state.clone()),
            AxumPath("n.md".into()),
            Json(WriteBody {
                content: "three\n".into(),
                expected_mtime: Some(token1 / 1_000_000_000),
                expected_mtime_ns: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let token2 = session.token().expect("post-flush token");

        // Legacy seconds token, stale: 409.
        let resp = api_write_file(
            State(state.clone()),
            AxumPath("n.md".into()),
            Json(WriteBody {
                content: "nope\n".into(),
                expected_mtime: Some(token2 / 1_000_000_000 - 10),
                expected_mtime_ns: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        assert_eq!(session.authority_view().0, "three\n");

        // A changed write under a live authority also requires its
        // open-time disk token. Disk-only writes retain the historical
        // no-token last-write-wins behavior.
        let resp = api_write_file(
            State(state.clone()),
            AxumPath("n.md".into()),
            Json(WriteBody {
                content: "four\n".into(),
                expected_mtime: None,
                expected_mtime_ns: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::PRECONDITION_REQUIRED);
        assert_eq!(
            std::fs::read_to_string(root.path().join("n.md")).unwrap(),
            "three\n"
        );
    }

    #[tokio::test]
    async fn put_divert_changed_body_without_authority_version_is_precondition_required() {
        let (_cfg, _root, state) = divert_app();
        let workspace = state.try_workspace().unwrap();
        workspace.write_text("n.md", "one\n").unwrap();
        let handle = state
            .doc_sessions
            .attach(&workspace, "n.md", "win-1", None)
            .await
            .unwrap();
        let token = handle.session().token().expect("seeded token");

        let resp = raw_put(
            State(state),
            AxumPath("n.md".into()),
            "two\n".into(),
            None,
            Some(token.to_string()),
            None,
        )
        .await;

        assert_eq!(resp.status(), StatusCode::PRECONDITION_REQUIRED);
        assert_eq!(handle.session().authority_view().0, "one\n");
    }

    #[tokio::test]
    async fn put_divert_stale_authority_or_missing_disk_token_is_rejected() {
        let (_cfg, _root, state) = divert_app();
        let workspace = state.try_workspace().unwrap();
        workspace.write_text("n.md", "one\n").unwrap();
        let handle = state
            .doc_sessions
            .attach(&workspace, "n.md", "win-1", None)
            .await
            .unwrap();
        let token = handle.session().token().expect("seeded token");

        let stale = raw_put(
            State(state.clone()),
            AxumPath("n.md".into()),
            "two\n".into(),
            None,
            Some(token.to_string()),
            Some(1),
        )
        .await;
        assert_eq!(stale.status(), StatusCode::CONFLICT);
        let stale_body = body_json(stale).await;
        assert_eq!(stale_body["current_authority_version"], 0);

        let missing_disk_token = raw_put(
            State(state),
            AxumPath("n.md".into()),
            "two\n".into(),
            None,
            None,
            Some(0),
        )
        .await;
        assert_eq!(
            missing_disk_token.status(),
            StatusCode::PRECONDITION_REQUIRED
        );
        assert_eq!(handle.session().authority_view().0, "one\n");
    }

    #[tokio::test]
    async fn oversized_stream_stops_early_and_leaves_target_unchanged() {
        let (_cfg, _root, state) = divert_app();
        let workspace = state.try_workspace().unwrap();
        workspace.write_text("n.md", "original\n").unwrap();
        let token = workspace.stat("n.md").unwrap().mtime_ns.unwrap();
        let chunks_seen = Arc::new(AtomicUsize::new(0));
        let stream = futures::stream::unfold(
            (0usize, Arc::clone(&chunks_seen)),
            |(index, chunks_seen)| async move {
                if index == 100 {
                    return None;
                }
                chunks_seen.fetch_add(1, Ordering::Relaxed);
                Some((
                    Ok::<Bytes, Infallible>(Bytes::from(vec![b'x'; 64 * 1024])),
                    (index + 1, chunks_seen),
                ))
            },
        );

        let resp = raw_put_body(
            State(state.clone()),
            AxumPath("n.md".into()),
            Body::from_stream(stream),
            None,
            Some(token.to_string()),
            None,
        )
        .await;

        assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(workspace.read_text("n.md").unwrap(), "original\n");
        assert!(
            chunks_seen.load(Ordering::Relaxed) < 100,
            "the producer must stop when the bounded consumer rejects overflow"
        );
        assert!(!state.self_writes.should_suppress("n.md"));
    }

    #[tokio::test]
    async fn streamed_put_accepts_a_legacy_file_larger_than_fifty_mib() {
        let (_cfg, root, state) = divert_app();
        let workspace = state.try_workspace().unwrap();
        // A text write, so the budget under test is the semantic one rather
        // than the transfer ceiling; fifty MiB is simply well past it.
        let replacement_size = 50 * 1024 * 1024 + 64 * 1024;
        let legacy = std::fs::File::create(root.path().join("legacy.md")).unwrap();
        legacy.set_len(replacement_size + 64 * 1024).unwrap();
        drop(legacy);
        let token = workspace.stat("legacy.md").unwrap().mtime_ns.unwrap();
        let stream = futures::stream::unfold(replacement_size, |remaining| async move {
            if remaining == 0 {
                return None;
            }
            let chunk_len = remaining.min(64 * 1024) as usize;
            Some((
                Ok::<Bytes, Infallible>(Bytes::from(vec![b'z'; chunk_len])),
                remaining - chunk_len as u64,
            ))
        });

        let resp = raw_put_body(
            State(state),
            AxumPath("legacy.md".into()),
            Body::from_stream(stream),
            None,
            Some(token.to_string()),
            None,
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            std::fs::metadata(root.path().join("legacy.md"))
                .unwrap()
                .len(),
            replacement_size
        );
    }

    #[tokio::test]
    async fn put_divert_equal_body_forces_durable_flush() {
        let (_cfg, root, state) = divert_app();
        let workspace = state.try_workspace().unwrap();
        workspace.write_text("n.md", "one\n").unwrap();
        let mut handle = state
            .doc_sessions
            .attach(&workspace, "n.md", "win-1", None)
            .await
            .unwrap();
        let mut frames = handle.take_frames();
        let session = handle.session().clone();
        let token0 = session.token().expect("seeded token");

        // Stale token + byte-identical body: the funnel-fallback shape
        // (the client re-sends the text the authority already holds
        // while the freshest flush token is still in flight to it).
        // Durable confirmation: 200 carrying the session token, no
        // synthetic $http update.
        let resp = api_write_file(
            State(state.clone()),
            AxumPath("n.md".into()),
            Json(WriteBody {
                content: "one\n".into(),
                expected_mtime: None,
                expected_mtime_ns: Some((token0 + 1).to_string()),
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        let durable_token = session.token().expect("forced-flush token");
        assert_eq!(v["mtime_ns"], durable_token.to_string());
        while let Ok(raw) = frames.try_recv() {
            let f: Value = serde_json::from_str(&raw).unwrap();
            assert_ne!(
                f["updates"][0]["clientID"], "$http",
                "an equal-body adopt must not fan a replace"
            );
        }

        // Live unflushed edit: authority text moves ahead of disk while
        // the token stays put. An equal-to-authority body must force or
        // confirm a durable flush before returning 200.
        handle
            .push(
                0,
                vec![UpdateJson {
                    client_id: "c-1".into(),
                    changes: replace_diff("one\n", "live v2\n"),
                }],
            )
            .unwrap();
        let resp = api_write_file(
            State(state.clone()),
            AxumPath("n.md".into()),
            Json(WriteBody {
                content: "live v2\n".into(),
                expected_mtime: None,
                expected_mtime_ns: Some((token0 + 1).to_string()),
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        let forced_token = session.token().expect("forced-flush token");
        assert_eq!(v["mtime_ns"], forced_token.to_string());
        assert_eq!(
            std::fs::read_to_string(root.path().join("n.md")).unwrap(),
            "live v2\n"
        );

        // Stale token + DIFFERENT body: a real potential lost update,
        // still 409 with the session token, nothing applied.
        let resp = api_write_file(
            State(state.clone()),
            AxumPath("n.md".into()),
            Json(WriteBody {
                content: "three\n".into(),
                expected_mtime: None,
                expected_mtime_ns: Some((token0 + 1).to_string()),
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        let v = body_json(resp).await;
        assert_eq!(v["current_mtime_ns"], forced_token.to_string());
        assert_eq!(session.authority_view().0, "live v2\n");
    }

    #[tokio::test]
    async fn put_divert_refuses_conflicted_doc_without_dropping_body() {
        let (_cfg, _root, state) = divert_app();
        let workspace = state.try_workspace().unwrap();
        workspace.write_text("n.md", "base\n").unwrap();
        let mut handle = state
            .doc_sessions
            .attach(&workspace, "n.md", "win-1", None)
            .await
            .unwrap();
        let mut frames = handle.take_frames();
        let session = handle.session().clone();
        session.apply_replace("c-1", "local\n").unwrap();
        while frames.try_recv().is_ok() {}

        workspace.write_text("n.md", "disk\n").unwrap();
        let stat = workspace.stat("n.md").unwrap();
        session.test_force_conflict("disk\n".into(), &stat);
        // Drain the conflict announcement; the assertions below are
        // about the PUT staying silent.
        while frames.try_recv().is_ok() {}
        let conflict_token = stat.mtime_ns.expect("conflicting disk token");
        let authority_version = session.http_read_view().authority_version;

        let get = api_read_file(
            State(state.clone()),
            AxumPath("n.md".into()),
            Query(ReadFileQuery::default()),
            HeaderMap::new(),
        )
        .await;
        let get_body = body_json(get).await;
        assert_eq!(get_body["authority_version"], authority_version);
        assert_eq!(get_body["disk_conflicted"], true);

        let stream = api_read_file(
            State(state.clone()),
            AxumPath("n.md".into()),
            Query(ReadFileQuery {
                download: None,
                stream: Some("1".into()),
                root: None,
            }),
            HeaderMap::new(),
        )
        .await;
        let stream_bytes = to_bytes(stream.into_body(), usize::MAX).await.unwrap();
        let first: Value = serde_json::from_str(
            std::str::from_utf8(&stream_bytes)
                .unwrap()
                .lines()
                .next()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(first["type"], "meta");
        assert_eq!(first["authority_version"], authority_version);
        assert_eq!(first["disk_conflicted"], true);

        let resp = api_write_file(
            State(state.clone()),
            AxumPath("n.md".into()),
            Json(WriteBody {
                content: "local\n".into(),
                expected_mtime: None,
                expected_mtime_ns: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::CONFLICT);
        let body = body_json(resp).await;
        assert_eq!(body["current_mtime_ns"], conflict_token.to_string());
        assert_eq!(session.authority_view().0, "local\n");
        assert_eq!(workspace.read_text("n.md").unwrap(), "disk\n");
        assert!(frames.try_recv().is_err(), "conflicted PUT must not fan");
    }

    #[tokio::test]
    async fn conflict_resolution_route_reloads_disk_and_overwrites_from_doc_authority() {
        let (_cfg, _root, state) = divert_app();
        let workspace = state.try_workspace().unwrap();
        workspace.write_text("resolve.md", "baseline\n").unwrap();
        let handle = state
            .doc_sessions
            .attach(&workspace, "resolve.md", "win-1", None)
            .await
            .unwrap();
        let session = handle.session().clone();

        session.apply_replace("local", "local\n").unwrap();
        workspace.write_text("resolve.md", "disk\n").unwrap();
        let stat = workspace.stat("resolve.md").unwrap();
        session.test_force_conflict("disk\n".into(), &stat);

        let response = crate::router(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/session-conflicts/resolve")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"path":"resolve.md","action":"reload"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["content"], "disk\n");
        assert_eq!(body["disk_conflicted"], false);
        assert_eq!(session.authority_view().0, "disk\n");

        session.apply_replace("local", "authority\n").unwrap();
        workspace.write_text("resolve.md", "disk again\n").unwrap();
        let stat = workspace.stat("resolve.md").unwrap();
        session.test_force_conflict("disk again\n".into(), &stat);

        let response = crate::router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/session-conflicts/resolve")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"path":"resolve.md","action":"overwrite"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["content"], "authority\n");
        assert_eq!(body["disk_conflicted"], false);
        assert_eq!(workspace.read_text("resolve.md").unwrap(), "authority\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn put_divert_answers_503_when_the_forced_flush_fails() {
        use std::os::unix::fs::PermissionsExt;

        let (_cfg, root, state) = divert_app();
        let workspace = state.try_workspace().unwrap();
        workspace.write_text("n.md", "one\n").unwrap();
        let mut handle = state
            .doc_sessions
            .attach(&workspace, "n.md", "win-1", None)
            .await
            .unwrap();
        let _frames = handle.take_frames();
        let session = handle.session().clone();
        let token0 = session.token().expect("seeded token");

        // Make the workspace root unwritable so the flush's temp-file
        // rename fails underneath the accepted write.
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
        let resp = api_write_file(
            State(state.clone()),
            AxumPath("n.md".into()),
            Json(WriteBody {
                content: "two\n".into(),
                expected_mtime: None,
                expected_mtime_ns: Some(token0.to_string()),
            }),
        )
        .await;
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();

        // Honest 503: the content is authoritative in the session, the
        // disk is untouched, and a retry (writable again) succeeds and
        // lands it.
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(session.authority_view().0, "two\n");
        assert_eq!(
            std::fs::read_to_string(root.path().join("n.md")).unwrap(),
            "one\n"
        );
        let resp = api_write_file(
            State(state.clone()),
            AxumPath("n.md".into()),
            Json(WriteBody {
                content: "two\n".into(),
                expected_mtime: None,
                expected_mtime_ns: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            std::fs::read_to_string(root.path().join("n.md")).unwrap(),
            "two\n"
        );
    }

    #[tokio::test]
    async fn put_on_removed_session_takes_the_classic_recreate_path() {
        // Root's flagged edge: an equal-content PUT on a session in the
        // removed state no-ops in apply_replace and flushes "true", so
        // the divert would 200 with the file still absent. The gate
        // sends removed-state PUTs down the classic path, which
        // recreates.
        let (_cfg, root, state) = divert_app();
        let workspace = state.try_workspace().unwrap();
        workspace.write_text("n.md", "one\n").unwrap();
        let mut handle = state
            .doc_sessions
            .attach(&workspace, "n.md", "win-1", None)
            .await
            .unwrap();
        let _frames = handle.take_frames();
        let session = handle.session().clone();

        std::fs::remove_file(root.path().join("n.md")).unwrap();
        state
            .doc_sessions
            .reconcile_event(
                &workspace,
                WatchEvent::file(
                    WatchKind::Removed,
                    "n.md",
                    chan_workspace::WorkspaceGeneration::default(),
                ),
            )
            .await;
        // Absence corroborates across two observations.
        session.test_backdate_pending_removal();
        state.doc_sessions.reconcile_pending(&workspace).await;
        assert_eq!(session.token(), None, "removed state");

        // Equal content, no CAS token: must recreate on disk, not 200
        // into the void.
        let resp = api_write_file(
            State(state.clone()),
            AxumPath("n.md".into()),
            Json(WriteBody {
                content: "one\n".into(),
                expected_mtime: None,
                expected_mtime_ns: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            std::fs::read_to_string(root.path().join("n.md")).unwrap(),
            "one\n"
        );
    }
}

#[cfg(test)]
mod scene_divert_tests {
    use axum::body::Body;
    use axum::extract::{Path as AxumPath, Query, State};
    use axum::http::{header, HeaderMap, Request, StatusCode};
    use axum::Json;
    use chan_workspace::{WatchEvent, WatchKind};
    use serde_json::{json, Value};
    use tower::ServiceExt;

    use super::doc_divert_tests::{api_write_file, body_json, divert_app};
    use super::{api_read_file, ReadFileQuery, WriteBody};

    fn scene_body(elements: Value) -> String {
        json!({
            "type": "excalidraw",
            "version": 2,
            "source": "t",
            "elements": elements,
            "appState": {},
            "files": {},
        })
        .to_string()
    }

    fn elem(id: &str, version: u64, nonce: u64, index: &str) -> Value {
        json!({
            "id": id,
            "type": "rectangle",
            "version": version,
            "versionNonce": nonce,
            "index": index,
            "isDeleted": false,
        })
    }

    #[tokio::test]
    async fn get_divert_serves_the_scene_file_form_under_the_session_token() {
        let (_cfg, root, state) = divert_app();
        let workspace = state.try_workspace().unwrap();
        workspace
            .write_text("b.excalidraw", &scene_body(json!([elem("x", 1, 1, "a1")])))
            .unwrap();
        let mut handle = state
            .scene_sessions
            .attach(&workspace, "b.excalidraw", "win-1")
            .await
            .unwrap();
        let _frames = handle.take_frames();
        // Live push, not yet flushed: authority and disk now differ.
        handle
            .push(vec![elem("y", 1, 1, "a2")], None, None)
            .unwrap();
        let token = handle.session().token().expect("seeded token");
        let authority_version = handle.session().http_read_view().authority_version;

        let resp = api_read_file(
            State(state.clone()),
            AxumPath("b.excalidraw".to_string()),
            Query(ReadFileQuery {
                download: None,
                stream: None,
                root: None,
            }),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["mtime_ns"], token.to_string());
        assert_eq!(v["authority_version"], authority_version);
        assert_eq!(v["disk_conflicted"], false);
        let content: Value = serde_json::from_str(v["content"].as_str().unwrap()).unwrap();
        let ids: Vec<&str> = content["elements"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["x", "y"], "authority file form, not the disk bytes");

        // Disk still holds only x: reads never touch it while attached.
        let on_disk: Value = serde_json::from_str(
            &std::fs::read_to_string(root.path().join("b.excalidraw")).unwrap(),
        )
        .unwrap();
        assert_eq!(on_disk["elements"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn put_divert_cas_replace_and_bad_body() {
        let (_cfg, root, state) = divert_app();
        let workspace = state.try_workspace().unwrap();
        workspace
            .write_text("b.excalidraw", &scene_body(json!([elem("x", 5, 10, "a1")])))
            .unwrap();
        let mut handle = state
            .scene_sessions
            .attach(&workspace, "b.excalidraw", "win-1")
            .await
            .unwrap();
        let mut frames = handle.take_frames();
        let session = handle.session().clone();
        let token0 = session.token().expect("seeded token");
        while frames.try_recv().is_ok() {}

        // Wrong ns token: 409 carrying the SESSION token, nothing
        // applied anywhere.
        let resp = api_write_file(
            State(state.clone()),
            AxumPath("b.excalidraw".into()),
            Json(WriteBody {
                content: scene_body(json!([])),
                expected_mtime: None,
                expected_mtime_ns: Some((token0 + 1).to_string()),
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        let v = body_json(resp).await;
        assert_eq!(v["current_mtime_ns"], token0.to_string());

        // A body that is not a scene against the live session: 400,
        // session untouched, nothing fanned.
        let resp = api_write_file(
            State(state.clone()),
            AxumPath("b.excalidraw".into()),
            Json(WriteBody {
                content: "{not a scene".into(),
                expected_mtime: None,
                expected_mtime_ns: Some(token0.to_string()),
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert!(frames.try_recv().is_err(), "nothing fanned");

        // Correct token: 200, the hand-edit fans live with a bumped
        // version, the disk flushes, and the reply carries the
        // post-flush session token.
        let mut edited = elem("x", 5, 10, "a1");
        edited
            .as_object_mut()
            .unwrap()
            .insert("angle".into(), json!(30));
        let resp = api_write_file(
            State(state.clone()),
            AxumPath("b.excalidraw".into()),
            Json(WriteBody {
                content: scene_body(json!([edited])),
                expected_mtime: None,
                expected_mtime_ns: Some(token0.to_string()),
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        let token1 = session.token().expect("post-flush token");
        assert_eq!(v["mtime_ns"], token1.to_string());
        assert_ne!(token0, token1);
        let fanned: Value = serde_json::from_str(&frames.try_recv().unwrap()).unwrap();
        assert_eq!(fanned["type"], "update");
        assert_eq!(
            fanned["elements"][0]["version"], 6,
            "replace bumps past the stored version"
        );
        let flush: Value = serde_json::from_str(&frames.try_recv().unwrap()).unwrap();
        assert_eq!(flush["type"], "flush");
        let on_disk: Value = serde_json::from_str(
            &std::fs::read_to_string(root.path().join("b.excalidraw")).unwrap(),
        )
        .unwrap();
        assert_eq!(on_disk["elements"][0]["angle"], 30);
    }

    #[tokio::test]
    async fn put_divert_refuses_conflicted_scene_without_dropping_body() {
        let (_cfg, _root, state) = divert_app();
        let workspace = state.try_workspace().unwrap();
        let mut baseline = elem("x", 1, 1, "a1");
        baseline["angle"] = json!(0);
        workspace
            .write_text("b.excalidraw", &scene_body(json!([baseline])))
            .unwrap();
        let mut handle = state
            .scene_sessions
            .attach(&workspace, "b.excalidraw", "win-1")
            .await
            .unwrap();
        let mut frames = handle.take_frames();
        let session = handle.session().clone();

        let mut local = elem("x", 2, 2, "a1");
        local["angle"] = json!(20);
        handle.push(vec![local], None, None).unwrap();
        while frames.try_recv().is_ok() {}

        let mut disk = elem("x", 2, 3, "a1");
        disk["angle"] = json!(30);
        let disk_text = scene_body(json!([disk]));
        workspace.write_text("b.excalidraw", &disk_text).unwrap();
        let stat = workspace.stat("b.excalidraw").unwrap();
        session.test_force_conflict(disk_text.clone(), &stat);
        let authority = session.authority_view().0;
        let conflict_token = stat.mtime_ns.expect("conflicting disk token");

        let resp = api_write_file(
            State(state.clone()),
            AxumPath("b.excalidraw".into()),
            Json(WriteBody {
                content: authority.clone(),
                expected_mtime: None,
                expected_mtime_ns: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::CONFLICT);
        let body = body_json(resp).await;
        assert_eq!(body["current_mtime_ns"], conflict_token.to_string());
        assert_eq!(session.authority_view().0, authority);
        assert_eq!(workspace.read_text("b.excalidraw").unwrap(), disk_text);
        assert!(frames.try_recv().is_err(), "conflicted PUT must not fan");
    }

    #[tokio::test]
    async fn conflict_resolution_route_reloads_and_overwrites_scene_authority() {
        let (_cfg, _root, state) = divert_app();
        let workspace = state.try_workspace().unwrap();
        let mut baseline = elem("x", 1, 1, "a1");
        baseline["angle"] = json!(0);
        workspace
            .write_text("resolve.excalidraw", &scene_body(json!([baseline])))
            .unwrap();
        let handle = state
            .scene_sessions
            .attach(&workspace, "resolve.excalidraw", "win-1")
            .await
            .unwrap();
        let session = handle.session().clone();

        let mut local = elem("x", 2, 2, "a1");
        local["angle"] = json!(20);
        handle.push(vec![local], None, None).unwrap();
        let mut disk = elem("x", 2, 3, "a1");
        disk["angle"] = json!(30);
        let disk_text = scene_body(json!([disk]));
        workspace
            .write_text("resolve.excalidraw", &disk_text)
            .unwrap();
        let stat = workspace.stat("resolve.excalidraw").unwrap();
        session.test_force_conflict(disk_text, &stat);

        let response = crate::router(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/session-conflicts/resolve")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"path":"resolve.excalidraw","action":"reload"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        let reloaded: Value = serde_json::from_str(body["content"].as_str().unwrap()).unwrap();
        assert_eq!(reloaded["elements"][0]["angle"], 30);
        assert_eq!(body["disk_conflicted"], false);

        let mut authority = elem("x", 4, 4, "a1");
        authority["angle"] = json!(40);
        handle.push(vec![authority], None, None).unwrap();
        let mut disk = elem("x", 4, 5, "a1");
        disk["angle"] = json!(50);
        let disk_text = scene_body(json!([disk]));
        workspace
            .write_text("resolve.excalidraw", &disk_text)
            .unwrap();
        let stat = workspace.stat("resolve.excalidraw").unwrap();
        session.test_force_conflict(disk_text, &stat);

        let response = crate::router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/session-conflicts/resolve")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"path":"resolve.excalidraw","action":"overwrite"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        let resolved: Value = serde_json::from_str(body["content"].as_str().unwrap()).unwrap();
        assert_eq!(resolved["elements"][0]["angle"], 40);
        let persisted: Value =
            serde_json::from_str(&workspace.read_text("resolve.excalidraw").unwrap()).unwrap();
        assert_eq!(persisted["elements"][0]["angle"], 40);
    }

    #[tokio::test]
    async fn put_on_a_removed_state_session_falls_through_to_classic() {
        let (_cfg, root, state) = divert_app();
        let workspace = state.try_workspace().unwrap();
        workspace
            .write_text("b.excalidraw", &scene_body(json!([elem("x", 1, 1, "a1")])))
            .unwrap();
        let mut handle = state
            .scene_sessions
            .attach(&workspace, "b.excalidraw", "win-1")
            .await
            .unwrap();
        let mut frames = handle.take_frames();
        let session = handle.session().clone();

        std::fs::remove_file(root.path().join("b.excalidraw")).unwrap();
        state
            .scene_sessions
            .reconcile_event(
                &workspace,
                WatchEvent::file(
                    WatchKind::Removed,
                    "b.excalidraw",
                    chan_workspace::WorkspaceGeneration::default(),
                ),
            )
            .await;
        // Absence corroborates across two observations.
        session.test_backdate_pending_removal();
        state.scene_sessions.reconcile_pending(&workspace).await;
        assert_eq!(session.token(), None, "removed state");
        while frames.try_recv().is_ok() {}

        // A PUT there is an explicit re-create intent: the classic
        // disk path recreates the file (the reconciler then folds it
        // back into the session).
        let resp = api_write_file(
            State(state.clone()),
            AxumPath("b.excalidraw".into()),
            Json(WriteBody {
                content: scene_body(json!([elem("z", 1, 1, "a1")])),
                expected_mtime: None,
                expected_mtime_ns: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(
            root.path().join("b.excalidraw").exists(),
            "classic path recreated the file"
        );
    }
}
