//! `chan workspace reports disable` and `enable` run as a script would run
//! them: no terminal on standard input.

use std::path::Path;
use std::process::{Command, Output, Stdio};

/// A chan home and a registered workspace, each in a directory of its own.
struct Sandbox {
    chan_home: tempfile::TempDir,
    home: tempfile::TempDir,
    root: tempfile::TempDir,
}

impl Sandbox {
    fn new() -> Self {
        let sandbox = Self {
            chan_home: tempfile::tempdir().expect("chan home"),
            home: tempfile::tempdir().expect("home"),
            root: tempfile::tempdir().expect("workspace root"),
        };
        let root = sandbox.root.path().to_str().expect("utf-8 root");
        let added = sandbox.chan(&["workspace", "add", root]);
        assert!(
            added.status.success(),
            "fixture: registering the workspace failed: {}",
            String::from_utf8_lossy(&added.stderr)
        );
        assert!(sandbox.reports_enabled(), "fixture: reports start on");
        sandbox
    }

    /// Run `chan` with `args` and a null standard input, isolated from the
    /// ambient chan environment.
    fn chan(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_chan"))
            .args(args)
            .env_clear()
            .envs(chan::test_env::scrubbed_process_env())
            .env("CHAN_HOME", self.chan_home.path())
            .env("HOME", self.home.path())
            .env("CHAN_NO_DESKTOP_HANDOFF", "1")
            .env("CHAN_NO_DEVSERVER_HANDOFF", "1")
            .stdin(Stdio::null())
            .output()
            .expect("run chan")
    }

    fn reports(&self, verb: &str, extra: &[&str]) -> Output {
        let root = self.root.path().to_str().expect("utf-8 root");
        let mut args = vec!["workspace", "reports", verb, "--path", root];
        args.extend_from_slice(extra);
        self.chan(&args)
    }

    /// The persisted reports flag, read from the workspace the CLI wrote.
    fn reports_enabled(&self) -> bool {
        let library =
            chan_workspace::Library::open_at(self.chan_home.path().join("config.toml"))
                .expect("open the sandbox library");
        library
            .open_workspace(Path::new(self.root.path()))
            .expect("open the workspace")
            .reports_enabled()
            .expect("read the reports flag")
    }
}

/// Without `--yes` and without a terminal to confirm on, the disable refuses:
/// it exits nonzero, names `--yes`, and leaves reports on.
#[test]
fn a_disable_without_a_terminal_or_yes_refuses() {
    let sandbox = Sandbox::new();
    let out = sandbox.reports("disable", &[]);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        !out.status.success(),
        "a disable with no terminal and no --yes exited 0: {stderr}"
    );
    assert!(
        stderr.contains("--yes"),
        "the refusal does not name --yes: {stderr}"
    );
    assert!(
        sandbox.reports_enabled(),
        "a refused disable turned reports off"
    );
}

/// `--yes` disables with no terminal and no prompt, and enable turns reports
/// back on without asking.
#[test]
fn a_disable_with_yes_and_an_enable_need_no_terminal() {
    let sandbox = Sandbox::new();
    let out = sandbox.reports("disable", &["--yes"]);
    assert!(
        out.status.success(),
        "a disable with --yes failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        !String::from_utf8_lossy(&out.stderr).contains("Continue?"),
        "a disable with --yes prompted"
    );
    assert!(!sandbox.reports_enabled(), "a disable with --yes left reports on");

    let out = sandbox.reports("enable", &[]);
    assert!(
        out.status.success(),
        "an enable failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(sandbox.reports_enabled(), "an enable left reports off");
}
