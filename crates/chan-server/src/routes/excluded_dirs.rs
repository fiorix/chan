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
//! (no globs, no paths). A name keeps a `\` it already holds and gains none
//! here: PUT takes a name that holds one when a directory of the workspace
//! has that name, or when the stored set already holds it, and refuses any
//! other. Where a `\` separates path components no directory has such a
//! name, so there a name that is not stored is refused as a path. PUT
//! persists the set and refreshes a warm report on the blocking pool; that
//! refresh walks and parses the workspace. It also queues the indexer's
//! rebuild to apply the same policy to search and graph.

use std::collections::HashSet;
use std::path::Path;
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

/// Whether a `\` separates path components on this platform, so that no
/// directory's name can hold one.
const BACKSLASH_SEPARATES: bool = cfg!(windows);

/// The refusal of an entry that is a path, where the set holds names.
fn not_a_bare_name(entry: &str) -> String {
    format!("excluded dir must be a bare name, not a path: {entry:?}")
}

/// Why a set is refused for an entry that holds a `\`. Each carries the
/// entry as it was sent.
#[derive(Debug, PartialEq, Eq)]
enum BackslashRefusal {
    /// A `\` separates components on this platform, so the entry is a path.
    Path(String),
    /// A `\` is part of a name on this platform, and no directory of the
    /// workspace has this one.
    NoDirectory(String),
}

impl BackslashRefusal {
    fn message(&self) -> String {
        match self {
            Self::Path(entry) => not_a_bare_name(entry),
            Self::NoDirectory(entry) => format!(
                "no directory in this workspace is named {entry:?}; a name can hold a \
                 backslash only when a directory already has it"
            ),
        }
    }
}

/// Normalize the requested set: trim, drop blanks, reject a `/` (a name, not
/// a path), lower-case (matching is case-insensitive), dedupe. A `\` stays:
/// the names alone do not decide it, and [`refused_backslash_entry`] asks
/// the platform and the workspace.
/// Returns the clean set, or the offending raw entry on a hard reject.
fn normalize(raw: &[String]) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for entry in raw {
        let name = entry.trim();
        if name.is_empty() {
            continue;
        }
        if name.contains('/') {
            return Err(entry.clone());
        }
        let lower = name.to_ascii_lowercase();
        if seen.insert(lower.clone()) {
            out.push(lower);
        }
    }
    Ok(out)
}

/// The name of every directory under `root`, one at each step of a walk in
/// progress: `.git` and `.chan` are not entered, no listing of the tree is
/// built and no entry is counted. A name that is not Unicode is spelled as
/// the walk's own filter spells it.
fn directory_names(root: &Path) -> impl Iterator<Item = String> {
    chan_workspace::fs_ops::walk_workspace(root)
        .filter(|entry| entry.file_type().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
}

/// The first of `entries` that none of `directories` is named, compared as
/// the walk compares a name: trimmed, and ignoring ASCII case.
///
/// `directories` is advanced one name at a time and left where the last
/// entry met its name, so a tree of any size costs no more than the walk to
/// that directory, and only a set that is refused costs the whole walk.
fn first_entry_no_directory_has<'a>(
    entries: &[&'a String],
    mut directories: impl Iterator<Item = impl AsRef<str>>,
) -> Option<&'a String> {
    let mut missing = entries.to_vec();
    while !missing.is_empty() {
        let Some(directory) = directories.next() else {
            break;
        };
        missing.retain(|entry| !entry.trim().eq_ignore_ascii_case(directory.as_ref()));
    }
    missing.first().copied()
}

