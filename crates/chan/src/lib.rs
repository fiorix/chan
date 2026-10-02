// chan: a terminal emulator and multiplexer plus a workspace manager.
//
// This library holds the whole `chan` CLI surface so two binaries can
// drive it: the standalone `chan` binary (`src/main.rs`, a thin shim
// calling `run(.., Personality::Standalone)`) and chan-desktop, which
// dispatches `chan` in-process when invoked through a `~/.local/bin/chan`
// shim (`Personality::Desktop`). The only behavioural fork between the two
// is the `Personality` passed to [`run`]: see `cmd_serve` (browser vs
// desktop handoff) and `chan upgrade` (CLI tarball replace vs desktop
// updater).
//
// The top-level surface carries the process-lifecycle and app-level
// commands; the workspace registry and per-workspace content operations
// are grouped under `chan workspace`. `chan --help` is the command list.
//
// Anything that touches the registry / workspace contents goes through
// `chan_workspace::Library` and `chan_workspace::Workspace` so the library's
// invariants (atomic writes, path sandbox, special-file refusal,
// cross-process writer lock) apply uniformly.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use anyhow::Result;

use crate::cli::{
    cmd_completions, parse_cli, Command, ContactsAction, ImportSource, WorkspaceAction,
};
use crate::close::cmd_close_cli;
use crate::config::cmd_config;
use crate::contacts::cmd_contacts_import_csv;
use crate::desktop::{cmd_upgrade_desktop, decide_upgrade_route, desktop_companion, UpgradeRoute};
use crate::devserver::cmd_devserver_action;
use crate::devserver::foreground::build_devserver_tunnel_from_env;
use crate::index::cmd_index;
use crate::mcp::{cmd_mcp, cmd_mcp_proxy};
use crate::metadata::cmd_metadata;
use crate::registry::{cmd_add, cmd_list};
use crate::reports::cmd_reports;
use crate::search::cmd_workspace_search;
use crate::serve::cmd_serve_cli;
use crate::status::{cmd_ps, cmd_status};

mod cli;
mod close;
mod config;
mod contacts;
mod control;
mod desktop;
mod devserver;
mod index;
mod mcp;
mod metadata;
mod parentage;
mod registry;
mod remote;
mod reports;
mod search;
mod serve;
mod status;
#[cfg(test)]
mod test_support;
mod update;

/// The build script's own rules. `build.rs` pulls this file in with
/// `include!` and is the only production consumer; mounting it here under
/// `cfg(test)` is what puts those rules under `cargo test`, which a build
/// script's own code otherwise never gets.
#[cfg(test)]
#[path = "build_id.rs"]
mod build_id;

/// `chan dump-skill`: the agent-facing skill document, rendered from the
/// clap trees so it cannot drift from the help it documents.
mod skill;

/// Long-form help for the `chan` commands, as consts.
mod help;

/// The `--service=chan` self-managed daemon: a cross-OS background devserver
/// guarded by a single-instance pidfile + flock (the systemd/launchd analog
/// where there is no OS supervisor, and the portable choice everywhere).
mod devserver_daemon;
pub use devserver_daemon::self_managed_devserver_pid;

/// Serialized ambient-`CHAN_*` isolation for env-reading tests and spawned
/// test children. Not `cfg(test)` because integration tests link this crate
/// without it.
#[doc(hidden)]
pub mod test_env;

/// Default listen port shared by `chan serve` (standalone serve) and
/// `chan devserver`. Single-sourced so the two cannot drift: `cmd_serve` relies
/// on them being equal to recognize the "a devserver already owns 8787" bind
/// collision and print an actionable hint instead of a bare "address in use".
const DEFAULT_PORT: u16 = 8787;

/// The devserver's default bind when `--bind` is omitted and no running service
/// supplies one: loopback, matching the `--bind` help and the foreground default.
const DEFAULT_DEVSERVER_BIND: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

