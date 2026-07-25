//! Filesystem graph: directories, files, symlinks, hardlinks, and
//! ghost nodes (broken or outside-workspace symlink targets, plus
//! special files like FIFOs and sockets that the content index
//! deliberately drops).
//!
//! Distinct from `/api/graph`, which describes the *semantic* graph
//! built from markdown content (file/tag/mention nodes, link/tag/
//! mention edges). This route walks the actual filesystem under the
//! workspace root and reports its shape. Same workspace sandbox invariants
//! apply: requests are lexically resolved through
//! `chan_workspace::fs_ops::resolve_safe` so `..` traversal is rejected
//! before any I/O.
//!
//! The walker uses `symlink_metadata` everywhere (lstat semantics) so
//! a symlink is never confused with the file it points at. Symlink
//! targets are classified but never traversed: their existence and
//! whether they land inside the workspace root workspaces the node kind, and
//! traversal only follows `contains` edges (parent -> child) under
//! real directories.
//!
//! Hardlinks are deduped by `(st_dev, st_ino)`. Two paths sharing the
//! same inode are surfaced as two `file` nodes joined by a
//! `hardlink` edge in addition to their parent `contains` edges.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs::Metadata;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::error::{err, err_state};
use crate::state::AppState;

/// Hard cap on `depth` for scope=directory. Ten matches the frontend's
/// GRAPH_DEPTH_HARD_MAX so the depth slider can reveal the full tree of a
/// deeper (e.g. source-style) workspace, not just the few levels a notes
/// workspace uses. A single request stays bounded by MAX_NODES below, so
/// a genuinely huge tree truncates by node count rather than by depth.
const MAX_DEPTH: usize = 10;

/// Hard cap on emitted nodes. Past this the response is truncated and
/// `truncated: true` flags it on the wire so the frontend can warn
/// the user that they're looking at a partial graph.
const MAX_NODES: usize = 10_000;

/// Paged-delivery batch caps. A *paged* request (one carrying `limit`
/// or `cursor`) returns at most this many nodes and at most this many
/// bytes of node payload, whichever trips first, then hands back a
/// `cursor` to resume. This is what keeps a large workspace
/// (`/tmp/linux`) filling in gradually instead of blocking the UI on a
/// single large payload. A *non-paged* request (neither param) keeps
/// the historical whole-scope walk capped at `MAX_NODES` -- the
/// depth-cap probe relies on that completeness.
const BATCH_MAX_NODES: usize = 256;
const BATCH_MAX_BYTES: usize = 64 * 1024;
const BATCH_MIN_NODES: usize = 16;

/// Cheap per-node serialized-size estimate for the byte budget. The
/// node cap is the primary bound; this is a safety net so a directory
/// of pathologically long names can't blow one frame past the byte
/// ceiling. `id` + `path` are ~the rel path each, `name` is the
/// basename, plus fixed JSON field overhead.
const NODE_FIXED_BYTES: usize = 96;

#[derive(Deserialize)]
pub struct FsGraphParams {
    /// `file` or `directory`. Default `directory` so a bare
    /// `/api/fs-graph?path=...` is the common case (workspace overview /
    /// directory snapshot).
    #[serde(default = "default_scope")]
    scope: FsGraphScope,
    /// Workspace-relative target. Empty / missing / `/` means the workspace
    /// root. Path is lexical: leading slash is trimmed,
    /// `..`-traversal is rejected before any I/O.
    #[serde(default)]
    path: String,
    /// For scope=directory: how many levels of children to walk.
    /// Depth 1 means direct children only. Capped at `MAX_DEPTH`.
    /// Ignored for scope=file (always returns the file and its
    /// parent / symlink target).
    #[serde(default = "default_depth")]
    depth: usize,
    /// Opaque continuation token from a previous paged response's
    /// `cursor`. Absent on the first request of a paged walk. Bound to
    /// the `(scope, path, depth)` it was issued for; a mismatch is a
    /// 400 so the caller restarts from no cursor.
    #[serde(default)]
    cursor: Option<String>,
    /// Switches on paged delivery: the response is bounded to one batch
    /// (`limit` nodes, clamped to `[BATCH_MIN_NODES, BATCH_MAX_NODES]`)
    /// plus a `cursor` to fetch the next. Absent (and no `cursor`) =
    /// the historical whole-scope walk the depth-cap probe relies on.
    #[serde(default)]
    limit: Option<usize>,
}

fn default_scope() -> FsGraphScope {
    FsGraphScope::Directory
}

fn default_depth() -> usize {
    1
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FsGraphScope {
    File,
    Directory,
}

impl FsGraphScope {
    fn label(self) -> &'static str {
        match self {
            FsGraphScope::File => "file",
            FsGraphScope::Directory => "directory",
        }
    }
}

/// Resume position for a paged directory walk, encoded opaquely into
/// the wire `cursor` (base64url of JSON). Bound to the `(path, depth)`
/// of its walk so a stale cursor from a different scope is rejected up
/// front rather than silently producing a wrong batch.
///
/// The walk is a depth-first pre-order over sorted directory entries;
/// the resume state is therefore the DFS stack, which is bounded to at
/// most `MAX_DEPTH` entries -- that is what keeps the cursor small.
/// Short field names keep the encoded token compact.
#[derive(Debug, Serialize, Deserialize)]
struct FsCursor {
    /// Scope path the walk was issued for (normalized rel).
    p: String,
    /// Requested (clamped) depth of the walk.
    d: usize,
    /// DFS stack, outermost directory first.
    s: Vec<CursorFrame>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CursorFrame {
    /// Directory rel path (workspace-relative POSIX, `""` = root).
    r: String,
    /// Index of the next child to process within the dir's sorted
    /// entries.
    i: usize,
    /// Levels of children still allowed below this dir (`find -d`
    /// budget). A child dir frame is pushed only while this is > 1.
    l: usize,
}

fn encode_cursor(c: &FsCursor) -> String {
    let json = serde_json::to_vec(c).unwrap_or_default();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
}

fn decode_cursor(s: &str) -> Option<FsCursor> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s.as_bytes())
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[derive(Debug, Serialize)]
pub struct FsGraphResponse {
    /// Workspace root absolute path, identical to what `/api/workspace`
    /// reports. Included so the frontend can render breadcrumbs
    /// without a follow-up call.
    pub root: String,
    pub scope: &'static str,
    /// The request's `path` after lexical normalization (empty means
    /// workspace root).
    pub path: String,
    /// The effective directory depth used. For scope=file this is always
    /// 0 (the file plus its parent / target are the response).
    pub depth: usize,
    pub nodes: Vec<NodeView>,
    pub edges: Vec<EdgeView>,
    /// True when the walker hit `MAX_NODES` and stopped early. Callers
    /// should narrow the scope or reduce depth. Paged responses never
    /// truncate (paging is the answer to largeness); they hand back a
    /// `cursor` instead.
    pub truncated: bool,
    /// Opaque continuation token. `Some` only on a paged response with
    /// more batches to come; `None` on the final paged batch and on
    /// every non-paged whole-scope response. Callers must not parse it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// True when no more batches remain: the final paged batch, or any
    /// non-paged whole-scope response. Always present so a paged client
    /// has an unambiguous stop signal.
    pub done: bool,
}

/// Node identifier shape:
///
///   - In-workspace entries: workspace-relative POSIX path. Workspace root is
///     the empty string.
///   - Outside-workspace symlink targets: `outside:<symlink-src>` where
///     `<symlink-src>` is the workspace-relative source path. Stable
///     within a response so the frontend can hang labels off it; not
///     suitable as a long-term identifier across responses since the
///     symlink's target may change.
///   - In-workspace missing targets: workspace-relative POSIX path of the
///     would-be file. Marked `broken: true`.
#[derive(Debug, Clone, Serialize)]
pub struct NodeView {
    pub id: String,
    pub kind: &'static str,
    /// Basename for the file / directory. For ghost-outside nodes
    /// this is the literal `readlink` target so the frontend can
    /// show something meaningful.
    pub name: String,
    /// Workspace-relative path (POSIX). Same as `id` for in-workspace nodes;
    /// empty for outside-workspace ghosts.
    pub path: String,
    /// File size in bytes (regular files only; 0 for everything
    /// else).
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_class: Option<chan_workspace::PathClass>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission: Option<chan_workspace::PathPermission>,
    #[serde(skip_serializing_if = "is_one")]
    pub link_count: u64,
    /// Last-modified time in unix seconds, when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<i64>,
    /// Raw `readlink` target for symlink nodes. None for other kinds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// True for symlink targets that point outside the workspace root.
    /// Never traversed.
    #[serde(skip_serializing_if = "is_false")]
    pub outside: bool,
    /// True for ghost nodes that represent missing in-workspace targets
    /// (broken `readlink`) or unreadable entries.
    #[serde(skip_serializing_if = "is_false")]
    pub broken: bool,
    /// True for symlink nodes whose target resolves outside the workspace.
    #[serde(skip_serializing_if = "is_false")]
    pub target_escapes_workspace: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

fn is_one(n: &u64) -> bool {
    *n == 1
}

#[derive(Debug, Clone, Serialize)]
pub struct EdgeView {
    pub source: String,
    pub target: String,
    pub kind: &'static str,
}

#[derive(Debug)]
pub struct FsGraphError {
    status: StatusCode,
    message: String,
}

impl FsGraphError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    pub(crate) fn into_response(self) -> Response {
        err(self.status, self.message)
    }
}

impl std::fmt::Display for FsGraphError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for FsGraphError {}

