//! Pre-fetches the default embedding model and writes it as a
//! single zstd-compressed tarball at
//! `crates/chan-server/resources/models.tar.zst`. chan-server's
//! release build calls `include_bytes!` on the tarball; the seeder
//! at first server launch zstd-decodes + untars the blob into the
//! per-machine cache (~/Library/Caches/chan/models on macOS) so
//! users never block on a HuggingFace download.
//!
//! Two-stage:
//!
//!   1. Open the candle embedder against a stable staging dir under
//!      `target/fetch-models-cache/`. hf-hub downloads the model
//!      there if missing; a re-run with the cache populated skips
//!      the network. With the default target dir, `cargo clean`
//!      wipes it and the next build re-downloads.
//!   2. tar+zstd encode the staging dir into the embed bundle.
//!      Drops `*.lock`, `*.no_exists` and `**/blobs/**` along the
//!      way; tar follows the snapshots/ symlinks into the blob bytes,
//!      so the snapshot entries already carry those bytes and keeping
//!      blobs/ too would store them twice.
//!
//! Run from the workspace root via `make models` or
//! `cargo run -p fetch-models`. Idempotent: re-running with the
//! model already cached AND the tarball up-to-date is a fast
//! no-op. Honors `HTTPS_PROXY` / `HTTP_PROXY` for restricted
//! networks; hf-hub's underlying HTTP client picks them up.

use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chan_workspace::index::embeddings::Embedder;
use chan_workspace::DEFAULT_MODEL;

/// Compression level. zstd's range is 1..=22; 19 sits at the
/// "max ratio with reasonable encode time" sweet spot for blobs
/// of this size (one-shot encode, no realtime constraint).
/// Anything higher only buys ~1% smaller for >2x encode time.
const ZSTD_LEVEL: i32 = 19;

fn main() -> Result<()> {
    let staging = staging_dir();
    let bundle = bundle_path();

    if let Some(parent) = bundle.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    std::fs::create_dir_all(&staging).with_context(|| format!("create {}", staging.display()))?;

    if let Some((var, val)) = active_proxy() {
        eprintln!(
            "fetch-models: using {var}={}",
            redact_proxy_credentials(&val)
        );
    }
    eprintln!(
        "fetch-models: seeding {DEFAULT_MODEL} into {}",
        staging.display()
    );

    // Open the embedder pointing at the staging dir. hf-hub
    // downloads the model there if missing; if already present
    // from a prior run it skips the network and returns instantly.
    Embedder::open(DEFAULT_MODEL, &staging).context("download default embedding model")?;

    // Skip the (slow) zstd-19 re-encode when the existing bundle is
    // already newer than every file under staging. Force a rebuild
    // by deleting the bundle (or the staging dir).
    if bundle_up_to_date(&bundle, &staging)? {
        let size = bundle_size(&bundle);
        eprintln!(
            "fetch-models: bundle up-to-date ({}, {})",
            bundle.display(),
            humanize(size)
        );
        return Ok(());
    }

    eprintln!("fetch-models: encoding bundle to {}", bundle.display());
    encode_tar_zst(&staging, &bundle)?;
    let size = bundle_size(&bundle);
    eprintln!(
        "fetch-models: done ({} -> {})",
        staging.display(),
        humanize(size)
    );
    Ok(())
}

/// The bundle's size in bytes, 0 when it cannot be read (for the log line).
fn bundle_size(bundle: &Path) -> u64 {
    std::fs::metadata(bundle)
        .map(|m| m.len())
        .unwrap_or_default()
}

/// The workspace's `crates/` directory, the parent of this crate.
fn crates_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Stable staging dir for the hf-hub cache. Lives under the repo's
/// default `target/`, so `cargo clean` there wipes it; survives normal
/// builds so re-runs of fetch-models hit the on-disk cache and skip the
/// network. Keep this OUT of `crates/chan-server/resources/` so
/// the only thing under that dir is the final bundle.
fn staging_dir() -> PathBuf {
    crates_dir()
        .join("..")
        .join("target")
        .join("fetch-models-cache")
}

fn bundle_path() -> PathBuf {
    crates_dir()
        .join("chan-server")
        .join("resources")
        .join("models.tar.zst")
}

