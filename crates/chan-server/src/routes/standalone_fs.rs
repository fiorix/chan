//! Standalone Files routes over the `/`-rooted `MiniWorkspace`.
//!
//! Siblings of the workspace handlers in `routes/files.rs`, never the same
//! functions: those divert through live doc/scene sessions, rewrite links,
//! classify contacts, and note `SelfWrites`, all of which either do not
//! exist or are wrong on the shared standalone tenant. What IS shared is
//! the wire: the list/read/write/move/transfer shapes come from `files.rs`
//! so the SPA cannot tell the tenants apart, and the same active-content
//! and bulk-lane defenses apply.
//!
//! Every handler snapshots `state.standalone_files` and answers 404 on a
//! tenant that did not construct the bundle, so mounting these routes on
//! every slim tenant is safe. Two entry points are NOT mounted here
//! because axum panics on a duplicate method+path: the bare GET read is
//! dispatched from `transfer::api_terminal_read_file` and the Files upload
//! from `transfer::api_terminal_upload_file`.
//!
//! Mutations carry an optional `?w=<window-id>`. With it, the disk work is
//! wrapped in the `StandaloneMutationBus` begin/commit/cancel transaction
//! so every subscribed Files window receives a deterministic attributed
//! `fs` frame and the raw OS echo is suppressed; without it the bus is
//! skipped entirely and shell-equivalent callers surface through the
//! watcher as external changes.

use std::convert::Infallible;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{multipart::Field, Multipart, Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::{stream, StreamExt as _};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use chan_workspace::{
    AtomicWriteKind, FileStat, MiniWorkspace, TextReadEvent, WatchEvent, WatchKind,
    WorkspaceGeneration,
};

use crate::bulk_transfer::{BulkCancel, BulkOutcome};
use crate::error::{err, err_from};
use crate::self_writes::{check_write_preconditions, WritePreconditionError, WritePreconditions};
use crate::signal::now_unix_secs;
use crate::standalone_mutations::MutationTicket;
use crate::state::{AppState, StandaloneFilesState};
use crate::util::{slugify_for_filename, split_filename};

use super::files::{
    accumulate_text_body, basename, consume_request_body, join_rel, ndjson_bytes,
    ndjson_error_bytes, normalize_dir_query, parent_dir, parse_optional_mtime_ns, project_kind,
    read_multipart_text_field, resolve_range, stream_binary_plan, upload_leaf_filename,
    write_precondition_response, BinaryPlan, CreateBody, FileResponse, FileStreamEvent,
    FileStreamMessage, ListFilesQuery, MoveBody, MoveResponse, RangeOutcome, RequestBodyMessage,
    TransferBody, TransferItem, TransferOp, TransferResponse, TreeEntryView, UploadDestination,
    UploadFileResponse, WriteResponse,
};
use super::transfer::TransferTracking;

/// Snapshot the tenant's Files bundle. A `None` answers with
/// [`files_not_served`]: the route exists (mounting is unconditional so
/// the router assembles once), but the application is not served here.
fn standalone_state(state: &AppState) -> Option<Arc<StandaloneFilesState>> {
    state.standalone_files.clone()
}

/// The slim tenant's absent-feature posture, shared by every Files route.
fn files_not_served() -> Response {
    err(
        StatusCode::NOT_FOUND,
        "files application not served on this tenant".into(),
    )
}

/// Standalone error mapping: the two refusals the File Browser acts on
/// structurally carry a machine-readable body; everything else keeps the
/// crate-wide mapping.
fn standalone_err(e: &chan_workspace::ChanError) -> Response {
    match e {
        chan_workspace::ChanError::DirectoryNotEmpty(path) => {
            structured_conflict("directory_not_empty", path)
        }
        chan_workspace::ChanError::ProtectedPath(path) => {
            structured_conflict("protected_path", path)
        }
        _ => err_from(e),
    }
}

fn structured_conflict(error: &'static str, path: &str) -> Response {
    (
        StatusCode::CONFLICT,
        Json(serde_json::json!({ "error": error, "path": path })),
    )
        .into_response()
}

/// Open a mutation ticket when the caller identified its window. An absent
/// `w` skips the bus entirely: shell-equivalent callers get plain watcher
/// echoes delivered as external changes.
fn begin_mutation(
    files: &StandaloneFilesState,
    w: Option<&str>,
    expected_paths: &[String],
) -> Option<MutationTicket> {
    let w = w.map(str::trim).filter(|w| !w.is_empty())?;
    Some(files.mutations.begin(w, expected_paths))
}

fn commit_mutation(
    files: &StandaloneFilesState,
    ticket: Option<MutationTicket>,
    changes: Vec<WatchEvent>,
) {
    if let Some(ticket) = ticket {
        files.mutations.commit(ticket, changes);
    }
}

fn cancel_mutation(files: &StandaloneFilesState, ticket: Option<MutationTicket>) {
    if let Some(ticket) = ticket {
        files.mutations.cancel(ticket);
    }
}

fn generation() -> WorkspaceGeneration {
    // Synthetic frames have no generated-workspace scope behind them; the
    // default generation is the constructors' documented value for that.
    WorkspaceGeneration::default()
}

fn standalone_path_class(fs: &MiniWorkspace, rel: &str) -> Option<chan_workspace::PathClass> {
    match fs.classify(rel) {
        Ok(class) => Some(class),
        Err(e) => {
            tracing::warn!(%rel, ?e, "path classification failed");
            None
        }
    }
}

/// The optional writer identity every mutating Files route accepts.
#[derive(Default, Deserialize)]
pub struct StandaloneMutationQuery {
    #[serde(default)]
    w: Option<String>,
}

#[derive(Serialize)]
struct FsContextResponse {
    protocol: u32,
    root: String,
    home: String,
    path_style: &'static str,
}

/// `GET /api/fs/context`: the Files frontend's bootstrap facts. `root` is
/// the capability root as opened (`/` in production) and `home` the
/// wire-relative canonical start directory every fresh window opens at.
pub async fn api_standalone_fs_context(State(state): State<Arc<AppState>>) -> Response {
    let Some(files) = standalone_state(&state) else {
        return files_not_served();
    };
    Json(FsContextResponse {
        protocol: 1,
        root: files.fs.root().display().to_string(),
        home: files.fs.start_rel().to_string(),
        path_style: "posix",
    })
    .into_response()
}

/// `GET /api/fs?dir=<wire>`: one-level listing. A missing `dir` is a
/// client error because the root is the whole machine: the workspace
/// route's legacy recursive fallback must never walk `/`.
pub async fn api_standalone_list_files(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListFilesQuery>,
) -> Response {
    let Some(files) = standalone_state(&state) else {
        return files_not_served();
    };
    let Some(dir) = query.dir else {
        return err(
            StatusCode::BAD_REQUEST,
            "file listing requires ?dir=<directory>".into(),
        );
    };
    let fs = files.fs.clone();
    let result = tokio::task::spawn_blocking(move || standalone_list_sync(&fs, &dir)).await;
    match result {
        Ok(Ok(out)) => Json(out).into_response(),
        Ok(Err(e)) => standalone_err(&e),
        Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    }
}

fn standalone_list_sync(
    fs: &MiniWorkspace,
    dir: &str,
) -> chan_workspace::Result<Vec<TreeEntryView>> {
    let rel = normalize_dir_query(dir)?;
    let children = fs.list(&rel)?;
    let mut out = Vec::with_capacity(children.len());
    for child in children {
        let path = join_rel(&rel, &child.name);
        let stat = match fs.stat(&path) {
            Ok(stat) => stat,
            Err(e) => {
                tracing::warn!(%path, ?e, "standalone list: stat failed; skipping");
                continue;
            }
        };
        // No workspace behind this root, so no contact rows exist; the
        // path-only "pending" kind resolves with a bounded content sniff
        // because every standalone listing is per-directory.
        let mut kind = project_kind(&path, stat.is_dir, false);
        if kind == Some("pending") {
            kind = Some(if fs.sniff_is_text(&path) {
                "text"
            } else {
                "binary"
            });
        }
        out.push(TreeEntryView {
            kind,
            path_class: standalone_path_class(fs, &path),
            is_dir: stat.is_dir,
            mtime: stat.mtime,
            size: if stat.is_dir { 0 } else { stat.size },
            path,
        });
    }
    Ok(out)
}

/// `POST /api/fs?w=<id>`: create a file or directory that must not
/// exist yet. 201 on success with an empty body, like the workspace route.
pub async fn api_standalone_create_file(
    State(state): State<Arc<AppState>>,
    Query(query): Query<StandaloneMutationQuery>,
    Json(body): Json<CreateBody>,
) -> Response {
    let Some(files) = standalone_state(&state) else {
        return files_not_served();
    };
    let ticket = begin_mutation(&files, query.w.as_deref(), std::slice::from_ref(&body.path));
    let fs = files.fs.clone();
    let path = body.path.clone();
    let is_dir = body.is_dir;
    let content = body.content.unwrap_or_default();
    let result = tokio::task::spawn_blocking(move || {
        if is_dir {
            fs.create_dir(&path)
        } else {
            fs.create_file(&path, &content)
        }
    })
    .await;
    match result {
        Ok(Ok(())) => {
            commit_mutation(
                &files,
                ticket,
                vec![WatchEvent::file(
                    WatchKind::Created,
                    &body.path,
                    generation(),
                )],
            );
            StatusCode::CREATED.into_response()
        }
        Ok(Err(e)) => {
            cancel_mutation(&files, ticket);
            standalone_err(&e)
        }
        Err(join) => {
            cancel_mutation(&files, ticket);
            err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string())
        }
    }
}

