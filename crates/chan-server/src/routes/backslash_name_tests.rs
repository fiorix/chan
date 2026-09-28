//! On Unix `\` is an ordinary character of a name, so a file may be called
//! `a\b.md`. Every route sends that name as it is and reads it back when a
//! client returns it; the `a/b.md` spelling names a different file.

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

use crate::state::AppState;

const ROOT_NAME: &str = "a\\b.md";
const NESTED_NAME: &str = "dir/a\\b.md";
/// A directory whose own name holds `\`.
const DIR_NAME: &str = "x\\y";

struct App {
    _cfg: TempDir,
    _root: TempDir,
    state: Arc<AppState>,
}

/// A workspace holding the three names, indexed by a full walk before the
/// server's own indexer starts.
fn app() -> App {
    let cfg = TempDir::new().unwrap();
    let root = TempDir::new().unwrap();
    let dir = root.path();
    std::fs::write(dir.join(ROOT_NAME), "# Root\n\nrootslashword\n").unwrap();
    std::fs::create_dir(dir.join("dir")).unwrap();
    std::fs::write(dir.join(NESTED_NAME), "# Nested\n\nnestedslashword\n").unwrap();
    std::fs::create_dir(dir.join(DIR_NAME)).unwrap();
    std::fs::write(dir.join(DIR_NAME).join("notes.md"), "# Notes\n\nplain\n").unwrap();
    std::fs::write(dir.join("links.md"), "# Links\n\n[root](a\\b.md)\n").unwrap();
    let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
    lib.register_workspace(dir).unwrap();
    let workspace = lib.open_workspace(dir).unwrap();
    workspace.reindex(None).unwrap();
    let state = crate::state::test_support::workspace_app_state(lib, dir.to_path_buf(), workspace);
    App {
        _cfg: cfg,
        _root: root,
        state: Arc::new(state),
    }
}

async fn send(app: &App, request: Request<Body>) -> (StatusCode, Value) {
    let response = crate::router(app.state.clone())
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

async fn get(app: &App, uri: &str) -> (StatusCode, Value) {
    send(app, Request::get(uri).body(Body::empty()).unwrap()).await
}

fn strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) => out.push(text.clone()),
        Value::Array(items) => items.iter().for_each(|item| strings(item, out)),
        Value::Object(map) => map.values().for_each(|item| strings(item, out)),
        _ => {}
    }
}

/// `answer` names each of `names`, as a path or as an id that ends in it,
/// and no string in it carries a name with its `\` read as a separator.
fn assert_one_spelling(surface: &str, answer: &Value, names: &[&str]) {
    let mut leaves = Vec::new();
    strings(answer, &mut leaves);
    for name in names {
        assert!(
            leaves
                .iter()
                .any(|leaf| leaf == name || leaf.ends_with(&format!(":{name}"))),
            "{surface} does not name {name}: {answer}"
        );
    }
    assert!(
        !leaves
            .iter()
            .any(|leaf| leaf.contains("a/b.md") || leaf.contains("x/y")),
        "{surface} names a rewritten spelling: {answer}"
    );
}

#[tokio::test]
async fn the_listing_and_the_tree_send_a_backslash_name_as_itself() {
    let app = app();
    for (uri, names) in [
        ("/api/fs?dir=", &[ROOT_NAME][..]),
        ("/api/fs?dir=dir", &[NESTED_NAME][..]),
        ("/api/fs", &[ROOT_NAME, NESTED_NAME][..]),
    ] {
        let (status, answer) = get(&app, uri).await;
        assert_eq!(status, StatusCode::OK, "{uri}: {answer}");
        assert_one_spelling(uri, &answer, names);
    }
}

#[tokio::test]
async fn a_backslash_name_reads_back_as_itself() {
    let app = app();
    for (uri, word) in [
        ("/api/fs/a%5Cb.md", "rootslashword"),
        ("/api/fs/dir/a%5Cb.md", "nestedslashword"),
    ] {
        let (status, answer) = get(&app, uri).await;
        assert_eq!(status, StatusCode::OK, "{uri}: {answer}");
        assert!(
            answer["content"].as_str().is_some_and(|c| c.contains(word)),
            "{uri}: {answer}"
        );
    }
}

#[tokio::test]
async fn content_search_finds_a_backslash_name_as_itself() {
    let app = app();
    for (word, name) in [
        ("rootslashword", ROOT_NAME),
        ("nestedslashword", NESTED_NAME),
    ] {
        let uri = format!("/api/search/content?q={word}");
        let (status, answer) = get(&app, &uri).await;
        assert_eq!(status, StatusCode::OK, "{uri}: {answer}");
        assert_eq!(answer["ready"], true, "{uri}: {answer}");
        assert_one_spelling(&uri, &answer["hits"], &[name]);
    }
}

#[tokio::test]
async fn filename_search_finds_a_backslash_name_as_itself() {
    let app = app();
    let (status, answer) = get(&app, "/api/search/files?q=a%5Cb.md&limit=50").await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_one_spelling("filename search", &answer, &[ROOT_NAME, NESTED_NAME]);
}

#[tokio::test]
async fn workspace_search_finds_a_backslash_name_as_itself() {
    let app = app();
    let request = Request::post("/api/search/workspace")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "query": "rootslashword" }).to_string()))
        .unwrap();
    let (status, answer) = send(&app, request).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_one_spelling("workspace search", &answer, &[ROOT_NAME]);
}

#[tokio::test]
async fn the_graph_holds_a_backslash_name_as_itself() {
    let app = app();
    let (status, answer) = get(&app, "/api/graph").await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_one_spelling("graph", &answer, &[ROOT_NAME, NESTED_NAME]);

    let (status, answer) = get(&app, "/api/backlinks/a%5Cb.md").await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_one_spelling("backlinks", &answer, &["links.md"]);
}

#[tokio::test]
async fn the_fs_graph_scopes_to_a_backslash_name_as_itself() {
    let app = app();
    let (status, answer) = get(&app, "/api/fs-graph?scope=file&path=a%5Cb.md").await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_one_spelling("fs graph", &answer, &[ROOT_NAME]);
}

#[tokio::test]
async fn the_report_holds_a_backslash_name_as_itself() {
    let app = app();
    let (status, answer) = get(&app, "/api/report/file?path=a%5Cb.md").await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["path"], ROOT_NAME, "{answer}");

    let (status, answer) = get(&app, "/api/graph/languages").await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_one_spelling("language graph", &answer, &[DIR_NAME]);
}
