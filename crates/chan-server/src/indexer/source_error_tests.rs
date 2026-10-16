use super::*;
use crate::state::{test_support::workspace_app_state, AppState};
use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use chan_workspace::{Library, SearchMode, SearchOpts};
use std::fs;
use tempfile::TempDir;
use tower::ServiceExt;

struct Fixture {
    workspace: Arc<Workspace>,
    library: Library,
    _root: TempDir,
    _config: TempDir,
}

impl Fixture {
    fn new() -> Self {
        let config = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let library = Library::open_at(config.path().join("config.toml")).unwrap();
        library.register_workspace(root.path()).unwrap();
        let workspace = library.open_workspace(root.path()).unwrap();
        workspace.stop_open_recovery();
        assert!(workspace.recovery_status().is_ready());
        for (rel, content) in [
            ("bad.md", "# Source\n\nsourceoldtoken [neighbor](good.md)\n"),
            ("good.md", "# Neighbor\n\nneighborcontroltoken\n"),
        ] {
            fs::write(workspace.root().join(rel), content).unwrap();
            workspace.index_file(rel).unwrap();
        }
        Self {
            workspace,
            library,
            _root: root,
            _config: config,
        }
    }

    fn app(&self) -> Arc<AppState> {
        Arc::new(AppState {
            token: Some("secret".to_owned()),
            ..workspace_app_state(
                self.library.clone(),
                self.workspace.root().to_path_buf(),
                self.workspace.clone(),
            )
        })
    }
}

async fn settle(app: &Arc<AppState>, path: &str) -> (String, IndexStatus) {
    let workspace = app.try_workspace().unwrap();
    let (tx, rx) = tokio::sync::oneshot::channel();
    test_hooks::on_apply_settled(&workspace.root().join(path), move |result, status| {
        tx.send((result, status)).unwrap();
    });
    app.index_events_tx
        .send(WatchEvent::file(
            WatchKind::Modified,
            path,
            workspace.recovery_status().generation,
        ))
        .unwrap();
    tokio::time::timeout(Duration::from_secs(30), rx)
        .await
        .expect("watcher apply must settle")
        .unwrap()
}

