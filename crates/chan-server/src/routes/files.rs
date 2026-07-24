//! Per-file CRUD: list, read (text or binary), write (with optional
//! CAS), create (file or dir), delete, move.

use std::{convert::Infallible, io::Cursor, sync::Arc};

use axum::body::{Body, Bytes};
use axum::extract::{Multipart, Path as AxumPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::doc_sessions::{flush_session, DocSession, HttpReplaceOutcome as DocHttpReplaceOutcome};
use crate::error::{err, err_from, err_state};
use crate::scene_sessions::scene::SceneError;
use crate::scene_sessions::{
    flush_session as flush_scene_session, HttpReplaceOutcome as SceneHttpReplaceOutcome,
    SceneSession,
};
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
    Binary(Vec<u8>),
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
struct TreeEntryView {
    path: String,
    is_dir: bool,
    mtime: Option<i64>,
    size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    path_class: Option<chan_workspace::PathClass>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<&'static str>,
}

/// Map a regular-file path (and its contact flag) to the wire kind
/// string. Returns `None` for directories so the existing serializer
/// drops the field on dir entries.
fn project_kind(path: &str, is_dir: bool, is_contact: bool) -> Option<&'static str> {
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
    dir: Option<String>,
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

fn normalize_dir_query(dir: &str) -> chan_workspace::Result<String> {
    let trimmed = dir.trim_matches('/');
    if trimmed.is_empty() || trimmed == "." {
        return Ok(String::new());
    }
    chan_workspace::fs_ops::validate_rel(trimmed)?;
    Ok(trimmed.to_string())
}

fn join_rel(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

#[derive(Serialize)]
struct FileResponse {
    path: String,
    content: String,
    mtime: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mtime_ns: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path_class: Option<chan_workspace::PathClass>,
    /// Filesystem-level writability. False when the path lacks the
    /// user-write bit (e.g. `chmod -w`); the editor uses this to
    /// lock the per-tab read mode regardless of user choice. Sourced
    /// from `metadata().permissions().readonly()` on the resolved
    /// workspace-internal path so symlink escapes are still refused
    /// upstream by chan-workspace.
    writable: bool,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum FileStreamEvent<'a> {
    Meta {
        path: &'a str,
        size: u64,
        mtime: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        mtime_ns: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        path_class: Option<chan_workspace::PathClass>,
        writable: bool,
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

enum FileStreamMessage {
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

/// Check the user-write bit on a workspace-relative path. Returns true when
/// the path can't be safely resolved (matches read_text's own behavior
/// of failing later) so we don't surface a misleading "locked" lamp on a
/// path that's actually broken; callers get the real error from
/// `read_text` instead.
fn fs_writable(workspace: &chan_workspace::Workspace, rel: &str) -> bool {
    let abs = match chan_workspace::fs_ops::resolve_safe_strict(workspace.root(), rel) {
        Ok(p) => p,
        Err(_) => return true,
    };
    match std::fs::symlink_metadata(&abs) {
        Ok(m) => !m.permissions().readonly(),
        Err(_) => true,
    }
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
            return workspace.read(path).map(ReadFileResult::Binary);
        }
        _ => {}
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
            writable: fs_writable(workspace, path),
            path_class: path_class_for_wire(workspace, path),
        }),
        Err(chan_workspace::ChanError::NotEditableText(_)) => {
            workspace.read(path).map(ReadFileResult::Binary)
        }
        Err(e) => Err(e),
    }
}

fn ndjson_bytes(event: &FileStreamEvent<'_>) -> Result<Bytes, serde_json::Error> {
    let mut line = serde_json::to_vec(event)?;
    line.push(b'\n');
    Ok(Bytes::from(line))
}

fn ndjson_error_bytes(error: String) -> Bytes {
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
                    path_class: path_class_for_wire(workspace, path),
                    writable: fs_writable(workspace, path),
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

/// What a workspace download resolves to: a file read into memory, or a
/// directory whose tree has been pre-flighted readable and is ready to stream.
enum DownloadPayload {
    File(Vec<u8>),
    Directory,
}

fn download_path_sync(
    workspace: &chan_workspace::Workspace,
    path: &str,
) -> chan_workspace::Result<DownloadPayload> {
    let stat = workspace.stat(path)?;
    if stat.is_dir {
        // Pre-flight the tree before streaming so an unreadable entry fails fast
        // with a clear "cannot read X" status instead of truncating a streamed
        // archive mid-flight.
        verify_readable_workspace_tree(workspace, path).map_err(chan_workspace::ChanError::Io)?;
        Ok(DownloadPayload::Directory)
    } else {
        // A single file is read into memory; an unreadable file surfaces the
        // error here with no bytes sent.
        workspace.read(path).map(DownloadPayload::File)
    }
}

/// Pre-flight for a directory download: confirm every file in the tree we will
/// tar is readable before any archive work. Walks via `Workspace::list` so it
/// visits exactly the entries `append_dir_to_archive` will (same `.chan` /
/// `.git` filter), and opens each backing file to check read permission without
/// pulling its bytes (the archive reads them next).
fn verify_readable_workspace_tree(
    workspace: &chan_workspace::Workspace,
    rel: &str,
) -> std::result::Result<(), String> {
    for child in workspace
        .list(rel)
        .map_err(|e| format!("cannot read directory {rel}: {e}"))?
    {
        let child_rel = join_rel(rel.trim_matches('/'), &child.name);
        if child.is_dir {
            verify_readable_workspace_tree(workspace, &child_rel)?;
        } else {
            std::fs::File::open(workspace.root().join(&child_rel))
                .map(|_| ())
                .map_err(|e| format!("cannot read {child_rel}: {e}"))?;
        }
    }
    Ok(())
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
            let bytes = workspace.read(&child_source)?;
            append_archive_file(builder, &child_archive, bytes)?;
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
    bytes: Vec<u8>,
) -> chan_workspace::Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    builder.append_data(&mut header, archive_rel, Cursor::new(bytes))?;
    Ok(())
}

#[derive(Default, Deserialize)]
pub struct ReadFileQuery {
    #[serde(default)]
    download: Option<String>,
    #[serde(default)]
    stream: Option<String>,
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
) -> Response {
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
        let (content, token) = session.authority_view();
        return read_via_session(&workspace, content, token, &path, &query).await;
    }
    // Same divert for a live scene session: every read mode serves the
    // scene's file form (exactly what a flush would write) under the
    // session token.
    if let Some(session) = state.scene_sessions.get(&path) {
        let (content, token) = session.authority_view();
        return read_via_session(&workspace, content, token, &path, &query).await;
    }
    if query_flag(&query.download) {
        let plan_ws = workspace.clone();
        let plan_path = path.clone();
        let result =
            tokio::task::spawn_blocking(move || download_path_sync(&plan_ws, &plan_path)).await;
        return match result {
            Ok(Ok(DownloadPayload::File(bytes))) => (
                [
                    (header::CONTENT_TYPE, content_type_for(&path).to_string()),
                    (
                        header::CONTENT_DISPOSITION,
                        content_disposition_attachment(&path),
                    ),
                ],
                bytes,
            )
                .into_response(),
            // The tree was pre-flighted readable in the plan; stream the tar on
            // the fly so a cancel is trace-free by construction (no staged temp).
            Ok(Ok(DownloadPayload::Directory)) => {
                let root_name = download_filename(&path);
                let build_ws = workspace;
                let build_path = path;
                let build_name = root_name.clone();
                crate::routes::transfer::stream_tar_response(root_name, move |builder| {
                    append_dir_to_archive(builder, &build_ws, &build_path, &build_name)
                        .map_err(|e| std::io::Error::other(e.to_string()))
                })
            }
            Ok(Err(e)) => err_from(&e),
            Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
        };
    }

    if query_flag(&query.stream) {
        return stream_read_file_response(workspace, path).await;
    }

    let path_for_read = path.clone();
    let result =
        tokio::task::spawn_blocking(move || read_file_sync(&workspace, &path_for_read)).await;

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
            writable,
        })
        .into_response(),
        Ok(Ok(ReadFileResult::Binary(bytes))) => binary_file_response(&path, bytes),
        Ok(Err(e)) => err_from(&e),
        Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    }
}

