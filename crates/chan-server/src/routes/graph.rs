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

use std::{convert::Infallible, sync::Arc};

use axum::body::{Body, Bytes};
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chan_workspace::{
    normalize_graph_edges, resolve_link_target as resolve_link_dst, EdgeKind, FileClass, PathClass,
    PathPermission, ReportFileBucket, ReportFileStats,
};
use futures::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::error::{err_from, err_state};
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

async fn blocking_response(
    f: impl FnOnce() -> Response + Send + 'static,
    label: &'static str,
) -> Response {
    match tokio::task::spawn_blocking(f).await {
        Ok(response) => response,
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("{label} task panicked: {e}"),
        )
            .into_response(),
    }
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
    blocking_response(move || api_link_targets_sync(workspace, p), "link targets").await
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
    blocking_response(
        move || match workspace.resolve_link(&p.target) {
            Some(resolved) => Json(resolved).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        },
        "resolve link",
    )
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
    blocking_response(
        move || {
            let graph = match workspace.graph() {
                Ok(g) => g,
                Err(e) => return err_from(&e),
            };
            match graph.headings_of(&path) {
                Ok(headings) => Json(headings).into_response(),
                Err(e) => err_from(&e),
            }
        },
        "headings",
    )
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
    blocking_response(
        move || {
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
                    Ok(es) => {
                        edges.extend(es.into_iter().filter(|e| matches!(e.kind, EdgeKind::Link)))
                    }
                    Err(e) => return err_from(&e),
                }
            }
            Json(edges).into_response()
        },
        "links",
    )
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
            GraphBuildError::Cancelled => {
                (StatusCode::INTERNAL_SERVER_ERROR, "graph stream cancelled").into_response()
            }
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
    /// "link" | "tag" | "mention" | "contains" | "language".
    /// Lowercase to match the
    /// frontend's GraphViewEdgeKind type.
    kind: &'static str,
    /// Only meaningful for link edges: true when the link resolves
    /// to a missing file. Other kinds skip the field.
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

/// Image-extension predicate. Mirrors the frontend's classifyFile
/// regex (`png|jpe?g|gif|webp|svg|avif|bmp`). The graph route uses
/// this to enrich the file set with image files referenced by
/// markdown so a `![](pic.png)` lands on a real file node instead
/// of a ghost. Keep both predicates in sync.
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

/// Collect every regular file under the workspace root, workspace-relative
/// POSIX paths. Used as the link-resolution oracle: a markdown link
/// pointing at any on-disk file (LICENSE, .rs source, .sh, ...)
/// resolves to that real file instead of synthesizing a ghost.
///
/// Returns an empty set on `list_tree` failure so callers degrade to
/// the previous graph-files-only behaviour instead of failing the
/// request.
fn workspace_disk_files(
    workspace: &chan_workspace::Workspace,
) -> std::collections::BTreeSet<String> {
    match workspace.list_tree_filtered_unified() {
        Ok(entries) => entries
            .into_iter()
            .filter(|e| !e.is_dir)
            .map(|e| e.path)
            .collect(),
        Err(_) => std::collections::BTreeSet::new(),
    }
}

/// Workspace-relative directory paths from the same walk
/// `workspace_disk_files` uses. Used to recognise markdown links whose
/// target is a directory (doc-navigation links like
/// `[notes](../alex/)`); those don't carry between-file graph
/// semantics and would otherwise fall through to ghost emission as
/// `kind: file` missing nodes.
///
/// Returns an empty set on `list_tree` failure so callers degrade
/// to "no directory filtering", i.e. the pre-fix behaviour, rather
/// than failing the request.
fn workspace_disk_dirs(
    workspace: &chan_workspace::Workspace,
) -> std::collections::BTreeSet<String> {
    match workspace.list_tree_filtered_unified() {
        Ok(entries) => entries
            .into_iter()
            .filter(|e| e.is_dir)
            .map(|e| e.path)
            .collect(),
        Err(_) => std::collections::BTreeSet::new(),
    }
}

/// Image subset of `workspace_disk_files`. Kept as its own predicate so
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

