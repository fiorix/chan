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

    fn drain_frames(&self) -> oneshot::Receiver<Vec<Value>> {
        let (tx, rx) = oneshot::channel();
        let mut frames_rx = self.state.events_tx.subscribe();
        test_hooks::on_drain_settled(self.workspace.root(), move || {
            let _ = tx.send(frames(&mut frames_rx));
        });
        rx
    }

    fn queued(&self) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        test_hooks::on_pending_changed(self.workspace.root(), move |pending| {
            for change in pending.values_mut() {
                change.last_seen = Instant::now() - Duration::from_secs(10);
            }
            let _ = tx.send(());
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
        let drained = self.drain_frames();
        let settled = self.settled(path);
        let mut event = WatchEvent::file(kind, path, self.workspace.generation());
        event.is_dir = is_dir;
        self.state.index_events_tx.send(event).unwrap();
        let (_, status) = receive(settled).await;
        (receive(drained).await, status)
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
    let drained = fixture.drain_frames();
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
    let published = receive(drained).await;
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
    let drained = fixture.drain_frames();
    let settled = fixture.settled("note.md");
    fixture.changed("image.png");
    fixture.changed("note.md");
    receive(settled).await;
    assert_eq!(
        receive(drained).await,
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
async fn graph_applied_paired_rename_shares_one_completed_drain() {
    let fixture = Fixture::new();
    let mut rx = fixture.state.events_tx.subscribe();
    std::fs::rename(
        fixture.workspace.root().join("note.md"),
        fixture.workspace.root().join("renamed.md"),
    )
    .unwrap();
    let (arrived, held) = oneshot::channel();
    let (release, resumed) = oneshot::channel();
    test_hooks::on_after_apply(
        &fixture.workspace.root().join("renamed.md"),
        (arrived, resumed),
    );
    let (drained, drain) = oneshot::channel();
    let mut final_rx = fixture.state.events_tx.subscribe();
    test_hooks::on_drain_settled(fixture.workspace.root(), move || {
        let _ = drained.send(frames(&mut final_rx));
    });
    let mut event = WatchEvent::file(
        WatchKind::Renamed,
        "note.md",
        fixture.workspace.generation(),
    );
    event.to = Some("renamed.md".into());
    fixture.state.index_events_tx.send(event).unwrap();
    receive(held).await;
    let early = frames(&mut rx);
    release.send(()).unwrap();
    let published = receive(drain).await;
    assert!(
        early.is_empty(),
        "no frame before the tail apply is released: {early:?}"
    );
    assert_eq!(published, expected(&["note.md", "renamed.md"]));
    assert_eq!(
        fixture.workspace.graph().unwrap().files().unwrap(),
        vec!["renamed.md"]
    );
}

#[tokio::test]
async fn graph_applied_lone_renames_in_separate_drains_each_publish() {
    let fixture = Fixture::new();
    std::fs::rename(
        fixture.workspace.root().join("note.md"),
        fixture.workspace.root().join("renamed.md"),
    )
    .unwrap();
    for path in ["note.md", "renamed.md"] {
        let (drained, drain) = oneshot::channel();
        let mut rx = fixture.state.events_tx.subscribe();
        test_hooks::on_drain_settled(fixture.workspace.root(), move || {
            let _ = drained.send(frames(&mut rx));
        });
        fixture
            .state
            .index_events_tx
            .send(WatchEvent::file(
                WatchKind::Renamed,
                path,
                fixture.workspace.generation(),
            ))
            .unwrap();
        assert_eq!(receive(drain).await, expected(&[path]));
    }
    assert_eq!(
        fixture.workspace.graph().unwrap().files().unwrap(),
        vec!["renamed.md"]
    );
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
        let drained = fixture.drain_frames();
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
        receive(drained).await;
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
    test_hooks::on_drain_settled(workspace.root(), move || {
        let _ = settled_tx.send(());
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

#[test]
fn graph_applied_batch_deadline_tracks_the_oldest_unpublished_receipt() {
    let start = Instant::now();
    let mut batch = GraphAppliedBatch::default();
    batch.push(Vec::new(), start);
    assert!(batch.deadline.is_none());
    assert!(batch
        .flush_if_due(start + Duration::from_secs(100))
        .is_empty());
    batch.push(vec!["first.md".into()], start);
    for second in 1..10 {
        let now = start + Duration::from_secs(second);
        batch.push(vec![format!("{second}.md")], now);
        assert_eq!(batch.deadline, Some(start + Duration::from_secs(10)));
        assert!(batch.flush_if_due(now).is_empty());
    }
    let published = batch.flush_if_due(start + Duration::from_secs(10));
    assert_eq!(published.len(), 10);
    assert_eq!(published[0], "first.md");
    assert!(batch.deadline.is_none());
    assert!(batch.take().is_empty());
    let next = start + Duration::from_secs(11);
    batch.push(vec!["next.md".into()], next);
    assert_eq!(batch.deadline, Some(next + Duration::from_secs(10)));
    assert_eq!(batch.take(), vec!["next.md"]);
    assert!(batch.deadline.is_none());
    assert!(batch
        .flush_if_due(next + Duration::from_secs(100))
        .is_empty());
}

#[test]
fn graph_applied_batch_flushes_when_the_clock_passes_its_deadline() {
    let start = Instant::now();
    let mut batch = GraphAppliedBatch::default();
    batch.push(vec!["note.md".into()], start);
    assert_eq!(
        batch.flush_if_due(start + Duration::from_secs(11)),
        vec!["note.md"]
    );
    assert!(batch
        .flush_if_due(start + Duration::from_secs(12))
        .is_empty());
}

impl Fixture {
    fn paired_rename(&self) {
        std::fs::rename(
            self.workspace.root().join("note.md"),
            self.workspace.root().join("renamed.md"),
        )
        .unwrap();
        let mut event =
            WatchEvent::file(WatchKind::Renamed, "note.md", self.workspace.generation());
        event.to = Some("renamed.md".into());
        self.state.index_events_tx.send(event).unwrap();
    }

    fn hold_metadata(&self, path: &str) -> (oneshot::Receiver<()>, std::sync::mpsc::Sender<()>) {
        let (arrived, held) = oneshot::channel();
        let (resume, resumed) = std::sync::mpsc::channel();
        test_hooks::on_after_metadata(&self.workspace.root().join(path), move || {
            let _ = arrived.send(());
            let _ = resumed.recv_timeout(BOUND * 2);
        });
        (held, resume)
    }

    fn two_drains(&self) -> (oneshot::Receiver<Vec<Value>>, oneshot::Receiver<Vec<Value>>) {
        let (first_tx, first) = oneshot::channel();
        let (second_tx, second) = oneshot::channel();
        let root = self.workspace.root().to_path_buf();
        let mut rx = self.state.events_tx.subscribe();
        test_hooks::on_drain_settled(&root.clone(), move || {
            let first_frames = frames(&mut rx);
            test_hooks::on_drain_settled(&root, move || {
                let _ = second_tx.send(frames(&mut rx));
            });
            let _ = first_tx.send(first_frames);
        });
        (first, second)
    }
}

#[tokio::test]
async fn graph_applied_arrival_during_a_drain_belongs_to_the_next_frame() {
    let fixture = Fixture::new();
    fixture.seed("later.md");
    let (held, release) = fixture.hold_metadata("renamed.md");
    let (first, second) = fixture.two_drains();
    fixture.paired_rename();
    receive(held).await;
    let queued = fixture.queued();
    fixture.changed("later.md");
    receive(queued).await;
    release.send(()).unwrap();
    assert_eq!(receive(first).await, expected(&["note.md", "renamed.md"]));
    assert_eq!(receive(second).await, expected(&["later.md"]));
}

#[tokio::test]
async fn graph_applied_retains_every_path_when_a_later_apply_fails() {
    use chan_workspace::workspace::journal_test_hooks::{fail_next, Operation};
    let fixture = Fixture::new();
    let _fault = fail_next(
        &fixture.workspace,
        "renamed.md",
        Operation::Index,
        std::io::ErrorKind::PermissionDenied,
    );
    let status = fixture.settled("renamed.md");
    let drained = fixture.drain_frames();
    fixture.paired_rename();
    let (_, status) = receive(status).await;
    assert!(matches!(status, IndexStatus::Error { .. }), "{status:?}");
    assert_eq!(receive(drained).await, expected(&["note.md", "renamed.md"]));
}

#[tokio::test]
async fn graph_applied_overlapping_subtree_and_file_paths_are_deduplicated() {
    let fixture = Fixture::new();
    fixture.seed("old/a.md");
    fixture.seed("old/b.md");
    let drained = fixture.drain_frames();
    // Construct one due set containing overlapping watcher changes.
    test_hooks::on_pending_changed(fixture.workspace.root(), |pending| {
        let last_seen = pending.get("old").unwrap().last_seen;
        assert!(pending
            .insert(
                "old/a.md".into(),
                PendingChange {
                    path: "old/a.md".into(),
                    deleted: false,
                    is_dir: false,
                    lone_rename: false,
                    last_seen,
                }
            )
            .is_none());
    });
    let mut event = WatchEvent::file(WatchKind::Removed, "old", fixture.workspace.generation());
    event.is_dir = true;
    fixture.state.index_events_tx.send(event).unwrap();
    assert_eq!(receive(drained).await, expected(&["old/a.md", "old/b.md"]));
    assert_eq!(
        fixture.workspace.graph().unwrap().files().unwrap(),
        vec!["note.md", "old/a.md"]
    );
}

#[tokio::test]
async fn graph_applied_isolated_save_publishes_before_its_drain_settles() {
    let fixture = Fixture::new();
    let drained = fixture.drain_frames();
    fixture.changed("note.md");
    assert_eq!(
        receive(drained).await,
        expected(&["note.md"]),
        "an isolated save needs no later tick or event"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn graph_applied_deadline_publishes_while_the_tail_apply_is_blocked() {
    let fixture = Fixture::new();
    let (held, release) = fixture.hold_metadata("renamed.md");
    let mut rx = fixture.state.events_tx.subscribe();
    let drained = fixture.drain_frames();
    fixture.paired_rename();
    receive(held).await;
    let text = tokio::time::timeout(BOUND, rx.recv())
        .await
        .expect("the completed path publishes while the tail is held")
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap(),
        expected(&["note.md"])[0]
    );
    assert!(frames(&mut rx).is_empty());
    release.send(()).unwrap();
    assert_eq!(
        receive(drained).await,
        vec![
            expected(&["note.md"]).remove(0),
            expected(&["renamed.md"]).remove(0)
        ],
        "the final frame contains only paths since the timed flush"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn graph_applied_stream_publishes_its_first_path_before_the_stream_ends() {
    let fixture = Fixture::new();
    fixture.seed("stream.md");
    let (held, release) = fixture.hold_metadata("renamed.md");
    let mut rx = fixture.state.events_tx.subscribe();
    let (first, second) = fixture.two_drains();
    fixture.paired_rename();
    receive(held).await;
    let mut arrivals = 0;
    let published = tokio::time::timeout(BOUND, async {
        loop {
            let queued = fixture.queued();
            fixture.changed("stream.md");
            receive(queued).await;
            arrivals += 1;
            match rx.try_recv() {
                Ok(text) => break serde_json::from_str::<Value>(&text).unwrap(),
                Err(broadcast::error::TryRecvError::Empty) => {}
                Err(error) => panic!("stream frame receiver: {error}"),
            }
        }
    })
    .await
    .expect("a stream cannot postpone a completed path's notification");
    assert!(arrivals > 0);
    assert_eq!(published, expected(&["note.md"])[0]);
    // The producer remains live through the frame; another arrival follows it.
    let queued = fixture.queued();
    fixture.changed("stream.md");
    receive(queued).await;
    release.send(()).unwrap();
    assert_eq!(
        receive(first).await,
        vec![
            expected(&["note.md"]).remove(0),
            expected(&["renamed.md"]).remove(0)
        ]
    );
    assert_eq!(receive(second).await, expected(&["stream.md"]));
}
