//! The CLI half of the remote workspace arms against a fake desktop: a real
//! handoff listener bound on a throwaway `XDG_RUNTIME_DIR`, the real `chan`
//! binary spawned against it, and the exact request bytes and rendered
//! replies asserted. The desktop's own wiring (target and workspace
//! resolution, the devserver calls) is covered by its unit tests and the
//! `scripts/e2e/workspace-on-remote.sh` run against a real desktop; this
//! suite pins the CLI grammar, the wire, and every refusal rendering the
//! user can see from a plain shell, without a GUI.
#![cfg(unix)]

use std::path::PathBuf;
use std::process::Stdio;

use chan_server::handoff::{start_listener, Request, Response, CHAN_VERSION};
use tokio::process::Command;

// The library compiles its test harness for its own tests alone, so the
// file of it that scrubs a child's environment is mounted here by path.
#[path = "../src/test_env/child_env.rs"]
mod child_env;

const CHAN: &str = env!("CARGO_BIN_EXE_chan");

struct Sandbox {
    runtime: tempfile::TempDir,
    chan_home: tempfile::TempDir,
    home: tempfile::TempDir,
}

impl Sandbox {
    fn new() -> Self {
        use std::os::unix::fs::PermissionsExt;
        let runtime = tempfile::tempdir().expect("runtime tempdir");
        std::fs::set_permissions(runtime.path(), std::fs::Permissions::from_mode(0o700))
            .expect("private runtime dir");
        Self {
            runtime,
            chan_home: tempfile::tempdir().expect("chan_home tempdir"),
            home: tempfile::tempdir().expect("home tempdir"),
        }
    }

    fn socket(&self) -> PathBuf {
        self.runtime.path().join("chan-desktop.sock")
    }

    /// A `chan` command preloaded with the sandbox env: the inherited
    /// environment is rebuilt from a scrubbed copy with the whole `CHAN_*`
    /// namespace removed, so a test launched from inside a chan terminal
    /// cannot inherit terminal-session state, handoff hints, or credentials.
    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(CHAN);
        cmd.env_clear()
            .envs(child_env::scrubbed_process_env())
            .env("CHAN_HOME", self.chan_home.path())
            .env("HOME", self.home.path())
            .env("XDG_RUNTIME_DIR", self.runtime.path())
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    }

    async fn run(&self, args: &[&str]) -> (i32, String, String) {
        let out = self.command(args).output().await.expect("spawn chan");
        (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        )
    }
}

/// The fake desktop: answers like the real one would for a connected
/// devserver labelled `lab` with one workspace, and refuses `dup` as an
/// ambiguous label the way the desktop's resolver words it.
fn fake_desktop(req: Request) -> Response {
    let v = || CHAN_VERSION.to_string();
    match req {
        Request::ServeRemoteWorkspace {
            target,
            workspace_path,
            ..
        } if target == "lab" && workspace_path == "/srv/notes" => Response::RemoteWorkspaceServed {
            desktop_version: v(),
            prefix: "/notes-1a2b3c".into(),
        },
        Request::CloseRemoteWorkspace {
            target,
            workspace_path,
            ..
        } if target == "lab" && workspace_path == "/srv/notes" => Response::CloseRefused {
            error: "live_terminals".into(),
            active_terminals: 2,
        },
        Request::CloseRemoteWorkspace {
            target,
            workspace_path,
            ..
        } if target == "lab" && workspace_path == "/srv/idle" => Response::RemoteWorkspaceClosed {
            desktop_version: v(),
            was_served: false,
        },
        Request::ForgetRemoteWorkspace { target, .. } if target == "lab" => {
            Response::RemoteWorkspaceForgotten { desktop_version: v() }
        }
        Request::ServeRemoteWorkspace { target, .. }
        | Request::CloseRemoteWorkspace { target, .. }
        | Request::ForgetRemoteWorkspace { target, .. }
            if target == "dup" =>
        {
            Response::Error {
                message: "\"dup\" matches more than one registered devserver:\n  dup  http://a:8787\n  dup  http://b:8787\nName the one you mean by URL, or remove the duplicate row in the launcher.".into(),
            }
        }
        Request::ServeRemoteWorkspace { target, .. }
        | Request::CloseRemoteWorkspace { target, .. }
        | Request::ForgetRemoteWorkspace { target, .. } => Response::Error {
            message: format!(
                "no registered devserver matches {target:?}. `chan devserver ls` lists the registered rows; a gateway-managed devserver is managed on the Gateways screen."
            ),
        },
        _ => Response::Error {
            message: "unexpected request".into(),
        },
    }
}