/// True only for regular files in chan's public namespace.
/// Uses Workspace so drafts (in the in-root `.Drafts/` dir) share the
/// same truth as `/api/files` and MCP content tools.
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
        .and_then(|p| p.to_str())
        .filter(|p| !p.is_empty())
        .unwrap_or("")
        .replace('\\', "/")
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
            if file.language.to_lowercase() != *filter {
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
        ranked.sort_by(|(a_path, a), (b_path, b)| {
            b.files
                .cmp(&a.files)
                .then_with(|| b.code.cmp(&a.code))
                .then_with(|| a_path.cmp(b_path))
        });

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
    }
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
/// Empirical motivation: a real workspace seed had 1973
/// imported contact files vs only ~49 unique `@@Handle` strings
/// in markdown bodies. The prior behaviour emitted all 1973
/// contact File nodes; this filter collapses to the referenced
/// subset (~49).
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

    fn merge_tree_entry(&mut self, entry: &chan_workspace::TreeEntry) {
        let path = entry.path.trim_matches('/');
        if path.is_empty() {
            self.ensure_directory_path("");
            return;
        }
        let parent = parent_directory(path);
        self.ensure_directory_path(&parent);
        if entry.is_dir {
            self.ensure_directory_path(path);
        } else {
            self.merge_tree_file_node(path);
            self.push_contains_edge(directory_node_id(&parent), path.to_string());
        }
    }
}