/// `DELETE /api/fs/{*path}?w=<id>`: permanently remove a regular file
/// or an empty directory. The structured 409 bodies are the contract that
/// keeps the UI from offering a force or recursive retry.
pub async fn api_standalone_delete_file(
    State(state): State<Arc<AppState>>,
    AxumPath(path): AxumPath<String>,
    Query(query): Query<StandaloneMutationQuery>,
) -> Response {
    let Some(files) = standalone_state(&state) else {
        return files_not_served();
    };
    let ticket = begin_mutation(&files, query.w.as_deref(), std::slice::from_ref(&path));
    let fs = files.fs.clone();
    let remove_path = path.clone();
    let result = tokio::task::spawn_blocking(move || fs.remove_safe(&remove_path)).await;
    match result {
        Ok(Ok(())) => {
            commit_mutation(
                &files,
                ticket,
                vec![WatchEvent::file(WatchKind::Removed, &path, generation())],
            );
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(Err(e)) => {
            cancel_mutation(&files, ticket);
            standalone_err(&e)
        }
        Err(join) => {
            cancel_mutation(&files, ticket);
            err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string())
        }
    }
}

/// What a standalone buffered read resolves to. A sibling of the
/// workspace's read result rather than a reuse: that one is welded to the
/// doc/scene divert plumbing this tenant must never touch.
enum StandaloneReadResult {
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

fn standalone_read_sync(
    fs: &MiniWorkspace,
    path: &str,
) -> chan_workspace::Result<StandaloneReadResult> {
    // Image and PDF paths feed `<img>` / `<embed>` tags pointing at this
    // route, so they come back as raw bytes regardless of content; an SVG
    // is XML text and would otherwise pass the editable sniff and ship as
    // the editor's JSON envelope.
    match chan_workspace::fs_ops::classify(path) {
        chan_workspace::fs_ops::FileClass::Image | chan_workspace::fs_ops::FileClass::Pdf => {
            return Ok(StandaloneReadResult::Binary);
        }
        chan_workspace::fs_ops::FileClass::Other if !fs.sniff_is_text(path) => {
            return Ok(StandaloneReadResult::Binary);
        }
        _ => {}
    }
    let stat = fs.stat(path)?;
    if stat.size > chan_workspace::TEXT_WRITE_LIMIT {
        return Ok(StandaloneReadResult::TooLarge {
            size: stat.size,
            limit: chan_workspace::TEXT_WRITE_LIMIT,
        });
    }
    match fs.read_text_with_stat(path) {
        Ok((content, stat)) => Ok(StandaloneReadResult::Text {
            content,
            mtime: stat.mtime,
            mtime_ns: stat.mtime_ns,
            writable: fs.ensure_writable(path).is_ok(),
            path_class: standalone_path_class(fs, path),
        }),
        Err(chan_workspace::ChanError::NotEditableText(_)) => Ok(StandaloneReadResult::Binary),
        Err(e) => Err(e),
    }
}

fn standalone_binary_plan_sync(
    fs: &MiniWorkspace,
    path: &str,
    range_header: Option<&str>,
) -> chan_workspace::Result<BinaryPlan> {
    let stat = fs.stat(path)?;
    // A directory reaches the whole-file open so it fails with the
    // canonical not-a-regular-file error instead of resolving a range
    // against a directory size.
    let outcome = if stat.is_dir {
        RangeOutcome::Full
    } else {
        resolve_range(range_header, stat.size)
    };
    match outcome {
        RangeOutcome::Full => fs.read_bytes_bounded(path).map(BinaryPlan::Full),
        RangeOutcome::Slice { start, len } => {
            fs.read_bytes_bounded_slice(path, start, len).map(|reader| {
                // The handle's own window is authoritative; a file truncated
                // between stat and open can empty it, and an empty 206 is a
                // lie.
                if reader.slice().1 == 0 {
                    BinaryPlan::Unsatisfiable(reader.stat().clone())
                } else {
                    BinaryPlan::Partial(reader)
                }
            })
        }
        RangeOutcome::Unsatisfiable => Ok(BinaryPlan::Unsatisfiable(stat)),
    }
}

/// The bare-GET read the transfer route dispatches to when this tenant
/// serves Files. Mirrors the workspace `api_read_file` minus the doc and
/// scene session diverts: editable text answers `FileResponse` JSON,
/// `?stream=1` answers NDJSON frames, and everything else streams raw
/// bytes with the active-content protections.
pub(crate) async fn standalone_read_file(
    files: Arc<StandaloneFilesState>,
    path: String,
    stream: bool,
    headers: &HeaderMap,
) -> Response {
    let range_header = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if stream {
        return standalone_stream_read_response(files.fs.clone(), path).await;
    }
    let fs = files.fs.clone();
    let read_path = path.clone();
    let result = tokio::task::spawn_blocking(move || standalone_read_sync(&fs, &read_path)).await;
    match result {
        Ok(Ok(StandaloneReadResult::Text {
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
        Ok(Ok(StandaloneReadResult::Binary)) => {
            let fs = files.fs.clone();
            let plan_path = path.clone();
            let plan = tokio::task::spawn_blocking(move || {
                standalone_binary_plan_sync(&fs, &plan_path, range_header.as_deref())
            })
            .await;
            match plan {
                Ok(Ok(plan)) => stream_binary_plan(&path, plan, false, None),
                Ok(Err(e)) => standalone_err(&e),
                Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
            }
        }
        Ok(Ok(StandaloneReadResult::TooLarge { size, limit })) => err(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "file is {size} bytes; buffered editor reads are limited to {limit} bytes; use ?stream=1"
            ),
        ),
        Ok(Err(e)) => standalone_err(&e),
        Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    }
}

fn standalone_stream_read_sync<F>(
    fs: &MiniWorkspace,
    path: &str,
    mut emit: F,
) -> chan_workspace::Result<()>
where
    F: FnMut(Bytes) -> bool,
{
    let mut encode_error = None;
    let result =
        fs.read_text_with_stat_chunked(path, chan_workspace::TEXT_READ_CHUNK_SIZE, |event| {
            let event = match event {
                TextReadEvent::Meta(stat) => FileStreamEvent::Meta {
                    path,
                    size: stat.size,
                    mtime: stat.mtime,
                    mtime_ns: stat.mtime_ns.map(|ns| ns.to_string()),
                    authority_version: None,
                    disk_conflicted: false,
                    path_class: standalone_path_class(fs, path),
                    writable: fs.ensure_writable(path).is_ok(),
                    max_editable_bytes: chan_workspace::TEXT_WRITE_LIMIT,
                },
                TextReadEvent::Chunk(content) => FileStreamEvent::Chunk {
                    content,
                    bytes: content.len(),
                },
                TextReadEvent::Done => FileStreamEvent::Done,
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
        });
    result?;
    if let Some(e) = encode_error {
        Err(e)
    } else {
        Ok(())
    }
}

async fn standalone_stream_read_response(fs: Arc<MiniWorkspace>, path: String) -> Response {
    let (tx, mut rx) = mpsc::channel::<FileStreamMessage>(8);
    let read_path = path.clone();
    tokio::task::spawn_blocking(move || {
        let result = standalone_stream_read_sync(&fs, &read_path, |bytes| {
            tx.blocking_send(FileStreamMessage::Data(bytes)).is_ok()
        });
        if let Err(e) = result {
            let _ = tx.blocking_send(FileStreamMessage::Error(e));
        }
    });

    // A failure before the first frame becomes a plain HTTP error; a later
    // failure rides the stream as an `error` frame so a truncated logical
    // file can never look complete.
    let first = match rx.recv().await {
        Some(FileStreamMessage::Data(bytes)) => bytes,
        Some(FileStreamMessage::Error(e)) => return standalone_err(&e),
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

/// CAS tokens for the standalone raw-body PUT. Same query-string wire as
/// the workspace route; there is no authority layer here, so an
/// `authority_version` param is simply ignored by deserialization.
#[derive(Default, Deserialize)]
pub struct StandaloneWriteQuery {
    #[serde(default)]
    w: Option<String>,
    #[serde(default)]
    expected_mtime: Option<i64>,
    #[serde(default)]
    expected_mtime_ns: Option<String>,
}

/// `PUT /api/fs/{*path}?w=<id>`: raw streamed UTF-8 text write with the
/// workspace route's CAS precedence (exact nanoseconds, else legacy
/// seconds, else unconditional).
pub async fn api_standalone_write_file(
    State(state): State<Arc<AppState>>,
    AxumPath(path): AxumPath<String>,
    Query(query): Query<StandaloneWriteQuery>,
    body: Body,
) -> Response {
    let Some(files) = standalone_state(&state) else {
        return files_not_served();
    };
    let expected_mtime_ns = match parse_optional_mtime_ns(query.expected_mtime_ns.as_deref()) {
        Ok(mtime_ns) => mtime_ns,
        Err(message) => return err(StatusCode::BAD_REQUEST, message),
    };
    let preconditions = WritePreconditions {
        expected_mtime: query.expected_mtime,
        expected_mtime_ns,
        authority_version: None,
    };
    // The accumulation ceiling matches the atomic sink's semantic budget:
    // an existing file larger than the editor limit stays shrinkable.
    let budget_fs = files.fs.clone();
    let budget_path = path.clone();
    let existing_size = match tokio::task::spawn_blocking(move || {
        budget_fs
            .stat(&budget_path)
            .ok()
            .filter(|stat| !stat.is_dir)
            .map(|stat| stat.size)
    })
    .await
    {
        Ok(size) => size,
        Err(join) => return err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    };
    let content = match accumulate_text_body(
        body,
        chan_workspace::semantic_write_budget(existing_size),
    )
    .await
    {
        Ok(content) => content,
        Err(error) => return err_from(&error),
    };
    let ticket = begin_mutation(&files, query.w.as_deref(), std::slice::from_ref(&path));
    let fs = files.fs.clone();
    let write_path = path.clone();
    let result = tokio::task::spawn_blocking(move || {
        standalone_write_sync(&fs, &write_path, preconditions, &content)
    })
    .await;
    let stat = match result {
        Ok(Ok(stat)) => stat,
        Ok(Err(chan_workspace::ChanError::WriteConflict { current_mtime_ns })) => {
            cancel_mutation(&files, ticket);
            return write_precondition_response(
                StatusCode::CONFLICT,
                current_mtime_ns,
                None,
                false,
            );
        }
        Ok(Err(error)) => {
            cancel_mutation(&files, ticket);
            return standalone_err(&error);
        }
        Err(join) => {
            cancel_mutation(&files, ticket);
            return err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string());
        }
    };
    commit_mutation(
        &files,
        ticket,
        vec![WatchEvent::file(WatchKind::Modified, &path, generation())],
    );
    Json(WriteResponse {
        mtime: stat.mtime,
        mtime_ns: stat.mtime_ns.map(|ns| ns.to_string()),
        authority_version: None,
        disk_conflicted: false,
    })
    .into_response()
}

fn standalone_write_sync(
    fs: &MiniWorkspace,
    path: &str,
    preconditions: WritePreconditions,
    content: &str,
) -> chan_workspace::Result<FileStat> {
    let writable = fs.ensure_writable(path)?;
    let current_mtime_ns = writable.stat.as_ref().and_then(|stat| stat.mtime_ns);
    let has_token =
        preconditions.expected_mtime.is_some() || preconditions.expected_mtime_ns.is_some();
    // With a token in play, capture the current text: byte-equal content
    // passes the CAS (equal bytes cannot lose an update), and the captured
    // observation is what the write below re-verifies.
    let current_disk = if has_token && writable.stat.is_some() {
        fs.read_text_with_stat(path).ok().map(|(text, _)| text)
    } else {
        None
    };
    let content_equal = current_disk.as_deref() == Some(content);
    match check_write_preconditions(current_mtime_ns, None, content_equal, preconditions) {
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
    if has_token {
        // The tokened write goes back through the CAS primitive against
        // the observation just checked, so an external write landing in
        // the gap conflicts instead of being silently overwritten.
        fs.write_text_if_unchanged(path, current_mtime_ns, current_disk.as_deref(), content)?;
    } else {
        fs.write_text(path, content)?;
    }
    fs.stat(path)
}

/// The Files-app branch of `POST /api/fs/upload`, dispatched from the
/// transfer route on `?app=files`. Speaks the File Browser contract: a
/// `dir` (create; collisions refuse) or `path` (replace an existing
/// regular file) part must precede the streaming `file` part, and the
/// write is admitted to the process-wide bulk lane.
pub(crate) async fn standalone_upload_file(
    state: Arc<AppState>,
    w: Option<String>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Response {
    let Some(files) = standalone_state(&state) else {
        return files_not_served();
    };
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
                        return stream_standalone_upload(
                            &state,
                            files,
                            w,
                            UploadDestination {
                                dir,
                                replace_path,
                                filename,
                            },
                            &headers,
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

/// Admit one Files upload and write it inside a single lane job, exactly
/// like the terminal and workspace lanes: the job is the writer, admitted
/// before the first body byte is pulled, and an early return drops the job
/// which cancels it and releases its slot.
async fn stream_standalone_upload(
    state: &Arc<AppState>,
    files: Arc<StandaloneFilesState>,
    w: Option<String>,
    destination: UploadDestination,
    headers: &HeaderMap,
    mut field: Field<'_>,
) -> Response {
    let (tx, mut rx) = mpsc::channel(8);
    let job_files = files.clone();
    let job = match state.bulk_transfer.submit(move |cancel| {
        standalone_upload_stream_sync(&job_files, w.as_deref(), &destination, &mut rx, cancel)
    }) {
        Ok(job) => job,
        Err(full) => return full.into_response(),
    };
    let (_alive_tx, alive_rx) = tokio::sync::oneshot::channel::<Infallible>();
    if let Some(tracking) = TransferTracking::from_headers(headers) {
        crate::routes::ws::spawn_transfer_queue_reporter(
            state.events_tx.clone(),
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
        BulkOutcome::Done(Ok(upload)) => Json(upload).into_response(),
        BulkOutcome::Done(Err(error)) => standalone_err(&error),
        // Cancellation, lane shutdown, and a panicked job are reported
        // identically; all three mean nothing was persisted.
        BulkOutcome::Cancelled => err(
            StatusCode::SERVICE_UNAVAILABLE,
            "upload did not complete".into(),
        ),
    }
}

fn standalone_upload_stream_sync(
    files: &StandaloneFilesState,
    w: Option<&str>,
    destination: &UploadDestination,
    rx: &mut mpsc::Receiver<RequestBodyMessage>,
    cancel: &BulkCancel,
) -> chan_workspace::Result<UploadFileResponse> {
    let fs = &files.fs;
    let rel = standalone_upload_target(
        fs,
        &destination.dir,
        destination.replace_path.as_deref(),
        &destination.filename,
    )?;
    // The ticket opens after the read-only target resolution and before
    // the write syscalls, so it names the real destination and the watcher
    // cannot observe an untracked echo.
    let ticket = begin_mutation(files, w, std::slice::from_ref(&rel));
    let result = fs.write_atomic_stream(&rel, AtomicWriteKind::Bytes, |sink| {
        consume_request_body(rx, |chunk| {
            // Checked per chunk so an abandoned upload returns its
            // admission slot within one chunk's work; the atomic writer
            // discards its temp file on this error.
            if cancel.is_cancelled() {
                return Err(chan_workspace::ChanError::Io(
                    "upload cancelled before it completed".into(),
                ));
            }
            sink.write_chunk(chunk)
        })
    });
    match result {
        Ok(stat) => {
            commit_mutation(
                files,
                ticket,
                vec![WatchEvent::file(WatchKind::Created, &rel, generation())],
            );
            Ok(UploadFileResponse {
                path: rel,
                size: stat.size,
            })
        }
        Err(error) => {
            cancel_mutation(files, ticket);
            Err(error)
        }
    }
}

fn standalone_upload_target(
    fs: &MiniWorkspace,
    dir: &str,
    replace_path: Option<&str>,
    original_name: &str,
) -> chan_workspace::Result<String> {
    if let Some(path) = replace_path {
        let trimmed = path.trim_matches('/');
        chan_workspace::fs_ops::validate_rel(trimmed)?;
        let stat = fs.stat(trimmed)?;
        if stat.is_dir {
            return Err(chan_workspace::ChanError::Io(format!(
                "not a file: {trimmed}"
            )));
        }
        return Ok(trimmed.to_string());
    }

    let dir = normalize_dir_query(dir)?;
    if !dir.is_empty() {
        let stat = fs.stat(&dir)?;
        if !stat.is_dir {
            return Err(chan_workspace::ChanError::Io(format!(
                "not a directory: {dir}"
            )));
        }
    }
    let filename = upload_leaf_filename(original_name)?;
    let rel = join_rel(&dir, &filename);
    if fs.stat(&rel).is_ok() {
        return Err(chan_workspace::ChanError::PathAlreadyExists(rel));
    }
    Ok(rel)
}

/// `POST /api/attachments?w=<id>`: the editor's paste/upload lane. The
/// Files frontend always sends `dir` (the edited file's parent; empty
/// string for `/`); the workspace `attachments_dir` fallback is dropped
/// because interpreting that setting relative to `/` would land uploads on
/// an unrelated machine path.
pub async fn api_standalone_post_attachment(
    State(state): State<Arc<AppState>>,
    Query(query): Query<StandaloneMutationQuery>,
    mut multipart: Multipart,
) -> Response {
    let Some(files) = standalone_state(&state) else {
        return files_not_served();
    };
    let mut chosen: Option<(String, Vec<u8>)> = None;
    let mut dir_override: Option<String> = None;
    loop {
        match multipart.next_field().await {
            Ok(Some(field)) => {
                let name = field.name().unwrap_or("").to_owned();
                match name.as_str() {
                    "file" if chosen.is_none() => {
                        let filename = field.file_name().unwrap_or("").to_owned();
                        let bytes = match field.bytes().await {
                            Ok(b) => b.to_vec(),
                            Err(e) => {
                                return err(
                                    StatusCode::BAD_REQUEST,
                                    format!("multipart read: {e}"),
                                );
                            }
                        };
                        chosen = Some((filename, bytes));
                    }
                    "dir" => match field.text().await {
                        Ok(s) => dir_override = Some(s),
                        Err(e) => {
                            return err(StatusCode::BAD_REQUEST, format!("multipart read: {e}"));
                        }
                    },
                    _ => {}
                }
            }
            Ok(None) => break,
            Err(e) => {
                return err(StatusCode::BAD_REQUEST, format!("multipart parse: {e}"));
            }
        }
    }

    let Some((original, bytes)) = chosen else {
        return err(
            StatusCode::BAD_REQUEST,
            "missing `file` part in multipart body".into(),
        );
    };
    if bytes.is_empty() {
        return err(StatusCode::BAD_REQUEST, "empty file".into());
    }
    let Some(dir) = dir_override else {
        return err(
            StatusCode::BAD_REQUEST,
            "missing `dir` field in multipart body".into(),
        );
    };
    let dir = match normalize_dir_query(&dir) {
        Ok(dir) => dir,
        Err(e) => return err_from(&e),
    };

    let (stem, ext) = split_filename(&original);
    let stem_slug = slugify_for_filename(stem);
    let stem_or_default = if stem_slug.is_empty() {
        "file".to_string()
    } else {
        stem_slug
    };
    let ext = ext.map(|e| e.to_ascii_lowercase()).unwrap_or_default();

    let w = query.w;
    let task_files = files.clone();
    let result = tokio::task::spawn_blocking(move || {
        let fs = &task_files.fs;
        let build_name = |suffix: Option<u32>| -> String {
            let base = match suffix {
                None => stem_or_default.clone(),
                Some(n) => format!("{stem_or_default}-{n}"),
            };
            if ext.is_empty() {
                base
            } else {
                format!("{base}.{ext}")
            }
        };
        let mut rel = join_rel(&dir, &build_name(None));
        let mut attempt: u32 = 1;
        // Hard cap on retries; past a thousand taken suffixes, bail to a
        // unique timestamp fallback rather than spinning forever.
        while fs.stat(&rel).is_ok() {
            if attempt > 1000 {
                let ts = now_unix_secs();
                rel = join_rel(&dir, &{
                    let base = format!("{stem_or_default}-{ts}");
                    if ext.is_empty() {
                        base
                    } else {
                        format!("{base}.{ext}")
                    }
                });
                break;
            }
            rel = join_rel(&dir, &build_name(Some(attempt)));
            attempt += 1;
        }

        // Begin after the read-only collision probes and before the write,
        // with the final resolved name.
        let ticket = begin_mutation(&task_files, w.as_deref(), std::slice::from_ref(&rel));
        let outcome = fs.write_atomic_stream(&rel, AtomicWriteKind::Bytes, |sink| {
            sink.write_chunk(&bytes)
        });
        match outcome {
            Ok(_) => {
                commit_mutation(
                    &task_files,
                    ticket,
                    vec![WatchEvent::file(WatchKind::Created, &rel, generation())],
                );
                Ok(rel)
            }
            Err(e) => {
                cancel_mutation(&task_files, ticket);
                Err(e)
            }
        }
    })
    .await;
    match result {
        Ok(Ok(rel)) => Json(serde_json::json!({ "path": rel })).into_response(),
        Ok(Err(e)) => standalone_err(&e),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("attachment write task panicked: {e}"),
        )
            .into_response(),
    }
}

/// `POST /api/move?w=<id>`: one plain no-clobber move. The response keeps
/// the workspace shape with empty `rewritten`/`conflicts`: there is no
/// link graph behind this root to rewrite.
pub async fn api_standalone_move(
    State(state): State<Arc<AppState>>,
    Query(query): Query<StandaloneMutationQuery>,
    Json(body): Json<MoveBody>,
) -> Response {
    let Some(files) = standalone_state(&state) else {
        return files_not_served();
    };
    let ticket = begin_mutation(
        &files,
        query.w.as_deref(),
        &[body.from.clone(), body.to.clone()],
    );
    let fs = files.fs.clone();
    let from = body.from.clone();
    let to = body.to.clone();
    let result = tokio::task::spawn_blocking(move || fs.move_plain(&from, &to)).await;
    match result {
        Ok(Ok(())) => {
            commit_mutation(
                &files,
                ticket,
                vec![WatchEvent::rename(
                    Some(body.from.clone()),
                    Some(body.to.clone()),
                    false,
                    None,
                    generation(),
                )],
            );
            Json(MoveResponse {
                renamed: vec![(body.from, body.to)],
                rewritten: vec![],
                conflicts: vec![],
            })
            .into_response()
        }
        Ok(Err(e)) => {
            cancel_mutation(&files, ticket);
            standalone_err(&e)
        }
        Err(join) => {
            cancel_mutation(&files, ticket);
            err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string())
        }
    }
}

/// `POST /api/fs/transfer?w=<id>`: the File Browser's batch move/copy.
/// Copies move bytes and ride the bulk lane; moves are metadata-sized and
/// stay on a plain blocking task so a drag never queues behind a
/// multi-gigabyte download.
pub async fn api_standalone_fs_transfer(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<StandaloneMutationQuery>,
    Json(body): Json<TransferBody>,
) -> Response {
    let Some(files) = standalone_state(&state) else {
        return files_not_served();
    };
    let dest_dir = body.dest_dir.trim_end_matches('/').to_string();
    let op = body.op;
    let sources = body.sources.clone();
    let w = query.w.clone();
    let batch_files = files.clone();

    let result = match op {
        TransferOp::Copy => {
            let job = match state.bulk_transfer.submit(move |cancel| {
                standalone_transfer_batch_sync(
                    &batch_files,
                    w.as_deref(),
                    op,
                    &dest_dir,
                    &sources,
                    Some(cancel),
                )
            }) {
                Ok(job) => job,
                Err(full) => return full.into_response(),
            };
            let (_alive_tx, alive_rx) = tokio::sync::oneshot::channel::<Infallible>();
            if let Some(tracking) = TransferTracking::from_headers(&headers) {
                crate::routes::ws::spawn_transfer_queue_reporter(
                    state.events_tx.clone(),
                    tracking.window_id,
                    tracking.transfer_id,
                    job.tracker(),
                    alive_rx,
                );
            }
            match job.outcome().await {
                BulkOutcome::Done(result) => result,
                BulkOutcome::Cancelled => {
                    return err(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "copy did not complete".into(),
                    )
                }
            }
        }
        TransferOp::Move => {
            match tokio::task::spawn_blocking(move || {
                standalone_transfer_batch_sync(
                    &batch_files,
                    w.as_deref(),
                    op,
                    &dest_dir,
                    &sources,
                    None,
                )
            })
            .await
            {
                Ok(result) => result,
                Err(join) => return err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
            }
        }
    };

    match result {
        Ok(resp) => Json(resp).into_response(),
        Err(e) => standalone_err(&e),
    }
}

/// Run one copy or move batch synchronously. Each entry carries its own
/// mutation ticket so the deterministic frames land per source as it
/// completes; a mid-batch failure cancels only the in-flight ticket and
/// reports the error for the whole request, matching the workspace batch.
fn standalone_transfer_batch_sync(
    files: &StandaloneFilesState,
    w: Option<&str>,
    op: TransferOp,
    dest_dir: &str,
    sources: &[String],
    cancel: Option<&BulkCancel>,
) -> chan_workspace::Result<TransferResponse> {
    let fs = &files.fs;
    let mut resp = TransferResponse::default();
    for src in sources {
        // Checked per source so an abandoned batch returns its admission
        // slot at the next entry rather than at the end of the batch.
        if cancel.is_some_and(|cancel| cancel.is_cancelled()) {
            return Err(chan_workspace::ChanError::Io(
                "transfer cancelled before it completed".into(),
            ));
        }
        let name = basename(src);
        // A move into the source's own current parent is a no-op (and
        // would otherwise resolve a needless " copy" suffix).
        if op == TransferOp::Move && parent_dir(src) == dest_dir {
            resp.skipped.push(src.clone());
            continue;
        }
        // Resolve a non-colliding destination name; both copy and a
        // cut-into-a-collision get a Finder-style " copy" suffix so
        // nothing is ever overwritten.
        let dest = fs.resolve_free_name(dest_dir, name)?;
        let ticket = begin_mutation(files, w, &[src.clone(), dest.clone()]);
        let outcome = match op {
            TransferOp::Move => fs.move_plain(src, &dest),
            TransferOp::Copy => fs.copy_plain(src, &dest),
        };
        match outcome {
            Ok(()) => {
                let change = match op {
                    TransferOp::Move => WatchEvent::rename(
                        Some(src.clone()),
                        Some(dest.clone()),
                        false,
                        None,
                        generation(),
                    ),
                    TransferOp::Copy => {
                        WatchEvent::file(WatchKind::Created, dest.clone(), generation())
                    }
                };
                commit_mutation(files, ticket, vec![change]);
            }
            Err(error) => {
                cancel_mutation(files, ticket);
                return Err(error);
            }
        }
        resp.moved.push(TransferItem {
            from: src.clone(),
            to: dest,
        });
    }
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicU64;
    use std::sync::{Arc, Mutex, RwLock};

    use axum::body::{to_bytes, Body};
    use axum::http::{header, Request, StatusCode};
    use serde_json::{json, Value};
    use tempfile::TempDir;
    use tokio::sync::{broadcast, watch};
    use tower::ServiceExt;

    use crate::bus::ScopeRegistry;
    use crate::self_writes::SelfWrites;
    use crate::standalone_mutations::StandaloneMutationBus;
    use crate::standalone_watch::ScopedWatchManager;
    use crate::state::{AppState, StandaloneFilesState};
    use crate::terminal_sessions::{Registry as TerminalRegistry, RegistryConfig};
    use crate::{EditorPrefs, ServerConfig};

    struct Fixture {
        _cfg: TempDir,
        _root: TempDir,
        root: PathBuf,
        registry: Arc<ScopeRegistry>,
        state: Arc<AppState>,
    }

    /// A slim-tenant `AppState` whose Files bundle is rooted at a temp
    /// directory with `home/user` as the protected start, standing in for
    /// the production `/` + canonical `$HOME`. The scope registry is
    /// shared between the state and the mutation bus exactly like the
    /// production constructor, so attributed frames are observable.
    fn files_fixture() -> Fixture {
        let cfg = TempDir::new().unwrap();
        let root_dir = TempDir::new().unwrap();
        let root = root_dir.path().to_path_buf();
        std::fs::create_dir_all(root.join("home/user")).unwrap();
        let fs = Arc::new(
            chan_workspace::MiniWorkspace::open(&root, &root.join("home/user"), 10 * 1024 * 1024)
                .expect("open mini workspace"),
        );
        let registry = Arc::new(ScopeRegistry::new());
        let mutations = Arc::new(StandaloneMutationBus::new(registry.clone()));
        let watcher = ScopedWatchManager::spawn(
            Arc::new(crate::MiniScopeResolver(fs.clone())),
            registry.clone(),
            mutations.clone(),
        )
        .expect("spawn watch manager");
        let standalone = Arc::new(StandaloneFilesState {
            fs,
            watcher,
            mutations,
        });

        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        let (events_tx, _) = broadcast::channel::<String>(8);
        let (index_events_tx, _) = broadcast::channel::<chan_workspace::WatchEvent>(1);
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        std::mem::forget(shutdown_tx);
        let state = Arc::new(AppState {
            library: lib,
            workspace_root: root.clone(),
            workspace_cell: Arc::new(RwLock::new(None)),
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
                workspace_root: root.clone(),
                mcp_socket_path: None,
                control_socket_path: None,
                terminal: ServerConfig::default().terminal,
            })),
            doc_sessions: Arc::new(crate::doc_sessions::DocRegistry::new()),
            scene_sessions: Arc::new(crate::scene_sessions::SceneRegistry::new()),
            shutdown_rx,
            scope_registry: registry.clone(),
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
            bulk_transfer: crate::state::test_support::make_test_bulk_transfer_tenant(),
            instance_id: "test-instance".to_string(),
            standalone_files: Some(standalone),
        });
        Fixture {
            _cfg: cfg,
            _root: root_dir,
            root,
            registry,
            state,
        }
    }

    fn router(fixture: &Fixture) -> axum::Router {
        crate::terminal_router(fixture.state.clone())
    }

    async fn body_json(response: axum::response::Response) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn get(app: axum::Router, uri: &str) -> axum::response::Response {
        app.oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    fn multipart_request(uri: &str, fields: &[(&str, Option<&str>, &str)]) -> Request<Body> {
        let boundary = "standalone-files-test-boundary";
        let mut body = String::new();
        for (name, filename, value) in fields {
            body.push_str(&format!("--{boundary}\r\n"));
            match filename {
                Some(filename) => body.push_str(&format!(
                    "Content-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\n\r\n"
                )),
                None => {
                    body.push_str(&format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n"))
                }
            }
            body.push_str(value);
            body.push_str("\r\n");
        }
        body.push_str(&format!("--{boundary}--\r\n"));
        Request::builder()
            .method("POST")
            .uri(uri)
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Body::from(body))
            .unwrap()
    }

    #[tokio::test]
    async fn fs_context_serves_the_pinned_wire_shape() {
        let fx = files_fixture();
        let response = get(router(&fx), "/api/fs/context").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await,
            json!({
                "protocol": 1,
                "root": fx.root.display().to_string(),
                "home": "home/user",
                "path_style": "posix",
            })
        );
    }

    #[tokio::test]
    async fn files_routes_answer_not_served_without_standalone_state() {
        let state = crate::state::test_support::make_test_state(false);
        let app = crate::terminal_router(state);
        let response = get(app.clone(), "/api/fs/context").await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body_json(response).await,
            json!({"error": "files application not served on this tenant"})
        );
        let response = get(app, "/api/fs?dir=").await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn listing_requires_dir_and_lists_root_one_level_including_dotfiles() {
        let fx = files_fixture();
        std::fs::write(fx.root.join(".zshrc"), "export A=1").unwrap();
        std::fs::write(fx.root.join("note.md"), "hi").unwrap();
        std::fs::write(fx.root.join("home/user/deep.md"), "deep").unwrap();

        let response = get(router(&fx), "/api/fs").await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(response).await,
            json!({"error": "file listing requires ?dir=<directory>"})
        );

        for uri in ["/api/fs?dir=", "/api/fs?dir=.", "/api/fs?dir=/"] {
            let response = get(router(&fx), uri).await;
            assert_eq!(response.status(), StatusCode::OK, "{uri}");
            let entries = body_json(response).await;
            let entries = entries.as_array().expect("listing array");
            let paths: Vec<&str> = entries
                .iter()
                .map(|e| e["path"].as_str().unwrap())
                .collect();
            assert!(paths.contains(&".zshrc"), "dotfiles list: {paths:?}");
            assert!(paths.contains(&"note.md"));
            assert!(paths.contains(&"home"));
            assert!(
                !paths.iter().any(|p| p.contains("deep.md")),
                "one level only: {paths:?}"
            );
        }

        let response = get(router(&fx), "/api/fs?dir=").await;
        let entries = body_json(response).await;
        let note = entries
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["path"] == "note.md")
            .expect("note.md entry")
            .clone();
        assert_eq!(note["kind"], "document");
        assert_eq!(note["is_dir"], false);
        assert_eq!(note["size"], 2);
        let zshrc = entries
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["path"] == ".zshrc")
            .expect(".zshrc entry")
            .clone();
        // An extensionless dotfile is path-ambiguous; the per-dir sniff
        // resolves it instead of leaving the pending kind on the wire.
        assert_eq!(zshrc["kind"], "text");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn listing_keeps_symlinks_visible_with_their_path_class() {
        let fx = files_fixture();
        std::fs::write(fx.root.join("real.txt"), "content").unwrap();
        std::os::unix::fs::symlink(fx.root.join("real.txt"), fx.root.join("link.txt")).unwrap();
        let response = get(router(&fx), "/api/fs?dir=").await;
        let entries = body_json(response).await;
        let link = entries
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["path"] == "link.txt")
            .expect("symlink entry")
            .clone();
        assert_eq!(link["path_class"]["kind"], "symlink");
    }

    #[tokio::test]
    async fn bare_get_dispatches_to_the_files_read_path() {
        let fx = files_fixture();
        std::fs::write(fx.root.join("note.md"), "hello").unwrap();
        let response = get(router(&fx), "/api/fs/note.md").await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["path"], "note.md");
        assert_eq!(body["content"], "hello");
        assert_eq!(body["disk_conflicted"], false);
        assert_eq!(body["writable"], true);
        assert_eq!(body["max_editable_bytes"], chan_workspace::TEXT_WRITE_LIMIT);
        // The field is present AND null: the SPA distinguishes
        // session-attached reads by a non-null authority_version.
        assert!(body.as_object().unwrap().contains_key("authority_version"));
        assert!(body["authority_version"].is_null());
        assert!(body["mtime_ns"].is_string());
    }

    #[tokio::test]
    async fn bare_get_without_standalone_state_keeps_the_refusal() {
        let state = crate::state::test_support::make_test_state(false);
        let app = crate::terminal_router(state);
        let response = get(app, "/api/fs/note.md").await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(response).await,
            json!({"error": "terminal file route requires ?download=1"})
        );
    }

