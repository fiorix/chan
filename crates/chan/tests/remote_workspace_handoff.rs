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

const CHAN: &str = env!("CARGO_BIN_EXE_chan");

struct Sandbox {
    runtime: tempfile::TempDir,
    chan_home: tempfile::TempDir,
    home: tempfile::TempDir,
}

impl Sandbox {
    fn new() -> Self {
        Self {
            runtime: tempfile::tempdir().expect("runtime tempdir"),
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
            .envs(chan::test_env::scrubbed_process_env())
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
