//! Per-workspace semantic-search state + enablement.
//!
//! Endpoints under `/api/index/semantic/`:
//!
//! * `GET /state` -- model + workspace preference snapshot.
//! * `GET /models` - curated model list + per-machine download
//!   flags for the picker.
//! * `PATCH /model` - persist the workspace's configured model.
//! * `POST /download` -- synchronously fetch the model into the
//!   per-machine cache (hf-hub). v1 is blocking; progress-streaming
//!   is a follow-up.
//! * `POST /enable` -- flip the workspace's `semantic_enabled` to true.
//!   Refuses with 409 if the model isn't on disk.
//! * `POST /disable` -- flip back to BM25-only.
//!
//! Whole module gated on `embeddings` -- the surface is meaningless
//! without the candle stack. `lib.rs::router_with_extensions` mirrors
//! that gate when wiring the routes.
//!
//! Companion CLI: `chan workspace index download-model |
//! enable-semantic | disable-semantic | status` (see
//! `crates/chan/src/lib.rs`).
//! The Settings UI is built against this contract.

#![cfg(feature = "embeddings")]

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chan_workspace::index::config::{self, EmbeddingModelInfo};
use chan_workspace::index::embeddings::{
    global_models_dir, model_downloaded, repo_dir_name, resolve_model, Embedder,
};
use serde::{Deserialize, Serialize};

use crate::error::{err, err_from, err_state};
use crate::state::AppState;

/// Snapshot of the per-workspace semantic-search state. Settings UI +
/// `chan index status` consume this. Shape is stable for `--json`
/// scripting; new fields land as additive options.
#[derive(Debug, Clone, Serialize)]
pub struct SemanticState {
    /// "bm25" or "hybrid". Derived from the workspace's
    /// `semantic_enabled` flag AND whether the model is on disk --
    /// the field is "hybrid" only when BOTH are true.
    pub mode: &'static str,
    /// True when the model files are laid out at the resolver's
    /// expected path (refs/main + complete snapshot trio). False
    /// when the model hasn't been downloaded.
    pub model_present: bool,
    /// Workspace-configured model id (`IndexConfig::model`).
    pub model_name: String,
    /// Resolver's expected path under `global_models_dir()`. Stable
    /// regardless of presence -- useful for diagnostics ("look at X
    /// to confirm the download landed").
    pub model_path: String,
    /// Total bytes occupied by the model on disk. `None` when
    /// `model_present` is false (no files to measure).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_size_bytes: Option<u64>,
    /// Per-workspace opt-in flag (`DashboardConfig::semantic_enabled`).
    /// Independent from `model_present`: a workspace can be opted in
    /// without a downloaded model (mode falls back to bm25 until
    /// the model lands; enable refuses to flip without the model
    /// so this state only arises if the model is deleted out from
    /// under us).
    pub semantic_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SemanticModelOption {
    pub id: &'static str,
    pub label: &'static str,
    pub dim: u32,
    pub size_label: &'static str,
    pub note: &'static str,
    #[serde(rename = "default")]
    pub is_default: bool,
    pub downloaded: bool,
    pub current: bool,
}

impl SemanticModelOption {
    fn from_info(info: &'static EmbeddingModelInfo, current_model: &str) -> Self {
        Self {
            id: info.id,
            label: info.label,
            dim: info.dim,
            size_label: info.size_label,
            note: info.note,
            is_default: info.is_default,
            downloaded: model_downloaded(info.id).unwrap_or(false),
            current: info.id == current_model,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SemanticModelsResponse {
    pub current_model: String,
    pub models: Vec<SemanticModelOption>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PatchSemanticModel {
    pub model: String,
}

/// Recursive size of every regular file under `dir`. Used for the
/// `model_size_bytes` reporting field; sums the snapshots + refs
/// trio plus any other on-disk artifacts hf-hub left behind.
fn dir_total_size(dir: &std::path::Path) -> u64 {
    fn walk(dir: &std::path::Path, total: &mut u64) {
        let Ok(it) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in it.flatten() {
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if ft.is_dir() {
                walk(&entry.path(), total);
            } else if ft.is_file() {
                if let Ok(meta) = entry.metadata() {
                    *total += meta.len();
                }
            }
        }
    }
    let mut total = 0;
    walk(dir, &mut total);
    total
}

fn build_state(
    workspace: &chan_workspace::Workspace,
) -> Result<SemanticState, chan_workspace::ChanError> {
    let model_name = workspace.semantic_model()?;
    let semantic_enabled = workspace.semantic_enabled()?;
    let expected_dir = global_models_dir().join(repo_dir_name(&model_name));
    let model_present = resolve_model(&model_name).is_ok();
    let model_size_bytes = if model_present {
        Some(dir_total_size(&expected_dir))
    } else {
        None
    };
    // Mode is "hybrid" only when both the user opted in AND the
    // model is downloaded. A flipped-on flag with no model on disk
    // still serves bm25 (defensive -- `enable` refuses to set this
    // shape, but a model deleted out from under us would otherwise
    // mis-report).
    let mode = if semantic_enabled && model_present {
        "hybrid"
    } else {
        "bm25"
    };
    Ok(SemanticState {
        mode,
        model_present,
        model_name,
        model_path: expected_dir.to_string_lossy().into_owned(),
        model_size_bytes,
        semantic_enabled,
    })
}

/// `GET /api/index/semantic/state`. Read-only snapshot.
pub async fn api_semantic_state(State(state): State<Arc<AppState>>) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    match tokio::task::spawn_blocking(move || build_state(&workspace)).await {
        Ok(Ok(s)) => Json(s).into_response(),
        Ok(Err(e)) => err_from(&e),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("semantic state task panicked: {e}"),
        )
            .into_response(),
    }
}

/// `GET /api/index/semantic/models`. Curated picker state.
pub async fn api_semantic_models(State(state): State<Arc<AppState>>) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    match tokio::task::spawn_blocking(move || {
        let current_model = match workspace.semantic_model() {
            Ok(model) => model,
            Err(e) => return err_from(&e),
        };
        let models = config::embedding_models()
            .iter()
            .map(|info| SemanticModelOption::from_info(info, &current_model))
            .collect();
        Json(SemanticModelsResponse {
            current_model,
            models,
        })
        .into_response()
    })
    .await
    {
        Ok(response) => response,
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("semantic models task panicked: {e}"),
        )
            .into_response(),
    }
}

/// `PATCH /api/index/semantic/model`. Persist the per-workspace model.
pub async fn api_semantic_model_patch(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PatchSemanticModel>,
) -> Response {
    let model = req.model.trim().to_owned();
    if config::embedding_model(&model).is_none() {
        return err(
            StatusCode::BAD_REQUEST,
            format!("unknown embedding model: {model}"),
        );
    }
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    match tokio::task::spawn_blocking(move || {
        if let Err(e) = workspace.set_semantic_model(&model) {
            return err_from(&e);
        }
        match build_state(&workspace) {
            Ok(s) => Json(s).into_response(),
            Err(e) => err_from(&e),
        }
    })
    .await
    {
        Ok(response) => response,
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("semantic model patch task panicked: {e}"),
        )
            .into_response(),
    }
}