/// The refusal of the first of `entries` that holds a `\`, is not one of the
/// workspace's stored additions, and cannot be taken.
///
/// A name keeps a backslash it already holds and no request creates one, so
/// a stored name is not looked for: the set is sent whole at every change,
/// and a name whose directory has gone since must not refuse the next one.
/// Where a `\` separates components (`backslash_separates`) no directory
/// can have such a name, and the entry is a path. Elsewhere it is a name,
/// taken when one of `directories` is it: the names of the tree's
/// directories at any depth, from a walk that is advanced, on the caller's
/// blocking thread, only then.
fn refused_backslash_entry(
    workspace: &chan_workspace::Workspace,
    entries: &[String],
    backslash_separates: bool,
    directories: impl Iterator<Item = impl AsRef<str>>,
) -> Result<Option<BackslashRefusal>, chan_workspace::ChanError> {
    let stored = workspace.excluded_dirs()?;
    let asked: Vec<&String> = entries
        .iter()
        .filter(|entry| entry.contains('\\'))
        .filter(|entry| {
            !stored
                .iter()
                .any(|kept| kept.eq_ignore_ascii_case(entry.trim()))
        })
        .collect();
    let Some(first) = asked.first() else {
        return Ok(None);
    };
    if backslash_separates {
        return Ok(Some(BackslashRefusal::Path((*first).clone())));
    }
    Ok(first_entry_no_directory_has(&asked, directories)
        .map(|entry| BackslashRefusal::NoDirectory(entry.clone())))
}

