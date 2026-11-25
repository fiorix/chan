//! `[[ ]]` typeahead, link resolution, headings, and the unified
//! graph view.
//!
//! Two-step typeahead UX. First, as the user types `[[Re...`, the
//! picker hits /api/link-targets to surface candidate files. Then,
//! after the user picks a file (`[[recipes/pasta.md`), they may type
//! `#` to jump to a heading; the picker hits /api/headings/`<rel>` to
//! enumerate the file's anchors.
//!
//! The graph endpoints (links / graph / backlinks) walk chan-workspace's
//! per-file accessors and stitch them into the unified `{ nodes,
//! edges }` shape the frontend visualization expects. `/api/graph`
//! and `/api/backlinks/{*path}` also expose `?stream=1` NDJSON forms
//! so the UI can render partial relationship data while the full
//! graph is still being composed.

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chan_workspace::{
    normalize_graph_edges, resolve_link_target as resolve_link_dst, CocomoSummary, EdgeKind,
    FileClass, PathClass, PathPermission, ReportFileBucket, ReportFileStats, WorkspacePath,
};
use serde::{Deserialize, Serialize};

use crate::error::{err, err_code, err_from, err_state};
use crate::extract::{Path as AxumPath, Query};
use crate::routes::blocking_response;
use crate::routes::fs_graph::{build_fs_graph, FsGraphScope};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct LinkTargetsParams {
    #[serde(default)]
    q: String,
    #[serde(default = "default_link_limit")]
    limit: u32,
}

fn default_link_limit() -> u32 {
    20
}

fn query_flag(value: &Option<String>) -> bool {
    matches!(
        value.as_deref(),
        Some("1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON")
    )
}

fn graph_ndjson_bytes(event: &GraphStreamEvent) -> Result<Bytes, serde_json::Error> {
    let mut line = serde_json::to_vec(event)?;
    line.push(b'\n');
    Ok(Bytes::from(line))
}

fn graph_ndjson_error_bytes(error: String) -> Bytes {
    match graph_ndjson_bytes(&GraphStreamEvent::Error { error }) {
        Ok(bytes) => bytes,
        Err(e) => Bytes::from(format!(
            "{{\"type\":\"error\",\"error\":\"failed to encode graph stream error: {e}\"}}\n"
        )),
    }
}

fn emit_graph_event(
    emit: &mut Option<&mut dyn FnMut(GraphStreamEvent) -> bool>,
    event: GraphStreamEvent,
) -> Result<(), GraphBuildError> {
    if let Some(emit) = emit.as_deref_mut() {
        if !emit(event) {
            return Err(GraphBuildError::Cancelled);
        }
    }
    Ok(())
}

fn emit_graph_nodes(
    emit: &mut Option<&mut dyn FnMut(GraphStreamEvent) -> bool>,
    nodes: Vec<GraphNodeView>,
) -> Result<(), GraphBuildError> {
    const BATCH_SIZE: usize = 128;
    for batch in nodes.chunks(BATCH_SIZE) {
        emit_graph_event(
            emit,
            GraphStreamEvent::Nodes {
                nodes: batch.to_vec(),
            },
        )?;
    }
    Ok(())
}

fn emit_graph_edges(
    emit: &mut Option<&mut dyn FnMut(GraphStreamEvent) -> bool>,
    edges: Vec<GraphEdgeView>,
) -> Result<(), GraphBuildError> {
    const BATCH_SIZE: usize = 256;
    for batch in edges.chunks(BATCH_SIZE) {
        emit_graph_event(
            emit,
            GraphStreamEvent::Edges {
                edges: batch.to_vec(),
            },
        )?;
    }
    Ok(())
}

pub async fn api_link_targets(
    State(state): State<Arc<AppState>>,
    Query(p): Query<LinkTargetsParams>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    blocking_response("link targets", move || api_link_targets_sync(workspace, p)).await
}

fn api_link_targets_sync(
    workspace: Arc<chan_workspace::Workspace>,
    p: LinkTargetsParams,
) -> Response {
    match workspace.link_targets(&p.q, p.limit) {
        Ok(targets) => Json(targets).into_response(),
        Err(e) => err_from(&e),
    }
}

#[derive(Deserialize)]
pub struct ResolveLinkParams {
    /// Wiki-link target as written, e.g. `recipes/pasta` or
    /// `recipes/pasta#ingredients`. Pass through verbatim from
    /// the editor; chan-workspace handles the .md / .txt extension
    /// fallback and the anchor split.
    target: String,
}

/// Resolve a wiki-link target to an existing workspace file. 404
/// when no file matches the candidates; this lets the editor's
/// click handler render a "broken link / create?" affordance.
pub async fn api_resolve_link(
    State(state): State<Arc<AppState>>,
    Query(p): Query<ResolveLinkParams>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    blocking_response("resolve link", move || {
        match workspace.resolve_link(&p.target) {
            Some(resolved) => Json(resolved).into_response(),
            None => err_code(
                StatusCode::NOT_FOUND,
                "link target not found".into(),
                "link_not_found",
                serde_json::json!({}),
            ),
        }
    })
    .await
}

pub async fn api_headings(
    State(state): State<Arc<AppState>>,
    AxumPath(path): AxumPath<String>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    blocking_response("headings", move || {
        let graph = match workspace.graph() {
            Ok(g) => g,
            Err(e) => return err_from(&e),
        };
        match graph.headings_of(&path) {
            Ok(headings) => Json(headings).into_response(),
            Err(e) => err_from(&e),
        }
    })
    .await
}

// chan-workspace's GraphView exposes per-file accessors (neighbors,
// backlinks, headings_of) and bulk reads (files, tags). It does
// NOT expose an "all edges" call, so /api/links and /api/graph
// walk the file list and accumulate. For typical workspace sizes the
// O(n) sqlite round-trip is fine; if profiles show this hot we
// add a chan-workspace helper.

/// All link-kind edges in the workspace. Mention and tag edges are
/// excluded; the graph view fetches those via /api/graph. The
/// shape is `[Edge]` so the frontend can render the link-only
/// view without a follow-up request.
pub async fn api_links(State(state): State<Arc<AppState>>) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    // Empty while the first index builds (the link-edge walk hits the
    // contended graph DB); the SPA re-fetches once indexing completes.
    if workspace.is_reindexing() {
        return Json(Vec::<chan_workspace::Edge>::new()).into_response();
    }
    blocking_response("links", move || {
        let graph = match workspace.graph() {
            Ok(g) => g,
            Err(e) => return err_from(&e),
        };
        let files = match graph.files() {
            Ok(f) => f,
            Err(e) => return err_from(&e),
        };
        let mut edges = Vec::new();
        for f in &files {
            match graph.neighbors(f) {
                Ok(es) => edges.extend(es.into_iter().filter(|e| matches!(e.kind, EdgeKind::Link))),
                Err(e) => return err_from(&e),
            }
        }
        Json(edges).into_response()
    })
    .await
}

/// `/api/graph` view. Frontend's `GraphView` type is unified
/// `{ nodes, edges }`; chan-workspace exposes per-kind primitives
/// (files / tags / neighbors). This handler walks the graph DB and
/// emits the unified shape so the visualization can render without
/// per-kind glue on the frontend side.
///
/// Node kinds: file (one per indexed path), tag (#name), mention
/// (@@name). Date nodes from the typescript type aren't emitted;
/// chan-workspace's EdgeKind has no date variant today.
#[derive(Debug, Clone, Serialize)]
struct GraphViewResponse {
    nodes: Vec<GraphNodeView>,
    edges: Vec<GraphEdgeView>,
    /// Set on the empty answer given while a full rebuild holds the index,
    /// and absent from every other answer, so a client can tell that answer
    /// from the graph of a workspace that has none.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    gated: bool,
}

#[derive(Debug)]
enum GraphBuildError {
    Workspace(chan_workspace::ChanError),
    Fs(super::fs_graph::FsGraphError),
    Cancelled,
}

impl GraphBuildError {
    fn into_response(self) -> Response {
        match self {
            GraphBuildError::Workspace(e) => err_from(&e),
            GraphBuildError::Fs(e) => e.into_response(),
            GraphBuildError::Cancelled => err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "graph stream cancelled".into(),
            ),
        }
    }
}

impl std::fmt::Display for GraphBuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GraphBuildError::Workspace(e) => write!(f, "{e}"),
            GraphBuildError::Fs(e) => write!(f, "{e}"),
            GraphBuildError::Cancelled => write!(f, "graph stream cancelled"),
        }
    }
}

impl From<chan_workspace::ChanError> for GraphBuildError {
    fn from(value: chan_workspace::ChanError) -> Self {
        GraphBuildError::Workspace(value)
    }
}

