//! Terminal and detached-hook routes of the OSC 7501 emitter.

#![cfg(unix)]

use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::unix::fs::{symlink, PermissionsExt};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use chan_shell::ControlResponse;
use rustix::fs::{Mode, OFlags};
use rustix::pty::{grantpt, openpt, ptsname, unlockpt, OpenptFlags};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[path = "../src/test_env/child_env.rs"]
mod child_env;

const BOUND: Duration = Duration::from_secs(30);
const READ_EVERY: Duration = Duration::from_millis(10);

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
    /// What the master has given and no caller has taken.
    read: Vec<u8>,
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
            read: Vec::new(),
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

    fn enable_signals(&self) {
        let mut attributes = rustix::termios::tcgetattr(&self.slave).unwrap();
        attributes.local_modes |= rustix::termios::LocalModes::ISIG;
        rustix::termios::tcsetattr(
            &self.slave,
            rustix::termios::OptionalActions::Now,
            &attributes,
        )
        .unwrap();
    }

    /// Take what the terminal holds now, without waiting for more.
    fn drain(&mut self) {
        match self.master.read_to_end(&mut self.read) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => panic!("PTY read: {error}"),
        }
    }

    fn bytes(&mut self) -> Vec<u8> {
        self.drain();
        std::mem::take(&mut self.read)
    }
}

/// Run `cmd` to its exit, reading `terminals` while it runs. On macOS the
/// exit of a session leader waits until its controlling terminal holds no
/// unread output, so a caller that reads only after the exit waits on a child
/// that waits on the read.
async fn run(cmd: Command, terminals: &mut [&mut Pty]) -> std::process::Output {
    run_observing(cmd, terminals, |_| {}).await
}

async fn run_observing(
    cmd: Command,
    terminals: &mut [&mut Pty],
    mut observe: impl FnMut(&mut [&mut Pty]),
) -> std::process::Output {
    // Not the command's own `Debug`, which prints its environment.
    let args: Vec<OsString> = cmd.get_args().map(OsString::from).collect();
    let mut cmd = tokio::process::Command::from(cmd);
    cmd.kill_on_drop(true);
    // Command::output replaces an explicitly configured stdout with a pipe.
    let output = cmd.spawn().unwrap().wait_with_output();
    tokio::pin!(output);
    let mut tick = tokio::time::interval(READ_EVERY);
    let finished = tokio::time::timeout(BOUND, async {
        loop {
            tokio::select! {
                output = &mut output => break output,
                _ = tick.tick() => {
                    terminals.iter_mut().for_each(|pty| pty.drain());
                    observe(terminals);
                }
            }
        }
    })
    .await;
    match finished {
        Ok(output) => output.unwrap(),
        Err(_) => {
            let given: Vec<usize> = terminals.iter().map(|pty| pty.read.len()).collect();
            panic!("{args:?} did not exit within {BOUND:?}; its terminals gave {given:?} bytes")
        }
    }
}

fn report_bodies(bytes: &[u8]) -> Vec<&[u8]> {
    const PREFIX: &[u8] = b"\x1b]7501;";
    let mut remaining = bytes;
    let mut bodies = Vec::new();
    while let Some(start) = remaining.windows(PREFIX.len()).position(|s| s == PREFIX) {
        remaining = &remaining[start + PREFIX.len()..];
        let end = remaining
            .windows(2)
            .position(|s| s == b"\x1b\\")
            .expect("complete status report");
        bodies.push(&remaining[..end]);
        remaining = &remaining[end + 2..];
    }
    bodies
}

#[tokio::test]
async fn status_sleep_expires_without_a_second_report() {
    let dir = tempfile::tempdir().unwrap();
    let cs = alias(dir.path());
    for state in ["working", "clear"] {
        let mut pty = Pty::new();
        let mut cmd = command(&cs);
        cmd.args(["terminal", "status", state, "--sleep", "2"])
            .stdout(Stdio::from(pty.slave.try_clone().unwrap()));
        pty.control(&mut cmd);
        let start = Instant::now();
        let output = run(cmd, &mut [&mut pty]).await;
        let elapsed = start.elapsed();
        assert!(output.status.success(), "{:?}", output.stderr);
        assert!(output.stdout.is_empty());
        let bytes = pty.bytes();
        assert_eq!(report_bodies(&bytes), [format!("state={state}").as_bytes()]);
        assert!(
            elapsed >= Duration::from_secs(2),
            "wait omitted: {elapsed:?}"
        );
    }
}

#[tokio::test]
async fn status_zero_sleep_and_no_flag_emit_the_same_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let cs = alias(dir.path());
    for state in ["working", "blocked", "idle", "done", "error", "clear"] {
        for args in [vec![], vec!["--sleep", "0"]] {
            let mut pty = Pty::new();
            let mut cmd = command(&cs);
            cmd.args(["terminal", "status", state])
                .args(args)
                .stdout(Stdio::from(pty.slave.try_clone().unwrap()));
            pty.control(&mut cmd);
            let output = run(cmd, &mut [&mut pty]).await;
            assert!(output.status.success(), "{:?}", output.stderr);
            assert!(output.stdout.is_empty());
            assert_eq!(
                pty.bytes(),
                format!("\x1b]7501;state={state}\x1b\\").as_bytes()
            );
        }
    }
}