/// Structured error payload for the 409 returned by `enable` when
/// the model isn't on disk. Mirrors `EmbedError::ModelNotDownloaded`
/// fields so the SPA can render the same hint as the CLI.
#[derive(Debug, Clone, Serialize)]
struct ModelNotDownloadedBody {
    error: &'static str,
    model_id: String,
    expected_dir: String,
    download_endpoint: &'static str,
}

/// `POST /api/index/semantic/enable`. Flip the workspace to Hybrid.
/// Refuses with 409 if the model isn't on disk; payload carries
/// the structured `ModelNotDownloaded` hint pointing the caller at
/// the `/download` endpoint.
pub async fn api_semantic_enable(State(state): State<Arc<AppState>>) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    // Enabling opts in, so kick a from-scratch rebuild: the reindex now embeds
    // (semantic_enabled is true) and bypasses the file cap, so the whole tree
    // gets vectors. If the indexer handle is unavailable (a rare reset/shutdown
    // window) the flag is still persisted; vectors then fill in on the next
    // explicit rebuild or as files are saved. The cold-boot trigger keys on an
    // empty index, not on this flag.
    let indexer = state.try_indexer().ok();
    match tokio::task::spawn_blocking(move || {
        let model_name = match workspace.semantic_model() {
            Ok(m) => m,
            Err(e) => return err_from(&e),
        };
        if let Err(e) = resolve_model(&model_name) {
            let expected_dir = match &e {
                chan_workspace::index::embeddings::EmbedError::ModelNotDownloaded {
                    expected_dir,
                    ..
                } => expected_dir.to_string_lossy().into_owned(),
                _ => global_models_dir()
                    .join(repo_dir_name(&model_name))
                    .to_string_lossy()
                    .into_owned(),
            };
            return (
                StatusCode::CONFLICT,
                Json(ModelNotDownloadedBody {
                    error: "model_not_downloaded",
                    model_id: model_name,
                    expected_dir,
                    download_endpoint: "/api/index/semantic/download",
                }),
            )
                .into_response();
        }
        if let Err(e) = workspace.set_semantic_enabled(true) {
            return err_from(&e);
        }
        if let Some(indexer) = &indexer {
            indexer.request_rebuild();
        }
        match build_state(&workspace) {
            Ok(s) => Json(s).into_response(),
            Err(e) => err_from(&e),
        }
    })
    .await
    {
        Ok(response) => response,
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("semantic enable task panicked: {e}"),
        )
            .into_response(),
    }
}