pub async fn api_fs_graph(
    State(state): State<Arc<AppState>>,
    Query(p): Query<FsGraphParams>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    // A request carrying `limit` or `cursor` is paged: bounded one
    // batch at a time with a continuation token. Otherwise it is the
    // historical whole-scope walk (the depth-cap probe needs that
    // completeness).
    let paged = p.limit.is_some() || p.cursor.is_some();
    let result = tokio::task::spawn_blocking(move || {
        if paged {
            build_fs_graph_paged(&workspace, &p)
        } else {
            build_fs_graph(&workspace, p.scope, &p.path, p.depth)
        }
    })
    .await;
    match result {
        Ok(Ok(response)) => Json(response).into_response(),
        Ok(Err(e)) => err(e.status, e.message),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("filesystem graph task panicked: {e}"),
        )
            .into_response(),
    }
}

/// The request scope after path resolution + the sandbox / escape /
/// existence guards. Shared by the whole-scope and paged entry points
/// so the (intricate) mid-path symlink escape check lives in one place.
struct ResolvedScope {
    root: PathBuf,
    rel: String,
    abs: PathBuf,
    meta: Metadata,
    /// Clamped to `[1, MAX_DEPTH]` for directory scope; `0` for file.
    depth: usize,
}

fn resolve_scope(
    workspace: &chan_workspace::Workspace,
    scope: FsGraphScope,
    path: &str,
    requested_depth: usize,
) -> Result<ResolvedScope, FsGraphError> {
    let root: PathBuf = workspace.root().to_path_buf();
    let rel = normalize_rel(path);
    let abs = if rel.is_empty() {
        root.clone()
    } else {
        match chan_workspace::fs_ops::resolve_safe(&root, &rel) {
            Ok(a) => a,
            Err(e) => return Err(FsGraphError::new(StatusCode::BAD_REQUEST, e.to_string())),
        }
    };

    // Mid-path symlink escape guard. `resolve_safe` is LEXICAL only:
    // if the request path traverses through an in-workspace symlink that
    // points outside the workspace (`escape-link -> /etc`), the join
    // gives `<workspace>/escape-link/hosts`, which `symlink_metadata`
    // happily resolves to `/etc/hosts` because intermediate components
    // are followed during path resolution (lstat only spares the
    // leaf). Canonicalize the parent and verify it stays under the
    // workspace's canonical root. The leaf itself can still be a symlink;
    // the walker classifies symlink leaves via readlink without
    // following them, so an in-workspace symlink to an outside file
    // surfaces correctly as a ghost node.
    ensure_parent_inside_workspace(&root, &abs, &rel)?;

    let meta = match std::fs::symlink_metadata(&abs) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(FsGraphError::new(
                StatusCode::NOT_FOUND,
                format!("no such path: {rel}"),
            ));
        }
        Err(e) => {
            return Err(FsGraphError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("stat: {e}"),
            ));
        }
    };

    // Reject scope=directory against a non-directory up front so the
    // walker stays infallible; the wire error shape matches the
    // 400 we use elsewhere.
    if scope == FsGraphScope::Directory && !meta.is_dir() {
        return Err(FsGraphError::new(
            StatusCode::BAD_REQUEST,
            format!("scope=directory requires a directory; {rel} is not"),
        ));
    }

    let depth = match scope {
        FsGraphScope::File => 0,
        FsGraphScope::Directory => requested_depth.clamp(1, MAX_DEPTH),
    };
    Ok(ResolvedScope {
        root,
        rel,
        abs,
        meta,
        depth,
    })
}

pub fn build_fs_graph(
    workspace: &chan_workspace::Workspace,
    scope: FsGraphScope,
    path: &str,
    requested_depth: usize,
) -> Result<FsGraphResponse, FsGraphError> {
    let r = resolve_scope(workspace, scope, path, requested_depth)?;

    let mut walker = FsGraphWalker::new(r.root.clone(), workspace.walk_filter().clone());
    match scope {
        FsGraphScope::File => walker.walk_file(&r.rel, &r.abs, &r.meta),
        FsGraphScope::Directory => walker.walk_directory(&r.rel, &r.abs, &r.meta, r.depth),
    }

    let (nodes, edges, truncated) = walker.finish();
    Ok(FsGraphResponse {
        root: r.root.display().to_string(),
        scope: scope.label(),
        path: r.rel,
        depth: r.depth,
        nodes,
        edges,
        truncated,
        cursor: None,
        done: true,
    })
}

/// Paged directory-scope walk: returns at most one bounded batch
/// (`limit` nodes, clamped) plus a `cursor` to resume. File scope is
/// always small (the file plus its parent / symlink target), so it is
/// never paged -- it returns the whole `done: true` payload regardless
/// of the paging params. The walk's node/edge CONTENTS are identical to
/// `build_fs_graph`; only delivery is split into frames.
///
/// Hardlink edges are emitted per batch from the inodes seen in that
/// batch (`finish`), so a hardlink pair split across two batches is not
/// joined in paged mode. That is the one paged-mode content caveat;
/// the whole-scope path (`build_fs_graph`) keeps hardlinks intact.
pub fn build_fs_graph_paged(
    workspace: &chan_workspace::Workspace,
    p: &FsGraphParams,
) -> Result<FsGraphResponse, FsGraphError> {
    let FsGraphParams {
        scope,
        path,
        depth: requested_depth,
        cursor,
        limit,
    } = p;
    let (scope, requested_depth, cursor, limit) =
        (*scope, *requested_depth, cursor.as_deref(), *limit);
    let r = resolve_scope(workspace, scope, path, requested_depth)?;

    if scope == FsGraphScope::File {
        let mut walker = FsGraphWalker::new(r.root.clone(), workspace.walk_filter().clone());
        walker.walk_file(&r.rel, &r.abs, &r.meta);
        let (nodes, edges, truncated) = walker.finish();
        return Ok(FsGraphResponse {
            root: r.root.display().to_string(),
            scope: scope.label(),
            path: r.rel,
            depth: r.depth,
            nodes,
            edges,
            truncated,
            cursor: None,
            done: true,
        });
    }

    // Directory scope. Decode + validate the resume cursor against this
    // walk's (path, depth); a cursor from a different scope is a 400 so
    // the caller restarts cleanly rather than getting a wrong batch.
    let resume = match cursor {
        Some(token) => {
            let parsed = decode_cursor(token).ok_or_else(|| {
                FsGraphError::new(StatusCode::BAD_REQUEST, "invalid graph cursor")
            })?;
            if parsed.p != r.rel || parsed.d != r.depth {
                return Err(FsGraphError::new(
                    StatusCode::BAD_REQUEST,
                    "graph cursor does not match the requested scope/depth",
                ));
            }
            Some(parsed.s)
        }
        None => None,
    };

    let batch_nodes = limit
        .unwrap_or(BATCH_MAX_NODES)
        .clamp(BATCH_MIN_NODES, BATCH_MAX_NODES);

    let mut walker = FsGraphWalker::new(r.root.clone(), workspace.walk_filter().clone());
    let next = walker.walk_directory_paged(
        &r.rel,
        &r.abs,
        &r.meta,
        r.depth,
        resume,
        BatchBudget {
            max_nodes: batch_nodes,
            max_bytes: BATCH_MAX_BYTES,
        },
    );
    let (nodes, edges, truncated) = walker.finish();

    let (cursor_out, done) = match next {
        Some(frames) => (
            Some(encode_cursor(&FsCursor {
                p: r.rel.clone(),
                d: r.depth,
                s: frames,
            })),
            false,
        ),
        None => (None, true),
    };

    Ok(FsGraphResponse {
        root: r.root.display().to_string(),
        scope: scope.label(),
        path: r.rel,
        depth: r.depth,
        nodes,
        edges,
        truncated,
        cursor: cursor_out,
        done,
    })
}

/// Verify that the parent of the joined request path resolves
/// inside the workspace root. Catches `path=alias-to-outside/x.md`
/// where `alias-to-outside` is an in-workspace symlink whose target
/// escapes the workspace -- `resolve_safe` is lexical and lets that
/// through, but the kernel will follow the intermediate symlink on
/// `symlink_metadata` / `read_dir`. Workspace root requests skip the
/// check (the request resolves to the workspace root itself; no parent
/// to verify).
fn ensure_parent_inside_workspace(root: &Path, abs: &Path, rel: &str) -> Result<(), FsGraphError> {
    if rel.is_empty() {
        return Ok(());
    }
    let parent = match abs.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => return Ok(()),
    };
    // Canonicalize the workspace root once per request. Cheap on local
    // filesystems; pricier on cloud-synced mounts (iCloud / Dropbox)
    // but still bounded by a single FS-provider round trip.
    let root_canon = match root.canonicalize() {
        Ok(c) => c,
        // The workspace root must canonicalize. If it doesn't (deleted
        // out from under us, broken mount) we cannot serve the
        // request safely -- surface as 500 rather than silently
        // allowing the lexical check.
        Err(e) => {
            return Err(FsGraphError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("canonicalize workspace root: {e}"),
            ));
        }
    };
    // Parent equal to workspace root is the common case (top-level file
    // request); skip the canonicalize round trip.
    if parent == root || parent == root_canon {
        return Ok(());
    }
    let parent_canon = match parent.canonicalize() {
        Ok(c) => c,
        // Parent dir does not exist. Fall through to the caller's
        // `symlink_metadata` call, which will surface the standard
        // NOT_FOUND error for the leaf.
        Err(_) => return Ok(()),
    };
    if !parent_canon.starts_with(&root_canon) {
        return Err(FsGraphError::new(
            StatusCode::BAD_REQUEST,
            format!("path escapes workspace root via mid-path symlink: {rel}"),
        ));
    }
    Ok(())
}