impl From<super::fs_graph::FsGraphError> for GraphBuildError {
    fn from(value: super::fs_graph::FsGraphError) -> Self {
        GraphBuildError::Fs(value)
    }
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum GraphStreamEvent {
    Meta {
        scope: GraphScope,
        path: String,
        depth: usize,
        /// Set on the stream given while a full rebuild holds the index,
        /// whose only other event is `done`; absent otherwise.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        gated: bool,
    },
    Nodes {
        nodes: Vec<GraphNodeView>,
    },
    Edges {
        edges: Vec<GraphEdgeView>,
    },
    Done,
    Error {
        error: String,
    },
}

enum GraphStreamMessage {
    Data(Bytes),
    Error(GraphBuildError),
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum GraphNodeView {
    File {
        id: String,
        label: String,
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        path_class: Option<PathClass>,
        /// `chan.kind` for the underlying file. "contact" for notes
        /// flagged with `chan.kind: contact` frontmatter; absent for
        /// regular markdown so the visualizer's default doc styling
        /// kicks in. Image files are still classified by extension on
        /// the frontend; this field is the indexer-side discriminator
        /// chan-workspace carries on every file node.
        #[serde(skip_serializing_if = "Option::is_none")]
        node_kind: Option<&'static str>,
        /// chan-report's source-code-shaped bucket
        /// (`Markdown` / `SourceCode { language }`) from the file's
        /// per-file stats, populated when the path is in
        /// chan-report's tracked-file set (markdown + recognized
        /// source extensions). Missing for files chan-report
        /// doesn't track (binary, media, unknown). Lets the SPA's
        /// graph colour scheme read the truth from the server instead
        /// of running client-side regex classification.
        #[serde(skip_serializing_if = "Option::is_none")]
        bucket: Option<ReportFileBucket>,
        /// True for ghost nodes synthesized as the target of a
        /// broken link. Frontend renders them muted.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        missing: bool,
    },
    Media {
        id: String,
        label: String,
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        path_class: Option<PathClass>,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        missing: bool,
    },
    Directory {
        id: String,
        label: String,
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        path_class: Option<PathClass>,
        files: u64,
        code: u64,
    },
    Language {
        id: String,
        label: String,
        language: String,
        files: u64,
        code: u64,
    },
    Tag {
        id: String,
        label: String,
    },
    Mention {
        id: String,
        label: String,
    },
}

#[derive(Debug, Clone, Serialize)]
struct GraphEdgeView {
    source: String,
    target: String,
    /// "link" | "tag" | "mention" | "contains" | "language" |
    /// "symlink" | "hardlink". Lowercase to match the
    /// frontend's GraphViewEdgeKind type.
    kind: &'static str,
    /// True for a link that resolves to a missing file, and for a
    /// symlink whose target is missing. Other kinds skip the field.
    #[serde(skip_serializing_if = "Option::is_none")]
    broken: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rank: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    files: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GraphParams {
    #[serde(default = "default_graph_scope")]
    scope: GraphScope,
    #[serde(default)]
    path: String,
    #[serde(default = "default_graph_depth")]
    depth: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GraphQuery {
    #[serde(default = "default_graph_scope")]
    scope: GraphScope,
    #[serde(default)]
    path: String,
    #[serde(default = "default_graph_depth")]
    depth: usize,
    #[serde(default)]
    stream: Option<String>,
}

impl GraphQuery {
    fn into_params(self) -> GraphParams {
        GraphParams {
            scope: self.scope,
            path: self.path,
            depth: self.depth,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum GraphScope {
    Workspace,
    Directory,
    File,
}

fn default_graph_scope() -> GraphScope {
    GraphScope::Workspace
}

fn default_graph_depth() -> usize {
    6
}

#[derive(Deserialize)]
pub struct LanguageGraphParams {
    #[serde(default)]
    depth: u32,
    #[serde(default)]
    language: Option<String>,
}

#[derive(Serialize)]
struct LanguageGraphResponse {
    max_depth: u32,
    nodes: Vec<LanguageGraphNode>,
    edges: Vec<LanguageGraphEdge>,
    /// Inspector detail for the requested language: complete ranked
    /// directory list (no depth truncation) plus the COCOMO summary
    /// chan-report computes for the language's file set. Present only
    /// when the caller passed `?language=`.
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<LanguageDetailResponse>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
struct LanguageDetailResponse {
    language: String,
    files: u64,
    code: u64,
    cocomo: CocomoSummary,
    directories: Vec<LanguageDetailDirectory>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct LanguageDetailDirectory {
    path: String,
    label: String,
    rank: u32,
    files: u64,
    code: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum LanguageGraphNode {
    Language {
        id: String,
        label: String,
        language: String,
        files: u64,
        code: u64,
    },
    Directory {
        id: String,
        label: String,
        path: String,
        files: u64,
        code: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct LanguageGraphEdge {
    source: String,
    target: String,
    kind: &'static str,
    rank: u32,
    files: u64,
    code: u64,
}

#[derive(Debug, Clone, Default)]
struct LanguageDirectoryStats {
    files: u64,
    code: u64,
}

fn edge_kind_tag(k: EdgeKind) -> &'static str {
    match k {
        EdgeKind::Link => "link",
        EdgeKind::Tag => "tag",
        EdgeKind::Mention => "mention",
    }
}

/// Derive the file-node label from a workspace-relative path. Strips
/// the `.md` / `.txt` extension and uses the basename so the graph
/// renders "recipes/pasta" as just "pasta" without losing the path
/// (the file node carries the full path on its `path` field).
fn file_label(rel: &str) -> String {
    let stem = std::path::Path::new(rel)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| rel.to_string());
    stem
}

/// Image-extension predicate. Mirrors `IMAGE_EXTENSIONS` in
/// `web/packages/workspace-app/src/state/fileTypes.ts`, the module that
/// owns the frontend's file classification: `classifyPath` there, and
/// `classifyFile` and `fileBucket` in `state/kinds.ts` built on it, are
/// what the canvas, its filter chips and the file browser read. The
/// graph route uses this to enrich the file set with image files
/// referenced by markdown so a `![](pic.png)` lands on a real file node
/// instead of a ghost. Keep this list and that set in sync.
fn is_image_path(rel: &str) -> bool {
    let ext = std::path::Path::new(rel)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());
    matches!(
        ext.as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "avif" | "bmp")
    )
}

/// The whole-tree walk of one graph load, which the link resolver's file
/// and directory sets and the folder layer share.
enum TreeWalk {
    /// Every regular file and every directory in the workspace's scope,
    /// workspace-relative POSIX paths. The files are the link resolver's
    /// universe beside the indexed ones, so a link to any file on disk
    /// (LICENSE, a `.rs` source, a script) lands on that file instead of a
    /// ghost. The directories let the graph tell a link to a folder
    /// (`[notes](../alex/)`) from a ghost and drop its edge, since a folder
    /// link carries no between-file meaning.
    Listed {
        files: std::collections::BTreeSet<String>,
        dirs: std::collections::BTreeSet<String>,
    },
    /// The listing is over the cap. The graph looks each link target that
    /// is a file up on disk instead (`link_targets_on_disk`). `dirs` holds
    /// every directory in scope, from `walk_directories`, or is `None` when
    /// the directories are over the cap too.
    OverCap {
        dirs: Option<std::collections::BTreeSet<String>>,
    },
    /// The listing failed otherwise. The graph answers with the indexed
    /// files alone as the resolver's universe and, in workspace scope, no
    /// tree layer, rather than failing the request.
    Failed,
}

impl TreeWalk {
    /// Walk the workspace's tree once. Over the listing cap the listing's
    /// partial result is gone before the directories are walked, so the
    /// load holds at most one cap's worth of walked paths at a time.
    fn of(workspace: &chan_workspace::Workspace) -> Self {
        #[cfg(test)]
        tree_walks::record(workspace.root(), tree_walks::Walk::Listing);
        match workspace.list_tree_filtered_unified() {
            Ok(entries) => {
                let mut files = std::collections::BTreeSet::new();
                let mut dirs = std::collections::BTreeSet::new();
                for entry in entries {
                    if entry.is_dir {
                        dirs.insert(entry.path);
                    } else {
                        files.insert(entry.path);
                    }
                }
                TreeWalk::Listed { files, dirs }
            }
            Err(chan_workspace::ChanError::ListingTooLarge { .. }) => {
                #[cfg(test)]
                let limit = tree_walks::directory_limit(workspace.root())
                    .unwrap_or(chan_workspace::fs_ops::LIST_TREE_LIMIT);
                #[cfg(not(test))]
                let limit = chan_workspace::fs_ops::LIST_TREE_LIMIT;
                TreeWalk::OverCap {
                    dirs: walk_directories(workspace, limit),
                }
            }
            Err(_) => TreeWalk::Failed,
        }
    }
}

/// Every directory in the workspace's scope, workspace-relative POSIX
/// paths, or `None` once more than `limit` of them arrive.
///
/// It takes the walk the whole-tree listing collects
/// (`walk_workspace_scoped` under the workspace's scope policy) and keeps
/// its directories, so it reaches exactly the directories the listing
/// lists: real directories inside the policy (excluded directories,
/// `.gitignore`), entered only through such directories, on the root's
/// file system (a mount point is listed and not entered). Each directory's
/// files are read past in its listing, neither held nor read for metadata,
/// so the walk holds at most `limit` paths; a graph load passes the
/// listing cap, which bounds the directories as it bounds the listing.
fn walk_directories(
    workspace: &chan_workspace::Workspace,
    limit: usize,
) -> Option<std::collections::BTreeSet<String>> {
    #[cfg(test)]
    tree_walks::record(workspace.root(), tree_walks::Walk::Directories);
    let root = workspace.root();
    let policy = workspace.scope_policy();
    let mut dirs = std::collections::BTreeSet::new();
    for entry in chan_workspace::fs_ops::walk_workspace_scoped(root, &policy) {
        if !entry.file_type().is_dir() {
            continue;
        }
        if dirs.len() >= limit {
            return None;
        }
        if let Ok(rel) = entry.path().strip_prefix(root) {
            dirs.insert(chan_workspace::fs_ops::rel_path_text(rel));
        }
    }
    Some(dirs)
}

/// How many whole-tree walks graph loads have taken, per workspace root and
/// kind of walk, so a test can read the walks of one load, and a lowered
/// bound on the directories-only walk.
#[cfg(test)]
pub(crate) mod tree_walks {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{LazyLock, Mutex};

    /// A kind of whole-tree walk.
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    pub(crate) enum Walk {
        /// The listing of every file and directory in scope.
        Listing,
        /// The walk of the directories in scope alone, over the listing cap.
        Directories,
    }

    static TAKEN: LazyLock<Mutex<HashMap<(PathBuf, Walk), usize>>> =
        LazyLock::new(Default::default);

    pub(super) fn record(root: &Path, walk: Walk) {
        *TAKEN
            .lock()
            .unwrap()
            .entry((root.to_path_buf(), walk))
            .or_default() += 1;
    }

    /// The walks of kind `walk` the graph loads of the workspace at `root`
    /// have taken.
    pub(crate) fn taken(root: &Path, walk: Walk) -> usize {
        TAKEN
            .lock()
            .unwrap()
            .get(&(root.to_path_buf(), walk))
            .copied()
            .unwrap_or(0)
    }

    static DIRECTORY_LIMITS: LazyLock<Mutex<HashMap<PathBuf, usize>>> =
        LazyLock::new(Default::default);

    /// A lowered bound on one workspace's directories-only walk, held until
    /// it is dropped.
    pub(crate) struct LoweredDirectoryWalk(PathBuf);

    impl Drop for LoweredDirectoryWalk {
        fn drop(&mut self) {
            DIRECTORY_LIMITS.lock().unwrap().remove(&self.0);
        }
    }

    /// Bound the directories-only walk of the workspace at `root` at `limit`
    /// directories, in place of the listing cap.
    pub(crate) fn lower_directory_walk(root: &Path, limit: usize) -> LoweredDirectoryWalk {
        let previous = DIRECTORY_LIMITS
            .lock()
            .unwrap()
            .insert(root.to_path_buf(), limit);
        assert!(previous.is_none(), "the directory walk is lowered already");
        LoweredDirectoryWalk(root.to_path_buf())
    }

    pub(super) fn directory_limit(root: &Path) -> Option<usize> {
        DIRECTORY_LIMITS.lock().unwrap().get(root).copied()
    }
}

/// The link targets in `edges` that are on disk, as `(files,
/// directories)`, for a graph whose whole-tree listing is over the cap
/// and lists no file. A target is looked up as the resolver's first
/// candidate spells it (percent-decoded, workspace-rooted), and only when
/// that is the walk's own spelling. It is kept as the walk keeps an entry:
/// every directory above it is one the walk enters, and the target is a
/// regular file inside the scope policy (excluded directories,
/// `.gitignore`) or a directory the walk lists.
///
/// `walked_dirs` is every directory the walk lists, from the
/// directories-only walk, and answers for the directories above a target
/// and for a folder target, so only a file target is statted. Without it
/// (the directories are over the cap too) each of those directories is
/// an lstat instead, kept when it is a real directory (a symlinked one
/// stops it, as the walk follows no symlink) inside the scope policy.
/// Every lookup goes through the workspace's capability sandbox, so no
/// `..` or symlink leaves the root.
///
/// It finds what the walk would list, with two differences: on a
/// case-folding volume a wrong-case spelling finds a file the walk lists
/// under its stored spelling only, and a file inside a mount point inside
/// the root is found where the walk does not descend. With `walked_dirs`
/// both hold for the last component only, since the set spells each
/// directory as the walk does and holds none below a mount point. The
/// resolver's other candidates match indexed Markdown files only, so an
/// extensionless link to a text file (`[[todo]]` for `todo.txt`) and a
/// source-relative spelling of a non-Markdown file stay dropped over the
/// cap.
///
/// Cost: one lstat per distinct link target that is not an indexed file
/// or a walked directory, on every graph load over the cap, and without
/// `walked_dirs` one per distinct directory above those targets too.
/// Under the cap the walk's sets answer and nothing is statted.
fn link_targets_on_disk(
    workspace: &chan_workspace::Workspace,
    edges: &[chan_workspace::Edge],
    indexed: &std::collections::BTreeSet<&str>,
    walked_dirs: Option<&std::collections::BTreeSet<String>>,
) -> (
    std::collections::BTreeSet<String>,
    std::collections::BTreeSet<String>,
) {
    let policy = workspace.scope_policy();
    // Without the walked directories, each directory above a target is
    // read once per call. The walk reaches an entry only through real
    // directories its scope keeps.
    let mut ancestors = std::collections::HashMap::new();
    let mut walk_descends = |dir: &str| -> bool {
        if let Some(walked) = walked_dirs {
            return walked.contains(dir);
        }
        if let Some(&descends) = ancestors.get(dir) {
            return descends;
        }
        let real_dir = matches!(
            workspace.classify_workspace_path(dir),
            Ok(WorkspacePath::Directory(_))
        );
        let descends = real_dir && policy.includes(dir, true);
        ancestors.insert(dir.to_string(), descends);
        descends
    };
    let no_files = std::collections::BTreeSet::<&str>::new();
    let mut seen = std::collections::HashSet::new();
    let mut files = std::collections::BTreeSet::new();
    let mut dirs = std::collections::BTreeSet::new();
    for edge in edges {
        if !matches!(edge.kind, EdgeKind::Link) {
            continue;
        }
        // With no file to match, the resolver answers the decoded target.
        let decoded = resolve_link_dst(&edge.src, &edge.dst, &no_files);
        let target = decoded.trim_start_matches('/');
        if indexed.contains(target) || !seen.insert(target.to_string()) {
            continue;
        }
        let walk_spelling = chan_workspace::fs_ops::validate_rel(target)
            .ok()
            .map(|rel| chan_workspace::fs_ops::rel_path_text(&rel));
        if walk_spelling.as_deref() != Some(target) {
            continue;
        }
        if !target
            .match_indices('/')
            .all(|(at, _)| walk_descends(&target[..at]))
        {
            continue;
        }
        if walked_dirs.is_some_and(|walked| walked.contains(target)) {
            dirs.insert(target.to_string());
            continue;
        }
        match workspace.classify_workspace_path(target) {
            Ok(WorkspacePath::Regular(_)) if policy.includes(target, false) => {
                files.insert(target.to_string());
            }
            Ok(WorkspacePath::Directory(_))
                if walked_dirs.is_none() && policy.includes(target, true) =>
            {
                dirs.insert(target.to_string());
            }
            _ => {}
        }
    }
    (files, dirs)
}

/// Image subset of the load's disk files. Kept as its own predicate so
/// images stay distinguishable from other non-graph files (they get
/// the Media node kind; other on-disk files become regular File
/// nodes).
fn image_subset(
    disk_files: &std::collections::BTreeSet<String>,
) -> std::collections::BTreeSet<String> {
    disk_files
        .iter()
        .filter(|p| is_image_path(p))
        .cloned()
        .collect()
}

/// True only for regular files in the workspace root. Sidecar drafts use a
/// separate capability and have no content-graph nodes before promotion.
fn indexed_file_exists(workspace: &chan_workspace::Workspace, rel: &str) -> bool {
    workspace.exists(rel)
}

fn language_node_id(language: &str) -> String {
    format!("language:{language}")
}

fn directory_node_id(path: &str) -> String {
    if path.is_empty() {
        String::new()
    } else {
        format!("directory:{path}")
    }
}

fn directory_label(path: &str) -> String {
    if path.is_empty() {
        "/".to_string()
    } else {
        std::path::Path::new(path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(path)
            .to_string()
    }
}

fn parent_directory(path: &str) -> String {
    std::path::Path::new(path)
        .parent()
        .map(chan_workspace::fs_ops::rel_path_text)
        .unwrap_or_default()
}

/// Case-insensitive language match shared by the language graph and
/// the inspector detail so both surfaces select the same file set.
fn language_matches(file_language: &str, filter_lowercase: &str) -> bool {
    file_language.to_lowercase() == filter_lowercase
}

/// Directory ranking shared by the language graph's directory edges
/// and the inspector detail: files descending, code descending, path
/// ascending. This is product policy encoded once; both surfaces must
/// consume this one comparator so their tie order cannot drift.
fn compare_language_directories(
    a_path: &str,
    a: &LanguageDirectoryStats,
    b_path: &str,
    b: &LanguageDirectoryStats,
) -> std::cmp::Ordering {
    b.files
        .cmp(&a.files)
        .then_with(|| b.code.cmp(&a.code))
        .then_with(|| a_path.cmp(b_path))
}

fn build_language_graph(
    files: &[ReportFileStats],
    depth: u32,
    language_filter: Option<&str>,
) -> LanguageGraphResponse {
    let filter = language_filter.map(str::to_lowercase);
    let mut by_language: std::collections::BTreeMap<
        String,
        std::collections::BTreeMap<String, LanguageDirectoryStats>,
    > = std::collections::BTreeMap::new();

    for file in files {
        if file.language.trim().is_empty() {
            continue;
        }
        if let Some(filter) = &filter {
            if !language_matches(&file.language, filter) {
                continue;
            }
        }
        let directory = parent_directory(&file.path);
        let stats = by_language
            .entry(file.language.clone())
            .or_default()
            .entry(directory)
            .or_default();
        stats.files += 1;
        stats.code += file.code;
    }

    let max_depth = by_language
        .values()
        .map(|directories| u32::try_from(directories.len()).unwrap_or(u32::MAX))
        .max()
        .unwrap_or(0);
    let effective_depth = if depth == 0 {
        max_depth
    } else {
        depth.min(max_depth)
    };

    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut directory_totals: std::collections::BTreeMap<String, LanguageDirectoryStats> =
        std::collections::BTreeMap::new();

    for (language, directories) in &by_language {
        let mut ranked: Vec<(&String, &LanguageDirectoryStats)> = directories.iter().collect();
        ranked
            .sort_by(|(a_path, a), (b_path, b)| compare_language_directories(a_path, a, b_path, b));

        let language_files = directories.values().map(|s| s.files).sum();
        let language_code = directories.values().map(|s| s.code).sum();
        nodes.push(LanguageGraphNode::Language {
            id: language_node_id(language),
            label: language.clone(),
            language: language.clone(),
            files: language_files,
            code: language_code,
        });

        for (idx, (directory, stats)) in ranked.into_iter().enumerate() {
            let rank = u32::try_from(idx + 1).unwrap_or(u32::MAX);
            if effective_depth != 0 && rank > effective_depth {
                continue;
            }
            let totals = directory_totals.entry(directory.clone()).or_default();
            totals.files += stats.files;
            totals.code += stats.code;
            edges.push(LanguageGraphEdge {
                source: language_node_id(language),
                target: directory_node_id(directory),
                kind: "language",
                rank,
                files: stats.files,
                code: stats.code,
            });
        }
    }

    for (directory, stats) in directory_totals {
        nodes.push(LanguageGraphNode::Directory {
            id: directory_node_id(&directory),
            label: directory_label(&directory),
            path: directory,
            files: stats.files,
            code: stats.code,
        });
    }

    LanguageGraphResponse {
        max_depth,
        nodes,
        edges,
        detail: None,
    }
}

/// Inspector detail for one language: every directory holding that
/// language's files, ranked with the same `compare_language_directories`
/// order as the language graph's directory edges but with NO depth
/// cutoff, plus the COCOMO summary chan-report computed for the
/// language's file set. The graph's depth slider trims rendered nodes;
/// the inspector must stay complete regardless, so this list is built
/// from the same report rows without a rank limit.
fn build_language_detail(
    files: &[ReportFileStats],
    language: &str,
    cocomo: CocomoSummary,
) -> LanguageDetailResponse {
    let filter = language.to_lowercase();
    let mut by_directory: std::collections::BTreeMap<String, LanguageDirectoryStats> =
        std::collections::BTreeMap::new();
    let mut canonical_language: Option<String> = None;

    for file in files {
        if file.language.trim().is_empty() || !language_matches(&file.language, &filter) {
            continue;
        }
        canonical_language.get_or_insert_with(|| file.language.clone());
        let directory = parent_directory(&file.path);
        let stats = by_directory.entry(directory).or_default();
        stats.files += 1;
        stats.code += file.code;
    }

    let mut ranked: Vec<(String, LanguageDirectoryStats)> = by_directory.into_iter().collect();
    ranked.sort_by(|(a_path, a), (b_path, b)| compare_language_directories(a_path, a, b_path, b));

    let mut total_files = 0;
    let mut total_code = 0;
    let mut directories = Vec::with_capacity(ranked.len());
    for (idx, (path, stats)) in ranked.into_iter().enumerate() {
        total_files += stats.files;
        total_code += stats.code;
        directories.push(LanguageDetailDirectory {
            label: directory_label(&path),
            path,
            rank: u32::try_from(idx + 1).unwrap_or(u32::MAX),
            files: stats.files,
            code: stats.code,
        });
    }

    LanguageDetailResponse {
        language: canonical_language.unwrap_or_else(|| language.to_string()),
        files: total_files,
        code: total_code,
        cocomo,
        directories,
    }
}

/// Detail builder for the HTTP handler: the file set comes from the
/// caller's snapshot, then a scoped report over exactly that set
/// supplies the rows and the COCOMO summary, so the estimate is
/// chan-report's own computation over the language's paths. Both
/// `workspace.report()` and `workspace.report_for_files()` return
/// maintained roll-up snapshots of the workspace index; they are two
/// separate maintained roll-ups, not one atomic snapshot across the
/// two calls.
fn language_detail_scoped(
    workspace: &chan_workspace::Workspace,
    files: &[ReportFileStats],
    language: &str,
) -> chan_workspace::Result<LanguageDetailResponse> {
    let filter = language.to_lowercase();
    let paths: Vec<String> = files
        .iter()
        .filter(|f| !f.language.trim().is_empty() && language_matches(&f.language, &filter))
        .map(|f| f.path.clone())
        .collect();
    let scoped = workspace.report_for_files(&paths)?;
    Ok(build_language_detail(
        &scoped.files,
        language,
        scoped.cocomo,
    ))
}

fn graph_scope_path(p: &GraphParams) -> &str {
    match p.scope {
        GraphScope::Workspace => "",
        GraphScope::Directory | GraphScope::File => p.path.trim_matches('/'),
    }
}

fn path_class_for_graph(workspace: &chan_workspace::Workspace, path: &str) -> Option<PathClass> {
    chan_workspace::fs_ops::classify_path(workspace.root(), path).ok()
}

/// Should a per-file emit at `path` survive the
/// contact-node filter? The graph's job is "who-mentions-whom":
/// contact-frontmatter files (imported address-book entries)
/// that are NOT referenced by any resolved `@@mention` add
/// nothing to that picture, so they're filtered out. Non-contact
/// files always emit. Contact files emit only when their path is
/// in `referenced_contact_paths` (built from the mention-edge
/// resolution pass earlier in `api_graph`).
///
/// This filter limits a large imported address book to the contacts that
/// participate in the mention graph.
fn should_emit_contact_file(
    path: &str,
    contact_paths: &std::collections::HashSet<String>,
    referenced_contact_paths: &std::collections::HashSet<String>,
) -> bool {
    !contact_paths.contains(path) || referenced_contact_paths.contains(path)
}

fn is_media_graph_path(path: &str) -> bool {
    matches!(
        chan_workspace::fs_ops::classify(path),
        FileClass::Image | FileClass::Pdf
    )
}

fn fs_node_graph_id(node: &super::fs_graph::NodeView) -> String {
    if node.kind == "directory" {
        directory_node_id(&node.path)
    } else {
        node.id.clone()
    }
}

fn merge_directory_node(
    nodes: &mut std::collections::BTreeMap<String, GraphNodeView>,
    id: String,
    label: String,
    path: String,
    path_class: Option<PathClass>,
    files: u64,
    code: u64,
) {
    if let Some(GraphNodeView::Directory {
        path_class: existing_class,
        files: existing_files,
        code: existing_code,
        ..
    }) = nodes.get_mut(&id)
    {
        if existing_class.is_none() {
            *existing_class = path_class;
        }
        *existing_files = (*existing_files).max(files);
        *existing_code = (*existing_code).max(code);
        return;
    }

    nodes.insert(
        id.clone(),
        GraphNodeView::Directory {
            id,
            label,
            path,
            path_class,
            files,
            code,
        },
    );
}

fn contains_edge_key(source: &str, target: &str) -> (String, String, &'static str) {
    (source.to_string(), target.to_string(), "contains")
}

/// Accumulators plus the read-only inputs threaded through the
/// unified tree layer. `edge_set` is owned: it is seeded from the
/// edges accumulated so far -- so the contains-edge dedup sees the
/// filesystem-layer edges pushed before the tree pass -- and dies
/// with the ctx.
struct TreeMergeCtx<'a> {
    workspace: &'a chan_workspace::Workspace,
    report_buckets: &'a std::collections::HashMap<String, ReportFileBucket>,
    nodes: &'a mut std::collections::BTreeMap<String, GraphNodeView>,
    edges: &'a mut Vec<GraphEdgeView>,
    edge_set: std::collections::BTreeSet<(String, String, &'static str)>,
}

impl<'a> TreeMergeCtx<'a> {
    fn new(
        workspace: &'a chan_workspace::Workspace,
        report_buckets: &'a std::collections::HashMap<String, ReportFileBucket>,
        nodes: &'a mut std::collections::BTreeMap<String, GraphNodeView>,
        edges: &'a mut Vec<GraphEdgeView>,
    ) -> Self {
        let edge_set = edges
            .iter()
            .map(|edge| (edge.source.clone(), edge.target.clone(), edge.kind))
            .collect();
        Self {
            workspace,
            report_buckets,
            nodes,
            edges,
            edge_set,
        }
    }

    fn push_contains_edge(&mut self, source: String, target: String) {
        if self.edge_set.insert(contains_edge_key(&source, &target)) {
            self.edges.push(GraphEdgeView {
                source,
                target,
                kind: "contains",
                broken: None,
                rank: None,
                files: None,
                code: None,
            });
        }
    }

    fn ensure_directory_path(&mut self, path: &str) {
        let clean = path.trim_matches('/');
        let id = directory_node_id(clean);
        merge_directory_node(
            self.nodes,
            id.clone(),
            directory_label(clean),
            clean.to_string(),
            path_class_for_graph(self.workspace, clean),
            0,
            0,
        );
        if clean.is_empty() {
            return;
        }
        let parent = parent_directory(clean);
        self.ensure_directory_path(&parent);
        self.push_contains_edge(directory_node_id(&parent), id);
    }

    fn merge_tree_file_node(&mut self, path: &str) {
        let id = path.to_string();
        let label = file_label(path);
        let path_class = path_class_for_graph(self.workspace, path);
        if is_media_graph_path(path) {
            self.nodes
                .entry(id.clone())
                .or_insert(GraphNodeView::Media {
                    id,
                    label,
                    path: path.to_string(),
                    path_class,
                    missing: false,
                });
            return;
        }

        if let Some(GraphNodeView::File { bucket, .. }) = self.nodes.get_mut(&id) {
            if bucket.is_none() {
                *bucket = self.report_buckets.get(path).cloned();
            }
            return;
        }

        self.nodes.entry(id.clone()).or_insert(GraphNodeView::File {
            id,
            label,
            path: path.to_string(),
            path_class,
            node_kind: None,
            bucket: self.report_buckets.get(path).cloned(),
            missing: false,
        });
    }

    fn merge_tree_entry(&mut self, path: &str, is_dir: bool) {
        let path = path.trim_matches('/');
        if path.is_empty() {
            self.ensure_directory_path("");
            return;
        }
        let parent = parent_directory(path);
        self.ensure_directory_path(&parent);
        if is_dir {
            self.ensure_directory_path(path);
        } else {
            self.merge_tree_file_node(path);
            self.push_contains_edge(directory_node_id(&parent), path.to_string());
        }
    }

    /// Merge the root and then `entries`, each a path and whether it is a
    /// directory, in path order. A directory the workspace holds read-only
    /// is merged as a dead end, and nothing below it is. Returns those
    /// directories.
    fn merge_tree_entries<'e>(
        &mut self,
        entries: impl IntoIterator<Item = (&'e str, bool)>,
    ) -> Vec<String> {
        self.ensure_directory_path("");
        let mut blocked_dirs: Vec<String> = Vec::new();
        for (entry_path, is_dir) in entries {
            let entry_path = entry_path.trim_matches('/');
            if is_below_any(&blocked_dirs, entry_path) {
                continue;
            }
            self.merge_tree_entry(entry_path, is_dir);
            if is_dir
                && matches!(
                    path_class_for_graph(self.workspace, entry_path),
                    Some(class) if class.permission == PathPermission::ReadOnly
                )
            {
                blocked_dirs.push(entry_path.to_string());
            }
        }
        blocked_dirs
    }

    /// Over the listing cap, where the walk lists directories alone: join
    /// each file the graph already holds to its folder, as the listing
    /// would, when the walk lists that folder and no read-only directory
    /// at or above it makes it a dead end. A file the graph holds for no
    /// other reason gets no node, so the layer holds one node per walked
    /// folder and per file the graph has, not one per file on disk.
    fn spine_held_files(
        &mut self,
        dirs: &std::collections::BTreeSet<String>,
        blocked_dirs: &[String],
    ) {
        let held: Vec<String> = self
            .nodes
            .values()
            .filter_map(|node| match node {
                GraphNodeView::File { path, missing, .. }
                | GraphNodeView::Media { path, missing, .. }
                    if !missing =>
                {
                    Some(path.trim_matches('/').to_string())
                }
                _ => None,
            })
            .collect();
        for path in held {
            if path.is_empty() || is_below_any(blocked_dirs, &path) {
                continue;
            }
            let parent = parent_directory(&path);
            if parent.is_empty() || dirs.contains(&parent) {
                self.merge_tree_entry(&path, false);
            }
        }
    }
}

/// Whether `path` lies below one of `dirs`.
fn is_below_any(dirs: &[String], path: &str) -> bool {
    dirs.iter()
        .any(|dir| path != dir && path.starts_with(&format!("{dir}/")))
}

/// The paths of `dirs` and `files` as one sequence in path order, the order
/// of the sorted listing they were split from, each with whether it is a
/// directory.
fn in_path_order<'a>(
    dirs: &'a std::collections::BTreeSet<String>,
    files: &'a std::collections::BTreeSet<String>,
) -> impl Iterator<Item = (&'a str, bool)> + 'a {
    let mut dirs = dirs.iter().peekable();
    let mut files = files.iter().peekable();
    std::iter::from_fn(move || {
        let next_is_dir = match (dirs.peek(), files.peek()) {
            (Some(dir), Some(file)) => dir < file,
            (Some(_), None) => true,
            (None, Some(_)) => false,
            (None, None) => return None,
        };
        if next_is_dir {
            dirs.next().map(|dir| (dir.as_str(), true))
        } else {
            files.next().map(|file| (file.as_str(), false))
        }
    })
}

fn merge_unified_tree_layer(
    workspace: &chan_workspace::Workspace,
    p: &GraphParams,
    walk: &TreeWalk,
    nodes: &mut std::collections::BTreeMap<String, GraphNodeView>,
    edges: &mut Vec<GraphEdgeView>,
    report_buckets: &std::collections::HashMap<String, ReportFileBucket>,
) {
    // Filtered walks, the load's whole-tree walk or a subtree's, so the
    // semantic graph's tree layer excludes the same blocklist dirs
    // (`node_modules/`, `target/`, ...) the index, the File Browser spine,
    // and the fs-graph walker exclude. The comment below ("same file
    // coverage as the File Browser") holds because the File Browser spine
    // is itself filtered (bootstrap).
    match p.scope {
        GraphScope::Workspace => match walk {
            TreeWalk::Listed { files, dirs } => {
                let mut ctx = TreeMergeCtx::new(workspace, report_buckets, nodes, edges);
                ctx.merge_tree_entries(in_path_order(dirs, files));
            }
            TreeWalk::OverCap { dirs: Some(dirs) } => {
                let mut ctx = TreeMergeCtx::new(workspace, report_buckets, nodes, edges);
                let blocked_dirs =
                    ctx.merge_tree_entries(dirs.iter().map(|dir| (dir.as_str(), true)));
                ctx.spine_held_files(dirs, &blocked_dirs);
            }
            TreeWalk::OverCap { dirs: None } | TreeWalk::Failed => {}
        },
        GraphScope::Directory | GraphScope::File => {
            merge_subtree_layer(workspace, p, nodes, edges, report_buckets)
        }
    }
}

/// The tree layer of a directory or file scope: the scoped subtree's own
/// walk, then every file node anchored to its folders.
fn merge_subtree_layer(
    workspace: &chan_workspace::Workspace,
    p: &GraphParams,
    nodes: &mut std::collections::BTreeMap<String, GraphNodeView>,
    edges: &mut Vec<GraphEdgeView>,
    report_buckets: &std::collections::HashMap<String, ReportFileBucket>,
) {
    let Ok(mut entries) = workspace.list_tree_prefix_filtered_unified(graph_scope_path(p)) else {
        return;
    };
    entries.sort_by(|a, b| a.path.cmp(&b.path));

    let mut ctx = TreeMergeCtx::new(workspace, report_buckets, nodes, edges);
    ctx.merge_tree_entries(
        entries
            .iter()
            .map(|entry| (entry.path.as_str(), entry.is_dir)),
    );

    // Anchor every included file to its folder ancestors. In directory/file
    // scope the file NODES are seeded workspace-wide (a node per indexed file,
    // plus referenced on-disk targets), but the tree walk above is
    // PREFIX-scoped -- so any file outside the scoped subtree gets a node with
    // no `contains` ancestor chain and the frontend renders it edgeless. Spine
    // each remaining non-missing file to its parent directory chain so
    // directory scope keeps the "no file renders edgeless" invariant Workspace
    // scope already has. This mirrors the Workspace-scope walk (which spines
    // the whole tree); the extra out-of-prefix folder bubbles are
    // declutterable via the folder chip. An old user-root `.Drafts` directory
    // is anchored like any other live directory. The spine ops are idempotent
    // (`edge_set`/`merge_directory_node`
    // dedup), so an in-scope file already spined by the prefix walk is a no-op.
    // Workspace scope walks the full tree, so it needs no backfill.
    let unspined: Vec<String> = ctx
        .nodes
        .values()
        .filter_map(|node| match node {
            GraphNodeView::File { path, missing, .. }
            | GraphNodeView::Media { path, missing, .. }
                if !missing =>
            {
                Some(path.clone())
            }
            _ => None,
        })
        .collect();
    for path in unspined {
        let clean = path.trim_matches('/');
        if clean.is_empty() {
            continue;
        }
        let parent = parent_directory(clean);
        ctx.ensure_directory_path(&parent);
        ctx.push_contains_edge(directory_node_id(&parent), clean.to_string());
    }
}

#[cfg(test)]
fn merge_filesystem_layer(
    workspace: &chan_workspace::Workspace,
    p: &GraphParams,
    nodes: &mut std::collections::BTreeMap<String, GraphNodeView>,
    edges: &mut Vec<GraphEdgeView>,
) -> Result<(), super::fs_graph::FsGraphError> {
    let report_buckets = report_buckets_for_graph(workspace);
    let walk = TreeWalk::of(workspace);
    merge_filesystem_layer_with_buckets(workspace, p, &walk, nodes, edges, &report_buckets)
}

fn merge_filesystem_layer_with_buckets(
    workspace: &chan_workspace::Workspace,
    p: &GraphParams,
    walk: &TreeWalk,
    nodes: &mut std::collections::BTreeMap<String, GraphNodeView>,
    edges: &mut Vec<GraphEdgeView>,
    report_buckets: &std::collections::HashMap<String, ReportFileBucket>,
) -> Result<(), super::fs_graph::FsGraphError> {
    let path = graph_scope_path(p);
    let scope = match p.scope {
        GraphScope::File => FsGraphScope::File,
        GraphScope::Workspace | GraphScope::Directory => FsGraphScope::Directory,
    };
    let fs_graph = build_fs_graph(workspace, scope, path, p.depth)?;
    let mut id_map = std::collections::BTreeMap::new();
    let broken_targets: std::collections::BTreeSet<String> = fs_graph
        .nodes
        .iter()
        .filter(|node| node.broken)
        .map(|node| node.id.clone())
        .collect();

    for node in fs_graph.nodes {
        let id = fs_node_graph_id(&node);
        id_map.insert(node.id.clone(), id.clone());
        match node.kind {
            "directory" => {
                merge_directory_node(nodes, id, node.name, node.path, node.path_class, 0, 0)
            }
            _ if is_media_graph_path(&node.path) => {
                nodes.entry(id.clone()).or_insert(GraphNodeView::Media {
                    id,
                    label: node.name,
                    path: node.path,
                    path_class: node.path_class,
                    missing: node.broken,
                });
            }
            _ => {
                nodes.entry(id.clone()).or_insert(GraphNodeView::File {
                    id,
                    label: node.name,
                    path: node.path,
                    path_class: node.path_class,
                    node_kind: None,
                    bucket: None,
                    missing: node.broken,
                });
            }
        }
    }

    for edge in fs_graph.edges {
        let source = id_map
            .get(&edge.source)
            .cloned()
            .unwrap_or(edge.source.clone());
        let target = id_map
            .get(&edge.target)
            .cloned()
            .unwrap_or(edge.target.clone());
        // A symlink and a hardlink keep their own kinds: they are facts of
        // the tree, not references a document makes, and the graph draws
        // them apart from its links.
        let broken =
            (edge.kind == "symlink" && broken_targets.contains(&edge.target)).then_some(true);
        edges.push(GraphEdgeView {
            source,
            target,
            kind: edge.kind,
            broken,
            rank: None,
            files: None,
            code: None,
        });
    }

    // The scoped fs_graph walk gives us rich symlink and permission
    // details for the requested neighbourhood. The unified tree pass
    // then fills in the full public namespace so the semantic graph
    // keeps the same file coverage as the File Browser, regardless
    // of the current visual depth.
    merge_unified_tree_layer(workspace, p, walk, nodes, edges, report_buckets);

    Ok(())
}

fn report_buckets_for_graph(
    workspace: &chan_workspace::Workspace,
) -> std::collections::HashMap<String, ReportFileBucket> {
    workspace
        .report()
        .map(|r| {
            r.files
                .into_iter()
                .filter_map(|f| f.bucket.map(|b| (f.path, b)))
                .collect()
        })
        .unwrap_or_default()
}

fn apply_report_buckets(
    nodes: &mut std::collections::BTreeMap<String, GraphNodeView>,
    report_buckets: &std::collections::HashMap<String, ReportFileBucket>,
) {
    for (path, bucket_value) in report_buckets {
        if let Some(GraphNodeView::File { bucket, .. }) = nodes.get_mut(path) {
            *bucket = Some(bucket_value.clone());
        }
    }
}

/// Stamp `node_kind: "contact"` on every File node whose path is a
/// contact, regardless of which layer created it. The semantic batch
/// only stamps contacts that survive `should_emit_contact_file`
/// (i.e. `@@mention`-referenced ones); the filesystem tree layer then
/// re-adds the rest as plain File nodes with `node_kind: None`. Without
/// this pass a contact that is only cross-linked (not `@@`-mentioned)
/// reaches the graph via the tree spine and renders with the generic
/// markdown glyph instead of the contact treatment. Stamps existing
/// nodes only; it never adds a node, so the `should_emit_contact_file`
/// declutter (drop unreferenced standalone contacts) still holds.
fn stamp_contact_kinds(
    nodes: &mut std::collections::BTreeMap<String, GraphNodeView>,
    contact_paths: &std::collections::HashSet<String>,
) {
    for path in contact_paths {
        if let Some(GraphNodeView::File { node_kind, .. }) = nodes.get_mut(path) {
            *node_kind = Some("contact");
        }
    }
}

fn merge_language_layer(
    workspace: &chan_workspace::Workspace,
    _p: &GraphParams,
    nodes: &mut std::collections::BTreeMap<String, GraphNodeView>,
    edges: &mut Vec<GraphEdgeView>,
) -> chan_workspace::Result<()> {
    // The workspace-graph language layer emits Language -> File
    // edges directly so the language lens (1-hop BFS in GraphPanel)
    // splays out to EVERY file of that language. It does not go
    // through `build_language_graph`, which aggregates files into
    // per-directory edges with a depth-bounded top-N rank: the
    // lens's 1-hop neighbours would then be directories (only the
    // top-ranked ones under a depth) rather than files. The
    // Workspace filesystem layer already emits each file as a node
    // + the contains-edges that anchor it to the spine, so per-file
    // language edges plug straight into the rendered graph.
    //
    // /api/graph/languages uses `build_language_graph` for the
    // overview's directory rollup (with `?depth=N` ranking); only
    // the workspace lens takes this per-file path.
    //
    // The file-NODE set comes from the unified tree
    // layer (the full File Browser namespace), and the language
    // EDGE set comes from the FULL workspace report -- the SAME
    // namespace as the nodes. A scope-restricted report
    // (`report_for_prefix` / `report_for_files`) would miss the
    // spine and link-target files the tree layer pulls in from
    // OUTSIDE the scoped prefix in directory and file scope, so
    // those file nodes would have no language edge and render
    // disconnected (floating) even when they are of a recognized
    // language. Per-file language comes from `report.files` (whose
    // `language` is `tokei`'s classification and is never empty for
    // a tracked file); a `language` edge is emitted for every File
    // node already present in `nodes` that the report tracks.
    // Media/binary files return no language from the report (and
    // are separate node kinds), so they never get a spurious edge.
    // Language-node `files`/`code` counts aggregate only over the
    // file nodes actually rendered.

    let report = workspace.report()?;
    let language_by_path: std::collections::HashMap<&str, &str> = report
        .files
        .iter()
        .filter_map(|f| {
            let language = f.language.trim();
            if language.is_empty() {
                None
            } else {
                Some((f.path.as_str(), language))
            }
        })
        .collect();
    let code_by_path: std::collections::HashMap<&str, u64> = report
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.code))
        .collect();

    // Walk the file nodes the graph already holds; emit one
    // Language -> File edge per file node the report classifies.
    let mut by_language: std::collections::BTreeMap<&str, (u64, u64)> =
        std::collections::BTreeMap::new();
    let mut language_edges: Vec<(String, String)> = Vec::new();
    for node in nodes.values() {
        let GraphNodeView::File { path, .. } = node else {
            continue;
        };
        let Some(&language) = language_by_path.get(path.as_str()) else {
            continue;
        };
        let entry = by_language.entry(language).or_default();
        entry.0 += 1;
        entry.1 += code_by_path.get(path.as_str()).copied().unwrap_or(0);
        language_edges.push((language_node_id(language), path.clone()));
    }

    for (language, (files_count, code_count)) in &by_language {
        let id = language_node_id(language);
        nodes.insert(
            id.clone(),
            GraphNodeView::Language {
                id,
                label: (*language).to_string(),
                language: (*language).to_string(),
                files: *files_count,
                code: *code_count,
            },
        );
    }

    for (source, target) in language_edges {
        edges.push(GraphEdgeView {
            source,
            target,
            kind: "language",
            broken: None,
            rank: None,
            files: None,
            code: None,
        });
    }

    Ok(())
}

pub async fn api_language_graph(
    State(state): State<Arc<AppState>>,
    Query(p): Query<LanguageGraphParams>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    blocking_response("language graph", move || {
        let report = match workspace.report() {
            Ok(r) => r,
            Err(e) => return err_from(&e),
        };
        let mut graph = build_language_graph(&report.files, p.depth, p.language.as_deref());
        if let Some(language) = p.language.as_deref() {
            match language_detail_scoped(&workspace, &report.files, language) {
                Ok(detail) => graph.detail = Some(detail),
                Err(e) => return err_from(&e),
            }
        }
        Json(graph).into_response()
    })
    .await
}

pub async fn api_graph(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(q): Query<GraphQuery>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let stream = query_flag(&q.stream);
    let params = q.into_params();
    // While a full rebuild holds the index, the graph DB is saturated by
    // the reindex writer (esp. on Windows, where reindex pacing can't read
    // fd pressure). Reading it here would queue behind that work and
    // freeze the workspace window's graph panel. Return an empty graph
    // immediately instead; the SPA re-fetches when indexing completes
    // (indexing-state poll + invalidateGraph), so the panel fills in
    // once the build is done rather than hanging now. The empty answer
    // says `gated`, so a client does not keep it as the workspace's graph.
    if workspace.is_reindexing() {
        if stream {
            return empty_graph_stream_response(params).await;
        }
        return Json(GraphViewResponse {
            nodes: Vec::new(),
            edges: Vec::new(),
            gated: true,
        })
        .into_response();
    }
    if stream {
        return stream_graph_response(
            state.bulk_transfer.stall_signal(),
            workspace,
            params,
            accepts_gzip(&headers),
        )
        .await;
    }
    blocking_response("graph", move || api_graph_sync(workspace, params)).await
}

/// Whether a request's `Accept-Encoding` takes a gzip answer: its `gzip`
/// coding, or else its `*`, with a quality above zero.
fn accepts_gzip(headers: &axum::http::HeaderMap) -> bool {
    let mut gzip = None;
    let mut any = None;
    for value in headers.get_all(header::ACCEPT_ENCODING) {
        let Ok(value) = value.to_str() else { continue };
        for coding in value.split(',') {
            let mut parts = coding.split(';');
            let name = parts.next().unwrap_or("").trim();
            let quality = parts
                .filter_map(|param| {
                    let (key, q) = param.split_once('=')?;
                    key.trim()
                        .eq_ignore_ascii_case("q")
                        .then(|| q.trim().parse::<f32>().ok())?
                })
                .next()
                .unwrap_or(1.0);
            if name.eq_ignore_ascii_case("gzip") {
                gzip = Some(quality);
            } else if name == "*" {
                any = Some(quality);
            }
        }
    }
    gzip.or(any).is_some_and(|q| q > 0.0)
}

/// A body stream gzipped frame by frame: each frame is compressed and
/// sync-flushed as it arrives, so a client decodes every line the route has
/// produced while it builds the next. A compressor left to choose its own
/// block boundaries, as the route's compression layer does, holds those
/// lines until a block fills, which on a large workspace is long enough for
/// the client to give the stream up as stalled. The end writes the gzip
/// trailer; an error ends the stream without one, so a cut answer never
/// reads as whole.
fn gzip_each_frame(
    frames: impl futures::Stream<Item = std::io::Result<Bytes>> + Send + 'static,
) -> impl futures::Stream<Item = std::io::Result<Bytes>> + Send {
    use futures::StreamExt;
    use std::io::Write;

    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    futures::stream::unfold(Some((Box::pin(frames), encoder)), |state| async move {
        let (mut frames, mut encoder) = state?;
        match frames.next().await {
            Some(Ok(frame)) => {
                let out = encoder
                    .write_all(&frame)
                    .and_then(|()| encoder.flush())
                    .map(|()| Bytes::from(std::mem::take(encoder.get_mut())));
                let next = out.is_ok().then_some((frames, encoder));
                Some((out, next))
            }
            Some(Err(e)) => Some((Err(e), None)),
            None => Some((encoder.finish().map(Bytes::from), None)),
        }
    })
    .fuse()
}

/// Holds a graph stream's producer after its `meta` event until the test
/// that asked lets it go, so the test can read what a client has while the
/// server is still building. Keyed by the workspace root, so tests that run
/// at once never share a hold. A test can also shorten the stream's
/// keep-alive for the requests its own thread opens.
#[cfg(test)]
pub(crate) mod stream_hold {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Condvar, LazyLock, Mutex};

    type Hold = Arc<(Mutex<bool>, Condvar)>;

    thread_local! {
        /// The keep-alive period of the graph streams this thread's requests
        /// open, in place of the route's.
        pub(crate) static KEEPALIVE: std::cell::Cell<Option<std::time::Duration>> =
            const { std::cell::Cell::new(None) };
    }

    static HOLDS: LazyLock<Mutex<HashMap<PathBuf, Hold>>> = LazyLock::new(Default::default);

    /// The hold on one workspace's streams; dropping it lets them go.
    pub(crate) struct Held {
        root: PathBuf,
        hold: Hold,
    }

    /// Hold every graph stream of the workspace at `root` after its `meta`.
    pub(crate) fn hold(root: &Path) -> Held {
        let hold: Hold = Arc::default();
        HOLDS
            .lock()
            .unwrap()
            .insert(root.to_path_buf(), Arc::clone(&hold));
        Held {
            root: root.to_path_buf(),
            hold,
        }
    }

    impl Drop for Held {
        fn drop(&mut self) {
            HOLDS.lock().unwrap().remove(&self.root);
            let (released, wake) = &*self.hold;
            *released.lock().unwrap() = true;
            wake.notify_all();
        }
    }

    pub(super) fn wait(root: &Path) {
        let Some(hold) = HOLDS.lock().unwrap().get(root).cloned() else {
            return;
        };
        let (released, wake) = &*hold;
        let mut released = released.lock().unwrap();
        while !*released {
            released = wake.wait(released).unwrap();
        }
    }
}

/// Empty NDJSON graph stream (`meta` + `done`, no nodes/edges) returned
/// while a full rebuild holds the index, its `meta` marked `gated`. Mirrors
/// the wire shape of a normal `?stream=1` response so the SPA's stream
/// consumer completes cleanly and simply renders nothing until its
/// post-index re-fetch.
async fn empty_graph_stream_response(p: GraphParams) -> Response {
    empty_graph_stream_from_metadata(graph_ndjson_bytes(&GraphStreamEvent::Meta {
        scope: p.scope,
        path: p.path.clone(),
        depth: p.depth,
        gated: true,
    }))
}

fn empty_graph_stream_from_metadata(metadata: Result<Bytes, serde_json::Error>) -> Response {
    let mut bytes = match metadata {
        Ok(b) => b.to_vec(),
        Err(e) => {
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("graph stream meta encode: {e}"),
            )
        }
    };
    bytes.extend_from_slice(&graph_ndjson_error_bytes_or_done());
    (
        [(header::CONTENT_TYPE, "application/x-ndjson")],
        Body::from(bytes),
    )
        .into_response()
}

fn graph_ndjson_error_bytes_or_done() -> Bytes {
    match graph_ndjson_bytes(&GraphStreamEvent::Done) {
        Ok(b) => b,
        Err(e) => graph_ndjson_error_bytes(format!("graph stream done encode: {e}")),
    }
}

fn api_graph_sync(workspace: Arc<chan_workspace::Workspace>, p: GraphParams) -> Response {
    let mut emit = None;
    match build_graph_view(workspace, p, &mut emit) {
        Ok(view) => Json(view).into_response(),
        Err(e) => e.into_response(),
    }
}

fn stream_graph_sync<F>(
    workspace: Arc<chan_workspace::Workspace>,
    p: GraphParams,
    mut emit: F,
) -> Result<(), GraphBuildError>
where
    F: FnMut(Bytes) -> bool,
{
    let mut send_event = |event: GraphStreamEvent| -> bool {
        match graph_ndjson_bytes(&event) {
            Ok(bytes) => emit(bytes),
            Err(e) => emit(graph_ndjson_error_bytes(format!(
                "failed to encode graph stream event: {e}"
            ))),
        }
    };

    if !send_event(GraphStreamEvent::Meta {
        scope: p.scope,
        path: p.path.clone(),
        depth: p.depth,
        gated: false,
    }) {
        return Err(GraphBuildError::Cancelled);
    }
    #[cfg(test)]
    stream_hold::wait(workspace.root());

    {
        let mut event_emit = |event| send_event(event);
        let mut event_emit = Some(&mut event_emit as &mut dyn FnMut(GraphStreamEvent) -> bool);
        build_graph_view(workspace, p, &mut event_emit)?;
    }

    if !send_event(GraphStreamEvent::Done) {
        return Err(GraphBuildError::Cancelled);
    }
    Ok(())
}

async fn stream_graph_response(
    signal: crate::bulk_transfer::BulkCancel,
    workspace: Arc<chan_workspace::Workspace>,
    p: GraphParams,
    gzip: bool,
) -> Response {
    let mut bridge = crate::stream_bridge::StreamBridge::spawn(signal, move |frames| {
        let result = stream_graph_sync(workspace, p, |bytes| {
            frames.send(GraphStreamMessage::Data(bytes))
        });
        match result {
            Ok(()) | Err(GraphBuildError::Cancelled) => {}
            Err(e) => {
                frames.send(GraphStreamMessage::Error(e));
            }
        }
    });

    let first = match bridge.first().await {
        Some(GraphStreamMessage::Data(bytes)) => bytes,
        Some(GraphStreamMessage::Error(e)) => return e.into_response(),
        None => {
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "graph stream ended before metadata".into(),
            )
        }
    };
    let render = |message: GraphStreamMessage| match message {
        GraphStreamMessage::Data(bytes) => bytes,
        GraphStreamMessage::Error(e) => graph_ndjson_error_bytes(e.to_string()),
    };
    let frames = keep_alive(bridge.into_stream(first, render), graph_stream_keepalive());
    if gzip {
        // Encoded here rather than by the route's compression layer, which
        // passes an answer that carries its own encoding through as it is.
        let body = Body::from_stream(gzip_each_frame(frames));
        return (
            [
                (header::CONTENT_TYPE, "application/x-ndjson"),
                (header::CONTENT_ENCODING, "gzip"),
                (header::VARY, "accept-encoding"),
            ],
            body,
        )
            .into_response();
    }
    let body = Body::from_stream(frames);
    ([(header::CONTENT_TYPE, "application/x-ndjson")], body).into_response()
}

/// How long the graph stream may send nothing before it sends an empty
/// `nodes` batch. A client gives a stream up as stalled after a silence
/// (the SPA's `GRAPH_STALL_MS`, 30 s), and the build that runs before the
/// first batch and between batches outlasts that on a large workspace; any
/// event resets the client's count, and an empty batch adds nothing to the
/// view.
const GRAPH_STREAM_KEEPALIVE: std::time::Duration = std::time::Duration::from_secs(10);

fn graph_stream_keepalive() -> std::time::Duration {
    #[cfg(test)]
    if let Some(period) = stream_hold::KEEPALIVE.with(std::cell::Cell::get) {
        return period;
    }
    GRAPH_STREAM_KEEPALIVE
}

/// `frames`, with an empty `nodes` event whenever `period` passes with no
/// frame. The frame the wait was for is not lost: the stream's own pending
/// receive outlives the wait.
fn keep_alive(
    frames: impl futures::Stream<Item = std::io::Result<Bytes>> + Send + 'static,
    period: std::time::Duration,
) -> impl futures::Stream<Item = std::io::Result<Bytes>> + Send {
    use futures::StreamExt;

    futures::stream::unfold(Box::pin(frames), move |mut frames| async move {
        match tokio::time::timeout(period, frames.next()).await {
            Ok(Some(frame)) => Some((frame, frames)),
            Ok(None) => None,
            Err(_) => {
                let empty = graph_ndjson_bytes(&GraphStreamEvent::Nodes { nodes: Vec::new() })
                    .map_err(std::io::Error::other);
                Some((empty, frames))
            }
        }
    })
    .fuse()
}

fn build_graph_view(
    workspace: Arc<chan_workspace::Workspace>,
    p: GraphParams,
    emit: &mut Option<&mut dyn FnMut(GraphStreamEvent) -> bool>,
) -> Result<GraphViewResponse, GraphBuildError> {
    // The graph DB intentionally outlives source files, so it can still return
    // indexed nodes after the workspace root itself has vanished. Root loss is
    // not an ordinary broken-link view: fail with the shared typed condition
    // before reading either the persisted graph or the filesystem layer.
    workspace.ensure_root_available()?;
    let graph = workspace.graph()?;
    let files = graph.files()?;
    let tags = graph.tags()?;
    let mut all_edges = Vec::new();
    for f in &files {
        all_edges.extend(graph.neighbors(f)?);
    }

    // Image files (and other non-markdown regular files: LICENSE,
    // source files, scripts) aren't graph nodes because the indexer
    // skips non-markdown content. Without enumerating them here, any
    // `[text](LICENSE)` or `[code](src/lib.rs)` link would land on a
    // ghost "file does not exist" node even when the file is right
    // there on disk. We walk the workspace once and use the result as the
    // link resolver's universe; images are the image subset of that
    // walk (Media node kind) while everything else gets the regular
    // File treatment further down. The folder layer reads the same walk.
    //
    // Directory entries come from the same walk. Markdown links whose
    // target is a directory (e.g. `[notes](../notes/)`) stay out of
    // `ghost_set`, and the edge filter below drops their edges.
    //
    // Over the listing cap the walk lists directories alone, so each link
    // target that is a file is looked up on disk instead;
    // `link_targets_on_disk` states the cost.
    let graph_file_set: std::collections::BTreeSet<&str> =
        files.iter().map(String::as_str).collect();
    let walk = TreeWalk::of(&workspace);
    let looked_up;
    let (disk_files, disk_dirs) = match &walk {
        TreeWalk::Listed { files, dirs } => (files, dirs),
        TreeWalk::OverCap { dirs } => {
            looked_up =
                link_targets_on_disk(&workspace, &all_edges, &graph_file_set, dirs.as_ref());
            (&looked_up.0, dirs.as_ref().unwrap_or(&looked_up.1))
        }
        TreeWalk::Failed => {
            looked_up = Default::default();
            (&looked_up.0, &looked_up.1)
        }
    };
    let image_files = image_subset(disk_files);
    let present_files: std::collections::BTreeSet<&str> = files
        .iter()
        .filter(|path| indexed_file_exists(&workspace, path))
        .map(String::as_str)
        .collect();

    // Contact-kind file set, used to stamp `node_kind: "contact"` on
    // file nodes so the visualizer can render `chan.kind: contact`
    // notes (Contacts/alice.md, etc.) with the contact treatment
    // rather than the generic doc shape. Single SQL scan; cheap
    // compared to N per-node `node_kind` lookups.
    //
    // Also serves as the lookup table for the @@mention -> contact
    // file rewrite below: a contact whose file_stem matches the
    // mention name (case-insensitive) gets its rel_path stamped on
    // the mention edge's dst, so `@@alice` collapses into the
    // Contacts/alice.md file node instead of rendering as a
    // standalone yellow text node.
    let contact_rows = workspace.contacts().unwrap_or_default();
    let contact_paths: std::collections::HashSet<String> =
        contact_rows.iter().map(|c| c.rel_path.clone()).collect();
    // `graph_file_set` is the indexed-only view; `file_set` is the
    // full link-resolution oracle (graph + all on-disk files). Keep
    // both: graph_file_set drives the "is this a real graph node?"
    // gate used when synthesizing referenced-disk-file nodes, while
    // file_set is what resolve_link_dst and ghost classification
    // consult.
    let mut file_set = graph_file_set.clone();
    for f in disk_files {
        file_set.insert(f.as_str());
    }
    let mut present_file_set = present_files.clone();
    for f in disk_files {
        present_file_set.insert(f.as_str());
    }

    // Rewrite link-edge targets so URL-encoded / source-relative
    // markdown links land on the real file node (clickable in the
    // inspector). Genuine ghosts get the decoded form so the label
    // reads "my note" instead of "my%20note".
    //
    // Mention-edge targets get a similar rewrite: `@@alice` is
    // remapped to `Contacts/alice.md` when a contact file with the
    // matching file_stem exists. The two would otherwise render as
    // separate nodes (yellow `@@alice` text node + yellow rectangle
    // contact node), even though they refer to the same person.
    // Unresolved mentions keep their `@@name` dst and fall through to
    // the synthesized Mention node below.
    //
    // Track contact file paths referenced by mention edges. The per-file emit
    // filter keeps only participating contacts. Resolved contacts remain concrete
    // file nodes; unresolved mentions synthesize a `@@name` Mention node via the
    // mention_set loop.
    let normalization = normalize_graph_edges(&mut all_edges, &file_set, &contact_rows);
    let referenced_contact_paths: std::collections::HashSet<String> =
        normalization.referenced_contact_paths.into_iter().collect();

    // Track which image / other-disk files are actually referenced
    // by a link edge so we only emit nodes for ones that participate
    // in the graph. Unreferenced files would inflate the node count
    // without adding any edges, which is purely visual noise.
    //
    // `referenced_disk_files` covers the non-markdown case: a markdown
    // link to LICENSE / a .rs source / a shell script lands on a real
    // file node here instead of falling through to ghost_set as a
    // "missing" target.
    let mut referenced_images: std::collections::BTreeSet<String> =
        std::collections::BTreeSet::new();
    let mut referenced_disk_files: std::collections::BTreeSet<String> =
        std::collections::BTreeSet::new();
    for e in &all_edges {
        if !matches!(e.kind, EdgeKind::Link) {
            continue;
        }
        if image_files.contains(&e.dst) {
            referenced_images.insert(e.dst.clone());
        } else if disk_files.contains(&e.dst) && !graph_file_set.contains(e.dst.as_str()) {
            referenced_disk_files.insert(e.dst.clone());
        }
    }

    // Build the node list. File nodes for every indexed path; tag
    // nodes per #tag; mention nodes per distinct @@name. Image
    // file nodes for any image actually referenced by an edge (the
    // indexer skips images, so they aren't in `files` even when
    // they exist on disk). Unresolved link targets are NOT rendered:
    // a `[[...]]` / `[](...)` whose dst exists neither in the index
    // nor on disk produces no node (and its edge is dropped below), so
    // graphing chan's own source shows no ghost clutter.
    //
    // Contact-frontmatter files that AREN'T
    // referenced by any `@@mention` resolution are skipped. The
    // graph view's job is "who-mentions-whom"; an imported contact
    // never mentioned anywhere contributes nothing to that picture.
    //
    // The first node batch intentionally skips chan-report buckets
    // so streaming callers can draw the semantic graph before the
    // report layer finishes. A later node batch re-sends final node
    // values with bucket metadata filled in.
    let mut nodes: std::collections::BTreeMap<String, GraphNodeView> =
        std::collections::BTreeMap::new();
    for path in &files {
        if !should_emit_contact_file(path, &contact_paths, &referenced_contact_paths) {
            // Imported but unreferenced contact: skip. See
            // `should_emit_contact_file` for the audit framing.
            continue;
        }
        let is_contact = contact_paths.contains(path);
        nodes.insert(
            path.clone(),
            GraphNodeView::File {
                id: path.clone(),
                label: file_label(path),
                path: path.clone(),
                path_class: path_class_for_graph(&workspace, path),
                node_kind: if is_contact { Some("contact") } else { None },
                bucket: None,
                missing: !present_files.contains(path.as_str()),
            },
        );
    }
    for img in &referenced_images {
        nodes.insert(
            img.clone(),
            GraphNodeView::Media {
                id: img.clone(),
                label: file_label(img),
                path: img.clone(),
                path_class: path_class_for_graph(&workspace, img),
                missing: false,
            },
        );
    }
    // Existing non-markdown, non-image files (LICENSE, source code,
    // shell scripts) referenced by a link. Treated as regular File
    // nodes so the canvas renders them solid (not ghost-stroked) and
    // the inspector treats them as real files. `merge_filesystem_layer`
    // would otherwise add these too, but only at depth <= the
    // request's depth cap; emitting them here makes the resolution
    // depth-independent.
    for f in &referenced_disk_files {
        nodes.insert(
            f.clone(),
            GraphNodeView::File {
                id: f.clone(),
                label: file_label(f),
                path: f.clone(),
                path_class: path_class_for_graph(&workspace, f),
                node_kind: None,
                bucket: None,
                missing: false,
            },
        );
    }
    for tag in &tags {
        let id = format!("#{}", tag.name);
        nodes.insert(
            id.clone(),
            GraphNodeView::Tag {
                id: id.clone(),
                label: id,
            },
        );
    }
    let mut mention_set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut ghost_set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for e in &all_edges {
        // Defensive: skip edges that resolved to an empty dst.
        // Cytoscape rejects nodes with an empty string id; without
        // this filter a legacy database with an empty-target edge
        // (pre-empty-target-skip extractor) blocks the whole graph
        // render with "Can not create element with invalid string
        // ID ``".
        if e.dst.is_empty() {
            continue;
        }
        match e.kind {
            EdgeKind::Mention => {
                // Only synthesize a standalone @@name node for
                // mentions that didn't resolve to a real contact
                // file. Resolved mentions point at the contact's
                // file node, which already exists in `files`.
                if !file_set.contains(e.dst.as_str()) {
                    mention_set.insert(e.dst.clone());
                }
            }
            EdgeKind::Link => {
                if !file_set.contains(e.dst.as_str()) && !disk_dirs.contains(&e.dst) {
                    ghost_set.insert(e.dst.clone());
                }
            }
            EdgeKind::Tag => {}
        }
    }
    for m in &mention_set {
        nodes.insert(
            m.clone(),
            GraphNodeView::Mention {
                id: m.clone(),
                label: m.clone(),
            },
        );
    }
    // No ghost nodes: a muted `File { missing: true }` per
    // unresolved link target is pure clutter on a big tree (e.g.
    // graphing a source checkout) and never navigable. `ghost_set`
    // ONLY drives the edge drop in the filter below, so a broken
    // link contributes neither a node nor a dangling edge. (Indexed
    // files that vanished from disk still render as `missing` via
    // the `files` loop above; that is a stale-index signal,
    // distinct from an unresolved link target.)

    // This graph contains only workspace-root files. Sidecar draft nodes are
    // drawn by the client from the draft list, without content or link edges.
    emit_graph_nodes(emit, nodes.values().cloned().collect())?;

    let mut edges: Vec<GraphEdgeView> = all_edges
        .iter()
        // Same defensive guard as the node-set above: an edge with
        // an empty endpoint would point at a node we never created
        // (ghosts / mentions / tags filter empty dsts), and
        // Cytoscape errors on empty source/target ids the same as
        // empty node ids.
        //
        // Also drop link edges whose dst is a directory on disk:
        // the ghost-set loop above keeps those out of `ghost_set`,
        // so the edge would otherwise dangle against a non-existent
        // node. Non-link edges (mention, tag) can't have a directory
        // dst (mention dsts are `@@name`, tag dsts are `#name`),
        // so the filter only matters for the link kind.
        .filter(|e| {
            if e.src.is_empty() || e.dst.is_empty() {
                return false;
            }
            // Drop link edges whose dst is a directory.
            // They have no node to point at after the ghost-set
            // guard above.
            if matches!(e.kind, EdgeKind::Link) && disk_dirs.contains(&e.dst) {
                return false;
            }
            // Drop link edges to unresolved targets. Nothing
            // synthesizes ghost nodes for them, so the edge would
            // otherwise dangle against a node we never created (and
            // Cytoscape errors on an edge to a missing node id).
            if matches!(e.kind, EdgeKind::Link) && ghost_set.contains(&e.dst) {
                return false;
            }
            true
        })
        .map(|e| GraphEdgeView {
            source: e.src.clone(),
            // chan-workspace stores the leading `#` / `@@` sigil on the
            // tag/mention edge's dst already (Workspace::build_edges
            // does the formatting), and the matching tag node ids
            // we emit above use the same `#name` shape. So the
            // wire-shape target is the plain dst with no extra
            // prefix; adding another `#` would produce `##name` and
            // orphan every tag edge.
            target: e.dst.clone(),
            kind: edge_kind_tag(e.kind),
            broken: match e.kind {
                EdgeKind::Link => Some(!present_file_set.contains(e.dst.as_str())),
                _ => None,
            },
            rank: None,
            files: None,
            code: None,
        })
        .collect();
    let emitted_edge_len = edges.len();
    emit_graph_edges(emit, edges.clone())?;

    let report_buckets = report_buckets_for_graph(&workspace);
    apply_report_buckets(&mut nodes, &report_buckets);
    merge_filesystem_layer_with_buckets(
        &workspace,
        &p,
        &walk,
        &mut nodes,
        &mut edges,
        &report_buckets,
    )?;
    merge_language_layer(&workspace, &p, &mut nodes, &mut edges)?;
    // The filesystem tree layer adds contact files as plain File nodes;
    // re-stamp the contact discriminator so cross-linked (not
    // @@mentioned) contacts keep the contact glyph in the final batch.
    stamp_contact_kinds(&mut nodes, &contact_paths);

    emit_graph_nodes(emit, nodes.values().cloned().collect())?;
    emit_graph_edges(emit, edges[emitted_edge_len..].to_vec())?;

    Ok(GraphViewResponse {
        nodes: nodes.into_values().collect(),
        edges,
        gated: false,
    })
}

/// Incoming link edges for one file. The frontend uses this for
/// the "linked from" panel. chan-workspace's `backlinks` filters to
/// link-kind edges already; we just pass through.
/// Backlinks payload shape: matches `ApiEdge` (lowercase `kind`)
/// so the frontend's `GraphEdge` type doesn't have to special-case
/// PascalCase versus lowercase across endpoints. `Edge.kind`'s
/// default `Serialize` would emit `"Link"` / `"Mention"` / `"Tag"`,
/// which `FileInfoBody`'s `kind === "link"` filter then rejects
/// and surfaced as "0 linked from" in the inspector.
#[derive(Debug, Clone, serde::Serialize)]
struct ApiBacklinkEdge {
    src: String,
    dst: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    anchor: Option<String>,
}

#[derive(Deserialize)]
pub struct BacklinksQuery {
    #[serde(default)]
    stream: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum BacklinksStreamEvent<'a> {
    Meta { path: &'a str },
    Edge { edge: ApiBacklinkEdge },
    Done,
    Error { error: String },
}

enum BacklinksStreamMessage {
    Data(Bytes),
    Error(chan_workspace::ChanError),
}

pub async fn api_backlinks(
    State(state): State<Arc<AppState>>,
    AxumPath(path): AxumPath<String>,
    Query(query): Query<BacklinksQuery>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let stream = query_flag(&query.stream);
    // During the first index build the graph DB is contended; reading
    // backlinks here would queue behind the reindex writer and freeze
    // the inspector's "linked from" panel on file-open. Return empty
    // now; the SPA re-fetches once indexing completes.
    if workspace.is_reindexing() {
        if stream {
            return empty_backlinks_stream_response(path).await;
        }
        return Json(Vec::<ApiBacklinkEdge>::new()).into_response();
    }
    if stream {
        return stream_backlinks_response(state.bulk_transfer.stall_signal(), workspace, path)
            .await;
    }
    blocking_response("backlinks", move || api_backlinks_sync(workspace, path)).await
}

/// Empty NDJSON backlinks stream (`meta` + `done`) returned while the
/// first index builds. Same wire shape as a normal `?stream=1` response
/// so the SPA consumer completes cleanly with no edges.
async fn empty_backlinks_stream_response(path: String) -> Response {
    empty_backlinks_stream_from_metadata(backlinks_ndjson_bytes(&BacklinksStreamEvent::Meta {
        path: path.as_str(),
    }))
}

fn empty_backlinks_stream_from_metadata(metadata: Result<Bytes, serde_json::Error>) -> Response {
    let mut bytes = match metadata {
        Ok(b) => b.to_vec(),
        Err(e) => {
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("backlinks stream meta encode: {e}"),
            )
        }
    };
    let done = match backlinks_ndjson_bytes(&BacklinksStreamEvent::Done) {
        Ok(b) => b,
        Err(e) => backlinks_ndjson_error_bytes(format!("backlinks stream done encode: {e}")),
    };
    bytes.extend_from_slice(&done);
    (
        [(header::CONTENT_TYPE, "application/x-ndjson")],
        Body::from(bytes),
    )
        .into_response()
}

fn api_backlinks_sync(workspace: Arc<chan_workspace::Workspace>, path: String) -> Response {
    match backlinks_for_path(&workspace, &path, |_| true) {
        Ok(edges) => Json(edges).into_response(),
        Err(e) => err_from(&e),
    }
}

fn backlinks_ndjson_bytes(event: &BacklinksStreamEvent<'_>) -> Result<Bytes, serde_json::Error> {
    let mut line = serde_json::to_vec(event)?;
    line.push(b'\n');
    Ok(Bytes::from(line))
}

fn backlinks_ndjson_error_bytes(error: String) -> Bytes {
    match backlinks_ndjson_bytes(&BacklinksStreamEvent::Error { error }) {
        Ok(bytes) => bytes,
        Err(e) => Bytes::from(format!(
            "{{\"type\":\"error\",\"error\":\"failed to encode backlinks stream error: {e}\"}}\n"
        )),
    }
}

fn emit_backlinks_event<F>(
    emit: &mut F,
    event: BacklinksStreamEvent<'_>,
) -> chan_workspace::Result<bool>
where
    F: FnMut(Bytes) -> bool,
{
    let bytes = backlinks_ndjson_bytes(&event).map_err(|e| {
        chan_workspace::ChanError::Io(format!("failed to encode backlinks stream event: {e}"))
    })?;
    Ok(emit(bytes))
}

fn stream_backlinks_sync<F>(
    workspace: &chan_workspace::Workspace,
    path: &str,
    mut emit: F,
) -> chan_workspace::Result<()>
where
    F: FnMut(Bytes) -> bool,
{
    if !emit_backlinks_event(&mut emit, BacklinksStreamEvent::Meta { path })? {
        return Ok(());
    }

    let mut encode_error = None;
    let result = backlinks_for_path(workspace, path, |edge| {
        match emit_backlinks_event(&mut emit, BacklinksStreamEvent::Edge { edge: edge.clone() }) {
            Ok(keep_going) => keep_going,
            Err(e) => {
                encode_error = Some(e);
                false
            }
        }
    });
    if let Some(e) = encode_error {
        return Err(e);
    }
    result?;

    emit_backlinks_event(&mut emit, BacklinksStreamEvent::Done)?;
    Ok(())
}

async fn stream_backlinks_response(
    signal: crate::bulk_transfer::BulkCancel,
    workspace: Arc<chan_workspace::Workspace>,
    path: String,
) -> Response {
    let mut bridge = crate::stream_bridge::StreamBridge::spawn(signal, move |frames| {
        let result = stream_backlinks_sync(&workspace, &path, |bytes| {
            frames.send(BacklinksStreamMessage::Data(bytes))
        });
        match result {
            Ok(()) | Err(chan_workspace::ChanError::Cancelled) => {}
            Err(e) => {
                frames.send(BacklinksStreamMessage::Error(e));
            }
        }
    });

    let first = match bridge.first().await {
        Some(BacklinksStreamMessage::Data(bytes)) => bytes,
        Some(BacklinksStreamMessage::Error(e)) => return err_from(&e),
        None => {
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "backlinks stream ended before metadata".into(),
            )
        }
    };
    let body = bridge.into_body(first, |message| match message {
        BacklinksStreamMessage::Data(bytes) => bytes,
        BacklinksStreamMessage::Error(e) => backlinks_ndjson_error_bytes(e.to_string()),
    });
    ([(header::CONTENT_TYPE, "application/x-ndjson")], body).into_response()
}

fn backlinks_for_path<F>(
    workspace: &chan_workspace::Workspace,
    path: &str,
    mut emit: F,
) -> chan_workspace::Result<Vec<ApiBacklinkEdge>>
where
    F: FnMut(&ApiBacklinkEdge) -> bool,
{
    let graph = workspace.graph()?;

    // chan-workspace stores the verbatim authored target on each link
    // edge ("./img.png", "attachments/pic.png", "../foo/x.md"), so
    // its SQL backlinks(dst=?) query misses every source-relative
    // reference. We mirror api_graph's resolution: walk all
    // outgoing edges, resolve link dsts against the workspace's file
    // set, then keep the ones that land on `path`. Slightly more
    // expensive than the SQL filter, but on the same order as the
    // graph load the inspector just ran.
    let files = graph.files()?;
    // Same resolver universe as `api_graph`: graph files + every
    // regular on-disk file. Without this, `[link](LICENSE)` from a
    // README would not show up in LICENSE's backlinks because the
    // resolver couldn't tell that "LICENSE" was a real file. Over the
    // listing cap, or when the walk fails, the graph files stand alone.
    let disk_files: std::collections::BTreeSet<String> =
        match workspace.list_tree_filtered_unified() {
            Ok(entries) => entries
                .into_iter()
                .filter(|e| !e.is_dir)
                .map(|e| e.path)
                .collect(),
            Err(_) => std::collections::BTreeSet::new(),
        };
    let mut file_set: std::collections::BTreeSet<&str> = files.iter().map(String::as_str).collect();
    for f in &disk_files {
        file_set.insert(f.as_str());
    }

    let mut out: Vec<ApiBacklinkEdge> = Vec::new();
    for f in &files {
        let edges = graph.neighbors(f)?;
        for e in edges {
            if !matches!(e.kind, EdgeKind::Link) {
                continue;
            }
            let resolved = resolve_link_dst(&e.src, &e.dst, &file_set);
            if resolved == path {
                let edge = ApiBacklinkEdge {
                    src: e.src,
                    dst: resolved,
                    kind: edge_kind_tag(e.kind),
                    anchor: e.anchor,
                };
                if !emit(&edge) {
                    return Err(chan_workspace::ChanError::Cancelled);
                }
                out.push(edge);
            }
        }
    }
    out.sort_by(|a, b| a.src.cmp(&b.src));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelled_graph_refusal_is_json() {
        super::super::refusal_tests::assert_refusal(
            GraphBuildError::Cancelled.into_response(),
            StatusCode::INTERNAL_SERVER_ERROR,
            serde_json::json!({"error": "graph stream cancelled"}),
        )
        .await;
    }

    #[tokio::test]
    async fn graph_metadata_encode_refusal_is_json() {
        let error = <serde_json::Error as serde::ser::Error>::custom("metadata unavailable");
        super::super::refusal_tests::assert_refusal(
            empty_graph_stream_from_metadata(Err(error)),
            StatusCode::INTERNAL_SERVER_ERROR,
            serde_json::json!({"error": "graph stream meta encode: metadata unavailable"}),
        )
        .await;
    }

    #[tokio::test]
    async fn backlinks_metadata_encode_refusal_is_json() {
        let error = <serde_json::Error as serde::ser::Error>::custom("metadata unavailable");
        super::super::refusal_tests::assert_refusal(
            empty_backlinks_stream_from_metadata(Err(error)),
            StatusCode::INTERNAL_SERVER_ERROR,
            serde_json::json!({"error": "backlinks stream meta encode: metadata unavailable"}),
        )
        .await;
    }

    /// A workspace app over one indexed file that carries a tag, behind a
    /// bearer token.
    struct GraphRouteApp {
        _cfg: tempfile::TempDir,
        _root: tempfile::TempDir,
        state: Arc<AppState>,
    }

    fn graph_route_app() -> GraphRouteApp {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace
            .write_text("notes/doc.md", "# doc\n\n#graph-pin\n")
            .unwrap();
        workspace.index_file("notes/doc.md").unwrap();
        let state = Arc::new(AppState {
            token: Some("secret".to_string()),
            ..crate::state::test_support::workspace_app_state(
                lib,
                root.path().to_path_buf(),
                workspace,
            )
        });
        GraphRouteApp {
            _cfg: cfg,
            _root: root,
            state,
        }
    }

    /// Wait, within a bound, until no recovery pass of the workspace is
    /// running or queued, so that the open's own recovery is not taken for
    /// the pass a test begins.
    async fn recovery_settled(workspace: &chan_workspace::Workspace) {
        let settled = async {
            loop {
                let recovery = workspace.recovery_status();
                if recovery.active.is_none() && recovery.pending.is_none() {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(60), settled)
            .await
            .expect("fixture: the workspace's own recovery never settled");
    }

    /// The body of a `GET` of `uri` through the app's router.
    async fn graph_route_body(app: &GraphRouteApp, uri: &str) -> String {
        use tower::ServiceExt;

        let request = axum::http::Request::builder()
            .uri(uri)
            .header(header::AUTHORIZATION, "Bearer secret")
            .body(Body::empty())
            .unwrap();
        let response = crate::router(Arc::clone(&app.state))
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "GET {uri}");
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        String::from_utf8(body.to_vec()).unwrap()
    }

    /// The events of an NDJSON graph stream, one per line.
    fn graph_stream_events(body: &str) -> Vec<serde_json::Value> {
        body.lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).expect("a graph stream line"))
            .collect()
    }

