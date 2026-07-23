//! `chan-shell`: the `cs` control-socket client, shared by the `chan`
//! binary and `chan-desktop` so desktop users get `cs` (and the MCP
//! discovery it carries) without a separate `chan` install.
//!
//! Two layers:
//!
//!   - The WIRE types ([`ControlRequest`] / [`ControlResponse`]) are
//!     always compiled (serde only). chan-server depends on chan-shell
//!     with `default-features = false` to share them, which is what kills
//!     the old client/server duplication.
//!   - The `client` feature (default) adds the clap surface
//!     ([`ShellAction`] / [`TerminalAction`]), the [`dispatch`] entry, the
//!     control transport, and the agent [`SubmitAgent`] submit map. The
//!     `chan` / `chan-desktop` binaries enable it; chan-server does not.

mod wire;
pub use wire::{
    ControlRequest, ControlResponse, Identity, PaneOp, PastePrefer, ServeKind, SplitDir,
    SurveyReply, SurveySpec, TeamOp, TermWriteSubmit, GRAPH_LINK_PREFIX, MAX_CLIPBOARD_BYTES,
    MAX_CONTROL_REQUEST_BYTES,
};

#[cfg(feature = "client")]
mod cli;
#[cfg(feature = "client")]
mod control;
// Long-form `cs` help, as consts. Client-gated with the clap surface it
// feeds, so chan-server does not link a few hundred KB of manual text.
#[cfg(feature = "client")]
mod help;
// Named exit codes for the client (the `cs terminal survey --timeout` 124
// path) and the typed error that carries one. Client-only: the server links
// the wire types without it.
#[cfg(feature = "client")]
mod exit_code;
// The submit map is always compiled (serde-free, clap-free): chan-server's
// server-side team spawner reads the agent submit chords without pulling the
// `client` feature (clap). Only the `ValueEnum` parse impl for the
// `--submit` flag is `client`-gated, inside the module.
mod submit;

#[cfg(feature = "client")]
pub use cli::{
    dispatch, parse_cs, render_workspace_search_markdown, run_cs, CsCli, ShellAction,
    TerminalAction, WorkspaceSearchArgs,
};
#[cfg(feature = "client")]
pub use control::{
    absolutize, control_socket_env, open_env, open_env_from, send_control_request, OpenEnv,
};
pub use submit::{
    apply_submit_chord, plan_submitted_input, set_chord_overrides, splits_submit_chord,
    submit_chord_bytes, submit_writes, submitted_body_bytes, PtyInputPlan, ResolvedSubmit,
    SubmitAgent, SubmitTemplateSource,
};

/// Whether this process was invoked through a `cs` name (a `cs -> chan`
/// symlink on PATH, or chan-desktop launched as `cs`). Both `chan`'s
/// `parse_cli` and chan-desktop's entry use this so the `cs` alias
/// detection is defined once; a match routes the argv into [`parse_cs`] /
/// [`run_cs`]. The file stem comparison ignores any directory and
/// extension, so `/usr/local/bin/cs` and a bare `cs` both match.
#[cfg(feature = "client")]
pub fn invoked_as_cs(arg0: &std::ffi::OsStr) -> bool {
    invoked_as(arg0, "cs")
}

/// Whether this process was invoked through a `chan` name. chan-desktop
/// dispatches the `chan` CLI in-process (`chan::run(.., Personality::Desktop)`)
/// when launched through a `~/.local/bin/chan` shim, exactly as it already
/// does for `cs`. The same file-stem rule as [`invoked_as_cs`] applies, so a
/// real symlink, an AppImage wrapper, and a bare `chan` all match.
#[cfg(feature = "client")]
pub fn invoked_as_chan(arg0: &std::ffi::OsStr) -> bool {
    invoked_as(arg0, "chan")
}

/// Shared file-stem comparison behind [`invoked_as_cs`] / [`invoked_as_chan`]:
/// ignore any directory and extension so `/usr/local/bin/<name>` and a bare
/// `<name>` both match.
#[cfg(feature = "client")]
fn invoked_as(arg0: &std::ffi::OsStr, name: &str) -> bool {
    std::path::Path::new(arg0)
        .file_stem()
        .map(|stem| stem == name)
        .unwrap_or(false)
}

