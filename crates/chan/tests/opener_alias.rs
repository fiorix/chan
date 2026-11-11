//! The `chan-files` and `chan-edit` names: the chan binary run through a link
//! of either name parses that name's own usage and sends each path where `cs
//! open` would. In a chan terminal whose server answers, that is the
//! terminal's control socket; from any other shell, the running desktop's
//! handoff endpoint. These tests stand a fake of each in a private runtime
//! directory, so no request can reach a real desktop or server.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{symlink, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::mpsc;
use std::time::Duration;

use chan_server::handoff::Response;
use chan_shell::ControlResponse;
use serde_json::{json, Value};

// The library compiles its test harness for its own tests alone, so the
// file of it that scrubs a child's environment is mounted here by path.
#[path = "../src/test_env/child_env.rs"]
mod child_env;

/// How long a fake waits to see a request that a test expects none of.
const QUIET: Duration = Duration::from_millis(300);

struct Fixture {
    _dir: tempfile::TempDir,
    bin: PathBuf,
    /// The child's `XDG_RUNTIME_DIR`, where the desktop endpoint lives.
    run: PathBuf,
    /// The child's working directory: `docs/` and `notes.md`.
    files: PathBuf,
}

fn fixture() -> Fixture {
    let dir = tempfile::Builder::new().prefix("opn-").tempdir().unwrap();
    let bin = dir.path().join("bin");
    let run = dir.path().join("run");
    let files = dir.path().join("files");
    for d in [&bin, &run, &files] {
        std::fs::create_dir(d).unwrap();
    }
    std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o700)).unwrap();
    for name in ["chan-files", "chan-edit"] {
        symlink(env!("CARGO_BIN_EXE_chan"), bin.join(name)).unwrap();
    }
    std::fs::create_dir(files.join("docs")).unwrap();
    std::fs::write(files.join("notes.md"), "# notes\n").unwrap();
    Fixture {
        _dir: dir,
        bin,
        run,
        files,
    }
}

impl Fixture {
    /// `name` over a scrubbed environment in a GUI session of its own: no
    /// `CHAN_*`, no SSH login, `DISPLAY` set, and this fixture's runtime
    /// directory, so the desktop endpoint it resolves is the fake's.
    fn command(&self, name: &str) -> Command {
        let mut cmd = Command::new(self.bin.join(name));
        cmd.env_clear()
            .envs(child_env::scrubbed_process_env())
            .env_remove("RUST_BACKTRACE")
            .env_remove("RUST_LIB_BACKTRACE")
            .env_remove("WAYLAND_DISPLAY")
            .env_remove("SSH_CONNECTION")
            .env_remove("SSH_TTY")
            .env_remove("SSH_CLIENT")
            .env("XDG_RUNTIME_DIR", &self.run)
            .env("DISPLAY", ":99")
            .current_dir(&self.files);
        cmd
    }

    fn path(&self, rel: &str) -> String {
        self.files.join(rel).into_os_string().into_string().unwrap()
    }
}

/// A fake listener at `socket` that answers every connection's request line
/// with `answer`'s line and reports each request it read.
fn fake(socket: PathBuf, answer: fn(&Value) -> String) -> mpsc::Receiver<Value> {
    let listener = UnixListener::bind(&socket).unwrap();
    let (sent, requests) = mpsc::channel();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut conn) = conn else { return };
            let mut line = String::new();
            if BufReader::new(&conn).read_line(&mut line).is_err() {
                continue;
            }
            let request: Value = serde_json::from_str(&line).unwrap();
            let mut reply = answer(&request);
            reply.push('\n');
            let _ = conn.write_all(reply.as_bytes());
            if sent.send(request).is_err() {
                return;
            }
        }
    });
    requests
}

/// The desktop's endpoint, answering every `open_path` as opened.
fn fake_desktop(f: &Fixture, answer: fn(&Value) -> String) -> mpsc::Receiver<Value> {
    fake(f.run.join("chan-desktop.sock"), answer)
}

fn opened(request: &Value) -> String {
    serde_json::to_string(&Response::PathOpened {
        desktop_version: "0.0.0".into(),
        message: format!("opened {}", request["path"].as_str().unwrap()),
    })
    .unwrap()
}

