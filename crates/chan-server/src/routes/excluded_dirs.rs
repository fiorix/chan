//! `GET` / `PUT /api/index/excluded-dirs`: the per-workspace directory
//! blocklist.
//!
//! Hybrid model: the global machine-wide baseline
//! (`Registry::index_excluded_dirs`) is READ-ONLY here; each workspace adds
//! its own `excluded_dirs` (in the per-workspace `IndexConfig`), and the walk
//! the index + graph rebuild use is `effective = union(defaults, additions)`.
//! This route edits ONLY the per-workspace additions.
//!
//! Names are exact directory BASENAMES matched at any depth, case-insensitive
//! (no globs, no paths). PUT persists the set and refreshes a warm report on
//! the blocking pool; that refresh walks and parses the workspace. It also
//! queues the indexer's rebuild to apply the same policy to search and graph.

use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};

use crate::error::{err, err_from, err_state};
use crate::extract::Json;
use crate::routes::blocking_response;
use crate::state::AppState;

#[derive(Debug, Serialize)]
struct ExcludedDirsView {
    /// Global machine-wide baseline (`Registry::index_excluded_dirs`).
    /// Read-only on this route; shown so the UI can render what the
    /// per-workspace additions sit on top of.
    defaults: Vec<String>,
    /// This workspace's own additions (the editable set).
    workspace: Vec<String>,
    /// `union(defaults, workspace)`: what the index + graph walk actually
    /// skips for this workspace.
    effective: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct PutBody {
    /// The full replacement set of per-workspace additions.
    workspace: Vec<String>,
}

fn view(ws: &chan_workspace::Workspace) -> Result<ExcludedDirsView, chan_workspace::ChanError> {
    Ok(ExcludedDirsView {
        defaults: ws.global_excluded_dirs(),
        workspace: ws.excluded_dirs()?,
        effective: ws.effective_excluded_dirs()?,
    })
}

pub async fn api_excluded_dirs_get(State(state): State<Arc<AppState>>) -> Response {
    let workspace = match state.try_workspace() {
        Ok(w) => w,
        Err(e) => return err_state(&e),
    };
    match view(&workspace) {
        Ok(v) => Json(v).into_response(),
        Err(e) => err_from(&e),
    }
}

/// Normalize the requested set: trim, drop blanks, reject path separators
/// (a name, not a path), lower-case (matching is case-insensitive), dedupe.
/// Returns the clean set, or the offending raw entry on a hard reject.
fn normalize(raw: &[String]) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for entry in raw {
        let name = entry.trim();
        if name.is_empty() {
            continue;
        }
        if name.contains('/') || name.contains('\\') {
            return Err(entry.clone());
        }
        let lower = name.to_ascii_lowercase();
        if seen.insert(lower.clone()) {
            out.push(lower);
        }
    }
    Ok(out)
}

