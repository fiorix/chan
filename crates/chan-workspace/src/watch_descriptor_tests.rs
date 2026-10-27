// A watcher must leave the process able to serve whatever tree it watches.
//
// The devserver's HTTP listener, its terminals and its workspace I/O share one
// descriptor table with the watcher. A backend that spends a descriptor per
// watched path (kqueue) can fill that table on a large tree, and a listener
// that cannot `accept` is a devserver that stops answering. Each test runs in
// a child process with a lowered soft `RLIMIT_NOFILE`, so the limit belongs to
// that test alone, and watches a tree wider than the limit.
//
// The contract is the same on every platform, so these run everywhere unix
// has an rlimit; only FreeBSD's kqueue backend pays per path, which is where
// the budget assertions bite.

use super::*;
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{channel, Receiver};
use tempfile::TempDir;

const CHILD: &str = "CHAN_TEST_WATCH_DESCRIPTOR_CHILD";

/// The child's soft descriptor limit. Small enough that each fixture tree is
/// wider than it, large enough for the test harness and the listener.
const LIMIT: u64 = 256;

/// Descriptors that must stay free with the watcher running: the room a
/// listener, a terminal and a workspace read need.
const RESERVE: u64 = LIMIT / 4;

struct Channel(std::sync::Mutex<std::sync::mpsc::Sender<WatchEvent>>);

impl WatchCallback for Channel {
    fn on_event(&self, event: WatchEvent) {
        let _ = self.0.lock().unwrap().send(event);
    }
}

/// In the parent, run `test` alone in a child process and assert it passed,
/// returning true. In the child, return false so the caller runs the body.
fn delegated_to_child(test: &str) -> bool {
    if std::env::var_os(CHILD).is_some() {
        return false;
    }
    let _gate = crate::test_gate::fs_timing_gate();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            test,
            "--nocapture",
            "--test-threads=1",
            "--color=never",
        ])
        .env(CHILD, "1")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "descriptor child failed:\n{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        stdout.contains("test result: ok. 1 passed;"),
        "descriptor child did not run exactly one test:\n{stdout}"
    );
    true
}

fn lower_soft_limit(limit: u64) {
    let mut current = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `current` is a writable rlimit that outlives the call.
    assert_eq!(
        unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut current) },
        0
    );
    current.rlim_cur = (limit as libc::rlim_t).min(current.rlim_max);
    // SAFETY: the child owns its limit for the rest of its life; the hard
    // limit is unchanged.
    assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &current) }, 0);
}

fn policy_source(root: &Path) -> ScopePolicySource {
    Arc::new(std::sync::RwLock::new(Arc::new(
        IndexScopePolicy::new(
            root.to_path_buf(),
            crate::WorkspaceGeneration::INITIAL,
            crate::WalkFilter::new(crate::registry::DEFAULT_INDEX_EXCLUDED_DIRS.iter().copied()),
        )
        .unwrap(),
    )))
}

fn start(root: &Path) -> (WatchHandle, Receiver<WatchEvent>) {
    let (tx, rx) = channel();
    let handle = WatchHandle::start(
        &[WatchRoot::workspace(root)],
        policy_source(root),
        Arc::new(Channel(std::sync::Mutex::new(tx))),
    )
    .expect("watcher starts");
    (handle, rx)
}

fn open_descriptors() -> u64 {
    crate::fd_budget::snapshot()
        .expect("descriptor probe available on this platform")
        .open
}

/// A connection reaches the listener and is accepted. Both ends need a
/// descriptor, which is exactly what a full table refuses.
fn assert_accepts(listener: &TcpListener) {
    let client = TcpStream::connect(listener.local_addr().unwrap())
        .expect("a client socket can be opened beside the watcher");
    let (server, _) = listener
        .accept()
        .expect("the listener accepts beside the watcher");
    drop((client, server));
}