/// Trim a leading slash and collapse `.` segments. Pure-`..` requests
/// pass through unchanged; `resolve_safe` will reject them with the
/// standard error wire shape so this helper does not have to.
fn normalize_rel(requested: &str) -> String {
    let trimmed = requested.trim_start_matches('/');
    if trimmed.is_empty() || trimmed == "." {
        return String::new();
    }
    let mut out = PathBuf::new();
    for c in Path::new(trimmed).components() {
        match c {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            _ => return trimmed.to_owned(),
        }
    }
    out.to_string_lossy().replace('\\', "/")
}

#[cfg(unix)]
fn inode_key(meta: &Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((meta.dev(), meta.ino()))
}

#[cfg(not(unix))]
fn inode_key(_meta: &Metadata) -> Option<(u64, u64)> {
    None
}

#[cfg(unix)]
fn nlink_of(meta: &Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.nlink()
}

#[cfg(not(unix))]
fn nlink_of(_meta: &Metadata) -> u64 {
    1
}

fn mtime_of(meta: &Metadata) -> Option<i64> {
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

fn basename_of(rel: &str, abs: &Path) -> String {
    if rel.is_empty() {
        abs.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "/".into())
    } else {
        rel.rsplit('/').next().unwrap_or(rel).to_owned()
    }
}

/// Read a directory's entries and sort them by basename so the wire
/// output is stable (`read_dir` order is platform-defined) and a paged
/// walk's cursor resumes at a deterministic position. An unreadable
/// directory yields no entries (the branch just ends).
fn read_dir_sorted(abs: &Path) -> Vec<(OsString, PathBuf)> {
    let Ok(read) = std::fs::read_dir(abs) else {
        return Vec::new();
    };
    let mut entries: Vec<(OsString, PathBuf)> = read
        .filter_map(|r| r.ok())
        .map(|e| (e.file_name(), e.path()))
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries
}

/// Cheap serialized-size estimate for one node, for the paged byte
/// budget. `id` + `path` are ~the rel path each, plus the basename and
/// fixed JSON field overhead.
fn node_byte_estimate(rel: &str) -> usize {
    NODE_FIXED_BYTES + rel.len() * 2 + rel.rsplit('/').next().map(str::len).unwrap_or(0)
}

fn node_kind_from_class(
    class: Option<&chan_workspace::PathClass>,
    ft: &std::fs::FileType,
) -> &'static str {
    match class.map(|c| c.kind) {
        Some(chan_workspace::PathKind::Symlink) => "symlink",
        Some(chan_workspace::PathKind::Directory) => "directory",
        Some(chan_workspace::PathKind::RegularFile) => "file",
        Some(
            chan_workspace::PathKind::Fifo
            | chan_workspace::PathKind::Socket
            | chan_workspace::PathKind::BlockDevice
            | chan_workspace::PathKind::CharDevice
            | chan_workspace::PathKind::Other,
        ) => "ghost",
        None if ft.is_symlink() => "symlink",
        None if ft.is_dir() => "directory",
        None if ft.is_file() => "file",
        None => "ghost",
    }
}

/// Internal accumulator. Holds the nodes/edges plus dedup tables so
/// each path emits a single node and each pair of hardlinks emits a
/// single `hardlink` edge.
struct FsGraphWalker {
    root: PathBuf,
    root_canon: Option<PathBuf>,
    /// Directory-name blocklist (the per-workspace `WalkFilter`). The
    /// child walk skips any directory whose basename is excluded, at
    /// any depth, so the filesystem graph never plots `node_modules/`
    /// / `target/` / `venv/` dependency trees. Matches the index and
    /// File Browser spine, which exclude the same set.
    filter: chan_workspace::fs_ops::WalkFilter,
    nodes: BTreeMap<String, NodeView>,
    edges: Vec<EdgeView>,
    edge_set: HashSet<(String, String, &'static str)>,
    /// Paths grouped by `(dev, ino)`. Filled as we visit files; used
    /// to emit a single `hardlink` edge between any two paths sharing
    /// the same inode.
    inode_paths: HashMap<(u64, u64), Vec<String>>,
    truncated: bool,
}

/// Outcome of emitting one directory child. Shared by the recursive
/// whole-scope `walk_dir` and the paged stack walk so the per-child
/// classification (blocklist skip, ghost on stat failure, node + parent
/// `contains` edge) lives in one place.
enum ChildOutcome {
    /// A real entry was emitted; carries its rel path + metadata so the
    /// caller decides whether to descend into it.
    Emitted { rel: String, meta: Metadata },
    /// A missing / unreadable entry was emitted as a ghost; never
    /// descended.
    Ghost,
}

/// One directory on the paged walk's DFS stack: its sorted entries and
/// how far through them we are. `levels` is the `find -d` budget of
/// children still allowed below this dir (a child dir frame is pushed
/// only while `levels > 1`, which yields exactly `relative_depth <=
/// depth`).
struct DirFrame {
    rel: String,
    entries: Vec<(OsString, PathBuf)>,
    idx: usize,
    levels: usize,
}

/// Per-call emission budget for a paged walk: cut the batch once either
/// the node count or the estimated byte size is reached.
#[derive(Clone, Copy)]
struct BatchBudget {
    max_nodes: usize,
    max_bytes: usize,
}

impl FsGraphWalker {
    fn new(root: PathBuf, filter: chan_workspace::fs_ops::WalkFilter) -> Self {
        let root_canon = root.canonicalize().ok();
        Self {
            root,
            root_canon,
            filter,
            nodes: BTreeMap::new(),
            edges: Vec::new(),
            edge_set: HashSet::new(),
            inode_paths: HashMap::new(),
            truncated: false,
        }
    }

    fn finish(mut self) -> (Vec<NodeView>, Vec<EdgeView>, bool) {
        // Emit one `hardlink` edge per pair of paths sharing an inode.
        // Sort the group so the wire output is stable; `source <
        // target` lexicographically.
        let inode_paths = std::mem::take(&mut self.inode_paths);
        let groups: Vec<Vec<String>> = inode_paths.into_values().filter(|v| v.len() >= 2).collect();
        for mut group in groups {
            group.sort();
            for i in 0..group.len() {
                for j in (i + 1)..group.len() {
                    self.push_edge(group[i].clone(), group[j].clone(), "hardlink");
                }
            }
        }
        let nodes: Vec<NodeView> = self.nodes.into_values().collect();
        (nodes, self.edges, self.truncated)
    }

    fn push_edge(&mut self, source: String, target: String, kind: &'static str) {
        let key = (source.clone(), target.clone(), kind);
        if self.edge_set.insert(key) {
            self.edges.push(EdgeView {
                source,
                target,
                kind,
            });
        }
    }

    fn insert_node(&mut self, node: NodeView) {
        if self.nodes.len() >= MAX_NODES && !self.nodes.contains_key(&node.id) {
            self.truncated = true;
            return;
        }
        self.nodes.entry(node.id.clone()).or_insert(node);
    }

    /// File-scope walk: emit the requested path, its ancestor
    /// directory chain up to the workspace root, and, if the path is a
    /// symlink, classify its target. Directory targets are NOT walked
    /// here; we stay shallow so `scope=file` is cheap.
    fn walk_file(&mut self, rel: &str, abs: &Path, meta: &Metadata) {
        self.emit_ancestor_chain(rel);
        self.visit_entry(rel, abs, meta);
        if !rel.is_empty() {
            let parent_rel = parent_rel(rel);
            let parent_abs = abs
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| self.root.clone());
            if let Ok(parent_meta) = std::fs::symlink_metadata(&parent_abs) {
                self.visit_entry(&parent_rel, &parent_abs, &parent_meta);
                self.push_edge(parent_rel, rel.to_owned(), "contains");
            }
        }
    }

    /// Directory-scope walk: emit the directory node, then walk its
    /// children up to `depth` levels. Depth 1 = direct children
    /// only. Caller MUST have verified that `meta.is_dir()`; the
    /// route enforces this before invoking the walker.
    fn walk_directory(&mut self, rel: &str, abs: &Path, meta: &Metadata, depth: usize) {
        debug_assert!(meta.is_dir(), "walk_directory called on non-directory");
        self.emit_ancestor_chain(rel);
        self.visit_entry(rel, abs, meta);
        if meta.permissions().readonly() {
            return;
        }
        let mut visited_dirs: HashSet<(u64, u64)> = HashSet::new();
        if let Some(key) = inode_key(meta) {
            visited_dirs.insert(key);
        }
        self.walk_dir(rel, abs, depth, &mut visited_dirs);
    }

    /// Emit the root-to-leaf `contains` chain for a scoped file or
    /// directory before walking its local neighbourhood. The normal
    /// depth walk expands downward from the scope; this pass supplies
    /// the upstream filesystem spine so callers can always show how a
    /// scoped node attaches back to the workspace root.
    fn emit_ancestor_chain(&mut self, rel: &str) {
        let root_abs = self.root.clone();
        if let Ok(root_meta) = std::fs::symlink_metadata(&root_abs) {
            self.visit_entry("", &root_abs, &root_meta);
        }

        let parts: Vec<&str> = rel.split('/').filter(|part| !part.is_empty()).collect();
        let mut parent_rel = String::new();
        for idx in 0..parts.len() {
            let child_rel = parts[..=idx].join("/");
            let child_abs = self.root.join(&child_rel);
            if let Ok(child_meta) = std::fs::symlink_metadata(&child_abs) {
                self.visit_entry(&child_rel, &child_abs, &child_meta);
                self.push_edge(parent_rel.clone(), child_rel.clone(), "contains");
            }
            parent_rel = child_rel;
        }
    }

