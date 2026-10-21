use super::*;
use crate::state::AppState;
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::sync::oneshot;

const BOUND: Duration = Duration::from_secs(30);

struct Fixture {
    state: Arc<AppState>,
    workspace: Arc<Workspace>,
    _dirs: [TempDir; 2],
}

impl Fixture {
    fn new() -> Self {
        let cfg = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let library = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        library.register_workspace(root.path()).unwrap();
        let workspace = library.open_workspace(root.path()).unwrap();
        workspace.stop_open_recovery();
        assert!(workspace.recovery_status().is_ready());
        workspace
            .write_text("note.md", "# Note\n\n#oldtag\n")
            .unwrap();
        workspace.index_file("note.md").unwrap();
        let mut state =
            crate::state::test_support::base_app_state(library, workspace.root().to_path_buf());
        state.events_tx = broadcast::channel(32).0;
        state.index_events_tx = broadcast::channel(32).0;
        let indexer = Arc::new(Indexer::spawn(
            workspace.clone(),
            state.index_events_tx.subscribe(),
            false,
            SearchAggression::Aggressive,
            Arc::new(chan_workspace::NoProgress),
            state.events_tx.clone(),
        ));
        *state.workspace_cell.write().unwrap() = Some(crate::state::WorkspaceCell {
            workspace: workspace.clone(),
            watch_handle: None,
            indexer,
        });
        let state = Arc::new(state);
        Self {
            state,
            workspace,
            _dirs: [cfg, root],
        }
    }

    fn changed(&self, path: &str) {
        self.state
            .index_events_tx
            .send(WatchEvent::file(
                WatchKind::Modified,
                path,
                self.workspace.generation(),
            ))
            .unwrap();
    }

    fn settled(&self, path: &str) -> oneshot::Receiver<(String, IndexStatus)> {
        let (tx, rx) = oneshot::channel();
        test_hooks::on_apply_settled(&self.workspace.root().join(path), move |result, status| {
            let _ = tx.send((result, status));
        });
        rx
    }

    fn has_tag(&self, name: &str) -> bool {
        self.workspace
            .graph()
            .unwrap()
            .tags()
            .unwrap()
            .iter()
            .any(|tag| tag.name == name)
    }

    fn seed(&self, path: &str) {
        self.workspace
            .write_text(path, "# Seed\n\n#seedtag\n")
            .unwrap();
        self.workspace.index_file(path).unwrap();
    }

    async fn apply(&self, kind: WatchKind, path: &str, is_dir: bool) -> (Vec<Value>, IndexStatus) {
        let mut rx = self.state.events_tx.subscribe();
        let settled = self.settled(path);
        let mut event = WatchEvent::file(kind, path, self.workspace.generation());
        event.is_dir = is_dir;
        self.state.index_events_tx.send(event).unwrap();
        let (_, status) = receive(settled).await;
        (frames(&mut rx), status)
    }
}

async fn receive<T>(rx: oneshot::Receiver<T>) -> T {
    tokio::time::timeout(BOUND, rx)
        .await
        .expect("fixture signal within bound")
        .expect("fixture sender")
}

