//! Filename + content search and indexer status/rebuild.
//!
//! `/api/search/files` scans `list_tree` for exact-basename missing-file
//! recovery candidates. `/api/search/content` defers to
//! `Workspace::search`: BM25, or hybrid (BM25 + dense, RRF-fused) when
//! the workspace opted in via `semantic_enabled` and the embedding model
//! is on disk. `/api/index/status` and `/api/index/rebuild` surface the
//! background indexer's state machine.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chan_workspace::{
    fs_ops, EffectiveSearchMode, SearchMode, SearchOpts, TreeEntry, WorkspaceReadiness,
    WorkspaceSearchRequest,
};
use serde::{Deserialize, Serialize};

use crate::error::{err_from, err_state};
use crate::indexer::IndexStatus;
use crate::state::AppState;

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

/// Missing-file recovery params. `q` is the complete basename.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileSearchParams {
    #[serde(default)]
    q: String,
    #[serde(default = "default_search_limit")]
    limit: usize,
}

fn default_search_limit() -> usize {
    50
}

const MAX_FILE_SEARCH_LIMIT: usize = 50;

fn filename_recovery(
    workspace: &chan_workspace::Workspace,
    basename: &str,
    limit: usize,
) -> chan_workspace::Result<Vec<TreeEntry>> {
    filename_recovery_with_contact_paths(workspace, basename, limit, || {
        Ok(workspace
            .contacts()?
            .into_iter()
            .map(|contact| contact.rel_path)
            .collect())
    })
}

