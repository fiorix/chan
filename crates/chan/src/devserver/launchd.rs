use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};

use crate::devserver::management::{emit_devserver_token_marker, DEVSERVER_TOKEN_WAIT};
use crate::devserver::persisted::{
    devserver_chan_home, devserver_log_path, keeps_recorded_service_path, launch_agent_path,
    recorded_launch_agent_search_path,
};
use crate::devserver::relaunch::resolve_relaunchable_exe;
use crate::devserver::supervisor::{
    current_uid, launchctl, launchd_domain_target, launchd_is_active, launchd_service_target,
    run_tool, wait_until_launchd_active, DEVSERVER_LAUNCHD_LABEL,
};
use crate::devserver::watchdog::{run_health_watchdog, DaemonLiveness};

// ---------------------------------------------------------------------------
// macOS launchd backend -- mirrors the systemd backend above. The functions are
// always compiled (they only shell out to `launchctl`) and called only under
// `cfg!(target_os = "macos")`; the pure helpers stay unit-testable on any host.
// ---------------------------------------------------------------------------

/// `chan devserver start --service=launchd`: ensure the agent is up
/// (write/enable/bootstrap when it is not already running), then return. A
/// LaunchAgent in the `gui/<uid>` domain outlives the launching shell and the
/// GUI login session (it does NOT survive a full logout; that would need a root
/// LaunchDaemon). Idempotent: a no-op (beyond re-providing the token) when it is
/// already active.
pub(crate) async fn start_devserver_under_launchd(addr: SocketAddr) -> Result<()> {
    let uid = current_uid().await?;
    if launchd_is_active(uid).await {
        emit_devserver_token_marker(DEVSERVER_TOKEN_WAIT).await?;
        eprintln!(
            "chan devserver: the launchd agent {DEVSERVER_LAUNCHD_LABEL} is already running."
        );
        return Ok(());
    }
    bootstrap_launch_agent(uid, addr).await?;
    eprintln!("chan devserver: started the launchd agent {DEVSERVER_LAUNCHD_LABEL} (bind={addr}).");
    Ok(())
}

/// `chan devserver join --service=launchd`: ensure the agent is running (start
/// it if down, re-attach if up), then stay attached and follow its log until
/// Ctrl-C. Unlike `start` it does not return until the agent stops or the user
/// detaches.
pub(crate) async fn join_devserver_under_launchd(addr: SocketAddr) -> Result<()> {
    let uid = current_uid().await?;

    if launchd_is_active(uid).await {
        // Re-attaching to a running agent. Its stdout (with the token marker)
        // goes to the log file, not this terminal, so the supervisor re-provides
        // the token contract itself (see emit_devserver_token_marker).
        emit_devserver_token_marker(DEVSERVER_TOKEN_WAIT).await?;
        eprintln!(
            "chan devserver: re-attaching to the running launchd agent \
             {DEVSERVER_LAUNCHD_LABEL}"
        );
    } else {
        bootstrap_launch_agent(uid, addr).await?;
        eprintln!(
            "chan devserver: started the launchd agent {DEVSERVER_LAUNCHD_LABEL} \
             (bind={addr})"
        );
    }

    run_health_watchdog(
        &addr.to_string(),
        DaemonLiveness::Launchd { uid },
        &format!("launchd agent {DEVSERVER_LAUNCHD_LABEL}"),
    )
    .await
}