pub async fn api_excluded_dirs_put(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PutBody>,
) -> Response {
    let dirs = match normalize(&body.workspace) {
        Ok(d) => d,
        Err(bad) => return err(StatusCode::BAD_REQUEST, not_a_bare_name(&bad)),
    };
    let workspace = match state.try_workspace() {
        Ok(w) => w,
        Err(e) => return err_state(&e),
    };
    blocking_response("excluded directories", move || {
        let directories = directory_names(workspace.root());
        match refused_backslash_entry(
            &workspace,
            &body.workspace,
            BACKSLASH_SEPARATES,
            directories,
        ) {
            Ok(None) => {}
            Ok(Some(refusal)) => return err(StatusCode::BAD_REQUEST, refusal.message()),
            Err(e) => return err_from(&e),
        }
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

    /// The additions as the workspace's index config file holds them.
    #[cfg(unix)]
    fn stored_on_disk(app: &RouteTestApp) -> Vec<String> {
        fn config_files(dir: &std::path::Path, found: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    config_files(&path, found);
                } else if path.ends_with("index/config.toml") {
                    found.push(path);
                }
            }
        }
        let mut found = Vec::new();
        config_files(app._cfg.path(), &mut found);
        assert_eq!(found.len(), 1, "one workspace, one index config: {found:?}");
        let config: toml::Value =
            toml::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap();
        config["excluded_dirs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| name.as_str().unwrap().to_string())
            .collect()
    }

    /// What the walk of the index and the graph skips for the workspace.
    #[cfg(unix)]
    fn effective(app: &RouteTestApp) -> Vec<String> {
        app.state
            .try_workspace()
            .unwrap()
            .effective_excluded_dirs()
            .unwrap()
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
        assert_eq!(
            stored_on_disk(&app),
            vec!["x\\y"],
            "a taken name is not in the workspace's config file"
        );
        assert!(
            effective(&app).iter().any(|name| name == "x\\y"),
            "a taken name is not in what the walk skips: {:?}",
            effective(&app)
        );
        assert_eq!(
            body["effective"],
            serde_json::json!(effective(&app)),
            "the answer's effective set is not the workspace's"
        );
    }

    /// A name that holds a `\` and that no directory of the workspace has
    /// is refused, in words that say so, and nothing is stored. A file of
    /// that name is not a directory. Where a `\` separates components no
    /// directory can have such a name, and the entry is refused as a path.
    #[tokio::test]
    async fn a_name_with_a_backslash_that_no_directory_has_is_refused_as_that() {
        let app = route_test_app();
        #[cfg(unix)]
        std::fs::write(app.root.path().join("no\\such"), b"").unwrap();
        let (status, body) = put_names(&app, &["vendor", "no\\such"]).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let refusal = if cfg!(windows) {
            "excluded dir must be a bare name, not a path: \"no\\\\such\""
        } else {
            "no directory in this workspace is named \"no\\\\such\"; a name can hold a \
             backslash only when a directory already has it"
        };
        assert_eq!(
            body,
            serde_json::json!({ "error": refusal }),
            "a name with a backslash that no directory has was refused in other words"
        );
        assert!(
            stored(&app).is_empty(),
            "a refused set changed the stored names: {:?}",
            stored(&app)
        );
    }

    /// The refusal names the entry as it was sent, quoted, as the refusal
    /// of a path does: not the lower-case name the set would have stored.
    #[tokio::test]
    async fn a_refused_name_is_echoed_as_it_was_sent() {
        let app = route_test_app();
        let (status, body) = put_names(&app, &["vendor", "Docs\\Old"]).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let refusal = if cfg!(windows) {
            "excluded dir must be a bare name, not a path: \"Docs\\\\Old\""
        } else {
            "no directory in this workspace is named \"Docs\\\\Old\"; a name can hold a \
             backslash only when a directory already has it"
        };
        assert_eq!(
            body,
            serde_json::json!({ "error": refusal }),
            "a refused name was not echoed as it was sent"
        );
        assert!(
            stored(&app).is_empty(),
            "a refused set changed the stored names: {:?}",
            stored(&app)
        );
    }

    /// The look is no listing of the tree: it takes a name a directory has
    /// after more directories than a listing holds, goes no further than
    /// that directory, and refuses the first sent of the names that none
    /// has.
    #[test]
    fn the_look_takes_a_name_past_a_listings_limit_and_goes_no_further() {
        let taken = "X\\y".to_string();
        let mut later = 0usize;
        let directories = std::iter::repeat_n("other", chan_workspace::fs_ops::LIST_TREE_LIMIT + 1)
            .chain(std::iter::once("x\\Y"))
            .chain(std::iter::repeat_n("later", 3).inspect(|_| later += 1));
        assert_eq!(
            first_entry_no_directory_has(&[&taken], directories),
            None,
            "a name was refused that a directory past a listing's limit has"
        );
        assert_eq!(
            later, 0,
            "the look went on past the directory that has the name"
        );

        let first = "no\\such".to_string();
        let second = "nor\\this".to_string();
        assert_eq!(
            first_entry_no_directory_has(&[&taken, &first, &second], ["other", "x\\y"].iter()),
            Some(&first),
            "the refused name is not the first that no directory has"
        );
    }

    /// The names come from a walk in progress and not from a listing built
    /// ahead of it: a directory made under one the walk has named and not
    /// yet read is met by the same walk.
    #[test]
    fn the_look_walks_the_tree_as_it_goes() {
        let root = TempDir::new().unwrap();
        std::fs::create_dir_all(root.path().join("a").join("b")).unwrap();
        let late = root.path().join("a").join("b").join("Late");
        let asked = "late".to_string();
        let names = directory_names(root.path()).inspect(|name| {
            if name == "a" {
                std::fs::create_dir(&late).unwrap();
            }
        });
        assert_eq!(
            first_entry_no_directory_has(&[&asked], names),
            None,
            "a directory made while the walk was under way was not met, so the names were \
             listed ahead of the look"
        );
        assert!(
            late.is_dir(),
            "fixture: the walk never named the first directory"
        );
    }

    /// Where a `\` separates path components no directory's name holds
    /// one, so a name that is not stored is refused as a path, in the
    /// path's words and with no look at the tree: a directory that has the
    /// name, where one can, does not take it. A stored name still passes.
    #[tokio::test]
    async fn where_a_backslash_separates_a_new_name_that_holds_one_is_a_path() {
        let app = route_test_app();
        let workspace = app.state.try_workspace().unwrap();
        #[cfg(unix)]
        std::fs::create_dir(app.root.path().join("src\\gen")).unwrap();
        let entries = vec!["vendor".to_string(), "Src\\Gen".to_string()];
        let unlooked = || {
            std::iter::from_fn(|| -> Option<String> {
                panic!("the tree was looked at where a backslash separates")
            })
        };
        let refusal = refused_backslash_entry(&workspace, &entries, true, unlooked()).unwrap();
        assert_eq!(
            refusal,
            Some(BackslashRefusal::Path("Src\\Gen".to_string())),
            "a new name that holds a backslash was not refused as a path"
        );
        assert_eq!(
            refusal.unwrap().message(),
            "excluded dir must be a bare name, not a path: \"Src\\\\Gen\""
        );

        let storing = workspace.clone();
        tokio::task::spawn_blocking(move || {
            storing.set_excluded_dirs(vec!["src\\gen".to_string()])
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            refused_backslash_entry(&workspace, &entries, true, unlooked()).unwrap(),
            None,
            "a stored name was refused where a backslash separates"
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
