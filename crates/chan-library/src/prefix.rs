//! Deterministic route-prefix allocation for hosted tenants.
//!
//! A workspace mounts at a KEYED PATHSPEC `/{slug}-{8hex}`: a legible basename
//! slug plus 8 hex of the sha256 of the canonical root (the same hash that keys
//! per-workspace metadata, [`chan_workspace::paths::canonical_root_hash8`]). It
//! is deterministic -- the same root always maps to the same route across
//! restarts, and an OFF workspace has a stable prefix without a live tenant.
//! The prefix IS the public path the gateway forwards
//! (`{user}.devserver.chan.app/{slug}-{8hex}/`) unchanged, and the devserver
//! routes the tenant by it. The hash suffix keys the prefix to the *root*, not
//! just the basename, so two workspaces with the same basename under different
//! parents (`foo/hello`, `bar/hello`) get DISTINCT prefixes and both mount:
//! a same-basename pair never collides at mount time.
//! The window-record assembly on `WorkspaceHost` calls
//! [`allocate_workspace_prefix`] for the off-workspace case; the devserver
//! calls it on mount. Both derive the suffix identically from the canonical
//! root, so the gateway and devserver agree on the prefix.

use std::path::Path;

use crate::serve_config::sanitize_prefix;
use crate::Error;

/// Allocate a workspace's mount prefix from its root: the keyed pathspec
/// `/{slug}-{8hex}`, where `slug` is the sanitized last path segment and `8hex`
/// is [`chan_workspace::paths::canonical_root_hash8`] of the canonical root.
/// Deterministic so the same root always maps to the same route -- the workspace
/// re-mounts at the same prefix across a restart, and an OFF workspace has a
/// stable prefix without a live tenant. The prefix is the PUBLIC path the
/// gateway forwards; the hash suffix makes it unique per root, so two
/// same-basename roots map to DISTINCT prefixes and both mount (no collision).
pub fn allocate_workspace_prefix(root: &Path) -> Result<String, Error> {
    let slug = workspace_slug(root);
    let hash = chan_workspace::paths::canonical_root_hash8(root);
    sanitize_prefix(&format!("/{slug}-{hash}")).map_err(Error::Config)
}

/// Sanitize a path's final component into a legible `[a-z0-9-]` slug for a
/// prefix: lowercase, non-alphanumerics to `-`, collapsed and trimmed, length
/// capped, with a fallback for an empty result.
pub fn workspace_slug(root: &Path) -> String {
    let raw = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("workspace");
    let mut slug: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    let trimmed: String = slug.trim_matches('-').chars().take(24).collect();
    let trimmed = trimmed.trim_matches('-');
    if trimmed.is_empty() {
        "workspace".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The prefix is the keyed pathspec `/{slug}-{8hex}`: a legible basename
    /// slug plus a deterministic 8-hex hash of the canonical root.
    #[test]
    fn prefix_is_slug_plus_hex_suffix() {
        let parent = tempfile::tempdir().expect("parent");
        let root = parent.path().join("hello");
        std::fs::create_dir_all(&root).expect("mkdir");
        let prefix = allocate_workspace_prefix(&root).expect("prefix");
        assert!(
            prefix.starts_with("/hello-"),
            "keeps the legible basename slug: {prefix}"
        );
        let suffix = prefix.rsplit_once('-').expect("hashed suffix").1;
        assert_eq!(suffix.len(), 8, "8-hex hash suffix: {prefix}");
        assert!(
            suffix.chars().all(|c| c.is_ascii_hexdigit()),
            "suffix is hex: {prefix}"
        );
    }

    /// Deterministic: the same root always maps to the same prefix across
    /// calls, so a workspace re-mounts at the same route after a restart.
    #[test]
    fn same_root_is_stable() {
        let parent = tempfile::tempdir().expect("parent");
        let root = parent.path().join("notes");
        std::fs::create_dir_all(&root).expect("mkdir");
        let a = allocate_workspace_prefix(&root).expect("prefix a");
        let b = allocate_workspace_prefix(&root).expect("prefix b");
        assert_eq!(a, b);
    }

    /// Two workspaces that share a basename but live under different
    /// parents key off the canonical root, so they get DISTINCT prefixes and
    /// both mount -- the old basename-only slug collided and rejected the
    /// second.
    #[test]
    fn same_basename_distinct_roots_get_distinct_prefixes() {
        let p1 = tempfile::tempdir().expect("parent 1");
        let p2 = tempfile::tempdir().expect("parent 2");
        let r1 = p1.path().join("hello");
        let r2 = p2.path().join("hello");
        std::fs::create_dir_all(&r1).expect("mkdir 1");
        std::fs::create_dir_all(&r2).expect("mkdir 2");
        let a = allocate_workspace_prefix(&r1).expect("prefix 1");
        let b = allocate_workspace_prefix(&r2).expect("prefix 2");
        assert!(a.starts_with("/hello-"));
        assert!(b.starts_with("/hello-"));
        assert_ne!(a, b, "same basename, different root → different prefix");
    }
}
