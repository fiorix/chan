// Per-workspace session blob storage. The schema of the stored bytes is
// the host's concern; chan-workspace treats every blob as opaque and just
// guarantees:
//
//   - atomic writes (tmpfile + fsync + rename);
//   - the key is a flat identifier, never a path component;
//   - the bucket dir is created on first write;
//   - delete is idempotent (missing key = Ok(()));
//   - list returns flat keys, sorted.
//
// `<bucket>/<key>` on disk; no file extension imposed because the
// blob is opaque. Hosts that want a `.json` suffix include it in
// the key.
//
// Why blobs in chan-workspace: hosts persist window and session state
// through `Workspace::put_session` and friends (chan-server's session
// routes do), so the safety story (atomic writes, key sandbox) lives in
// one place instead of being reimplemented by each host.

use std::fs;
use std::path::Path;

use crate::error::{ChanError, Result};
use crate::fs_ops;

/// Maximum length of a blob key. 255 matches the most common
/// filesystem filename ceiling (ext4, APFS, NTFS, btrfs, xfs);
/// callers can compose `<prefix>-<sha256>` (74 chars) or longer
/// natural identifiers without bumping the cap.
const MAX_KEY_LEN: usize = 255;

/// Validate a flat blob key. The key becomes a single path
/// component under the bucket dir, so it must not contain
/// separators, must not be empty, must not start with `.`
/// (defense against accidentally writing a hidden file when a
/// caller hands us an unsanitized name), and must not start with
/// `-` (defense against future shell-out paths that would treat
/// the key as a CLI flag; chan-workspace doesn't shell out today, but
/// the cost of forbidding it is zero and the cost of revisiting
/// after a CVE is real).
///
/// Allowed: ASCII alphanumeric, `-`, `_`, `.`. Length 1..=255.
/// 64-char sha256 hex fits; UUIDs with dashes fit; longer composite
/// identifiers fit.
pub(crate) fn validate_key(key: &str) -> Result<()> {
    if key.is_empty() {
        return Err(ChanError::InvalidKey("empty".into()));
    }
    if key.len() > MAX_KEY_LEN {
        return Err(ChanError::InvalidKey(format!(
            "{} exceeds {MAX_KEY_LEN} chars",
            key.len()
        )));
    }
    if key.starts_with('.') {
        return Err(ChanError::InvalidKey(
            "leading '.' (would write a hidden file)".into(),
        ));
    }
    if key.starts_with('-') {
        return Err(ChanError::InvalidKey(
            "leading '-' (would look like a CLI flag if shelled out)".into(),
        ));
    }
    for c in key.chars() {
        if !(c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') {
            return Err(ChanError::InvalidKey(format!(
                "illegal character {c:?}; allowed: ASCII alnum, '-', '_', '.'"
            )));
        }
    }
    Ok(())
}

/// Atomic write of `content` to `<bucket>/<key>`. Creates the
/// bucket dir on first call.
pub(crate) fn put(bucket: &Path, key: &str, content: &[u8]) -> Result<()> {
    validate_key(key)?;
    fs::create_dir_all(bucket)?;
    let path = bucket.join(key);
    fs_ops::atomic_write(&path, content)
}

/// Read `<bucket>/<key>`. Returns `Ok(None)` for missing key.
pub(crate) fn get(bucket: &Path, key: &str) -> Result<Option<Vec<u8>>> {
    validate_key(key)?;
    let path = bucket.join(key);
    match fs::read(&path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Sorted flat key list. Entries that are subdirs or whose names
/// fail `validate_key` are skipped (they're junk that didn't come
/// from `put`). Missing bucket dir returns empty.
pub(crate) fn list(bucket: &Path) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let rd = match fs::read_dir(bucket) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };
    for entry in rd.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if validate_key(name).is_err() {
            continue;
        }
        out.push(name.to_owned());
    }
    out.sort();
    Ok(out)
}

/// Idempotent delete; missing key is `Ok(())`.
pub(crate) fn delete(bucket: &Path, key: &str) -> Result<()> {
    validate_key(key)?;
    let path = bucket.join(key);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn put_get_round_trip() {
        let tmp = TempDir::new().unwrap();
        put(tmp.path(), "win-1", b"hello").unwrap();
        assert_eq!(
            get(tmp.path(), "win-1").unwrap().as_deref(),
            Some(&b"hello"[..])
        );
    }

    #[test]
    fn get_missing_returns_none() {
        let tmp = TempDir::new().unwrap();
        assert!(get(tmp.path(), "nope").unwrap().is_none());
    }

    #[test]
    fn list_returns_sorted_keys() {
        let tmp = TempDir::new().unwrap();
        put(tmp.path(), "b", b"").unwrap();
        put(tmp.path(), "a", b"").unwrap();
        put(tmp.path(), "c", b"").unwrap();
        assert_eq!(list(tmp.path()).unwrap(), vec!["a", "b", "c"]);
    }

    #[test]
    fn list_missing_bucket_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let bucket = tmp.path().join("never-created");
        assert!(list(&bucket).unwrap().is_empty());
    }

    #[test]
    fn list_skips_invalid_names_and_dirs() {
        let tmp = TempDir::new().unwrap();
        put(tmp.path(), "good", b"").unwrap();
        std::fs::write(tmp.path().join(".hidden"), b"").unwrap();
        std::fs::create_dir(tmp.path().join("subdir")).unwrap();
        assert_eq!(list(tmp.path()).unwrap(), vec!["good"]);
    }

    #[test]
    fn delete_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        put(tmp.path(), "x", b"v1").unwrap();
        delete(tmp.path(), "x").unwrap();
        delete(tmp.path(), "x").unwrap(); // no error second time
        assert!(get(tmp.path(), "x").unwrap().is_none());
    }

    #[test]
    fn validate_key_rejects() {
        assert!(validate_key("").is_err());
        assert!(validate_key(".hidden").is_err());
        assert!(validate_key("-flagshape").is_err());
        assert!(validate_key("a/b").is_err());
        assert!(validate_key("a\\b").is_err());
        assert!(validate_key("a b").is_err()); // no spaces
        assert!(validate_key(&"x".repeat(MAX_KEY_LEN + 1)).is_err());
    }

    #[test]
    fn validate_key_accepts() {
        validate_key("win-1").unwrap();
        validate_key("abc_def").unwrap();
        validate_key("conv.json").unwrap();
        validate_key(&"a".repeat(64)).unwrap(); // sha256 hex shape
                                                // Composite "<prefix>-<sha256>" shape (74 chars) fits comfortably.
        validate_key(&format!("session-{}", "0".repeat(64))).unwrap();
        // Right at the cap.
        validate_key(&"x".repeat(MAX_KEY_LEN)).unwrap();
    }

    #[test]
    fn put_rejects_path_traversal_via_key() {
        let tmp = TempDir::new().unwrap();
        assert!(put(tmp.path(), "../escape", b"x").is_err());
        assert!(put(tmp.path(), "a/b", b"x").is_err());
    }

    #[test]
    fn put_overwrites_existing() {
        let tmp = TempDir::new().unwrap();
        put(tmp.path(), "x", b"v1").unwrap();
        put(tmp.path(), "x", b"v2").unwrap();
        assert_eq!(get(tmp.path(), "x").unwrap().unwrap(), b"v2");
    }
}
