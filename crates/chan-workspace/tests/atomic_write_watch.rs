#![cfg(target_os = "linux")]

use chan_workspace::{Library, WatchCallback, WatchEvent, WatchKind, Workspace};
use notify::{EventKind, RecursiveMode, Watcher};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tempfile::TempDir;

const BUDGET: Duration = Duration::from_secs(20);
const SENTINEL: &str = "notes/fence.md";

struct Events(mpsc::Sender<WatchEvent>);

impl WatchCallback for Events {
    fn on_event(&self, event: WatchEvent) {
        self.0.send(event).unwrap();
    }
}

fn fixture() -> (TempDir, TempDir, Arc<Workspace>) {
    let config = TempDir::new().unwrap();
    let root = TempDir::new().unwrap();
    std::fs::create_dir(root.path().join("notes")).unwrap();
    let library = Library::open_at(config.path().join("config.toml")).unwrap();
    library.register_workspace(root.path()).unwrap();
    let workspace = library.open_workspace(root.path()).unwrap();
    (config, root, workspace)
}

fn save_events(replace: bool) {
    let (_config, root, workspace) = fixture();
    if replace {
        std::fs::write(root.path().join("notes/target.md"), b"before").unwrap();
    }
    let (tx, rx) = mpsc::channel();
    let watch = workspace.watch(Arc::new(Events(tx))).unwrap();
    workspace.write_text("notes/target.md", "after").unwrap();
    std::fs::write(root.path().join(SENTINEL), b"fence").unwrap();

    let deadline = Instant::now() + BUDGET;
    let mut events = Vec::new();
    loop {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("save fence must reach the owned watcher");
        if event.path.as_deref() == Some(SENTINEL) {
            assert_eq!(
                event,
                WatchEvent::file(WatchKind::Created, SENTINEL, workspace.generation())
            );
            break;
        }
        events.push(event);
    }
    drop(watch);
    assert_eq!(
        events,
        vec![WatchEvent::file(
            if replace {
                WatchKind::Modified
            } else {
                WatchKind::Created
            },
            "notes/target.md",
            workspace.generation(),
        )],
        "the complete save event list before the fence"
    );
}

#[test]
fn atomic_replacement_emits_one_target_modification() {
    save_events(true);
}

#[test]
fn atomic_creation_emits_one_target_creation() {
    save_events(false);
}

#[test]
fn watcher_hides_reserved_orphans_but_observes_ordinary_user_names() {
    let (_config, root, workspace) = fixture();
    std::fs::create_dir(root.path().join("notes/.chan-write-stage")).unwrap();
    std::fs::write(root.path().join("notes/.chan-write-orphan"), b"orphan").unwrap();
    let (tx, rx) = mpsc::channel();
    let watch = workspace.watch(Arc::new(Events(tx))).unwrap();
    std::fs::write(root.path().join("notes/.chan-write-orphan"), b"kept").unwrap();
    std::fs::write(root.path().join("notes/.chan-write-stage/payload"), b"kept").unwrap();
    let ordinary = ["notes/#123", "notes/e7eec6ab-54ca-43fb-9f86-8120361e624a"];
    for path in ordinary {
        std::fs::write(root.path().join(path), b"user file").unwrap();
    }
    std::fs::write(root.path().join(SENTINEL), b"fence").unwrap();
    let deadline = Instant::now() + BUDGET;
    let mut events = Vec::new();
    loop {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("orphan fence must reach the owned watcher");
        if event.path.as_deref() == Some(SENTINEL) {
            assert_eq!(
                event,
                WatchEvent::file(WatchKind::Created, SENTINEL, workspace.generation())
            );
            break;
        }
        events.push(event);
    }
    drop(watch);
    for path in ordinary {
        assert!(
            events.contains(&WatchEvent::file(
                WatchKind::Created,
                path,
                workspace.generation()
            )),
            "ordinary file {path}: {events:?}"
        );
    }
    assert!(
        events.iter().all(|event| event
            .path
            .as_deref()
            .is_some_and(|path| ordinary.contains(&path))
            && event.to.is_none()),
        "only ordinary user files reach the watcher: {events:?}"
    );
    assert_eq!(
        std::fs::read(root.path().join("notes/.chan-write-orphan")).unwrap(),
        b"kept"
    );
    assert_eq!(
        std::fs::read(root.path().join("notes/.chan-write-stage/payload")).unwrap(),
        b"kept"
    );
}

