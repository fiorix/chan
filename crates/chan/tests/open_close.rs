//! Cross-process proof of `chan close`: a SEPARATE `chan open --standalone`
//! process holds a
//! workspace's writer flock and its per-pid control socket; `chan close
//! <path>` discovers that process from the on-disk `writer.lock` record
//! (`{pid, …}`) -> its control socket
//! (`$XDG_RUNTIME_DIR/chan-control-<pid>-*.sock`),
//! sends the `Close` verb, and the serve process exits + releases the flock.
//!
//! Requirement under test: on a workspace that is being served, calling
//! `close` sends the signal that tears down the serving process.
//!
//! Isolation: a throwaway `CHAN_HOME` redirects the whole chan library
//! (registry, devserver config, lock records), a throwaway `HOME` covers
//! anything that still consults the OS home, and a shared socket dir is set as
//! `XDG_RUNTIME_DIR` on the serve child and the
//! close invocation, with `TMPDIR` matching for older binaries. The per-pid
//! control-socket discovery only resolves when both processes agree on where
//! the socket lives. The child's inherited environment is rebuilt from a
//! scrubbed copy of the parent environment with the complete `CHAN_*`
//! namespace removed, so a test launched from inside a chan terminal inherits
//! neither terminal-session state nor credentials.
//! `CHAN_NO_DESKTOP_HANDOFF` and `CHAN_NO_DEVSERVER_HANDOFF` keep the serve from
//! handing off to a running chan-desktop or devserver. Unix-only: the control
//! socket is a Unix socket and the discovery glob is unix-first (Windows named
//! pipes aren't enumerable here).

#![cfg(unix)]

use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tempfile::TempDir;

/// The built `chan` binary under test (Cargo points this at the target dir).
const CHAN: &str = env!("CARGO_BIN_EXE_chan");

/// A `chan open` serve writes its lock record during open and force-exits well
/// inside this grace window on the close signal. Generous for a loaded CI box.
const READY_BUDGET: Duration = Duration::from_secs(30);
const EXIT_BUDGET: Duration = Duration::from_secs(15);

/// Throwaway `CHAN_HOME` (the whole chan library) + a throwaway `HOME` + a
/// shared socket dir set as `XDG_RUNTIME_DIR` (where the per-pid control
/// socket lives) and `TMPDIR`, so the serve and close processes agree on the
/// control-socket location. Dropping it removes everything.
struct Sandbox {
    chan_home: TempDir,
    home: TempDir,
    sockdir: TempDir,
    scratch: TempDir,
}

impl Sandbox {
    fn new() -> Self {
        Self {
            chan_home: tempfile::tempdir().expect("chan home tempdir"),
            home: tempfile::tempdir().expect("home tempdir"),
            sockdir: tempfile::tempdir().expect("sockdir tempdir"),
            scratch: tempfile::tempdir().expect("scratch tempdir"),
        }
    }

    /// A fresh workspace with one note, under the scratch area.
    fn workspace(&self) -> PathBuf {
        let root = self.scratch.path().join("ws");
        std::fs::create_dir_all(&root).expect("create workspace");
        std::fs::write(root.join("a.md"), b"# note\n").expect("seed note");
        root
    }

    /// A `chan` command preloaded with the sandbox env. The inherited
    /// environment is rebuilt from a scrubbed copy with the complete `CHAN_*`
    /// namespace removed, so a test launched from inside a chan terminal
    /// cannot inherit terminal-session state, handoff hints, or credentials;
    /// only the explicit sandbox values below carry `CHAN_` names.
    fn command(&self) -> Command {
        let mut cmd = Command::new(CHAN);
        cmd.env_clear()
            .envs(chan::test_env::scrubbed_process_env())
            .env("CHAN_HOME", self.chan_home.path())
            .env("HOME", self.home.path())
            .env("TMPDIR", self.sockdir.path())
            .env("XDG_RUNTIME_DIR", self.sockdir.path())
            .env("CHAN_NO_DESKTOP_HANDOFF", "1")
            .env("CHAN_NO_DEVSERVER_HANDOFF", "1");
        cmd
    }
}

/// A spawned `chan open` serve child + a background-drained stderr transcript (so
/// the pipe never fills and wedges the child, and the test can wait for the
/// "ready" marker). Dropping it always kills and reaps the child, so a
/// panicking assertion never strands a server holding the flock.
struct Serve {
    child: Child,
    stderr: Arc<Mutex<Vec<String>>>,
}

impl Serve {
    fn spawn(sandbox: &Sandbox, ws: &Path) -> Self {
        let mut child = sandbox
            .command()
            .arg("open")
            .arg(ws)
            // `--here` serves the path verbatim (sidesteps the enclosing-VCS
            // refusal if the temp dir ever lands inside a working tree);
            // `--standalone` + `--no-token` keep it self-contained and authless.
            .args([
                "--here",
                "--standalone",
                "--no-token",
                "--port",
                "0",
                "--no-browser",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn chan open");
        let stderr = Arc::new(Mutex::new(Vec::new()));
        if let Some(pipe) = child.stderr.take() {
            let sink = stderr.clone();
            std::thread::spawn(move || {
                for line in std::io::BufReader::new(pipe).lines().map_while(Result::ok) {
                    sink.lock().unwrap().push(line);
                }
            });
        }
        Self { child, stderr }
    }

    fn pid(&self) -> u32 {
        self.child.id()
    }

    fn has_exited(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)))
    }

    /// `serve` prints `chan is ready:\n<url>` to stderr only after its control
    /// socket AND HTTP listener are up -- so this is the readiness signal that
    /// guarantees `close` can actually connect to the control socket (the
    /// `writer.lock` record alone is written earlier, during workspace open).
    fn wait_ready(&self, timeout: Duration) -> bool {
        poll(timeout, || {
            self.stderr
                .lock()
                .unwrap()
                .iter()
                .any(|l| l.contains("http://127.0.0.1:"))
        })
    }

    fn stderr_dump(&self) -> String {
        self.stderr.lock().unwrap().join("\n")
    }
}