    fn walk_dir(
        &mut self,
        parent_rel: &str,
        parent_abs: &Path,
        depth_remaining: usize,
        visited_dirs: &mut HashSet<(u64, u64)>,
    ) {
        if depth_remaining == 0 || self.nodes.len() >= MAX_NODES {
            if depth_remaining > 0 {
                self.truncated = true;
            }
            return;
        }
        for (name, child_abs) in read_dir_sorted(parent_abs) {
            match self.emit_child(parent_rel, &name, &child_abs) {
                None | Some(ChildOutcome::Ghost) => {}
                Some(ChildOutcome::Emitted { rel, meta }) => {
                    if meta.is_dir()
                        && !meta.file_type().is_symlink()
                        && !meta.permissions().readonly()
                    {
                        if let Some(key) = inode_key(&meta) {
                            if !visited_dirs.insert(key) {
                                // Already walked this inode; skip to avoid
                                // double-counting on platforms that allow
                                // hardlinked dirs.
                                continue;
                            }
                        }
                        self.walk_dir(&rel, &child_abs, depth_remaining - 1, visited_dirs);
                    }
                }
            }
        }
    }

    /// Emit one directory child: skip the blocklist, emit a ghost on
    /// stat failure, else emit the node + the parent `contains` edge.
    /// Returns `None` for a skipped (blocklisted) entry, otherwise the
    /// `ChildOutcome` so the caller can decide on descent. The single
    /// source of per-child behaviour for both the recursive and paged
    /// walks, so the two stay byte-identical in their node/edge output.
    fn emit_child(
        &mut self,
        parent_rel: &str,
        name: &OsStr,
        child_abs: &Path,
    ) -> Option<ChildOutcome> {
        let name_str = name.to_string_lossy();
        // Skip workspace-internal state and the per-workspace blocklist
        // dirs at ANY depth. Mirrors chan-workspace's `walk_workspace`
        // (`.chan`/`.git` invariants) plus the `WalkFilter`
        // (`node_modules`, `target`, `venv`, ...) so the filesystem
        // graph excludes the same set the index, the File Browser spine,
        // and the watcher feed exclude. A repo-root workspace otherwise
        // plots its whole dependency tree (60K-131K nodes). The skip
        // applies regardless of file type so a `.git` symlink can't slip
        // a dependency tree back in.
        if name_str == ".chan" || name_str == ".git" || self.filter.is_excluded(&name_str) {
            return None;
        }
        let child_rel = if parent_rel.is_empty() {
            name_str.to_string()
        } else {
            format!("{parent_rel}/{name_str}")
        };
        let child_meta = match std::fs::symlink_metadata(child_abs) {
            Ok(m) => m,
            Err(_) => {
                let ghost = NodeView {
                    id: child_rel.clone(),
                    kind: "ghost",
                    name: name_str.to_string(),
                    path: child_rel.clone(),
                    size: 0,
                    path_class: None,
                    permission: None,
                    link_count: 1,
                    mtime: None,
                    target: None,
                    outside: false,
                    broken: true,
                    target_escapes_workspace: false,
                };
                self.insert_node(ghost);
                self.push_edge(parent_rel.to_owned(), child_rel, "contains");
                return Some(ChildOutcome::Ghost);
            }
        };
        self.visit_entry(&child_rel, child_abs, &child_meta);
        self.push_edge(parent_rel.to_owned(), child_rel.clone(), "contains");
        Some(ChildOutcome::Emitted {
            rel: child_rel,
            meta: child_meta,
        })
    }

    /// Bounded, resumable depth-scope walk. Emits at most `max_nodes`
    /// nodes / `max_bytes` of node payload this call, then returns the
    /// DFS stack to resume from (`None` = the walk is complete). On a
    /// fresh walk (`resume` is `None`) it first emits the upstream
    /// ancestor spine + the scope node; on resume it picks up mid-walk
    /// without re-emitting what earlier batches already sent.
    ///
    /// Termination does NOT rely on the recursive walk's inode
    /// visited-set (that state can't ride in a bounded cursor): the
    /// `find -d` depth budget caps total descent at `MAX_DEPTH` levels,
    /// so even a hardlinked-directory cycle stops at the depth bound.
    fn walk_directory_paged(
        &mut self,
        rel: &str,
        abs: &Path,
        meta: &Metadata,
        depth: usize,
        resume: Option<Vec<CursorFrame>>,
        budget: BatchBudget,
    ) -> Option<Vec<CursorFrame>> {
        debug_assert!(
            meta.is_dir(),
            "walk_directory_paged called on non-directory"
        );
        let mut stack: Vec<DirFrame> = Vec::new();
        match resume {
            None => {
                self.emit_ancestor_chain(rel);
                self.visit_entry(rel, abs, meta);
                if meta.permissions().readonly() || depth == 0 {
                    return None;
                }
                if let Some(frame) = self.open_dir_frame(rel, abs, depth) {
                    stack.push(frame);
                }
            }
            Some(frames) => {
                // Re-emit the ancestor spine down to the deepest in-progress
                // frame so THIS resume page is self-consistent. The page emits
                // `contains` edges for the resumed directories' children
                // (`parent_rel -> child`); without re-emitting the spine, those
                // parent directory nodes (and the chain up to the root) live
                // only on the page that first descended into them, so a resume
                // page carries parent-less edges. The DFS stack is a single
                // nested path, so its deepest frame's rel encodes every
                // ancestor -- `emit_ancestor_chain` re-emits each as a node plus
                // the `contains` edges between them. (Idempotent within the
                // whole walk: nodes/edges dedup, so the union still equals
                // `build_fs_graph`; this only makes each page self-describing,
                // matching the `None` branch's spine emission at `:985`.)
                if let Some(deepest) = frames.last() {
                    let deepest_rel = deepest.r.clone();
                    self.emit_ancestor_chain(&deepest_rel);
                }
                for cf in frames {
                    let dir_abs = self.root.join(&cf.r);
                    if let Some(mut frame) = self.open_dir_frame(&cf.r, &dir_abs, cf.l) {
                        frame.idx = cf.i.min(frame.entries.len());
                        stack.push(frame);
                    }
                }
            }
        }

        let mut emitted = 0usize;
        let mut bytes = 0usize;
        loop {
            // Drop frames we've finished so a budget break below always
            // leaves a frame with real pending work on top (no spurious
            // trailing empty batch), and an empty stack means done.
            while matches!(stack.last(), Some(f) if f.idx >= f.entries.len()) {
                stack.pop();
            }
            let Some(top) = stack.last_mut() else { break };
            if emitted >= budget.max_nodes || bytes >= budget.max_bytes {
                break;
            }
            let (name, child_abs) = top.entries[top.idx].clone();
            top.idx += 1;
            let parent_rel = top.rel.clone();
            let levels = top.levels;
            match self.emit_child(&parent_rel, &name, &child_abs) {
                None => {} // blocklisted: skipped, no budget spent
                Some(ChildOutcome::Ghost) => {
                    emitted += 1;
                    bytes += NODE_FIXED_BYTES;
                }
                Some(ChildOutcome::Emitted {
                    rel: child_rel,
                    meta,
                }) => {
                    emitted += 1;
                    bytes += node_byte_estimate(&child_rel);
                    // Descend only while depth budget remains; `levels >
                    // 1` is exactly `relative_depth + 1 <= depth`.
                    if levels > 1
                        && meta.is_dir()
                        && !meta.file_type().is_symlink()
                        && !meta.permissions().readonly()
                    {
                        if let Some(frame) = self.open_dir_frame(&child_rel, &child_abs, levels - 1)
                        {
                            stack.push(frame);
                        }
                    }
                }
            }
        }

        if stack.is_empty() {
            None
        } else {
            Some(
                stack
                    .iter()
                    .map(|f| CursorFrame {
                        r: f.rel.clone(),
                        i: f.idx,
                        l: f.levels,
                    })
                    .collect(),
            )
        }
    }

    /// Open a directory as a DFS frame: its sorted entries plus the
    /// `levels` budget. `None` when the directory can't be read (a
    /// transient stat/permission failure just ends that branch).
    fn open_dir_frame(&self, rel: &str, abs: &Path, levels: usize) -> Option<DirFrame> {
        Some(DirFrame {
            rel: rel.to_owned(),
            entries: read_dir_sorted(abs),
            idx: 0,
            levels,
        })
    }

    /// Emit a node for the path at `rel` with metadata `meta`. Records
    /// hardlink candidates so `finish()` can emit dedup edges.
    fn visit_entry(&mut self, rel: &str, abs: &Path, meta: &Metadata) {
        let ft = meta.file_type();
        let class = chan_workspace::fs_ops::classify_abs(&self.root, abs).ok();
        let kind = node_kind_from_class(class.as_ref(), &ft);

        let mut node = NodeView {
            id: rel.to_owned(),
            kind,
            name: basename_of(rel, abs),
            path: rel.to_owned(),
            size: if ft.is_file() { meta.len() } else { 0 },
            path_class: class.clone(),
            permission: class.as_ref().map(|c| c.permission),
            link_count: class.as_ref().map(|c| c.link_count).unwrap_or(1),
            mtime: mtime_of(meta),
            target: None,
            outside: false,
            broken: false,
            target_escapes_workspace: class
                .as_ref()
                .map(|c| c.target_escapes_workspace)
                .unwrap_or(false),
        };

        if ft.is_symlink() {
            match std::fs::read_link(abs) {
                Ok(target) => {
                    node.target = Some(target.to_string_lossy().into_owned());
                    self.insert_node(node);
                    self.emit_symlink_target(rel, abs, &target);
                    return;
                }
                Err(_) => {
                    node.broken = true;
                    self.insert_node(node);
                    return;
                }
            }
        }

        if ft.is_file() {
            if let Some(key) = inode_key(meta) {
                if nlink_of(meta) > 1 {
                    self.inode_paths
                        .entry(key)
                        .or_default()
                        .push(rel.to_owned());
                }
            }
        }

        self.insert_node(node);
    }

