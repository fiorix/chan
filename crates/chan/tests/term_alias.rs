//! The standalone CLI's `chan-term`: the chan binary run through a link of
//! that name reads the launch grammar and, having no window of its own, asks
//! the running desktop's handoff endpoint for a shell window or refuses with
//! the reason. These tests stand a fake endpoint in a private runtime
//! directory, so no request can reach a real desktop.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{symlink, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::mpsc;
use std::time::Duration;

use chan_server::handoff::Response;
use serde_json::Value;

// The library compiles its test harness for its own tests alone, so the
// file of it that scrubs a child's environment is mounted here by path.
#[path = "../src/test_env/child_env.rs"]
mod child_env;

/// How long the fake waits to see a request that a test expects none of.
const QUIET: Duration = Duration::from_millis(300);

struct Fixture {
    _dir: tempfile::TempDir,
    bin: PathBuf,
    /// The child's `XDG_RUNTIME_DIR`, where the desktop endpoint lives.
    run: PathBuf,
    /// The child's `HOME`, where a `--dir` that is no directory falls back.
    home: PathBuf,
    /// The child's working directory, holding `docs/`.
    files: PathBuf,
    /// `files` as the OS reports it to the child (getcwd): canonical.
    cwd: PathBuf,
}

fn fixture() -> Fixture {
    let dir = tempfile::Builder::new().prefix("trm-").tempdir().unwrap();
    let bin = dir.path().join("bin");
    let run = dir.path().join("run");
    let home = dir.path().join("home");
    let files = dir.path().join("files");
    for d in [&bin, &run, &home, &files] {
        std::fs::create_dir(d).unwrap();
    }
    std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o700)).unwrap();
    symlink(env!("CARGO_BIN_EXE_chan"), bin.join("chan-term")).unwrap();
    std::fs::create_dir(files.join("docs")).unwrap();
    let cwd = std::fs::canonicalize(&files).unwrap();
    Fixture {
        _dir: dir,
        bin,
        run,
        home,
        files,
        cwd,
    }
}

impl Fixture {
    /// `chan-term ARGS` over a scrubbed environment in a GUI session of its
    /// own: no `CHAN_*`, no SSH login, `DISPLAY` set, and this fixture's
    /// runtime directory, so the desktop endpoint it resolves is the fake's.
    fn term(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(self.bin.join("chan-term"));
        cmd.env_clear()
            .envs(child_env::scrubbed_process_env())
            .env_remove("RUST_BACKTRACE")
            .env_remove("RUST_LIB_BACKTRACE")
            .env_remove("WAYLAND_DISPLAY")
            .env_remove("SSH_CONNECTION")
            .env_remove("SSH_TTY")
            .env_remove("SSH_CLIENT")
            .env("XDG_RUNTIME_DIR", &self.run)
            .env("HOME", &self.home)
            .env("DISPLAY", ":99")
            .current_dir(&self.files)
            .args(args);
        cmd
    }
}

/// The desktop's endpoint, answering every request with `answer`'s line and
/// reporting each request it read.
fn fake_desktop(f: &Fixture, answer: fn(&Value) -> Response) -> mpsc::Receiver<Value> {
    let listener = UnixListener::bind(f.run.join("chan-desktop.sock")).unwrap();
    let (sent, requests) = mpsc::channel();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut conn) = conn else { return };
            let mut line = String::new();
            if BufReader::new(&conn).read_line(&mut line).is_err() {
                continue;
            }
            let request: Value = serde_json::from_str(&line).unwrap();
            let mut reply = serde_json::to_string(&answer(&request)).unwrap();
            reply.push('\n');
            let _ = conn.write_all(reply.as_bytes());
            if sent.send(request).is_err() {
                return;
            }
        }
    });
    requests
}

fn opened(_: &Value) -> Response {
    Response::TerminalOpened {
        desktop_version: "0.0.0".into(),
    }
}