fn write_tree(root: &Path, dirs: &str, dir_count: usize, files_per_dir: usize) {
    for d in 0..dir_count {
        let dir = root.join(format!("{dirs}/d{d}"));
        std::fs::create_dir_all(&dir).unwrap();
        for f in 0..files_per_dir {
            std::fs::write(dir.join(format!("f{f}.md")), "x\n").unwrap();
        }
    }
}

/// Accepted content wider than the limit beside an excluded build tree with
/// more directories than the limit can spare. The watcher stays healthy, the
/// table keeps its reserve, the listener accepts, and the tree is still
/// watched. Spending descriptors on the excluded `target/` subtree, or one
/// per accepted file without a budget, breaks the reserve.
#[test]
fn a_tree_wider_than_the_descriptor_limit_leaves_the_listener_accepting() {
    if delegated_to_child(
        "watch::descriptor_tests::a_tree_wider_than_the_descriptor_limit_leaves_the_listener_accepting",
    ) {
        return;
    }
    let tmp = TempDir::new().unwrap();
    // Canonical, so FSEvents (which reports `/private/var/...`) relativizes.
    let root = tmp.path().canonicalize().unwrap();
    write_tree(&root, "src", 6, 100);
    write_tree(&root, "target", 200, 1);

    lower_soft_limit(LIMIT);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let (handle, rx) = start(&root);
    // `start` returns after the first registration; wait out a few retry
    // periods so a backend that retries into a leak has the chance to.
    std::thread::sleep(Duration::from_millis(1500));

    let open = open_descriptors();
    assert!(
        open + RESERVE <= LIMIT,
        "the watcher left {} of {LIMIT} descriptors free, under the {RESERVE} reserve",
        LIMIT.saturating_sub(open)
    );
    assert_accepts(&listener);
    let health = handle.health();
    assert_eq!(health.state, WatchHealthState::Healthy, "{health:?}");

    // Still watching: a new file in accepted content is reported.
    std::fs::write(root.join("src/d5/new.md"), "x\n").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut seen = false;
    while !seen && Instant::now() < deadline {
        if let Ok(event) = rx.recv_timeout(Duration::from_millis(100)) {
            seen =
                event.kind == WatchKind::Created && event.path.as_deref() == Some("src/d5/new.md");
        }
    }
    assert!(seen, "a file created in accepted content must be reported");
    handle.stop();
}

/// A tree whose accepted directories alone exceed what the table can spare.
/// Whatever the backend cannot hold it must release, not keep half-registered,
/// and retrying must not grow the count. The listener keeps accepting.
#[test]
fn a_tree_that_cannot_fit_releases_its_descriptors_and_does_not_grow() {
    if delegated_to_child(
        "watch::descriptor_tests::a_tree_that_cannot_fit_releases_its_descriptors_and_does_not_grow",
    ) {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    write_tree(&root, "wide", 300, 1);

    lower_soft_limit(LIMIT);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let baseline = open_descriptors();
    let (handle, rx) = start(&root);
    std::thread::sleep(Duration::from_millis(1500));

    let settled = open_descriptors();
    assert_accepts(&listener);
    // Several retry periods later the count has not moved.
    std::thread::sleep(Duration::from_secs(2));
    let later = open_descriptors();
    assert!(
        later <= settled + 2,
        "retries grew the descriptor count: {settled} -> {later}"
    );
    // A backend that keeps nothing per directory is trivially within this; a
    // backend that pays per directory must have released what it opened.
    assert!(
        settled <= baseline + 8,
        "a registration that could not complete kept descriptors: {baseline} -> {settled}"
    );
    assert_accepts(&listener);

    #[cfg(target_os = "freebsd")]
    {
        let health = handle.health();
        assert_eq!(health.state, WatchHealthState::Degraded, "{health:?}");
        let reported = rx
            .try_iter()
            .any(|event| event.kind == WatchKind::ProviderError);
        assert!(reported, "a tree the watcher cannot hold is reported");
    }
    #[cfg(not(target_os = "freebsd"))]
    drop(rx);
    handle.stop();
}
