//! A draft is listed whole or not at all. Each test holds a draft's creation,
//! or its promotion's removal of the source, at one step of the store, reads
//! the list and the workspace warnings while it is held, then releases it.
//! The hold's action runs on the operation's blocking thread and waits on a
//! channel the test owns, so the order is the test's and nothing sleeps.

use std::path::{Path, PathBuf};
use std::sync::mpsc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use chan_workspace::draft_hold::{self, Step};
use serde_json::{json, Value};
use tokio::task::JoinHandle;
use tower::ServiceExt;

use super::tests::{get_draft_list, post_create_draft, post_window_mutation, route_test_app};
use super::{NEW_DIAGRAM_CONTENT, NEW_DRAFT_CONTENT};

const MARKER: &str = ".chan-draft-id";

/// A step armed to hold its operation. The operation goes on when the test
/// sends on `release`, or when `release` drops, so a failed assertion cannot
/// leave the operation and the runtime's blocking pool waiting.
struct Hold {
    reached: tokio::sync::oneshot::Receiver<PathBuf>,
    release: mpsc::Sender<()>,
}

/// Hold `step` of the next operation on `drafts_dir`, after running `first`
/// on the directory the step is about.
fn hold_after(drafts_dir: &Path, step: Step, first: impl FnOnce(&Path) + Send + 'static) -> Hold {
    let (reached_tx, reached) = tokio::sync::oneshot::channel();
    let (release, released) = mpsc::channel();
    draft_hold::on_step(drafts_dir, step, move |dir| {
        first(dir);
        let _ = reached_tx.send(dir.to_path_buf());
        let _ = released.recv();
        Ok(())
    });
    Hold { reached, release }
}

fn hold(drafts_dir: &Path, step: Step) -> Hold {
    hold_after(drafts_dir, step, |_| {})
}

/// Wait until the operation reaches its held step, failing if it finishes
/// first.
async fn held<T: std::fmt::Debug>(
    reached: tokio::sync::oneshot::Receiver<PathBuf>,
    operation: &mut JoinHandle<T>,
    step: Step,
) -> PathBuf {
    tokio::select! {
        dir = reached => dir.expect("the hold's action reports its directory"),
        done = operation => panic!("the operation finished without reaching {step}: {done:?}"),
    }
}

fn spawn_post(
    router: &axum::Router,
    uri: &str,
    body: Option<String>,
) -> JoinHandle<(StatusCode, Value)> {
    let router = router.clone();
    let uri = uri.to_string();
    tokio::spawn(async move { post_window_mutation(&router, &uri, body.as_deref()).await })
}