/// True if `bundle` exists and its mtime is at least as new as
/// every bundled file under `staging`, so newly-arrived `*.lock` /
/// `blobs/` files don't force a re-encode.
fn bundle_up_to_date(bundle: &Path, staging: &Path) -> Result<bool> {
    let Ok(meta) = std::fs::metadata(bundle) else {
        return Ok(false);
    };
    if meta.len() == 0 {
        return Ok(false);
    }
    let bundle_mtime = meta.modified().context("bundle mtime")?;
    for (entry, _rel) in bundle_entries(staging)? {
        let m = std::fs::metadata(&entry)
            .with_context(|| format!("stat {}", entry.display()))?
            .modified()
            .with_context(|| format!("mtime {}", entry.display()))?;
        if m > bundle_mtime {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Walk `src` and emit a zstd-compressed tar archive at `dst`.
/// Skips hf-hub's bookkeeping cruft (`*.lock`, `*.no_exists`) and
/// the `blobs/` subdir (snapshots/ symlinks already point to the
/// same bytes; tar follows symlinks by default, so blobs/ would
/// double the archive).
fn encode_tar_zst(src: &Path, dst: &Path) -> Result<()> {
    encode_tar_zst_via(src, dst, |path| File::create(path))
}

fn encode_tar_zst_via<S: Write + Into<File>>(
    src: &Path,
    dst: &Path,
    create: impl FnOnce(&Path) -> io::Result<S>,
) -> Result<()> {
    // Complete both archive layers and sync the sibling temporary file
    // before publishing it, so finalization failures cannot look current.
    let tmp = dst.with_extension("zst.tmp");
    let result = (|| -> Result<()> {
        let file = create(&tmp).with_context(|| format!("create {}", tmp.display()))?;
        let zenc = zstd::Encoder::new(file, ZSTD_LEVEL).context("init zstd encoder")?;
        let mut tarw = tar::Builder::new(zenc);
        tarw.follow_symlinks(true);
        // Walk the staging tree explicitly so we can filter
        // entries; `Builder::append_dir_all` would happily include
        // blobs/ and lock files.
        for (entry, rel) in bundle_entries(src)? {
            tarw.append_path_with_name(&entry, &rel)
                .with_context(|| format!("append {}", entry.display()))?;
        }
        let zenc = tarw.into_inner().context("finalize tar")?;
        let file: File = zenc.finish().context("finalize zstd")?.into();
        file.sync_all()
            .with_context(|| format!("sync {}", tmp.display()))?;
        drop(file);
        std::fs::rename(&tmp, dst)
            .with_context(|| format!("rename {} -> {}", tmp.display(), dst.display()))?;
        Ok(())
    })();
    if let Err(error) = result {
        if let Err(cleanup) = std::fs::remove_file(&tmp) {
            if cleanup.kind() != io::ErrorKind::NotFound {
                return Err(error.context(format!(
                    "remove {} after encode failure: {cleanup}",
                    tmp.display()
                )));
            }
        }
        return Err(error);
    }
    Ok(())
}

/// The files that go into the bundle, as (absolute, relative to `root`)
/// pairs in walk order, with the `should_skip` filter applied.
fn bundle_entries(root: &Path) -> Result<Vec<(PathBuf, PathBuf)>> {
    let mut out = Vec::new();
    for entry in walk_files(root)? {
        let rel = entry
            .strip_prefix(root)
            .with_context(|| format!("strip {}", entry.display()))?
            .to_path_buf();
        if should_skip(&rel) {
            continue;
        }
        out.push((entry, rel));
    }
    Ok(out)
}

/// Recursive walk, sorted. Yields regular files
/// and symlinks, and skips any other entry type; a listed symlink
/// is followed by its consumer (tar's `follow_symlinks(true)`, or
/// `std::fs::metadata` in `bundle_up_to_date`).
fn walk_files(root: &Path) -> Result<Vec<PathBuf>> {
    fn rec(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
        for entry in
            std::fs::read_dir(dir).with_context(|| format!("read_dir {}", dir.display()))?
        {
            let entry = entry?;
            let path = entry.path();
            let ft = entry
                .file_type()
                .with_context(|| format!("file_type {}", path.display()))?;
            if ft.is_dir() {
                rec(&path, out)?;
            } else if ft.is_file() || ft.is_symlink() {
                // Symlinks: tar's `follow_symlinks(true)` resolves
                // them at append time, so we list them here and
                // tar serializes the target's bytes.
                out.push(path);
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    rec(root, &mut out)?;
    out.sort();
    Ok(out)
}

/// Filenames hf-hub emits that we don't want in the bundle.
fn should_skip(rel: &Path) -> bool {
    let s = rel.to_string_lossy();
    if s.contains("/blobs/") || s.starts_with("blobs/") {
        return true;
    }
    if s.ends_with(".lock") || s.ends_with(".no_exists") {
        return true;
    }
    false
}

fn humanize(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    let b = bytes as f64;
    if b >= MB {
        format!("{:.1} MB", b / MB)
    } else if b >= KB {
        format!("{:.1} KB", b / KB)
    } else {
        format!("{bytes} B")
    }
}

/// Report which (if any) HTTP proxy env var is in effect, with
/// HTTPS_PROXY taking precedence (hf-hub uses HTTPS to hit the
/// HuggingFace CDN).
fn active_proxy() -> Option<(&'static str, String)> {
    for var in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(v) = std::env::var(var) {
            if !v.is_empty() {
                return Some((var, v));
            }
        }
    }
    None
}

/// The proxy value with any `user:pass@` credentials replaced, so the log
/// line names the proxy without putting its password in build output.
fn redact_proxy_credentials(value: &str) -> String {
    let (scheme, rest) = match value.find("://") {
        Some(at) => value.split_at(at + 3),
        None => ("", value),
    };
    let authority_end = rest.find('/').unwrap_or(rest.len());
    match rest[..authority_end].rfind('@') {
        Some(at) => format!("{scheme}***@{}", &rest[at + 1..]),
        None => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_credentials_never_reach_the_log() {
        assert_eq!(
            redact_proxy_credentials("http://user:secret@proxy.example:3128"),
            "http://***@proxy.example:3128"
        );
        assert_eq!(
            redact_proxy_credentials("user:secret@proxy.example:3128/path@x"),
            "***@proxy.example:3128/path@x"
        );
        assert_eq!(
            redact_proxy_credentials("http://proxy.example:3128"),
            "http://proxy.example:3128"
        );
    }

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(name: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("fetch-models-{name}-{}", std::process::id()));
            match std::fs::remove_dir_all(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => panic!("remove stale test directory: {error}"),
            }
            std::fs::create_dir(&path).expect("create unique test directory");
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let cleanup = std::fs::remove_dir_all(&self.0);
            if !std::thread::panicking() {
                cleanup.expect("remove test directory");
            }
        }
    }

    struct FailingWriter {
        file: File,
        remaining: usize,
    }

    impl Write for FailingWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.remaining == 0 {
                return Err(io::Error::other("injected finalization write failure"));
            }
            let count = self.file.write(&bytes[..bytes.len().min(self.remaining)])?;
            self.remaining -= count;
            Ok(count)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.file.flush()
        }
    }

    impl From<FailingWriter> for File {
        fn from(writer: FailingWriter) -> Self {
            writer.file
        }
    }

    #[test]
    fn a_bundle_whose_final_flush_fails_is_not_promoted() {
        use std::io::Read;

        let dir = TestDir::new("final-flush");
        let staging = dir.0.join("staging");
        std::fs::create_dir(&staging).unwrap();
        std::fs::write(staging.join("config.json"), "{\"model\":\"tiny\"}\n").unwrap();
        let reference = dir.0.join("reference.tar.zst");
        encode_tar_zst(&staging, &reference).expect("reference bundle");
        let reference_len = std::fs::metadata(&reference).unwrap().len();
        let decoder = zstd::Decoder::new(File::open(&reference).unwrap()).unwrap();
        let mut archive = tar::Archive::new(decoder);
        let mut entries = archive.entries().unwrap();
        {
            let mut entry = entries.next().expect("staged file").unwrap();
            assert_eq!(entry.path().unwrap().as_ref(), Path::new("config.json"));
            let mut content = String::new();
            entry.read_to_string(&mut content).unwrap();
            assert_eq!(content, "{\"model\":\"tiny\"}\n");
        }
        assert!(entries.next().is_none());
        let dst = dir.0.join("models.tar.zst");
        let result = encode_tar_zst_via(&staging, &dst, |path| {
            Ok(FailingWriter {
                file: File::create(path)?,
                remaining: reference_len as usize / 2,
            })
        });
        let promoted_len = std::fs::metadata(&dst).ok().map(|meta| meta.len());
        let up_to_date = bundle_up_to_date(&dst, &staging).unwrap();
        assert!(result.is_err() && !dst.exists(), "result={result:?}, reference_len={reference_len}, promoted_len={promoted_len:?}, bundle_up_to_date={up_to_date}");
        assert_eq!(result.as_ref().unwrap_err().to_string(), "finalize zstd");
        assert!(
            !dst.with_extension("zst.tmp").exists(),
            "failed encode must clean the temporary bundle"
        );
        std::fs::copy(&reference, &dst).unwrap();
        assert!(encode_tar_zst_via(&staging, &dst, |path| {
            Ok(FailingWriter {
                file: File::create(path)?,
                remaining: reference_len as usize / 2,
            })
        })
        .is_err());
        assert_eq!(
            std::fs::read(&dst).unwrap(),
            std::fs::read(&reference).unwrap(),
            "failed re-encode must preserve an existing bundle"
        );
        assert!(!dst.with_extension("zst.tmp").exists());
    }
}
