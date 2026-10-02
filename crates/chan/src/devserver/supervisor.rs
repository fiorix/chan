use std::time::{Duration, Instant};

use anyhow::{Context, Result};

/// The systemd user unit name for the devserver.
pub(crate) const DEVSERVER_SYSTEMD_UNIT: &str = "chan-devserver.service";

/// Poll until the unit is active, a failure is reported, or the deadline
/// passes. Tolerates the brief `activating` window after `enable --now`.
pub(super) async fn wait_until_active(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if unit_is_active().await {
            return true;
        }
        if unit_is_failed().await || Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

pub(crate) async fn unit_is_active() -> bool {
    matches!(
        run_tool("systemctl", &["--user", "is-active", DEVSERVER_SYSTEMD_UNIT]).await,
        Ok(output) if output.status.success()
    )
}

async fn unit_is_failed() -> bool {
    matches!(
        run_tool("systemctl", &["--user", "is-failed", DEVSERVER_SYSTEMD_UNIT]).await,
        Ok(output) if output.status.success()
    )
}

/// Run `systemctl --user <args>`, erroring with stderr on a non-zero exit.
pub(super) async fn systemctl_user(args: &[&str]) -> Result<()> {
    let mut full: Vec<&str> = vec!["--user"];
    full.extend_from_slice(args);
    let output = run_tool("systemctl", &full).await?;
    if !output.status.success() {
        anyhow::bail!(
            "`systemctl --user {}` failed:\n{}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

/// The last lines of the unit's journal, for a failure message.
pub(super) async fn recent_unit_journal() -> String {
    match run_tool(
        "journalctl",
        &[
            "--user",
            "-u",
            DEVSERVER_SYSTEMD_UNIT,
            "--no-pager",
            "-n",
            "30",
        ],
    )
    .await
    {
        Ok(output) => String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string(),
        Err(e) => format!("(could not read the journal: {e})"),
    }
}

/// Run a tool to completion, capturing its output. Errors only when the
/// tool cannot be spawned (e.g. missing binary), not on a non-zero exit.
pub(super) async fn run_tool(program: &str, args: &[&str]) -> Result<std::process::Output> {
    tokio::process::Command::new(program)
        .args(args)
        .output()
        .await
        .with_context(|| format!("running `{program} {}`", args.join(" ")))
}

/// The launchd LaunchAgent label for the devserver. Reverse-DNS off the app
/// bundle id (`app.chan.desktop`).
pub(crate) const DEVSERVER_LAUNCHD_LABEL: &str = "app.chan.devserver";

/// The current user's numeric uid for the `gui/<uid>` domain target. Shells out
/// to `id -u` rather than adding a libc dependency, mirroring the systemd
/// backend's `$USER` discovery.
pub(crate) async fn current_uid() -> Result<u32> {
    let output = run_tool("id", &["-u"]).await?;
    if !output.status.success() {
        anyhow::bail!(
            "`id -u` failed:\n{}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .context("parsing the current uid from `id -u`")
}

/// `gui/<uid>` -- the launchd domain target for the user's GUI login session.
pub(super) fn launchd_domain_target(uid: u32) -> String {
    format!("gui/{uid}")
}

/// `gui/<uid>/<label>` -- the launchd service target for the devserver agent.
pub(super) fn launchd_service_target(uid: u32) -> String {
    format!("gui/{uid}/{DEVSERVER_LAUNCHD_LABEL}")
}

/// Run `launchctl <args>`, erroring with stderr on a non-zero exit. For the
/// must-succeed calls (`enable`, `bootstrap`); `bootout` runs best-effort.
pub(super) async fn launchctl(args: &[&str]) -> Result<()> {
    let output = run_tool("launchctl", args).await?;
    if !output.status.success() {
        anyhow::bail!(
            "`launchctl {}` failed:\n{}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

/// Whether the agent is loaded AND running.
pub(crate) async fn launchd_is_active(uid: u32) -> bool {
    let service = launchd_service_target(uid);
    matches!(
        run_tool("launchctl", &["print", service.as_str()]).await,
        Ok(output)
            if output.status.success()
                && launchd_print_running(&String::from_utf8_lossy(&output.stdout))
    )
}

/// Whether the agent is loaded, not running, and last exited non-zero.
async fn launchd_is_failed(uid: u32) -> bool {
    let service = launchd_service_target(uid);
    matches!(
        run_tool("launchctl", &["print", service.as_str()]).await,
        Ok(output)
            if output.status.success()
                && launchd_print_failed(&String::from_utf8_lossy(&output.stdout))
    )
}

/// Parse `launchctl print` output for a running service (`state = running`).
fn launchd_print_running(out: &str) -> bool {
    out.lines().any(|l| l.trim() == "state = running")
}

/// Parse `launchctl print` output for a failed service: not running with a
/// non-zero `last exit code`. `(never exited)` and `= 0` are not failures.
fn launchd_print_failed(out: &str) -> bool {
    let not_running = out.lines().any(|l| l.trim() == "state = not running");
    let bad_exit = out.lines().find_map(|l| {
        l.trim()
            .strip_prefix("last exit code = ")
            .and_then(|v| v.parse::<i32>().ok())
    });
    not_running && matches!(bad_exit, Some(code) if code != 0)
}

/// Poll until the agent is active, a failure is reported, or the deadline
/// passes. Tolerates the brief window between bootstrap and first run.
pub(super) async fn wait_until_launchd_active(uid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if launchd_is_active(uid).await {
            return true;
        }
        if launchd_is_failed(uid).await || Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launchd_print_running_reads_state() {
        // Tab-indented like real `launchctl print` output.
        assert!(launchd_print_running(
            "\tstate = running\n\tpid = 4321\n\tlast exit code = (never exited)\n"
        ));
        assert!(!launchd_print_running(
            "\tstate = not running\n\tlast exit code = (never exited)\n"
        ));
    }

    #[test]
    fn launchd_print_failed_only_on_nonzero_exit() {
        assert!(launchd_print_failed(
            "\tstate = not running\n\tlast exit code = 1\n"
        ));
        // A clean exit, a never-run service, and a running service are not failures.
        assert!(!launchd_print_failed(
            "\tstate = not running\n\tlast exit code = 0\n"
        ));
        assert!(!launchd_print_failed(
            "\tstate = not running\n\tlast exit code = (never exited)\n"
        ));
        assert!(!launchd_print_failed("\tstate = running\n\tpid = 5\n"));
    }
}
