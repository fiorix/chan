use std::fs::Metadata;
use std::io::{self, ErrorKind};
use std::path::Path;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::{now_ms, Demand};

/// Last completed chan-home scan; a failed refresh preserves these totals.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Storage {
    pub path: String,
    pub logical_bytes: Option<u64>,
    pub allocated_bytes: Option<u64>,
    pub files: Option<u64>,
    pub sampled_at_ms: Option<u64>,
    pub scan_ms: Option<u64>,
    pub error: Option<String>,
}

impl Storage {
    pub(super) fn pending(root: &Path) -> Self {
        Self {
            path: root.display().to_string(),
            logical_bytes: None,
            allocated_bytes: None,
            files: None,
            sampled_at_ms: None,
            scan_ms: None,
            error: None,
        }
    }
}

/// Entry errors a scan steps over without counting the entry: one removed
/// between its directory read and its stat (an index merge, a temp-file
/// rename), and one this user may not read (a directory a `sudo chan` left
/// root-owned). Either would otherwise cost every later total.
fn skippable(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::NotFound | ErrorKind::PermissionDenied
    )
}

pub(super) fn scan(root: &Path, stop: &Demand) -> io::Result<Storage> {
    scan_with(root, stop, |path| std::fs::symlink_metadata(path))
}

/// [`scan`] with the stat call supplied, so a test can remove an entry at
/// the exact point a concurrent writer would.
fn scan_with(
    root: &Path,
    stop: &Demand,
    stat: impl Fn(&Path) -> io::Result<Metadata>,
) -> io::Result<Storage> {
    let started = Instant::now();
    // The configured root itself may be a symlink; descendants remain inert.
    let root_path = std::fs::canonicalize(root)?;
    let mut pending = vec![(root_path, 0)];
    let mut bytes = 0u64;
    #[cfg(unix)]
    let mut allocated = 0u64;
    let mut files = 0u64;
    let mut visited = 0;
    #[cfg(unix)]
    let mut inodes = std::collections::HashSet::new();
    while let Some((path, depth)) = pending.pop() {
        if stop.is_stopped()
            || started.elapsed() > Duration::from_secs(30)
            || visited >= 1_000_000
            || depth > 128
        {
            return Err(io::Error::new(
                ErrorKind::Interrupted,
                "storage scan interrupted or exceeded its bound",
            ));
        }
        visited += 1;
        // Depth 0 is the chan home itself: failing to read it leaves no total.
        let metadata = match stat(&path) {
            Ok(metadata) => metadata,
            Err(error) if depth > 0 && skippable(&error) => continue,
            Err(error) => return Err(error),
        };
        if metadata.is_file() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if !inodes.insert((metadata.dev(), metadata.ino())) {
                    continue;
                }
                allocated = allocated.saturating_add(metadata.blocks().saturating_mul(512));
            }
            bytes = bytes.saturating_add(metadata.len());
            files += 1;
        } else if metadata.is_dir() {
            let entries = match std::fs::read_dir(&path) {
                Ok(entries) => entries,
                Err(error) if depth > 0 && skippable(&error) => continue,
                Err(error) => return Err(error),
            };
            for entry in entries {
                if stop.is_stopped()
                    || pending.len() >= 1_000_000
                    || started.elapsed() > Duration::from_secs(30)
                {
                    return Err(io::Error::new(
                        ErrorKind::Interrupted,
                        "storage scan interrupted or exceeded its bound",
                    ));
                }
                match entry {
                    Ok(entry) => pending.push((entry.path(), depth + 1)),
                    Err(error) if skippable(&error) => {}
                    Err(error) => return Err(error),
                }
            }
        }
    }
    Ok(Storage {
        path: root.display().to_string(),
        logical_bytes: Some(bytes),
        #[cfg(unix)]
        allocated_bytes: Some(allocated),
        #[cfg(not(unix))]
        allocated_bytes: None,
        files: Some(files),
        sampled_at_ms: Some(now_ms()),
        scan_ms: Some(started.elapsed().as_millis() as u64),
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn millisecond_fields_share_one_spelling_on_the_wire() {
        let storage = serde_json::to_value(Storage::pending(Path::new("/home"))).unwrap();
        let keys: Vec<&str> = storage
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        for key in ["sampledAtMs", "scanMs"] {
            assert!(keys.contains(&key), "no {key} in {keys:?}");
        }
    }

    #[test]
    fn scan_skips_links_counts_files_and_refuses_incomplete_results() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("file"), b"12345").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.path(), root.path().join("loop")).unwrap();
            std::fs::hard_link(root.path().join("file"), root.path().join("hardlink")).unwrap();
        }
        let stop = Demand::default();
        let sample = scan(root.path(), &stop).unwrap();
        assert_eq!((sample.logical_bytes, sample.files), (Some(5), Some(1)));
        stop.stop();
        assert!(scan(root.path(), &stop).is_err());
        assert!(scan(&root.path().join("missing"), &Demand::default()).is_err());
    }

    #[test]
    fn entries_removed_mid_scan_are_skipped_and_not_counted() {
        let root = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(root.path()).unwrap();
        std::fs::write(base.join("kept"), b"12345").unwrap();
        std::fs::write(base.join("gone"), b"123").unwrap();
        std::fs::create_dir(base.join("gone-dir")).unwrap();
        std::fs::write(base.join("gone-dir").join("inner"), b"1").unwrap();
        let (gone, gone_dir) = (base.join("gone"), base.join("gone-dir"));
        // The file goes before its stat; the directory goes after its stat and
        // before its read, the two windows a concurrent rename or merge opens.
        let sample = scan_with(root.path(), &Demand::default(), |path| {
            if path == gone {
                std::fs::remove_file(path).unwrap();
            }
            let metadata = std::fs::symlink_metadata(path);
            if path == gone_dir {
                std::fs::remove_dir_all(path).unwrap();
            }
            metadata
        })
        .unwrap();
        assert_eq!((sample.logical_bytes, sample.files), (Some(5), Some(1)));
        assert!(!gone.exists() && !gone_dir.exists(), "the hook did not run");
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_entries_are_skipped_and_not_counted() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("kept"), b"12345").unwrap();
        // No access at all: the directory itself cannot be read.
        let locked = root.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::write(locked.join("hidden"), b"123").unwrap();
        // Readable but not searchable: its names list, its entries cannot be
        // stat'ed.
        let listed = root.path().join("listed").join("deeper");
        std::fs::create_dir_all(&listed).unwrap();
        std::fs::write(listed.join("unstatable"), b"1").unwrap();
        let mode = |path: &Path, mode| {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap()
        };
        mode(&locked, 0o000);
        mode(&listed, 0o400);
        let privileged = std::fs::read_dir(&locked).is_ok();
        let sample = scan(root.path(), &Demand::default());
        let locked_root = scan(&locked, &Demand::default());
        mode(&locked, 0o700);
        mode(&listed, 0o700);
        if privileged {
            // Root (or CAP_DAC_OVERRIDE) reads every entry, so there is no
            // unreadable entry to skip here.
            eprintln!("SKIPPED: this process reads a 0o000 directory");
            return;
        }
        let sample = sample.unwrap();
        assert_eq!((sample.logical_bytes, sample.files), (Some(5), Some(1)));
        let error = locked_root.expect_err("an unreadable chan home is an error");
        assert_eq!(error.kind(), ErrorKind::PermissionDenied);
    }
}
