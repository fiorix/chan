//! Seed the per-machine embedding-model cache from a baked-in tarball.
//!
//! The release build embeds a zstd-encoded tar of the hf-hub cache layout
//! at `resources/models.tar.zst` (produced by the `fetch-models` helper).
//! On first server launch we extract it into the global model cache so
//! users never block on a HuggingFace download.
//!
//! Whole module gated on `embed-model`:
//! `embeddings` controls the candle stack; `embed-model` controls
//! whether the bundle ships in the binary. With `embeddings` on but
//! `embed-model` off, `chan-workspace::index::embeddings::resolve_model`
//! looks for an already-downloaded model under
//! `<user-config>/chan/models/<model-name>/` and the CLI / API layer
//! handles on-demand download.

#![cfg(feature = "embed-model")]

use std::path::Path;

/// Compressed copy of the default embedding model, baked at build
/// time. Empty in dev builds (the build.rs stub); real release
/// builds run `make models` first which writes the actual ~80 MB
/// tarball before linking.
static MODEL_BUNDLE: &[u8] = include_bytes!("../resources/models.tar.zst");

/// Extract the compressed default-model bundle into the per-machine
/// model cache (resolved by chan-workspace's `global_models_dir`) the
/// first time the server boots on this machine. Skipped on every
/// subsequent boot if the default model is already laid out under
/// the cache; the check is keyed on the actual snapshot files the
/// runtime embedder will load, not on "any file exists".
///
/// Every branch prints a one-line marker on stderr so a single run
/// (no `RUST_LOG=info` required) reveals whether the binary shipped
/// a populated bundle, the cache was already good, or extraction
/// failed. Errors do not block startup: the runtime path falls back
/// to hf-hub's HuggingFace download, the same UX as a dev build.
pub fn seed_models_from_bundle() {
    if MODEL_BUNDLE.is_empty() {
        eprintln!(
            "seed-models: no embedded model bundle (dev build or \
             --no-default-features); first launch will fetch from \
             HuggingFace"
        );
        return;
    }
    let target = chan_workspace::index::embeddings::global_models_dir();
    let repo_dir = target.join(repo_dir_name(chan_workspace::DEFAULT_MODEL));
    if default_model_present(&repo_dir) {
        eprintln!(
            "seed-models: cache already populated at {}; skipping",
            repo_dir.display()
        );
        return;
    }
    if let Err(e) = std::fs::create_dir_all(&target) {
        eprintln!("seed-models: create {}: {e}", target.display());
        return;
    }
    match extract_bundle(&target) {
        Ok(count) => eprintln!(
            "seed-models: extracted {count} files into {}",
            target.display()
        ),
        Err(e) => eprintln!("seed-models: extract failed: {e}"),
    }
}

/// zstd-decode + untar `MODEL_BUNDLE` into `target`. Returns the
/// number of files written. Reports any error verbatim; the caller
/// downgrades it to a warning so a corrupt bundle never blocks
/// server start.
fn extract_bundle(target: &Path) -> std::io::Result<usize> {
    let zr = zstd::Decoder::new(MODEL_BUNDLE)?;
    let mut tar = tar::Archive::new(zr);
    // Default unpack semantics are correct for the hf-hub layout:
    // creates intermediate dirs, preserves file mode, doesn't
    // follow symlinks (tar's encode side already resolved them
    // into regular files when fetch-models built the bundle).
    let mut count = 0usize;
    for entry in tar.entries()? {
        let mut entry = entry?;
        // Sanity: refuse path traversal. tar::Archive::unpack does
        // this implicitly; we replicate by skipping entries whose
        // post-cleanup path would escape `target`.
        let path = entry.path()?.into_owned();
        if path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            tracing::warn!("seed-models: skipping suspicious entry {path:?}");
            continue;
        }
        entry.unpack_in(target)?;
        count += 1;
    }
    Ok(count)
}

/// Translate a HuggingFace model id (`"<org>/<name>"`) into the
/// directory name hf-hub uses inside its cache root: `models--`
/// prefix, slashes replaced with `--`. Mirrors hf-hub's own scheme
/// (`hf_hub::cache::Cache::repo_path`) so the seeder and runtime
/// embedder agree on where the default model lives.
fn repo_dir_name(model: &str) -> String {
    format!("models--{}", model.replace('/', "--"))
}

/// True if `repo_dir` already holds a usable copy of the default
/// model: `refs/main` present, plus at least one `snapshots/<hash>/`
/// directory containing `config.json`, `tokenizer.json`, and
/// `model.safetensors`. Anything weaker (stray lockfile, half-
/// downloaded snapshot, blobs-only state from an aborted hf-hub
/// fetch) fails the check and the seeder re-extracts. `is_file`
/// follows symlinks, so the native hf-hub layout (snapshots/ ->
/// blobs/) and the tarball layout (regular files under snapshots/)
/// both validate.
fn default_model_present(repo_dir: &Path) -> bool {
    if !repo_dir.join("refs").join("main").is_file() {
        return false;
    }
    let snapshots = repo_dir.join("snapshots");
    let Ok(it) = std::fs::read_dir(&snapshots) else {
        return false;
    };
    for entry in it.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_dir() {
            continue;
        }
        let dir = entry.path();
        if dir.join("config.json").is_file()
            && dir.join("tokenizer.json").is_file()
            && dir.join("model.safetensors").is_file()
        {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn repo_dir_name_matches_hf_hub_layout() {
        assert_eq!(
            repo_dir_name("BAAI/bge-small-en-v1.5"),
            "models--BAAI--bge-small-en-v1.5"
        );
    }

    fn seeded(repo: &Path) {
        fs::create_dir_all(repo.join("refs")).unwrap();
        fs::write(repo.join("refs").join("main"), b"deadbeef").unwrap();
        let snap = repo.join("snapshots").join("deadbeef");
        fs::create_dir_all(&snap).unwrap();
        fs::write(snap.join("config.json"), b"{}").unwrap();
        fs::write(snap.join("tokenizer.json"), b"{}").unwrap();
        fs::write(snap.join("model.safetensors"), b"weights").unwrap();
    }

    #[test]
    fn present_when_full_layout_exists() {
        let tmp = tempfile::tempdir().unwrap();
        seeded(tmp.path());
        assert!(default_model_present(tmp.path()));
    }

    #[test]
    fn absent_when_dir_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!default_model_present(tmp.path()));
    }

    #[test]
    fn absent_when_only_stray_lockfile() {
        // A stray lockfile does not make the cache seeded.
        let tmp = tempfile::tempdir().unwrap();
        let blobs = tmp.path().join("blobs");
        fs::create_dir_all(&blobs).unwrap();
        fs::write(blobs.join("abc.lock"), b"").unwrap();
        assert!(!default_model_present(tmp.path()));
    }

    #[test]
    fn absent_when_refs_main_missing() {
        let tmp = tempfile::tempdir().unwrap();
        seeded(tmp.path());
        fs::remove_file(tmp.path().join("refs").join("main")).unwrap();
        assert!(!default_model_present(tmp.path()));
    }

    #[test]
    fn absent_when_snapshot_incomplete() {
        let tmp = tempfile::tempdir().unwrap();
        seeded(tmp.path());
        fs::remove_file(
            tmp.path()
                .join("snapshots")
                .join("deadbeef")
                .join("tokenizer.json"),
        )
        .unwrap();
        assert!(!default_model_present(tmp.path()));
    }
}
