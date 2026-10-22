use super::*;
use chan_workspace::{Library, Workspace};
use serde_json::{json, Value};
use std::time::Duration;
use tempfile::TempDir;
use tokio::time::{timeout_at, Instant};

const BUDGET: Duration = Duration::from_secs(20);
const TARGET: &str = "notes/target.md";
const SENTINEL: &str = "notes/fence.md";

fn fixture() -> (TempDir, TempDir, Arc<Workspace>) {
    let config = TempDir::new().unwrap();
    let root = TempDir::new().unwrap();
    std::fs::create_dir(root.path().join("notes")).unwrap();
    let library = Library::open_at(config.path().join("config.toml")).unwrap();
    library.register_workspace(root.path()).unwrap();
    let workspace = library.open_workspace(root.path()).unwrap();
    (config, root, workspace)
}

async fn real_save(replace: bool) {
    let (_config, root, workspace) = fixture();
    if replace {
        std::fs::write(root.path().join(TARGET), "before").unwrap();
    }
    let (events_tx, mut global) = broadcast::channel(128);
    let (index_tx, mut index) = broadcast::channel(128);
    // The fence owns the test's deadline; note expiry is tested separately.
    let writes = Arc::new(SelfWrites::with_window(BUDGET * 2));
    let scopes = Arc::new(ScopeRegistry::new());
    let (id, mut scoped) = scopes.register();
    scopes.subscribe(id, "notes");
    let bridge = make_watch_bridge(&events_tx, &index_tx, &writes, &scopes, root.path().into());
    let watch = workspace.watch(bridge).unwrap();
    writes.note_from(TARGET, if replace { None } else { Some("w-writer") });
    workspace.write_text(TARGET, "after").unwrap();
    std::fs::write(root.path().join(SENTINEL), "fence").unwrap();

    let deadline = Instant::now() + BUDGET;
    let fence = WatchEvent::file(WatchKind::Created, SENTINEL, workspace.generation());
    let mut index_events = Vec::new();
    loop {
        let event = timeout_at(deadline, index.recv())
            .await
            .expect("index fence deadline")
            .expect("index event");
        if event.path.as_deref() == Some(SENTINEL) {
            assert_eq!(event, fence);
            break;
        }
        index_events.push(event);
    }
    let mut global_frames = Vec::new();
    loop {
        let raw = timeout_at(deadline, global.recv())
            .await
            .expect("global fence deadline")
            .expect("global frame");
        let frame: Value = serde_json::from_str(&raw).unwrap();
        if frame["event"]["path"] == SENTINEL {
            assert_eq!(
                frame,
                json!({"type": "watch", "event": fence, "writable": true})
            );
            break;
        }
        global_frames.push(frame);
    }
    let mut scoped_frames = Vec::new();
    loop {
        let raw = timeout_at(deadline, scoped.recv())
            .await
            .expect("scoped fence deadline")
            .expect("scoped frame");
        let frame: Value = serde_json::from_str(&raw).unwrap();
        if frame["event"]["path"] == SENTINEL {
            assert_eq!(frame, json!({"type": "fs", "dir": "notes", "event": fence}));
            break;
        }
        scoped_frames.push(frame);
    }
    drop(watch);
    let target = WatchEvent::file(
        if replace {
            WatchKind::Modified
        } else {
            WatchKind::Created
        },
        TARGET,
        workspace.generation(),
    );
    let (expected_global, expected_scoped) = if replace {
        (Vec::new(), Vec::new())
    } else {
        (
            vec![
                json!({"type": "watch", "event": target, "writable": true, "source_w": "w-writer"}),
            ],
            vec![json!({"type": "fs", "dir": "notes", "event": target, "source_w": "w-writer"})],
        )
    };
    assert_eq!(
        (index_events, global_frames, scoped_frames),
        (vec![target], expected_global, expected_scoped),
        "complete index and page event lists before the same-directory fence"
    );
}

#[tokio::test]
async fn real_windowless_replacement_indexes_once_without_page_frames() {
    real_save(true).await;
}

#[tokio::test]
async fn real_window_creation_indexes_once_and_attributes_both_page_frames() {
    real_save(false).await;
}