    /// Both forms of `/api/graph` answer the graph, the file's tag in it,
    /// with no `gated` field.
    async fn assert_the_graph_is_answered_ungated(app: &GraphRouteApp, when: &str) {
        let stream = graph_route_body(app, "/api/graph?stream=1").await;
        assert!(
            stream.contains("graph-pin"),
            "fixture: {when}, the graph stream does not hold the file's tag: {stream}"
        );
        for event in graph_stream_events(&stream) {
            assert!(
                event.get("gated").is_none(),
                "{when}, a graph stream event carries a gated field: {event}"
            );
        }
        let body = graph_route_body(app, "/api/graph").await;
        assert!(
            body.contains("graph-pin"),
            "fixture: {when}, the graph answer does not hold the file's tag: {body}"
        );
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(
            json.get("gated").is_none(),
            "{when}, the graph answer carries a gated field: {body}"
        );
    }

    // While a full rebuild holds the index, the graph route answers its
    // empty graph and says so with `gated`: on the stream's meta event,
    // before done, and beside the empty lists of the JSON answer. Every
    // other answer carries no such field, so an answer without it is the
    // graph. No clock decides it: the test puts the pass in the active slot
    // and takes it out, and the indexer's coordinator claims no pass while
    // one is active.
    #[tokio::test]
    async fn a_graph_answer_gated_by_a_full_rebuild_says_so() {
        let app = graph_route_app();
        let workspace = app.state.try_workspace().expect("graph route workspace");
        recovery_settled(&workspace).await;
        assert_the_graph_is_answered_ungated(&app, "with no rebuild begun").await;

        // No await between the two: the coordinator cannot claim the pass.
        workspace.request_recovery(chan_workspace::RecoveryAction::FullRebuild);
        let pass = workspace
            .begin_recovery()
            .expect("fixture: a full rebuild to put in the active slot");
        assert!(
            workspace.is_reindexing(),
            "fixture: no full rebuild holds the index"
        );

        let stream = graph_route_body(&app, "/api/graph?stream=1").await;
        let events = graph_stream_events(&stream);
        let kinds: Vec<&str> = events
            .iter()
            .map(|event| event["type"].as_str().unwrap_or("?"))
            .collect();
        assert_eq!(
            kinds,
            ["meta", "done"],
            "the gated graph stream is not its meta event and done: {stream}"
        );
        assert_eq!(
            events[0].get("gated"),
            Some(&serde_json::Value::Bool(true)),
            "the gated graph stream's meta event does not say gated: {stream}"
        );
        let body = graph_route_body(&app, "/api/graph").await;
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"nodes": [], "edges": [], "gated": true}),
            "the gated graph answer is not the empty graph marked gated"
        );