#[tokio::test]
async fn status_sleep_refuses_invalid_seconds_before_emission() {
    let dir = tempfile::tempdir().unwrap();
    let cs = alias(dir.path());
    for args in [
        vec!["--sleep", "86401"],
        vec!["--sleep=-1"],
        vec!["--sleep", "-1"],
        vec!["--sleep", "1.5"],
        vec!["--sleep", "x"],
    ] {
        let mut pty = Pty::new();
        pty.enable_signals();
        let mut cmd = command(&cs);
        cmd.args(["terminal", "status", "working"])
            .args(&args)
            .stdout(Stdio::from(pty.slave.try_clone().unwrap()));
        pty.control(&mut cmd);
        let mut interrupted = false;
        let output = run_observing(cmd, &mut [&mut pty], |terminals| {
            // A wrongly accepted long wait must fail on its bytes, not hang.
            if !interrupted && !terminals[0].read.is_empty() {
                terminals[0].master.write_all(b"\x03").unwrap();
                interrupted = true;
            }
        })
        .await;
        assert!(!output.status.success(), "{args:?} accepted");
        assert!(pty.bytes().is_empty(), "{args:?} wrote terminal bytes");
        assert!(output.stdout.is_empty());
    }
}

#[tokio::test]
async fn status_sleep_interrupt_writes_no_second_report() {
    let dir = tempfile::tempdir().unwrap();
    let cs = alias(dir.path());
    let mut pty = Pty::new();
    pty.enable_signals();
    let mut cmd = command(&cs);
    cmd.args(["terminal", "status", "working", "--sleep", "3600"])
        .stdout(Stdio::from(pty.slave.try_clone().unwrap()));
    pty.control(&mut cmd);
    let mut interrupted = false;
    let output = run_observing(cmd, &mut [&mut pty], |terminals| {
        if !interrupted && terminals[0].read.windows(2).any(|s| s == b"\x1b\\") {
            terminals[0].master.write_all(b"\x03").unwrap();
            interrupted = true;
        }
    })
    .await;
    assert!(interrupted, "writer exited before the interrupt");
    let bytes = pty.bytes();
    assert_eq!(report_bodies(&bytes), [b"state=working".as_slice()]);
    assert_eq!(
        output.status.signal(),
        Some(rustix::process::Signal::INT.as_raw())
    );
    assert!(output.stdout.is_empty());
}

#[tokio::test]
async fn status_sleep_control_route_sends_once_then_waits() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let cs = alias(dir.path());
    let path = dir.path().join("control.sock");
    let listener = tokio::net::UnixListener::bind(&path).unwrap();
    let mut cmd = command(&cs);
    cmd.args(["terminal", "status", "working", "--sleep", "2"])
        .env("CHAN_SESSION_ID", "s1")
        .env("CHAN_CONTROL_SOCKET", &path);
    detach(&mut cmd);
    let mut requests = 0;
    let start = Instant::now();
    let server = async {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut reader = BufReader::new(read);
            let mut line = String::new();
            while reader.read_line(&mut line).await.unwrap() != 0 {
                requests += 1;
                assert_eq!(
                    serde_json::from_str::<Value>(&line).unwrap(),
                    json!({"type":"term_status","session_id":"s1","body":"state=working"})
                );
                let reply = ControlResponse::Ok {
                    message: "accepted".into(),
                };
                write
                    .write_all(format!("{}\n", serde_json::to_string(&reply).unwrap()).as_bytes())
                    .await
                    .unwrap();
                line.clear();
            }
        }
    };
    let output = tokio::select! {
        output = run(cmd, &mut []) => output,
        () = server => unreachable!(),
    };
    let elapsed = start.elapsed();
    assert!(output.status.success(), "{:?}", output.stderr);
    assert_eq!(requests, 1);
    assert!(
        elapsed >= Duration::from_secs(2),
        "wait omitted: {elapsed:?}"
    );
    assert!(output.stdout.is_empty());
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
        let output = run(cmd, &mut [&mut pty, &mut controlling]).await;
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
    cmd.args(["terminal", "status", "done", "--sleep", "3600"]);
    detach(&mut cmd);
    let output = run(cmd, &mut []).await;
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
    let output = run(cmd, &mut [&mut pty]).await;
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
    cmd.args(["terminal", "status", "done", "--sleep", "3600"])
        .env("CHAN_SESSION_ID", "fallback-must-not-run")
        .stdout(Stdio::from(readonly));
    pty.control(&mut cmd);
    let output = run(cmd, &mut [&mut pty]).await;
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
        let (output, ()) =
            tokio::time::timeout(BOUND, async { tokio::join!(run(cmd, &mut []), server) })
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

// A status report is far smaller than a terminal's buffer, and on Linux no
// exit waits for a terminal, so the tests above pass there with a `run` that
// reads nothing until the child is gone. This child fills the buffer and
// cannot finish until its terminal is read.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn run_reads_a_terminal_while_its_child_runs() {
    const LEN: usize = 128 * 1024;
    let mut pty = Pty::new();
    let mut cmd = command(Path::new("/bin/sh"));
    cmd.args(["-c", &format!("head -c {LEN} /dev/zero")])
        .stdout(Stdio::from(pty.slave.try_clone().unwrap()));
    let output = run(cmd, &mut [&mut pty]).await;
    assert!(output.status.success(), "{:?}", output.stderr);
    let bytes = pty.bytes();
    assert_eq!(bytes.len(), LEN);
    assert!(bytes.iter().all(|byte| *byte == 0));
}
