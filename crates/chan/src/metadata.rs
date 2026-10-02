use anyhow::{Context, Result};
use chan_workspace::{MetadataExportOptions, MetadataImportOptions};

use crate::cli::MetadataAction;
use crate::registry::{ensure_workspace_registered, library};

pub(super) fn cmd_metadata(action: MetadataAction) -> Result<()> {
    match action {
        MetadataAction::Export { path, archive } => {
            let lib = library()?;
            let report = lib
                .export_metadata_archive(
                    &path,
                    &archive,
                    MetadataExportOptions {
                        chan_version: env!("CARGO_PKG_VERSION").to_string(),
                    },
                )
                .context("exporting metadata archive")?;
            println!(
                "exported {} files ({} bytes) to {}",
                report.files,
                report.bytes,
                report.archive_path.display()
            );
            println!("source metadata: {}", report.manifest.source_metadata_key);
            Ok(())
        }
        MetadataAction::Import {
            path,
            archive,
            rescan,
            force_scm,
        } => {
            let lib = library()?;
            ensure_workspace_registered(&lib, &path)?;
            let report = lib
                .import_metadata_archive(
                    &path,
                    &archive,
                    MetadataImportOptions { rescan, force_scm },
                )
                .context("importing metadata archive")?;
            println!(
                "imported {} files ({} bytes) from {}",
                report.files,
                report.bytes,
                archive.display()
            );
            println!("subtrees: {}", report.imported_subtrees.join(", "));
            if report.rescanned {
                println!("rescan: completed");
            }
            Ok(())
        }
        MetadataAction::Inspect { archive, json } => {
            let lib = library()?;
            let manifest = lib
                .inspect_metadata_archive(&archive)
                .context("inspecting metadata archive")?;
            if json {
                println!("{}", serde_json::to_string_pretty(&manifest)?);
            } else {
                println!("format: {}", manifest.archive_format_version);
                println!("chan: {}", manifest.chan_version);
                println!("created: {}", manifest.created_at);
                println!("source root: {}", manifest.source_root);
                println!("source metadata: {}", manifest.source_metadata_key);
                println!("subtrees: {}", manifest.included_subtrees.join(", "));
                if let Some(scm) = manifest.scm {
                    if !scm.remotes.is_empty() {
                        println!("scm remotes: {}", scm.remotes.join(", "));
                    }
                    if let Some(head) = scm.head {
                        println!("scm head: {head}");
                    }
                }
            }
            Ok(())
        }
    }
}