    #[tokio::test]
    async fn download_flag_keeps_the_absolute_transfer_lane_untouched() {
        let fx = files_fixture();
        // A file OUTSIDE the capability-test root: the download lane
        // re-roots at the real filesystem root and must keep doing so on a
        // Files tenant.
        let outside = TempDir::new().unwrap();
        let file = outside.path().join("probe.txt");
        std::fs::write(&file, b"download lane probe").unwrap();
        let response = get(
            router(&fx),
            &format!("/api/fs{}?download=1", file.display()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let disposition = response
            .headers()
            .get(header::CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert!(disposition.starts_with("attachment;"), "{disposition}");
        let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
        assert_eq!(&bytes[..], b"download lane probe");
    }

    #[tokio::test]
    async fn stream_read_emits_meta_chunk_done_frames() {
        let fx = files_fixture();
        std::fs::write(fx.root.join("note.md"), "hello").unwrap();
        let response = get(router(&fx), "/api/fs/note.md?stream=1").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("application/x-ndjson")
        );
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let frames: Vec<Value> = std::str::from_utf8(&bytes)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(frames.len() >= 3, "meta + chunk + done: {frames:?}");
        let meta = &frames[0];
        assert_eq!(meta["type"], "meta");
        assert_eq!(meta["path"], "note.md");
        assert_eq!(meta["size"], 5);
        assert!(meta.as_object().unwrap().contains_key("authority_version"));
        assert!(meta["authority_version"].is_null());
        assert_eq!(meta["disk_conflicted"], false);
        assert!(meta["mtime_ns"].is_string());
        assert_eq!(meta["max_editable_bytes"], chan_workspace::TEXT_WRITE_LIMIT);
        assert_eq!(
            frames[1],
            json!({"type": "chunk", "content": "hello", "bytes": 5})
        );
        assert_eq!(frames.last().unwrap(), &json!({"type": "done"}));
    }

    #[tokio::test]
    async fn active_svg_content_gets_attachment_csp_and_nosniff() {
        let fx = files_fixture();
        std::fs::write(fx.root.join("img.svg"), "<svg xmlns='x'></svg>").unwrap();
        let response = get(router(&fx), "/api/fs/img.svg").await;
        assert_eq!(response.status(), StatusCode::OK);
        let header_str = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_string()
        };
        assert_eq!(header_str("content-type"), "image/svg+xml");
        assert!(header_str("content-disposition").starts_with("attachment;"));
        assert_eq!(header_str("content-security-policy"), "sandbox");
        assert_eq!(header_str("x-content-type-options"), "nosniff");
    }

    async fn raw_put(fx: &Fixture, uri: &str, body: &str) -> axum::response::Response {
        router(fx)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(uri)
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn cas_write_succeeds_fresh_and_answers_409_with_the_current_token() {
        let fx = files_fixture();

        // Unconditional create.
        let response = raw_put(&fx, "/api/fs/new.md", "v1").await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["disk_conflicted"], false);
        assert!(
            !body.as_object().unwrap().contains_key("authority_version"),
            "the disk write response skips a null authority_version"
        );
        let t1 = body["mtime_ns"].as_str().expect("fresh token").to_string();

        // Fresh-token CAS write succeeds.
        let response = raw_put(&fx, &format!("/api/fs/new.md?expected_mtime_ns={t1}"), "v2").await;
        assert_eq!(response.status(), StatusCode::OK);
        let t2 = body_json(response).await["mtime_ns"]
            .as_str()
            .expect("second token")
            .to_string();

        // The stale token conflicts and reports the CURRENT token.
        let response = raw_put(&fx, &format!("/api/fs/new.md?expected_mtime_ns={t1}"), "v3").await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let t2_ns: i64 = t2.parse().unwrap();
        assert_eq!(
            body_json(response).await,
            json!({
                "current_mtime": t2_ns / 1_000_000_000,
                "current_mtime_ns": t2,
                "disk_conflicted": false,
            })
        );
        assert_eq!(
            std::fs::read_to_string(fx.root.join("new.md")).unwrap(),
            "v2",
            "the conflicting write must not land"
        );

        // A garbage token is a 400, not a treated-as-absent write.
        let response = raw_put(&fx, "/api/fs/new.md?expected_mtime_ns=nope", "v4").await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(response).await,
            json!({"error": "expected_mtime_ns must be a decimal nanosecond timestamp"})
        );
    }

