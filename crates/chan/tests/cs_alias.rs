//! The `cs` alias: invoking the chan binary through a `cs` symlink routes
//! argv through chan-shell's own `cs` parser (the same parse chan-desktop
//! uses), then dispatches like `chan shell <action>`. One parse means one
//! help rendering: usage lines read `cs <cmd>`, never `cs shell <cmd>`.
//! Installs provide that name in several shapes; these tests create a
//! symlink in a tempdir and exercise dispatch and help.

#![cfg(unix)]

use std::os::unix::fs::symlink;
use std::process::Command;

/// Symlink `cs -> chan` in a fresh tempdir and return its path.
fn cs_symlink() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let cs = dir.path().join("cs");
    symlink(env!("CARGO_BIN_EXE_chan"), &cs).expect("symlink cs -> chan");
    (dir, cs)
}

#[test]
fn cs_terminal_list_dispatches_to_shell() {
    let (_dir, cs) = cs_symlink();
    // Outside a chan terminal there is no control socket, so `cs terminal
    // list` errors for the missing $CHAN_CONTROL_SOCKET. That the
    // `terminal` subcommand parses AT ALL proves the `cs -> shell`
    // rewrite: plain `chan terminal list` would be an unknown subcommand.
    let output = Command::new(&cs)
        .args(["terminal", "list"])
        .env_remove("CHAN_CONTROL_SOCKET")
        .env_remove("CHAN_WINDOW_ID")
        .output()
        .expect("run cs terminal list");

    assert!(
        !output.status.success(),
        "cs terminal list should fail without a control socket"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("CHAN_CONTROL_SOCKET"),
        "expected the missing-control-socket error, got: {stderr}"
    );
}

#[test]
fn cs_help_shows_shell_subcommands() {
    let (_dir, cs) = cs_symlink();
    // `cs --help` is `chan shell --help`, so its usage lists the shell
    // actions (terminal / graph / dashboard), not the top-level commands.
    let output = Command::new(&cs)
        .arg("--help")
        .output()
        .expect("run cs --help");

    assert!(output.status.success(), "cs --help should succeed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("terminal"),
        "shell help should list `terminal`: {stdout}"
    );
    assert!(
        stdout.contains("dashboard"),
        "shell help should list `dashboard`: {stdout}"
    );
    // A top-level-only command must not appear: this is the shell group.
    // `upgrade` is top-level-only and (unlike `open`) is not also a `cs`
    // action, so its absence proves this is the shell surface.
    assert!(
        !stdout.contains("upgrade"),
        "shell help should not list the top-level `upgrade`: {stdout}"
    );
}

/// Drop ANSI style sequences (`ESC [ ... <letter>`) so the help assertions
/// hold whether or not clap's color detection kicks in.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            for c2 in chars.by_ref() {
                if c2.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[test]
fn cs_help_usage_is_cs_not_cs_shell() {
    let (_dir, cs) = cs_symlink();
    // `cs --help` parses through chan-shell's `cs` parser, so the usage
    // line names `cs` itself -- no `shell` level anywhere in the path.
    // (The word "shell" alone still appears in command prose, e.g. "the
    // shell's own reach"; the forbidden string is the `cs shell` path.)
    let output = Command::new(&cs)
        .arg("--help")
        .output()
        .expect("run cs --help");

    assert!(output.status.success(), "cs --help should succeed");
    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    assert!(
        stdout.contains("Usage: cs [OPTIONS] <COMMAND>"),
        "cs --help usage must be `cs`, got: {stdout}"
    );
    assert!(
        !stdout.contains("cs shell"),
        "cs --help must not render a `cs shell` path: {stdout}"
    );
}

#[test]
fn cs_terminal_help_usage_is_cs_terminal() {
    let (_dir, cs) = cs_symlink();
    let output = Command::new(&cs)
        .args(["terminal", "--help"])
        .output()
        .expect("run cs terminal --help");

    assert!(output.status.success(), "cs terminal --help should succeed");
    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    assert!(
        stdout.contains("Usage: cs terminal [OPTIONS] <COMMAND>"),
        "cs terminal --help usage must be `cs terminal`, got: {stdout}"
    );
    assert!(
        !stdout.contains("cs shell"),
        "cs terminal --help must not render a `cs shell` path: {stdout}"
    );
}

#[test]
fn chan_shell_help_keeps_its_own_usage() {
    // Explicit `chan shell` (no alias) still renders its own two-level
    // usage; the shared-parser routing applies only to a `cs` argv0.
    let output = Command::new(env!("CARGO_BIN_EXE_chan"))
        .args(["shell", "--help"])
        .output()
        .expect("run chan shell --help");

    assert!(output.status.success(), "chan shell --help should succeed");
    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    assert!(
        stdout.contains("Usage: chan shell [OPTIONS] <COMMAND>"),
        "chan shell --help usage must be `chan shell`, got: {stdout}"
    );
}