fn filename_recovery_with_contact_paths(
    workspace: &chan_workspace::Workspace,
    basename: &str,
    limit: usize,
    load_contact_paths: impl FnOnce() -> chan_workspace::Result<BTreeSet<String>>,
) -> chan_workspace::Result<Vec<TreeEntry>> {
    let tree = workspace.list_tree()?;
    let contact_paths = load_contact_paths()?;
    let mut hits: Vec<TreeEntry> = tree
        .into_iter()
        .filter(|entry| {
            !entry.is_dir
                && Path::new(&entry.path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    == Some(basename)
                && !contact_paths.contains(&entry.path)
        })
        .collect();
    hits.sort_by(|left, right| left.path.cmp(&right.path));
    hits.truncate(limit.min(MAX_FILE_SEARCH_LIMIT));
    Ok(hits)
}

/// Exact-basename lookup for missing-file reopen suggestions.
pub async fn api_search_files(
    State(state): State<Arc<AppState>>,
    Query(p): Query<FileSearchParams>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    blocking_response(
        move || match filename_recovery(&workspace, &p.q, p.limit) {
            Ok(hits) => Json(hits).into_response(),
            Err(error) => err_from(&error),
        },
        "file search",
    )
    .await
}

#[derive(Deserialize)]
pub struct ContentSearchParams {
    #[serde(default)]
    q: String,
    #[serde(default = "default_content_limit")]
    limit: u32,
    /// Optional subdir scope (POSIX rel path under the workspace root).
    /// Mirrors chan-workspace's `SearchOpts::scope`.
    #[serde(default)]
    scope: Option<String>,
}

fn default_content_limit() -> u32 {
    20
}

/// `/api/search/content` view. The search index can return multiple
/// matching chunks/headings per file; the UI wants one row per file,
/// carrying the best-ranked heading/snippet for that path.
#[derive(Serialize)]
struct ContentSearchResponse {
    /// Compatibility projection of `readiness`: false during workspace
    /// recovery, and also false if the selected search mode degraded.
    ready: bool,
    readiness: WorkspaceReadiness,
    /// Mode actually used: "bm25" (tantivy) or "hybrid" (BM25 + dense,
    /// RRF-fused). Hybrid is selected when the workspace opted in via
    /// `semantic_enabled` and the embedding model is on disk; otherwise
    /// the query is BM25-only. The value is the mode the facade actually
    /// ran, which collapses to "bm25" on a build without `embeddings`.
    mode: &'static str,
    hits: Vec<ContentHit>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
struct ContentHit {
    path: String,
    chunk_id: String,
    heading: String,
    start_line: u32,
    snippet: String,
    score: f32,
}

fn legacy_search_mode(mode: EffectiveSearchMode) -> SearchMode {
    match mode {
        EffectiveSearchMode::Hybrid => SearchMode::Hybrid,
        EffectiveSearchMode::NotRun | EffectiveSearchMode::Bm25 => SearchMode::Bm25,
    }
}

pub async fn api_search_content(
    State(state): State<Arc<AppState>>,
    Query(p): Query<ContentSearchParams>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    search_content_with_mode_resolver(workspace, p, |workspace| {
        Ok((
            legacy_search_mode(workspace.effective_search_mode()?),
            workspace.readiness(),
        ))
    })
    .await
}

async fn search_content_with_mode_resolver(
    workspace: Arc<chan_workspace::Workspace>,
    p: ContentSearchParams,
    resolve_mode: impl FnOnce(
            &chan_workspace::Workspace,
        ) -> chan_workspace::Result<(SearchMode, WorkspaceReadiness)>
        + Send
        + 'static,
) -> Response {
    let response_limit = normalized_content_limit(p.limit);
    blocking_response(
        move || {
            // Effective mode reads disk-backed configuration. Resolve it with
            // readiness and search in this one blocking operation.
            let (mode, readiness) = match resolve_mode(&workspace) {
                Ok(snapshot) => snapshot,
                Err(error) => return err_from(&error),
            };
            if !readiness.is_ready() || p.q.trim().is_empty() {
                return Json(ContentSearchResponse {
                    ready: readiness.is_ready(),
                    readiness,
                    mode: mode.label(),
                    hits: Vec::new(),
                })
                .into_response();
            }
            let opts = SearchOpts {
                mode,
                limit: expanded_content_candidate_limit(response_limit),
                scope: p.scope,
            };
            let results = match workspace.search(&p.q, &opts) {
                Ok(r) => r,
                Err(e) => return err_from(&e),
            };
            let hits = collapse_hits_by_file(
                results.hits.into_iter().map(ContentHit::from),
                response_limit,
            );
            let readiness = workspace.readiness();
            if !readiness.is_ready() {
                return Json(ContentSearchResponse {
                    ready: false,
                    readiness,
                    mode: results.mode,
                    hits: Vec::new(),
                })
                .into_response();
            }
            Json(ContentSearchResponse {
                ready: results.ready,
                readiness,
                mode: results.mode,
                hits,
            })
            .into_response()
        },
        "content search",
    )
    .await
}

/// Unified bounded retrieval and traversal. Syntactic JSON failures are HTTP
/// 400; structured core request/selector failures remain HTTP 200 alongside
/// successful partial fields.
pub async fn api_search_workspace(
    State(state): State<Arc<AppState>>,
    payload: Result<Json<WorkspaceSearchRequest>, JsonRejection>,
) -> Response {
    let Json(request) = match payload {
        Ok(payload) => payload,
        Err(rejection) => {
            return (StatusCode::BAD_REQUEST, rejection.body_text()).into_response();
        }
    };
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    blocking_response(
        move || match workspace.workspace_search(&request) {
            Ok(result) => Json(result).into_response(),
            Err(error) => err_from(&error),
        },
        "workspace search",
    )
    .await
}

impl From<chan_workspace::Hit> for ContentHit {
    fn from(h: chan_workspace::Hit) -> Self {
        Self {
            path: h.path,
            chunk_id: h.chunk_id,
            heading: h.heading,
            start_line: u32::try_from(h.start_line).unwrap_or(u32::MAX),
            snippet: h.snippet,
            score: h.score,
        }
    }
}

fn normalized_content_limit(limit: u32) -> u32 {
    if limit == 0 {
        default_content_limit()
    } else {
        limit
    }
}

fn expanded_content_candidate_limit(limit: u32) -> u32 {
    let widened = limit.saturating_mul(8);
    let cap = limit.max(200);
    widened.min(cap)
}

/// Collapse score-descending search hits to the best hit per file.
fn collapse_hits_by_file<I>(hits: I, limit: u32) -> Vec<ContentHit>
where
    I: IntoIterator<Item = ContentHit>,
{
    let mut out: Vec<ContentHit> = Vec::new();
    for hit in hits {
        if out.iter().any(|existing| existing.path == hit.path) {
            continue;
        }
        out.push(hit);
        if out.len() >= limit as usize {
            break;
        }
    }
    out
}

/// Index status snapshot. Reads the live `IndexStatus` from the
/// background indexer; shape mirrors the frontend's IndexStatus
/// tagged union (Settings -> Search index). The indexer flips
/// the snapshot to Building / Reindexing while a pass is in
/// flight and to Idle (with chunk + vector counts plus the
/// embedding model id) when it settles.
pub async fn api_index_status(State(state): State<Arc<AppState>>) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    match state.try_indexer() {
        Ok(indexer) => Json(IndexStatusResponse {
            status: indexer.snapshot(),
            readiness: workspace.readiness(),
        })
        .into_response(),
        Err(error) => err_state(&error),
    }
}

#[derive(Debug, Clone, Serialize)]
struct IndexStatusResponse {
    #[serde(flatten)]
    status: IndexStatus,
    readiness: WorkspaceReadiness,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IndexingStateResponse {
    root: String,
    nodes: Vec<IndexingStateNode>,
    readiness: WorkspaceReadiness,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IndexingStateNode {
    path: String,
    state: IndexingDirectoryState,
    children_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexingDirectoryState {
    Indexed,
    Indexing,
    Pending,
}

#[derive(Default)]
struct DirectoryStateAccum {
    children_count: usize,
    indexable_files: usize,
    indexed_files: usize,
    indexing: bool,
}

/// Dir-only indexing state for the empty-pane carousel. The server
/// derives the view from the same filtered tree used by reindexing
/// plus the persisted BM25 path snapshot, avoiding any parse/embed
/// work on the request path.
pub async fn api_indexing_state(State(state): State<Arc<AppState>>) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(e) => return err_state(&e),
    };
    let indexer = match state.try_indexer() {
        Ok(indexer) => indexer,
        Err(e) => return err_state(&e),
    };
    let status = indexer.snapshot();
    // The embed sweep reaches Idle{embedding:Some} (BM25 committed, vectors
    // still flushing) with no per-file label, so it has to be signalled
    // separately from `current_file`.
    let embed_sweep = is_embedding_sweep(&status);
    let current_file = current_index_file(status);
    let readiness = workspace.readiness();
    blocking_response(
        move || {
            let entries =
                match fs_ops::list_tree_filtered(workspace.root(), workspace.walk_filter()) {
                    Ok(entries) => entries,
                    Err(e) => return err_from(&e),
                };
            let indexed_paths = match workspace.indexed_paths() {
                Ok(paths) => paths.into_iter().collect::<BTreeSet<_>>(),
                Err(e) => {
                    tracing::warn!(error = %e, "indexing-state: failed to snapshot indexed paths");
                    BTreeSet::new()
                }
            };
            Json(build_indexing_state(
                &entries,
                &indexed_paths,
                current_file.as_deref(),
                embed_sweep,
                readiness,
            ))
            .into_response()
        },
        "indexing state",
    )
    .await
}

fn current_index_file(status: IndexStatus) -> Option<String> {
    match status {
        IndexStatus::Building { file, .. } | IndexStatus::Reindexing { file } => Some(file),
        // During the background embed sweep the search index is Idle, but the
        // embed pass still drains file by file and stamps the live label onto
        // the chip. Surface it so the indexing spine pulses one directory at a
        // time instead of the whole tree (see build_indexing_state). `None`
        // between batch flushes falls back to the broad sweep below.
        IndexStatus::Idle {
            embedding: Some(p), ..
        } => p.file,
        IndexStatus::Idle { .. } | IndexStatus::Error { .. } => None,
    }
}

/// True while the background embedding pass is running: the search index
/// flips to `Idle { embedding: Some(..) }` once BM25 is committed and
/// searchable, then keeps re-embedding in the background for the rest of
/// the (minutes-long, on a big workspace) sweep. `current_index_file` is
/// `None` across that whole window, so this is the only signal the spine
/// has to pulse the dirs that still have vectors pending.
fn is_embedding_sweep(status: &IndexStatus) -> bool {
    matches!(
        status,
        IndexStatus::Idle {
            embedding: Some(_),
            ..
        }
    )
}

fn build_indexing_state(
    entries: &[TreeEntry],
    indexed_paths: &BTreeSet<String>,
    current_file: Option<&str>,
    embedding_sweep: bool,
    readiness: WorkspaceReadiness,
) -> IndexingStateResponse {
    let mut dirs = BTreeMap::<String, DirectoryStateAccum>::new();
    dirs.insert(String::new(), DirectoryStateAccum::default());

    for entry in entries.iter().filter(|entry| entry.is_dir) {
        dirs.entry(entry.path.clone()).or_default();
        dirs.entry(parent_dir(&entry.path).to_string())
            .or_default()
            .children_count += 1;
    }

    let mut current_file_matched_entry = false;
    for entry in entries
        .iter()
        .filter(|entry| !entry.is_dir && fs_ops::is_indexable_text(&entry.path))
    {
        for dir in ancestor_dirs_for_file(&entry.path) {
            let accum = dirs.entry(dir).or_default();
            accum.indexable_files += 1;
            if indexed_paths.contains(&entry.path) {
                accum.indexed_files += 1;
            }
            if current_file == Some(entry.path.as_str()) {
                accum.indexing = true;
                current_file_matched_entry = true;
            }
        }
    }

    // Broaden "one dir is indexing" into "the whole sweep is indexing" ONLY
    // when there's active indexing but no per-file label to pin it to, so a
    // long pass pulses the spine instead of looking idle - without painting
    // every dir orange when we DO know which file is in flight:
    //
    // - `embedding_sweep`: the background embed phase. The indexer commits
    //   BM25 then flips to `Idle { embedding: Some(..) }` and re-embeds for
    //   the rest of the (minutes-long) pass. It now stamps the draining file
    //   onto the chip, so `current_file` is usually a real path (matched
    //   per-entry above -> one dir pulses) and only `None` between batch
    //   flushes. The broad sweep is the fallback for those gaps.
    //
    // - `current_file.is_some()`: the foreground build emits `Building.file`
    //   as a real workspace-relative path during `GraphRebuild` / `IndexFile`
    //   (matched per-entry above, one dir) but as the empty string `""` in the
    //   initial Building window before the first per-file event
    //   (indexer.rs:310-314). The empty label matches no entry.
    //
    // Whenever the label DID match an entry (`current_file_matched_entry`) -
    // a real IndexFile / Reindexing / embed-drain file - stay on the narrower
    // one-dir path so individual paths transition independently.
    let broad_sweep = (embedding_sweep || current_file.is_some()) && !current_file_matched_entry;
    let nodes = dirs
        .into_iter()
        .map(|(path, accum)| {
            let in_progress = accum.indexing || (broad_sweep && accum.indexable_files > 0);
            let state = if in_progress {
                IndexingDirectoryState::Indexing
            } else if accum.indexable_files > 0 && accum.indexed_files == accum.indexable_files {
                IndexingDirectoryState::Indexed
            } else {
                IndexingDirectoryState::Pending
            };
            IndexingStateNode {
                path,
                state,
                children_count: accum.children_count,
            }
        })
        .collect();

    IndexingStateResponse {
        root: String::new(),
        nodes,
        readiness,
    }
}

fn ancestor_dirs_for_file(path: &str) -> Vec<String> {
    let mut dirs = vec![String::new()];
    let mut rel = path;
    while let Some((parent, _name)) = rel.rsplit_once('/') {
        dirs.push(parent.to_string());
        rel = parent;
    }
    dirs
}

fn parent_dir(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _name)| parent)
}

