//! Cross-process proof of `chan close`: a SEPARATE `chan serve --standalone`
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

// The library compiles its test harness for its own tests alone, so the
// file of it that scrubs a child's environment is mounted here by path.
#[path = "../src/test_env/child_env.rs"]
mod child_env;

/// The built `chan` binary under test (Cargo points this at the target dir).
const CHAN: &str = env!("CARGO_BIN_EXE_chan");

/// A `chan serve` serve writes its lock record during open and force-exits well
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
        use std::os::unix::fs::PermissionsExt;
        let sockdir = tempfile::tempdir().expect("sockdir tempdir");
        std::fs::set_permissions(sockdir.path(), std::fs::Permissions::from_mode(0o700))
            .expect("private socket dir");
        Self {
            chan_home: tempfile::tempdir().expect("chan home tempdir"),
            home: tempfile::tempdir().expect("home tempdir"),
            sockdir,
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
            .envs(child_env::scrubbed_process_env())
            .env("CHAN_HOME", self.chan_home.path())
            .env("HOME", self.home.path())
            .env("TMPDIR", self.sockdir.path())
            .env("XDG_RUNTIME_DIR", self.sockdir.path())
            .env("CHAN_NO_DESKTOP_HANDOFF", "1")
            .env("CHAN_NO_DEVSERVER_HANDOFF", "1");
        cmd
    }
}

/// A spawned `chan serve` serve child + a background-drained stderr transcript (so
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
            .arg("serve")
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
            .expect("spawn chan serve");
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

    // Process A: a real `chan serve` serve holds the workspace's writer flock, writes
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