    /// Classify a symlink target and emit the corresponding node +
    /// `symlink` edge. Targets are NEVER traversed; we only stat them
    /// to decide whether they exist, and emit one classification node.
    fn emit_symlink_target(&mut self, src_rel: &str, src_abs: &Path, target: &Path) {
        let target_abs: PathBuf = if target.is_absolute() {
            target.to_path_buf()
        } else {
            let parent = src_abs.parent().unwrap_or(&self.root);
            parent.join(target)
        };

        if !self.target_is_inside_workspace(&target_abs) {
            let ghost_id = format!("outside:{src_rel}");
            let ghost = NodeView {
                id: ghost_id.clone(),
                kind: "ghost",
                name: target.to_string_lossy().into_owned(),
                path: String::new(),
                size: 0,
                path_class: None,
                permission: None,
                link_count: 1,
                mtime: None,
                target: Some(target.to_string_lossy().into_owned()),
                outside: true,
                broken: false,
                target_escapes_workspace: false,
            };
            self.insert_node(ghost);
            self.push_edge(src_rel.to_owned(), ghost_id, "symlink");
            return;
        }

        let target_rel = match self.workspace_relative_target(&target_abs) {
            Some(s) => s,
            None => {
                // Could not pin the relative form. Treat as broken
                // rather than outside-workspace: the lexical check above
                // already ruled out escape, so the most useful signal
                // is "we can't find it".
                let ghost_id = format!("broken:{src_rel}");
                let ghost = NodeView {
                    id: ghost_id.clone(),
                    kind: "ghost",
                    name: target.to_string_lossy().into_owned(),
                    path: String::new(),
                    size: 0,
                    path_class: None,
                    permission: None,
                    link_count: 1,
                    mtime: None,
                    target: Some(target.to_string_lossy().into_owned()),
                    outside: false,
                    broken: true,
                    target_escapes_workspace: false,
                };
                self.insert_node(ghost);
                self.push_edge(src_rel.to_owned(), ghost_id, "symlink");
                return;
            }
        };

        let target_abs_in_root = self.root.join(&target_rel);
        match std::fs::symlink_metadata(&target_abs_in_root) {
            Ok(target_meta) => {
                // Emit a node for the target. We deliberately do NOT
                // recurse into `visit_entry` here: a chain
                // `a -> b -> a` would otherwise re-enter
                // `emit_symlink_target` for `b` and loop. The walker
                // will reach the actual target through its own
                // parent-`contains` descent and classify it fully
                // there; from a symlink's perspective we only need
                // the immediate target node + the edge.
                self.insert_target_node(&target_rel, &target_abs_in_root, &target_meta);
                self.push_edge(src_rel.to_owned(), target_rel, "symlink");
            }
            Err(_) => {
                let ghost = NodeView {
                    id: target_rel.clone(),
                    kind: "ghost",
                    name: target_rel
                        .rsplit('/')
                        .next()
                        .unwrap_or(&target_rel)
                        .to_owned(),
                    path: target_rel.clone(),
                    size: 0,
                    path_class: None,
                    permission: None,
                    link_count: 1,
                    mtime: None,
                    target: Some(target.to_string_lossy().into_owned()),
                    outside: false,
                    broken: true,
                    target_escapes_workspace: false,
                };
                self.insert_node(ghost);
                self.push_edge(src_rel.to_owned(), target_rel, "symlink");
            }
        }
    }

    /// Insert a node for a symlink's resolved target without
    /// recursing through its symlink chain. Mirrors the node shape
    /// `visit_entry` produces but stops at the target itself; if the
    /// target is also a symlink, we leave full classification to
    /// whatever later visit reaches it as a parent-`contains` child
    /// (or to a direct file-scope query against that path).
    fn insert_target_node(&mut self, rel: &str, abs: &Path, meta: &Metadata) {
        if self.nodes.contains_key(rel) {
            return;
        }
        let ft = meta.file_type();
        let class = chan_workspace::fs_ops::classify_abs(&self.root, abs).ok();
        let kind = node_kind_from_class(class.as_ref(), &ft);
        let target_readlink = if ft.is_symlink() {
            std::fs::read_link(abs)
                .ok()
                .map(|t| t.to_string_lossy().into_owned())
        } else {
            None
        };
        let node = NodeView {
            id: rel.to_owned(),
            kind,
            name: basename_of(rel, abs),
            path: rel.to_owned(),
            size: if ft.is_file() { meta.len() } else { 0 },
            path_class: class.clone(),
            permission: class.as_ref().map(|c| c.permission),
            link_count: class.as_ref().map(|c| c.link_count).unwrap_or(1),
            mtime: mtime_of(meta),
            target: target_readlink,
            outside: false,
            broken: false,
            target_escapes_workspace: class
                .as_ref()
                .map(|c| c.target_escapes_workspace)
                .unwrap_or(false),
        };
        self.insert_node(node);
    }

    fn target_is_inside_workspace(&self, target_abs: &Path) -> bool {
        // Canonicalize the deepest existing ancestor of `target_abs`
        // (`canonicalize` fails on missing leaves; we mirror what the
        // kernel will do on `open`). Compare against the canonical
        // root when available.
        let mut probe: &Path = target_abs;
        let canon_target = loop {
            match probe.canonicalize() {
                Ok(c) => break Some(c),
                Err(_) => match probe.parent() {
                    Some(p) => probe = p,
                    None => break None,
                },
            }
        };

        match (&self.root_canon, canon_target) {
            (Some(root_canon), Some(t)) => t.starts_with(root_canon),
            // Fall back to a conservative lexical check. This keeps
            // missing in-workspace targets visible as ghosts when the root
            // cannot be canonicalized, while refusing paths that only
            // appear under the root because they contain `..`.
            _ => lexical_path_inside_root(target_abs, &self.root),
        }
    }

    fn workspace_relative_target(&self, target_abs: &Path) -> Option<String> {
        if let Some(root_canon) = &self.root_canon {
            if let Ok(canon_target) = target_abs.canonicalize() {
                if let Ok(stripped) = canon_target.strip_prefix(root_canon) {
                    return Some(posix_rel(stripped));
                }
            }
        }
        target_abs.strip_prefix(&self.root).ok().map(posix_rel)
    }
}