async fn get_workspace(router: &axum::Router) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(
            Request::get("/api/workspace")
                .header(header::AUTHORIZATION, "Bearer secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or_default())
}

fn staging_dir(workspace: &chan_workspace::Workspace) -> PathBuf {
    workspace
        .drafts_dir()
        .parent()
        .unwrap()
        .join("drafts-staging")
}

/// The entries under the store's staging directory; none when it is absent.
fn staged(workspace: &chan_workspace::Workspace) -> Vec<String> {
    match std::fs::read_dir(staging_dir(workspace)) {
        Ok(entries) => {
            let mut names: Vec<String> = entries
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => panic!("read the staging directory: {error}"),
    }
}

fn entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

async fn creation_held_at_a_step_is_not_listed(uri: &str, step: Step) {
    let app = route_test_app();
    let router = crate::router(app.state.clone());
    let workspace = app.state.try_workspace().unwrap();
    let Hold { reached, release } = hold(workspace.drafts_dir(), step);

    let mut create = spawn_post(&router, uri, None);
    let held_dir = held(reached, &mut create, step).await;
    let (list_status, list) = get_draft_list(&router).await;
    let (info_status, info) = get_workspace(&router).await;
    release.send(()).unwrap();
    let (created_status, created) = create.await.unwrap();

    let at = format!("a creation held at {step} on {}", held_dir.display());
    assert_eq!(list_status, StatusCode::OK, "{at}: {list}");
    assert_eq!(list["drafts"], json!([]), "{at} is listed: {list}");
    assert_eq!(list["warnings"], json!([]), "{at} is warned: {list}");
    assert_eq!(info_status, StatusCode::OK, "{at}: {info}");
    assert_eq!(
        info["warnings"],
        json!([]),
        "{at} is a workspace warning: {info}"
    );
    assert_eq!(created_status, StatusCode::OK, "{created}");
    assert_eq!(created["name"], "untitled");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_note_held_with_its_directory_made_is_not_listed() {
    creation_held_at_a_step_is_not_listed("/api/drafts/new", draft_hold::DIRECTORY_MADE).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_note_held_with_its_marker_written_is_not_listed() {
    creation_held_at_a_step_is_not_listed("/api/drafts/new", draft_hold::MARKER_WRITTEN).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_diagram_held_with_its_marker_written_is_not_listed() {
    creation_held_at_a_step_is_not_listed("/api/diagrams/new", draft_hold::MARKER_WRITTEN).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_note_held_with_its_primary_written_is_not_listed() {
    creation_held_at_a_step_is_not_listed("/api/drafts/new", draft_hold::PRIMARY_WRITTEN).await;
}

async fn a_created_draft_is_listed_whole(uri: &str, leaf: &str, seed: &str) {
    let app = route_test_app();
    let router = crate::router(app.state.clone());
    let workspace = app.state.try_workspace().unwrap();

    let (status, created) = post_window_mutation(&router, uri, None).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(
        created["primary"]["draft_id"].as_str(),
        Some(workspace.draft_id("untitled").unwrap().as_str()),
        "the create answers the lifetime its marker holds"
    );
    assert_eq!(created["primary"]["path"], format!("untitled/{leaf}"));
    let (status, list) = get_draft_list(&router).await;

    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["warnings"], json!([]), "{list}");
    assert_eq!(
        list["drafts"],
        json!([{
            "name": "untitled",
            "primary": created["primary"],
            "has_attachments": false,
            "busy": false,
        }]),
    );
    let dir = workspace.drafts_dir().join("untitled");
    assert_eq!(entries(&dir), vec![MARKER.to_string(), leaf.to_string()]);
    assert_eq!(std::fs::read_to_string(dir.join(leaf)).unwrap(), seed);
    assert_eq!(staged(&workspace), Vec::<String>::new());
}

#[tokio::test]
async fn a_created_note_is_listed_whole() {
    a_created_draft_is_listed_whole("/api/drafts/new", "draft.md", NEW_DRAFT_CONTENT).await;
}

#[tokio::test]
async fn a_created_diagram_is_listed_whole() {
    a_created_draft_is_listed_whole(
        "/api/diagrams/new",
        "untitled.excalidraw",
        NEW_DIAGRAM_CONTENT,
    )
    .await;
}

#[tokio::test]
async fn a_creation_that_fails_midway_leaves_no_draft() {
    let app = route_test_app();
    let router = crate::router(app.state.clone());
    let workspace = app.state.try_workspace().unwrap();
    draft_hold::on_step(workspace.drafts_dir(), draft_hold::MARKER_WRITTEN, |_| {
        Err(std::io::Error::other("injected creation failure"))
    });

    let (status, failed) = post_create_draft(&router, None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{failed}");
    let (status, list) = get_draft_list(&router).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(
        list["warnings"],
        json!([]),
        "a failed creation is warned: {list}"
    );
    assert_eq!(
        list["drafts"],
        json!([]),
        "a failed creation is listed: {list}"
    );
    assert_eq!(staged(&workspace), Vec::<String>::new());

    let (status, created) = post_create_draft(&router, None).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(
        created["name"], "untitled",
        "the failed creation kept its name"
    );
}

#[tokio::test]
async fn a_draft_whose_primary_is_removed_lists_as_broken_with_its_discard_source() {
    let app = route_test_app();
    let router = crate::router(app.state.clone());
    let workspace = app.state.try_workspace().unwrap();
    let (status, created) = post_create_draft(&router, None).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    std::fs::remove_file(workspace.drafts_dir().join("untitled/draft.md")).unwrap();
    let source = json!({
        "root": "draft",
        "path": "untitled",
        "draft_id": created["primary"]["draft_id"],
    });

    let (status, list) = get_draft_list(&router).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["drafts"], json!([]), "{list}");
    assert_eq!(list["warnings"].as_array().unwrap().len(), 1, "{list}");
    assert_eq!(list["warnings"][0]["kind"], "broken_draft");
    assert_eq!(list["warnings"][0]["message"], "draft has no primary file");
    assert_eq!(list["warnings"][0]["source"], source);
    let (status, info) = get_workspace(&router).await;
    assert_eq!(status, StatusCode::OK, "{info}");
    assert_eq!(info["warnings"].as_array().unwrap().len(), 1, "{info}");
    assert_eq!(info["warnings"][0]["kind"], "broken_draft");
    assert_eq!(info["warnings"][0]["source"], source);

    let discard = json!({ "source": source }).to_string();
    let (status, _) = post_window_mutation(&router, "/api/drafts/discard", Some(&discard)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, list) = get_draft_list(&router).await;
    assert_eq!(list, json!({ "drafts": [], "warnings": [] }));
}

/// Promote a created draft to `target`, holding the promotion where it is
/// about to remove the source. The hold first unlinks the marker in the
/// directory it is given: `remove_dir_all` unlinks a directory's entries one
/// at a time, and this is the state it passes through when the marker goes
/// first.
async fn promotion_removing_its_source_is_not_listed_broken(attachment: bool, target: &str) {
    let app = route_test_app();
    let router = crate::router(app.state.clone());
    let workspace = app.state.try_workspace().unwrap();
    let (status, created) = post_create_draft(&router, None).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    if attachment {
        let id = created["primary"]["draft_id"].as_str().unwrap();
        workspace
            .draft_files()
            .unwrap()
            .create_bytes("untitled/image.png", id, &[1, 2, 3])
            .unwrap();
    }
    let Hold { reached, release } =
        hold_after(workspace.drafts_dir(), draft_hold::SOURCE_REMOVING, |dir| {
            std::fs::remove_file(dir.join(MARKER)).unwrap()
        });

    let body = json!({ "source": created["primary"], "target": target }).to_string();
    let mut promote = spawn_post(&router, "/api/drafts/promote", Some(body));
    let removing = held(reached, &mut promote, draft_hold::SOURCE_REMOVING).await;
    let (list_status, list) = get_draft_list(&router).await;
    release.send(()).unwrap();
    let (promoted_status, promoted) = promote.await.unwrap();

    let at = format!("a promotion removing {}", removing.display());
    assert_eq!(list_status, StatusCode::OK, "{at}: {list}");
    assert_eq!(list["warnings"], json!([]), "{at} is warned: {list}");
    for row in list["drafts"].as_array().unwrap() {
        assert_eq!(row["busy"], true, "{at} is listed idle: {list}");
    }
    assert_eq!(promoted_status, StatusCode::OK, "{promoted}");
    let (_, list) = get_draft_list(&router).await;
    assert_eq!(list, json!({ "drafts": [], "warnings": [] }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_single_file_promotion_removing_its_source_is_not_listed_broken() {
    promotion_removing_its_source_is_not_listed_broken(false, "saved.md").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_directory_promotion_removing_its_source_is_not_listed_broken() {
    promotion_removing_its_source_is_not_listed_broken(true, "saved.md").await;
}

#[tokio::test]
async fn a_promotion_whose_retired_copy_cannot_be_removed_answers_its_target() {
    let app = route_test_app();
    let router = crate::router(app.state.clone());
    let workspace = app.state.try_workspace().unwrap();
    let (status, created) = post_create_draft(&router, None).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    draft_hold::on_step(workspace.drafts_dir(), draft_hold::SOURCE_REMOVING, |_| {
        Err(std::io::Error::other("injected removal failure"))
    });

    let body = json!({ "source": created["primary"], "target": "saved.md" }).to_string();
    let (status, promoted) =
        post_window_mutation(&router, "/api/drafts/promote", Some(&body)).await;

    assert_eq!(status, StatusCode::OK, "{promoted}");
    assert_eq!(promoted["primary"]["path"], "saved.md");
    assert_eq!(
        std::fs::read_to_string(workspace.root().join("saved.md")).unwrap(),
        NEW_DRAFT_CONTENT
    );
    let (_, list) = get_draft_list(&router).await;
    assert_eq!(list, json!({ "drafts": [], "warnings": [] }));
    let retired = staged(&workspace);
    assert_eq!(retired.len(), 1, "{retired:?}");
    assert!(retired[0].starts_with("untitled."), "{retired:?}");
}