pub async fn api_excluded_dirs_put(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PutBody>,
) -> Response {
    let dirs = match normalize(&body.workspace) {
        Ok(d) => d,
        Err(bad) => {
            return err(
                StatusCode::BAD_REQUEST,
                format!("excluded dir must be a bare name, not a path: {bad:?}"),
            )
        }
    };
    let workspace = match state.try_workspace() {
        Ok(w) => w,
        Err(e) => return err_state(&e),
    };
    blocking_response("excluded directories", move || {
        if let Err(e) = workspace.set_excluded_dirs(dirs) {
            return err_from(&e);
        }
        // The warm report has already been rescanned. Search and graph
        // converge through the indexer's separate rebuild worker.
        if let Ok(indexer) = state.try_indexer() {
            indexer.request_rebuild();
        }
        match view(&workspace) {
            Ok(v) => Json(v).into_response(),
            Err(e) => err_from(&e),
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::{to_bytes, Body};
    use axum::http::{header, Request};
    use tempfile::TempDir;
    use tower::ServiceExt;

    use crate::state::test_support::workspace_app_state;

    struct RouteTestApp {
        _cfg: TempDir,
        root: TempDir,
        state: Arc<AppState>,
    }

    fn route_test_app() -> RouteTestApp {
        let cfg = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();

        let state = Arc::new(AppState {
            token: Some("secret".to_string()),
            ..workspace_app_state(lib, root.path().to_path_buf(), workspace)
        });

        RouteTestApp {
            _cfg: cfg,
            root,
            state,
        }
    }

    /// PUT `names` as the workspace's additions and return the answer's
    /// status and JSON body.
    async fn put_names(app: &RouteTestApp, names: &[&str]) -> (StatusCode, serde_json::Value) {
        let router = axum::Router::new()
            .route(
                "/api/index/excluded-dirs",
                axum::routing::put(api_excluded_dirs_put),
            )
            .with_state(app.state.clone());
        let request = Request::put("/api/index/excluded-dirs")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::json!({ "workspace": names }).to_string(),
            ))
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    /// The names the workspace stores as its additions.
    fn stored(app: &RouteTestApp) -> Vec<String> {
        app.state.try_workspace().unwrap().excluded_dirs().unwrap()
    }

    /// A directory whose name holds a `\` can be excluded by that name, at
    /// any depth and in any case, as every other directory can.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_name_with_a_backslash_is_taken_when_a_directory_has_it() {
        let app = route_test_app();
        std::fs::create_dir_all(app.root.path().join("notes").join("X\\y")).unwrap();
        let (status, body) = put_names(&app, &["x\\Y"]).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "the name of a directory that holds a backslash was refused: {body}"
        );
        assert_eq!(body["workspace"], serde_json::json!(["x\\y"]));
        assert_eq!(stored(&app), vec!["x\\y"]);
    }

    /// A name that holds a `\` and that no directory of the workspace has
    /// is refused, in words that say so, and nothing is stored. A file of
    /// that name is not a directory.
    #[tokio::test]
    async fn a_name_with_a_backslash_that_no_directory_has_is_refused_as_that() {
        let app = route_test_app();
        #[cfg(unix)]
        std::fs::write(app.root.path().join("no\\such"), b"").unwrap();
        let (status, body) = put_names(&app, &["vendor", "no\\such"]).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(
            body,
            serde_json::json!({
                "error": "no directory in this workspace is named no\\such; a name can hold a \
                          backslash only when a directory already has it"
            }),
            "a name with a backslash that no directory has was refused in other words"
        );
        assert!(
            stored(&app).is_empty(),
            "a refused set changed the stored names: {:?}",
            stored(&app)
        );
    }

    /// The set is sent whole at every change, so a name the workspace
    /// already stores stays in it once its directory is gone: it keeps the
    /// backslash it holds.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_stored_name_with_a_backslash_outlives_its_directory() {
        let app = route_test_app();
        let dir = app.root.path().join("x\\y");
        std::fs::create_dir(&dir).unwrap();
        let (status, body) = put_names(&app, &["x\\y"]).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "the name of a directory that holds a backslash was refused: {body}"
        );
        std::fs::remove_dir(&dir).unwrap();
        let (status, body) = put_names(&app, &["x\\y", "vendor"]).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "a stored name was refused once its directory was gone: {body}"
        );
        assert_eq!(stored(&app), vec!["x\\y", "vendor"]);
    }

    /// A `/` makes a path, which no name is, whatever the tree holds.
    #[tokio::test]
    async fn a_path_is_refused_as_a_path() {
        let app = route_test_app();
        std::fs::create_dir_all(app.root.path().join("a").join("b")).unwrap();
        let (status, body) = put_names(&app, &["a/b"]).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(
            body,
            serde_json::json!({
                "error": "excluded dir must be a bare name, not a path: \"a/b\""
            })
        );
        assert!(stored(&app).is_empty());
    }

    #[test]
    fn excluded_dirs_put_runs_off_runtime_thread() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        runtime.block_on(async {
            let app = route_test_app();
            let workspace = app.state.try_workspace().unwrap();
            workspace.report().unwrap();
            let router = axum::Router::new()
                .route(
                    "/api/index/excluded-dirs",
                    axum::routing::put(api_excluded_dirs_put),
                )
                .with_state(app.state.clone());
            let request = Request::put("/api/index/excluded-dirs")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"workspace":["vendor"]}"#))
                .unwrap();
            let response =
                crate::state::test_support::assert_uses_blocking_pool(router.oneshot(request))
                    .await
                    .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let view: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(view["workspace"], serde_json::json!(["vendor"]));
            assert_eq!(workspace.excluded_dirs().unwrap(), vec!["vendor"]);
        });
    }

    #[test]
    fn normalize_trims_drops_blanks_lowercases_and_dedupes() {
        let got = normalize(&[
            "  Vendor ".to_string(),
            "vendor".to_string(),
            "".to_string(),
            "  ".to_string(),
            "NodeModules".to_string(),
        ])
        .unwrap();
        assert_eq!(got, vec!["vendor".to_string(), "nodemodules".to_string()]);
    }

    #[test]
    fn normalize_rejects_a_path_and_keeps_a_backslash_for_the_workspace_to_decide() {
        assert!(normalize(&["a/b".to_string()]).is_err());
        assert_eq!(
            normalize(&["A\\b".to_string()]),
            Ok(vec!["a\\b".to_string()]),
            "a backslash is part of a name on Unix, so the names alone do not decide it"
        );
    }
}