impl Drop for Serve {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Poll `f` until it returns true or `timeout` elapses.
fn poll(timeout: Duration, mut f: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if f() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The first non-empty `writer.lock` under `CHAN_HOME/workspaces/*/locks/`.
fn writer_lock(chan_home: &Path) -> Option<PathBuf> {
    let dir = chan_home.join("workspaces");
    for entry in std::fs::read_dir(&dir).ok()?.flatten() {
        let lock = entry.path().join("locks/writer.lock");
        if std::fs::metadata(&lock)
            .map(|m| m.len() > 0)
            .unwrap_or(false)
        {
            return Some(lock);
        }
    }
    None
}

/// Whether the live `writer.lock` record names `pid` as the holder.
fn lock_held_by(chan_home: &Path, pid: u32) -> bool {
    writer_lock(chan_home)
        .and_then(|l| std::fs::read_to_string(l).ok())
        .map(|s| s.contains(&format!("\"pid\":{pid}")))
        .unwrap_or(false)
}

#[test]
fn close_tears_down_the_separate_serve_process() {
    let sandbox = Sandbox::new();
    let ws = sandbox.workspace();

    // Process A: a real `chan open` serve holds the workspace's writer flock, writes
    // its `{pid, …}` record (the discovery index), and opens its control socket.
    let mut serve = Serve::spawn(&sandbox, &ws);
    assert!(
        serve.wait_ready(READY_BUDGET),
        "serve never became ready (control socket / HTTP not up):\n{}",
        serve.stderr_dump(),
    );
    assert!(
        lock_held_by(sandbox.chan_home.path(), serve.pid()),
        "serve is ready but its writer.lock record is missing or names another pid"
    );

    // Process B: a SEPARATE `chan close` invocation discovers process A and
    // sends it the teardown verb.
    let out = sandbox
        .command()
        .arg("close")
        .arg(&ws)
        .output()
        .expect("run chan close");
    assert!(
        out.status.success(),
        "chan close failed: status={:?}\nstdout={}\nstderr={}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("closed"),
        "chan close did not report success: {}",
        String::from_utf8_lossy(&out.stdout),
    );

    // Assert the separate serve process exits because
    // `close` reached it over its control socket (Close → shutdown_tx →
    // graceful exit). Not this process; the separate serve we spawned.
    assert!(
        poll(EXIT_BUDGET, || serve.has_exited()),
        "the serve process did not exit after `chan close`: the teardown signal never reached it"
    );

    // Assert 2 -- clean teardown, not a wedge: the writer flock is released, so a
    // FRESH serve acquires it and records ITS pid (a held flock would surface
    // WorkspaceLocked and the new serve would never write its record).
    let fresh = Serve::spawn(&sandbox, &ws);
    assert!(
        poll(READY_BUDGET, || lock_held_by(
            sandbox.chan_home.path(),
            fresh.pid()
        )),
        "a fresh serve never acquired the released flock after close:\n{}",
        fresh.stderr_dump(),
    );
}

/// `chan close --remove` on a registered-but-not-served workspace forgets it
/// from the registry: the teardown is a no-op ("not served"), but --remove
/// still unregisters -- proving the forget runs independent of the close
/// outcome. (The teardown half of close is already proven above against a
/// live serve; this covers the registry half without a process to tear down.)
#[test]
fn close_remove_forgets_an_unserved_workspace() {
    let sandbox = Sandbox::new();
    let ws = sandbox.workspace();

    // Register the workspace WITHOUT serving it.
    let add = sandbox
        .command()
        .args(["workspace", "add"])
        .arg(&ws)
        .output()
        .expect("run chan workspace add");
    assert!(
        add.status.success(),
        "workspace add failed: {}",
        String::from_utf8_lossy(&add.stderr),
    );

    // close --remove: nothing is serving (a no-op teardown), but the workspace
    // is still forgotten.
    let out = sandbox
        .command()
        .arg("close")
        .arg("--remove")
        .arg(&ws)
        .output()
        .expect("run chan close --remove");
    assert!(
        out.status.success(),
        "chan close --remove failed: status={:?}\nstdout={}\nstderr={}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("not served"),
        "expected a not-served note from the teardown half: {stdout}",
    );
    assert!(
        stdout.contains("unregistered"),
        "expected an unregistered note from --remove: {stdout}",
    );

    // The registry is now empty (we only ever added this one).
    let ls = sandbox
        .command()
        .args(["workspace", "ls"])
        .output()
        .expect("run chan workspace ls");
    assert!(
        String::from_utf8_lossy(&ls.stdout).contains("no workspaces registered"),
        "registry not empty after --remove: {}",
        String::from_utf8_lossy(&ls.stdout),
    );
}