/// (Re)register and start the launchd agent for `addr`: rewrite the plist
/// (current binary + `addr`), bootout any stale registration, enable, bootstrap,
/// and wait until active. Always re-registers, so it doubles as the `restart`
/// reload (a `kickstart -k` alone would bounce the OLD plist). Surfaces the
/// bearer token. Shared by the first-start path and
/// [`restart_devserver_under_launchd`]; the caller owns the started/restarted
/// log line + watching the agent.
async fn bootstrap_launch_agent(uid: u32, addr: SocketAddr) -> Result<()> {
    let service = launchd_service_target(uid);
    let plist = write_devserver_launch_agent(addr)?;
    eprintln!("chan devserver: wrote {}", plist.display());
    // Clear any stale (loaded-but-dead, or running) registration so the freshly
    // written plist takes effect; best-effort, it errors when nothing is loaded.
    let _ = run_tool("launchctl", &["bootout", service.as_str()]).await;
    launchctl(&["enable", service.as_str()]).await?;
    let plist_arg = plist.to_string_lossy();
    launchctl(&["bootstrap", &launchd_domain_target(uid), plist_arg.as_ref()]).await?;
    if !wait_until_launchd_active(uid, Duration::from_secs(10)).await {
        anyhow::bail!(
            "chan devserver: the launchd agent {DEVSERVER_LAUNCHD_LABEL} \
             failed to start:\n{}",
            recent_launchd_log().await
        );
    }
    // Same direct-emit contract as the systemd path: the service logs its
    // own marker to the log file, invisible to this terminal, so surface it
    // from the persisted config and fail loud if it never lands.
    emit_devserver_token_marker(DEVSERVER_TOKEN_WAIT).await?;
    Ok(())
}

/// `chan devserver restart --service=launchd`: rewrite + re-register the agent
/// (current binary + `addr`) so it bounces (or starts if stopped), then return.
/// Use `join` to stay attached.
pub(crate) async fn restart_devserver_under_launchd(addr: SocketAddr) -> Result<()> {
    let uid = current_uid().await?;
    let was_running = launchd_is_active(uid).await;
    bootstrap_launch_agent(uid, addr).await?;
    eprintln!(
        "chan devserver: {} the launchd agent {DEVSERVER_LAUNCHD_LABEL} (bind={addr})",
        if was_running { "restarted" } else { "started" }
    );
    Ok(())
}

/// `chan devserver stop --service=launchd`: bootout the agent AND disable it,
/// so launchd does not re-bootstrap it at the next GUI login. Idempotent:
/// `bootout` errors when nothing is loaded, which we report as already-stopped;
/// `disable` is best-effort. The plist stays on disk, so `status` can still
/// show its last command; `start`/`restart` re-enable it.
pub(crate) async fn stop_devserver_under_launchd() -> Result<()> {
    let uid = current_uid().await?;
    let service = launchd_service_target(uid);
    let output = run_tool("launchctl", &["bootout", service.as_str()]).await?;
    // Persist the disable so RunAtLoad does not relaunch it at login. Best-effort:
    // a no-op when it was never enabled, and it must not fail the stop.
    let _ = run_tool("launchctl", &["disable", service.as_str()]).await;
    if output.status.success() {
        eprintln!(
            "chan devserver: stopped and disabled the launchd agent {DEVSERVER_LAUNCHD_LABEL}."
        );
    } else {
        eprintln!(
            "chan devserver: the launchd agent {DEVSERVER_LAUNCHD_LABEL} is not running (disabled)."
        );
    }
    Ok(())
}

/// Write the LaunchAgent plist whose `ProgramArguments` run the resolved `chan`
/// CLI's foreground devserver on `addr`. Returns the plist path.
fn write_devserver_launch_agent(addr: SocketAddr) -> Result<PathBuf> {
    use std::io::IsTerminal;
    let exe = resolve_relaunchable_exe()?;
    let log = devserver_log_path()?;
    if let Some(parent) = log.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let plist_path = launch_agent_path()?;
    if let Some(parent) = plist_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    // launchd starts the agent with its own environment, so the plist
    // records a PATH for the same reason the systemd unit does, chosen by
    // the same rule.
    let installed = std::fs::read_to_string(&plist_path).ok();
    let search_path = launch_agent_search_path(
        &std::env::var_os("PATH").unwrap_or_default(),
        installed.as_deref(),
        std::io::stdin().is_terminal(),
    );
    let plist = devserver_launch_agent_plist(
        &exe,
        addr,
        &log,
        devserver_chan_home().as_deref(),
        search_path.as_deref(),
    );
    std::fs::write(&plist_path, plist)
        .with_context(|| format!("writing {}", plist_path.display()))?;
    Ok(plist_path)
}