fn merge_unified_tree_layer(
    workspace: &chan_workspace::Workspace,
    p: &GraphParams,
    nodes: &mut std::collections::BTreeMap<String, GraphNodeView>,
    edges: &mut Vec<GraphEdgeView>,
    report_buckets: &std::collections::HashMap<String, ReportFileBucket>,
) {
    let path = graph_scope_path(p);
    // Filtered listing so the semantic graph's tree layer excludes the
    // same blocklist dirs (`node_modules/`, `target/`, ...) the index,
    // the File Browser spine, and the fs-graph walker exclude. The
    // comment below ("same file coverage as the File Browser") holds
    // because the File Browser spine is itself filtered (bootstrap).
    let entries = match p.scope {
        GraphScope::Workspace => workspace.list_tree_filtered_unified(),
        GraphScope::Directory | GraphScope::File => {
            workspace.list_tree_prefix_filtered_unified(path)
        }
    };
    let Ok(mut entries) = entries else {
        return;
    };
    entries.sort_by(|a, b| a.path.cmp(&b.path));

    let mut ctx = TreeMergeCtx::new(workspace, report_buckets, nodes, edges);
    ctx.ensure_directory_path("");
    let mut blocked_dirs: Vec<String> = Vec::new();
    for entry in &entries {
        let entry_path = entry.path.trim_matches('/');
        if blocked_dirs
            .iter()
            .any(|dir| entry_path != dir && entry_path.starts_with(&format!("{dir}/")))
        {
            continue;
        }
        ctx.merge_tree_entry(entry);
        if entry.is_dir
            && matches!(
                path_class_for_graph(workspace, entry_path),
                Some(class) if class.permission == PathPermission::ReadOnly
            )
        {
            blocked_dirs.push(entry_path.to_string());
        }
    }

    // Anchor every included file to its folder ancestors. In directory/file
    // scope the file NODES are seeded workspace-wide (a node per indexed file,
    // plus referenced on-disk targets), but the tree walk above is
    // PREFIX-scoped -- so any file outside the scoped subtree gets a node with
    // no `contains` ancestor chain and the frontend renders it edgeless. Spine
    // each remaining non-missing file to its parent directory chain so
    // directory scope keeps the "no file renders edgeless" invariant Workspace
    // scope already has. This mirrors the Workspace-scope walk (which spines
    // the whole tree); the extra out-of-prefix folder bubbles are
    // declutterable via the folder chip. No directory is special-cased -- a
    // draft's `.Drafts` parent is anchored exactly like any other live
    // directory. The spine ops are idempotent (`edge_set`/`merge_directory_node`
    // dedup), so an in-scope file already spined by the prefix walk is a no-op.
    // Workspace scope already walks the full tree, so it needs no backfill.
    if !matches!(p.scope, GraphScope::Workspace) {
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
}

#[cfg(test)]
fn merge_filesystem_layer(
    workspace: &chan_workspace::Workspace,
    p: &GraphParams,
    nodes: &mut std::collections::BTreeMap<String, GraphNodeView>,
    edges: &mut Vec<GraphEdgeView>,
) -> Result<(), super::fs_graph::FsGraphError> {
    let report_buckets = report_buckets_for_graph(workspace);
    merge_filesystem_layer_with_buckets(workspace, p, nodes, edges, &report_buckets)
}

fn merge_filesystem_layer_with_buckets(
    workspace: &chan_workspace::Workspace,
    p: &GraphParams,
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
        edges.push(GraphEdgeView {
            source,
            target,
            kind: match edge.kind {
                "contains" => "contains",
                "symlink" => "link",
                "hardlink" => "link",
                _ => edge.kind,
            },
            broken: None,
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
    merge_unified_tree_layer(workspace, p, nodes, edges, report_buckets);

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
    // splays out to EVERY file of that language. The prior shape
    // went through `build_language_graph`, which aggregates files
    // into per-directory edges with a depth-bounded top-N rank --
    // fine for the /api/graph/languages overview surface but it had
    // the workspace lens showing only the top dir per language
    // (clicking a language surfaced a single directory out of
    // many). The Workspace
    // filesystem layer already emits each file as a node + the
    // contains-edges that anchor it to the spine, so per-file
    // language edges plug straight into the rendered graph.
    //
    // /api/graph/languages keeps using `build_language_graph`
    // for the overview's directory rollup (with `?depth=N`
    // ranking); only the workspace lens path moves.
    //
    // The file-NODE set comes from the unified tree
    // layer (the full File Browser namespace), but the language
    // EDGE set used to come from a scope-restricted report
    // (`report_for_prefix` / `report_for_files`). In directory and
    // file scope the tree layer pulls in spine and link-target
    // files that live OUTSIDE the scoped prefix, so those file
    // nodes had no language edge and rendered disconnected
    // (floating) even when they were of a recognized language.
    // We now drive the language edges off the SAME namespace as the
    // nodes: take per-file language from the FULL workspace report
    // (`report.files`, whose `language` is `tokei`'s classification
    // and is never empty for a tracked file) and emit a `language`
    // edge for every File node already present in `nodes` that the
    // report tracks. Media/binary files return no language from the
    // report (and are separate node kinds), so they never get a
    // spurious edge. Language-node `files`/`code` counts aggregate
    // only over the file nodes actually rendered.

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
    blocking_response(
        move || {
            let report = match workspace.report() {
                Ok(r) => r,
                Err(e) => return err_from(&e),
            };
            Json(build_language_graph(
                &report.files,
                p.depth,
                p.language.as_deref(),
            ))
            .into_response()
        },
        "language graph",
    )
    .await
}

pub async fn api_graph(
    State(state): State<Arc<AppState>>,
    Query(q): Query<GraphQuery>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let stream = query_flag(&q.stream);
    let params = q.into_params();
    // While the first index builds, the graph DB is saturated by the
    // reindex writer (esp. on Windows, where reindex pacing can't read
    // fd pressure). Reading it here would queue behind that work and
    // freeze the workspace window's graph panel. Return an empty graph
    // immediately instead; the SPA re-fetches when indexing completes
    // (indexing-state poll + invalidateGraph), so the panel fills in
    // once the build is done rather than hanging now.
    if workspace.is_reindexing() {
        if stream {
            return empty_graph_stream_response(params).await;
        }
        return Json(GraphViewResponse {
            nodes: Vec::new(),
            edges: Vec::new(),
        })
        .into_response();
    }
    if stream {
        return stream_graph_response(workspace, params).await;
    }
    blocking_response(move || api_graph_sync(workspace, params), "graph").await
}

/// Empty NDJSON graph stream (`meta` + `done`, no nodes/edges) returned
/// while the first index builds. Mirrors the wire shape of a normal
/// `?stream=1` response so the SPA's stream consumer completes cleanly
/// and simply renders nothing until its post-index re-fetch.
async fn empty_graph_stream_response(p: GraphParams) -> Response {
    let mut bytes = match graph_ndjson_bytes(&GraphStreamEvent::Meta {
        scope: p.scope,
        path: p.path.clone(),
        depth: p.depth,
    }) {
        Ok(b) => b.to_vec(),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("graph stream meta encode: {e}"),
            )
                .into_response()
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
    }) {
        return Err(GraphBuildError::Cancelled);
    }

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
    workspace: Arc<chan_workspace::Workspace>,
    p: GraphParams,
) -> Response {
    let (tx, mut rx) = mpsc::channel::<GraphStreamMessage>(8);
    tokio::task::spawn_blocking(move || {
        let result = stream_graph_sync(workspace, p, |bytes| {
            tx.blocking_send(GraphStreamMessage::Data(bytes)).is_ok()
        });
        match result {
            Ok(()) | Err(GraphBuildError::Cancelled) => {}
            Err(e) => {
                let _ = tx.blocking_send(GraphStreamMessage::Error(e));
            }
        }
    });

    let first = match rx.recv().await {
        Some(GraphStreamMessage::Data(bytes)) => bytes,
        Some(GraphStreamMessage::Error(e)) => return e.into_response(),
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "graph stream ended before metadata",
            )
                .into_response()
        }
    };
    let rest = stream::unfold(rx, |mut rx| async {
        rx.recv().await.map(|message| {
            let bytes = match message {
                GraphStreamMessage::Data(bytes) => bytes,
                GraphStreamMessage::Error(e) => graph_ndjson_error_bytes(e.to_string()),
            };
            (Ok::<Bytes, Infallible>(bytes), rx)
        })
    });
    let body =
        Body::from_stream(stream::once(async move { Ok::<Bytes, Infallible>(first) }).chain(rest));
    ([(header::CONTENT_TYPE, "application/x-ndjson")], body).into_response()
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
    // File treatment further down.
    let disk_files = workspace_disk_files(&workspace);
    let image_files = image_subset(&disk_files);
    // Directory entries from the same walk. Markdown links whose
    // target is a directory (e.g. `[notes](../notes/)`) used to
    // fall through to ghost emission as `kind: file` missing nodes;
    // we filter them out of the ghost path and drop the corresponding
    // edges below.
    let disk_dirs = workspace_disk_dirs(&workspace);
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
    // the mention edge's dst, so `@@alice` no longer renders as a
    // standalone yellow text node alongside the Contacts/alice.md
    // file node, so the two collapse into one.
    let contact_rows = workspace.contacts().unwrap_or_default();
    let contact_paths: std::collections::HashSet<String> =
        contact_rows.iter().map(|c| c.rel_path.clone()).collect();
    // `graph_file_set` is the indexed-only view; `file_set` is the
    // full link-resolution oracle (graph + all on-disk files). Keep
    // both: graph_file_set workspaces the "is this a real graph node?"
    // gate used when synthesizing referenced-disk-file nodes, while
    // file_set is what resolve_link_dst and ghost classification
    // consult.
    let graph_file_set: std::collections::BTreeSet<&str> =
        files.iter().map(String::as_str).collect();
    let mut file_set = graph_file_set.clone();
    for f in &disk_files {
        file_set.insert(f.as_str());
    }
    let mut present_file_set = present_files.clone();
    for f in &disk_files {
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
    // Track the set of contact file paths that ARE
    // referenced by some mention edge. This drives the per-file
    // emit filter below: contact-frontmatter files that aren't
    // referenced anywhere get skipped from the graph (vs the prior
    // behaviour where every imported contact became a node, which
    // exploded the graph to 1973 contact nodes against ~49 unique
    // referenced handles on a real seed workspace). Resolved
    // contacts ARE kept; unresolved mentions still synthesize a
    // `@@name` Mention node via the existing mention_set loop.
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
    // Before the filter a real seed workspace surfaced 1973 contact
    // nodes; after, only the ~49 referenced ones.
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
    // No ghost nodes. We used to synthesize a muted `File { missing:
    // true }` per unresolved link target, but on a big tree (e.g.
    // graphing a source checkout) they were pure clutter, never
    // navigable. `ghost_set` now ONLY drives the edge drop in
    // the filter below, so a broken link contributes neither a node nor
    // a dangling edge. (Indexed files that vanished from disk still
    // render as `missing` via the `files` loop above; that is a stale-
    // index signal, distinct from an unresolved link target.)

    // The drafts dir is a real in-root directory now, so it arrives as a
    // normal `directory:<drafts_dir>` node with a `contains` edge from
    // root through the filesystem / tree layers below. No special
    // synthesis is needed.
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
        // the ghost-set loop above skips ghost emission for those,
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
            // Drop link edges to unresolved targets. We no longer
            // synthesize ghost nodes for them, so the edge would
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
            // prefix; the previous format!("#{}", e.dst) for tag
            // edges was double-prefixing into "##name" and orphaning
            // every tag edge.
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
    merge_filesystem_layer_with_buckets(&workspace, &p, &mut nodes, &mut edges, &report_buckets)?;
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
        return stream_backlinks_response(workspace, path).await;
    }
    blocking_response(move || api_backlinks_sync(workspace, path), "backlinks").await
}