fn lexical_path_inside_root(path: &Path, root: &Path) -> bool {
    let Ok(stripped) = path.strip_prefix(root) else {
        return false;
    };
    stripped
        .components()
        .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

fn posix_rel(stripped: &Path) -> String {
    let mut out = String::new();
    for (i, c) in stripped.components().enumerate() {
        if let Component::Normal(s) = c {
            if i > 0 {
                out.push('/');
            }
            out.push_str(&s.to_string_lossy());
        }
    }
    out
}

fn parent_rel(rel: &str) -> String {
    match rel.rsplit_once('/') {
        Some((parent, _)) => parent.to_owned(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    use tempfile::TempDir;

    fn write(p: &Path, body: &str) {
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, body).unwrap();
    }

    fn walk(root: &Path, scope: FsGraphScope, rel: &str, depth: usize) -> FsGraphResponse {
        walk_with_filter(
            root,
            scope,
            rel,
            depth,
            chan_workspace::fs_ops::WalkFilter::default(),
        )
    }

    fn walk_with_filter(
        root: &Path,
        scope: FsGraphScope,
        rel: &str,
        depth: usize,
        filter: chan_workspace::fs_ops::WalkFilter,
    ) -> FsGraphResponse {
        let mut walker = FsGraphWalker::new(root.to_path_buf(), filter);
        let abs = if rel.is_empty() {
            root.to_path_buf()
        } else {
            root.join(rel)
        };
        let meta = std::fs::symlink_metadata(&abs).expect("stat scope");
        match scope {
            FsGraphScope::Directory => walker.walk_directory(rel, &abs, &meta, depth),
            FsGraphScope::File => walker.walk_file(rel, &abs, &meta),
        }
        let (nodes, edges, truncated) = walker.finish();
        FsGraphResponse {
            root: root.display().to_string(),
            scope: scope.label(),
            path: rel.to_owned(),
            depth: match scope {
                FsGraphScope::File => 0,
                FsGraphScope::Directory => depth,
            },
            nodes,
            edges,
            truncated,
            cursor: None,
            done: true,
        }
    }

    fn node_kind<'a>(resp: &'a FsGraphResponse, id: &str) -> Option<&'a str> {
        resp.nodes.iter().find(|n| n.id == id).map(|n| n.kind)
    }

    #[cfg(unix)]
    fn node<'a>(resp: &'a FsGraphResponse, id: &str) -> Option<&'a NodeView> {
        resp.nodes.iter().find(|n| n.id == id)
    }

    #[cfg(unix)]
    fn node_path_kind(resp: &FsGraphResponse, id: &str) -> Option<chan_workspace::PathKind> {
        node(resp, id).and_then(|n| n.path_class.as_ref().map(|class| class.kind))
    }

    fn has_edge(resp: &FsGraphResponse, src: &str, dst: &str, kind: &str) -> bool {
        resp.edges
            .iter()
            .any(|e| e.source == src && e.target == dst && e.kind == kind)
    }

    #[test]
    fn lexical_fallback_rejects_parent_escape() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("missing-root");
        assert!(lexical_path_inside_root(
            &root.join("notes/missing.md"),
            &root
        ));
        assert!(!lexical_path_inside_root(
            &root.join("../outside.md"),
            &root
        ));
    }

    #[test]
    fn directory_scope_depth_one_lists_direct_children() {
        let tmp = TempDir::new().unwrap();
        write(&tmp.path().join("top.md"), "# top");
        write(&tmp.path().join("sub/nested.md"), "# n");
        write(&tmp.path().join("sub/deep/deep.md"), "# d");

        let resp = walk(tmp.path(), FsGraphScope::Directory, "", 1);
        assert_eq!(node_kind(&resp, "top.md"), Some("file"));
        assert_eq!(node_kind(&resp, "sub"), Some("directory"));
        // Depth=1 must NOT enumerate sub's contents.
        assert!(
            node_kind(&resp, "sub/nested.md").is_none(),
            "depth=1 leaked grandchildren: {:?}",
            resp.nodes.iter().map(|n| &n.id).collect::<Vec<_>>()
        );
        assert!(has_edge(&resp, "", "top.md", "contains"));
        assert!(has_edge(&resp, "", "sub", "contains"));
    }

    #[test]
    fn walk_filter_excludes_blocklisted_dirs_at_any_depth() {
        let tmp = TempDir::new().unwrap();
        write(&tmp.path().join("real.md"), "# real");
        write(&tmp.path().join("notes/today.md"), "# today");
        // Dependency-tree noise the graph must never plot.
        write(&tmp.path().join("node_modules/pkg/index.js"), "x");
        write(&tmp.path().join("target/debug/build.rs"), "x");
        write(&tmp.path().join(".venv/lib/site.py"), "x");
        // Nested blocklist dir below a real dir (any depth).
        write(&tmp.path().join("notes/node_modules/dep/a.js"), "x");

        let filter = chan_workspace::fs_ops::WalkFilter::new([
            "node_modules".to_string(),
            "target".to_string(),
            ".venv".to_string(),
        ]);
        let resp = walk_with_filter(tmp.path(), FsGraphScope::Directory, "", 6, filter);

        // Real content present.
        assert_eq!(node_kind(&resp, "real.md"), Some("file"));
        assert_eq!(node_kind(&resp, "notes"), Some("directory"));
        assert_eq!(node_kind(&resp, "notes/today.md"), Some("file"));

        // Blocklisted dirs and everything under them are absent, at
        // top level and nested.
        for absent in [
            "node_modules",
            "node_modules/pkg",
            "node_modules/pkg/index.js",
            "target",
            "target/debug",
            "target/debug/build.rs",
            ".venv",
            ".venv/lib/site.py",
            "notes/node_modules",
            "notes/node_modules/dep/a.js",
        ] {
            assert!(
                node_kind(&resp, absent).is_none(),
                "blocklisted path leaked into fs-graph: {absent}; nodes={:?}",
                resp.nodes.iter().map(|n| &n.id).collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn directory_scope_deeper_includes_grandchildren() {
        let tmp = TempDir::new().unwrap();
        write(&tmp.path().join("sub/nested.md"), "# n");
        write(&tmp.path().join("sub/deep/deep.md"), "# d");

        let resp = walk(tmp.path(), FsGraphScope::Directory, "sub", 2);
        assert_eq!(node_kind(&resp, "sub/nested.md"), Some("file"));
        assert_eq!(node_kind(&resp, "sub/deep"), Some("directory"));
        assert_eq!(node_kind(&resp, "sub/deep/deep.md"), Some("file"));
    }

    #[cfg(unix)]
    #[test]
    fn read_only_directory_is_a_dead_end() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new().unwrap();
        write(&tmp.path().join("locked/hidden.md"), "# hidden");
        fs::set_permissions(tmp.path().join("locked"), fs::Permissions::from_mode(0o555)).unwrap();

        let resp = walk(tmp.path(), FsGraphScope::Directory, "", 2);
        let locked = node(&resp, "locked").expect("locked directory node");
        assert_eq!(locked.kind, "directory");
        assert_eq!(
            locked.permission,
            Some(chan_workspace::PathPermission::ReadOnly)
        );
        assert!(
            node_kind(&resp, "locked/hidden.md").is_none(),
            "read-only directory should not be expanded"
        );
    }

    #[test]
    fn workspace_internal_dirs_are_hidden() {
        let tmp = TempDir::new().unwrap();
        write(&tmp.path().join("top.md"), "# t");
        write(&tmp.path().join(".chan/lock"), "x");
        write(&tmp.path().join(".git/HEAD"), "x");

        let resp = walk(tmp.path(), FsGraphScope::Directory, "", 2);
        assert!(node_kind(&resp, ".chan").is_none(), "saw .chan node");
        assert!(node_kind(&resp, ".git").is_none(), "saw .git node");
        assert_eq!(node_kind(&resp, "top.md"), Some("file"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_in_workspace_target_existing() {
        let tmp = TempDir::new().unwrap();
        write(&tmp.path().join("top.md"), "# t");
        symlink("top.md", tmp.path().join("alias.md")).unwrap();

        let resp = walk(tmp.path(), FsGraphScope::Directory, "", 1);
        assert_eq!(node_kind(&resp, "alias.md"), Some("symlink"));
        assert_eq!(
            node_path_kind(&resp, "alias.md"),
            Some(chan_workspace::PathKind::Symlink)
        );
        assert_eq!(node_kind(&resp, "top.md"), Some("file"));
        assert!(
            has_edge(&resp, "alias.md", "top.md", "symlink"),
            "missing in-workspace symlink edge: {:?}",
            resp.edges
                .iter()
                .map(|e| (&e.source, &e.target, e.kind))
                .collect::<Vec<_>>()
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_broken_emits_ghost() {
        let tmp = TempDir::new().unwrap();
        symlink("does-not-exist.md", tmp.path().join("broken.md")).unwrap();

        let resp = walk(tmp.path(), FsGraphScope::Directory, "", 1);
        assert_eq!(node_kind(&resp, "broken.md"), Some("symlink"));
        let ghost = resp
            .nodes
            .iter()
            .find(|n| n.id == "does-not-exist.md")
            .expect("missing ghost node");
        assert_eq!(ghost.kind, "ghost");
        assert!(ghost.broken);
        assert!(has_edge(&resp, "broken.md", "does-not-exist.md", "symlink"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_outside_workspace_emits_outside_ghost() {
        let tmp = TempDir::new().unwrap();
        symlink("/etc/hosts", tmp.path().join("escape.md")).unwrap();

        let resp = walk(tmp.path(), FsGraphScope::Directory, "", 1);
        assert_eq!(node_kind(&resp, "escape.md"), Some("symlink"));
        assert_eq!(
            node_path_kind(&resp, "escape.md"),
            Some(chan_workspace::PathKind::Symlink)
        );
        let ghost = resp
            .nodes
            .iter()
            .find(|n| n.id == "outside:escape.md")
            .expect("missing outside ghost");
        assert_eq!(ghost.kind, "ghost");
        assert!(ghost.outside);
        assert!(!ghost.broken);
        assert!(has_edge(&resp, "escape.md", "outside:escape.md", "symlink"));
    }

    #[cfg(unix)]
    #[test]
    fn fifo_and_socket_surface_as_ghost_with_path_class() {
        use std::os::unix::net::UnixListener;

        let tmp = TempDir::new().unwrap();
        let fifo_path = tmp.path().join("pipe.fifo");
        // Shell out to `mkfifo` rather than pulling in libc just for
        // this test. On every platform the build supports the binary
        // is in PATH; if it's missing we skip the assertion so test
        // runs on minimal containers stay green.
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo_path)
            .status();
        match status {
            Ok(s) if s.success() => {}
            _ => return,
        }
        let _listener = UnixListener::bind(tmp.path().join("sock")).unwrap();

        let resp = walk(tmp.path(), FsGraphScope::Directory, "", 1);
        assert_eq!(
            node_kind(&resp, "pipe.fifo"),
            Some("ghost"),
            "FIFO must surface as a ghost, not be silently dropped"
        );
        assert_eq!(
            node_path_kind(&resp, "pipe.fifo"),
            Some(chan_workspace::PathKind::Fifo)
        );
        assert_eq!(
            node_kind(&resp, "sock"),
            Some("ghost"),
            "socket must surface as a ghost, not be silently dropped"
        );
        assert_eq!(
            node_path_kind(&resp, "sock"),
            Some(chan_workspace::PathKind::Socket)
        );
    }

    #[cfg(unix)]
    #[test]
    fn hardlink_emits_hardlink_edge() {
        use std::fs::hard_link;
        let tmp = TempDir::new().unwrap();
        write(&tmp.path().join("top.md"), "# t");
        hard_link(tmp.path().join("top.md"), tmp.path().join("twin.md")).unwrap();

        let resp = walk(tmp.path(), FsGraphScope::Directory, "", 1);
        assert_eq!(node_kind(&resp, "top.md"), Some("file"));
        assert_eq!(node_kind(&resp, "twin.md"), Some("file"));
        // Sorted lexicographically: "top.md" < "twin.md".
        assert!(
            has_edge(&resp, "top.md", "twin.md", "hardlink"),
            "missing hardlink edge: {:?}",
            resp.edges
                .iter()
                .map(|e| (&e.source, &e.target, e.kind))
                .collect::<Vec<_>>()
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_loop_terminates() {
        // a -> b -> a. The walker must terminate (we never traverse
        // symlinks during the directory walk; we only classify their
        // targets) and emit both as symlink nodes pointing at each
        // other.
        let tmp = TempDir::new().unwrap();
        symlink("b.md", tmp.path().join("a.md")).unwrap();
        symlink("a.md", tmp.path().join("b.md")).unwrap();

        let resp = walk(tmp.path(), FsGraphScope::Directory, "", 1);
        assert_eq!(node_kind(&resp, "a.md"), Some("symlink"));
        assert_eq!(node_kind(&resp, "b.md"), Some("symlink"));
        assert!(has_edge(&resp, "a.md", "b.md", "symlink"));
        assert!(has_edge(&resp, "b.md", "a.md", "symlink"));
    }

    #[test]
    fn file_scope_emits_parent_contains_edge() {
        let tmp = TempDir::new().unwrap();
        write(&tmp.path().join("sub/nested.md"), "# n");

        let resp = walk(tmp.path(), FsGraphScope::File, "sub/nested.md", 0);
        assert_eq!(node_kind(&resp, ""), Some("directory"));
        assert_eq!(node_kind(&resp, "sub/nested.md"), Some("file"));
        assert_eq!(node_kind(&resp, "sub"), Some("directory"));
        assert!(has_edge(&resp, "", "sub", "contains"));
        assert!(has_edge(&resp, "sub", "sub/nested.md", "contains"));
    }

    #[test]
    fn file_scope_emits_full_ancestor_chain() {
        let tmp = TempDir::new().unwrap();
        write(&tmp.path().join("a/b/c/deep.md"), "# deep");

        let resp = walk(tmp.path(), FsGraphScope::File, "a/b/c/deep.md", 0);
        assert_eq!(node_kind(&resp, ""), Some("directory"));
        assert_eq!(node_kind(&resp, "a"), Some("directory"));
        assert_eq!(node_kind(&resp, "a/b"), Some("directory"));
        assert_eq!(node_kind(&resp, "a/b/c"), Some("directory"));
        assert_eq!(node_kind(&resp, "a/b/c/deep.md"), Some("file"));
        assert!(has_edge(&resp, "", "a", "contains"));
        assert!(has_edge(&resp, "a", "a/b", "contains"));
        assert!(has_edge(&resp, "a/b", "a/b/c", "contains"));
        assert!(has_edge(&resp, "a/b/c", "a/b/c/deep.md", "contains"));
    }

    #[test]
    fn directory_scope_emits_full_ancestor_chain() {
        let tmp = TempDir::new().unwrap();
        write(&tmp.path().join("a/b/c/deep.md"), "# deep");

        let resp = walk(tmp.path(), FsGraphScope::Directory, "a/b/c", 1);
        assert_eq!(node_kind(&resp, ""), Some("directory"));
        assert_eq!(node_kind(&resp, "a"), Some("directory"));
        assert_eq!(node_kind(&resp, "a/b"), Some("directory"));
        assert_eq!(node_kind(&resp, "a/b/c"), Some("directory"));
        assert!(has_edge(&resp, "", "a", "contains"));
        assert!(has_edge(&resp, "a", "a/b", "contains"));
        assert!(has_edge(&resp, "a/b", "a/b/c", "contains"));
    }

    #[test]
    fn normalize_rel_strips_leading_slash_and_dot() {
        assert_eq!(normalize_rel(""), "");
        assert_eq!(normalize_rel("/"), "");
        assert_eq!(normalize_rel("."), "");
        assert_eq!(normalize_rel("/notes/a.md"), "notes/a.md");
        assert_eq!(normalize_rel("notes/./a.md"), "notes/a.md");
    }

    /// Workspace-bootstrapped tests for the public `build_fs_graph` entry
    /// point -- the filesystem graph endpoint and its direct callers use
    /// this directly, so its rejection contract needs explicit
    /// coverage in addition to the walker-only tests above.
    fn open_workspace() -> (TempDir, TempDir, std::sync::Arc<chan_workspace::Workspace>) {
        let cfg = TempDir::new().unwrap();
        let workspace_root = TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_root.path()).unwrap();
        let workspace = lib.open_workspace(workspace_root.path()).unwrap();
        workspace.write_text("notes/a.md", "# a\n").unwrap();
        (cfg, workspace_root, workspace)
    }

    #[test]
    fn build_fs_graph_rejects_escape_path() {
        let (_cfg, _root, workspace) = open_workspace();
        let err = build_fs_graph(&workspace, FsGraphScope::Directory, "../etc", 1).unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert!(
            err.message.contains("escape"),
            "expected escape rejection, got: {}",
            err.message
        );
    }

    #[test]
    fn build_fs_graph_rejects_missing_path() {
        let (_cfg, _root, workspace) = open_workspace();
        let err =
            build_fs_graph(&workspace, FsGraphScope::File, "notes/no-such-file.md", 1).unwrap_err();
        assert_eq!(err.status, StatusCode::NOT_FOUND);
        assert!(
            err.message.contains("no such path"),
            "expected missing-path rejection, got: {}",
            err.message
        );
    }

    #[test]
    fn build_fs_graph_rejects_directory_scope_on_file() {
        let (_cfg, _root, workspace) = open_workspace();
        let err = build_fs_graph(&workspace, FsGraphScope::Directory, "notes/a.md", 1).unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert!(
            err.message.contains("requires a directory"),
            "expected directory-required rejection, got: {}",
            err.message
        );
    }

    #[cfg(unix)]
    #[test]
    fn build_fs_graph_rejects_mid_path_symlink_escape() {
        // syseng's design-snapshot flagged this: an in-workspace symlink
        // pointing OUTSIDE the workspace root used to be silently
        // followed when it appeared as a mid-path component, because
        // `resolve_safe` is lexical only. A request like
        // `path=alias/inside.md` (alias -> /etc) leaked /etc/inside.md
        // metadata under a workspace-relative id. ensure_parent_inside_workspace
        // closes that.
        let (_cfg, root, workspace) = open_workspace();
        // Build a symlink whose target is OUTSIDE the workspace root,
        // pointing at a directory that definitely exists on every
        // posix system.
        symlink("/etc", root.path().join("escape-link")).unwrap();

        // Directory scope through the escape link: hostnames dir on
        // macOS, hosts dir on Linux. Pick a path that's almost
        // certainly present.
        let err =
            build_fs_graph(&workspace, FsGraphScope::Directory, "escape-link/ssl", 1).unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert!(
            err.message.contains("escapes workspace root"),
            "expected mid-path escape rejection, got: {}",
            err.message
        );

        // File scope through the escape link: any single file under
        // /etc. `hosts` is the canonical pick.
        let err =
            build_fs_graph(&workspace, FsGraphScope::File, "escape-link/hosts", 1).unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert!(
            err.message.contains("escapes workspace root"),
            "expected mid-path escape rejection, got: {}",
            err.message
        );
    }

    #[cfg(unix)]
    #[test]
    fn build_fs_graph_allows_in_workspace_symlink_leaf_to_outside() {
        // The mid-path guard must NOT reject when the LEAF itself is
        // an in-workspace symlink pointing outside the workspace. The walker
        // classifies that leaf via readlink and emits an outside-
        // ghost node -- that's the documented behavior, and it's the
        // whole point of having a graph route over filesystems with
        // symlinks.
        let (_cfg, root, workspace) = open_workspace();
        symlink("/etc/hosts", root.path().join("alias-outside.md")).unwrap();

        let resp = build_fs_graph(&workspace, FsGraphScope::File, "alias-outside.md", 0)
            .expect("in-workspace symlink leaf must be accepted");
        // Expect the symlink node + an outside ghost target.
        assert!(
            resp.nodes
                .iter()
                .any(|n| n.id == "alias-outside.md" && n.kind == "symlink"),
            "missing symlink node: {:?}",
            resp.nodes.iter().map(|n| &n.id).collect::<Vec<_>>()
        );
        assert!(
            resp.nodes
                .iter()
                .any(|n| n.id == "outside:alias-outside.md" && n.outside),
            "missing outside-workspace ghost node: {:?}",
            resp.nodes.iter().map(|n| &n.id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn build_fs_graph_root_scope_returns_workspace_root() {
        let (_cfg, _root, workspace) = open_workspace();
        let resp = build_fs_graph(&workspace, FsGraphScope::Directory, "", 1).unwrap();
        assert_eq!(resp.scope, "directory");
        assert_eq!(resp.path, "");
        // Workspace root is keyed by the empty string; depth 1 lists the
        // top-level `notes/` directory.
        assert!(
            resp.nodes
                .iter()
                .any(|n| n.id.is_empty() && n.kind == "directory"),
            "workspace root node missing from response"
        );
        assert!(
            resp.nodes
                .iter()
                .any(|n| n.id == "notes" && n.kind == "directory"),
            "notes/ should be a direct child at depth 1"
        );
    }

    // ---- Paced / paged delivery ----------------------------------------

    fn seed_paged_workspace() -> (TempDir, TempDir, std::sync::Arc<chan_workspace::Workspace>) {
        let cfg = TempDir::new().unwrap();
        let workspace_root = TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_root.path()).unwrap();
        let ws = lib.open_workspace(workspace_root.path()).unwrap();
        // A small multi-level tree: enough nodes to force several
        // batches at a tiny batch size.
        for i in 0..6 {
            ws.write_text(&format!("top{i}.md"), "# t\n").unwrap();
        }
        for d in 0..3 {
            for i in 0..4 {
                ws.write_text(&format!("dir{d}/file{i}.md"), "# f\n")
                    .unwrap();
            }
            ws.write_text(&format!("dir{d}/sub/deep{d}.md"), "# d\n")
                .unwrap();
        }
        (cfg, workspace_root, ws)
    }

    type EdgeSet = std::collections::BTreeSet<(String, String, String)>;

    fn collect_paged(
        ws: &chan_workspace::Workspace,
        path: &str,
        depth: usize,
        batch: usize,
    ) -> (std::collections::BTreeSet<String>, EdgeSet, usize) {
        let mut node_ids = std::collections::BTreeSet::new();
        let mut edges: EdgeSet = std::collections::BTreeSet::new();
        let mut cursor: Option<String> = None;
        let mut batches = 0usize;
        loop {
            let resp = build_fs_graph_paged(
                ws,
                &FsGraphParams {
                    scope: FsGraphScope::Directory,
                    path: path.to_string(),
                    depth,
                    cursor: cursor.clone(),
                    limit: Some(batch),
                },
            )
            .expect("paged batch");
            batches += 1;
            for n in &resp.nodes {
                node_ids.insert(n.id.clone());
            }
            for e in &resp.edges {
                edges.insert((e.source.clone(), e.target.clone(), e.kind.to_string()));
            }
            if resp.done {
                assert!(resp.cursor.is_none(), "done batch must carry no cursor");
                break;
            }
            cursor = resp.cursor.clone();
            assert!(cursor.is_some(), "non-final batch must carry a cursor");
            assert!(batches < 10_000, "paged walk failed to terminate");
        }
        (node_ids, edges, batches)
    }

    fn whole_sets(
        ws: &chan_workspace::Workspace,
        path: &str,
        depth: usize,
    ) -> (std::collections::BTreeSet<String>, EdgeSet) {
        let resp = build_fs_graph(ws, FsGraphScope::Directory, path, depth).unwrap();
        let nodes = resp.nodes.iter().map(|n| n.id.clone()).collect();
        let edges = resp
            .edges
            .iter()
            .map(|e| (e.source.clone(), e.target.clone(), e.kind.to_string()))
            .collect();
        (nodes, edges)
    }

    #[test]
    fn cursor_round_trips_through_base64() {
        let c = FsCursor {
            p: "dir0/sub".to_string(),
            d: 3,
            s: vec![
                CursorFrame {
                    r: "dir0".into(),
                    i: 2,
                    l: 3,
                },
                CursorFrame {
                    r: "dir0/sub".into(),
                    i: 0,
                    l: 2,
                },
            ],
        };
        let decoded = decode_cursor(&encode_cursor(&c)).expect("decodes");
        assert_eq!(decoded.p, c.p);
        assert_eq!(decoded.d, c.d);
        assert_eq!(decoded.s.len(), 2);
        assert_eq!(decoded.s[0].r, "dir0");
        assert_eq!(decoded.s[1].i, 0);
        assert!(decode_cursor("!!!not base64!!!").is_none());
    }

    #[test]
    fn paged_walk_reassembles_to_the_whole_walk() {
        let (_cfg, _root, ws) = seed_paged_workspace();
        for depth in [1usize, 2, 6] {
            let (pn, pe, batches) = collect_paged(&ws, "", depth, 4);
            let (wn, we) = whole_sets(&ws, "", depth);
            assert_eq!(pn, wn, "node set mismatch at depth {depth}");
            assert_eq!(pe, we, "edge set mismatch at depth {depth}");
            // The tree is bigger than one batch at depth>=2, so paging
            // actually split it (proves we exercised >1 batch).
            if depth >= 2 {
                assert!(batches > 1, "depth {depth} should need multiple batches");
            }
        }
    }

    #[test]
    fn every_paged_batch_is_self_describing() {
        // Each page must be a valid subgraph on its own: every `contains`
        // edge's parent (source) directory is a node IN THE SAME page. Before
        // the resume branch re-emitted the ancestor spine, resume pages whose
        // walk was mid-way down a directory (e.g. inside `dir0/sub`) carried
        // edges like `dir0/sub -> deep.md` with no `dir0/sub` node -- masked
        // only by the client's cumulative merge. The whole-tree walk at a tiny
        // batch forces several resume pages with deep in-progress frames.
        let (_cfg, _root, ws) = seed_paged_workspace();
        let mut cursor: Option<String> = None;
        let mut pages = 0usize;
        let mut resume_pages = 0usize;
        loop {
            let resp = build_fs_graph_paged(
                &ws,
                &FsGraphParams {
                    scope: FsGraphScope::Directory,
                    path: String::new(),
                    depth: 6,
                    cursor: cursor.clone(),
                    limit: Some(2),
                },
            )
            .expect("paged batch");
            pages += 1;
            if cursor.is_some() {
                resume_pages += 1;
            }
            let ids: std::collections::BTreeSet<&str> =
                resp.nodes.iter().map(|n| n.id.as_str()).collect();
            for e in &resp.edges {
                if e.kind == "contains" {
                    assert!(
                        ids.contains(e.source.as_str()),
                        "page {pages} has a parent-less contains edge: {} -> {} \
                         (source not a node in this page)",
                        e.source,
                        e.target,
                    );
                }
            }
            if resp.done {
                break;
            }
            cursor = resp.cursor.clone();
            assert!(pages < 10_000, "paged walk failed to terminate");
        }
        assert!(
            resume_pages > 0,
            "the walk must exercise resume pages (the branch under test)"
        );
    }

    #[test]
    fn paged_batches_respect_the_node_budget() {
        let (_cfg, _root, ws) = seed_paged_workspace();
        // Request the floor batch size (a smaller `limit` clamps up to
        // `BATCH_MIN_NODES`, so assert against the effective budget).
        let batch = BATCH_MIN_NODES;
        let mut cursor: Option<String> = None;
        loop {
            let resp = build_fs_graph_paged(
                &ws,
                &FsGraphParams {
                    scope: FsGraphScope::Directory,
                    path: String::new(),
                    depth: 6,
                    cursor: cursor.clone(),
                    limit: Some(batch),
                },
            )
            .unwrap();
            // Bounded by the budget plus the once-only root + ancestor
            // spine (<= 2 for a root-scope walk).
            assert!(
                resp.nodes.len() <= batch + 2,
                "batch overran budget: {} nodes",
                resp.nodes.len()
            );
            if resp.done {
                break;
            }
            cursor = resp.cursor.clone();
        }
    }

    #[test]
    fn paged_cursor_is_idempotent() {
        let (_cfg, _root, ws) = seed_paged_workspace();
        let page = |cursor: Option<String>| FsGraphParams {
            scope: FsGraphScope::Directory,
            path: String::new(),
            depth: 6,
            cursor,
            limit: Some(4),
        };
        let first = build_fs_graph_paged(&ws, &page(None)).unwrap();
        let cursor = first.cursor.expect("first batch has more");
        let a = build_fs_graph_paged(&ws, &page(Some(cursor.clone()))).unwrap();
        let b = build_fs_graph_paged(&ws, &page(Some(cursor.clone()))).unwrap();
        let ids = |r: &FsGraphResponse| r.nodes.iter().map(|n| n.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(&a), ids(&b), "same cursor produced different batches");
        assert_eq!(a.cursor, b.cursor);
    }

    #[test]
    fn paged_cursor_bound_to_scope_and_depth() {
        let (_cfg, _root, ws) = seed_paged_workspace();
        let page = |depth: usize, cursor: Option<String>| FsGraphParams {
            scope: FsGraphScope::Directory,
            path: String::new(),
            depth,
            cursor,
            limit: Some(4),
        };
        let first = build_fs_graph_paged(&ws, &page(2, None)).unwrap();
        let cursor = first.cursor.expect("more batches");
        // Same cursor, different depth -> rejected (new walk).
        let err = build_fs_graph_paged(&ws, &page(3, Some(cursor.clone()))).unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert!(
            err.message.contains("does not match"),
            "got: {}",
            err.message
        );
        // Garbage cursor -> rejected.
        let err = build_fs_graph_paged(&ws, &page(2, Some("@@nope@@".to_string()))).unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert!(
            err.message.contains("invalid graph cursor"),
            "got: {}",
            err.message
        );
    }

    #[test]
    fn single_dir_expand_returns_direct_children_only() {
        let (_cfg, _root, ws) = seed_paged_workspace();
        let (nodes, edges, _batches) = collect_paged(&ws, "dir0", 1, 4);
        assert!(nodes.contains("dir0/file0.md"), "direct file missing");
        assert!(nodes.contains("dir0/sub"), "direct subdir missing");
        // The subdir's own child must NOT appear at depth 1.
        assert!(
            !nodes.contains("dir0/sub/deep0.md"),
            "grandchild leaked at depth 1"
        );
        assert!(edges.contains(&(
            "dir0".to_string(),
            "dir0/file0.md".to_string(),
            "contains".to_string()
        )));
    }

    #[test]
    fn file_scope_is_never_paged() {
        let (_cfg, _root, ws) = seed_paged_workspace();
        // Even with a limit set, file scope returns the whole small
        // payload and reports done (the file + its parent spine).
        let resp = build_fs_graph_paged(
            &ws,
            &FsGraphParams {
                scope: FsGraphScope::File,
                path: "dir0/file0.md".to_string(),
                depth: 0,
                cursor: None,
                limit: Some(1),
            },
        )
        .unwrap();
        assert!(resp.done);
        assert!(resp.cursor.is_none());
        assert!(resp.nodes.iter().any(|n| n.id == "dir0/file0.md"));
    }
}