async fn preflight(app: &Arc<AppState>) -> serde_json::Value {
    let response = crate::router(app.clone())
        .oneshot(
            Request::get("/api/preflight")
                .header(header::AUTHORIZATION, "Bearer secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 8192)
        .await
        .unwrap();
    serde_json::from_slice(&body).unwrap()
}

fn hits(workspace: &Workspace, token: &str) -> Vec<String> {
    workspace
        .search(
            token,
            &SearchOpts {
                mode: SearchMode::Bm25,
                limit: 10,
                scope: None,
            },
        )
        .unwrap()
        .hits
        .into_iter()
        .map(|hit| hit.path)
        .collect()
}

fn assert_seed(workspace: &Workspace) {
    let graph = workspace.graph().unwrap();
    assert!(graph.files().unwrap().contains(&"bad.md".to_owned()));
    assert!(!graph.headings_of("bad.md").unwrap().is_empty());
    assert_eq!(graph.backlinks("good.md").unwrap().len(), 1);
    assert_eq!(hits(workspace, "sourceoldtoken"), ["bad.md"]);
    assert_eq!(hits(workspace, "neighborcontroltoken"), ["good.md"]);
}

fn assert_cleaned(workspace: &Workspace) {
    let graph = workspace.graph().unwrap();
    assert!(
        !graph.files().unwrap().contains(&"bad.md".to_owned()),
        "stale source graph row"
    );
    assert!(graph.headings_of("bad.md").unwrap().is_empty());
    assert!(graph.backlinks("good.md").unwrap().is_empty());
    assert!(
        hits(workspace, "sourceoldtoken").is_empty(),
        "stale source search row"
    );
    assert_eq!(hits(workspace, "neighborcontroltoken"), ["good.md"]);
    assert!(graph.files().unwrap().contains(&"good.md".to_owned()));
    assert!(
        workspace.pending_writes().is_empty(),
        "source journal must settle"
    );
    assert!(!workspace
        .paths()
        .graph_dir
        .join("pending_writes.json")
        .exists());
}

async fn assert_source_skipped(app: &Arc<AppState>) {
    let (result, status) = settle(app, "bad.md").await;
    assert!(
        matches!(status, IndexStatus::Idle { .. }),
        "source failure must leave Idle: {status:?}; {result}"
    );
    let response = preflight(app).await;
    assert_eq!(response["phase"], "ready", "{response}");
    assert_eq!(response["locked"], false, "{response}");
    assert!(response["error"].is_null(), "{response}");
    assert_eq!(result, "Ok(Ok(SkippedSource))");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undecodable_source_keeps_preflight_unlocked() {
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    assert_seed(workspace);
    let app = fixture.app();
    fs::write(workspace.root().join("bad.md"), [0xff, 0xfe]).unwrap();
    assert_source_skipped(&app).await;
    assert_eq!(
        fs::read(workspace.root().join("bad.md")).unwrap(),
        [0xff, 0xfe]
    );
    assert_cleaned(workspace);
    fs::write(
        workspace.root().join("bad.md"),
        "# Repaired\n\nrestoredsourcetoken\n",
    )
    .unwrap();
    let (result, status) = settle(&app, "bad.md").await;
    assert!(matches!(status, IndexStatus::Idle { .. }), "{status:?}");
    assert_eq!(result, "Ok(Ok(Indexed))");
    assert_eq!(hits(workspace, "restoredsourcetoken"), ["bad.md"]);
}

#[cfg(unix)]
struct RestorePermissions(std::path::PathBuf, fs::Permissions);

#[cfg(unix)]
impl RestorePermissions {
    fn set(path: &std::path::Path, mode: u32) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let guard = Self(
            path.to_path_buf(),
            fs::metadata(path).unwrap().permissions(),
        );
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
        guard
    }
}

#[cfg(unix)]
impl Drop for RestorePermissions {
    fn drop(&mut self) {
        fs::set_permissions(&self.0, self.1.clone()).unwrap();
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unreadable_source_keeps_preflight_unlocked() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    assert_seed(workspace);
    let app = fixture.app();
    let path = workspace.root().join("bad.md");
    let permissions = RestorePermissions::set(&path, 0);
    assert_eq!(
        fs::read(&path).unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied,
        "the fixture must deny a plain read by this non-root test user"
    );
    assert_source_skipped(&app).await;
    assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0);
    assert_cleaned(workspace);
    drop(permissions);
    assert!(fs::read_to_string(&path)
        .unwrap()
        .contains("sourceoldtoken"));
}

async fn assert_backend_locked(app: &Arc<AppState>) {
    let (result, status) = settle(app, "bad.md").await;
    assert!(
        matches!(status, IndexStatus::Error { .. }),
        "backend failure must leave Error: {status:?}; {result}"
    );
    let response = preflight(app).await;
    assert_eq!(response["phase"], "failed", "{response}");
    assert_eq!(response["locked"], true, "{response}");
    assert_eq!(response["error"]["step"], "index", "{response}");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refused_journal_write_keeps_preflight_locked() {
    let fixture = Fixture::new();
    let app = fixture.app();
    let workspace = &fixture.workspace;
    let _permissions = RestorePermissions::set(&workspace.paths().graph_dir, 0o500);
    let probe = workspace.paths().graph_dir.join("refused-probe");
    assert_eq!(
        fs::write(probe, b"probe").unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied,
        "the fixture must deny a plain write by this non-root test user"
    );
    assert!(workspace
        .read_text("bad.md")
        .unwrap()
        .contains("sourceoldtoken"));
    assert_backend_locked(&app).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_journal_write_keeps_preflight_locked() {
    use chan_workspace::workspace::journal_test_hooks::{fail_next, Operation};
    let fixture = Fixture::new();
    let app = fixture.app();
    let workspace = &fixture.workspace;
    assert!(workspace
        .read_text("bad.md")
        .unwrap()
        .contains("sourceoldtoken"));
    let fault = fail_next(
        workspace,
        "bad.md",
        Operation::Index,
        std::io::ErrorKind::NotFound,
    );
    assert_backend_locked(&app).await;
    assert!(workspace
        .read_text("bad.md")
        .unwrap()
        .contains("sourceoldtoken"));
    drop(fault);
    let (result, status) = settle(&app, "bad.md").await;
    assert!(
        matches!(status, IndexStatus::Idle { .. }),
        "one-shot fault: {status:?}"
    );
    assert_eq!(result, "Ok(Ok(Indexed))");
}

#[test]
fn source_cleanup_failure_is_an_outer_error() {
    use chan_workspace::workspace::journal_test_hooks::{fail_next, Operation};
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    assert_seed(workspace);
    fs::write(workspace.root().join("bad.md"), [0xff, 0xfe]).unwrap();
    let fault = fail_next(
        workspace,
        "bad.md",
        Operation::Forget,
        std::io::ErrorKind::PermissionDenied,
    );
    let result = workspace.index_file_or_source_error("bad.md");
    assert!(
        matches!(result, Err(chan_workspace::ChanError::Io(ref error)) if error.contains("injected journal write failure")),
        "cleanup failure must remain outer Err: {result:?}"
    );
    assert!(!workspace.pending_writes().is_empty());
    assert_seed(workspace);
    drop(fault);
    assert!(workspace
        .index_file_or_source_error("bad.md")
        .unwrap()
        .is_some());
    assert_cleaned(workspace);
}

#[test]
fn strict_index_file_returns_source_failure() {
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    fs::write(workspace.root().join("bad.md"), [0xff, 0xfe]).unwrap();
    let result = workspace.index_file("bad.md");
    assert!(
        matches!(result, Err(chan_workspace::ChanError::Io(_))),
        "strict API must return source failure: {result:?}"
    );
    assert_cleaned(workspace);
}

#[test]
fn undecodable_text_retains_only_its_stat_stamp() {
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    let path = workspace.root().join("bad.txt");
    fs::write(&path, "textoldtoken\n").unwrap();
    workspace.index_file("bad.txt").unwrap();
    assert_eq!(hits(workspace, "textoldtoken"), ["bad.txt"]);
    fs::write(&path, [0xff, 0xfe]).unwrap();
    assert!(workspace
        .index_file_or_source_error("bad.txt")
        .unwrap()
        .is_some());
    assert!(hits(workspace, "textoldtoken").is_empty());
    assert!(workspace
        .graph()
        .unwrap()
        .files_with_stat()
        .unwrap()
        .iter()
        .any(|row| row.0 == "bad.txt"));
    assert!(!workspace
        .graph()
        .unwrap()
        .files()
        .unwrap()
        .contains(&"bad.txt".to_owned()));
    let report = workspace.reconcile().unwrap();
    assert!(
        report.upserted.is_empty() && report.failed.is_empty(),
        "{report:?}"
    );
    assert_eq!(report.unchanged, 3);
    assert!(workspace.pending_writes().is_empty());
    assert_eq!(fs::read(&path).unwrap(), [0xff, 0xfe]);
}

#[derive(Debug)]
struct Event {
    level: tracing::Level,
    fields: std::collections::BTreeMap<String, String>,
}

impl tracing::field::Visit for Event {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        self.fields
            .insert(field.name().to_owned(), format!("{value:?}"));
    }
}

fn capture<T>(f: impl FnOnce() -> T) -> (Vec<Event>, T) {
    struct Capture(Arc<Mutex<Vec<Event>>>);
    impl tracing::Subscriber for Capture {
        fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
            true
        }
        fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }
        fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
        fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
        fn event(&self, event: &tracing::Event<'_>) {
            let mut recorded = Event {
                level: *event.metadata().level(),
                fields: Default::default(),
            };
            event.record(&mut recorded);
            self.0.lock().unwrap().push(recorded);
        }
        fn enter(&self, _: &tracing::span::Id) {}
        fn exit(&self, _: &tracing::span::Id) {}
    }
    let events = Arc::new(Mutex::new(Vec::new()));
    let result = tracing::subscriber::with_default(Capture(events.clone()), || {
        tracing::info!("source-capture-control");
        f()
    });
    let captured = std::mem::take(&mut *events.lock().unwrap());
    assert!(captured.iter().any(|event| event
        .fields
        .get("message")
        .is_some_and(|s| s == "source-capture-control")));
    (captured, result)
}

fn source_warnings(events: &[Event]) -> Vec<&Event> {
    events
        .iter()
        .filter(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|s| s == "indexer: skipped unreadable source file")
        })
        .collect()
}