/// Trigger a full reindex of the workspace (search + graph). Routed
/// through the background indexer's coordinator so the request
/// coalesces with anything already queued and the status
/// snapshot transitions cleanly through Building -> Idle.
/// Returns 202 Accepted: the work runs in the background and
/// progress is observable via `/api/index/status`.
pub async fn api_index_rebuild(State(state): State<Arc<AppState>>) -> Response {
    match state.try_indexer() {
        Ok(indexer) => {
            indexer.request_rebuild();
            (
                StatusCode::ACCEPTED,
                Json(serde_json::json!({"queued": true})),
            )
                .into_response()
        }
        Err(e) => err_state(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    use std::sync::{Mutex, RwLock};

    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use chan_workspace::{NoProgress, SearchAggression};
    use tempfile::TempDir;
    use tokio::sync::{broadcast, watch};
    use tower::ServiceExt;

    use crate::self_writes::SelfWrites;
    use crate::state::{AppState, WorkspaceCell};
    use crate::terminal_sessions::{Registry as TerminalRegistry, RegistryConfig};
    use crate::{EditorPrefs, ServerConfig};

    fn hit(path: &str, heading: &str, score: f32) -> ContentHit {
        ContentHit {
            path: path.to_string(),
            chunk_id: format!("{path}:{heading}"),
            heading: heading.to_string(),
            start_line: 1,
            snippet: heading.to_string(),
            score,
        }
    }

    #[test]
    fn collapse_hits_by_file_keeps_first_ranked_heading() {
        let hits = collapse_hits_by_file(
            vec![
                hit("a.md", "best", 10.0),
                hit("b.md", "only", 8.0),
                hit("a.md", "lower", 2.0),
            ],
            20,
        );

        assert_eq!(
            hits,
            vec![hit("a.md", "best", 10.0), hit("b.md", "only", 8.0)]
        );
    }

    #[test]
    fn collapse_hits_by_file_honors_limit_after_dedup() {
        let hits = collapse_hits_by_file(
            vec![
                hit("a.md", "best", 10.0),
                hit("a.md", "lower", 2.0),
                hit("b.md", "next", 1.0),
            ],
            1,
        );

        assert_eq!(hits, vec![hit("a.md", "best", 10.0)]);
    }

    #[test]
    fn expanded_content_candidate_limit_broadens_small_queries() {
        assert_eq!(normalized_content_limit(0), default_content_limit());
        assert_eq!(expanded_content_candidate_limit(20), 160);
        assert_eq!(expanded_content_candidate_limit(50), 200);
        assert_eq!(expanded_content_candidate_limit(500), 500);
    }

    fn tree_entry(path: &str, is_dir: bool) -> TreeEntry {
        TreeEntry {
            path: path.to_string(),
            is_dir,
            mtime: None,
            size: 0,
        }
    }

    #[test]
    fn indexing_state_shape_uses_dir_states_only() {
        let entries = vec![
            tree_entry("indexed", true),
            tree_entry("indexed/done.md", false),
            tree_entry("indexing", true),
            tree_entry("indexing/live.md", false),
            tree_entry("pending", true),
            tree_entry("pending/todo.md", false),
            tree_entry("assets", true),
            tree_entry("assets/logo.png", false),
        ];
        let indexed_paths = BTreeSet::from([
            "indexed/done.md".to_string(),
            "indexing/live.md".to_string(),
        ]);

        let response = build_indexing_state(
            &entries,
            &indexed_paths,
            Some("indexing/live.md"),
            false,
            WorkspaceReadiness::default(),
        );

        assert_eq!(response.root, "");
        assert!(response
            .nodes
            .iter()
            .all(|node| !node.path.ends_with(".md")));
        assert_eq!(
            response
                .nodes
                .iter()
                .find(|node| node.path == "indexed")
                .map(|node| node.state),
            Some(IndexingDirectoryState::Indexed)
        );
        assert_eq!(
            response
                .nodes
                .iter()
                .find(|node| node.path == "indexing")
                .map(|node| node.state),
            Some(IndexingDirectoryState::Indexing)
        );
        assert_eq!(
            response
                .nodes
                .iter()
                .find(|node| node.path == "pending")
                .map(|node| node.state),
            Some(IndexingDirectoryState::Pending)
        );
        assert_eq!(
            response
                .nodes
                .iter()
                .find(|node| node.path.is_empty())
                .map(|node| node.children_count),
            Some(4)
        );

        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["root"], "");
        assert_eq!(json["nodes"][0]["path"], "");
        assert!(matches!(
            json["nodes"][0]["state"].as_str(),
            Some("indexed" | "indexing" | "pending")
        ));
        assert!(json["nodes"][0]["children_count"].is_u64());
    }

    /// During the background embedding phase the indexer reports
    /// `IndexStatus::Idle { embedding: Some(..) }` (BM25 committed and
    /// searchable, vectors still flushing) with NO per-file label, so
    /// `current_file` is `None`. The embed phase runs AFTER BM25, so by
    /// then every indexable file already shows up in
    /// `workspace.indexed_paths()` (the BM25 index) - counting
    /// `indexable_files > indexed_files` would read everywhere as "BM25
    /// done" -> no orange. The `embedding_sweep` flag is the real signal
    /// (mapped from `Idle.embedding` by `is_embedding_sweep`); it marks
    /// every dir with indexable content because embeddings are still
    /// pending across the whole sweep.
    #[test]
    fn indexing_state_marks_every_dir_with_indexable_files_during_embedding_sweep() {
        let entries = vec![
            tree_entry("notes", true),
            tree_entry("notes/finished.md", false),
            tree_entry("docs", true),
            tree_entry("docs/done.md", false),
            tree_entry("docs/another.md", false),
            tree_entry("assets", true),
            tree_entry("assets/logo.png", false),
        ];
        // BM25 has already indexed every text file (embedding phase
        // runs AFTER BM25). `indexed_paths` reflects that completion.
        let indexed_paths = BTreeSet::from([
            "notes/finished.md".to_string(),
            "docs/done.md".to_string(),
            "docs/another.md".to_string(),
        ]);

        // No per-file label during the embed sweep; the embedding flag
        // carries the signal instead.
        let response = build_indexing_state(
            &entries,
            &indexed_paths,
            None,
            true,
            WorkspaceReadiness::default(),
        );

        // Every dir with indexable text flips to Indexing during the
        // embedding sweep, even if BM25 already finished. The
        // embeddings haven't flushed yet, so "in-flight" is correct.
        assert_eq!(
            response
                .nodes
                .iter()
                .find(|node| node.path == "notes")
                .map(|node| node.state),
            Some(IndexingDirectoryState::Indexing)
        );
        assert_eq!(
            response
                .nodes
                .iter()
                .find(|node| node.path == "docs")
                .map(|node| node.state),
            Some(IndexingDirectoryState::Indexing)
        );
        // Asset-only dirs carry no indexable text, so they stay
        // Pending - they're not part of the embedding sweep.
        assert_eq!(
            response
                .nodes
                .iter()
                .find(|node| node.path == "assets")
                .map(|node| node.state),
            Some(IndexingDirectoryState::Pending)
        );
        // Workspace root aggregates every descendant's indexable
        // content, so it also reads as Indexing.
        assert_eq!(
            response
                .nodes
                .iter()
                .find(|node| node.path.is_empty())
                .map(|node| node.state),
            Some(IndexingDirectoryState::Indexing)
        );
    }

    /// The embed sweep now carries the draining file's live label, so a
    /// known `current_file` during embedding pulses ONLY that directory -
    /// the rest (BM25-committed) read as Indexed. This is the fix for
    /// "every node flashes orange together, then all turn green" on a
    /// small workspace where the whole visible pass is the embed phase.
    #[test]
    fn indexing_state_embedding_sweep_with_current_file_pulses_one_dir() {
        let entries = vec![
            tree_entry("notes", true),
            tree_entry("notes/embedding.md", false),
            tree_entry("docs", true),
            tree_entry("docs/done.md", false),
        ];
        // BM25 finished the whole tree before the embed phase started.
        let indexed_paths =
            BTreeSet::from(["notes/embedding.md".to_string(), "docs/done.md".to_string()]);

        // Embed sweep AND a live per-file label for the file being drained.
        let response = build_indexing_state(
            &entries,
            &indexed_paths,
            Some("notes/embedding.md"),
            true,
            WorkspaceReadiness::default(),
        );

        // Only the dir holding the file being embedded pulses Indexing.
        assert_eq!(
            response
                .nodes
                .iter()
                .find(|node| node.path == "notes")
                .map(|node| node.state),
            Some(IndexingDirectoryState::Indexing)
        );
        // A sibling whose files are all committed reads Indexed, not
        // Indexing: with a matching file the embed sweep does not
        // broaden into an all-orange pulse.
        assert_eq!(
            response
                .nodes
                .iter()
                .find(|node| node.path == "docs")
                .map(|node| node.state),
            Some(IndexingDirectoryState::Indexed)
        );
    }

    /// The initial Building
    /// window between `IndexStatus::Building { file: String::new(), .. }`
    /// (indexer.rs:310-314) and the first per-file event also
    /// signals "indexing in progress" - treat any `current_file`
    /// that doesn't match an entry path as a broad sweep so the
    /// pre-event window doesn't read as Idle on the dashboard.
    #[test]
    fn indexing_state_marks_broad_sweep_during_initial_building_empty_file_window() {
        let entries = vec![
            tree_entry("notes", true),
            tree_entry("notes/a.md", false),
            tree_entry("docs", true),
            tree_entry("docs/b.md", false),
        ];
        let indexed_paths = BTreeSet::new();

        let response = build_indexing_state(
            &entries,
            &indexed_paths,
            Some(""),
            false,
            WorkspaceReadiness::default(),
        );

        // Empty current_file is the initial Building state; treat
        // as a broad sweep.
        assert_eq!(
            response
                .nodes
                .iter()
                .find(|node| node.path == "notes")
                .map(|node| node.state),
            Some(IndexingDirectoryState::Indexing)
        );
        assert_eq!(
            response
                .nodes
                .iter()
                .find(|node| node.path == "docs")
                .map(|node| node.state),
            Some(IndexingDirectoryState::Indexing)
        );
    }

    /// Per-entry match still takes the narrower path: a real file
    /// path being processed marks only the dirs that contain it
    /// (and its ancestors), not the rest of the workspace.
    #[test]
    fn indexing_state_per_file_match_only_marks_ancestors_of_current_file() {
        let entries = vec![
            tree_entry("notes", true),
            tree_entry("notes/current.md", false),
            tree_entry("docs", true),
            tree_entry("docs/done.md", false),
        ];
        let indexed_paths = BTreeSet::from(["docs/done.md".to_string()]);

        let response = build_indexing_state(
            &entries,
            &indexed_paths,
            Some("notes/current.md"),
            false,
            WorkspaceReadiness::default(),
        );

        // The ancestor chain of the in-flight file is Indexing.
        assert_eq!(
            response
                .nodes
                .iter()
                .find(|node| node.path == "notes")
                .map(|node| node.state),
            Some(IndexingDirectoryState::Indexing)
        );
        // A sibling dir that's fully BM25-indexed reads as Indexed,
        // not Indexing - the per-entry match didn't broaden into
        // a sweep.
        assert_eq!(
            response
                .nodes
                .iter()
                .find(|node| node.path == "docs")
                .map(|node| node.state),
            Some(IndexingDirectoryState::Indexed)
        );
    }

    /// `is_embedding_sweep` is the signal that makes the spine pulse for
    /// the whole background embed pass. Only `Idle { embedding: Some(..) }`
    /// (BM25 committed, vectors still flushing) counts; a settled idle, a
    /// foreground Building/Reindexing pass (those carry a per-file label
    /// instead), and Error do not.
    #[test]
    fn is_embedding_sweep_only_true_for_idle_with_embedding() {
        use crate::indexer::EmbedProgress;

        assert!(is_embedding_sweep(&IndexStatus::Idle {
            indexed_docs: 3,
            indexed_vectors: 1,
            model: "m".to_string(),
            embedding: Some(EmbedProgress {
                done: 1,
                total: 3,
                file: None,
            }),
        }));
        assert!(!is_embedding_sweep(&IndexStatus::Idle {
            indexed_docs: 3,
            indexed_vectors: 3,
            model: "m".to_string(),
            embedding: None,
        }));
        assert!(!is_embedding_sweep(&IndexStatus::Building {
            current: 1,
            total: 3,
            file: "notes/a.md".to_string(),
        }));
        assert!(!is_embedding_sweep(&IndexStatus::Reindexing {
            file: "notes/a.md".to_string(),
        }));
        assert!(!is_embedding_sweep(&IndexStatus::Error {
            message: "boom".to_string(),
        }));
    }

    struct RouteTestApp {
        _cfg: TempDir,
        _root: TempDir,
        state: Arc<AppState>,
    }

    fn route_test_app() -> RouteTestApp {
        let cfg = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace
            .write_text("archive/done.md", "# archived\n")
            .unwrap();
        workspace
            .write_bytes("archive/done.md.bak", b"# backup\n")
            .unwrap();
        workspace
            .write_text(
                "contacts/done.md",
                "---\nchan:\n  kind: contact\n---\n# Done\n",
            )
            .unwrap();
        workspace.write_text("notes/done.md", "# done\n").unwrap();
        workspace.write_text("notes/todo.md", "# todo\n").unwrap();
        workspace.index_file("contacts/done.md").unwrap();
        workspace.index_file("notes/done.md").unwrap();

        let (events_tx, _) = broadcast::channel::<String>(1);
        let (index_events_tx, _) = broadcast::channel::<chan_workspace::WatchEvent>(1);
        let indexer = Arc::new(crate::indexer::Indexer::spawn(
            workspace.clone(),
            index_events_tx.subscribe(),
            false,
            SearchAggression::Conservative,
            Arc::new(NoProgress),
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
            token: Some("secret".to_string()),
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
            doc_sessions: std::sync::Arc::new(crate::doc_sessions::DocRegistry::new()),
            scene_sessions: std::sync::Arc::new(crate::scene_sessions::SceneRegistry::new()),
            shutdown_rx,
            scope_registry: std::sync::Arc::new(crate::bus::ScopeRegistry::new()),
            survey_bus: std::sync::Arc::new(crate::survey::SurveyBus::new()),
            window_bus: std::sync::Arc::new(crate::window_bus::WindowBus::new()),
            handover_bus: std::sync::Arc::new(crate::handover_bus::HandoverBus::new()),
            ephemeral_sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
            ephemeral_files_sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
            terminal_session_dir: None,
            window_presence: std::sync::Arc::new(crate::window_presence::WindowPresence::new()),
            session_registry: std::sync::Arc::new(crate::session_presence::SessionRegistry::new()),
            pending_window_commands: std::sync::Arc::new(Default::default()),
            window_transfers: std::sync::Arc::new(crate::window_transfers::WindowTransfers::new()),
            window_titles: std::sync::Arc::new(crate::window_titles::WindowTitles::new()),
            bulk_transfer: crate::state::test_support::make_test_bulk_transfer_tenant(),
            instance_id: "test-instance".to_string(),
            standalone_files: None,
        });

        RouteTestApp {
            _cfg: cfg,
            _root: root,
            state,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn content_search_mode_resolution_does_not_starve_async_worker() {
        use std::sync::mpsc;
        use std::time::Duration;

        let app = route_test_app();
        let workspace = app
            .state
            .try_workspace()
            .expect("content search test workspace");
        let (resolver_started_tx, resolver_started_rx) = mpsc::channel();
        let (release_resolver_tx, release_resolver_rx) = mpsc::channel();
        let (timer_fired_tx, timer_fired_rx) = mpsc::channel();
        let coordinator = std::thread::spawn(move || {
            resolver_started_rx.recv().expect("resolver started");
            let starved = timer_fired_rx
                .recv_timeout(Duration::from_millis(200))
                .is_err();
            release_resolver_tx.send(()).expect("release resolver");
            starved
        });
        let timer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            let _ = timer_fired_tx.send(());
        });

        let response = search_content_with_mode_resolver(
            workspace,
            ContentSearchParams {
                q: String::new(),
                limit: default_content_limit(),
                scope: None,
            },
            move |_| {
                resolver_started_tx.send(()).expect("signal resolver");
                release_resolver_rx.recv().expect("resolver release");
                Ok((SearchMode::Bm25, WorkspaceReadiness::default()))
            },
        )
        .await;
        timer.await.expect("timer task");

        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            !coordinator.join().expect("coordinator"),
            "filesystem-backed mode resolution starved the single async worker"
        );
    }

    #[tokio::test]
    async fn filename_recovery_matches_exact_basename_and_sorts_paths() {
        let app = route_test_app();
        let router = crate::router(app.state);
        let request = Request::builder()
            .uri("/api/search/files?q=done.md&limit=50")
            .header(header::AUTHORIZATION, "Bearer secret")
            .body(Body::empty())
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let hits: Vec<serde_json::Value> = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            hits.iter()
                .map(|hit| hit["path"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["archive/done.md", "notes/done.md"]
        );
    }

    #[tokio::test]
    async fn filename_recovery_loads_one_contact_path_set() {
        let app = route_test_app();
        let workspace = app
            .state
            .try_workspace()
            .expect("filename recovery test workspace");
        let mut contact_set_queries = 0;
        filename_recovery_with_contact_paths(&workspace, "recovery.md", 50, || {
            contact_set_queries += 1;
            Ok(BTreeSet::new())
        })
        .expect("instrumented recovery");

        assert_eq!(contact_set_queries, 1);
    }

    #[tokio::test]
    async fn indexing_state_endpoint_requires_auth() {
        let app = route_test_app();
        let router = crate::router(app.state);
        let request = Request::builder()
            .uri("/api/indexing/state")
            .body(Body::empty())
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn indexing_state_endpoint_returns_dir_nodes() {
        let app = route_test_app();
        let router = crate::router(app.state);
        let request = Request::builder()
            .uri("/api/indexing/state")
            .header(header::AUTHORIZATION, "Bearer secret")
            .body(Body::empty())
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["root"], "");
        assert_eq!(json["readiness"]["state"], "ready");
        let nodes = json["nodes"].as_array().unwrap();
        assert!(nodes.iter().any(|node| node["path"] == ""));
        assert!(nodes.iter().any(|node| node["path"] == "notes"));
        assert!(nodes.iter().all(|node| {
            matches!(
                node["state"].as_str(),
                Some("indexed" | "indexing" | "pending")
            )
        }));
        assert!(nodes.iter().all(|node| node["children_count"].is_u64()));
    }

    #[tokio::test]
    async fn index_status_preserves_its_tag_and_adds_recovery_readiness() {
        let app = route_test_app();
        app.state
            .try_workspace()
            .expect("index status test workspace")
            .request_recovery(chan_workspace::RecoveryAction::FullRebuild);
        let router = crate::router(app.state);
        let request = Request::builder()
            .uri("/api/index/status")
            .header(header::AUTHORIZATION, "Bearer secret")
            .body(Body::empty())
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["state"].is_string());
        assert!(json.get("status").is_none(), "status must stay flattened");
        assert_eq!(json["readiness"]["state"], "recovering");
        assert_eq!(json["readiness"]["required_action"], "full_rebuild");
    }

    #[tokio::test]
    async fn content_query_during_recovery_is_not_a_fresh_empty_result() {
        let app = route_test_app();
        app.state
            .try_workspace()
            .expect("content recovery test workspace")
            .request_recovery(chan_workspace::RecoveryAction::Reconcile);
        let router = crate::router(app.state);
        let request = Request::builder()
            .uri("/api/search/content?q=done")
            .header(header::AUTHORIZATION, "Bearer secret")
            .body(Body::empty())
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["ready"], false);
        assert_eq!(json["readiness"]["state"], "recovering");
        assert_eq!(json["hits"], serde_json::json!([]));
    }

    #[test]
    fn legacy_search_mode_projects_the_core_decision() {
        assert_eq!(
            legacy_search_mode(EffectiveSearchMode::Hybrid),
            SearchMode::Hybrid
        );
        assert_eq!(
            legacy_search_mode(EffectiveSearchMode::Bm25),
            SearchMode::Bm25
        );
        assert_eq!(
            legacy_search_mode(EffectiveSearchMode::NotRun),
            SearchMode::Bm25
        );
    }

    #[tokio::test]
    async fn workspace_search_returns_the_core_result_shape() {
        let app = route_test_app();
        let router = crate::router(app.state);
        let request = Request::builder()
            .method("POST")
            .uri("/api/search/workspace")
            .header(header::AUTHORIZATION, "Bearer secret")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"domains":["file"]}"#))
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["workspace"]["root"].is_string());
        assert!(json["content_hits"].is_array());
        assert!(json["entity_matches"].is_array());
        assert!(json["nodes"].is_array());
        assert!(json["relationships"].is_array());
        assert!(json["errors"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn workspace_search_rejects_unknown_wire_enums_as_bad_request() {
        let app = route_test_app();
        let router = crate::router(app.state);
        let request = Request::builder()
            .method("POST")
            .uri("/api/search/workspace")
            .header(header::AUTHORIZATION, "Bearer secret")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"domains":["bogus"]}"#))
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    /// `route_test_app` builds a fresh workspace, so `semantic_enabled`
    /// defaults to false: the route must request (and report) bm25 for a
    /// real query regardless of whether a model is cached on the host.
    #[tokio::test]
    async fn content_search_reports_bm25_when_semantic_disabled() {
        let app = route_test_app();
        let router = crate::router(app.state);
        let request = Request::builder()
            .uri("/api/search/content?q=done")
            .header(header::AUTHORIZATION, "Bearer secret")
            .body(Body::empty())
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["mode"], "bm25");
    }

    /// The empty-query short-circuit reports the same mode a real query
    /// would run, never a hardcoded one. With semantic disabled that is
    /// bm25, and the hit list stays empty.
    #[tokio::test]
    async fn content_search_empty_query_reports_flag_mode() {
        let app = route_test_app();
        let router = crate::router(app.state);
        let request = Request::builder()
            .uri("/api/search/content?q=")
            .header(header::AUTHORIZATION, "Bearer secret")
            .body(Body::empty())
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["mode"], "bm25");
        assert_eq!(json["hits"].as_array().unwrap().len(), 0);
    }
}
