//! Nonowning access to the standalone lane and acknowledgments around its stop.
//! The task-local hook applies only to the scoped `serve` future; concurrent
//! servers and the production build have no hook.

use std::cell::RefCell;
use std::net::SocketAddr;
use std::sync::{mpsc, Arc};
use std::time::Duration;

use crate::bulk_transfer::BulkTransferTenant;

pub(crate) const WATCHDOG: Duration = Duration::from_secs(60);
pub(crate) const OBSERVATION: Duration = Duration::from_secs(15);

pub(crate) struct Ready {
    pub tenant: BulkTransferTenant,
    pub shutdown: Arc<tokio::sync::watch::Sender<bool>>,
    pub addr: SocketAddr,
}

pub(crate) struct Hooks {
    pub ready: mpsc::Sender<Ready>,
    pub teardown: mpsc::Sender<()>,
    pub released: RefCell<Option<mpsc::Sender<std::thread::ThreadId>>>,
}

tokio::task_local! {
    pub(crate) static HOOKS: Hooks;
}

pub(crate) fn ready(artifacts: &crate::AppArtifacts, addr: SocketAddr) {
    let _ = HOOKS.try_with(|hooks| {
        hooks
            .ready
            .send(Ready {
                tenant: artifacts.bulk_transfer.tenant(),
                shutdown: artifacts.shutdown_tx.clone(),
                addr,
            })
            .expect("standalone observer");
    });
}

pub(crate) fn teardown() {
    let _ = HOOKS.try_with(|hooks| {
        hooks.teardown.send(()).expect("standalone observer");
    });
}

pub(crate) fn take_release_observer() -> Option<mpsc::Sender<std::thread::ThreadId>> {
    HOOKS
        .try_with(|hooks| hooks.released.borrow_mut().take())
        .ok()
        .flatten()
}

/// Run the case in a disposable process, so an inline destructor cannot stop
/// the watchdog's clock or leave a held thread in the rest of the suite.
/// Returns false inside that child and true after a successful parent run.
pub(crate) fn isolated(suffix: &str) -> bool {
    use tokio::io::AsyncReadExt;

    const CHILD: &str = "CHAN_TEST_HOST_RELEASE_CHILD";
    if std::env::var(CHILD).as_deref() == Ok(suffix) {
        return false;
    }
    // The selector can name a sibling; libtest names the caller independently.
    let caller = std::thread::current()
        .name()
        .expect("libtest caller name")
        .to_owned();
    let home = tempfile::tempdir().expect("isolated home");
    let runtime_dir = tempfile::tempdir().expect("isolated sockets");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("watchdog runtime");
    runtime.block_on(async {
        let name = format!("devserver::tests::files_watch_shutdown::{suffix}");
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &name, "--nocapture", "--test-threads=2"])
            .env(CHILD, suffix)
            .env("CHAN_HOME", home.path())
            .env("HOME", home.path())
            .env("XDG_RUNTIME_DIR", runtime_dir.path())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn isolated case");
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let output = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).await.unwrap();
            bytes
        });
        let errors = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stderr.read_to_end(&mut bytes).await.unwrap();
            bytes
        });
        let waited = tokio::time::timeout(WATCHDOG, child.wait()).await;
        let expired = waited.is_err();
        let status = match waited {
            Ok(status) => status.expect("wait for isolated case"),
            Err(_) => {
                child.kill().await.expect("kill overdue isolated case");
                child.wait().await.expect("reap overdue isolated case")
            }
        };
        let output = output.await.unwrap();
        eprint!(
            "{}{}",
            String::from_utf8_lossy(&output),
            String::from_utf8_lossy(&errors.await.unwrap())
        );
        assert!(
            !expired,
            "fixture exceeded its sixty-second external watchdog"
        );
        assert!(status.success(), "isolated case failed: {status}");
        assert!(
            String::from_utf8_lossy(&output).contains("test result: ok. 1 passed"),
            "isolated case ran no test"
        );
        let passed = format!("test {caller} ... ok");
        assert!(
            String::from_utf8_lossy(&output)
                .lines()
                .any(|line| line == passed),
            "isolated case did not run its caller: {caller}"
        );
    });
    true
}