/// The start directories of the `open_terminal` requests the fake read, each
/// checked for the request's shape.
fn terminals(requests: &mpsc::Receiver<Value>) -> Vec<String> {
    let mut cwds = Vec::new();
    while let Ok(request) = requests.recv_timeout(QUIET) {
        assert_eq!(request["type"], "open_terminal", "{request}");
        assert_eq!(
            request["cli_version"],
            env!("CARGO_PKG_VERSION"),
            "{request}"
        );
        cwds.push(request["cwd"].as_str().unwrap().to_string());
    }
    cwds
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// `--help` and `--version` answer without a desktop; a usage error names
/// what is wrong, prints the usage line and exits 2. The container smokes of
/// the packages grep the help for its usage line.
#[test]
fn help_version_and_a_usage_error_answer_here() {
    let f = fixture();
    let help = f.term(&["--help"]).output().unwrap();
    assert!(help.status.success(), "{}", stderr(&help));
    assert!(
        stdout(&help)
            .lines()
            .any(|line| line.starts_with("Usage: chan-term [--dir=PATH] ")),
        "{}",
        stdout(&help)
    );
    let version = f.term(&["-V"]).output().unwrap();
    assert!(version.status.success(), "{}", stderr(&version));
    assert!(
        stdout(&version).starts_with(&format!("chan-term {} (build ", env!("CARGO_PKG_VERSION"))),
        "{}",
        stdout(&version)
    );
    for (args, reason) in [
        (&["--foo"][..], "unknown option --foo"),
        (
            &["htop"],
            "unexpected argument htop: put -e or -- before the command",
        ),
        (&["-e"], "-e needs a command after it"),
    ] {
        let output = f.term(args).output().unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        let text = stderr(&output);
        assert!(
            text.starts_with(&format!("chan-term: {reason}\nUsage: chan-term ")),
            "{args:?}: {text}"
        );
    }
}

/// A launch that only runs the shell goes to the running desktop as one
/// `open_terminal` for its start directory: the working directory, `--dir`
/// read against it, or, with a warning, the home directory for a `--dir`
/// that is none.
#[test]
fn a_shell_launch_goes_to_the_running_desktop() {
    let f = fixture();
    let requests = fake_desktop(&f, opened);
    for args in [&[][..], &["--dir", "docs"]] {
        let output = f.term(args).output().unwrap();
        assert!(output.status.success(), "{args:?}: {}", stderr(&output));
        assert_eq!(stderr(&output), "", "{args:?}");
    }
    let stale = f.term(&["--dir=/nonexistent-trm-dir"]).output().unwrap();
    assert!(stale.status.success(), "{}", stderr(&stale));
    let warning = format!(
        "/nonexistent-trm-dir is not a directory; starting in {}",
        f.home.display()
    );
    assert!(stderr(&stale).contains(&warning), "{}", stderr(&stale));
    assert_eq!(
        terminals(&requests),
        [
            f.cwd.to_str().unwrap().to_string(),
            f.cwd.join("docs").to_str().unwrap().to_string(),
            f.home.to_str().unwrap().to_string(),
        ]
    );
}

/// A command, `--hold`, `--app-id` and `--title` each need a window this
/// process owns, which the standalone CLI cannot open: refused with the
/// reason before anything is sent.
#[test]
fn a_launch_that_needs_its_own_window_is_refused() {
    let f = fixture();
    let requests = fake_desktop(&f, opened);
    for (args, reason) in [
        (&["-e", "true"][..], "a command"),
        (&["--", "htop"], "a command"),
        (&["--hold"], "--hold"),
        (&["--app-id=TUI.float"], "--app-id"),
        (&["--title", "Logs"], "--title"),
    ] {
        let output = f.term(args).output().unwrap();
        assert_eq!(output.status.code(), Some(1), "{args:?}");
        assert_eq!(
            stderr(&output),
            format!(
                "Error: {reason} needs a window of chan-term's own, which only Chan Desktop's \
                 chan-term opens; this chan is the standalone CLI, whose chan-term only asks a \
                 running chan-desktop for a shell window\n"
            ),
            "{args:?}"
        );
    }
    assert_eq!(terminals(&requests), Vec::<String>::new());
}

#[test]
fn with_no_desktop_running_it_says_so() {
    let f = fixture();
    let output = f.term(&[]).output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        stderr(&output),
        "Error: chan-desktop is not running; start it and run chan-term again\n"
    );
}

fn refused(_: &Value) -> Response {
    Response::Error {
        message: "chan-desktop is shutting down".into(),
    }
}

#[test]
fn a_desktop_that_refuses_is_reported() {
    let f = fixture();
    let requests = fake_desktop(&f, refused);
    let output = f.term(&[]).output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        stderr(&output),
        format!(
            "Error: chan-desktop did not open a terminal in {}: chan-desktop is shutting down\n",
            f.cwd.display()
        )
    );
    assert_eq!(terminals(&requests).len(), 1);
}

/// `CHAN_NO_DESKTOP_HANDOFF` and a headless session each stop the request
/// before anything is sent, and say which stopped it. An SSH login is
/// headless everywhere; a session with no `DISPLAY` or `WAYLAND_DISPLAY` is
/// headless everywhere but macOS, where the check reads neither.
#[test]
fn the_handoff_opt_out_and_a_headless_session_refuse_before_sending() {
    let f = fixture();
    let requests = fake_desktop(&f, opened);
    let opt_out = f
        .term(&[])
        .env("CHAN_NO_DESKTOP_HANDOFF", "1")
        .output()
        .unwrap();
    assert_eq!(opt_out.status.code(), Some(1));
    assert_eq!(
        stderr(&opt_out),
        "Error: CHAN_NO_DESKTOP_HANDOFF is set, so chan-term asks chan-desktop for no window; \
         unset CHAN_NO_DESKTOP_HANDOFF\n"
    );
    let headless = "Error: chan-term opens its window in chan-desktop, and this session has no \
                    display (an SSH login, or no DISPLAY or WAYLAND_DISPLAY)\n";
    let ssh = f
        .term(&[])
        .env("SSH_CONNECTION", "10.0.0.1 22 10.0.0.2 50000")
        .output()
        .unwrap();
    assert_eq!(ssh.status.code(), Some(1));
    assert_eq!(stderr(&ssh), headless);
    if !cfg!(target_os = "macos") {
        let no_display = f.term(&[]).env_remove("DISPLAY").output().unwrap();
        assert_eq!(no_display.status.code(), Some(1));
        assert_eq!(stderr(&no_display), headless);
    }
    assert_eq!(terminals(&requests), Vec::<String>::new());
}