/// `POST /api/index/semantic/disable`. Flips the workspace to BM25 and bins the
/// vector store (via `set_semantic_enabled(false)`), so a later enable rebuilds
/// from scratch. Always succeeds; idempotent (a wipe of an already-off
/// workspace is a no-op).
pub async fn api_semantic_disable(State(state): State<Arc<AppState>>) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    match tokio::task::spawn_blocking(move || {
        if let Err(e) = workspace.set_semantic_enabled(false) {
            return err_from(&e);
        }
        match build_state(&workspace) {
            Ok(s) => Json(s).into_response(),
            Err(e) => err_from(&e),
        }
    })
    .await
    {
        Ok(response) => response,
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("semantic disable task panicked: {e}"),
        )
            .into_response(),
    }
}

/// `POST /api/index/semantic/download`. Synchronously fetches the
/// model into `global_models_dir()` via hf-hub. Returns the
/// post-download state on success.
///
/// v1 is blocking from the caller's perspective: the response
/// arrives when the download completes (or fails). Progress-event
/// streaming via the watcher channel is a follow-up -- see the
/// task tail's "deferred to follow-up" note. The blocking work
/// runs on a Tokio blocking thread so it doesn't tie up the
/// async runtime.
pub async fn api_semantic_download(State(state): State<Arc<AppState>>) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let result = tokio::task::spawn_blocking(move || {
        let model_name = match workspace.semantic_model() {
            Ok(m) => m,
            Err(e) => return err_from(&e),
        };
        let cache_dir = global_models_dir();
        if let Err(e) = std::fs::create_dir_all(&cache_dir) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("creating model cache {}: {e}", cache_dir.display()),
            )
                .into_response();
        }
        if let Err(e) = Embedder::open(&model_name, &cache_dir).map(|_| ()) {
            // EmbedError → IndexError::Embed → ChanError → `err_from`
            // funnels every model-side failure (network, hf-hub
            // checksum, candle load) through the same error
            // rendering as the rest of the search surface. The
            // bridge is feature-gated alongside this whole module.
            let chan_err: chan_workspace::ChanError =
                chan_workspace::index::IndexError::Embed(e).into();
            return err_from(&chan_err);
        }
        match build_state(&workspace) {
            Ok(s) => Json(s).into_response(),
            Err(e) => err_from(&e),
        }
    })
    .await;
    match result {
        Ok(response) => response,
        Err(join_err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("download task panicked: {join_err}"),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    use std::sync::{Mutex, RwLock};

    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use chan_workspace::SearchAggression;
    use tempfile::TempDir;
    use tokio::sync::{broadcast, watch};
    use tower::ServiceExt;

    use crate::self_writes::SelfWrites;
    use crate::state::WorkspaceCell;
    use crate::terminal_sessions::{Registry as TerminalRegistry, RegistryConfig};
    use crate::{EditorPrefs, ServerConfig};

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

    async fn request(
        router: &axum::Router,
        method: &str,
        uri: &str,
        body: Option<&str>,
    ) -> (StatusCode, serde_json::Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, "Bearer secret");
        let body = if let Some(b) = body {
            req = req.header(header::CONTENT_TYPE, "application/json");
            Body::from(b.to_string())
        } else {
            Body::empty()
        };
        let response = router
            .clone()
            .oneshot(req.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    #[tokio::test]
    async fn semantic_models_returns_curated_model_picker_state() {
        let app = route_test_app();
        let router = crate::router(app.state);
        let (status, body) = request(&router, "GET", "/api/index/semantic/models", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["current_model"], "BAAI/bge-small-en-v1.5");
        let models = body["models"].as_array().unwrap();
        assert_eq!(models.len(), 4);
        assert_eq!(models[0]["id"], "BAAI/bge-small-en-v1.5");
        assert_eq!(models[0]["label"], "BGE Small EN v1.5");
        assert_eq!(models[0]["dim"], 384);
        assert_eq!(models[0]["default"], true);
        assert_eq!(models[0]["current"], true);
        assert!(models[0]["downloaded"].is_boolean());
    }

    #[tokio::test]
    async fn semantic_model_patch_updates_current_model() {
        let app = route_test_app();
        let router = crate::router(app.state);
        let (status, body) = request(
            &router,
            "PATCH",
            "/api/index/semantic/model",
            Some(r#"{"model":"BAAI/bge-base-en-v1.5"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["model_name"], "BAAI/bge-base-en-v1.5");
        assert_eq!(body["semantic_enabled"], false);
        assert_eq!(body["mode"], "bm25");

        let (status, body) = request(&router, "GET", "/api/index/semantic/models", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["current_model"], "BAAI/bge-base-en-v1.5");
        let current = body["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|model| model["current"] == true)
            .unwrap();
        assert_eq!(current["id"], "BAAI/bge-base-en-v1.5");
    }

    #[tokio::test]
    async fn semantic_model_patch_rejects_unknown_model() {
        let app = route_test_app();
        let router = crate::router(app.state);
        let (status, body) = request(
            &router,
            "PATCH",
            "/api/index/semantic/model",
            Some(r#"{"model":"not-a-model"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("unknown embedding model"),
            "unexpected error body: {body}",
        );
    }
}
