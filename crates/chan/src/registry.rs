use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chan_workspace::{KnownWorkspace, Library};
use serde::Serialize;

pub(super) fn library() -> Result<Library> {
    Library::open().context("opening chan registry")
}

pub(super) fn same_path(a: &Path, b: &Path) -> bool {
    let ca = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let cb = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    ca == cb
}

pub(super) fn ensure_workspace_registered(
    lib: &Library,
    root: &Path,
) -> Result<chan_workspace::KnownWorkspace> {
    lib.register_workspace(root)
        .with_context(|| format!("registering {}", root.display()))
}

pub(super) fn cmd_add(path: PathBuf, semantic_search: bool, reports: bool) -> Result<()> {
    // Mirror `chan serve`'s behavior: create the directory if it
    // doesn't exist yet. Single verb covers both "register an
    // existing dir" and "make a fresh workspace here". A separate
    // `chan init` would be a synonym; not worth the mental
    // overhead.
    if !path.exists() {
        std::fs::create_dir_all(&path)
            .with_context(|| format!("creating workspace root {}", path.display()))?;
    }
    let lib = library()?;
    let entry = ensure_workspace_registered(&lib, &path)?;
    // Opt-in feature flags. Persist before
    // boot-time activation so a `chan workspace add --reports` lands the
    // flag immediately + the kickoff scan runs once.
    if semantic_search || reports {
        let workspace = lib
            .open_workspace(&entry.root_path)
            .with_context(|| format!("opening workspace at {}", entry.root_path.display()))?;
        if semantic_search {
            workspace
                .set_semantic_enabled(true)
                .context("persisting semantic_enabled flag")?;
        }
        if reports {
            workspace
                .set_reports_enabled(true)
                .context("persisting reports_enabled flag")?;
        }
        workspace
            .boot()
            .context("BOOT after enabling optional features")?;
    }
    println!("registered: {}", entry.root_path.display());
    if semantic_search {
        println!("semantic search enabled");
    }
    if reports {
        println!("chan-reports enabled");
    }
    Ok(())
}

pub(super) fn cmd_list(json: bool) -> Result<()> {
    let workspaces = library()?.list_workspaces();
    if json {
        let out = WorkspaceListOutput {
            workspaces: workspaces.iter().map(WorkspaceListEntry::from).collect(),
        };
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }
    if workspaces.is_empty() {
        println!("(no workspaces registered)");
        return Ok(());
    }
    for d in workspaces {
        println!(
            "{}  (last seen {}, metadata {})",
            d.root_path.display(),
            d.last_seen_at.format("%Y-%m-%d %H:%M"),
            d.metadata_key,
        );
    }
    Ok(())
}

/// Error for a command invoked without its required workspace path. Every
/// command names the workspace root explicitly; `hint` is a complete,
/// valid example invocation to suggest.
pub(super) fn missing_workspace_path(cmd: &str, hint: &str) -> anyhow::Error {
    anyhow::anyhow!("chan {cmd} requires a workspace path; e.g. `{hint}`")
}

/// User-facing message when a CLI subcommand is
/// pointed at a path the registry doesn't know. Surfaces a clear
/// "not a chan workspace at <path>" hint with a `chan workspace add` next-step
/// instead of leaking the implementation detail (auto-register
/// side-effect, `WorkspaceNotRegistered(<path>)`, etc.).
pub(super) fn not_a_chan_workspace_hint(root: &std::path::Path) -> String {
    format!(
        "not a chan workspace at {}; run `chan workspace add {}` first",
        root.display(),
        root.display()
    )
}

#[derive(Serialize)]
struct WorkspaceListOutput {
    workspaces: Vec<WorkspaceListEntry>,
}

#[derive(Serialize)]
struct WorkspaceListEntry {
    path: String,
    /// Stable per-workspace metadata storage key under ~/.chan/workspaces/.
    metadata_key: String,
    /// RFC3339 UTC timestamp.
    last_seen_at: String,
}

impl From<&KnownWorkspace> for WorkspaceListEntry {
    fn from(d: &KnownWorkspace) -> Self {
        Self {
            path: d.root_path.display().to_string(),
            metadata_key: d.metadata_key.clone(),
            last_seen_at: d.last_seen_at.to_rfc3339(),
        }
    }
}