/// The `PATH` the LaunchAgent plist records when it replaces `installed`:
/// the one `installed` records when [`keeps_recorded_service_path`] says so,
/// else the entries of `current` that [`chan_systemd::service_search_path`]
/// keeps, the same filter the systemd unit applies.
fn launch_agent_search_path(
    current: &std::ffi::OsStr,
    installed: Option<&str>,
    interactive: bool,
) -> Option<String> {
    match installed.and_then(recorded_launch_agent_search_path) {
        Some(recorded) if keeps_recorded_service_path(current, interactive) => Some(recorded),
        _ => chan_systemd::service_search_path(current),
    }
}

/// Build the LaunchAgent plist XML. `RunAtLoad` starts it on bootstrap;
/// `KeepAlive`/`SuccessfulExit=false` restarts it only on a crash (the launchd
/// analogue of systemd `Restart=on-failure`); stdout/stderr go to `log`.
pub(crate) fn devserver_launch_agent_plist(
    exe: &Path,
    addr: SocketAddr,
    log: &Path,
    chan_home: Option<&str>,
    search_path: Option<&str>,
) -> String {
    // launchd starts the agent with a fresh environment, so a CHAN_HOME-scoped
    // supervisor bakes it into the plist; else the agent runs against ~/.chan.
    // The PATH is the one `launch_agent_search_path` chose. The dict follows
    // ProgramArguments, where persisted_command_line reads the flags.
    let mut variables = String::new();
    for (key, value) in [("CHAN_HOME", chan_home), ("PATH", search_path)] {
        if let Some(value) = value {
            variables.push_str(&format!(
                "    <key>{key}</key>\n    <string>{}</string>\n",
                xml_escape(value)
            ));
        }
    }
    let environment = if variables.is_empty() {
        String::new()
    } else {
        format!("  <key>EnvironmentVariables</key>\n  <dict>\n{variables}  </dict>\n")
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>devserver</string>
    <string>run</string>
    <string>--bind={ip}</string>
    <string>--port={port}</string>
  </array>
{environment}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"#,
        label = DEVSERVER_LAUNCHD_LABEL,
        exe = xml_escape(&exe.to_string_lossy()),
        ip = addr.ip(),
        port = addr.port(),
        log = xml_escape(&log.to_string_lossy()),
    )
}