fn binary_file_response(path: &str, bytes: Vec<u8>) -> Response {
    let mut response = ([(header::CONTENT_TYPE, content_type_for(path))], bytes).into_response();
    if is_active_content_path(path) {
        response.headers_mut().insert(
            header::CONTENT_DISPOSITION,
            content_disposition_attachment(path)
                .parse()
                .expect("download filename is header-safe"),
        );
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

fn is_active_content_path(path: &str) -> bool {
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
        (path_class_for_wire(&ws, &rel), fs_writable(&ws, &rel))
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
                path_class,
                writable,
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
        writable,
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

#[derive(Deserialize)]
pub struct WriteBody {
    content: String,
    /// CAS token: the mtime the client thinks the file currently
    /// has on disk. When present, the server uses
    /// Workspace::write_text_if_unchanged and rejects with 409 if the
    /// disk-side mtime differs. When absent, the write is
    /// last-write-wins (Workspace::write_text), preserving the
    /// pre-CAS contract for callers that don't care
    /// (bulk imports, scripts).
    #[serde(default)]
    expected_mtime: Option<i64>,
    /// Nanosecond CAS token as a decimal string. Preferred over
    /// `expected_mtime` when present, because JSON numbers cannot
    /// represent nanosecond mtimes exactly in browser clients.
    #[serde(default)]
    expected_mtime_ns: Option<String>,
}

#[derive(Serialize)]
struct WriteResponse {
    /// Mtime after the write. Frontend stores this as the next
    /// CAS token for subsequent saves so the client and disk stay
    /// in lock-step without an extra stat round-trip.
    mtime: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mtime_ns: Option<String>,
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
}

fn session_write_conflict_response(current_mtime_ns: Option<i64>) -> Response {
    (
        StatusCode::CONFLICT,
        Json(WriteConflictBody {
            current_mtime: current_mtime_ns.map(|ns| ns / 1_000_000_000),
            current_mtime_ns: current_mtime_ns.map(|ns| ns.to_string()),
        }),
    )
        .into_response()
}

pub async fn api_write_file(
    State(state): State<Arc<AppState>>,
    AxumPath(path): AxumPath<String>,
    Json(body): Json<WriteBody>,
) -> Response {
    let expected_mtime_ns = match parse_optional_mtime_ns(body.expected_mtime_ns.as_deref()) {
        Ok(mtime_ns) => mtime_ns,
        Err(message) => return err(StatusCode::BAD_REQUEST, message),
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
            return write_via_session(
                &state,
                &workspace,
                &session,
                body.expected_mtime,
                expected_mtime_ns,
                &body.content,
            )
            .await;
        }
    }
    // Same divert for a live scene session: CAS against the session
    // token, the body becomes the scene authority through the replace
    // semantics, and the reply awaits a forced flush. The removed-state
    // fall-through matches the doc divert above.
    if let Some(session) = state.scene_sessions.get(&path) {
        if session.diverts_http_write() {
            return write_via_scene_session(
                &state,
                &workspace,
                &session,
                body.expected_mtime,
                expected_mtime_ns,
                &body.content,
            )
            .await;
        }
    }
    // Record the self-write BEFORE the blocking write runs. The fs
    // watcher runs on its own thread and can deliver the resulting
    // notify event the instant the write lands; noting after the
    // spawn_blocking await left a window where that event reached
    // should_suppress() before the path was recorded, so the editor's
    // own autosave surfaced as a phantom "external edit" mid-typing.
    // Recording up front closes the window. Noting a path whose write
    // then fails (CAS conflict / IO error) is harmless and within the
    // module's documented over-suppression trade-off.
    state.self_writes.note(&path);
    let path_for_write = path.clone();
    let result = tokio::task::spawn_blocking(move || {
        write_file_sync(
            &workspace,
            &path_for_write,
            body.expected_mtime,
            expected_mtime_ns,
            &body.content,
        )
    })
    .await;

    let (mtime, mtime_ns) = match result {
        Ok(Ok(mtime)) => mtime,
        Ok(Err(e)) => {
            if let chan_workspace::ChanError::WriteConflict { current_mtime_ns } = e {
                return (
                    StatusCode::CONFLICT,
                    Json(WriteConflictBody {
                        current_mtime: current_mtime_ns.map(|ns| ns / 1_000_000_000),
                        current_mtime_ns: current_mtime_ns.map(|ns| ns.to_string()),
                    }),
                )
                    .into_response();
            }
            return err_from(&e);
        }
        Err(join) => return err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    };
    Json(WriteResponse {
        mtime,
        mtime_ns: mtime_ns.map(|ns| ns.to_string()),
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
    expected_mtime: Option<i64>,
    expected_mtime_ns: Option<i64>,
    content: &str,
) -> Response {
    // Text and token read under one lock: the equal-body escape below
    // must compare against the same authority state the token belongs to.
    let (authority_text, pre_token, disk_conflict_mtime_ns) = session.http_write_view();
    if let Some(disk_mtime_ns) = disk_conflict_mtime_ns {
        return session_write_conflict_response(disk_mtime_ns);
    }
    // The CAS matrix mirrors write_file_sync: the ns token is
    // preferred, the legacy form compares at second resolution, no
    // token is last-write-wins.
    let conflict = if let Some(expected) = expected_mtime_ns {
        pre_token != Some(expected)
    } else if let Some(expected) = expected_mtime {
        pre_token.map(|ns| ns / 1_000_000_000) != Some(expected)
    } else {
        false
    };
    if conflict {
        // Token-adopt escape: a stale token with a byte-identical body
        // is not a lost update. The client-side funnel fallback PUTs
        // the exact text the authority already holds while the
        // authority's freshest flush token is still in flight to that
        // client, so a bare token compare would answer a spurious 409
        // and the editor would raise its conflict modal for a file
        // nobody else touched. Equal bytes mean accepting can lose
        // nothing: adopt the caller onto the session token and skip
        // the no-op replace; any pending flush proceeds on its own
        // clock (the token rotation reaches attached clients through
        // the flush frame, exactly as for a confirmed edit).
        if pre_token.is_some() && content == authority_text {
            return Json(WriteResponse {
                mtime: pre_token.map(|ns| ns / 1_000_000_000),
                mtime_ns: pre_token.map(|ns| ns.to_string()),
            })
            .into_response();
        }
        return session_write_conflict_response(pre_token);
    }
    match session.apply_http_replace("$http", content) {
        Ok(DocHttpReplaceOutcome::Applied) => {}
        Ok(DocHttpReplaceOutcome::Conflicted { disk_mtime_ns }) => {
            return session_write_conflict_response(disk_mtime_ns);
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
        if let (_, _, Some(disk_mtime_ns)) = session.http_write_view() {
            return session_write_conflict_response(disk_mtime_ns);
        }
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "doc session accepted the write but the disk flush failed; retry".into(),
        );
    }
    let token = session.token();
    Json(WriteResponse {
        mtime: token.map(|ns| ns / 1_000_000_000),
        mtime_ns: token.map(|ns| ns.to_string()),
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
    expected_mtime: Option<i64>,
    expected_mtime_ns: Option<i64>,
    content: &str,
) -> Response {
    let (pre_token, disk_conflict_mtime_ns) = session.http_write_view();
    if let Some(disk_mtime_ns) = disk_conflict_mtime_ns {
        return session_write_conflict_response(disk_mtime_ns);
    }
    // The CAS matrix mirrors write_file_sync: the ns token is
    // preferred, the legacy form compares at second resolution, no
    // token is last-write-wins.
    let conflict = if let Some(expected) = expected_mtime_ns {
        pre_token != Some(expected)
    } else if let Some(expected) = expected_mtime {
        pre_token.map(|ns| ns / 1_000_000_000) != Some(expected)
    } else {
        false
    };
    if conflict {
        return session_write_conflict_response(pre_token);
    }
    match session.apply_http_replace(content) {
        Ok(SceneHttpReplaceOutcome::Applied) => {}
        Ok(SceneHttpReplaceOutcome::Conflicted { disk_mtime_ns }) => {
            return session_write_conflict_response(disk_mtime_ns);
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
        if let (_, Some(disk_mtime_ns)) = session.http_write_view() {
            return session_write_conflict_response(disk_mtime_ns);
        }
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "scene session accepted the write but the disk flush failed; retry".into(),
        );
    }
    let token = session.token();
    Json(WriteResponse {
        mtime: token.map(|ns| ns / 1_000_000_000),
        mtime_ns: token.map(|ns| ns.to_string()),
    })
    .into_response()
}

fn write_file_sync(
    workspace: &chan_workspace::Workspace,
    path: &str,
    expected_mtime: Option<i64>,
    expected_mtime_ns: Option<i64>,
    content: &str,
) -> chan_workspace::Result<(Option<i64>, Option<i64>)> {
    if let Some(ns) = expected_mtime_ns {
        workspace.write_text_if_unchanged(path, Some(ns), content)?;
    } else if expected_mtime.is_some() {
        let pre = workspace.stat(path).ok();
        let cur_secs = pre.as_ref().and_then(|s| s.mtime);
        let cur_ns = pre.as_ref().and_then(|s| s.mtime_ns);
        if expected_mtime != cur_secs {
            return Err(chan_workspace::ChanError::WriteConflict {
                current_mtime_ns: cur_ns,
            });
        }
        workspace.write_text_if_unchanged(path, cur_ns, content)?;
    } else {
        workspace.write_text(path, content)?;
    }
    let stat = workspace.stat(path).ok();
    Ok((
        stat.as_ref().and_then(|s| s.mtime),
        stat.as_ref().and_then(|s| s.mtime_ns),
    ))
}

fn parse_optional_mtime_ns(value: Option<&str>) -> Result<Option<i64>, String> {
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

#[derive(Deserialize)]
pub struct CreateBody {
    path: String,
    is_dir: bool,
    /// Optional initial contents for files. Ignored for directories.
    content: Option<String>,
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
struct UploadFileResponse {
    path: String,
    size: u64,
}

pub async fn api_upload_file(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Response {
    let mut chosen: Option<(String, Vec<u8>)> = None;
    let mut dir = String::new();
    let mut replace_path: Option<String> = None;
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
                        Ok(s) => dir = s,
                        Err(e) => {
                            return err(StatusCode::BAD_REQUEST, format!("multipart read: {e}"));
                        }
                    },
                    "path" => match field.text().await {
                        Ok(s) => replace_path = Some(s),
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

    let Some((filename, bytes)) = chosen else {
        return err(
            StatusCode::BAD_REQUEST,
            "missing `file` part in multipart body".into(),
        );
    };

    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(e) => return err_state(&e),
    };
    // The destination path is computed inside the blocking task (the
    // collision-avoidance loop picks a free name), so we can't note it
    // before the spawn. Clone the suppression handle in and record the
    // self-write inside the task, before it returns to the await, so
    // the watcher's echo is suppressed without the race that surfaced
    // server writes as phantom external edits. See api_write_file.
    let self_writes = Arc::clone(&state.self_writes);
    let result = tokio::task::spawn_blocking(move || {
        let upload = if let Some(path) = replace_path {
            replace_file_sync(&workspace, &path, &bytes)
        } else {
            upload_file_sync(&workspace, &dir, &filename, &bytes)
        }?;
        self_writes.note(&upload.path);
        Ok::<_, chan_workspace::ChanError>(upload)
    })
    .await;
    match result {
        Ok(Ok(upload)) => Json(upload).into_response(),
        Ok(Err(e)) => err_from(&e),
        Err(e) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("file upload task panicked: {e}"),
        ),
    }
}

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
    // Pre-flight: the parent directory is writable before overwriting, so a
    // failed replace writes nothing.
    let abs = workspace.root().join(trimmed);
    let parent = abs.parent().unwrap_or_else(|| workspace.root());
    crate::routes::transfer::verify_writable_dir(parent).map_err(chan_workspace::ChanError::Io)?;
    workspace.write_bytes(trimmed, bytes)?;
    Ok(UploadFileResponse {
        path: trimmed.to_string(),
        size: bytes.len() as u64,
    })
}

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
    // Pre-flight: the destination directory is writable before any write, so a
    // failed upload writes nothing (fail fast, no partial file).
    let abs_dir = if dir.is_empty() {
        workspace.root().to_path_buf()
    } else {
        workspace.root().join(&dir)
    };
    crate::routes::transfer::verify_writable_dir(&abs_dir)
        .map_err(chan_workspace::ChanError::Io)?;
    let filename = upload_leaf_filename(original_name)?;
    let rel = join_rel(&dir, &filename);
    if create_target_exists(workspace, &rel) {
        return Err(chan_workspace::ChanError::PathAlreadyExists(rel));
    }
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
mod file_browser_listing_tests {
    use super::{
        append_dir_to_archive, create_target_exists, download_path_sync, list_dir_entries,
        list_files_sync, replace_file_sync, upload_file_sync, upload_leaf_filename,
        DownloadPayload, ListFilesQuery,
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
        let payload = download_path_sync(&workspace, "docs").unwrap();
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
        let message = match download_path_sync(&workspace, "docs") {
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
    fn upload_file_sync_preflights_an_unwritable_destination() {
        use std::os::unix::fs::PermissionsExt;
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.create_dir("locked").unwrap();
        let locked = root.path().join("locked");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
        // Root bypasses directory write bits; skip the assertion then (and
        // restore perms so the TempDir can clean up).
        if tempfile::Builder::new().tempfile_in(&locked).is_ok() {
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
            return;
        }
        let err = upload_file_sync(&workspace, "locked", "x.txt", b"data").unwrap_err();
        let message = err.to_string();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(message.contains("not writable"), "{message}");
        assert!(
            !root.path().join("locked/x.txt").exists(),
            "a rejected upload writes nothing"
        );
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
            ReadFileResult::Binary(_) => panic!("expected editable text result"),
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

        match result {
            ReadFileResult::Binary(bytes) => assert_eq!(bytes, vec![0, 1, 2, 3]),
            ReadFileResult::Text { .. } => panic!("expected binary result"),
        }
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

        match read_file_sync(&workspace, "logo.svg").unwrap() {
            ReadFileResult::Binary(bytes) => assert_eq!(bytes, svg.as_bytes()),
            ReadFileResult::Text { .. } => panic!("svg must serve as raw bytes, not editor JSON"),
        }
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
            ReadFileResult::Binary(_) => panic!("expected sniffed text result"),
        }
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
        assert_eq!(events[1]["type"], "chunk");
        assert_eq!(events[1]["content"], "hello");
        assert_eq!(events[2]["type"], "done");
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

        let payload = download_path_sync(&workspace, "notes/readme.md").unwrap();

        match payload {
            DownloadPayload::File(bytes) => assert_eq!(bytes, b"hello\n"),
            DownloadPayload::Directory => panic!("expected file download"),
        }
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

        let payload = download_path_sync(&workspace, "notes").unwrap();
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

        assert!(source.contains(
            "tokio::task::spawn_blocking(move || read_file_sync(&workspace, &path_for_read))"
        ));
        assert!(source.contains(
            "tokio::task::spawn_blocking(move || download_path_sync(&plan_ws, &plan_path))"
        ));
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
    from: String,
    to: String,
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
struct MoveResponse {
    renamed: Vec<(String, String)>,
    rewritten: Vec<String>,
    conflicts: Vec<String>,
}

/// Multi-entry move/copy for the File Browser clipboard + multi-drag
/// (FB capabilities). `op` selects move (cut/paste, drag) vs copy
/// (copy/paste); `sources` are the workspace-rooted POSIX paths of the
/// selection; `dest_dir` is the target directory ("" = workspace root).
#[derive(Deserialize)]
pub struct TransferBody {
    op: TransferOp,
    sources: Vec<String>,
    dest_dir: String,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferOp {
    Move,
    Copy,
}

#[derive(Serialize, Default)]
struct TransferResponse {
    /// Per-source outcome, in request order: the final destination path
    /// each source landed at (after collision suffixing) plus the op.
    moved: Vec<TransferItem>,
    /// Sources skipped because the destination equals the source's
    /// current parent (a no-op move) or the source escaped the workspace.
    skipped: Vec<String>,
    /// Link-rewrite CAS conflicts accumulated across all moved entries.
    conflicts: Vec<String>,
}

#[derive(Serialize)]
struct TransferItem {
    from: String,
    to: String,
}

/// Basename of a workspace-rooted POSIX path.
fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Parent dir of a workspace-rooted POSIX path ("" for a top-level entry).
fn parent_dir(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[..i],
        None => "",
    }
}

pub async fn api_fs_transfer(
    State(state): State<Arc<AppState>>,
    Json(body): Json<TransferBody>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(e) => return err_state(&e),
    };
    let dest_dir = body.dest_dir.trim_end_matches('/').to_string();
    let op = body.op;
    let sources = body.sources.clone();

    // The whole batch runs on a blocking thread: each move does a
    // synchronous link-rewrite walk and each copy reads + writes N
    // files, both off the tokio worker pool.
    let dest_for_task = dest_dir.clone();
    // Note every created/moved/rewritten path INSIDE the blocking task,
    // as each workspace op reports it, so the watcher's Created/Removed
    // events are suppressed before the await returns. Noting after the
    // await (the old behavior) raced the watcher into firing phantom
    // external-edit prompts on files the user may have open. The
    // watcher still emits the events; the scoped `fs` registry routes
    // them to subscribed File Browser instances + the Graph.
    let self_writes = Arc::clone(&state.self_writes);
    let result = tokio::task::spawn_blocking(move || {
        let mut resp = TransferResponse::default();
        for src in &sources {
            let name = basename(src);
            // A move into the source's own current parent is a no-op
            // (and would otherwise resolve a needless " copy" suffix).
            if op == TransferOp::Move && parent_dir(src) == dest_for_task {
                resp.skipped.push(src.clone());
                continue;
            }
            // Resolve a non-colliding destination name; both copy and a
            // cut-into-a-collision get a Finder-style " copy" suffix so
            // we never overwrite.
            let dest = match workspace.resolve_free_name(&dest_for_task, name) {
                Ok(d) => d,
                Err(e) => return Err(e),
            };
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
        Ok::<_, chan_workspace::ChanError>(resp)
    })
    .await;

    let resp = match result {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return err_from(&e),
        Err(join) => return err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    };
    Json(resp).into_response()
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
            path_class: Some(chan_workspace::PathClass {
                kind: chan_workspace::PathKind::RegularFile,
                permission: chan_workspace::PathPermission::ReadWrite,
                link_count: 2,
                target: None,
                target_escapes_workspace: false,
            }),
            writable: true,
        };

        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["path_class"]["kind"], "regular_file");
        assert_eq!(value["path_class"]["permission"], "read_write");
        assert_eq!(value["path_class"]["link_count"], 2);
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
    use std::sync::atomic::AtomicU64;
    use std::sync::{Arc, Mutex, RwLock};

    use axum::body::{to_bytes, Body};
    use axum::extract::{Path as AxumPath, Query, State};
    use axum::http::{header, Request, StatusCode};
    use axum::Json;
    use chan_workspace::{SearchAggression, WatchEvent, WatchKind};
    use serde_json::Value;
    use tempfile::TempDir;
    use tokio::sync::{broadcast, watch};
    use tower::ServiceExt;

    use super::{api_read_file, api_write_file, ReadFileQuery, WriteBody};
    use crate::doc_sessions::changes::{replace_diff, UpdateJson};
    use crate::self_writes::SelfWrites;
    use crate::state::{AppState, WorkspaceCell};
    use crate::terminal_sessions::{Registry as TerminalRegistry, RegistryConfig};
    use crate::{EditorPrefs, ServerConfig};

    pub(super) fn divert_app() -> (TempDir, TempDir, Arc<AppState>) {
        let cfg = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
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
            terminal_session_dir: None,
            window_presence: Arc::new(crate::window_presence::WindowPresence::new()),
            session_registry: Arc::new(crate::session_presence::SessionRegistry::new()),
            window_transfers: Arc::new(crate::window_transfers::WindowTransfers::new()),
            window_titles: Arc::new(crate::window_titles::WindowTitles::new()),
            instance_id: "test-instance".to_string(),
        });
        (cfg, root, state)
    }

    pub(super) async fn body_json(resp: axum::response::Response) -> Value {
        let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
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
        let body = serde_json::to_string(&serde_json::json!({
            "content": shrunk,
            "expected_mtime": null,
            "expected_mtime_ns": token_ns.to_string(),
        }))
        .unwrap();
        let resp = router
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/files/legacy.md")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
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

        // Plain JSON: authority text under the session token.
        let resp = api_read_file(
            State(state.clone()),
            AxumPath("n.md".to_string()),
            Query(ReadFileQuery {
                download: None,
                stream: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["content"], "live v2\n");
        assert_eq!(v["mtime_ns"], token.to_string());
        assert_eq!(v["writable"], true);

        // Stream: Meta + ONE Chunk + Done, same token, same text; the
        // shape is indistinguishable from the disk stream.
        let resp = api_read_file(
            State(state.clone()),
            AxumPath("n.md".to_string()),
            Query(ReadFileQuery {
                download: None,
                stream: Some("1".into()),
            }),
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
            }),
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

        // No token: last-write-wins, same as the disk path's contract.
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
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            std::fs::read_to_string(root.path().join("n.md")).unwrap(),
            "four\n"
        );
    }

    #[tokio::test]
    async fn put_divert_stale_token_equal_body_token_adopts() {
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
        // Token-adopt: 200 carrying the session token, no $http fan.
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
        assert_eq!(v["mtime_ns"], token0.to_string());
        while let Ok(raw) = frames.try_recv() {
            let f: Value = serde_json::from_str(&raw).unwrap();
            assert_ne!(
                f["updates"][0]["clientID"], "$http",
                "an equal-body adopt must not fan a replace"
            );
        }

        // Live unflushed edit: authority text moves ahead of disk while
        // the token stays put. An equal-to-AUTHORITY body still adopts,
        // and the pending flush is left on its own clock (disk keeps
        // the old bytes: no forced flush rides the adopt).
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
        assert_eq!(v["mtime_ns"], token0.to_string());
        assert_eq!(
            std::fs::read_to_string(root.path().join("n.md")).unwrap(),
            "one\n"
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
        assert_eq!(v["current_mtime_ns"], token0.to_string());
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
        let conflict_token = stat.mtime_ns.expect("conflicting disk token");

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
                WatchEvent {
                    kind: WatchKind::Removed,
                    path: Some("n.md".into()),
                    to: None,
                },
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
    use axum::extract::{Path as AxumPath, Query, State};
    use axum::http::StatusCode;
    use axum::Json;
    use chan_workspace::{WatchEvent, WatchKind};
    use serde_json::{json, Value};

    use super::doc_divert_tests::{body_json, divert_app};
    use super::{api_read_file, api_write_file, ReadFileQuery, WriteBody};

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

        let resp = api_read_file(
            State(state.clone()),
            AxumPath("b.excalidraw".to_string()),
            Query(ReadFileQuery {
                download: None,
                stream: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["mtime_ns"], token.to_string());
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
                WatchEvent {
                    kind: WatchKind::Removed,
                    path: Some("b.excalidraw".into()),
                    to: None,
                },
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