/// `chan workspace forget` on a registered-but-not-served workspace forgets it
/// from the registry: the teardown is a no-op ("not served"), and --remove
/// still unregisters. (The teardown half of close is already proven above
/// against a live serve; this covers the registry half without a process to
/// tear down.)
#[test]
fn forget_forgets_an_unserved_workspace() {
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

    // workspace forget: nothing is serving (a no-op teardown), but the workspace
    // is still forgotten.
    let out = sandbox
        .command()
        .args(["workspace", "forget"])
        .arg(&ws)
        .output()
        .expect("run chan workspace forget");
    assert!(
        out.status.success(),
        "chan workspace forget failed: status={:?}\nstdout={}\nstderr={}",
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

/// The words a host answers a removal with while an earlier call of its own
/// on the same root has not let go.
const STILL_RELEASING: &str = "workspace is still releasing; retry";

/// Stand in for a host that holds `ws`: take its writer lock, which records
/// this process as the holder, and serve one request on a control socket named
/// for this pid. The host answers a removal `removing <path>: <words>` after
/// its close has run, so the lock is released before the answer is written.
/// Returns the request it was sent, or `None` when none arrived in time.
fn holder_answering_a_removal(
    sandbox: &Sandbox,
    ws: &Path,
    words: &'static str,
) -> std::thread::JoinHandle<Option<chan_shell::ControlRequest>> {
    let lock_dir = chan_workspace::Library::open_at(sandbox.chan_home.path().join("config.toml"))
        .expect("open the sandbox registry")
        .workspace_paths_for(ws)
        .expect("the workspace is registered")
        .lock;
    holder_answering_a_removal_at(sandbox, ws, &lock_dir, words)
}

fn holder_answering_a_removal_at(
    sandbox: &Sandbox,
    ws: &Path,
    lock_dir: &Path,
    words: &'static str,
) -> std::thread::JoinHandle<Option<chan_shell::ControlRequest>> {
    use std::io::Write;

    let lock = chan_workspace::lock::WorkspaceLock::acquire(lock_dir, ws)
        .expect("hold the workspace's writer lock");
    let socket = sandbox
        .sockdir
        .path()
        .join(format!("chan-control-{}-holder.sock", std::process::id()));
    let listener = std::os::unix::net::UnixListener::bind(&socket).expect("bind the holder socket");
    listener
        .set_nonblocking(true)
        .expect("poll the holder socket");
    std::thread::spawn(move || {
        let mut accepted = None;
        poll(EXIT_BUDGET, || {
            accepted = listener.accept().ok();
            accepted.is_some()
        });
        let (mut stream, _) = accepted?;
        stream.set_nonblocking(false).ok()?;
        stream.set_read_timeout(Some(EXIT_BUDGET)).ok()?;
        let mut line = String::new();
        std::io::BufReader::new(stream.try_clone().ok()?)
            .read_line(&mut line)
            .ok()?;
        let request: chan_shell::ControlRequest = serde_json::from_str(&line).ok()?;
        let chan_shell::ControlRequest::Close { path, .. } = &request else {
            return Some(request);
        };
        drop(lock);
        let answer = chan_shell::ControlResponse::Error {
            message: format!("removing {}: {words}", path.display()),
        };
        let mut reply = serde_json::to_vec(&answer).ok()?;
        reply.push(b'\n');
        stream.write_all(&reply).ok()?;
        Some(request)
    })
}

/// Register two distinct rows, then point the first row's stored root at
/// the second workspace's folder without changing either row.
fn relinked_rows(sandbox: &Sandbox) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    use std::os::unix::fs::symlink;

    let scratch = std::fs::canonicalize(sandbox.scratch.path()).unwrap();
    let saved = scratch.join("saved");
    let other = scratch.join("other");
    std::fs::create_dir(&saved).unwrap();
    std::fs::create_dir(&other).unwrap();
    let lib =
        chan_workspace::Library::open_at(sandbox.chan_home.path().join("config.toml")).unwrap();
    let saved_row = lib.register_workspace(&saved).unwrap();
    let other_row = lib.register_workspace(&other).unwrap();
    let saved_state = lib.workspace_paths_for_row(&saved_row).root;
    let other_state = lib.workspace_paths_for_row(&other_row).root;
    std::fs::write(other_state.join("keep"), b"other workspace state").unwrap();
    std::fs::remove_dir(&saved).unwrap();
    symlink(&other, &saved).unwrap();
    (saved, other, saved_state, other_state)
}

#[test]
fn forget_of_a_relinked_stored_root_leaves_the_other_row_and_its_state() {
    let sandbox = Sandbox::new();
    let (saved, other, saved_state, other_state) = relinked_rows(&sandbox);
    let out = sandbox
        .command()
        .args(["workspace", "forget"])
        .arg(&saved)
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    let rows = chan_workspace::Library::open_at(sandbox.chan_home.path().join("config.toml"))
        .unwrap()
        .list_workspaces();
    assert!(rows.iter().all(|row| row.root_path != saved), "{rows:?}");
    assert!(rows.iter().any(|row| row.root_path == other), "{rows:?}");
    assert!(!saved_state.exists());
    assert_eq!(
        std::fs::read(other_state.join("keep")).unwrap(),
        b"other workspace state"
    );
}

#[test]
fn forget_of_a_relative_stored_root_uses_the_row_under_the_cwd() {
    let sandbox = Sandbox::new();
    let (saved, other, _saved_state, other_state) = relinked_rows(&sandbox);
    let out = sandbox
        .command()
        .current_dir(sandbox.scratch.path())
        .args(["workspace", "forget", "./saved"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    let rows = chan_workspace::Library::open_at(sandbox.chan_home.path().join("config.toml"))
        .unwrap()
        .list_workspaces();
    assert!(rows.iter().all(|row| row.root_path != saved), "{rows:?}");
    assert!(rows.iter().any(|row| row.root_path == other), "{rows:?}");
    assert_eq!(
        std::fs::read(other_state.join("keep")).unwrap(),
        b"other workspace state"
    );
}

#[test]
fn forget_of_a_relinked_stored_root_asks_its_holder_by_that_name() {
    let sandbox = Sandbox::new();
    let (saved, other, saved_state, other_state) = relinked_rows(&sandbox);
    let holder =
        holder_answering_a_removal_at(&sandbox, &saved, &saved_state.join("locks"), "other error");
    let out = sandbox
        .command()
        .args(["workspace", "forget"])
        .arg(&saved)
        .output()
        .unwrap();
    let request = holder.join().unwrap();
    assert!(
        matches!(&request, Some(chan_shell::ControlRequest::Close { path, remove: true }) if path == &saved),
        "{request:?}"
    );
    assert!(out.status.success(), "{out:?}");
    let rows = chan_workspace::Library::open_at(sandbox.chan_home.path().join("config.toml"))
        .unwrap()
        .list_workspaces();
    assert!(rows.iter().all(|row| row.root_path != saved));
    assert!(rows.iter().any(|row| row.root_path == other));
    assert_eq!(
        std::fs::read(other_state.join("keep")).unwrap(),
        b"other workspace state"
    );
}

#[test]
fn forget_of_an_unregistered_alias_keeps_the_resolved_lookup() {
    use std::os::unix::fs::symlink;

    let sandbox = Sandbox::new();
    let (saved, other, saved_state, _other_state) = relinked_rows(&sandbox);
    let alias = saved.parent().unwrap().join("alias");
    symlink(&other, &alias).unwrap();
    let out = sandbox
        .command()
        .args(["workspace", "forget"])
        .arg(&alias)
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    let rows = chan_workspace::Library::open_at(sandbox.chan_home.path().join("config.toml"))
        .unwrap()
        .list_workspaces();
    assert!(rows.iter().any(|row| row.root_path == saved), "{rows:?}");
    assert!(rows.iter().all(|row| row.root_path != other), "{rows:?}");
    assert!(saved_state.exists());
}

struct DotdotRows {
    stored: PathBuf,
    resolved: PathBuf,
    typed: PathBuf,
    stored_state: PathBuf,
}

fn dotdot_rows(sandbox: &Sandbox, register_resolved: bool) -> DotdotRows {
    use std::os::unix::fs::symlink;

    let scratch = std::fs::canonicalize(sandbox.scratch.path()).unwrap();
    let stored = scratch.join("a/b");
    let resolved = scratch.join("t/b");
    let target = scratch.join("t/sub");
    std::fs::create_dir_all(&stored).unwrap();
    std::fs::create_dir_all(&resolved).unwrap();
    std::fs::create_dir_all(&target).unwrap();
    let lib =
        chan_workspace::Library::open_at(sandbox.chan_home.path().join("config.toml")).unwrap();
    let stored_row = lib.register_workspace(&stored).unwrap();
    if register_resolved {
        lib.register_workspace(&resolved).unwrap();
    }
    let stored_state = lib.workspace_paths_for_row(&stored_row).root;
    std::fs::write(stored_state.join("keep"), b"stored workspace state").unwrap();
    symlink(&target, scratch.join("a/link")).unwrap();
    let typed = scratch.join("a/link/../b");
    DotdotRows {
        stored,
        resolved,
        typed,
        stored_state,
    }
}

#[test]
fn forget_behind_symlinked_parent_uses_the_resolved_row() {
    let sandbox = Sandbox::new();
    let roots = dotdot_rows(&sandbox, true);
    let out = sandbox
        .command()
        .args(["workspace", "forget"])
        .arg(&roots.typed)
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    let rows = chan_workspace::Library::open_at(sandbox.chan_home.path().join("config.toml"))
        .unwrap()
        .list_workspaces();
    assert!(
        rows.iter().any(|row| row.root_path == roots.stored),
        "{rows:?}"
    );
    assert!(
        rows.iter().all(|row| row.root_path != roots.resolved),
        "{rows:?}"
    );
    assert_eq!(
        std::fs::read(roots.stored_state.join("keep")).unwrap(),
        b"stored workspace state"
    );
}

#[test]
fn forget_behind_symlinked_parent_without_a_resolved_row_keeps_the_stored_row() {
    let sandbox = Sandbox::new();
    let roots = dotdot_rows(&sandbox, false);
    let out = sandbox
        .command()
        .args(["workspace", "forget"])
        .arg(&roots.typed)
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("(not registered:"),
        "{out:?}"
    );
    let rows = chan_workspace::Library::open_at(sandbox.chan_home.path().join("config.toml"))
        .unwrap()
        .list_workspaces();
    assert!(
        rows.iter().any(|row| row.root_path == roots.stored),
        "{rows:?}"
    );
    assert!(roots.stored_state.join("keep").exists());
}

#[test]
fn forget_relative_to_a_symlinked_parent_uses_the_resolved_row() {
    let sandbox = Sandbox::new();
    let roots = dotdot_rows(&sandbox, true);
    let out = sandbox
        .command()
        .current_dir(roots.stored.parent().unwrap())
        .args(["workspace", "forget", "link/../b"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    let rows = chan_workspace::Library::open_at(sandbox.chan_home.path().join("config.toml"))
        .unwrap()
        .list_workspaces();
    assert!(
        rows.iter().any(|row| row.root_path == roots.stored),
        "{rows:?}"
    );
    assert!(
        rows.iter().all(|row| row.root_path != roots.resolved),
        "{rows:?}"
    );
    assert!(roots.stored_state.join("keep").exists());
}

#[test]
fn forget_behind_symlinked_parent_asks_the_resolved_holder() {
    let sandbox = Sandbox::new();
    let roots = dotdot_rows(&sandbox, true);
    let holder = holder_answering_a_removal(&sandbox, &roots.resolved, "other error");
    let out = sandbox
        .command()
        .args(["workspace", "forget"])
        .arg(&roots.typed)
        .output()
        .unwrap();
    let request = holder.join().unwrap();
    assert!(
        matches!(&request, Some(chan_shell::ControlRequest::Close { path, remove: true }) if path == &roots.resolved),
        "{request:?}"
    );
    assert!(out.status.success(), "{out:?}");
    let rows = chan_workspace::Library::open_at(sandbox.chan_home.path().join("config.toml"))
        .unwrap()
        .list_workspaces();
    assert!(
        rows.iter().any(|row| row.root_path == roots.stored),
        "{rows:?}"
    );
    assert!(
        rows.iter().all(|row| row.root_path != roots.resolved),
        "{rows:?}"
    );
}

#[test]
fn forget_over_a_missing_component_keeps_the_stored_row() {
    let sandbox = Sandbox::new();
    let roots = dotdot_rows(&sandbox, false);
    let typed = roots.stored.parent().unwrap().join("missing/../b");
    let out = sandbox
        .command()
        .args(["workspace", "forget"])
        .arg(&typed)
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("(not registered:"),
        "{out:?}"
    );
    let rows = chan_workspace::Library::open_at(sandbox.chan_home.path().join("config.toml"))
        .unwrap()
        .list_workspaces();
    assert!(
        rows.iter().any(|row| row.root_path == roots.stored),
        "{rows:?}"
    );
    assert!(roots.stored_state.join("keep").exists());
}

#[test]
fn forget_over_a_plain_directory_names_the_stored_row() {
    let sandbox = Sandbox::new();
    let roots = dotdot_rows(&sandbox, false);
    let plain = roots.stored.parent().unwrap().join("plain");
    std::fs::create_dir(&plain).unwrap();
    let typed = plain.join("../b");
    let out = sandbox
        .command()
        .args(["workspace", "forget"])
        .arg(&typed)
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    let rows = chan_workspace::Library::open_at(sandbox.chan_home.path().join("config.toml"))
        .unwrap()
        .list_workspaces();
    assert!(
        rows.iter().all(|row| row.root_path != roots.stored),
        "{rows:?}"
    );
    assert!(!roots.stored_state.exists());
}

#[test]
fn close_of_a_relinked_stored_root_keeps_its_resolved_request_name() {
    let sandbox = Sandbox::new();
    let (saved, other, _saved_state, other_state) = relinked_rows(&sandbox);
    let holder =
        holder_answering_a_removal_at(&sandbox, &other, &other_state.join("locks"), "other error");
    let out = sandbox.command().arg("close").arg(&saved).output().unwrap();
    let request = holder.join().unwrap();
    assert!(
        matches!(&request, Some(chan_shell::ControlRequest::Close { path, remove: false }) if path == &other),
        "{request:?}"
    );
    assert!(out.status.success(), "{out:?}");
    let rows = chan_workspace::Library::open_at(sandbox.chan_home.path().join("config.toml"))
        .unwrap()
        .list_workspaces();
    assert!(rows.iter().any(|row| row.root_path == saved));
    assert!(rows.iter().any(|row| row.root_path == other));
}

/// `chan workspace forget` whose host answers that the workspace is still
/// releasing: the host has forgotten nothing, so the command prints the
/// host's words, exits 75 and leaves the registry as the host holds it.
#[test]
fn forget_answered_still_releasing_keeps_the_workspace_registered() {
    let sandbox = Sandbox::new();
    let ws = sandbox.workspace();
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

    let holder = holder_answering_a_removal(&sandbox, &ws, STILL_RELEASING);
    let out = sandbox
        .command()
        .args(["workspace", "forget"])
        .arg(&ws)
        .output()
        .expect("run chan workspace forget");
    let request = holder.join().expect("the holder thread");
    let Some(chan_shell::ControlRequest::Close { path, remove: true }) = request else {
        panic!("the holder was not asked to remove the workspace: {request:?}");
    };
    let answer = format!("removing {}: {STILL_RELEASING}", path.display());

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let still_registered =
        chan_workspace::Library::open_at(sandbox.chan_home.path().join("config.toml"))
            .expect("reopen the sandbox registry")
            .workspace_paths_for(&ws)
            .is_some();
    assert_eq!(
        (
            stderr.contains(&answer),
            out.status.code(),
            still_registered,
        ),
        (true, Some(75), true),
        "(printed the host's words, exit code, still registered)\nstdout={stdout}\nstderr={stderr}"
    );
}