/// The name this process was invoked as, for the `cs` / `chan` stem checks.
///
/// Prefers `$ARGV0` over `argv[0]`. On a packaged Linux AppImage, linuxdeploy's
/// `AppRun` re-execs the inner binary WITHOUT preserving `argv[0]`, so
/// `std::env::args_os().next()` is the inner binary path -- not the `cs` /
/// `chan` the user invoked through an `exec -a <name> "$APPIMAGE"` shim. The
/// type-2 AppImage runtime instead exports that `exec -a` name as `$ARGV0`, so
/// reading it recovers the intended stem. Off an AppImage `$ARGV0` is unset and
/// this is just `argv[0]`.
///
/// Only the STEM matters to callers ([`invoked_as_cs`] / [`invoked_as_chan`]);
/// the args you actually parse should still come from `std::env::args_os()`
/// (clap ignores the program-name slot).
#[cfg(feature = "client")]
pub fn invoked_arg0() -> std::ffi::OsString {
    resolve_arg0(std::env::var_os("ARGV0"), || {
        std::env::args_os().next().unwrap_or_default()
    })
}

/// Pure core of [`invoked_arg0`], split out so the `$ARGV0` preference is
/// testable without mutating the process environment.
#[cfg(feature = "client")]
fn resolve_arg0<F>(argv0_env: Option<std::ffi::OsString>, fallback: F) -> std::ffi::OsString
where
    F: FnOnce() -> std::ffi::OsString,
{
    match argv0_env {
        Some(v) if !v.is_empty() => v,
        _ => fallback(),
    }
}

#[cfg(all(test, feature = "client"))]
mod arg0_tests {
    use super::{invoked_as_chan, invoked_as_cs, resolve_arg0};
    use std::ffi::{OsStr, OsString};

    #[test]
    fn resolve_arg0_prefers_nonempty_argv0_env() {
        // AppImage `exec -a cs "$APPIMAGE"`: the runtime exports $ARGV0=cs even
        // though argv[0] is the inner binary path. The stem must resolve to cs.
        let resolved = resolve_arg0(Some(OsString::from("cs")), || {
            OsString::from("/tmp/.mount_ChanXX/usr/bin/chan-desktop")
        });
        assert_eq!(resolved, OsString::from("cs"));
        assert!(invoked_as_cs(&resolved));
        assert!(!invoked_as_chan(&resolved));

        let resolved = resolve_arg0(Some(OsString::from("chan")), || {
            OsString::from("/tmp/.mount_ChanXX/usr/bin/chan-desktop")
        });
        assert!(invoked_as_chan(&resolved));
    }

    #[test]
    fn resolve_arg0_falls_back_when_argv0_env_absent_or_empty() {
        // Off an AppImage: $ARGV0 unset → argv[0] (here a `cs` symlink).
        assert_eq!(
            resolve_arg0(None, || OsString::from("/usr/local/bin/cs")),
            OsString::from("/usr/local/bin/cs")
        );
        // Empty $ARGV0 is treated as unset.
        assert_eq!(
            resolve_arg0(Some(OsString::new()), || OsString::from(
                "/usr/bin/chan-desktop"
            )),
            OsString::from("/usr/bin/chan-desktop")
        );
    }

    #[test]
    fn cs_matches_bare_path_and_extension() {
        assert!(invoked_as_cs(OsStr::new("cs")));
        assert!(invoked_as_cs(OsStr::new("/usr/local/bin/cs")));
        assert!(invoked_as_cs(OsStr::new("cs.exe")));
        assert!(!invoked_as_cs(OsStr::new("chan")));
        assert!(!invoked_as_cs(OsStr::new("/opt/chan-desktop")));
    }

    #[test]
    fn chan_matches_bare_path_and_appimage_wrapper() {
        assert!(invoked_as_chan(OsStr::new("chan")));
        assert!(invoked_as_chan(OsStr::new("/home/u/.local/bin/chan")));
        assert!(invoked_as_chan(OsStr::new("chan.exe")));
        // The desktop binary's own name must NOT be seen as `chan`, or a
        // normal GUI launch would re-dispatch into the CLI forever.
        assert!(!invoked_as_chan(OsStr::new("chan-desktop")));
        assert!(!invoked_as_chan(OsStr::new(
            "/Applications/Chan.app/Contents/MacOS/chan-desktop"
        )));
        assert!(!invoked_as_chan(OsStr::new("cs")));
    }
}