#[tokio::test]
async fn forget_alias_preserves_requests_and_refused_registrations() {
    use std::sync::{Arc, Mutex};
    let sandbox = Sandbox::new();
    let workspace = tempfile::tempdir().unwrap();
    let path = workspace.path().to_str().unwrap();
    let (code, _, err) = sandbox.run(&["workspace", "add", path]).await;
    assert_eq!(code, 0, "{err}");
    let config = sandbox.chan_home.path().join("config.toml");
    let before = std::fs::read(&config).unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let _listener = start_listener(sandbox.socket(), move |req| {
        seen.lock()
            .unwrap()
            .push(serde_json::to_value(&req).unwrap());
        async {
            Response::CloseRefused {
                error: "live_terminals".into(),
                active_terminals: 2,
            }
        }
    })
    .unwrap();
    for remote in [false, true] {
        for verb in [
            vec!["close", "--forget", path],
            vec!["workspace", "forget", path],
        ] {
            let mut args = verb;
            if remote {
                args.extend(["--on", "lab"]);
            }
            let out = sandbox
                .command(&args)
                .env("CHAN_DESKTOP_HANDOFF", "1")
                .output()
                .await
                .unwrap();
            assert!(!out.status.success());
            let err = String::from_utf8(out.stderr).unwrap();
            assert!(err.contains("2 live terminal(s)"), "{err}");
            assert_eq!(std::fs::read(&config).unwrap(), before);
        }
    }
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[0], requests[1]);
    assert_eq!(requests[2], requests[3]);
    assert_eq!(requests[0]["remove"], true);
    assert_eq!(requests[2]["target"], "lab");
}

#[tokio::test]
async fn forget_reads_a_desktops_still_releasing_answer() {
    let sandbox = Sandbox::new();
    let workspace = tempfile::tempdir().unwrap();
    let path = workspace.path().to_str().unwrap();
    let (code, _, err) = sandbox.run(&["workspace", "add", path]).await;
    assert_eq!(code, 0, "{err}");
    let config = sandbox.chan_home.path().join("config.toml");
    let before = std::fs::read(&config).unwrap();
    let answer = format!(
        "removing {path}: {}",
        chan_server::WORKSPACE_STILL_RELEASING
    );
    let reply = answer.clone();
    let _listener = start_listener(sandbox.socket(), move |_| {
        let message = reply.clone();
        async move { Response::Error { message } }
    })
    .unwrap();

    let out = sandbox
        .command(&["workspace", "forget", path])
        .env("CHAN_DESKTOP_HANDOFF", "1")
        .output()
        .await
        .unwrap();
    assert_eq!(out.status.code(), Some(75), "{out:?}");
    assert!(String::from_utf8_lossy(&out.stderr).contains(&answer));
    assert_eq!(std::fs::read(&config).unwrap(), before);

    // A close with the same answer and a forget with another desktop error
    // keep the best-effort control-socket fallback.
    let close = sandbox
        .command(&["close", path])
        .env("CHAN_DESKTOP_HANDOFF", "1")
        .output()
        .await
        .unwrap();
    assert_eq!(close.status.code(), Some(0), "{close:?}");
    assert_eq!(std::fs::read(&config).unwrap(), before);
}

#[tokio::test]
async fn forget_sends_the_stored_root_to_the_desktop_after_it_is_relinked() {
    use std::os::unix::fs::symlink;
    use std::sync::{Arc, Mutex};

    let sandbox = Sandbox::new();
    let saved = sandbox.home.path().join("saved");
    let other = sandbox.home.path().join("other");
    std::fs::create_dir(&saved).unwrap();
    std::fs::create_dir(&other).unwrap();
    let lib =
        chan_workspace::Library::open_at(sandbox.chan_home.path().join("config.toml")).unwrap();
    let saved_row = lib.register_workspace(&saved).unwrap();
    let other_row = lib.register_workspace(&other).unwrap();
    let other_state = lib.workspace_paths_for_row(&other_row).root;
    std::fs::write(other_state.join("keep"), b"other workspace state").unwrap();
    std::fs::remove_dir(&saved).unwrap();
    symlink(&other, &saved).unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let requests = Arc::clone(&seen);
    let _listener = start_listener(sandbox.socket(), move |request| {
        requests.lock().unwrap().push(request);
        async {
            Response::Closed {
                desktop_version: CHAN_VERSION.into(),
            }
        }
    })
    .unwrap();

    let out = sandbox
        .command(&["workspace", "forget", saved.to_str().unwrap()])
        .env("CHAN_DESKTOP_HANDOFF", "1")
        .output()
        .await
        .unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let requests = seen.lock().unwrap();
    assert!(
        matches!(requests.as_slice(), [Request::CloseWorkspace { workspace_path, remove: true, .. }] if workspace_path == saved.to_str().unwrap()),
        "{requests:?}"
    );
    let rows = chan_workspace::Library::open_at(sandbox.chan_home.path().join("config.toml"))
        .unwrap()
        .list_workspaces();
    assert!(rows.iter().all(|row| row.root_path != saved_row.root_path));
    assert!(rows.iter().any(|row| row.root_path == other_row.root_path));
    assert_eq!(
        std::fs::read(other_state.join("keep")).unwrap(),
        b"other workspace state"
    );
}