fn open_path(path: &str) -> Value {
    json!({
        "type": "open_path",
        "protocol": 1,
        "cli_version": env!("CARGO_PKG_VERSION"),
        "path": path,
    })
}

fn drain(requests: &mpsc::Receiver<Value>) -> Vec<Value> {
    let mut all = Vec::new();
    while let Ok(request) = requests.recv_timeout(QUIET) {
        all.push(request);
    }
    all
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn each_name_prints_its_own_usage() {
    let f = fixture();
    for name in ["chan-files", "chan-edit"] {
        let output = f.command(name).arg("--help").output().unwrap();
        assert!(output.status.success(), "{name}: {}", stderr(&output));
        let help = String::from_utf8_lossy(&output.stdout);
        assert!(
            help.contains(&format!("Usage: {name} [OPTIONS] [PATH]...")),
            "{name} --help:\n{help}"
        );
        assert!(
            help.contains("as `cs open PATH` does inside chan"),
            "{help}"
        );
    }
}

/// From a shell outside chan, a directory, a file, a missing name and a file
/// URI each go to the desktop as the absolute path they name, in order. The
/// desktop decides what each opens, and creates the missing one: the command
/// creates nothing.
#[test]
fn outside_chan_each_path_goes_to_the_running_desktop() {
    let f = fixture();
    let requests = fake_desktop(&f, opened);
    let uri = format!("file://{}", f.path("a%20b.md"));
    let output = f
        .command("chan-files")
        .args(["docs", "notes.md", "later.md", &uri])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    let paths = [
        f.path("docs"),
        f.path("notes.md"),
        f.path("later.md"),
        f.path("a b.md"),
    ];
    assert_eq!(
        drain(&requests),
        paths.iter().map(|p| open_path(p)).collect::<Vec<_>>()
    );
    assert_eq!(
        stderr(&output),
        paths
            .iter()
            .map(|p| format!("opened {p}\n"))
            .collect::<String>()
    );
    assert!(!Path::new(&f.path("later.md")).exists());
}

/// The two names send the same request: only the usage and the desktop entry
/// tell them apart.
#[test]
fn chan_edit_sends_what_chan_files_sends() {
    let f = fixture();
    let requests = fake_desktop(&f, opened);
    for name in ["chan-edit", "chan-files"] {
        let output = f.command(name).arg("docs").output().unwrap();
        assert!(output.status.success(), "{name}: {}", stderr(&output));
    }
    assert_eq!(
        drain(&requests),
        [open_path(&f.path("docs")), open_path(&f.path("docs"))]
    );
}

#[test]
fn no_path_opens_the_working_directory() {
    let f = fixture();
    let requests = fake_desktop(&f, opened);
    let output = f.command("chan-edit").output().unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    let cwd = std::fs::canonicalize(&f.files).unwrap();
    assert_eq!(drain(&requests), [open_path(cwd.to_str().unwrap())]);
}

/// A fake chan terminal server: `Identify` answers as a desktop, an
/// `open_path` as queued.
fn terminal_server(request: &Value) -> String {
    let message = match request["type"].as_str() {
        Some("identify") => json!({"kind": "desktop", "version": "0.0.0", "pid": 1}).to_string(),
        Some("open_path") => format!("queued {}", request["path"].as_str().unwrap()),
        other => panic!("unexpected control request {other:?}: {request}"),
    };
    serde_json::to_string(&ControlResponse::Ok { message }).unwrap()
}

/// In a chan terminal whose server answers, each path goes to that terminal's
/// window through `cs open`, and the desktop endpoint hears nothing.
#[test]
fn in_a_chan_terminal_each_path_goes_through_cs_open() {
    let f = fixture();
    let desktop = fake_desktop(&f, opened);
    let control_dir = f.run.join("ctl");
    std::fs::create_dir(&control_dir).unwrap();
    std::fs::set_permissions(&control_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let socket = control_dir.join("control.sock");
    let control = fake(socket.clone(), terminal_server);
    let output = f
        .command("chan-files")
        .args(["docs", "notes.md"])
        .env("CHAN", "1")
        .env("CHAN_CONTROL_SOCKET", &socket)
        .env("CHAN_WINDOW_ID", "w-test")
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    let opens: Vec<Value> = drain(&control)
        .into_iter()
        .filter(|request| request["type"] != "identify")
        .collect();
    assert_eq!(
        opens,
        [f.path("docs"), f.path("notes.md")]
            .iter()
            .map(|path| json!({"type": "open_path", "window_id": "w-test", "path": path}))
            .collect::<Vec<_>>()
    );
    assert_eq!(drain(&desktop), Vec::<Value>::new());
    assert_eq!(
        stderr(&output),
        format!("queued {}\nqueued {}\n", f.path("docs"), f.path("notes.md"))
    );
}

/// A `$CHAN_CONTROL_SOCKET` nothing answers on (a tmux session reattached
/// outside chan) is not a chan terminal: the path goes to the desktop.
#[test]
fn a_control_socket_nothing_answers_on_falls_back_to_the_desktop() {
    let f = fixture();
    let requests = fake_desktop(&f, opened);
    let output = f
        .command("chan-files")
        .arg("docs")
        .env("CHAN", "1")
        .env("CHAN_CONTROL_SOCKET", f.run.join("gone.sock"))
        .env("CHAN_WINDOW_ID", "w-test")
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(drain(&requests), [open_path(&f.path("docs"))]);
}

/// The standalone binary has no desktop of its own to start.
#[test]
fn with_no_desktop_running_the_standalone_cli_says_so() {
    let f = fixture();
    for name in ["chan-files", "chan-edit"] {
        let output = f.command(name).arg("docs").output().unwrap();
        assert_eq!(output.status.code(), Some(1), "{name}");
        assert_eq!(
            stderr(&output),
            format!(
                "Error: chan-desktop is not running; start it and run {name} again, or run \
                 {name} in a chan terminal\n"
            )
        );
    }
}

/// `CHAN_NO_DESKTOP_HANDOFF` and a session with no display each stop the
/// handoff before anything is sent, and say which stopped it.
#[test]
fn the_handoff_opt_out_and_a_headless_session_refuse_before_sending() {
    let f = fixture();
    let requests = fake_desktop(&f, opened);
    let opt_out = f
        .command("chan-edit")
        .arg("notes.md")
        .env("CHAN_NO_DESKTOP_HANDOFF", "1")
        .output()
        .unwrap();
    assert_eq!(opt_out.status.code(), Some(1));
    assert_eq!(
        stderr(&opt_out),
        "Error: CHAN_NO_DESKTOP_HANDOFF is set, so chan-edit hands no path to chan-desktop; \
         run chan-edit in a chan terminal, or unset CHAN_NO_DESKTOP_HANDOFF\n"
    );
    let headless = "Error: chan-edit outside a chan terminal opens paths in chan-desktop, and \
                    this session has no display (an SSH login, or no DISPLAY or \
                    WAYLAND_DISPLAY); run chan-edit in a chan terminal\n";
    let no_display = f
        .command("chan-edit")
        .arg("notes.md")
        .env_remove("DISPLAY")
        .output()
        .unwrap();
    assert_eq!(no_display.status.code(), Some(1));
    assert_eq!(stderr(&no_display), headless);
    let ssh = f
        .command("chan-edit")
        .arg("notes.md")
        .env("SSH_CONNECTION", "10.0.0.1 22 10.0.0.2 50000")
        .output()
        .unwrap();
    assert_eq!(ssh.status.code(), Some(1));
    assert_eq!(stderr(&ssh), headless);
    assert_eq!(drain(&requests), Vec::<Value>::new());
}

fn refuses_bad(request: &Value) -> String {
    let path = request["path"].as_str().unwrap();
    if path.contains("bad") {
        serde_json::to_string(&Response::Error {
            message: format!("create {path}: not editable text"),
        })
        .unwrap()
    } else {
        opened(request)
    }
}

/// A path the desktop refuses and an argument that names nothing to open are
/// each reported; the rest still open, and the command fails.
#[test]
fn a_path_that_cannot_be_opened_is_reported_and_the_rest_still_open() {
    let f = fixture();
    let requests = fake_desktop(&f, refuses_bad);
    let output = f
        .command("chan-files")
        .args(["bad.bin", "smb://nas/share/x.md", "notes.md"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        drain(&requests),
        [
            open_path(&f.path("bad.bin")),
            open_path(&f.path("notes.md"))
        ]
    );
    let bad = f.path("bad.bin");
    assert_eq!(
        stderr(&output),
        format!(
            "opened {notes}\n\
             chan-files: chan-desktop did not open {bad}: create {bad}: not editable text\n\
             chan-files: smb://nas/share/x.md is not a file: chan opens files and directories, \
             given as paths or file:// URIs\n\
             Error: 2 of 3 paths were not opened\n",
            notes = f.path("notes.md"),
        )
    );
}

/// A refusal that stops every path still reports the arguments that failed
/// before it.
#[test]
fn a_refusal_of_every_path_keeps_the_arguments_that_failed() {
    let f = fixture();
    let requests = fake_desktop(&f, opened);
    let output = f
        .command("chan-files")
        .args(["smb://nas/share/x.md", "notes.md"])
        .env("CHAN_NO_DESKTOP_HANDOFF", "1")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        stderr(&output),
        "chan-files: smb://nas/share/x.md is not a file: chan opens files and directories, \
         given as paths or file:// URIs\n\
         Error: CHAN_NO_DESKTOP_HANDOFF is set, so chan-files hands no path to chan-desktop; \
         run chan-files in a chan terminal, or unset CHAN_NO_DESKTOP_HANDOFF\n"
    );
    assert_eq!(drain(&requests), Vec::<Value>::new());
}

/// A desktop whose listener is bound but never reads (still starting, or
/// wedged) is running: the command does not say none is, starts no other,
/// and reports that it did not answer once the 5 s it gets have passed.
#[test]
fn a_desktop_that_does_not_answer_is_reported_not_replaced() {
    let f = fixture();
    let _bound = UnixListener::bind(f.run.join("chan-desktop.sock")).unwrap();
    let started = std::time::Instant::now();
    let output = f
        .command("chan-files")
        .args(["docs", "notes.md"])
        .output()
        .unwrap();
    let took = started.elapsed();
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        stderr(&output),
        format!(
            "chan-files: chan-desktop did not answer for {docs}\n\
             chan-files: chan-desktop did not answer for {notes}\n\
             Error: 2 of 2 paths were not opened\n",
            docs = f.path("docs"),
            notes = f.path("notes.md"),
        )
    );
    assert!(
        took >= Duration::from_millis(4500) && took < Duration::from_secs(9),
        "the desktop gets its 5 s and no more: took {took:?}"
    );
}

/// A listener that closes without an answer is asked again within the 5 s,
/// and an answer that takes longer than the old 3 s still lands.
#[test]
fn a_busy_desktop_is_asked_again_and_waited_for() {
    let f = fixture();
    let listener = UnixListener::bind(f.run.join("chan-desktop.sock")).unwrap();
    let (sent, requests) = mpsc::channel();
    std::thread::spawn(move || {
        let mut conns = listener.incoming();
        // The first connection is closed unread.
        drop(conns.next());
        let Some(Ok(mut conn)) = conns.next() else {
            return;
        };
        let mut line = String::new();
        BufReader::new(&conn).read_line(&mut line).unwrap();
        let request: Value = serde_json::from_str(&line).unwrap();
        std::thread::sleep(Duration::from_millis(3500));
        let _ = conn.write_all(format!("{}\n", opened(&request)).as_bytes());
        let _ = sent.send(request);
    });
    let output = f.command("chan-edit").arg("notes.md").output().unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(stderr(&output), format!("opened {}\n", f.path("notes.md")));
    assert_eq!(drain(&requests), [open_path(&f.path("notes.md"))]);
}

/// One argument that cannot be opened is the error itself.
#[test]
fn a_lone_path_that_cannot_be_opened_is_the_error() {
    let f = fixture();
    let requests = fake_desktop(&f, refuses_bad);
    let output = f.command("chan-edit").arg("bad.bin").output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    let bad = f.path("bad.bin");
    assert_eq!(
        stderr(&output),
        format!("Error: chan-desktop did not open {bad}: create {bad}: not editable text\n")
    );
    assert_eq!(drain(&requests).len(), 1);
}