fn frames(rx: &mut broadcast::Receiver<String>) -> Vec<Value> {
    let mut frames = Vec::new();
    loop {
        match rx.try_recv() {
            Ok(text) => frames.push(serde_json::from_str(&text).unwrap()),
            Err(broadcast::error::TryRecvError::Empty) => return frames,
            Err(error) => panic!("frame receiver: {error}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn graph_applied_follows_the_graph_write_and_reaches_the_bus_once() {
    let fixture = Fixture::new();
    assert!(fixture.has_tag("oldtag"));
    let mut rx = fixture.state.events_tx.subscribe();
    fixture
        .workspace
        .write_text("note.md", "# Note\n\n#newtag\n")
        .unwrap();
    let path = fixture.workspace.root().join("note.md");
    let (before_tx, before_rx) = oneshot::channel();
    let (resume, resumed) = std::sync::mpsc::channel();
    test_hooks::on_after_metadata(&path, move || {
        let _ = before_tx.send(());
        let _ = resumed.recv_timeout(BOUND);
    });
    let (after_tx, after_rx) = oneshot::channel();
    let (publish, publish_rx) = oneshot::channel();
    test_hooks::on_after_apply(&path, (after_tx, publish_rx));
    let settled = fixture.settled("note.md");
    fixture.changed("note.md");
    receive(before_rx).await;
    let old_graph = fixture.has_tag("oldtag") && !fixture.has_tag("newtag");
    let before = frames(&mut rx);
    resume.send(()).unwrap();
    receive(after_rx).await;
    let new_graph = fixture.has_tag("newtag") && !fixture.has_tag("oldtag");
    let after = frames(&mut rx);
    publish.send(()).unwrap();
    let (_, status) = receive(settled).await;
    let published = frames(&mut rx);
    assert!(old_graph, "the before-apply gate still reads the old graph");
    assert!(before.is_empty(), "no frame before the apply: {before:?}");
    assert!(new_graph, "the after-apply gate reads the changed graph");
    assert!(
        after.is_empty(),
        "no frame before the publication gate: {after:?}"
    );
    assert!(matches!(status, IndexStatus::Idle { .. }), "{status:?}");
    assert_eq!(
        published,
        vec![json!({"type":"graph_applied","paths":["note.md"]})],
        "one graph-applied frame follows the completed graph write"
    );
}

fn expected(paths: &[&str]) -> Vec<Value> {
    vec![json!({"type":"graph_applied","paths":paths})]
}

#[tokio::test]
async fn graph_applied_ignores_an_unapplied_path_beside_an_applied_control() {
    let fixture = Fixture::new();
    let mut rx = fixture.state.events_tx.subscribe();
    let settled = fixture.settled("note.md");
    fixture.changed("image.png");
    fixture.changed("note.md");
    receive(settled).await;
    assert_eq!(
        frames(&mut rx),
        expected(&["note.md"]),
        "only an applied path is announced"
    );
}

#[tokio::test]
async fn graph_applied_names_deleted_and_undecodable_files() {
    let fixture = Fixture::new();
    fixture.seed("deleted.md");
    std::fs::remove_file(fixture.workspace.root().join("deleted.md")).unwrap();
    let (received, status) = fixture.apply(WatchKind::Removed, "deleted.md", false).await;
    assert_eq!(received, expected(&["deleted.md"]));
    assert!(matches!(status, IndexStatus::Idle { .. }));
    assert!(!fixture
        .workspace
        .graph()
        .unwrap()
        .files()
        .unwrap()
        .contains(&"deleted.md".into()));

    fixture.seed("undecodable.md");
    std::fs::write(fixture.workspace.root().join("undecodable.md"), [0xff]).unwrap();
    let (received, status) = fixture
        .apply(WatchKind::Modified, "undecodable.md", false)
        .await;
    assert_eq!(received, expected(&["undecodable.md"]));
    assert!(matches!(status, IndexStatus::Idle { .. }));
    assert!(!fixture
        .workspace
        .graph()
        .unwrap()
        .files()
        .unwrap()
        .contains(&"undecodable.md".into()));
}

#[cfg(unix)]
#[tokio::test]
async fn graph_applied_names_a_file_replaced_by_a_symlink() {
    let fixture = Fixture::new();
    fixture.seed("special.md");
    let path = fixture.workspace.root().join("special.md");
    std::fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink("note.md", &path).unwrap();
    let (received, status) = fixture
        .apply(WatchKind::Modified, "special.md", false)
        .await;
    assert_eq!(received, expected(&["special.md"]));
    assert!(matches!(status, IndexStatus::Idle { .. }));
    assert!(!fixture
        .workspace
        .graph()
        .unwrap()
        .files()
        .unwrap()
        .contains(&"special.md".into()));
}

#[tokio::test]
async fn graph_applied_lists_every_subtree_file_and_the_root() {
    let fixture = Fixture::new();
    fixture.seed("old/z.md");
    fixture.seed("old/nested/a.md");
    let (received, _) = fixture.apply(WatchKind::Removed, "old", true).await;
    assert_eq!(
        received,
        expected(&["old/nested/a.md", "old/z.md"]),
        "every forgotten subtree file is named"
    );
    assert_eq!(
        fixture.workspace.graph().unwrap().files().unwrap(),
        vec!["note.md"]
    );
    let (received, _) = fixture.apply(WatchKind::Removed, "", true).await;
    assert_eq!(
        received,
        expected(&["note.md"]),
        "the root names files, not a prefix"
    );
    assert!(fixture
        .workspace
        .graph()
        .unwrap()
        .files()
        .unwrap()
        .is_empty());
    let (received, _) = fixture.apply(WatchKind::Removed, "", true).await;
    assert!(
        received.is_empty(),
        "an empty subtree has no file paths to announce"
    );
}

#[tokio::test]
async fn graph_applied_survives_declined_absent_and_failed_single_path_applies() {
    use chan_workspace::workspace::journal_test_hooks::{fail_next, Operation};
    let fixture = Fixture::new();
    let large = std::fs::File::create(fixture.workspace.root().join("large.md")).unwrap();
    large.set_len(chan_workspace::TEXT_WRITE_LIMIT + 1).unwrap();
    let (received, status) = fixture.apply(WatchKind::Modified, "large.md", false).await;
    assert_eq!(received, expected(&["large.md"]));
    assert!(matches!(status, IndexStatus::Idle { .. }));
    assert!(!fixture
        .workspace
        .graph()
        .unwrap()
        .files()
        .unwrap()
        .contains(&"large.md".into()));
    let (received, _) = fixture.apply(WatchKind::Removed, "absent.md", false).await;
    assert_eq!(received, expected(&["absent.md"]));
    let _fault = fail_next(
        &fixture.workspace,
        "note.md",
        Operation::Index,
        std::io::ErrorKind::PermissionDenied,
    );
    let (received, status) = fixture.apply(WatchKind::Modified, "note.md", false).await;
    assert_eq!(
        received,
        expected(&["note.md"]),
        "a failed apply still invalidates its graph view"
    );
    let IndexStatus::Error { message } = status else {
        panic!("the apply error must be retained: {status:?}");
    };
    assert!(
        message.contains("injected journal write failure"),
        "{message}"
    );
}

#[tokio::test]
async fn graph_applied_keeps_attempted_paths_when_a_subtree_forget_fails() {
    use chan_workspace::workspace::journal_test_hooks::{fail_next, Operation};
    let fixture = Fixture::new();
    for path in ["old/a.md", "old/b.md", "old/c.md"] {
        fixture.seed(path);
    }
    let _fault = fail_next(
        &fixture.workspace,
        "old/b.md",
        Operation::Forget,
        std::io::ErrorKind::PermissionDenied,
    );
    let (received, status) = fixture.apply(WatchKind::Removed, "old", true).await;
    assert_eq!(
        received,
        expected(&["old/a.md", "old/b.md"]),
        "subtree errors retain every attempted path"
    );
    let IndexStatus::Error { message } = status else {
        panic!("the subtree error must be retained: {status:?}");
    };
    assert!(message.contains("injected journal write failure"));
    let paths = fixture.workspace.graph().unwrap().files().unwrap();
    assert!(!paths.contains(&"old/a.md".into()));
    assert!(paths.contains(&"old/b.md".into()));
    assert!(
        paths.contains(&"old/c.md".into()),
        "the loop stops at its first error"
    );
}

#[tokio::test]
async fn graph_applied_sends_nothing_when_subtree_listing_fails() {
    let fixture = Fixture::new();
    let _fault =
        chan_workspace::workspace::subtree_test_hooks::fail_next_listing(&fixture.workspace);
    let (received, status) = fixture.apply(WatchKind::Removed, "", true).await;
    assert!(received.is_empty(), "a failed listing starts no file apply");
    let IndexStatus::Error { message } = status else {
        panic!("listing error must be retained: {status:?}");
    };
    assert!(message.contains("injected subtree listing failure"));
    assert_eq!(
        fixture.workspace.graph().unwrap().files().unwrap(),
        vec!["note.md"]
    );
}

#[tokio::test]
async fn graph_applied_names_both_ends_of_paired_and_lone_renames() {
    for paired in [true, false] {
        let fixture = Fixture::new();
        let mut rx = fixture.state.events_tx.subscribe();
        std::fs::rename(
            fixture.workspace.root().join("note.md"),
            fixture.workspace.root().join("renamed.md"),
        )
        .unwrap();
        let from = fixture.settled("note.md");
        let to = fixture.settled("renamed.md");
        let mut event = WatchEvent::file(
            WatchKind::Renamed,
            "note.md",
            fixture.workspace.generation(),
        );
        if paired {
            event.to = Some("renamed.md".into());
        }
        fixture.state.index_events_tx.send(event).unwrap();
        if !paired {
            fixture
                .state
                .index_events_tx
                .send(WatchEvent::file(
                    WatchKind::Renamed,
                    "renamed.md",
                    fixture.workspace.generation(),
                ))
                .unwrap();
        }
        receive(from).await;
        receive(to).await;
        let mut received = frames(&mut rx);
        received.sort_by_key(Value::to_string);
        assert_eq!(
            received,
            vec![
                expected(&["note.md"]).remove(0),
                expected(&["renamed.md"]).remove(0)
            ],
            "separate frames for each applied rename path"
        );
        assert_eq!(
            fixture.workspace.graph().unwrap().files().unwrap(),
            vec!["renamed.md"]
        );
    }
}

#[tokio::test]
async fn graph_applied_crosses_every_self_write_origin_without_changing_raw_echoes() {
    let fixture = Fixture::new();
    let bridge = crate::bus::make_watch_bridge(
        &fixture.state.events_tx,
        &fixture.state.index_events_tx,
        &fixture.state.self_writes,
        &fixture.state.scope_registry,
        fixture.workspace.root().to_path_buf(),
    );
    let mut rx = fixture.state.events_tx.subscribe();
    let (scope, mut scoped) = fixture.state.scope_registry.register();
    fixture.state.scope_registry.subscribe(scope, "");
    for (path, origin) in [
        ("external.md", None),
        ("windowless.md", Some(None)),
        ("writer.md", Some(Some("writer"))),
    ] {
        fixture.seed(path);
        fixture
            .workspace
            .write_text(path, "# Changed\n\n#fresh\n")
            .unwrap();
        if let Some(origin) = origin {
            fixture.state.self_writes.note_from(path, origin);
        }
        let settled = fixture.settled(path);
        let (applied, after_apply) = oneshot::channel();
        let (publish, publish_rx) = oneshot::channel();
        test_hooks::on_after_apply(&fixture.workspace.root().join(path), (applied, publish_rx));
        bridge.on_event(WatchEvent::file(
            WatchKind::Modified,
            path,
            fixture.workspace.generation(),
        ));
        receive(after_apply).await;
        let raw = frames(&mut rx);
        let scoped_raw = scoped.try_recv();
        publish.send(()).unwrap();
        receive(settled).await;
        assert_eq!(
            frames(&mut rx),
            expected(&[path]),
            "every origin reaches the indexer"
        );
        if origin.is_none() {
            assert_eq!(raw.len(), 1);
            assert_eq!(raw[0]["type"], "watch");
            assert!(raw[0].get("source_w").is_none());
            let scoped_raw: Value = serde_json::from_str(&scoped_raw.unwrap()).unwrap();
            assert_eq!(scoped_raw["type"], "fs");
        } else {
            assert!(raw.is_empty(), "a noted modification has no raw echo");
            assert!(scoped_raw.is_err());
        }
    }
}

#[test]
fn graph_applied_wire_sorts_deduplicates_and_refuses_empty_lists() {
    let (tx, mut rx) = broadcast::channel(8);
    crate::bus::send_graph_applied(&tx, vec!["z.md".into(), "a.md".into(), "z.md".into()]);
    assert_eq!(
        frames(&mut rx),
        expected(&["a.md", "z.md"]),
        "the graph-applied wire has only its type and paths"
    );
    crate::bus::send_graph_applied(&tx, Vec::new());
    assert!(
        frames(&mut rx).is_empty(),
        "an empty list must never be sent"
    );
}

async fn socket_fanout(state: Arc<AppState>, path: &str) {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel();
    let app = crate::router(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
    });
    let mut sockets = Vec::new();
    for query in ["?w=writer", "?w=sibling", ""] {
        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws{query}"))
            .await
            .unwrap();
        socket
            .send(Message::Text(r#"{"type":"ping"}"#.into()))
            .await
            .unwrap();
        tokio::time::timeout(BOUND, async {
            loop {
                let message = socket.next().await.unwrap().unwrap();
                if let Message::Text(text) = message {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if value["type"] == "pong" {
                        break;
                    }
                }
            }
        })
        .await
        .expect("socket entered its pump");
        sockets.push(socket);
    }
    let workspace = state.try_workspace().unwrap();
    let (settled_tx, settled_rx) = oneshot::channel();
    test_hooks::on_apply_settled(&workspace.root().join(path), move |_, status| {
        let _ = settled_tx.send(status);
    });
    state.self_writes.note_from(path, Some("writer"));
    let bridge = crate::bus::make_watch_bridge(
        &state.events_tx,
        &state.index_events_tx,
        &state.self_writes,
        &state.scope_registry,
        workspace.root().to_path_buf(),
    );
    bridge.on_event(WatchEvent::file(
        WatchKind::Modified,
        path,
        workspace.generation(),
    ));
    receive(settled_rx).await;
    state
        .events_tx
        .send(r#"{"type":"test_barrier"}"#.into())
        .unwrap();
    let mut received = Vec::new();
    for socket in &mut sockets {
        let values = tokio::time::timeout(BOUND, async {
            let mut values = Vec::new();
            loop {
                let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
                    continue;
                };
                let value: Value = serde_json::from_str(&text).unwrap();
                if value["type"] == "test_barrier" {
                    break;
                }
                if !matches!(value["type"].as_str(), Some("session_roster" | "progress")) {
                    values.push(value);
                }
            }
            values
        })
        .await
        .expect("the broadcast barrier reaches each socket");
        received.push(values);
        socket.close(None).await.unwrap();
    }
    drop(sockets);
    stop.send(()).unwrap();
    tokio::time::timeout(BOUND, server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    for (i, values) in received.iter().enumerate() {
        assert_eq!(
            values,
            &expected(&[path]),
            "graph-applied fan-out includes socket {i} for {path} (writer, sibling, untagged)"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn graph_applied_from_built_and_reinstalled_tenants_reaches_every_socket() {
    use tower::ServiceExt;
    const CHILD: &str = "CHAN_TEST_GRAPH_APPLIED_BUILDER_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let home = tempfile::tempdir().unwrap();
        let caller = std::thread::current().name().unwrap().to_owned();
        let output = tokio::time::timeout(
            Duration::from_secs(90),
            tokio::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    &caller,
                    "--nocapture",
                    "--test-threads=2",
                    "--color=never",
                ])
                .env(CHILD, "1")
                .env("CHAN_HOME", home.path())
                .env("HOME", home.path())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "builder child failed: {stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            stdout
                .lines()
                .any(|line| line == format!("test {caller} ... ok")),
            "child ran its test: {stdout}"
        );
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let home = std::path::PathBuf::from(std::env::var_os("CHAN_HOME").unwrap());
    let library = chan_workspace::Library::open_at(home.join("library.toml")).unwrap();
    library.register_workspace(root.path()).unwrap();
    let workspace = library.open_workspace(root.path()).unwrap();
    workspace
        .write_text("seed.md", "# Seed\n\nseedtoken\n")
        .unwrap();
    workspace.index_file("seed.md").unwrap();
    workspace.stop_open_recovery();
    let config = crate::ServeConfig {
        addr: ([127, 0, 0, 1], 0).into(),
        prefix: String::new(),
        no_token: true,
        idle_timeout: None,
        open_browser: false,
        search_aggression: Some(SearchAggression::Aggressive),
        settings_disabled: false,
        verbose: false,
    };
    let mut built = crate::build_app(
        library,
        workspace,
        &config,
        crate::desktop_window_ops::DesktopBridge::default(),
        chan_library::UnserveMode::Standalone,
        None,
    )
    .await
    .unwrap();
    // Synthetic changes own the order; no OS watcher can queue a second apply.
    drop(
        built
            .state
            .workspace_cell
            .write()
            .unwrap()
            .as_mut()
            .unwrap()
            .watch_handle
            .take(),
    );
    socket_fanout(built.state.clone(), "first.md").await;
    let response = tokio::time::timeout(
        BOUND,
        crate::router(built.state.clone()).oneshot(
            axum::http::Request::post("/api/storage/reset")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(r#"{"mode":"workspace"}"#))
                .unwrap(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        response.status(),
        axum::http::StatusCode::OK,
        "the real cell reset succeeds"
    );
    drop(
        built
            .state
            .workspace_cell
            .write()
            .unwrap()
            .as_mut()
            .unwrap()
            .watch_handle
            .take(),
    );
    socket_fanout(built.state.clone(), "second.md").await;
    built.tasks.shutdown().await;
}