#[tokio::test]
async fn serve_close_and_forget_render_the_desktop_replies() {
    let sandbox = Sandbox::new();
    let _listener = start_listener(sandbox.socket(), |req| async move { fake_desktop(req) })
        .expect("bind fake desktop");

    let (code, out, err) = sandbox
        .run(&["workspace", "serve", "/srv/notes", "--on", "lab"])
        .await;
    assert_eq!(code, 0, "serve: {err}");
    assert!(out.contains("served /srv/notes on devserver lab"), "{out}");
    assert!(out.contains("mounted at /notes-1a2b3c"), "{out}");

    // The elevated spelling carries the arm too.
    let (code, out, _) = sandbox.run(&["serve", "/srv/notes", "--on", "lab"]).await;
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("mounted at /notes-1a2b3c"), "{out}");

    let (code, _, err) = sandbox.run(&["close", "/srv/notes", "--on", "lab"]).await;
    assert_ne!(code, 0);
    assert!(
        err.contains("refusing to close /srv/notes on lab: 2 live terminal(s)"),
        "{err}"
    );

    let (code, out, _) = sandbox
        .run(&["workspace", "close", "/srv/idle", "--on", "lab"])
        .await;
    assert_eq!(code, 0);
    assert!(out.contains("(not served on lab: /srv/idle)"), "{out}");

    let (code, out, _) = sandbox
        .run(&["workspace", "forget", "/srv/notes", "--on", "lab"])
        .await;
    assert_eq!(code, 0);
    assert!(out.contains("forgot: /srv/notes on lab"), "{out}");
}

#[tokio::test]
async fn refusals_name_the_candidates_and_the_other_flag() {
    let sandbox = Sandbox::new();
    let _listener = start_listener(sandbox.socket(), |req| async move { fake_desktop(req) })
        .expect("bind fake desktop");

    let (code, _, err) = sandbox.run(&["serve", "/srv/notes", "--on", "dup"]).await;
    assert_ne!(code, 0);
    assert!(err.contains("more than one registered devserver"), "{err}");
    assert!(
        err.contains("http://a:8787") && err.contains("http://b:8787"),
        "{err}"
    );

    let (code, _, err) = sandbox.run(&["serve", "/srv/notes", "--on", "nope"]).await;
    assert_ne!(code, 0);
    assert!(
        err.contains("no registered devserver matches \"nope\""),
        "{err}"
    );

    // Grammar refusals never reach the desktop: clap exits 2 with a pointer
    // at the other flag.
    let (code, _, err) = sandbox.run(&["serve", "/srv/notes", "--on", "8787"]).await;
    assert_eq!(code, 2, "{err}");
    assert!(err.contains("--devserver"), "{err}");
    let (code, _, err) = sandbox
        .run(&["serve", "/srv/notes", "--devserver=lab"])
        .await;
    assert_eq!(code, 2, "{err}");
    assert!(err.contains("--on"), "{err}");

    // A relative path is refused before any request: it would resolve
    // against this shell, not that machine.
    let (code, _, err) = sandbox.run(&["serve", "notes", "--on", "lab"]).await;
    assert_ne!(code, 0);
    assert!(err.contains("absolute"), "{err}");
}

#[tokio::test]
async fn without_a_desktop_the_arms_say_so() {
    let sandbox = Sandbox::new();
    let (code, _, err) = sandbox.run(&["serve", "/srv/notes", "--on", "lab"]).await;
    assert_ne!(code, 0);
    assert!(err.contains("needs the chan desktop app running"), "{err}");
}
