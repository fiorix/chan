// Every file that appears under a watched root must reach dispatch.
//
// The two ways a backend loses one are a burst (several files created in the
// same directory before the backend reads its queue) and a directory that
// arrives with files already inside it (the directory is announced, its
// contents never were). Both are indistinguishable from "nothing happened" to
// the consumer: the index simply does not know the files exist, and nothing
// asks it to look again until a full reconcile.
//
// inotify and FSEvents report both cases natively. FreeBSD's kqueue backend
// does not, which is what these tests were written against; they are not gated
// to it, because the contract they state is the same on every platform.

use chan_workspace::{Library, WatchCallback, WatchEvent, WatchKind};
use std::collections::BTreeSet;
use std::fs;
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tempfile::TempDir;

/// Generous: these assert that an event arrives at all, never how quickly, and
/// a loaded machine should not turn a completeness test into a latency test.
const BUDGET: Duration = Duration::from_secs(20);

struct EventChannel(mpsc::Sender<WatchEvent>);

impl WatchCallback for EventChannel {
    fn on_event(&self, event: WatchEvent) {
        let _ = self.0.send(event);
    }
}

/// Drain events until every wanted path has been seen created, or the budget
/// expires. Returns what was still missing, so a failure names it.
fn missing_creates(
    rx: &mpsc::Receiver<WatchEvent>,
    wanted: &[String],
    budget: Duration,
) -> BTreeSet<String> {
    let deadline = Instant::now() + budget;
    let mut outstanding: BTreeSet<String> = wanted.iter().cloned().collect();
    while !outstanding.is_empty() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match rx.recv_timeout(remaining) {
            Ok(event) if event.kind == WatchKind::Created => {
                if let Some(path) = event.path.as_deref() {
                    outstanding.remove(path);
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    outstanding
}

fn watched_workspace(cfg: &TempDir, root: &std::path::Path) -> Arc<chan_workspace::Workspace> {
    let library = Library::open_at(cfg.path().join("config.toml")).unwrap();
    library.register_workspace(root).unwrap();
    library.open_workspace(root).unwrap()
}

#[test]
fn every_file_in_a_creation_burst_reaches_dispatch() {
    let cfg = TempDir::new().unwrap();
    let root_dir = TempDir::new().unwrap();
    let root = root_dir.path();
    // The directory exists before the watch starts, so this exercises the
    // burst alone and not the new-directory case below.
    fs::create_dir_all(root.join("notes")).unwrap();
    fs::write(root.join("notes/seed.md"), "# seed\n").unwrap();

    let workspace = watched_workspace(&cfg, root);
    let (tx, rx) = mpsc::channel();
    let _watch = workspace.watch(Arc::new(EventChannel(tx))).unwrap();

    let names = ["burst-a.md", "burst-b.md", "burst-c.md", "burst-d.md"];
    for name in names {
        fs::write(root.join("notes").join(name), "# burst\n").unwrap();
    }

    let wanted: Vec<String> = names.iter().map(|name| format!("notes/{name}")).collect();
    let missing = missing_creates(&rx, &wanted, BUDGET);
    assert!(
        missing.is_empty(),
        "files created in one burst never reached dispatch: {missing:?}"
    );
}

#[test]
fn a_directory_that_arrives_with_files_announces_all_of_them() {
    let cfg = TempDir::new().unwrap();
    let root_dir = TempDir::new().unwrap();
    let root = root_dir.path();
    fs::write(root.join("seed.md"), "# seed\n").unwrap();

    let workspace = watched_workspace(&cfg, root);
    let (tx, rx) = mpsc::channel();
    let _watch = workspace.watch(Arc::new(EventChannel(tx))).unwrap();

    // A tree that appears whole, the shape a checkout or an unpack leaves.
    fs::create_dir_all(root.join("imported/nested")).unwrap();
    fs::write(root.join("imported/top.md"), "# top\n").unwrap();
    fs::write(root.join("imported/nested/deep.md"), "# deep\n").unwrap();

    let wanted = vec![
        "imported/top.md".to_string(),
        "imported/nested/deep.md".to_string(),
    ];
    let missing = missing_creates(&rx, &wanted, BUDGET);
    assert!(
        missing.is_empty(),
        "files inside a newly created directory never reached dispatch: {missing:?}"
    );
}