#[test]
fn cs_verbose_flag_parses_under_the_shared_parser() {
    let (_dir, cs) = cs_symlink();
    // The `cs` parser carries the same global `-v` the `chan` CLI has, so
    // `cs -v terminal list` parses and fails on the missing control
    // socket -- not on a clap usage error.
    let output = Command::new(&cs)
        .args(["-v", "terminal", "list"])
        .env_remove("CHAN_CONTROL_SOCKET")
        .env_remove("CHAN_WINDOW_ID")
        .output()
        .expect("run cs -v terminal list");

    assert!(
        !output.status.success(),
        "cs -v terminal list should fail without a control socket"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("CHAN_CONTROL_SOCKET"),
        "expected the missing-control-socket error (proving -v parses), got: {stderr}"
    );
}

#[test]
fn cs_session_self_bare_is_a_query_not_a_usage_error() {
    let (_dir, cs) = cs_symlink();
    // Bare `cs session self` is the whoami query, so with no chan terminal
    // env it fails on the missing $CHAN_WINDOW_ID -- NOT on a clap usage
    // error demanding --name/--reset.
    let output = Command::new(&cs)
        .args(["session", "self"])
        .env_remove("CHAN_CONTROL_SOCKET")
        .env_remove("CHAN_WINDOW_ID")
        .output()
        .expect("run cs session self");

    assert!(
        !output.status.success(),
        "cs session self should fail outside a chan session"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("CHAN_WINDOW_ID") || stderr.contains("CHAN_CONTROL_SOCKET"),
        "expected the missing-session-env error (proving the bare form parses), got: {stderr}"
    );
    assert!(
        !stderr.contains("required"),
        "bare `cs session self` must not be a clap usage error: {stderr}"
    );
}

#[test]
fn plain_chan_rejects_terminal_subcommand() {
    // Control: WITHOUT the `cs` rewrite, `chan terminal` is unknown. This
    // is what makes the rewrite load-bearing.
    let output = Command::new(env!("CARGO_BIN_EXE_chan"))
        .args(["terminal", "list"])
        .output()
        .expect("run chan terminal list");

    assert!(!output.status.success(), "chan terminal list should fail");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("unrecognized subcommand") || stderr.contains("unexpected"),
        "expected an unknown-subcommand error, got: {stderr}"
    );
}

#[test]
fn cs_prefix_match_resolves_terminal_list() {
    let (_dir, cs) = cs_symlink();
    // iproute2-style prefix matching: `cs t l` == `cs terminal list` via
    // clap infer_subcommands (t -> terminal, l -> list). That it resolves
    // far enough to fail on the missing control socket (rather than an
    // unknown-subcommand error) proves the prefix dispatch.
    let output = Command::new(&cs)
        .args(["t", "l"])
        .env_remove("CHAN_CONTROL_SOCKET")
        .env_remove("CHAN_WINDOW_ID")
        .output()
        .expect("run cs t l");

    assert!(
        !output.status.success(),
        "cs t l should fail without a control socket"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("CHAN_CONTROL_SOCKET"),
        "expected the missing-control-socket error (proving t->terminal, l->list), got: {stderr}"
    );
}

#[test]
fn inherited_argv0_does_not_steer_the_alias() {
    // Off Windows the invoked name arrives in argv[0], so `$ARGV0` is not
    // consulted at all. A packaged Linux AppImage exports the variable and
    // every process it starts inherits it, so an inherited value must not be
    // able to turn `chan` into `cs` or the reverse.
    //
    // `chan` invoked as `chan` with ARGV0=cs stays the chan CLI: `terminal`
    // is not one of its subcommands.
    let output = Command::new(env!("CARGO_BIN_EXE_chan"))
        .args(["terminal", "list"])
        .env("ARGV0", "cs")
        .env_remove("CHAN_CONTROL_SOCKET")
        .env_remove("CHAN_WINDOW_ID")
        .output()
        .expect("run chan terminal list with ARGV0=cs");

    assert!(!output.status.success(), "chan terminal list should fail");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("unrecognized subcommand"),
        "ARGV0 must not alias chan to cs off Windows, got: {stderr}"
    );

    // And the symlink keeps winning: `cs` invoked as `cs` with ARGV0=chan
    // still dispatches the cs client, failing on the missing control socket
    // rather than on an unknown subcommand.
    let (_dir, cs) = cs_symlink();
    let output = Command::new(&cs)
        .args(["terminal", "list"])
        .env("ARGV0", "chan")
        .env_remove("CHAN_CONTROL_SOCKET")
        .env_remove("CHAN_WINDOW_ID")
        .output()
        .expect("run cs terminal list with ARGV0=chan");

    assert!(!output.status.success(), "cs terminal list should fail");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("CHAN_CONTROL_SOCKET"),
        "ARGV0 must not un-alias cs off Windows, got: {stderr}"
    );
}
