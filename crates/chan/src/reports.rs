use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::cli::ReportsAction;
use crate::registry::{library, missing_workspace_path};

/// Dispatch the `chan workspace reports {enable,disable}`
/// subcommands. Parallels `cmd_index_set_semantic`'s shape: open
/// the workspace (with the path-resolution fallback to the registry's
/// default), flip the per-workspace `reports_enabled` flag, surface
/// the verb on stdout. `disable` is destructive -- drops the
/// persisted `report.jsonl` so re-enable triggers a fresh scan;
/// gated on `--yes` or an interactive prompt (explicit
/// confirmation for a destructive action).
pub(super) fn cmd_reports(action: ReportsAction) -> Result<()> {
    match action {
        ReportsAction::Enable { path } => cmd_reports_set(path, true, false),
        ReportsAction::Disable { path, yes } => cmd_reports_set(path, false, yes),
    }
}

/// Ask on stderr whether to disable reports for the workspace at `root`,
/// reading the answer from `input`. Anything but `y` or `yes`, an empty
/// line or end of input included, is an error.
fn confirm_reports_disable(root: &Path, input: &mut impl std::io::BufRead) -> Result<()> {
    use std::io::Write;

    eprintln!(
        "About to disable chan-reports for workspace at {}",
        root.display(),
    );
    eprintln!(
        "This drops the persisted report.jsonl. Re-enabling later \
         triggers a fresh scan."
    );
    eprint!("Continue? [y/N] ");
    let _ = std::io::stderr().flush();
    let mut line = String::new();
    input.read_line(&mut line)?;
    let answer = line.trim().to_ascii_lowercase();
    if answer == "y" || answer == "yes" {
        Ok(())
    } else {
        anyhow::bail!("aborted: reports stay enabled")
    }
}

fn cmd_reports_set(path: Option<PathBuf>, enabled: bool, skip_confirm: bool) -> Result<()> {
    let lib = library()?;
    let root = path.ok_or_else(|| {
        let (cmd, hint) = if enabled {
            ("reports enable", "chan workspace reports enable --path .")
        } else {
            ("reports disable", "chan workspace reports disable --path .")
        };
        missing_workspace_path(cmd, hint)
    })?;
    let workspace = lib
        .open_workspace(&root)
        .with_context(|| format!("opening workspace at {}", root.display()))?;
    // Destructive-action confirmation for disable. `-y` skips the
    // prompt; without it, a terminal on stdin is asked and anything but
    // yes fails, and no terminal fails at once, so a script never reads
    // success from a disable that changed nothing.
    if !enabled && !skip_confirm {
        if !std::io::IsTerminal::is_terminal(&std::io::stdin()) {
            anyhow::bail!("use --yes to confirm the reports disable in non-interactive mode");
        }
        confirm_reports_disable(workspace.root(), &mut std::io::stdin().lock())?;
    }
    workspace
        .set_reports_enabled(enabled)
        .context("persisting reports_enabled flag")?;
    if enabled {
        // Kick off the initial scan via `boot` so the flag flip
        // produces visible data without waiting for the next
        // `Workspace::report()` consumer.
        workspace.boot().context("BOOT after enabling reports")?;
    }
    let verb = if enabled { "enabled" } else { "disabled" };
    println!(
        "chan-reports {verb} for workspace at {}",
        workspace.root().display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A reports disable asked on a terminal goes ahead only on yes; a
    /// declined prompt, an empty answer and end of input are errors, so the
    /// command does not exit 0 having changed nothing.
    #[test]
    fn a_declined_reports_disable_is_an_error() {
        let root = Path::new("workspace");
        for declined in ["n\n", "no\n", "\n", ""] {
            assert!(
                confirm_reports_disable(root, &mut declined.as_bytes()).is_err(),
                "the answer {declined:?} confirmed the disable"
            );
        }
        for confirmed in ["y\n", "yes\n", "Y\n"] {
            assert!(
                confirm_reports_disable(root, &mut confirmed.as_bytes()).is_ok(),
                "the answer {confirmed:?} did not confirm the disable"
            );
        }
    }
}