/// The in-app chord table, generated from
/// `web/packages/workspace-app/src/state/shortcuts.ts` (the single source
/// of truth for chan's chords) by
/// `node web/packages/workspace-app/scripts/shortcuts-table.mjs --serve-long-about`.
/// Paste that command's output here verbatim; `make shortcuts-check` fails
/// when the two drift. The native shell layers VS Code-shaped chords on
/// top of the browser set; those are documented in the same TS source.
///
/// The body opens on the quote's own line rather than after a `\`
/// continuation, because that escape eats the newline and every leading
/// space after it, which would strip the first row's table indent.
const KEYBINDINGS_TABLE: &str = "  App
  ---
  Command launcher                             Ctrl+Alt+K
  Settings                                     Cmd+,
  Search                                       Cmd+Shift+S
      (Ctrl+Alt+S on Linux / Windows)
  New terminal                                 Ctrl+Shift+T
      (Cmd+T on macOS desktop; or Mod+. t (Hybrid Nav))
  Reload window                                Cmd+R
      (Ctrl+Shift+R on Linux / Windows)
  Dismiss overlay                              Esc

  File
  ----
  Delete file or directory                     Backspace

  Panes
  -----
  Hybrid Nav                                   Cmd+.
  Flip pane side                               Ctrl+`
  Previous pane                                Alt+[
  Next pane                                    Alt+]
  Split right                                  Ctrl+Alt+/
  Split bottom                                 Ctrl+Alt+?

  Tabs
  ----
  Close tab                                    Ctrl+D
      (Cmd+W on macOS, Ctrl+Shift+W on the Linux / Windows desktop)
  Reopen closed tab                            Ctrl+Alt+Shift+T
      (Cmd+Shift+T on macOS desktop)
  Next tab                                     Alt+Shift+]
  Previous tab                                 Alt+Shift+[
  Jump to tab N                                Ctrl+Alt+1..9

  Editor
  ------
  Show Source Code (toggle rendered/source)    Cmd+E
  Bold                                         Cmd+B
  Italic                                       Cmd+I
  Preview slide deck                           Cmd+Enter
  Present slide deck fullscreen                Cmd+Shift+Enter

  Terminal
  --------
  Copy selection                               Cmd+C
      (Ctrl+Shift+C on Linux / Windows)
  Paste                                        Cmd+V
      (Ctrl+Shift+V on Linux / Windows)
  Show/Hide Rich Prompt                        Cmd+Shift+P
      (Ctrl+Shift+P on Linux / Windows)
  Find in terminal                             Cmd+F
";

/// The build this binary was made from, stamped by `build.rs`.
///
/// The release version cannot name a build on its own: the version pins move
/// only at release cut, so every branch build between two cuts reports the
/// previous release's version. This is what separates them, and it is the same
/// value the server's health surfaces carry, so an id read through a tunnel
/// and an id read from `chan --version` are comparable.
pub const BUILD_ID: &str = env!("CHAN_BUILD_ID");

/// Which binary is driving the `chan` CLI, and therefore how the
/// desktop-aware subcommands behave.
///
/// - [`Personality::Standalone`] -- the `chan` binary from install.sh (and
///   the `cs -> chan` symlink). With both a desktop and devserver live,
///   `chan serve` prefers the devserver; with neither it runs its own server
///   and opens the browser.
///   `chan upgrade` replaces the CLI tarball in place.
/// - [`Personality::Desktop`] -- chan-desktop invoked as `chan` (via the
///   `~/.local/bin/chan` shim). `chan serve` integrates with the desktop:
///   it prefers a live devserver when no desktop is running, otherwise hands
///   the workspace to the desktop or launches the GUI.
///   `chan upgrade` drives the desktop's `tauri-plugin-updater`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Personality {
    Standalone,
    Desktop,
}

/// Which backend backs `chan devserver --service`. `Auto` (the CLI value
/// `auto`, the default) resolves per-OS at runtime: with an action verb it
/// supervises under systemd (Linux), launchd (macOS), or the self-managed `chan`
/// daemon (Windows); with no action verb it runs the plain foreground server.
/// `None` (`none`) forces that unsupervised foreground server, and `Chan` /
/// `Systemd` / `Launchd` each force a specific backend explicitly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum ServiceKind {
    // These doc comments are the possible-values list in `--help`, and clap
    // renders each as ONE line however it is wrapped here. Keep them to a
    // single short sentence; the per-OS resolution table is in the command's
    // long help, where there is room for it.
    /// Per-OS auto-pick, the default
    #[value(name = "auto")]
    Auto,
    /// No supervision: run in the foreground, Ctrl-C stops
    #[value(name = "none")]
    None,
    /// The cross-OS self-managed background daemon
    Chan,
    /// A systemd user service (Linux only).
    Systemd,
    /// A launchd LaunchAgent (macOS only).
    Launchd,
}

impl ServiceKind {
    /// The `--service=<name>` value, for error messages.
    fn cli_name(self) -> &'static str {
        match self {
            ServiceKind::Auto => "auto",
            ServiceKind::None => "none",
            ServiceKind::Chan => "chan",
            ServiceKind::Systemd => "systemd",
            ServiceKind::Launchd => "launchd",
        }
    }
}

/// Parse `args` and run the selected subcommand to completion.
///
/// This is the single entry point for the whole `chan` CLI. The caller owns
/// the tokio runtime (so it can pick the multi-threaded flavour `serve`
/// needs and `shutdown_background()` to detach chan-workspace's uncancellable
/// reindex pool on exit); everything here runs inside it. Sync subcommands
/// execute inline on the runtime thread, which is fine for a
/// run-one-thing-and-exit CLI.
pub async fn run<I, T>(args: I, personality: Personality) -> Result<()>
where
    I: IntoIterator<Item = T>,
    T: Into<std::ffi::OsString> + Clone,
{
    // Hand the binary's identity to the server library before any subcommand
    // can start one. chan-server cannot stamp this itself -- it is a library,
    // and the id belongs to the binary linking it.
    chan_server::set_build_id(BUILD_ID);

    let cli = parse_cli(args);
    init_tracing(cli.verbose);
    let verbose = cli.verbose > 0;

    match cli.command {
        Command::Workspace { action } => match action {
            WorkspaceAction::Add {
                path,
                semantic_search,
                reports,
            } => cmd_add(path, semantic_search, reports),
            WorkspaceAction::Ls { json } => cmd_list(json),
            WorkspaceAction::Serve { args } => cmd_serve_cli(args, personality, verbose).await,
            WorkspaceAction::Close { args } => {
                cmd_close_cli(args.path, args.on, false, personality).await
            }
            WorkspaceAction::Forget { args } => {
                cmd_close_cli(args.path, args.on, true, personality).await
            }
            WorkspaceAction::Index { action } => cmd_index(action),
            WorkspaceAction::Reports { action } => cmd_reports(action),
            WorkspaceAction::Search {
                search,
                targets,
                json,
                pretty,
            } => cmd_workspace_search(search.to_request()?, targets, json, pretty).await,
            WorkspaceAction::Graph {
                graph,
                targets,
                json,
                pretty,
            } => cmd_workspace_search(graph.to_request()?, targets, json, pretty).await,
            WorkspaceAction::Status { path, json } => cmd_status(path, json).await,
            WorkspaceAction::Metadata { action } => cmd_metadata(action),
            WorkspaceAction::Contacts { action } => match action {
                ContactsAction::Import { source } => match source {
                    ImportSource::Csv {
                        file,
                        into,
                        provider,
                        dry_run,
                        overwrite,
                        workspace,
                    } => {
                        cmd_contacts_import_csv(file, into, provider, dry_run, overwrite, workspace)
                    }
                },
            },
        },
        Command::Shell { action } => chan_shell::dispatch(action, dump_skill).await,
        Command::Completions { shell } => cmd_completions(shell),
        Command::DumpSkill { args } => dump_skill(args),
        Command::Close { args, forget } => {
            cmd_close_cli(args.path, args.on, forget, personality).await
        }
        Command::Serve { args } => cmd_serve_cli(args, personality, verbose).await,
        Command::Ps { json } => cmd_ps(json).await,
        Command::Devserver { action } => cmd_devserver_action(action, verbose).await,
        Command::DevserverDaemon {
            bind,
            port,
            tunnel_url,
            tunnel_devserver_name,
        } => {
            let addr = SocketAddr::new(bind, port);
            let tunnel = build_devserver_tunnel_from_env(tunnel_url, tunnel_devserver_name)?;
            devserver_daemon::run_devserver_daemon_child(addr, tunnel).await
        }
        Command::Config { action } => cmd_config(action),
        Command::Upgrade {
            yes,
            check,
            version,
        } => match decide_upgrade_route(
            personality,
            update::packaged_via(),
            desktop_companion(cfg!(windows), chan_server::handoff::handoff_forced()),
        ) {
            // A distro-packaged build: the package manager owns the files.
            UpgradeRoute::Refuse(message) => anyhow::bail!(message),
            // Standalone (install.sh / install.ps1) replaces its CLI archive
            // in place.
            UpgradeRoute::Cli => {
                update::run_upgrade(update::UpgradeOptions {
                    assume_yes: yes,
                    check_only: check,
                    version_override: version,
                    verbose,
                })
                .await
            }
            // Desktop drives the running desktop's tauri-plugin-updater
            // instead (no tarball). `yes` is moot -- the fire-and-return flow
            // has no prompt.
            UpgradeRoute::Desktop => cmd_upgrade_desktop(check, version).await,
        },
        Command::Mcp { path } => cmd_mcp(path).await,
        Command::McpProxy { socket } => cmd_mcp_proxy(socket).await,
    }
}

fn init_tracing(verbosity: u8) {
    let level = match verbosity {
        0 => "warn",
        1 => "info",
        2 => "debug",
        _ => "trace",
    };
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| fallback_filter(level)),
        )
        .with_writer(std::io::stderr)
        .init();
}

/// tokei (pulled in transitively by chan-report for the language-count
/// lens) logs `Unknown extension: <ext>` at WARN through tokei's own
/// `LanguageType::from_path` for every file it can't classify. chan-report
/// is default-on (`DashboardConfig::reports_enabled = true`), so on a source
/// tree with reports enabled this is pure console noise with no downstream
/// effect (the graph language lens already degrades when a bucket is
/// absent). Cap tokei at ERROR so the spam disappears but genuine tokei
/// errors still surface.
///
/// Applied to the FALLBACK filter only (`RUST_LOG` parses first via
/// `try_from_default_env`), so anyone who explicitly wants tokei detail
/// keeps full control by setting `RUST_LOG`.
const TOKEI_LOG_DIRECTIVE: &str = "tokei=error";

fn fallback_filter(level: &str) -> tracing_subscriber::EnvFilter {
    tracing_subscriber::EnvFilter::new(level).add_directive(
        TOKEI_LOG_DIRECTIVE
            .parse()
            .expect("static tokei log directive parses"),
    )
}

/// Print the offline agent manual for either CLI personality. The desktop
/// supplies this same renderer to chan-shell so both entrypoints agree.
pub fn dump_skill(args: chan_shell::DumpSkillArgs) -> Result<()> {
    let out = skill::render_output(&args)?;
    print!("{out}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `make shortcuts-check` diffs the SOURCE text of `KEYBINDINGS_TABLE`
    /// against the generator, so it cannot see an escape that changes the
    /// compiled value. This asserts on the value itself: every row of the
    /// chord table carries the two-space indent the help framing expects.
    #[test]
    fn keybindings_table_rows_keep_the_help_indent() {
        let unindented: Vec<&str> = KEYBINDINGS_TABLE
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with("  "))
            .collect();
        assert!(
            unindented.is_empty(),
            "KEYBINDINGS_TABLE rows lost the table indent:\n  {}",
            unindented.join("\n  ")
        );
        assert!(
            KEYBINDINGS_TABLE.lines().filter(|l| !l.is_empty()).count() > 10,
            "KEYBINDINGS_TABLE looks empty"
        );
    }

    /// The fallback filter must (1) parse the static tokei directive
    /// without panicking at startup for every verbosity level and (2)
    /// actually carry the tokei cap. A malformed directive would panic
    /// the binary on launch; a dropped directive would let the spam back.
    #[test]
    fn fallback_filter_caps_tokei_for_every_level() {
        for level in ["warn", "info", "debug", "trace"] {
            let rendered = fallback_filter(level).to_string();
            assert!(
                rendered.contains("tokei"),
                "level {level} filter dropped the tokei directive: {rendered}"
            );
        }
    }
}