        workspace
            .finish_recovery(pass, chan_workspace::RecoveryOutcome::Complete)
            .expect("fixture: finish the pass");
        recovery_settled(&workspace).await;
        assert_the_graph_is_answered_ungated(&app, "with the rebuild finished").await;
    }

    /// The answer to a `GET` of `uri` from a client that sends
    /// `accept_encoding`, when it sends one: the `Content-Encoding` the
    /// answer carries and its body as sent.
    async fn graph_route_answer(
        app: &GraphRouteApp,
        uri: &str,
        accept_encoding: Option<&str>,
    ) -> (Option<String>, Vec<u8>) {
        use tower::ServiceExt;

        let mut request = axum::http::Request::builder()
            .uri(uri)
            .header(header::AUTHORIZATION, "Bearer secret");
        if let Some(accepted) = accept_encoding {
            request = request.header(header::ACCEPT_ENCODING, accepted);
        }
        let response = crate::router(Arc::clone(&app.state))
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "GET {uri}");
        let encoding = response
            .headers()
            .get(header::CONTENT_ENCODING)
            .map(|value| value.to_str().unwrap().to_string());
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (encoding, body.to_vec())
    }

    // The graph is megabytes on a real workspace, so a client that accepts
    // gzip is sent it compressed, stream or not, and reads back the bytes
    // the plain answer carries. A client that does not ask, or asks for
    // encodings the route does not speak, is sent the plain answer.
    #[tokio::test]
    async fn a_graph_answer_is_gzipped_for_a_client_that_accepts_it() {
        use std::io::Read;

        let app = graph_route_app();
        let workspace = app.state.try_workspace().expect("graph route workspace");
        recovery_settled(&workspace).await;

        for uri in ["/api/graph?stream=1", "/api/graph"] {
            let (encoding, plain) = graph_route_answer(&app, uri, None).await;
            assert_eq!(
                encoding, None,
                "{uri}: an answer nobody asked to compress carries an encoding"
            );
            assert!(
                plain.starts_with(b"{"),
                "{uri}: the plain answer is not JSON"
            );

            // What a browser sends.
            let (encoding, sent) =
                graph_route_answer(&app, uri, Some("gzip, deflate, br, zstd")).await;
            assert_eq!(
                encoding.as_deref(),
                Some("gzip"),
                "{uri}: a client that accepts gzip is not sent gzip"
            );
            let mut read = Vec::new();
            flate2::read::GzDecoder::new(sent.as_slice())
                .read_to_end(&mut read)
                .expect("the body sent as gzip is gzip");
            assert_eq!(
                String::from_utf8_lossy(&read),
                String::from_utf8_lossy(&plain),
                "{uri}: the gzipped answer does not read back as the plain one"
            );

            let (encoding, sent) = graph_route_answer(&app, uri, Some("br, zstd")).await;
            assert_eq!(
                encoding, None,
                "{uri}: a client that does not accept gzip is sent an encoding"
            );
            assert_eq!(
                sent, plain,
                "{uri}: a client that does not accept gzip is not sent the plain answer"
            );
        }
    }

    // A gzip client decodes each line of the graph stream as the route
    // produces it: while the server is still building, here held after its
    // `meta` event, the client already holds the `meta` line, and once the
    // build goes on it reads the rest and the gzip trailer. A compressor that
    // keeps its output until a block fills sends nothing a client can decode
    // until the build is over.
    #[tokio::test]
    async fn a_gzip_client_decodes_each_graph_stream_line_as_it_is_produced() {
        use futures::StreamExt;
        use std::io::Write;
        use tower::ServiceExt;

        let app = graph_route_app();
        let workspace = app.state.try_workspace().expect("graph route workspace");
        recovery_settled(&workspace).await;
        let held = stream_hold::hold(workspace.root());

        let request = axum::http::Request::builder()
            .uri("/api/graph?stream=1")
            .header(header::AUTHORIZATION, "Bearer secret")
            .header(header::ACCEPT_ENCODING, "gzip")
            .body(Body::empty())
            .unwrap();
        let response = crate::router(Arc::clone(&app.state))
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_ENCODING)
                .map(|value| value.to_str().unwrap()),
            Some("gzip")
        );
        let mut body = response.into_body().into_data_stream();
        let mut decoded = flate2::write::GzDecoder::new(Vec::new());
        let first_line = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !decoded.get_ref().contains(&b'\n') {
                let chunk = body
                    .next()
                    .await
                    .expect("the stream ended while the server was held")
                    .expect("a body chunk");
                decoded.write_all(&chunk).unwrap();
                decoded.flush().unwrap();
            }
        })
        .await;
        assert!(
            first_line.is_ok(),
            "a gzip client decoded no line while the server was still building: {:?}",
            String::from_utf8_lossy(decoded.get_ref())
        );
        assert!(
            decoded.get_ref().starts_with(b"{\"type\":\"meta\""),
            "the first line is not the meta event: {}",
            String::from_utf8_lossy(decoded.get_ref())
        );

        drop(held);
        while let Some(chunk) = body.next().await {
            decoded.write_all(&chunk.unwrap()).unwrap();
        }
        let whole = String::from_utf8(decoded.finish().expect("the gzip trailer")).unwrap();
        assert!(
            whole.ends_with("{\"type\":\"done\"}\n"),
            "the stream does not end with its done event: {whole}"
        );
    }

    // A stream whose build runs long still reaches its client: while the
    // producer is held after `meta`, the client keeps getting empty `nodes`
    // batches, any of which resets a client's stall count, and once the build
    // goes on it gets the rest.
    #[tokio::test]
    async fn a_graph_stream_sends_empty_batches_while_its_build_runs() {
        use futures::StreamExt;
        use tower::ServiceExt;

        let app = graph_route_app();
        let workspace = app.state.try_workspace().expect("graph route workspace");
        recovery_settled(&workspace).await;
        let held = stream_hold::hold(workspace.root());
        stream_hold::KEEPALIVE
            .with(|period| period.set(Some(std::time::Duration::from_millis(100))));

        let request = axum::http::Request::builder()
            .uri("/api/graph?stream=1")
            .header(header::AUTHORIZATION, "Bearer secret")
            .body(Body::empty())
            .unwrap();
        let response = crate::router(Arc::clone(&app.state))
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut body = response.into_body().into_data_stream();
        let mut text = String::new();
        let held_lines = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while text.lines().count() < 3 {
                let chunk = body
                    .next()
                    .await
                    .expect("the stream ended while the server was held")
                    .expect("a body chunk");
                text.push_str(&String::from_utf8_lossy(&chunk));
            }
        })
        .await;
        stream_hold::KEEPALIVE.with(|period| period.set(None));
        assert!(
            held_lines.is_ok(),
            "the held stream went silent after: {text:?}"
        );
        let lines: Vec<&str> = text.lines().collect();
        assert!(lines[0].starts_with("{\"type\":\"meta\""), "{text}");
        assert_eq!(lines[1], "{\"type\":\"nodes\",\"nodes\":[]}");
        assert_eq!(lines[2], "{\"type\":\"nodes\",\"nodes\":[]}");

        drop(held);
        while let Some(chunk) = body.next().await {
            text.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
        }
        assert!(text.ends_with("{\"type\":\"done\"}\n"), "{text}");
    }

    #[test]
    fn a_request_accepts_gzip_by_its_gzip_coding_or_else_its_wildcard() {
        let accepts = |value: &str| {
            let mut headers = axum::http::HeaderMap::new();
            headers.insert(header::ACCEPT_ENCODING, value.parse().unwrap());
            accepts_gzip(&headers)
        };
        assert!(accepts("gzip, deflate, br, zstd"));
        assert!(accepts("GZIP;q=0.5"));
        assert!(accepts("br, *"));
        assert!(!accepts("br, zstd"));
        assert!(!accepts("gzip;q=0, br"));
        assert!(
            !accepts("gzip; q=0.0, *"),
            "an explicit refusal of gzip wins over the wildcard"
        );
        assert!(!accepts("identity"));
        assert!(!accepts_gzip(&axum::http::HeaderMap::new()));
    }

    fn report_file(path: &str, language: &str, code: u64) -> ReportFileStats {
        ReportFileStats {
            path: path.to_string(),
            language: language.to_string(),
            code,
            comments: 0,
            blanks: 0,
            complexity: 0,
            bytes: 0,
            mtime: None,
            bucket: None,
        }
    }

    fn open_workspace() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        std::sync::Arc<chan_workspace::Workspace>,
    ) {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        (cfg, root, workspace)
    }

    /// The file and directory sets of the whole-tree walk of `workspace`,
    /// which must be under the listing cap.
    fn listed(
        workspace: &chan_workspace::Workspace,
    ) -> (
        std::collections::BTreeSet<String>,
        std::collections::BTreeSet<String>,
    ) {
        match TreeWalk::of(workspace) {
            TreeWalk::Listed { files, dirs } => (files, dirs),
            TreeWalk::OverCap { .. } => panic!("fixture: the walk is over the cap"),
            TreeWalk::Failed => panic!("fixture: the walk failed"),
        }
    }

    fn put(root: &std::path::Path, rel: &str, body: &[u8]) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, body).unwrap();
    }

    fn event_types(lines: &[Bytes]) -> Vec<String> {
        lines
            .iter()
            .map(|line| {
                let value: serde_json::Value = serde_json::from_slice(line).unwrap();
                value
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap()
                    .to_string()
            })
            .collect()
    }

    fn has_node_kind(
        nodes: &std::collections::BTreeMap<String, GraphNodeView>,
        kind: &str,
    ) -> bool {
        nodes.values().any(|node| {
            matches!(
                (kind, node),
                ("directory", GraphNodeView::Directory { .. })
                    | ("file", GraphNodeView::File { .. })
                    | ("media", GraphNodeView::Media { .. })
                    | ("language", GraphNodeView::Language { .. })
                    | ("tag", GraphNodeView::Tag { .. })
                    | ("mention", GraphNodeView::Mention { .. })
            )
        })
    }

    #[test]
    fn graph_stream_emits_meta_batches_and_done() {
        let (_cfg, root, workspace) = open_workspace();
        put(
            root.path(),
            "notes/a.md",
            b"# A\n\n[[notes/b.md]]\n#topic\n",
        );
        put(root.path(), "notes/b.md", b"# B\n");
        workspace.index_file("notes/a.md").unwrap();
        workspace.index_file("notes/b.md").unwrap();

        let params = GraphParams {
            scope: GraphScope::Workspace,
            path: String::new(),
            depth: 2,
        };
        let mut lines = Vec::new();
        stream_graph_sync(workspace, params, |bytes| {
            lines.push(bytes);
            true
        })
        .unwrap();

        let types = event_types(&lines);
        assert_eq!(types.first().map(String::as_str), Some("meta"));
        assert!(types.iter().any(|t| t == "nodes"), "got {types:?}");
        assert!(types.iter().any(|t| t == "edges"), "got {types:?}");
        assert_eq!(types.last().map(String::as_str), Some("done"));
    }

    #[test]
    fn backlinks_stream_emits_meta_edges_and_done() {
        let (_cfg, root, workspace) = open_workspace();
        put(root.path(), "notes/a.md", b"# A\n\n[[notes/b.md]]\n");
        put(root.path(), "notes/b.md", b"# B\n");
        workspace.index_file("notes/a.md").unwrap();
        workspace.index_file("notes/b.md").unwrap();

        let mut lines = Vec::new();
        stream_backlinks_sync(&workspace, "notes/b.md", |bytes| {
            lines.push(bytes);
            true
        })
        .unwrap();

        let types = event_types(&lines);
        assert_eq!(types.first().map(String::as_str), Some("meta"));
        assert!(types.iter().any(|t| t == "edge"), "got {types:?}");
        assert_eq!(types.last().map(String::as_str), Some("done"));
    }

    /// The graph stream batches nodes 128 to a frame, so a workspace whose
    /// graph holds more than a thousand nodes outruns the channel; with the
    /// response unpolled the producer must give up within the stall bound.
    #[test]
    fn unread_graph_stream_frees_its_pool_thread() {
        let (_cfg, root, workspace) = open_workspace();
        let tags: Vec<String> = (0..1200).map(|i| format!("#t{i}")).collect();
        put(
            root.path(),
            "notes/tags.md",
            format!("# Tags\n\n{}\n", tags.join(" ")).as_bytes(),
        );
        workspace.index_file("notes/tags.md").unwrap();
        let params = || GraphParams {
            scope: GraphScope::Workspace,
            path: String::new(),
            depth: 2,
        };
        let mut frames = 0;
        stream_graph_sync(workspace.clone(), params(), |_| {
            frames += 1;
            true
        })
        .unwrap();
        assert!(
            frames > crate::stream_bridge::BRIDGE_CAPACITY + 1,
            "the producer must outrun the channel, got {frames} frames"
        );
        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
        let bulk = bulk.with_stall_timeout(std::time::Duration::from_millis(25));
        let body = crate::stream_bridge::test_support::assert_unread_stream_frees_its_pool_thread(
            "graph stream",
            || stream_graph_response(bulk.stall_signal(), workspace, params(), false),
        );
        assert!(
            body.is_err(),
            "an abandoned stream must fail its body rather than end short"
        );
    }

    /// The backlinks stream sends one frame per linking note, so a dozen
    /// notes pointing at one target outrun the channel.
    #[test]
    fn unread_backlinks_stream_frees_its_pool_thread() {
        let (_cfg, root, workspace) = open_workspace();
        put(root.path(), "notes/target.md", b"# Target\n");
        workspace.index_file("notes/target.md").unwrap();
        for i in 0..12 {
            let path = format!("notes/from-{i}.md");
            put(root.path(), &path, b"[[notes/target.md]]\n");
            workspace.index_file(&path).unwrap();
        }
        let mut frames = 0;
        stream_backlinks_sync(&workspace, "notes/target.md", |_| {
            frames += 1;
            true
        })
        .unwrap();
        assert!(
            frames > crate::stream_bridge::BRIDGE_CAPACITY + 1,
            "the producer must outrun the channel, got {frames} frames"
        );
        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
        let bulk = bulk.with_stall_timeout(std::time::Duration::from_millis(25));
        let body = crate::stream_bridge::test_support::assert_unread_stream_frees_its_pool_thread(
            "backlinks stream",
            || stream_backlinks_response(bulk.stall_signal(), workspace, "notes/target.md".into()),
        );
        assert!(
            body.is_err(),
            "an abandoned stream must fail its body rather than end short"
        );
    }

    #[test]
    fn workspace_disk_files_includes_non_markdown_targets() {
        // The link resolver in `api_graph` walks the workspace once
        // (`TreeWalk::of`) and uses its files as the universe of
        // valid link targets. Without this, a `[mit](LICENSE)` or
        // `[code](src/lib.rs)` link from a markdown file would fall
        // through to the ghost path, even though both files are
        // sitting on disk. Pin the contract: every regular file the
        // user might link to has to show up here.
        let (_cfg, root, workspace) = open_workspace();
        put(root.path(), "LICENSE", b"MIT\n");
        put(root.path(), "src/lib.rs", b"pub fn x() {}\n");
        put(root.path(), "scripts/build.sh", b"#!/bin/sh\n");
        put(root.path(), "notes/a.md", b"# A\n");

        let (disk, _) = listed(&workspace);
        assert!(disk.contains("LICENSE"), "got {disk:?}");
        assert!(disk.contains("src/lib.rs"));
        assert!(disk.contains("scripts/build.sh"));
        assert!(disk.contains("notes/a.md"));
    }

    #[test]
    fn link_to_non_markdown_disk_file_resolves_to_real_file() {
        // A markdown link to a non-graph regular file (LICENSE, src/lib.rs, ...)
        // resolves to the FS layer's real `File { missing: false }` entry.
        // `disk_files` participates in `file_set` so `ghost_set` stays empty for
        // the LICENSE case and `referenced_disk_files` picks it up.
        let (_cfg, root, workspace) = open_workspace();
        // Use a wiki link so the dst lands on workspace-rooted "LICENSE"
        // rather than the source-relative "notes/LICENSE" that bare
        // markdown semantics would produce.
        put(root.path(), "notes/intro.md", b"# Intro\n\n[[LICENSE]]\n");
        put(root.path(), "LICENSE", b"MIT\n");
        workspace.index_file("notes/intro.md").unwrap();

        let graph = workspace.graph().unwrap();
        let edges = graph.neighbors("notes/intro.md").unwrap();
        let link = edges
            .iter()
            .find(|e| matches!(e.kind, EdgeKind::Link))
            .expect("indexed markdown link edge");
        // chan-workspace stores the verbatim authored target on the edge.
        assert_eq!(link.dst, "LICENSE");

        let (disk, _) = listed(&workspace);
        assert!(disk.contains("LICENSE"), "got {disk:?}");

        let graph_files = graph.files().unwrap();
        let graph_file_set: std::collections::BTreeSet<&str> =
            graph_files.iter().map(String::as_str).collect();
        assert!(!graph_file_set.contains("LICENSE"));

        // Mirror the file_set construction in api_graph: graph files
        // plus every regular on-disk file. LICENSE has to land in the
        // union so the resolver does not synthesize a ghost.
        let mut file_set = graph_file_set.clone();
        for f in &disk {
            file_set.insert(f.as_str());
        }
        assert!(file_set.contains("LICENSE"));

        // referenced_disk_files trigger: disk_files contains LICENSE,
        // graph_file_set does not, and it is not an image. api_graph emits a
        // File { missing: false } node for it rather than dropping the link
        // as unresolved.
        assert!(disk.contains("LICENSE"));
        assert!(!graph_file_set.contains("LICENSE"));
        assert!(!is_image_path("LICENSE"));
    }

    #[test]
    fn workspace_disk_dirs_includes_directory_entries() {
        // Pin the helper contract: every regular directory
        // the user might link to has to show up here so api_graph can
        // recognise `[label](some/dir/)` targets and keep them out of
        // `ghost_set`. The walk's file set is unaffected (it takes the
        // entries that are not directories).
        let (_cfg, root, workspace) = open_workspace();
        put(root.path(), "docs/intro.md", b"# Intro\n");
        put(root.path(), "docs/agents/alice.md", b"# alice\n");
        put(root.path(), "notes/inner/deep.md", b"# deep\n");

        let (files, dirs) = listed(&workspace);
        assert!(dirs.contains("docs"), "got {dirs:?}");
        assert!(dirs.contains("docs/agents"));
        assert!(dirs.contains("notes"));
        assert!(dirs.contains("notes/inner"));
        // Files should not appear in the dirs set.
        assert!(!dirs.contains("docs/intro.md"));
        assert!(!dirs.contains("docs/agents/alice.md"));

        // Files set stays clean of directories. The walk splits one
        // listing into the two sets; pin that the split is exclusive.
        assert!(files.contains("docs/intro.md"));
        assert!(!files.contains("docs"));
        assert!(!files.contains("docs/agents"));
    }

    #[test]
    fn link_to_directory_does_not_synthesize_ghost_file_node() {
        // A markdown link whose target is a directory (e.g.
        // `[notes](../notes/)`) must not land in ghost_set as
        // `File { missing: true }`: disk_dirs participates in the
        // ghost-set guard so the directory target is skipped
        // entirely; the corresponding link edge is dropped by the
        // edge filter so Cytoscape never sees a dangling target.
        let (_cfg, root, workspace) = open_workspace();
        // Source link: bare `some-dir` resolves workspace-rooted under
        // the wiki convention. `some-dir/` exists as a real
        // directory on disk (created by `put` writing a file under
        // it). Mirrors a real-repo shape where a markdown file links a
        // sibling directory (`[label](../sibling/)`) that exists on
        // disk.
        put(root.path(), "notes/intro.md", b"# Intro\n\n[[some-dir]]\n");
        put(root.path(), "some-dir/contents.md", b"# contents\n");
        workspace.index_file("notes/intro.md").unwrap();

        let graph = workspace.graph().unwrap();
        let edges = graph.neighbors("notes/intro.md").unwrap();
        let link = edges
            .iter()
            .find(|e| matches!(e.kind, EdgeKind::Link))
            .expect("indexed markdown link edge");
        assert_eq!(link.dst, "some-dir");

        let (disk_files, disk_dirs) = listed(&workspace);
        assert!(disk_dirs.contains("some-dir"), "got {disk_dirs:?}");
        // The link target is NOT a file on disk (it's the directory).
        // Pinning this rules out the referenced-disk-file path
        // accidentally covering the symptom.
        assert!(!disk_files.contains("some-dir"));

        // Simulate the api_graph ghost-set check: file_set is
        // graph_files union disk_files. Directory entries are absent
        // from file_set, so the disk_dirs guard keeps `some-dir` out
        // of ghost_set.
        let graph_files = graph.files().unwrap();
        let graph_file_set: std::collections::BTreeSet<&str> =
            graph_files.iter().map(String::as_str).collect();
        let mut file_set = graph_file_set.clone();
        for f in &disk_files {
            file_set.insert(f.as_str());
        }
        assert!(!file_set.contains(link.dst.as_str()));
        // The directory check wins, so the ghost set stays empty.
        let would_be_ghost =
            !file_set.contains(link.dst.as_str()) && !disk_dirs.contains(&link.dst);
        assert!(
            !would_be_ghost,
            "directory target should not become a ghost file node"
        );

        // Mirror the api_graph edge filter: link edges whose dst is
        // a directory get dropped so Cytoscape never sees them.
        let drop_for_empty = link.src.is_empty() || link.dst.is_empty();
        let drop_for_dir_dst = matches!(link.kind, EdgeKind::Link) && disk_dirs.contains(&link.dst);
        let keep_edge = !drop_for_empty && !drop_for_dir_dst;
        assert!(
            !keep_edge,
            "edge with dst pointing at a directory should be dropped"
        );
    }

    /// A workspace app over `workspace/` in a temporary directory that also
    /// holds `outside.log`. Its one indexed note, `notes/evidence.md`, links
    /// to a file and an image on disk, to a folder, to a missing file, out
    /// of the root (by an encoded `..`, and on Unix through a symlink to the
    /// directory above), into an excluded and an ignored directory, to an
    /// excluded folder, to a file the `.gitignore` names, to a file its
    /// negation re-includes under an ignored directory, and on Unix through
    /// a symlinked directory inside the root and to a symlink itself.
    fn evidence_route_app() -> GraphRouteApp {
        let cfg = tempfile::TempDir::new().unwrap();
        let outer = tempfile::TempDir::new().unwrap();
        let root = outer.path().join("workspace");
        put(outer.path(), "outside.log", b"outside\n");
        put(&root, "evidence/run1/trace.log", b"trace\n");
        put(&root, "evidence/run1/shot.png", b"png");
        put(&root, "evidence/run1/key.secret", b"key\n");
        put(&root, "node_modules/pkg/index.js", b"dep\n");
        put(&root, ".gitignore", b"build/\n!build/keep.log\n*.secret\n");
        put(&root, "build/out.log", b"built\n");
        put(&root, "build/keep.log", b"kept\n");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outer.path(), root.join("out")).unwrap();
            std::os::unix::fs::symlink("evidence", root.join("alias")).unwrap();
        }
        put(
            &root,
            "notes/evidence.md",
            b"# Evidence\n\n\
              [log](../evidence/run1/trace.log)\n\
              ![shot](../evidence/run1/shot.png)\n\
              [run](../evidence/run1/)\n\
              [gone](../evidence/run1/gone.log)\n\
              [[%2e%2e/outside.log]]\n\
              [[out/outside.log]]\n\
              [[node_modules/pkg/index.js]]\n\
              [[build/out.log]]\n\
              [[node_modules]]\n\
              [[evidence/run1/key.secret]]\n\
              [[build/keep.log]]\n\
              [[alias/run1/trace.log]]\n\
              [[out]]\n",
        );
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(&root).unwrap();
        let workspace = lib.open_workspace(&root).unwrap();
        workspace.index_file("notes/evidence.md").unwrap();
        let state = Arc::new(AppState {
            token: Some("secret".to_string()),
            ..crate::state::test_support::workspace_app_state(lib, root, workspace)
        });
        GraphRouteApp {
            _cfg: cfg,
            _root: outer,
            state,
        }
    }

    // Over the listing cap the whole-tree walk lists nothing, and the graph
    // resolves each link by its target on disk instead, as it does under the
    // cap: a link to a file or an image there lands on its node, and a link
    // to a missing file, out of the root, into an excluded or ignored
    // directory, to an ignored file, to a file a negation re-includes under
    // an ignored directory, or through a symlinked directory stays a ghost,
    // whose edge the graph drops; a link to a folder draws no ghost node.
    // That holds whether the directories come from the walk of directories
    // alone or, when they are over the cap too, from a stat of each. The
    // stored links are read first, so a dropped edge is a ghost and not a
    // link the index never kept.
    #[tokio::test]
    async fn links_resolve_by_their_targets_on_disk_over_the_listing_cap() {
        let app = evidence_route_app();
        let workspace = app.state.try_workspace().expect("graph route workspace");
        recovery_settled(&workspace).await;
        let stored: std::collections::BTreeSet<String> = workspace
            .graph()
            .unwrap()
            .neighbors("notes/evidence.md")
            .unwrap()
            .into_iter()
            .filter(|edge| matches!(edge.kind, EdgeKind::Link))
            .map(|edge| edge.dst)
            .collect();
        let expected_stored = [
            "%2e%2e/outside.log",
            "alias/run1/trace.log",
            "build/keep.log",
            "build/out.log",
            "evidence/run1",
            "evidence/run1/gone.log",
            "evidence/run1/key.secret",
            "evidence/run1/shot.png",
            "evidence/run1/trace.log",
            "node_modules",
            "node_modules/pkg/index.js",
            "out",
            "out/outside.log",
        ];
        assert_eq!(
            stored,
            expected_stored.map(String::from).into(),
            "fixture: the note's stored links"
        );

        let under = graph_route_body(&app, "/api/graph?depth=1").await;
        let limit =
            chan_workspace::workspace::listing_limit_test_hooks::lower_tree_walk(&workspace, 3);
        assert!(
            matches!(
                workspace.list_tree_filtered_unified(),
                Err(chan_workspace::ChanError::ListingTooLarge { .. })
            ),
            "fixture: the walk is not over the lowered cap"
        );
        let over = graph_route_body(&app, "/api/graph?depth=1").await;
        let directories = super::tree_walks::lower_directory_walk(workspace.root(), 1);
        assert_eq!(
            walk_directories(&workspace, 1),
            None,
            "fixture: the directories are not over the lowered bound"
        );
        let over_both = graph_route_body(&app, "/api/graph?depth=1").await;
        drop(directories);
        drop(limit);

        for (when, body) in [
            ("under the cap", under),
            ("over the cap", over),
            ("with the directories over the cap too", over_both),
        ] {
            let json: serde_json::Value = serde_json::from_str(&body).unwrap();
            let links: std::collections::BTreeMap<&str, Option<bool>> = json["edges"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|edge| edge["kind"] == "link" && edge["source"] == "notes/evidence.md")
                .map(|edge| (edge["target"].as_str().unwrap(), edge["broken"].as_bool()))
                .collect();
            assert_eq!(
                links,
                std::collections::BTreeMap::from([
                    ("evidence/run1/shot.png", Some(false)),
                    ("evidence/run1/trace.log", Some(false)),
                ]),
                "{when}, the note's links are not the two files on disk: {body}"
            );
            let nodes: std::collections::BTreeMap<&str, &serde_json::Value> = json["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|node| (node["id"].as_str().unwrap(), node))
                .collect();
            for (id, kind) in [
                ("evidence/run1/trace.log", "file"),
                ("evidence/run1/shot.png", "media"),
            ] {
                let node = nodes
                    .get(id)
                    .unwrap_or_else(|| panic!("{when}, no {id} node"));
                assert_eq!(node["kind"], kind, "{when}: {node}");
                assert!(node.get("missing").is_none(), "{when}: {node}");
            }
            for ghost in [
                "evidence/run1",
                "evidence/run1/gone.log",
                "../outside.log",
                "out/outside.log",
                "node_modules/pkg/index.js",
                "build/out.log",
                "evidence/run1/key.secret",
                "build/keep.log",
                "alias/run1/trace.log",
            ] {
                assert!(!nodes.contains_key(ghost), "{when}, {ghost} has a node");
            }
        }
    }

    // The lookup the graph makes over the listing cap, read directly, with
    // no walked directories, so each directory is statted: the route drops
    // the edge of a link to a folder whether it counts as a folder or as a
    // ghost, so only here does a folder show. Of the note's
    // targets it finds the file, the image and the folder on disk, and
    // neither the missing file nor one out of the root or out of scope, an
    // excluded folder, a symlink, or a path through a symlinked directory.
    #[tokio::test]
    async fn link_targets_on_disk_finds_files_and_folders_in_scope() {
        let app = evidence_route_app();
        let workspace = app.state.try_workspace().expect("graph route workspace");
        recovery_settled(&workspace).await;
        let graph = workspace.graph().unwrap();
        let indexed = graph.files().unwrap();
        let edges = graph.neighbors("notes/evidence.md").unwrap();

        let (files, dirs) = link_targets_on_disk(
            &workspace,
            &edges,
            &indexed.iter().map(String::as_str).collect(),
            None,
        );

        assert_eq!(
            files,
            ["evidence/run1/shot.png", "evidence/run1/trace.log"]
                .map(String::from)
                .into()
        );
        assert_eq!(dirs, ["evidence/run1".to_string()].into());
    }

    /// The deepest folder of `folder_layer_app`. It and its parent sit
    /// below the depth the shared graph asks of its depth-bounded
    /// filesystem layer (6), so only the tree layer draws them.
    const DEEP: &str = "deep/l2/l3/l4/l5/l6/l7/l8";

    /// A workspace app whose folders run below the depth the shared graph
    /// asks of its depth-bounded filesystem layer. Its indexed note links a
    /// second indexed note and an image in the deepest folder, beside a file
    /// nothing indexes or links, an empty folder, a folder the `.gitignore`
    /// names and an excluded one.
    fn folder_layer_app() -> GraphRouteApp {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let deep = root.path().join(DEEP);
        put(
            root.path(),
            ".gitignore",
            format!("{DEEP}/hidden/\n").as_bytes(),
        );
        put(
            root.path(),
            "notes/index.md",
            format!("# Index\n\n[[{DEEP}/leaf.md]]\n![pic](../{DEEP}/pic.png)\n").as_bytes(),
        );
        put(&deep, "leaf.md", b"# Leaf\n");
        put(&deep, "pic.png", b"png");
        put(&deep, "raw.bin", &[1, 2, 3]);
        put(&deep, "hidden/secret.md", b"# Hidden\n");
        put(&deep, "node_modules/pkg/index.js", b"dep\n");
        std::fs::create_dir(deep.join("empty")).unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.index_file("notes/index.md").unwrap();
        workspace.index_file(&format!("{DEEP}/leaf.md")).unwrap();
        let state = Arc::new(AppState {
            token: Some("secret".to_string()),
            ..crate::state::test_support::workspace_app_state(
                lib,
                root.path().to_path_buf(),
                workspace,
            )
        });
        GraphRouteApp {
            _cfg: cfg,
            _root: root,
            state,
        }
    }

    /// Lower the whole-tree walk's cap of `workspace` below its entries, and
    /// show the walk is over it.
    fn over_the_listing_cap(
        workspace: &chan_workspace::Workspace,
    ) -> chan_workspace::workspace::listing_limit_test_hooks::LimitGuard {
        let limit =
            chan_workspace::workspace::listing_limit_test_hooks::lower_tree_walk(workspace, 3);
        assert!(
            matches!(
                workspace.list_tree_filtered_unified(),
                Err(chan_workspace::ChanError::ListingTooLarge { .. })
            ),
            "fixture: the walk is not over the lowered cap"
        );
        limit
    }

    /// The shared graph's load of `folder_layer_app`, the JSON form, under
    /// the listing cap and then over it.
    async fn folder_layer_answers() -> [(&'static str, serde_json::Value); 2] {
        let app = folder_layer_app();
        let workspace = app.state.try_workspace().expect("graph route workspace");
        recovery_settled(&workspace).await;
        let under = graph_route_body(&app, "/api/graph").await;
        let limit = over_the_listing_cap(&workspace);
        let over = graph_route_body(&app, "/api/graph").await;
        drop(limit);
        [("under the cap", under), ("over the cap", over)]
            .map(|(when, body)| (when, serde_json::from_str(&body).unwrap()))
    }

    /// The folder ids of `folder_layer_app`, written from its tree: the
    /// root, `notes`, each folder down to `DEEP` and `DEEP/empty`. The
    /// ignored and excluded folders are not among them.
    fn folder_layer_folder_ids() -> std::collections::BTreeSet<String> {
        let mut ids = std::collections::BTreeSet::from([
            String::new(),
            "directory:notes".to_string(),
            format!("directory:{DEEP}/empty"),
        ]);
        let mut path = String::new();
        for part in DEEP.split('/') {
            if !path.is_empty() {
                path.push('/');
            }
            path.push_str(part);
            ids.insert(format!("directory:{path}"));
        }
        ids
    }

    /// The `(source, target)` of each `contains` edge in `answer`.
    fn contains_edges(answer: &serde_json::Value) -> std::collections::BTreeSet<(String, String)> {
        answer["edges"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|edge| edge["kind"] == "contains")
            .map(|edge| {
                (
                    edge["source"].as_str().unwrap().to_string(),
                    edge["target"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    }

    /// The nodes of `answer` by id.
    fn nodes_by_id(
        answer: &serde_json::Value,
    ) -> std::collections::BTreeMap<String, serde_json::Value> {
        answer["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|node| (node["id"].as_str().unwrap().to_string(), node.clone()))
            .collect()
    }

    // One graph load walks the whole tree once, in each of its forms and
    // scopes: the link resolver's file and directory sets and the folder
    // layer share that walk. Over the listing cap the load also walks the
    // directories alone, once; under it, never.
    #[tokio::test]
    async fn a_graph_load_walks_the_whole_tree_once() {
        use super::tree_walks::{taken, Walk};

        let app = folder_layer_app();
        let workspace = app.state.try_workspace().expect("graph route workspace");
        recovery_settled(&workspace).await;
        let root = workspace.root().to_path_buf();
        let walks = || (taken(&root, Walk::Listing), taken(&root, Walk::Directories));
        assert!(
            workspace.list_tree_filtered_unified().is_ok(),
            "fixture: the walk is over the cap before it is lowered"
        );
        for (when, over_cap) in [("under the cap", false), ("over the cap", true)] {
            let limit = over_cap.then(|| over_the_listing_cap(&workspace));
            for uri in [
                "/api/graph",
                "/api/graph?stream=1",
                "/api/graph?scope=directory&path=notes",
            ] {
                let (listings, directory_walks) = walks();
                graph_route_body(&app, uri).await;
                let (listings_after, directory_walks_after) = walks();
                assert_eq!(
                    listings_after - listings,
                    1,
                    "GET {uri} {when}: the whole-tree listings of one load"
                );
                assert_eq!(
                    directory_walks_after - directory_walks,
                    usize::from(over_cap),
                    "GET {uri} {when}: the directories-only walks of one load"
                );
            }
            drop(limit);
        }
    }

    // Over the listing cap the shared graph holds the root and every folder
    // in scope, and only those, as under it: the folders below the
    // depth-bounded filesystem layer's reach included, the ignored and
    // excluded ones left out. Each folder node is the one the graph holds
    // under the cap, its counts included.
    #[tokio::test]
    async fn over_the_listing_cap_the_graph_keeps_every_folder_in_scope() {
        let [(_, under), (_, over)] = folder_layer_answers().await;
        let expected = folder_layer_folder_ids();
        assert_eq!(expected.len(), 11, "fixture: the folders in scope");
        let folders =
            |answer: &serde_json::Value| -> std::collections::BTreeMap<String, serde_json::Value> {
                nodes_by_id(answer)
                    .into_iter()
                    .filter(|(_, node)| node["kind"] == "directory")
                    .collect()
            };
        let (under_folders, over_folders) = (folders(&under), folders(&over));
        assert_eq!(
            under_folders
                .keys()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>(),
            expected,
            "under the cap, the folder nodes"
        );
        assert_eq!(
            over_folders
                .keys()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>(),
            expected,
            "over the cap, the folder nodes"
        );
        assert_eq!(
            over_folders, under_folders,
            "over the cap, a folder node differs from the one under the cap"
        );
    }

    // Over the listing cap each folder but the root is joined to its parent
    // by one `contains` edge, as under the cap, and no other `contains` edge
    // runs between two folders.
    #[tokio::test]
    async fn over_the_listing_cap_the_graph_keeps_the_contains_edges_between_folders() {
        let [under, over] = folder_layer_answers().await;
        let folders = folder_layer_folder_ids();
        let expected: std::collections::BTreeSet<(String, String)> = folders
            .iter()
            .filter(|id| !id.is_empty())
            .map(|id| {
                let path = id.strip_prefix("directory:").unwrap();
                let parent = match path.rsplit_once('/') {
                    Some((parent, _)) => format!("directory:{parent}"),
                    None => String::new(),
                };
                (parent, id.clone())
            })
            .collect();
        assert_eq!(
            expected.len(),
            10,
            "fixture: one edge per folder but the root"
        );
        for (when, answer) in [under, over] {
            let between_folders: std::collections::BTreeSet<(String, String)> =
                contains_edges(&answer)
                    .into_iter()
                    .filter(|(source, target)| folders.contains(source) && folders.contains(target))
                    .collect();
            assert_eq!(
                between_folders, expected,
                "{when}, the contains edges between folders"
            );
        }
    }

    // Over the listing cap each file the shared graph holds (the two
    // indexed notes and the linked image) stays in its folder by its
    // `contains` edge, as under the cap. The walk over the cap lists no
    // file, so a file the graph holds for no other reason (`raw.bin`, which
    // nothing indexes or links) has a node only under the cap. Every other
    // `contains` edge is the one under the cap: none is lost, none added.
    #[tokio::test]
    async fn over_the_listing_cap_the_graph_keeps_each_file_it_holds_in_its_folder() {
        let [(_, under), (_, over)] = folder_layer_answers().await;
        let held = [
            ("directory:notes".to_string(), "notes/index.md".to_string()),
            (format!("directory:{DEEP}"), format!("{DEEP}/leaf.md")),
            (format!("directory:{DEEP}"), format!("{DEEP}/pic.png")),
        ];
        let raw = (format!("directory:{DEEP}"), format!("{DEEP}/raw.bin"));
        let (under_edges, over_edges) = (contains_edges(&under), contains_edges(&over));
        for edge in held.iter().chain([&raw]) {
            assert!(
                under_edges.contains(edge),
                "fixture: under the cap, no contains edge {edge:?}"
            );
        }
        for edge in &held {
            assert!(
                over_edges.contains(edge),
                "over the cap, no contains edge {edge:?}"
            );
        }
        let over_nodes = nodes_by_id(&over);
        assert!(
            !over_nodes.contains_key(&raw.1) && !over_edges.contains(&raw),
            "over the cap, the graph holds a file the walk listed: {:?}",
            over_nodes.get(&raw.1)
        );
        let expected_over: std::collections::BTreeSet<(String, String)> = under_edges
            .iter()
            .filter(|(_, target)| over_nodes.contains_key(target))
            .cloned()
            .collect();
        assert_eq!(
            over_edges, expected_over,
            "over the cap, the contains edges are not those under the cap into the nodes it holds"
        );
    }

    // The directories-only walk lists the directories the whole-tree
    // listing lists, the empty one included and the ignored and excluded
    // ones left out, and holds no more than its bound: at its bound it
    // answers them all, and one below it refuses instead of holding more.
    #[tokio::test]
    async fn the_directory_walk_lists_the_listings_directories_within_its_bound() {
        let app = folder_layer_app();
        let workspace = app.state.try_workspace().expect("graph route workspace");
        let (_, listed_dirs) = listed(&workspace);
        assert_eq!(
            listed_dirs.len(),
            10,
            "fixture: the listing's directories, {listed_dirs:?}"
        );
        assert_eq!(
            walk_directories(&workspace, listed_dirs.len()),
            Some(listed_dirs.clone()),
            "at its bound, the walk's directories"
        );
        assert_eq!(
            walk_directories(&workspace, listed_dirs.len() - 1),
            None,
            "one below its bound, the walk answers"
        );
    }

    // Given the walked directories, the lookup over the cap reads them for
    // the directories above a target and for a folder target, and stats
    // only a file target: it answers what the stat path answers, and
    // without `evidence/run1` in the set it finds neither that folder nor
    // the two files in it, though all three are on disk.
    #[tokio::test]
    async fn link_targets_on_disk_reads_folders_from_the_walked_directories() {
        let app = evidence_route_app();
        let workspace = app.state.try_workspace().expect("graph route workspace");
        recovery_settled(&workspace).await;
        let graph = workspace.graph().unwrap();
        let indexed = graph.files().unwrap();
        let indexed: std::collections::BTreeSet<&str> =
            indexed.iter().map(String::as_str).collect();
        let edges = graph.neighbors("notes/evidence.md").unwrap();
        let mut walked = walk_directories(&workspace, chan_workspace::fs_ops::LIST_TREE_LIMIT)
            .expect("fixture: the directories are over the cap");

        assert_eq!(
            link_targets_on_disk(&workspace, &edges, &indexed, Some(&walked)),
            link_targets_on_disk(&workspace, &edges, &indexed, None),
            "the walked directories answer otherwise than the stat path"
        );
        assert!(walked.remove("evidence/run1"), "fixture: {walked:?}");
        assert_eq!(
            link_targets_on_disk(&workspace, &edges, &indexed, Some(&walked)),
            Default::default(),
            "a target found below or at a directory the walk did not list"
        );
    }

    // A read-only folder is a dead end over the listing cap as under it: the
    // folder is drawn, and an indexed note inside it, which the graph holds,
    // is joined to it by no `contains` edge.
    #[cfg(unix)]
    #[test]
    fn over_the_listing_cap_a_read_only_folder_stays_a_dead_end() {
        use std::os::unix::fs::PermissionsExt;

        // Puts the directory's mode back when the test ends, pass or fail, so
        // that a user who is not root can remove the temp directory.
        struct ModeRestore(std::path::PathBuf, std::fs::Permissions);
        impl Drop for ModeRestore {
            fn drop(&mut self) {
                let _ = std::fs::set_permissions(&self.0, self.1.clone());
            }
        }

        let (_cfg, root, workspace) = open_workspace();
        put(root.path(), "top.md", b"# Top\n");
        put(root.path(), "notes/a.md", b"# A\n");
        put(root.path(), "locked/hidden.md", b"# Hidden\n");
        workspace.index_file("locked/hidden.md").unwrap();
        let locked = root.path().join("locked");
        let _restore = ModeRestore(
            locked.clone(),
            std::fs::metadata(&locked).unwrap().permissions(),
        );
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();

        let load = || {
            let mut emit = None;
            build_graph_view(
                Arc::clone(&workspace),
                GraphParams {
                    scope: GraphScope::Workspace,
                    path: String::new(),
                    depth: 6,
                },
                &mut emit,
            )
            .unwrap()
        };
        let under = load();
        let limit = over_the_listing_cap(&workspace);
        let over = load();
        drop(limit);

        for (when, view) in [("under the cap", under), ("over the cap", over)] {
            assert!(
                view.nodes.iter().any(|node| matches!(
                    node,
                    GraphNodeView::Directory { id, .. } if id == "directory:locked"
                )),
                "{when}, no folder node for the read-only folder"
            );
            assert!(
                view.nodes.iter().any(|node| matches!(
                    node,
                    GraphNodeView::File { id, .. } if id == "locked/hidden.md"
                )),
                "fixture: {when}, the indexed note has no node"
            );
            assert!(
                !view
                    .edges
                    .iter()
                    .any(|edge| edge.kind == "contains" && edge.target == "locked/hidden.md"),
                "{when}, the note inside the read-only folder is joined to it"
            );
        }
    }

    #[test]
    fn image_subset_picks_image_extensions_only() {
        let mut disk = std::collections::BTreeSet::new();
        disk.insert("notes/intro.md".to_string());
        disk.insert("assets/logo.png".to_string());
        disk.insert("assets/diagram.SVG".to_string());
        disk.insert("LICENSE".to_string());
        disk.insert("src/lib.rs".to_string());
        let images = image_subset(&disk);
        assert!(images.contains("assets/logo.png"));
        assert!(images.contains("assets/diagram.SVG"));
        assert!(!images.contains("notes/intro.md"));
        assert!(!images.contains("LICENSE"));
        assert!(!images.contains("src/lib.rs"));
    }

    #[test]
    fn contact_dedup_end_to_end_drops_unreferenced_imported_contacts() {
        // End-to-end: fixture workspace with 3 contact-
        // frontmatter files (alice + bob + charlie) and one
        // markdown body mentioning only `@@alice`. Replays the
        // api_graph filter pipeline (workspace.contacts() →
        // mention_to_contact lookup → resolved-mention pass →
        // should_emit_contact_file gate) and asserts the filter
        // drops bob + charlie + keeps alice. Without this test,
        // a regression on the filter would only surface on a
        // live-serve smoke run.
        let (_cfg, root, workspace) = open_workspace();
        put(
            root.path(),
            "contacts/alice.md",
            b"---\nchan:\n  kind: contact\n---\n# Alice\n",
        );
        put(
            root.path(),
            "contacts/bob.md",
            b"---\nchan:\n  kind: contact\n---\n# Bob\n",
        );
        put(
            root.path(),
            "contacts/charlie.md",
            b"---\nchan:\n  kind: contact\n---\n# Charlie\n",
        );
        put(
            root.path(),
            "notes/intro.md",
            b"# Intro\n\nMet @@alice today.\n",
        );
        workspace.index_file("contacts/alice.md").unwrap();
        workspace.index_file("contacts/bob.md").unwrap();
        workspace.index_file("contacts/charlie.md").unwrap();
        workspace.index_file("notes/intro.md").unwrap();

        // chan-workspace surfaces 3 contacts.
        let contact_rows = workspace.contacts().unwrap();
        let contact_paths: std::collections::HashSet<String> =
            contact_rows.iter().map(|c| c.rel_path.clone()).collect();
        assert_eq!(contact_paths.len(), 3, "got {contact_paths:?}");

        // Replay api_graph's mention_to_contact lookup.
        let mut mention_to_contact: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for c in &contact_rows {
            if let Some(stem) = std::path::Path::new(&c.rel_path)
                .file_stem()
                .and_then(|s| s.to_str())
            {
                mention_to_contact.insert(stem.to_lowercase(), c.rel_path.clone());
            }
        }

        // Walk the indexed graph edges; build the referenced-
        // contact set the same way api_graph does in the
        // mention-edge rewrite loop.
        let graph = workspace.graph().unwrap();
        let edges = graph.neighbors("notes/intro.md").unwrap();
        let mut referenced_contact_paths: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        for e in &edges {
            if matches!(e.kind, EdgeKind::Mention) {
                let stripped = e.dst.strip_prefix("@@").unwrap_or(&e.dst).to_lowercase();
                if let Some(contact_path) = mention_to_contact.get(&stripped) {
                    referenced_contact_paths.insert(contact_path.clone());
                }
            }
        }
        assert!(
            referenced_contact_paths.contains("contacts/alice.md"),
            "alice should be referenced: got {referenced_contact_paths:?}"
        );
        assert_eq!(
            referenced_contact_paths.len(),
            1,
            "only alice referenced: got {referenced_contact_paths:?}"
        );

        // Apply the filter: alice emits, bob + charlie drop.
        assert!(super::should_emit_contact_file(
            "contacts/alice.md",
            &contact_paths,
            &referenced_contact_paths
        ));
        assert!(!super::should_emit_contact_file(
            "contacts/bob.md",
            &contact_paths,
            &referenced_contact_paths
        ));
        assert!(!super::should_emit_contact_file(
            "contacts/charlie.md",
            &contact_paths,
            &referenced_contact_paths
        ));
        // notes/intro.md is not a contact, so it emits regardless.
        assert!(super::should_emit_contact_file(
            "notes/intro.md",
            &contact_paths,
            &referenced_contact_paths
        ));
    }

    #[test]
    fn api_graph_file_scope_accepts_draft_paths() {
        let (_cfg, _root, workspace) = open_workspace();
        workspace.create_draft_dir("untitled").unwrap();
        workspace
            .write_text(".Drafts/untitled/draft.md", "# Draft\n")
            .unwrap();

        let params = GraphParams {
            scope: GraphScope::File,
            path: ".Drafts/untitled/draft.md".to_string(),
            depth: 1,
        };
        let response = api_graph_sync(workspace, params);

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn graph_refuses_missing_workspace_root_instead_of_serving_stale_index() {
        let (_cfg, _root, workspace) = open_workspace();
        let root_path = workspace.root().to_path_buf();
        workspace.write_text("notes/a.md", "# A\n").unwrap();
        workspace.index_file("notes/a.md").unwrap();
        std::fs::remove_dir_all(&root_path).expect("remove harness-owned workspace");

        let mut emit = None;
        let result = build_graph_view(
            workspace,
            GraphParams {
                scope: GraphScope::Workspace,
                path: String::new(),
                depth: 10,
            },
            &mut emit,
        );
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("a missing root must not serve stale graph nodes"),
        };
        assert!(
            matches!(
                error,
                GraphBuildError::Workspace(
                    chan_workspace::ChanError::WorkspaceRootMissing(ref missing)
                ) if missing == &root_path
            ),
            "unexpected graph error: {error}"
        );
        assert!(
            !root_path.exists(),
            "graph request recreated the workspace root"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_and_a_hardlink_keep_their_own_edge_kinds() {
        let (_cfg, _root, workspace) = open_workspace();
        workspace.write_text("top.md", "# Top\n").unwrap();
        workspace.index_file("top.md").unwrap();
        let root = workspace.root().to_path_buf();
        std::os::unix::fs::symlink("top.md", root.join("alias.md")).unwrap();
        std::os::unix::fs::symlink("gone.md", root.join("dangling.md")).unwrap();
        std::fs::hard_link(root.join("top.md"), root.join("twin.md")).unwrap();

        let mut emit = None;
        let view = build_graph_view(
            workspace,
            GraphParams {
                scope: GraphScope::Workspace,
                path: String::new(),
                depth: 1,
            },
            &mut emit,
        )
        .unwrap();
        let between = |a: &str, b: &str| -> Vec<(&str, Option<bool>)> {
            view.edges
                .iter()
                .filter(|e| (e.source == a && e.target == b) || (e.source == b && e.target == a))
                .map(|e| (e.kind, e.broken))
                .collect()
        };
        assert_eq!(between("alias.md", "top.md"), vec![("symlink", None)]);
        assert_eq!(
            between("dangling.md", "gone.md"),
            vec![("symlink", Some(true))],
            "a symlink to a missing target is marked broken"
        );
        assert_eq!(between("top.md", "twin.md"), vec![("hardlink", None)]);
    }

    #[test]
    fn legacy_user_drafts_directory_appears_as_normal_directory() {
        // An ordinary user-root `.Drafts` directory remains in this graph.
        // A sidecar-only draft does not enter the workspace content graph.
        let (_cfg, _root, workspace) = open_workspace();
        workspace.create_draft_dir("sidecar-only").unwrap();
        let sidecar_id = workspace.draft_id("sidecar-only").unwrap();
        workspace
            .draft_files()
            .unwrap()
            .create_text_new("sidecar-only/draft.md", &sidecar_id, "# Sidecar\n")
            .unwrap();
        workspace
            .write_text(".Drafts/untitled/draft.md", "# Draft\n")
            .unwrap();
        workspace.index_file(".Drafts/untitled/draft.md").unwrap();
        workspace.write_text("notes/a.md", "# A\n").unwrap();
        workspace.index_file("notes/a.md").unwrap();

        let drafts_id = directory_node_id(".Drafts");
        let has_drafts = |view: &GraphViewResponse| {
            view.nodes
                .iter()
                .any(|n| matches!(n, GraphNodeView::Directory { id, .. } if *id == drafts_id))
        };

        let mut e1 = None;
        let ws = build_graph_view(
            workspace.clone(),
            GraphParams {
                scope: GraphScope::Workspace,
                path: String::new(),
                depth: 1,
            },
            &mut e1,
        )
        .unwrap();
        assert!(
            has_drafts(&ws),
            "drafts directory should appear at workspace scope"
        );
        assert!(
            !ws.nodes.iter().any(|node| matches!(node, GraphNodeView::File { path, .. } if path.contains("sidecar-only"))),
            "sidecar draft must not enter the workspace content graph"
        );
        // The drafts directory is anchored by a real `contains` edge from
        // the workspace root, not a synthetic edge kind.
        assert!(
            ws.edges
                .iter()
                .any(|e| e.source.is_empty() && e.target == drafts_id && e.kind == "contains"),
            "drafts directory must be anchored by a `contains` edge from root"
        );
        // Every edge pointing at the drafts node is a normal `contains`
        // edge; no synthetic drafts-specific edge kind survives.
        assert!(
            ws.edges
                .iter()
                .filter(|e| e.target == drafts_id)
                .all(|e| e.kind == "contains"),
            "drafts node must carry only `contains` edges"
        );

        let mut e2 = None;
        let dir = build_graph_view(
            workspace,
            GraphParams {
                scope: GraphScope::Directory,
                path: "notes".to_string(),
                depth: 1,
            },
            &mut e2,
        )
        .unwrap();
        // The indexed user-root file is a workspace-wide node, so it is anchored into
        // a non-drafts directory scope like any other out-of-prefix file: the
        // `.Drafts` directory appears, carried only by `contains` edges (no
        // special-casing keeps it out, and no synthetic edge kind leaks in).
        assert!(
            has_drafts(&dir),
            "drafts directory should appear in a non-drafts directory scope, like any directory"
        );
        assert!(
            dir.edges
                .iter()
                .any(|e| e.target == drafts_id && e.kind == "contains"),
            "drafts directory must be anchored by a `contains` edge in directory scope"
        );
        assert!(
            dir.edges
                .iter()
                .filter(|e| e.target == drafts_id)
                .all(|e| e.kind == "contains"),
            "drafts node must carry only `contains` edges in directory scope"
        );
    }

    #[test]
    fn directory_scope_anchors_every_out_of_prefix_file_no_loose_nodes() {
        // Folder-ON (directory scope) seeds a file node for every indexed file
        // workspace-wide, but the tree spine is prefix-scoped -- so before the
        // backfill every file OUTSIDE the scoped subtree had a node with no
        // `contains` ancestor chain and the frontend rendered it edgeless.
        // The backfill anchors every included file to its folder ancestors
        // (the "no file renders edgeless" invariant), mirroring Workspace
        // scope. This holds for out-of-prefix files whether or not anything
        // links them.
        let (_cfg, _root, workspace) = open_workspace();
        workspace.write_text("notes/a.md", "# A\n").unwrap();
        // A file two dirs deep in another subtree.
        workspace
            .write_text("gateway/deep/ref.md", "# Ref\n")
            .unwrap();
        // An UNREFERENCED file in yet another subtree -- anchored all the same.
        workspace
            .write_text("other/orphan.md", "# Orphan\n")
            .unwrap();
        workspace.index_file("notes/a.md").unwrap();
        workspace.index_file("gateway/deep/ref.md").unwrap();
        workspace.index_file("other/orphan.md").unwrap();

        let mut emit = None;
        let dir = build_graph_view(
            workspace,
            GraphParams {
                scope: GraphScope::Directory,
                path: "notes".to_string(),
                depth: 1,
            },
            &mut emit,
        )
        .unwrap();

        // The deep out-of-prefix file is fully anchored:
        // root -> directory:gateway -> directory:gateway/deep -> file.
        for (source, target) in [
            (String::new(), directory_node_id("gateway")),
            (
                directory_node_id("gateway"),
                directory_node_id("gateway/deep"),
            ),
            (
                directory_node_id("gateway/deep"),
                "gateway/deep/ref.md".to_string(),
            ),
        ] {
            assert!(
                dir.edges
                    .iter()
                    .any(|e| e.source == source && e.target == target && e.kind == "contains"),
                "missing `contains` spine edge {source:?} -> {target:?} (out-of-prefix file renders loose)"
            );
        }
        // The unreferenced file is anchored too -- anchoring is not gated on
        // being a link/mention/tag target.
        assert!(
            dir.edges
                .iter()
                .any(|e| e.source == directory_node_id("other")
                    && e.target == "other/orphan.md"
                    && e.kind == "contains"),
            "an unreferenced out-of-prefix file must still be anchored"
        );

        // Invariant: every non-missing file node is reachable from the
        // workspace root over `contains` edges (the frontend
        // `pullContainsSpine` "no file renders edgeless" contract).
        let parent_of: std::collections::HashMap<&str, &str> = dir
            .edges
            .iter()
            .filter(|e| e.kind == "contains")
            .map(|e| (e.target.as_str(), e.source.as_str()))
            .collect();
        for node in &dir.nodes {
            let GraphNodeView::File { path, missing, .. } = node else {
                continue;
            };
            if *missing {
                continue;
            }
            let mut cur = path.as_str();
            let mut hops = 0;
            while !cur.is_empty() {
                let Some(parent) = parent_of.get(cur) else {
                    panic!("file node {path:?} is edgeless (no `contains` parent for {cur:?})");
                };
                cur = parent;
                hops += 1;
                assert!(hops < 64, "contains chain for {path:?} did not reach root");
            }
        }
    }

    #[test]
    fn unresolved_link_target_produces_no_ghost_node_or_edge() {
        // The graph shows no ghost nodes. A markdown link whose
        // target exists neither in the index nor on disk must
        // contribute NEITHER a `File { missing: true }` node NOR a
        // dangling edge.
        let (_cfg, _root, workspace) = open_workspace();
        workspace
            .write_text(
                "notes/intro.md",
                "# Intro\n\nsee [the void](does-not-exist.md)\n",
            )
            .unwrap();
        workspace.index_file("notes/intro.md").unwrap();

        let params = GraphParams {
            scope: GraphScope::Workspace,
            path: String::new(),
            depth: 6,
        };
        let mut emit = None;
        let view = build_graph_view(workspace, params, &mut emit).unwrap();

        // Positive control: the real authored file IS a node, so the
        // graph genuinely built (the assertion below is not vacuous).
        assert!(
            view.nodes.iter().any(|n| matches!(
                n,
                GraphNodeView::File { path, .. } if path == "notes/intro.md"
            )),
            "intro.md should be a graph node"
        );
        // The unresolved target appears nowhere. Serialize the whole
        // view and assert the dst string is absent, robust against which
        // node/edge variant might otherwise carry it.
        let json = serde_json::to_string(&view).unwrap();
        assert!(
            !json.contains("does-not-exist"),
            "unresolved link target must not surface as a ghost node or a \
             dangling edge: {json}"
        );
    }

    #[test]
    fn cross_linked_contact_keeps_contact_node_kind() {
        // A contact file referenced only by a markdown link (not an @@mention)
        // is dropped from the semantic batch by
        // `should_emit_contact_file`, then re-added by the filesystem
        // tree layer as a plain File node (`node_kind: None`). Without
        // the `stamp_contact_kinds` re-stamp it renders with the generic
        // markdown glyph instead of the contact treatment, so the built
        // view must carry `node_kind: "contact"` on the contact node.
        let (_cfg, _root, workspace) = open_workspace();
        workspace
            .write_text(
                "contacts/alice.md",
                "---\nchan:\n  kind: contact\n---\n# Alice\n",
            )
            .unwrap();
        workspace
            .write_text("note.md", "# Note\n\nSee [alice](contacts/alice.md).\n")
            .unwrap();
        workspace.index_file("contacts/alice.md").unwrap();
        workspace.index_file("note.md").unwrap();

        let params = GraphParams {
            scope: GraphScope::Workspace,
            path: String::new(),
            depth: 6,
        };
        let mut emit = None;
        let view = build_graph_view(workspace, params, &mut emit).unwrap();

        let alice = view.nodes.iter().find_map(|n| match n {
            GraphNodeView::File {
                path, node_kind, ..
            } if path == "contacts/alice.md" => Some(*node_kind),
            _ => None,
        });
        assert_eq!(
            alice,
            Some(Some("contact")),
            "a cross-linked (not @@mentioned) contact must reach the graph \
             with node_kind=contact: {view:?}"
        );
    }

    #[tokio::test]
    async fn link_targets_endpoint_is_path_title_heading_picker_not_body_search() {
        let (_cfg, _root, workspace) = open_workspace();
        workspace
            .write_text(
                "notes/carbonara.md",
                "# Carbonara\n\nsecret-body-token\n\n## Ingredients\n",
            )
            .unwrap();
        workspace
            .write_text("notes/unrelated.md", "# Unrelated\n\nsecret-body-token\n")
            .unwrap();
        workspace.index_file("notes/carbonara.md").unwrap();
        workspace.index_file("notes/unrelated.md").unwrap();

        let body_response = api_link_targets_sync(
            workspace.clone(),
            LinkTargetsParams {
                q: "secret-body-token".to_string(),
                limit: 10,
            },
        );
        assert_eq!(body_response.status(), StatusCode::OK);
        let body_bytes = axum::body::to_bytes(body_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body_hits: Vec<chan_workspace::LinkTarget> =
            serde_json::from_slice(&body_bytes).unwrap();
        assert!(
            body_hits.is_empty(),
            "link targets must not search body text: {body_hits:?}",
        );

        let heading_response = api_link_targets_sync(
            workspace,
            LinkTargetsParams {
                q: "ingredients".to_string(),
                limit: 10,
            },
        );
        assert_eq!(heading_response.status(), StatusCode::OK);
        let heading_bytes = axum::body::to_bytes(heading_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let heading_hits: Vec<chan_workspace::LinkTarget> =
            serde_json::from_slice(&heading_bytes).unwrap();
        assert!(heading_hits.iter().any(|hit| {
            hit.kind == chan_workspace::LinkTargetKind::Heading
                && hit.path == "notes/carbonara.md"
                && hit.heading.as_deref() == Some("Ingredients")
        }));
    }

    #[test]
    fn should_emit_contact_file_drops_unreferenced_keeps_referenced_and_non_contacts() {
        // The contact-file emit filter pins the graph view to
        // "who-mentions-whom": only referenced contacts survive. A seed
        // workspace can have 1973 contact files but only about 49 unique
        // @@Handle strings in markdown bodies.
        let mut contacts = std::collections::HashSet::new();
        contacts.insert("contacts/alice.md".to_string());
        contacts.insert("contacts/bob.md".to_string());
        contacts.insert("contacts/charlie.md".to_string());

        let mut referenced = std::collections::HashSet::new();
        referenced.insert("contacts/alice.md".to_string());

        // alice IS referenced, so emit.
        assert!(super::should_emit_contact_file(
            "contacts/alice.md",
            &contacts,
            &referenced
        ));
        // bob is a contact but NOT referenced, so drop.
        assert!(!super::should_emit_contact_file(
            "contacts/bob.md",
            &contacts,
            &referenced
        ));
        // charlie too.
        assert!(!super::should_emit_contact_file(
            "contacts/charlie.md",
            &contacts,
            &referenced
        ));
        // Plain markdown (not a contact) always emits.
        assert!(super::should_emit_contact_file(
            "notes/intro.md",
            &contacts,
            &referenced
        ));
        // Source file always emits.
        assert!(super::should_emit_contact_file(
            "src/lib.rs",
            &contacts,
            &referenced
        ));
    }

    #[test]
    fn merged_graph_layers_emit_filesystem_media_and_language_nodes() {
        let (_cfg, root, workspace) = open_workspace();
        put(root.path(), "notes/a.md", b"# A\n\n[[notes/b.md]]\n#tag\n");
        put(root.path(), "notes/b.md", b"# B\n");
        put(root.path(), "src/lib.rs", b"pub fn answer() -> u8 { 42 }\n");
        put(root.path(), "assets/logo.png", &[0, 1, 2, 3]);
        workspace.index_file("notes/a.md").unwrap();
        workspace.index_file("notes/b.md").unwrap();

        let params = GraphParams {
            scope: GraphScope::Workspace,
            path: String::new(),
            depth: 6,
        };
        let mut nodes = std::collections::BTreeMap::new();
        let mut edges = Vec::new();
        merge_filesystem_layer(&workspace, &params, &mut nodes, &mut edges).unwrap();
        merge_language_layer(&workspace, &params, &mut nodes, &mut edges).unwrap();

        assert!(has_node_kind(&nodes, "directory"));
        assert!(has_node_kind(&nodes, "file"));
        assert!(has_node_kind(&nodes, "media"));
        assert!(has_node_kind(&nodes, "language"));
        assert!(edges.iter().any(|edge| edge.kind == "contains"));
        assert!(edges.iter().any(|edge| edge.kind == "language"));
        assert!(nodes.values().any(
            |node| matches!(node, GraphNodeView::Directory { id, .. } if id == "directory:src")
        ));
        assert!(nodes.values().any(
            |node| matches!(node, GraphNodeView::Language { language, .. } if language == "Rust")
        ));
    }

    #[test]
    fn merged_graph_language_layer_emits_language_to_file_edges_for_workspace_lens() {
        // The workspace-graph language layer must emit one
        // Language -> File edge per file of the language so the
        // GraphPanel lens (1-hop BFS seeded on `language:<lang>`)
        // renders the bubble plus every file. Edges from
        // `build_language_graph` collapse files into top-N
        // per-directory edges, which would leave the language lens
        // showing directories instead of every file.
        let (_cfg, root, workspace) = open_workspace();
        put(root.path(), "notes/intro.md", b"# Intro\n");
        put(root.path(), "notes/deep/sub.md", b"# Sub\n");
        put(root.path(), "docs/readme.md", b"# Readme\n");
        put(root.path(), "src/lib.rs", b"fn x() {}\n");
        workspace.index_file("notes/intro.md").unwrap();
        workspace.index_file("notes/deep/sub.md").unwrap();
        workspace.index_file("docs/readme.md").unwrap();

        let params = GraphParams {
            scope: GraphScope::Workspace,
            path: String::new(),
            depth: 1,
        };
        let mut nodes = std::collections::BTreeMap::new();
        let mut edges = Vec::new();
        merge_filesystem_layer(&workspace, &params, &mut nodes, &mut edges).unwrap();
        merge_language_layer(&workspace, &params, &mut nodes, &mut edges).unwrap();

        let markdown_id = language_node_id("Markdown");
        let markdown_targets: std::collections::BTreeSet<&str> = edges
            .iter()
            .filter(|e| e.kind == "language" && e.source == markdown_id)
            .map(|e| e.target.as_str())
            .collect();

        // Every markdown file appears as a 1-hop neighbour of the
        // Markdown language bubble, regardless of which directory
        // it lives in: the workspace lens does not apply the
        // top-N directory ranking that `build_language_graph`
        // takes from the `depth` parameter.
        assert!(markdown_targets.contains("notes/intro.md"));
        assert!(markdown_targets.contains("notes/deep/sub.md"));
        assert!(markdown_targets.contains("docs/readme.md"));
        // Rust file gets its own language node + edge, separate
        // from Markdown.
        let rust_id = language_node_id("Rust");
        assert!(edges
            .iter()
            .any(|e| e.kind == "language" && e.source == rust_id && e.target == "src/lib.rs"));
        // No `directory:<path>` targets emitted by the language
        // layer (those came from the retired directory-rollup
        // path inside `build_language_graph`).
        assert!(!edges
            .iter()
            .any(|e| e.kind == "language" && e.target.starts_with("directory:")));
    }

    #[test]
    fn merged_graph_filesystem_layer_uses_full_tree_spine() {
        let (_cfg, root, workspace) = open_workspace();
        put(root.path(), "notes/deep/a.md", b"# A\n");
        put(root.path(), "notes/deep/raw.bin", &[1, 2, 3]);
        put(root.path(), "top.md", b"# Top\n");

        let params = GraphParams {
            scope: GraphScope::Workspace,
            path: String::new(),
            depth: 1,
        };
        let mut nodes = std::collections::BTreeMap::new();
        let mut edges = Vec::new();
        merge_filesystem_layer(&workspace, &params, &mut nodes, &mut edges).unwrap();

        assert!(nodes.values().any(
            |node| matches!(node, GraphNodeView::Directory { id, path, .. } if id.is_empty() && path.is_empty())
        ));
        assert!(nodes.contains_key("directory:notes"));
        assert!(nodes.contains_key("directory:notes/deep"));
        assert!(nodes.contains_key("notes/deep/a.md"));
        assert!(nodes.contains_key("notes/deep/raw.bin"));
        assert!(edges.iter().any(|edge| edge.source.is_empty()
            && edge.target == "directory:notes"
            && edge.kind == "contains"));
        assert!(edges.iter().any(|edge| {
            edge.source == "directory:notes"
                && edge.target == "directory:notes/deep"
                && edge.kind == "contains"
        }));
        assert!(edges.iter().any(|edge| {
            edge.source == "directory:notes/deep"
                && edge.target == "notes/deep/a.md"
                && edge.kind == "contains"
        }));
    }

    #[test]
    fn merged_graph_layer_excludes_ignored_dirs() {
        // ignore-consistency-spec.md: a workspace pointed at a source tree
        // must not plot node_modules/target/venv/.git in the graph. The
        // default registry index_excluded_dirs is sane, so this holds
        // with no config. Guards against a runaway node count.
        let (_cfg, root, workspace) = open_workspace();
        put(root.path(), "top.md", b"# Top\n");
        put(root.path(), "notes/today.md", b"# Today\n");
        // Dependency / VCS noise at top level AND nested under a real dir.
        put(root.path(), "node_modules/pkg/index.js", b"x");
        put(root.path(), "target/debug/build.rs", b"x");
        put(root.path(), ".venv/lib/site.py", b"x");
        put(root.path(), ".git/HEAD", b"ref: x");
        put(root.path(), "notes/node_modules/dep/a.js", b"x");

        let params = GraphParams {
            scope: GraphScope::Workspace,
            path: String::new(),
            depth: 6,
        };
        let mut nodes = std::collections::BTreeMap::new();
        let mut edges = Vec::new();
        merge_filesystem_layer(&workspace, &params, &mut nodes, &mut edges).unwrap();

        // Real content present.
        assert!(nodes.contains_key("top.md"));
        assert!(nodes.contains_key("directory:notes"));
        assert!(nodes.contains_key("notes/today.md"));

        // No ignored dir appears as a directory node or a file node, at
        // any depth. Directory nodes are keyed "directory:<rel>"; file /
        // media nodes are keyed by the raw rel path.
        for ignored in ["node_modules", "target", ".venv", ".git"] {
            for (id, _) in nodes.iter() {
                let rel = id.strip_prefix("directory:").unwrap_or(id);
                assert!(
                    rel != ignored && !rel.starts_with(&format!("{ignored}/")),
                    "ignored dir leaked into the semantic graph: node id={id}"
                );
                // Nested case: notes/node_modules/...
                assert!(
                    !rel.contains(&format!("/{ignored}/"))
                        && !rel.ends_with(&format!("/{ignored}")),
                    "nested ignored dir leaked into the semantic graph: node id={id}"
                );
            }
        }
    }

    #[test]
    fn merged_graph_file_scope_includes_ancestor_chain() {
        let (_cfg, root, workspace) = open_workspace();
        put(root.path(), "notes/deep/a.md", b"# A\n");

        let params = GraphParams {
            scope: GraphScope::File,
            path: "notes/deep/a.md".to_string(),
            depth: 1,
        };
        let mut nodes = std::collections::BTreeMap::new();
        let mut edges = Vec::new();
        merge_filesystem_layer(&workspace, &params, &mut nodes, &mut edges).unwrap();

        assert!(nodes.contains_key(""));
        assert!(nodes.contains_key("directory:notes"));
        assert!(nodes.contains_key("directory:notes/deep"));
        assert!(nodes.contains_key("notes/deep/a.md"));
        assert!(edges.iter().any(|edge| edge.source.is_empty()
            && edge.target == "directory:notes"
            && edge.kind == "contains"));
        assert!(edges.iter().any(|edge| {
            edge.source == "directory:notes"
                && edge.target == "directory:notes/deep"
                && edge.kind == "contains"
        }));
        assert!(edges.iter().any(|edge| {
            edge.source == "directory:notes/deep"
                && edge.target == "notes/deep/a.md"
                && edge.kind == "contains"
        }));
    }

    #[cfg(unix)]
    #[test]
    fn merged_graph_keeps_read_only_directories_as_dead_ends() {
        use std::os::unix::fs::PermissionsExt;

        // Puts the directory's mode back when the test ends, pass or fail, so
        // that a user who is not root can remove the temp directory.
        struct ModeRestore(std::path::PathBuf, std::fs::Permissions);
        impl Drop for ModeRestore {
            fn drop(&mut self) {
                let _ = std::fs::set_permissions(&self.0, self.1.clone());
            }
        }

        let (_cfg, root, workspace) = open_workspace();
        put(root.path(), "locked/hidden.md", b"# Hidden\n");
        let locked = root.path().join("locked");
        let _restore = ModeRestore(
            locked.clone(),
            std::fs::metadata(&locked).unwrap().permissions(),
        );
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();

        let params = GraphParams {
            scope: GraphScope::Workspace,
            path: String::new(),
            depth: 6,
        };
        let mut nodes = std::collections::BTreeMap::new();
        let mut edges = Vec::new();
        merge_filesystem_layer(&workspace, &params, &mut nodes, &mut edges).unwrap();

        assert!(nodes.contains_key("directory:locked"));
        assert!(!nodes.contains_key("locked/hidden.md"));
        assert!(!edges.iter().any(|edge| {
            edge.source == "directory:locked" && edge.target == "locked/hidden.md"
        }));
    }

    #[test]
    fn resolve_link_dst_decodes_percent_encoded_to_real_file() {
        let files: std::collections::BTreeSet<&str> = ["recipes/my note.md", "recipes/intro.md"]
            .into_iter()
            .collect();
        // [link](my%20note.md) inside recipes/intro.md.
        assert_eq!(
            resolve_link_dst("recipes/intro.md", "my%20note.md", &files),
            "recipes/my note.md"
        );
    }

    #[test]
    fn resolve_link_dst_workspace_relative_match_wins() {
        // Wiki-style targets store no extension; resolver tries .md
        // and lands on the indexed file at workspace root.
        let files: std::collections::BTreeSet<&str> =
            ["pasta.md", "recipes/pasta.md"].into_iter().collect();
        assert_eq!(
            resolve_link_dst("recipes/intro.md", "pasta", &files),
            "pasta.md",
        );
    }

    #[test]
    fn resolve_link_dst_partial_prefix_wikilink_lands_on_ancestor_file() {
        // A wiki-link `[[sprint/notes-3.md]]` authored in a doc deep
        // under the workspace (repo-root workspace) is stored
        // workspace-rooted, verbatim as `sprint/notes-3.md`. The real
        // file is nested deeper, at `docs/journals/sprint/notes-3.md`.
        // Neither the workspace-root candidate (`sprint/notes-3.md`)
        // nor the immediate-parent join
        // (`docs/journals/sprint/sprint/notes-3.md`) exists; the
        // ancestor base `docs/journals` rescues it. Without the
        // ancestor walk this rendered a false "file does not exist"
        // ghost even though the file is right there.
        let files: std::collections::BTreeSet<&str> = [
            "docs/journals/sprint/notes-3.md",
            "docs/journals/sprint/journal.md",
        ]
        .into_iter()
        .collect();
        assert_eq!(
            resolve_link_dst(
                "docs/journals/sprint/journal.md",
                "sprint/notes-3.md",
                &files,
            ),
            "docs/journals/sprint/notes-3.md",
        );
    }

    #[test]
    fn resolve_link_dst_ancestor_fallback_does_not_beat_workspace_root() {
        // The ancestor fallback must not shadow a genuine workspace-root
        // match: when both the workspace-root file and an ancestor-relative
        // file exist, workspace-root still wins (preserves the wiki-rooted
        // convention asserted by resolve_link_dst_workspace_relative_match_wins).
        let files: std::collections::BTreeSet<&str> =
            ["x/y.md", "a/b/x/y.md", "a/b/c.md"].into_iter().collect();
        assert_eq!(resolve_link_dst("a/b/c.md", "x/y.md", &files), "x/y.md",);
    }

    #[test]
    fn resolve_link_dst_dot_relative_to_source() {
        let files: std::collections::BTreeSet<&str> = ["recipes/peer.md", "recipes/intro.md"]
            .into_iter()
            .collect();
        assert_eq!(
            resolve_link_dst("recipes/intro.md", "./peer.md", &files),
            "recipes/peer.md",
        );
    }

    #[test]
    fn resolve_link_dst_parent_relative_to_source() {
        let files: std::collections::BTreeSet<&str> =
            ["sibling.md", "recipes/intro.md"].into_iter().collect();
        assert_eq!(
            resolve_link_dst("recipes/intro.md", "../sibling.md", &files),
            "sibling.md",
        );
    }

    #[test]
    fn resolve_link_dst_unresolved_returns_decoded() {
        let files: std::collections::BTreeSet<&str> = ["intro.md"].into_iter().collect();
        // Genuine broken link: decoded form surfaces a clean ghost
        // label without %20 noise.
        assert_eq!(
            resolve_link_dst("intro.md", "my%20missing.md", &files),
            "my missing.md",
        );
    }

    #[test]
    fn resolve_link_dst_strips_leading_slash() {
        let files: std::collections::BTreeSet<&str> = ["recipes/pasta.md"].into_iter().collect();
        assert_eq!(
            resolve_link_dst("intro.md", "/recipes/pasta.md", &files),
            "recipes/pasta.md",
        );
    }

    #[test]
    fn resolve_link_dst_image_attachments_workspace_relative() {
        // `![](attachments/pic.png)` from any source resolves to the
        // image at the workspace root. Backlinks for the image now find
        // this edge instead of returning the stale "linked from: 0"
        // that the SQL `dst = "attachments/pic.png"` query produced
        // when the source authored it as a workspace-relative path.
        let files: std::collections::BTreeSet<&str> = ["attachments/pic.png", "notes/journal.md"]
            .into_iter()
            .collect();
        assert_eq!(
            resolve_link_dst("notes/journal.md", "attachments/pic.png", &files),
            "attachments/pic.png",
        );
    }

    #[test]
    fn resolve_link_dst_image_source_relative_dot() {
        // `![](./img.png)` inside notes/journal.md should land on the
        // sibling image, not stay verbatim.
        let files: std::collections::BTreeSet<&str> =
            ["notes/img.png", "notes/journal.md"].into_iter().collect();
        assert_eq!(
            resolve_link_dst("notes/journal.md", "./img.png", &files),
            "notes/img.png",
        );
    }

    #[test]
    fn resolve_link_dst_parent_escape_falls_back() {
        // `../../escape` from a one-level source escapes the workspace
        // root: normalize_workspace_rel returns None, so only the
        // verbatim workspace-relative candidate is tried; both miss and
        // we surface the decoded original.
        let files: std::collections::BTreeSet<&str> = ["intro.md"].into_iter().collect();
        assert_eq!(
            resolve_link_dst("intro.md", "../../escape.md", &files),
            "../../escape.md",
        );
    }

    #[test]
    fn indexed_file_exists_requires_regular_file() {
        let (_cfg, root, workspace) = open_workspace();
        std::fs::create_dir_all(root.path().join("notes")).unwrap();
        std::fs::write(root.path().join("notes/live.md"), "# live\n").unwrap();
        std::fs::create_dir(root.path().join("notes/dir.md")).unwrap();

        assert!(indexed_file_exists(&workspace, "notes/live.md"));
        assert!(!indexed_file_exists(&workspace, "notes/missing.md"));
        assert!(!indexed_file_exists(&workspace, "notes/dir.md"));
    }

    #[cfg(unix)]
    #[test]
    fn indexed_file_exists_treats_symlink_as_missing() {
        use std::os::unix::fs::symlink;

        let (_cfg, root, workspace) = open_workspace();
        std::fs::write(root.path().join("target.md"), "# target\n").unwrap();
        symlink("target.md", root.path().join("alias.md")).unwrap();

        assert!(!indexed_file_exists(&workspace, "alias.md"));
    }

    #[test]
    fn language_graph_ranks_directories_per_language() {
        let graph = build_language_graph(
            &[
                report_file("crates/a/src/lib.rs", "Rust", 100),
                report_file("crates/a/src/main.rs", "Rust", 40),
                report_file("crates/b/lib.rs", "Rust", 400),
                report_file("web/src/App.svelte", "Svelte", 80),
            ],
            0,
            None,
        );

        assert_eq!(graph.max_depth, 2);
        assert!(graph.nodes.contains(&LanguageGraphNode::Language {
            id: "language:Rust".to_string(),
            label: "Rust".to_string(),
            language: "Rust".to_string(),
            files: 3,
            code: 540,
        }));
        assert!(graph.nodes.contains(&LanguageGraphNode::Directory {
            id: "directory:crates/a/src".to_string(),
            label: "src".to_string(),
            path: "crates/a/src".to_string(),
            files: 2,
            code: 140,
        }));
        assert!(graph.edges.contains(&LanguageGraphEdge {
            source: "language:Rust".to_string(),
            target: "directory:crates/a/src".to_string(),
            kind: "language",
            rank: 1,
            files: 2,
            code: 140,
        }));
        assert!(graph.edges.contains(&LanguageGraphEdge {
            source: "language:Rust".to_string(),
            target: "directory:crates/b".to_string(),
            kind: "language",
            rank: 2,
            files: 1,
            code: 400,
        }));
    }

    #[test]
    fn language_graph_depth_and_language_filter_trim_edges() {
        let graph = build_language_graph(
            &[
                report_file("a/one.rs", "Rust", 10),
                report_file("b/two.rs", "Rust", 20),
                report_file("web/App.svelte", "Svelte", 30),
            ],
            1,
            Some("rust"),
        );

        assert_eq!(graph.max_depth, 2);
        assert_eq!(graph.edges.len(), 1);
        assert_eq!(graph.edges[0].source, "language:Rust");
        assert_eq!(graph.edges[0].rank, 1);
        assert!(graph.nodes.iter().any(
            |n| matches!(n, LanguageGraphNode::Language { language, .. } if language == "Rust")
        ));
        assert!(!graph.nodes.iter().any(
            |n| matches!(n, LanguageGraphNode::Language { language, .. } if language == "Svelte")
        ));
    }

    #[test]
    fn language_graph_breaks_ties_by_code_then_path() {
        let graph = build_language_graph(
            &[
                report_file("z/lib.rs", "Rust", 10),
                report_file("b/lib.rs", "Rust", 30),
                report_file("a/lib.rs", "Rust", 30),
            ],
            0,
            Some("Rust"),
        );

        let targets: Vec<&str> = graph
            .edges
            .iter()
            .map(|edge| edge.target.as_str())
            .collect();
        assert_eq!(targets, ["directory:a", "directory:b", "directory:z"]);
        assert_eq!(
            graph.edges.iter().map(|edge| edge.rank).collect::<Vec<_>>(),
            [1, 2, 3]
        );
    }

    #[test]
    fn language_graph_renders_root_directory_with_slash_label() {
        let graph = build_language_graph(&[report_file("lib.rs", "Rust", 12)], 0, None);

        assert!(graph.nodes.contains(&LanguageGraphNode::Directory {
            id: "".to_string(),
            label: "/".to_string(),
            path: "".to_string(),
            files: 1,
            code: 12,
        }));
        assert!(graph.edges.contains(&LanguageGraphEdge {
            source: "language:Rust".to_string(),
            target: "".to_string(),
            kind: "language",
            rank: 1,
            files: 1,
            code: 12,
        }));
    }

    #[test]
    fn language_graph_clamps_depth_to_max_depth() {
        let graph = build_language_graph(
            &[
                report_file("a/lib.rs", "Rust", 10),
                report_file("b/lib.rs", "Rust", 20),
                report_file("c/lib.rs", "Rust", 30),
            ],
            99,
            Some("Rust"),
        );

        assert_eq!(graph.max_depth, 3);
        assert_eq!(graph.edges.len(), 3);
        assert_eq!(
            graph.edges.iter().map(|edge| edge.rank).collect::<Vec<_>>(),
            [1, 2, 3]
        );
    }

    #[test]
    fn language_graph_empty_workspace_returns_empty_payload() {
        let graph = build_language_graph(&[], 0, None);

        assert_eq!(graph.max_depth, 0);
        assert!(graph.nodes.is_empty());
        assert!(graph.edges.is_empty());
        assert!(graph.detail.is_none());
    }

    fn detail_cocomo() -> CocomoSummary {
        CocomoSummary {
            model: "basic-organic".to_string(),
            effort_person_months: 1.5,
            schedule_months: 2.5,
            developers: 0.6,
            estimated_cost_usd: 28_800.0,
        }
    }

    #[test]
    fn language_detail_ranks_every_directory_without_a_depth_cutoff() {
        let detail = build_language_detail(
            &[
                report_file("d1/lib.rs", "Rust", 10),
                report_file("d2/lib.rs", "Rust", 10),
                report_file("d3/lib.rs", "Rust", 10),
                report_file("d4/lib.rs", "Rust", 10),
                report_file("d5/lib.rs", "Rust", 10),
                report_file("d6/lib.rs", "Rust", 10),
                report_file("d6/extra.rs", "Rust", 5),
                report_file("web/App.svelte", "Svelte", 99),
            ],
            "rust",
            detail_cocomo(),
        );

        // Six Rust directories: the graph's depth slider would trim
        // this to the top N, the inspector detail must carry all of
        // them in rank order.
        let paths: Vec<&str> = detail
            .directories
            .iter()
            .map(|dir| dir.path.as_str())
            .collect();
        assert_eq!(paths, ["d6", "d1", "d2", "d3", "d4", "d5"]);
        assert_eq!(
            detail
                .directories
                .iter()
                .map(|dir| dir.rank)
                .collect::<Vec<_>>(),
            [1, 2, 3, 4, 5, 6]
        );
        assert_eq!(detail.language, "Rust");
        assert_eq!(detail.files, 7);
        assert_eq!(detail.code, 65);
        assert_eq!(detail.cocomo, detail_cocomo());
    }

    #[test]
    fn language_detail_breaks_ties_by_code_then_path() {
        let detail = build_language_detail(
            &[
                report_file("z/lib.rs", "Rust", 10),
                report_file("b/lib.rs", "Rust", 30),
                report_file("a/lib.rs", "Rust", 30),
            ],
            "Rust",
            detail_cocomo(),
        );

        let paths: Vec<&str> = detail
            .directories
            .iter()
            .map(|dir| dir.path.as_str())
            .collect();
        assert_eq!(paths, ["a", "b", "z"]);
    }

    #[test]
    fn language_graph_and_detail_share_the_directory_tie_order() {
        // Tie-heavy rows: `c` wins on file count; `a`, `b`, and `z`
        // tie on both files and code so only the path ordering
        // separates them. Two independently drifting comparators in
        // the graph and detail builders would order these rows
        // differently and fail this test.
        let files = [
            report_file("z/lib.rs", "Rust", 30),
            report_file("b/lib.rs", "Rust", 30),
            report_file("a/lib.rs", "Rust", 30),
            report_file("c/one.rs", "Rust", 10),
            report_file("c/two.rs", "Rust", 10),
            report_file("web/App.svelte", "Svelte", 99),
        ];

        let graph = build_language_graph(&files, 0, Some("rust"));
        let detail = build_language_detail(&files, "rust", detail_cocomo());

        // The graph emits directory edges in rank order for the single
        // filtered language; the detail lists directories in rank
        // order. Both must be the same sequence.
        let graph_order: Vec<&str> = graph
            .edges
            .iter()
            .map(|edge| edge.target.as_str())
            .collect();
        let detail_order: Vec<String> = detail
            .directories
            .iter()
            .map(|dir| directory_node_id(&dir.path))
            .collect();
        assert_eq!(graph_order, detail_order);
        assert_eq!(
            graph_order,
            [
                directory_node_id("c"),
                directory_node_id("a"),
                directory_node_id("b"),
                directory_node_id("z"),
            ]
        );
    }

    #[test]
    fn language_detail_labels_root_directory_with_slash() {
        let detail = build_language_detail(
            &[report_file("lib.rs", "Rust", 12)],
            "Rust",
            detail_cocomo(),
        );

        assert_eq!(detail.directories.len(), 1);
        assert_eq!(detail.directories[0].path, "");
        assert_eq!(detail.directories[0].label, "/");
        assert_eq!(detail.directories[0].rank, 1);
    }

    #[test]
    fn language_detail_unknown_language_keeps_query_name_and_zeroes() {
        let detail = build_language_detail(
            &[report_file("lib.rs", "Rust", 12)],
            "Cobol",
            CocomoSummary::default(),
        );

        assert_eq!(detail.language, "Cobol");
        assert_eq!(detail.files, 0);
        assert_eq!(detail.code, 0);
        assert!(detail.directories.is_empty());
    }

    #[test]
    fn language_detail_scoped_report_computes_cocomo_for_the_language() {
        let (_cfg, root, workspace) = open_workspace();
        // chan-report rounds the COCOMO fields to two decimals, so the
        // fixtures need more than a couple of SLOC for the effort to
        // survive rounding.
        let body = "fn main() {}\n".repeat(20);
        put(root.path(), "src/lib.rs", body.as_bytes());
        put(root.path(), "src/sub/mod.rs", body.as_bytes());
        put(root.path(), "notes/doc.md", b"# doc\n\nprose\n");
        let report = workspace.report().unwrap();

        let detail = language_detail_scoped(&workspace, &report.files, "rust").unwrap();

        assert_eq!(detail.language, "Rust");
        assert_eq!(detail.files, 2);
        let paths: Vec<&str> = detail
            .directories
            .iter()
            .map(|dir| dir.path.as_str())
            .collect();
        assert_eq!(paths, ["src", "src/sub"]);
        // The COCOMO summary must be chan-report's own computation for
        // the language file set: organic model label, non-zero effort.
        assert_eq!(detail.cocomo.model, "basic-organic");
        assert!(detail.cocomo.effort_person_months > 0.0);

        // A language with no tracked files yields an empty detail, not
        // an error.
        let empty = language_detail_scoped(&workspace, &report.files, "Cobol").unwrap();
        assert_eq!(empty.language, "Cobol");
        assert!(empty.directories.is_empty());
        assert_eq!(empty.cocomo.effort_person_months, 0.0);
    }
}