/// Minimal XML text escaping for plist `<string>` values (paths).
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The last lines of the agent's log file, for a failure message.
async fn recent_launchd_log() -> String {
    let path = match devserver_log_path() {
        Ok(p) => p,
        Err(e) => return format!("(could not resolve the log path: {e})"),
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let mut tail: Vec<&str> = text.lines().rev().take(30).collect();
            tail.reverse();
            tail.join("\n")
        }
        Err(e) => format!("(could not read {}: {e})", path.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devserver::persisted::{
        devserver_addr_from_persisted_args, launchd_program_arguments,
    };

    #[test]
    fn launch_agent_plist_carries_program_and_keys() {
        let plist = devserver_launch_agent_plist(
            Path::new("/usr/local/bin/chan"),
            "127.0.0.1:8799".parse().unwrap(),
            Path::new("/Users/x/.chan/devserver/devserver.log"),
            None,
            None,
        );
        assert!(plist.contains("<string>app.chan.devserver</string>"));
        assert!(plist.contains("<string>/usr/local/bin/chan</string>"));
        assert!(plist.contains("<string>devserver</string>"));
        assert!(plist.contains("<string>run</string>"));
        assert!(plist.contains("<string>--bind=127.0.0.1</string>"));
        assert!(plist.contains("<string>--port=8799</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("<key>SuccessfulExit</key>"));
        assert!(plist.contains("<string>/Users/x/.chan/devserver/devserver.log</string>"));
        // Without CHAN_HOME there is no EnvironmentVariables block.
        assert!(!plist.contains("EnvironmentVariables"));
    }

    #[test]
    fn launch_agent_plist_propagates_chan_home() {
        let plist = devserver_launch_agent_plist(
            Path::new("/usr/local/bin/chan"),
            "127.0.0.1:8799".parse().unwrap(),
            Path::new("/tmp/iso/.chan/devserver/devserver.log"),
            Some("/tmp/iso & home"),
            None,
        );
        assert!(plist.contains("<key>EnvironmentVariables</key>"));
        assert!(plist.contains("<key>CHAN_HOME</key>"));
        // The value is XML-escaped like every other plist string.
        assert!(plist.contains("<string>/tmp/iso &amp; home</string>"));
    }

    #[test]
    fn launch_agent_plist_records_the_install_time_search_path() {
        let addr: SocketAddr = "127.0.0.1:8799".parse().unwrap();
        let plist = devserver_launch_agent_plist(
            Path::new("/usr/local/bin/chan"),
            addr,
            Path::new("/tmp/log"),
            Some("/tmp/iso"),
            Some("/Users/x/.local/bin:/opt/a&b/bin:/usr/bin"),
        );
        assert!(
            plist.contains(
                "  <key>EnvironmentVariables</key>\n  <dict>\n    <key>CHAN_HOME</key>\n    \
                 <string>/tmp/iso</string>\n    <key>PATH</key>\n    \
                 <string>/Users/x/.local/bin:/opt/a&amp;b/bin:/usr/bin</string>\n  </dict>\n"
            ),
            "the plist must record the PATH, XML-escaped, beside CHAN_HOME: {plist}"
        );
        // The environment follows the command, and neither the status line
        // nor the persisted address reads it.
        assert!(
            plist.find("<key>ProgramArguments</key>")
                < plist.find("<key>EnvironmentVariables</key>")
        );
        assert_eq!(
            launchd_program_arguments(&plist).as_deref(),
            Some("/usr/local/bin/chan devserver run --bind=127.0.0.1 --port=8799")
        );
        assert_eq!(devserver_addr_from_persisted_args(&plist), Some(addr));
        assert_eq!(
            recorded_launch_agent_search_path(&plist).as_deref(),
            Some("/Users/x/.local/bin:/opt/a&b/bin:/usr/bin")
        );
    }

    #[test]
    fn launch_agent_search_path_follows_the_unit_rule() {
        let plist = |search_path: Option<&str>| {
            devserver_launch_agent_plist(
                Path::new("/usr/local/bin/chan"),
                "127.0.0.1:8799".parse().unwrap(),
                Path::new("/tmp/log"),
                None,
                search_path,
            )
        };
        let installed = plist(Some("/Users/x/.local/bin:/usr/bin"));
        let script = std::ffi::OsStr::new("/usr/bin:/bin:relative:/usr/bin");

        assert_eq!(
            launch_agent_search_path(script, Some(&installed), false).as_deref(),
            Some("/Users/x/.local/bin:/usr/bin"),
            "a render without a terminal must keep the recorded PATH"
        );
        assert_eq!(
            launch_agent_search_path(script, Some(&installed), true).as_deref(),
            Some("/usr/bin:/bin"),
            "a render from a terminal must record its own PATH, filtered like the unit's"
        );
        for installed in [Some(plist(None)), None] {
            assert_eq!(
                launch_agent_search_path(script, installed.as_deref(), false).as_deref(),
                Some("/usr/bin:/bin"),
                "a plist with no recorded PATH must gain one"
            );
        }
        assert_eq!(
            launch_agent_search_path(std::ffi::OsStr::new("::bin:."), Some(&installed), true)
                .as_deref(),
            Some("/Users/x/.local/bin:/usr/bin"),
            "a PATH with no usable entry must not delete the recorded one"
        );
    }

    #[test]
    fn launch_agent_plist_escapes_xml_in_paths() {
        let plist = devserver_launch_agent_plist(
            Path::new("/opt/a & b/chan"),
            "127.0.0.1:1".parse().unwrap(),
            Path::new("/tmp/log"),
            None,
            None,
        );
        assert!(plist.contains("/opt/a &amp; b/chan"));
        assert!(!plist.contains("a & b/chan"));
    }
}
