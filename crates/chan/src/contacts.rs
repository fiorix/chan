use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::registry::{ensure_workspace_registered, library, missing_workspace_path};

pub(super) fn cmd_contacts_import_csv(
    file: PathBuf,
    into: String,
    provider: String,
    dry_run: bool,
    overwrite: bool,
    workspace: Option<PathBuf>,
) -> Result<()> {
    use chan_workspace::contacts::{
        google::parse_google_csv, slug::SlugAllocator, ImportOpts, ProviderKind,
    };

    // Provider gate. Only Google CSV today; the flag exists so the
    // help text and the wire shape are stable when more land.
    let prov =
        ProviderKind::parse(&provider).with_context(|| format!("unknown provider: {provider}"))?;
    if prov != ProviderKind::Google {
        anyhow::bail!("only --provider google is supported today");
    }

    // Parse the CSV up front. A bad file should fail before we
    // touch the workspace, so the user doesn't end up with a half-
    // created Contacts/ dir on a typo.
    let csv_bytes = std::fs::read(&file).with_context(|| format!("reading {}", file.display()))?;
    let contacts = parse_google_csv(csv_bytes.as_slice())
        .with_context(|| format!("parsing {}", file.display()))?;
    if contacts.is_empty() {
        println!("(no contacts in {})", file.display());
        return Ok(());
    }

    let lib = library()?;
    let root = workspace.ok_or_else(|| {
        missing_workspace_path(
            "contacts import csv",
            "chan workspace contacts import csv contacts.csv --workspace .",
        )
    })?;
    if !root.exists() {
        std::fs::create_dir_all(&root)
            .with_context(|| format!("creating workspace root {}", root.display()))?;
    }
    ensure_workspace_registered(&lib, &root)?;
    let workspace = lib.open_workspace(&root)?;

    if dry_run {
        // Mirror the orchestrator's slug + existence check loop
        // without writing. Existence checks against the live workspace
        // so SKIPPED / OVERWROTE labels are accurate.
        let dir_norm = into.trim_matches('/').to_string();
        let mut wrote = 0usize;
        let mut overwrote = 0usize;
        let mut skipped = 0usize;
        let on_disk = |p: &str| workspace.exists(p);
        let mut slugs = SlugAllocator::new(&dir_norm, &on_disk);
        for c in &contacts {
            let path = slugs.slug_for(c);
            let exists = workspace.exists(&path);
            if exists && !overwrite {
                println!("WOULD SKIP      {path}  (exists)");
                skipped += 1;
            } else if exists {
                println!("WOULD OVERWRITE {path}");
                overwrote += 1;
            } else {
                println!("WOULD WRITE     {path}");
                wrote += 1;
            }
        }
        println!();
        println!(
            "{wrote} would write, {overwrote} would overwrite, \
             {skipped} would skip (dry-run; no files changed)"
        );
        return Ok(());
    }

    let summary = workspace
        .import_contacts(&into, contacts, ImportOpts { overwrite })
        .context("importing contacts")?;
    print_import_summary(&summary);
    Ok(())
}

fn print_import_summary(summary: &chan_workspace::ImportSummary) {
    use chan_workspace::ImportOutcome;
    for o in &summary.outcomes {
        match o {
            ImportOutcome::Wrote { path } => println!("WROTE     {path}"),
            ImportOutcome::Overwrote { path } => println!("OVERWROTE {path}"),
            ImportOutcome::Skipped { path, reason } => {
                println!("SKIPPED   {path}  ({reason})")
            }
            ImportOutcome::Failed { name, reason } => {
                println!("FAILED    {name}  ({reason})")
            }
        }
    }
    let c = summary.counts();
    println!();
    println!(
        "{} wrote, {} overwrote, {} skipped, {} failed",
        c.wrote, c.overwrote, c.skipped, c.failed
    );
}