#[test]
fn writability_probe_uses_a_reserved_name_and_removes_it() {
    let (_config, root, workspace) = fixture();
    let (tx, rx) = mpsc::channel();
    let mut watch = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        tx.send(event).unwrap();
    })
    .unwrap();
    watch
        .watch(&root.path().join("notes"), RecursiveMode::NonRecursive)
        .unwrap();
    assert!(workspace
        .ensure_writable("notes/new.md")
        .unwrap()
        .stat
        .is_none());
    std::fs::write(root.path().join(SENTINEL), b"fence").unwrap();
    let deadline = Instant::now() + BUDGET;
    let mut created = Vec::new();
    let mut removed = Vec::new();
    loop {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("probe fence must reach the raw watcher")
            .unwrap();
        if event.paths == [root.path().join(SENTINEL)] && matches!(event.kind, EventKind::Create(_))
        {
            break;
        }
        match event.kind {
            EventKind::Create(_) => created.extend(event.paths),
            EventKind::Remove(_) => removed.extend(event.paths),
            _ => {}
        }
    }
    drop(watch);
    assert_eq!(
        created.len(),
        1,
        "the probe creates one named temporary: {created:?}"
    );
    let name = created[0].file_name().unwrap().to_str().unwrap();
    assert!(
        name.starts_with(".chan-write-"),
        "reserved probe name: {name}"
    );
    assert_eq!(
        removed, created,
        "the probe removes exactly its owned entry"
    );
    let entries: Vec<_> = std::fs::read_dir(root.path().join("notes"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(entries, ["fence.md"]);
}

fn raw_publication_names(publish: impl FnOnce(&std::path::Path)) {
    let root = TempDir::new().unwrap();
    let (tx, rx) = mpsc::channel();
    let mut watch = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        tx.send(event).unwrap();
    })
    .unwrap();
    watch
        .watch(root.path(), RecursiveMode::NonRecursive)
        .unwrap();
    publish(root.path());
    std::fs::write(root.path().join("fence"), b"fence").unwrap();
    let deadline = Instant::now() + BUDGET;
    let mut temporaries = Vec::new();
    let mut published = false;
    loop {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("publication fence must reach the raw watcher")
            .unwrap();
        if event.paths == [root.path().join("fence")] && matches!(event.kind, EventKind::Create(_))
        {
            break;
        }
        for path in event.paths {
            if path == root.path().join("note.md") {
                published = true;
            } else if path != root.path() {
                temporaries.push(path);
            }
        }
    }
    drop(watch);
    assert!(published, "the publication must reach the raw watcher");
    assert!(
        !temporaries.is_empty(),
        "the raw watcher must observe the stage"
    );
    for path in temporaries {
        assert!(
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with(".chan-write-"),
            "reserved publication temporary: {path:?}"
        );
    }
    let mut names: Vec<_> = std::fs::read_dir(root.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    names.sort();
    assert_eq!(names, ["fence", "note.md"]);
}

#[test]
fn ambient_atomic_writer_uses_reserved_names() {
    raw_publication_names(|root| {
        chan_workspace::fs_ops::atomic_write(&root.join("note.md"), b"text").unwrap()
    });
}

#[test]
fn exclusive_writer_stages_under_reserved_names() {
    raw_publication_names(|root| {
        let config = TempDir::new().unwrap();
        let library = Library::open_at(config.path().join("config.toml")).unwrap();
        library.register_workspace(root).unwrap();
        library
            .open_workspace(root)
            .unwrap()
            .create_bytes("note.md", b"text")
            .unwrap();
    });
}
