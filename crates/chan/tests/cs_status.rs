//! Terminal and detached-hook routes of the OSC 7501 emitter.

#![cfg(unix)]

use std::fs::File;
use std::io::{self, Read};
use std::os::unix::fs::{symlink, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use chan_shell::ControlResponse;
use rustix::fs::{Mode, OFlags};
use rustix::pty::{grantpt, openpt, ptsname, unlockpt, OpenptFlags};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[path = "../src/test_env/child_env.rs"]
mod child_env;

const BOUND: Duration = Duration::from_secs(30);

fn command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.env_clear()
        .envs(child_env::scrubbed_process_env())
        .env_remove("CHAN")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

fn alias(dir: &Path) -> std::path::PathBuf {
    let path = dir.join("cs");
    symlink(env!("CARGO_BIN_EXE_chan"), &path).unwrap();
    path
}

struct Pty {
    master: File,
    slave: File,
}

impl Pty {
    fn new() -> Self {
        let master = openpt(OpenptFlags::RDWR | OpenptFlags::NOCTTY).unwrap();
        rustix::io::fcntl_setfd(&master, rustix::io::FdFlags::CLOEXEC).unwrap();
        grantpt(&master).unwrap();
        unlockpt(&master).unwrap();
        let slave = rustix::fs::open(
            ptsname(&master, Vec::new()).unwrap(),
            OFlags::RDWR | OFlags::NOCTTY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .unwrap();
        let mut attributes = rustix::termios::tcgetattr(&slave).unwrap();
        attributes.make_raw();
        rustix::termios::tcsetattr(&slave, rustix::termios::OptionalActions::Now, &attributes)
            .unwrap();
        rustix::fs::fcntl_setfl(&master, OFlags::NONBLOCK).unwrap();
        Self {
            master: master.into(),
            slave: slave.into(),
        }
    }

    fn control(&self, cmd: &mut Command) {
        let slave = self.slave.try_clone().unwrap();
        // SAFETY: the child performs only async-signal-safe syscalls before exec.
        unsafe {
            cmd.pre_exec(move || {
                rustix::process::setsid()?;
                rustix::process::ioctl_tiocsctty(&slave)?;
                Ok(())
            });
        }
    }

    fn bytes(&mut self) -> Vec<u8> {
        let mut bytes = Vec::new();
        match self.master.read_to_end(&mut bytes) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => panic!("PTY read: {error}"),
        }
        bytes
    }
}

async fn run(cmd: Command) -> std::process::Output {
    let mut cmd = tokio::process::Command::from(cmd);
    cmd.kill_on_drop(true);
    // Command::output replaces an explicitly configured stdout with a pipe.
    let child = cmd.spawn().unwrap();
    tokio::time::timeout(BOUND, child.wait_with_output())
        .await
        .expect("bounded cs process")
        .unwrap()
}

fn detach(cmd: &mut Command) {
    // SAFETY: setsid is async-signal-safe and touches no shared Rust state.
    unsafe {
        cmd.pre_exec(|| {
            rustix::process::setsid()?;
            Ok(())
        });
    }
}

#[tokio::test]
async fn status_stdout_and_controlling_terminal_work_without_chan_env_and_through_alias() {
    let dir = tempfile::tempdir().unwrap();
    let cs = alias(dir.path());
    for (redirect, explicit) in [(false, false), (true, false), (false, true), (true, true)] {
        let mut pty = Pty::new();
        let mut controlling = Pty::new();
        let mut cmd = command(if explicit {
            Path::new(env!("CARGO_BIN_EXE_chan"))
        } else {
            &cs
        });
        if explicit {
            cmd.arg("shell");
        }
        cmd.args([
            "terminal",
            "status",
            "blocked",
            "--id",
            "child",
            "--kind",
            "question",
            "--msg",
            "Continue?",
        ]);
        if !redirect {
            cmd.stdout(Stdio::from(pty.slave.try_clone().unwrap()));
        }
        controlling.control(&mut cmd);
        let output = run(cmd).await;
        assert!(
            output.status.success(),
            "{redirect}/{explicit}: {:?}",
            output.stderr
        );
        assert!(output.stdout.is_empty(), "redirect received status bytes");
        let expected = b"\x1b]7501;state=blocked:kind=question:id=child:msg=Q29udGludWU/\x1b\\";
        if redirect {
            assert_eq!(
                controlling.bytes(),
                expected,
                "controlling terminal route {explicit}"
            );
            assert!(pty.bytes().is_empty());
        } else {
            assert_eq!(pty.bytes(), expected, "stdout terminal route {explicit}");
            assert!(
                controlling.bytes().is_empty(),
                "stdout must win over controlling tty"
            );
        }
    }
}

#[tokio::test]
async fn status_no_terminal_refuses_and_invalid_fields_write_no_sequence() {
    let dir = tempfile::tempdir().unwrap();
    let cs = alias(dir.path());
    let mut cmd = command(&cs);
    cmd.args(["terminal", "status", "done"]);
    detach(&mut cmd);
    let output = run(cmd).await;
    assert!(!output.status.success(), "no-terminal status succeeded");
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("needs a terminal"),
        "wrong refusal: {:?}",
        output.stderr
    );
    let mut pty = Pty::new();
    let mut cmd = command(&cs);
    cmd.args(["terminal", "status", "done", "--title", &"x".repeat(193)])
        .stdout(Stdio::from(pty.slave.try_clone().unwrap()));
    pty.control(&mut cmd);
    let output = run(cmd).await;
    assert!(!output.status.success(), "oversized title accepted");
    assert!(pty.bytes().is_empty(), "refusal wrote terminal bytes");
    assert!(String::from_utf8_lossy(&output.stderr).contains("192-byte"));
}