    #[tokio::test]
    async fn stale_token_with_identical_bytes_adopts_instead_of_conflicting() {
        let fx = files_fixture();
        let response = raw_put(&fx, "/api/fs/same.md", "body").await;
        let stale = body_json(response).await["mtime_ns"]
            .as_str()
            .expect("first token")
            .to_string();
        // A second write moves the token while leaving the same bytes.
        raw_put(&fx, "/api/fs/same.md", "body").await;

        // Equal bytes cannot lose an update, so the shared CAS matrix's
        // content-equal arm answers 200 rather than raising a conflict
        // modal over a save that changes nothing.
        let response = raw_put(
            &fx,
            &format!("/api/fs/same.md?expected_mtime_ns={stale}"),
            "body",
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            std::fs::read_to_string(fx.root.join("same.md")).unwrap(),
            "body"
        );
    }

    #[tokio::test]
    async fn create_answers_201_and_duplicates_conflict() {
        let fx = files_fixture();
        let request = |body: Value| {
            Request::builder()
                .method("POST")
                .uri("/api/fs")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        let response = router(&fx)
            .oneshot(request(
                json!({"path": "made.md", "is_dir": false, "content": "x"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(
            std::fs::read_to_string(fx.root.join("made.md")).unwrap(),
            "x"
        );

        let response = router(&fx)
            .oneshot(request(
                json!({"path": "made.md", "is_dir": false, "content": "y"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);

        let response = router(&fx)
            .oneshot(request(json!({"path": "fresh-dir", "is_dir": true})))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        assert!(fx.root.join("fresh-dir").is_dir());
    }

    async fn delete(fx: &Fixture, uri: &str) -> axum::response::Response {
        router(fx)
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn delete_removes_files_and_refuses_nonempty_and_protected() {
        let fx = files_fixture();
        std::fs::write(fx.root.join("gone.txt"), "x").unwrap();
        let response = delete(&fx, "/api/fs/gone.txt").await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(!fx.root.join("gone.txt").exists());

        std::fs::create_dir(fx.root.join("full")).unwrap();
        std::fs::write(fx.root.join("full/inner.txt"), "x").unwrap();
        let response = delete(&fx, "/api/fs/full").await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(response).await,
            json!({"error": "directory_not_empty", "path": "full"})
        );
        assert!(fx.root.join("full/inner.txt").exists(), "nothing mutated");

        let response = delete(&fx, "/api/fs/home/user").await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(response).await,
            json!({"error": "protected_path", "path": "home/user"})
        );
    }

    #[tokio::test]
    async fn upload_app_files_creates_replaces_and_conflicts() {
        let fx = files_fixture();

        // Create into the root.
        let response = router(&fx)
            .oneshot(multipart_request(
                "/api/fs/upload?app=files",
                &[("dir", None, ""), ("file", Some("up.bin"), "data")],
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await,
            json!({"path": "up.bin", "size": 4})
        );

        // A second create at the same name refuses instead of clobbering.
        let response = router(&fx)
            .oneshot(multipart_request(
                "/api/fs/upload?app=files",
                &[("dir", None, ""), ("file", Some("up.bin"), "other")],
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);

        // The explicit replace flow rewrites the existing file.
        let response = router(&fx)
            .oneshot(multipart_request(
                "/api/fs/upload?app=files",
                &[
                    ("path", None, "up.bin"),
                    ("file", Some("ignored.bin"), "replaced"),
                ],
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await,
            json!({"path": "up.bin", "size": 8})
        );
        assert_eq!(
            std::fs::read_to_string(fx.root.join("up.bin")).unwrap(),
            "replaced"
        );
    }

    #[tokio::test]
    async fn upload_without_app_files_keeps_the_absolute_lane() {
        let fx = files_fixture();
        let outside = TempDir::new().unwrap();
        let response = router(&fx)
            .oneshot(multipart_request(
                "/api/fs/upload",
                &[
                    ("dir", None, &outside.path().display().to_string()),
                    ("file", Some("cs.bin"), "cs-upload"),
                ],
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(
            body["path"],
            outside.path().join("cs.bin").display().to_string(),
            "the cs lane keeps absolute display paths"
        );
        assert_eq!(
            std::fs::read_to_string(outside.path().join("cs.bin")).unwrap(),
            "cs-upload"
        );
    }

    #[tokio::test]
    async fn upload_app_files_without_standalone_state_is_not_served() {
        let state = crate::state::test_support::make_test_state(false);
        let app = crate::terminal_router(state);
        let response = app
            .oneshot(multipart_request(
                "/api/fs/upload?app=files",
                &[("dir", None, ""), ("file", Some("up.bin"), "data")],
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body_json(response).await,
            json!({"error": "files application not served on this tenant"})
        );
    }

    #[tokio::test]
    async fn attachment_requires_dir_and_lands_slugged_with_collision_suffix() {
        let fx = files_fixture();

        // The workspace attachments_dir fallback is deliberately absent:
        // interpreting that setting relative to `/` would land uploads on
        // an unrelated machine path.
        let response = router(&fx)
            .oneshot(multipart_request(
                "/api/attachments",
                &[("file", Some("My Pic.PNG"), "bytes")],
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(response).await,
            json!({"error": "missing `dir` field in multipart body"})
        );

        let response = router(&fx)
            .oneshot(multipart_request(
                "/api/attachments",
                &[("file", Some("My Pic.PNG"), "bytes"), ("dir", None, "")],
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_json(response).await, json!({"path": "My-Pic.png"}));

        let response = router(&fx)
            .oneshot(multipart_request(
                "/api/attachments",
                &[("file", Some("My Pic.PNG"), "more"), ("dir", None, "")],
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_json(response).await, json!({"path": "My-Pic-1.png"}));
    }

    #[tokio::test]
    async fn move_answers_the_wire_shape_and_never_clobbers() {
        let fx = files_fixture();
        std::fs::write(fx.root.join("a.md"), "a").unwrap();
        std::fs::write(fx.root.join("b.md"), "b").unwrap();
        let request = |body: Value| {
            Request::builder()
                .method("POST")
                .uri("/api/move")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };

        let response = router(&fx)
            .oneshot(request(json!({"from": "a.md", "to": "sub/a.md"})))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await,
            json!({
                "renamed": [["a.md", "sub/a.md"]],
                "rewritten": [],
                "conflicts": [],
            })
        );
        assert_eq!(
            std::fs::read_to_string(fx.root.join("sub/a.md")).unwrap(),
            "a"
        );

        let response = router(&fx)
            .oneshot(request(json!({"from": "sub/a.md", "to": "b.md"})))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(std::fs::read_to_string(fx.root.join("b.md")).unwrap(), "b");

        let response = router(&fx)
            .oneshot(request(json!({"from": "home/user", "to": "elsewhere"})))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(response).await,
            json!({"error": "protected_path", "path": "home/user"})
        );
    }

    #[tokio::test]
    async fn transfer_skips_own_parent_moves_and_suffixes_collisions() {
        let fx = files_fixture();
        std::fs::write(fx.root.join("x.md"), "x").unwrap();
        let request = |body: Value| {
            Request::builder()
                .method("POST")
                .uri("/api/fs/transfer")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };

        // A move into the source's own parent is reported skipped.
        let response = router(&fx)
            .oneshot(request(
                json!({"op": "move", "sources": ["x.md"], "dest_dir": ""}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await,
            json!({"moved": [], "skipped": ["x.md"], "conflicts": []})
        );

        // A copy into a collision resolves the Finder-style suffix.
        let response = router(&fx)
            .oneshot(request(
                json!({"op": "copy", "sources": ["x.md"], "dest_dir": ""}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await,
            json!({
                "moved": [{"from": "x.md", "to": "x copy.md"}],
                "skipped": [],
                "conflicts": [],
            })
        );
        assert_eq!(
            std::fs::read_to_string(fx.root.join("x copy.md")).unwrap(),
            "x"
        );

        // A real move lands with the same response shape.
        std::fs::create_dir(fx.root.join("dest")).unwrap();
        let response = router(&fx)
            .oneshot(request(
                json!({"op": "move", "sources": ["x.md"], "dest_dir": "dest"}),
            ))
            .await
            .unwrap();
        assert_eq!(
            body_json(response).await,
            json!({
                "moved": [{"from": "x.md", "to": "dest/x.md"}],
                "skipped": [],
                "conflicts": [],
            })
        );
    }

    #[tokio::test]
    async fn mutations_with_w_emit_attributed_fs_frames() {
        let fx = files_fixture();
        let (id, mut rx) = fx.registry.register();
        fx.registry.subscribe(id, "");

        let response = raw_put(&fx, "/api/fs/attr.md?w=w-writer", "x").await;
        assert_eq!(response.status(), StatusCode::OK);
        let frame: Value = serde_json::from_str(&rx.try_recv().expect("attributed frame")).unwrap();
        assert_eq!(frame["type"], "fs");
        assert_eq!(frame["dir"], "");
        assert_eq!(frame["source_w"], "w-writer");
        assert_eq!(frame["event"]["path"], "attr.md");

        // Without w= the bus is skipped entirely: no synthetic frame.
        let response = raw_put(&fx, "/api/fs/plain.md", "x").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            rx.try_recv().is_err(),
            "an unattributed mutation must not emit a synthetic frame"
        );
    }
}