/// Empty NDJSON backlinks stream (`meta` + `done`) returned while the
/// first index builds. Same wire shape as a normal `?stream=1` response
/// so the SPA consumer completes cleanly with no edges.
async fn empty_backlinks_stream_response(path: String) -> Response {
    let mut bytes = match backlinks_ndjson_bytes(&BacklinksStreamEvent::Meta {
        path: path.as_str(),
    }) {
        Ok(b) => b.to_vec(),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("backlinks stream meta encode: {e}"),
            )
                .into_response()
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
    workspace: Arc<chan_workspace::Workspace>,
    path: String,
) -> Response {
    let (tx, mut rx) = mpsc::channel::<BacklinksStreamMessage>(8);
    tokio::task::spawn_blocking(move || {
        let result = stream_backlinks_sync(&workspace, &path, |bytes| {
            tx.blocking_send(BacklinksStreamMessage::Data(bytes))
                .is_ok()
        });
        match result {
            Ok(()) | Err(chan_workspace::ChanError::Cancelled) => {}
            Err(e) => {
                let _ = tx.blocking_send(BacklinksStreamMessage::Error(e));
            }
        }
    });

    let first = match rx.recv().await {
        Some(BacklinksStreamMessage::Data(bytes)) => bytes,
        Some(BacklinksStreamMessage::Error(e)) => return err_from(&e),
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "backlinks stream ended before metadata",
            )
                .into_response()
        }
    };
    let rest = stream::unfold(rx, |mut rx| async {
        rx.recv().await.map(|message| {
            let bytes = match message {
                BacklinksStreamMessage::Data(bytes) => bytes,
                BacklinksStreamMessage::Error(e) => backlinks_ndjson_error_bytes(e.to_string()),
            };
            (Ok::<Bytes, Infallible>(bytes), rx)
        })
    });
    let body =
        Body::from_stream(stream::once(async move { Ok::<Bytes, Infallible>(first) }).chain(rest));
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
    // resolver couldn't tell that "LICENSE" was a real file.
    let disk_files = workspace_disk_files(workspace);
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

    #[test]
    fn workspace_disk_files_includes_non_markdown_targets() {
        // The link resolver in `api_graph` walks the workspace once via
        // `workspace_disk_files` and uses the result as the universe of
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

        let disk = workspace_disk_files(&workspace);
        assert!(disk.contains("LICENSE"), "got {disk:?}");
        assert!(disk.contains("src/lib.rs"));
        assert!(disk.contains("scripts/build.sh"));
        assert!(disk.contains("notes/a.md"));
    }

    #[test]
    fn link_to_non_markdown_disk_file_resolves_to_real_file() {
        // Regression: a markdown file linking to a
        // non-graph regular file (LICENSE, src/lib.rs, ...) was being
        // classified as a broken link, with a synthesized ghost
        // File { missing: true } overriding the FS layer's real entry.
        // After the fix, disk_files participates in file_set so
        // ghost_set stays empty for the LICENSE case, and the
        // referenced-disk-files set picks up a `File { missing: false }`
        // node instead.
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

        let disk = workspace_disk_files(&workspace);
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
        // File { missing: false } node for it instead of the previous ghost.
        assert!(disk.contains("LICENSE"));
        assert!(!graph_file_set.contains("LICENSE"));
        assert!(!is_image_path("LICENSE"));
    }

    #[test]
    fn workspace_disk_dirs_includes_directory_entries() {
        // Pin the helper contract: every regular directory
        // the user might link to has to show up here so api_graph can
        // recognise `[label](some/dir/)` targets and keep them out of
        // ghost emission. The companion `workspace_disk_files` set is
        // unaffected (it filters `is_dir` out the other way).
        let (_cfg, root, workspace) = open_workspace();
        put(root.path(), "docs/intro.md", b"# Intro\n");
        put(root.path(), "docs/agents/alice.md", b"# alice\n");
        put(root.path(), "notes/inner/deep.md", b"# deep\n");

        let dirs = workspace_disk_dirs(&workspace);
        assert!(dirs.contains("docs"), "got {dirs:?}");
        assert!(dirs.contains("docs/agents"));
        assert!(dirs.contains("notes"));
        assert!(dirs.contains("notes/inner"));
        // Files should not appear in the dirs set.
        assert!(!dirs.contains("docs/intro.md"));
        assert!(!dirs.contains("docs/agents/alice.md"));

        // Files set stays clean of directories. The two helpers split
        // the same walk; pin that the split is exclusive.
        let files = workspace_disk_files(&workspace);
        assert!(files.contains("docs/intro.md"));
        assert!(!files.contains("docs"));
        assert!(!files.contains("docs/agents"));
    }

    #[test]
    fn link_to_directory_does_not_synthesize_ghost_file_node() {
        // Regression: a markdown link whose target is
        // a directory (e.g. `[notes](../notes/)`)
        // used to fall through `file_set` (graph_files filters to
        // markdown / contact; disk_files filters `!is_dir`) and land
        // in ghost_set as `File { missing: true }`. After the fix,
        // disk_dirs participates in the ghost-set guard so the
        // directory target is skipped entirely; the corresponding
        // link edge is dropped by the edge filter so Cytoscape never
        // sees a dangling target.
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

        let disk_files = workspace_disk_files(&workspace);
        let disk_dirs = workspace_disk_dirs(&workspace);
        assert!(disk_dirs.contains("some-dir"), "got {disk_dirs:?}");
        // The link target is NOT a file on disk (it's the directory).
        // Pinning this rules out the referenced-disk-file path
        // accidentally covering the symptom.
        assert!(!disk_files.contains("some-dir"));

        // Simulate the api_graph ghost-set check: file_set is
        // graph_files ∪ disk_files. disk_dirs entries are absent
        // from file_set, so the pre-fix path would have inserted
        // `some-dir` into ghost_set. The new guard skips that.
        let graph_files = graph.files().unwrap();
        let graph_file_set: std::collections::BTreeSet<&str> =
            graph_files.iter().map(String::as_str).collect();
        let mut file_set = graph_file_set.clone();
        for f in &disk_files {
            file_set.insert(f.as_str());
        }
        assert!(!file_set.contains(link.dst.as_str()));
        // Pre-fix: would synthesize ghost. Post-fix: directory check
        // wins, ghost stays empty.
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
        let (_cfg, root, workspace) = open_workspace();
        let root_path = root.path().to_path_buf();
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

    #[test]
    fn drafts_dir_appears_as_natural_directory() {
        // Drafts are now real in-root files under the configured drafts dir
        // and are no longer special-cased -- the drafts directory is just
        // another live directory. It arrives as a normal `directory:.Drafts`
        // node anchored by a real `contains` edge from root via the
        // filesystem / tree layers (no synthetic edge kind), and an indexed
        // draft is anchored in a non-drafts directory scope exactly like any
        // other out-of-prefix file.
        let (_cfg, _root, workspace) = open_workspace();
        workspace.create_draft_dir("untitled").unwrap();
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
        // The indexed draft is a workspace-wide node, so it is anchored into
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
        // Regression: a contact file referenced only by a markdown LINK
        // (not an @@mention) is dropped from the semantic batch by
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
        // The contact-file emit filter pins the
        // graph view to "who-mentions-whom". Pre-fix behaviour
        // emitted every imported contact File node regardless of
        // whether it was referenced; a real seed workspace had
        // 1973 contact files vs ~49 unique @@Handle strings in
        // markdown bodies. After the fix, only referenced contacts
        // survive.
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
        // renders the bubble plus every file. The prior shape went
        // via `build_language_graph` which collapsed files into
        // top-N per-directory edges, which left the language lens
        // showing a single directory instead of every file.
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
        // it lives in. The prior implementation kept only the
        // top-N directory edges per the `depth` parameter; the
        // workspace lens is now decoupled from that ranking.
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
        // with no config. Workspaces the runaway-node-count fix.
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

        let (_cfg, root, workspace) = open_workspace();
        put(root.path(), "locked/hidden.md", b"# Hidden\n");
        std::fs::set_permissions(
            root.path().join("locked"),
            std::fs::Permissions::from_mode(0o555),
        )
        .unwrap();

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
    }
}