#[tokio::test]
async fn status_failed_terminal_write_is_nonzero_without_control_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let cs = alias(dir.path());
    let mut pty = Pty::new();
    let slave_name = ptsname(&pty.master, Vec::new()).unwrap();
    let readonly = rustix::fs::open(
        slave_name,
        OFlags::RDONLY | OFlags::NOCTTY | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .unwrap();
    let mut cmd = command(&cs);
    cmd.args(["terminal", "status", "done"])
        .env("CHAN_SESSION_ID", "fallback-must-not-run")
        .stdout(Stdio::from(readonly));
    pty.control(&mut cmd);
    let output = run(cmd).await;
    assert!(!output.status.success(), "failed write succeeded");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("writing program status"),
        "wrong failure: {:?}",
        output.stderr
    );
    assert!(
        pty.bytes().is_empty(),
        "failed stdout fell back to controlling tty"
    );
}

#[tokio::test]
async fn status_detached_hook_sends_exact_body_and_server_refusal_is_nonzero() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let cs = alias(dir.path());
    let path = dir.path().join("control.sock");
    let listener = tokio::net::UnixListener::bind(&path).unwrap();
    for accepted in [true, false] {
        let mut cmd = command(&cs);
        cmd.args([
            "terminal",
            "status",
            "working",
            "--id",
            "hook",
            "--app",
            "claude-code",
        ])
        .env("CHAN_SESSION_ID", "s1")
        .env("CHAN_CONTROL_SOCKET", &path);
        detach(&mut cmd);
        let server = async {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut line = String::new();
            BufReader::new(read).read_line(&mut line).await.unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&line).unwrap(),
                json!({"type":"term_status","session_id":"s1","body":"state=working:app=claude-code:id=hook"})
            );
            let response = if accepted {
                ControlResponse::Ok {
                    message: "program status accepted".into(),
                }
            } else {
                ControlResponse::Error {
                    message: "no live terminal session for program status".into(),
                }
            };
            let bytes = format!("{}\n", serde_json::to_string(&response).unwrap());
            write.write_all(bytes.as_bytes()).await.unwrap();
        };
        let (output, ()) = tokio::time::timeout(BOUND, async { tokio::join!(run(cmd), server) })
            .await
            .expect("bounded hook exchange");
        assert_eq!(
            output.status.success(),
            accepted,
            "server refusal must fail process"
        );
        assert!(output.stdout.is_empty(), "hook route wrote stdout");
    }
}