#[test]
fn source_warning_names_path_and_error() {
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    fs::write(workspace.root().join("bad.md"), [0xff, 0xfe]).unwrap();
    let expected_error = workspace.read_text("bad.md").unwrap_err().to_string();
    let (events, outcome) = capture(|| apply_watch_change(workspace, "bad.md", false, false));
    assert_eq!(outcome.unwrap(), ApplyOutcome::SkippedSource);
    let warnings = source_warnings(&events);
    assert_eq!(warnings.len(), 1, "one source warning: {events:?}");
    assert_eq!(warnings[0].level, tracing::Level::WARN);
    assert_eq!(
        warnings[0].fields.get("path").map(String::as_str),
        Some("bad.md"),
        "source warning path"
    );
    assert_eq!(warnings[0].fields.get("error"), Some(&expected_error));
}

#[test]
fn vanished_source_stays_a_quiet_skip() {
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    let path = workspace.root().join("bad.md");
    let remove = path.clone();
    test_hooks::on_after_metadata(&path, move || fs::remove_file(remove).unwrap());
    let (events, outcome) = capture(|| apply_watch_change(workspace, "bad.md", false, false));
    assert_eq!(outcome.unwrap(), ApplyOutcome::SkippedMissing);
    assert!(source_warnings(&events).is_empty(), "{events:?}");
    assert_cleaned(workspace);
}
