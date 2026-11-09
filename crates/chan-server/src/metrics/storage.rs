use std::path::Path;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::{now_ms, Stop};

/// Last completed chan-home scan; a failed refresh preserves these totals.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Storage {
    pub path: String,
    pub logical_bytes: Option<u64>,
    pub allocated_bytes: Option<u64>,
    pub files: Option<u64>,
    pub sampled_at_ms: Option<u64>,
    pub scan_millis: Option<u64>,
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
            scan_millis: None,
            error: None,
        }
    }
}

pub(super) fn scan(root: &Path, stop: &Stop) -> std::io::Result<Storage> {
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
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "storage scan interrupted or exceeded its bound",
            ));
        }
        visited += 1;
        let metadata = std::fs::symlink_metadata(&path)?;
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
            for entry in std::fs::read_dir(&path)? {
                if stop.is_stopped()
                    || pending.len() >= 1_000_000
                    || started.elapsed() > Duration::from_secs(30)
                {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Interrupted,
                        "storage scan interrupted or exceeded its bound",
                    ));
                }
                pending.push((entry?.path(), depth + 1));
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
        scan_millis: Some(started.elapsed().as_millis() as u64),
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scan_skips_links_counts_files_and_refuses_incomplete_results() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("file"), b"12345").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.path(), root.path().join("loop")).unwrap();
            std::fs::hard_link(root.path().join("file"), root.path().join("hardlink")).unwrap();
        }
        let stop = Stop::default();
        let sample = scan(root.path(), &stop).unwrap();
        assert_eq!((sample.logical_bytes, sample.files), (Some(5), Some(1)));
        stop.stop();
        assert!(scan(root.path(), &stop).is_err());
        assert!(scan(&root.path().join("missing"), &Stop::default()).is_err());
    }
}
