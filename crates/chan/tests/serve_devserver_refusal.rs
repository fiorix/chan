//! A real CLI child receives a devserver registration refusal over the local
//! discovery socket while another process holds the workspace writer lock.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chan_server::devserver_handoff::{start_listener, Request, Response, CHAN_VERSION};
use tempfile::TempDir;
use tokio::process::Command;

#[path = "../src/test_env/child_env.rs"]
mod child_env;

const CHAN: &str = env!("CARGO_BIN_EXE_chan");
const OPEN_ELSEWHERE: &str =
    "This workspace is open in another chan process. Quit it and try again.";
const OLDER_LOCK_TEXT: &str = "chan-workspace: workspace is locked by another process";

struct Sandbox {
    chan_home: TempDir,
    home: TempDir,
    runtime: TempDir,
    scratch: TempDir,
}

impl Sandbox {
    fn new() -> Self {
        use std::os::unix::fs::PermissionsExt;

        let runtime = tempfile::tempdir().expect("runtime directory");
        std::fs::set_permissions(runtime.path(), std::fs::Permissions::from_mode(0o700))
            .expect("private runtime directory");
        Self {
            chan_home: tempfile::tempdir().expect("chan home"),
            home: tempfile::tempdir().expect("home"),
            runtime,
            scratch: tempfile::tempdir().expect("scratch directory"),
        }
    }

    fn workspace(&self) -> PathBuf {
        let root = self.scratch.path().join("ws");
        std::fs::create_dir(&root).expect("workspace directory");
        root
    }

    fn command(&self, root: &Path) -> Command {
        let mut command = Command::new(CHAN);
        command
            .env_clear()
            .envs(child_env::scrubbed_process_env())
            .env("CHAN_HOME", self.chan_home.path())
            .env("HOME", self.home.path())
            .env("TMPDIR", self.runtime.path())
            .env("XDG_RUNTIME_DIR", self.runtime.path())
            .env("CHAN_NO_DESKTOP_HANDOFF", "1")
            .env("RUST_LOG", "off")
            .env("RUST_LIB_BACKTRACE", "0")
            .arg("serve")
            .arg(root)
            .args(["--here", "--port", "0", "--timeout", "1s", "--no-browser"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command
    }
}

async fn run_refusal(other_library: bool, answer: &'static str) -> (i32, String, String) {
    use std::os::unix::fs::PermissionsExt;

    let sandbox = Sandbox::new();
    let root = sandbox.workspace();
    let library = chan_workspace::Library::open_at(sandbox.chan_home.path().join("config.toml"))
        .expect("sandbox library");
    library
        .register_workspace(&root)
        .expect("register workspace");
    let lock_dir = library
        .workspace_paths_for(&root)
        .expect("workspace paths")
        .lock;
    std::fs::create_dir_all(&lock_dir).expect("lock directory");
    let _holder = chan_workspace::lock::WorkspaceLock::acquire(&lock_dir, &root)
        .expect("hold workspace writer lock");

    let discovery = sandbox.runtime.path().join("chan-devserver");
    std::fs::create_dir(&discovery).expect("discovery directory");
    std::fs::set_permissions(&discovery, std::fs::Permissions::from_mode(0o700))
        .expect("private discovery directory");
    let socket = discovery.join("0123456789abcdef.sock");
    let library_root = if other_library {
        sandbox.scratch.path().join("another-library")
    } else {
        sandbox.chan_home.path().to_path_buf()
    };
    let registrations = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&registrations);
    let _listener = start_listener(socket, move |request| {
        let library_root = library_root.clone();
        let recorded = Arc::clone(&recorded);
        async move {
            match request {
                Request::Identify { .. } => Response::Identified {
                    pid: std::process::id(),
                    library_root,
                    port: 8787,
                    version: CHAN_VERSION.into(),
                },
                Request::RegisterWorkspace { workspace_path, .. } => {
                    recorded.lock().expect("registrations").push(workspace_path);
                    Response::Error {
                        message: answer.into(),
                    }
                }
            }
        }
    })
    .expect("start discovery listener");

    let child = sandbox.command(&root).spawn().expect("spawn chan serve");
    let output = tokio::time::timeout(Duration::from_secs(15), child.wait_with_output())
        .await
        .expect("chan serve exited within the bound")
        .expect("wait for chan serve");
    let stderr = String::from_utf8(output.stderr).expect("stderr UTF-8");
    let stdout = String::from_utf8(output.stdout).expect("stdout UTF-8");
    let recorded = registrations.lock().expect("registrations").clone();
    assert_one_registration(&recorded, &root);
    (output.status.code().unwrap_or(-1), stdout, stderr)
}

fn assert_one_registration(registrations: &[String], root: &Path) {
    assert_eq!(registrations.len(), 1, "one registration was not sent");
    assert_eq!(
        Path::new(&registrations[0])
            .canonicalize()
            .expect("registered path"),
        root.canonicalize().expect("workspace path"),
        "the registration named another workspace"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_devserver_refusal_over_another_process_lock_ends_the_serve() {
    let (status, stdout, stderr) = run_refusal(false, OPEN_ELSEWHERE).await;
    assert_eq!(status, 1, "the serve did not exit 1: {stderr}");
    let final_line = format!("Error: {OPEN_ELSEWHERE}");
    assert_eq!(
        stderr.lines().last(),
        Some(final_line.as_str()),
        "the serve did not end on the devserver's sentence: {stderr}"
    );
    assert!(
        !stderr.contains("chan: the local devserver could not mount this workspace"),
        "the serve did not end on the devserver's sentence: {stderr}"
    );
    assert!(stdout.is_empty(), "the refused serve printed: {stdout}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_devserver_of_another_library_keeps_the_fallback() {
    let (status, stdout, stderr) = run_refusal(true, OPEN_ELSEWHERE).await;
    assert_eq!(status, 1, "the fallback did not exit 1: {stderr}");
    assert!(
        stderr.starts_with(&format!(
            "chan: the local devserver could not mount this workspace ({OPEN_ELSEWHERE}); starting a standalone server.\n"
        )),
        "a devserver of another library did not fall back: {stderr}"
    );
    assert!(
        stderr.contains("Error: the workspace is held by another process"),
        "the standalone open did not meet the held lock: {stderr}"
    );
    assert!(stdout.is_empty(), "the refused serve printed: {stdout}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_devserver_answering_the_older_lock_text_keeps_the_fallback() {
    let (status, stdout, stderr) = run_refusal(false, OLDER_LOCK_TEXT).await;
    assert_eq!(status, 1, "the fallback did not exit 1: {stderr}");
    assert!(
        stderr.starts_with(&format!(
            "chan: the local devserver could not mount this workspace ({OLDER_LOCK_TEXT}); starting a standalone server.\n"
        )),
        "the older lock text did not fall back: {stderr}"
    );
    assert!(
        stderr.contains("Error: the workspace is held by another process"),
        "the standalone open did not meet the held lock: {stderr}"
    );
    assert!(stdout.is_empty(), "the refused serve printed: {stdout}");
}
