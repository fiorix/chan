// Workspace bootstrap / pre-flight snapshot.
//
// The workspace exposes, immediately on open, a lightweight structural
// snapshot (directory tree shape, file counts, byte sizes) that the
// UI renders before any index or report job runs. This is the "spine"
// the partial-load flow hangs File Browser, Graph, and the
// paced background jobs off of.
//
// What this is, and is NOT:
//
//   * It is a STAT-ONLY walk. No file is opened, no content is read,
//     no graph edge is parsed. The cost is one filtered directory
//     walk plus a `metadata` per entry; it does not pressure the
//     file-descriptor budget the way the index / report jobs do.
//   * It is FILTERED by the same `WalkFilter` the indexer uses (one
//     ignore policy, not two): `node_modules`, `target`, ... plus the
//     hardcoded `.git/` / `.chan/` invariants. The editor-visible
//     on-demand APIs (`Workspace::list`, `Workspace::list_tree`) stay
//     unfiltered so a user can still open a file inside an ignored
//     directory on purpose; the bootstrap spine workspaces the DEFAULT
//     rendered tree and the paced jobs, so it honors the filter.
//   * The root response is the first level fully (root's immediate
//     files + dirs, each dir carrying its recursive subtree stats),
//     and aggregate subtree stats for the whole workspace. Deeper levels
//     load lazily on File Browser expand / Graph depth-increase via
//     the existing per-directory listing path; this module computes
//     the eager root level in one pass.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::error::Result;
use crate::fs_ops::{self, FileClass, IndexScopePolicy, WalkFilter};
use crate::workspace::WorkspaceGeneration;

/// Structural snapshot of one directory level, produced by the
/// bootstrap walk. Counts and sizes only; no content, no graph edges.
/// Serializable for the `/api/workspace/bootstrap` response and for the
/// FFI bridge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BootstrapTree {
    /// Workspace-relative POSIX dir path of this node ("" for the workspace
    /// root).
    pub path: String,
    /// Immediate child directories at this level, sorted by name.
    pub dirs: Vec<BootstrapDir>,
    /// Immediate child files at this level, sorted by name.
    pub files: Vec<BootstrapFile>,
    /// Aggregate over the WHOLE filtered subtree under `path`: total
    /// file count and summed bytes. Lets the UI show "1,240 files,
    /// 38 MB" on a collapsed directory without re-walking it.
    pub subtree: SubtreeStats,
}

/// One immediate child directory in a `BootstrapTree` level.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BootstrapDir {
    /// Basename (not a path).
    pub name: String,
    /// Recursive counts/sizes for everything under this directory
    /// (filtered). Workspaces the collapsed-directory affordance.
    pub subtree: SubtreeStats,
    /// Immediate-child directory count, so the UI can render
    /// "12 files, 3 folders" without expanding.
    pub child_dirs: u32,
    /// Immediate-child file count.
    pub child_files: u32,
}

/// One immediate child file in a `BootstrapTree` level.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BootstrapFile {
    /// Basename (not a path).
    pub name: String,
    pub size: u64,
    /// Last modification time as Unix seconds; 0 when unavailable.
    pub mtime: i64,
    /// File classification, matching the editor's `FileClass` gate so
    /// the UI classifies files the same way the editor does.
    pub class: FileClassWire,
}

/// Aggregate file count + byte total over a subtree (filtered).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubtreeStats {
    pub files: u64,
    pub bytes: u64,
}

impl SubtreeStats {
    fn add_file(&mut self, size: u64) {
        self.files += 1;
        self.bytes += size;
    }
}

/// Wire-stable mirror of `fs_ops::FileClass`. The internal enum is not
/// `Serialize` (it is a filesystem-classification detail); this is the
/// frozen JSON shape the SPA + FFI consume. A change here is an
/// explicit wire-shape edit, pinned by the test below.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileClassWire {
    EditableText,
    Text,
    Image,
    Pdf,
    Other,
}

impl From<FileClass> for FileClassWire {
    fn from(c: FileClass) -> Self {
        match c {
            FileClass::EditableText => FileClassWire::EditableText,
            FileClass::Text => FileClassWire::Text,
            FileClass::Image => FileClassWire::Image,
            FileClass::Pdf => FileClassWire::Pdf,
            FileClass::Other => FileClassWire::Other,
        }
    }
}

/// Walk `root` once (filtered) and build the eager root-level
/// `BootstrapTree`: every immediate file + directory of the workspace
/// root, each directory carrying its recursive subtree stats, plus
/// the whole-workspace aggregate.
///
/// One pass: for every file we bump the subtree stats of its
/// top-level ancestor directory (and the whole-workspace total). Immediate
/// children of the root are recorded directly. The walk reuses the
/// same `.git/` / `.chan/` + `WalkFilter` rules as the indexer's
/// `walk_workspace_filtered`, so the spine and the index agree on what is
/// part of the workspace.
pub fn bootstrap_root(root: &Path, filter: &WalkFilter) -> Result<BootstrapTree> {
    let policy = IndexScopePolicy::new(
        root.to_path_buf(),
        WorkspaceGeneration::INITIAL,
        filter.clone(),
    )?;
    bootstrap_root_scoped(root, &policy)
}

/// Build a `BootstrapTree` for the directory at workspace-relative `rel`
/// ("" for the workspace root). Used by the root bootstrap and, for
/// symmetry, by any caller that wants the same eager-level shape for a
/// nested directory (File Browser expand can reuse this rather than
/// the plain per-file listing when it wants subtree stats).
pub fn bootstrap_dir(root: &Path, rel: &str, filter: &WalkFilter) -> Result<BootstrapTree> {
    let policy = IndexScopePolicy::new(
        root.to_path_buf(),
        WorkspaceGeneration::INITIAL,
        filter.clone(),
    )?;
    bootstrap_dir_scoped(root, rel, &policy)
}

pub(crate) fn bootstrap_root_scoped(
    root: &Path,
    policy: &IndexScopePolicy,
) -> Result<BootstrapTree> {
    bootstrap_dir_scoped(root, "", policy)
}

pub(crate) fn bootstrap_dir_scoped(
    root: &Path,
    rel: &str,
    policy: &IndexScopePolicy,
) -> Result<BootstrapTree> {
    let base = if rel.is_empty() {
        root.to_path_buf()
    } else {
        fs_ops::resolve_safe_strict(root, rel)?
    };

    // Accumulators for each immediate child directory's recursive
    // subtree, plus the whole-level aggregate. Keyed by the immediate
    // child dir basename.
    let mut dir_subtrees: HashMap<String, SubtreeStats> = HashMap::new();
    let mut dir_child_dirs: HashMap<String, u32> = HashMap::new();
    let mut dir_child_files: HashMap<String, u32> = HashMap::new();
    let mut files: Vec<BootstrapFile> = Vec::new();
    let mut total = SubtreeStats::default();

    // Walk from `base`, depth >= 1 so we never re-emit `base` itself.
    // Mirror `walk_workspace_filtered`'s filter chain: skip `.git` /
    // `.chan` and any excluded dir basename at any depth; drop
    // symlinks / specials; never follow links; stay on one fs.
    let walker = WalkDir::new(&base)
        .min_depth(1)
        .follow_links(false)
        .same_file_system(true)
        .into_iter()
        .filter_entry(|e| {
            if !e.file_type().is_dir() {
                return true;
            }
            let Ok(rel) = e.path().strip_prefix(root) else {
                return false;
            };
            policy.includes(&rel.to_string_lossy().replace('\\', "/"), true)
        })
        .filter_map(|res| match res {
            Ok(e) => Some(e),
            Err(e) => {
                tracing::warn!("bootstrap walkdir error: {e}");
                None
            }
        })
        .filter(|e| {
            let ft = e.file_type();
            ft.is_dir() || ft.is_file()
        });

    for entry in walker {
        // Path relative to `base`, POSIX form. `depth` 1 is an
        // immediate child of `base`.
        let Ok(rel_to_base) = entry.path().strip_prefix(&base) else {
            continue;
        };
        let depth = entry.depth();
        let is_dir = entry.file_type().is_dir();

        // The first path component under `base` identifies the
        // immediate-child directory bucket this entry contributes to
        // (or, at depth 1, the entry itself).
        let first_component = rel_to_base
            .components()
            .next()
            .map(|c| c.as_os_str().to_string_lossy().into_owned());

        if depth == 1 {
            // Immediate child of `base`.
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_dir {
                dir_subtrees.entry(name.clone()).or_default();
                dir_child_dirs.entry(name.clone()).or_default();
                dir_child_files.entry(name).or_default();
            } else {
                let (size, mtime) = file_size_mtime(&entry);
                total.add_file(size);
                files.push(BootstrapFile {
                    name,
                    size,
                    mtime,
                    class: fs_ops::classify(&entry.file_name().to_string_lossy()).into(),
                });
            }
            continue;
        }

        // Deeper than the immediate level: it contributes to its
        // top-level ancestor directory's recursive subtree stats. We
        // do NOT record the entry itself (only counts roll up).
        let Some(bucket) = first_component else {
            continue;
        };
        if is_dir {
            // Count immediate sub-subdirs / sub-files only when depth
            // == 2 (direct child of an immediate child dir) so
            // `child_dirs` / `child_files` describe the bucket's own
            // immediate level, matching `BootstrapDir`'s contract.
            if depth == 2 {
                *dir_child_dirs.entry(bucket).or_default() += 1;
            }
        } else {
            let (size, _) = file_size_mtime(&entry);
            dir_subtrees
                .entry(bucket.clone())
                .or_default()
                .add_file(size);
            total.add_file(size);
            if depth == 2 {
                *dir_child_files.entry(bucket).or_default() += 1;
            }
        }
    }

    let mut dirs: Vec<BootstrapDir> = dir_subtrees
        .into_iter()
        .map(|(name, subtree)| {
            let child_dirs = dir_child_dirs.get(&name).copied().unwrap_or(0);
            let child_files = dir_child_files.get(&name).copied().unwrap_or(0);
            BootstrapDir {
                name,
                subtree,
                child_dirs,
                child_files,
            }
        })
        .collect();

    // Stable, predictable ordering for the UI (and for the test).
    dirs.sort_by(|a, b| a.name.cmp(&b.name));
    files.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(BootstrapTree {
        path: rel.to_string(),
        dirs,
        files,
        subtree: total,
    })
}

fn file_size_mtime(entry: &walkdir::DirEntry) -> (u64, i64) {
    match entry.metadata() {
        Ok(m) => {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            (m.len(), mtime)
        }
        Err(e) => {
            tracing::warn!(path = ?entry.path(), error = %e, "bootstrap metadata failed");
            (0, 0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write(root: &Path, rel: &str, body: &str) {
        let abs = root.join(rel);
        fs::create_dir_all(abs.parent().unwrap()).unwrap();
        fs::write(abs, body).unwrap();
    }

    #[test]
    fn root_level_counts_files_and_dirs_with_subtree_rollup() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        // Root-level files.
        write(root, "a.md", "alpha");
        write(root, "b.txt", "bravo body");
        // A nested dir with two levels.
        write(root, "notes/c.md", "charlie");
        write(root, "notes/sub/d.md", "delta deep");
        // A second top-level dir with one file.
        write(root, "media/pic.png", "not really a png");

        let filter = WalkFilter::default();
        let tree = bootstrap_root(root, &filter).unwrap();

        assert_eq!(tree.path, "");
        // Two root files (a.md, b.txt), sorted.
        let file_names: Vec<&str> = tree.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(file_names, vec!["a.md", "b.txt"]);
        assert_eq!(tree.files[0].class, FileClassWire::EditableText);

        // Two root dirs (media, notes), sorted.
        let dir_names: Vec<&str> = tree.dirs.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(dir_names, vec!["media", "notes"]);

        // `notes` subtree rolls up BOTH levels: c.md + sub/d.md.
        let notes = tree.dirs.iter().find(|d| d.name == "notes").unwrap();
        assert_eq!(notes.subtree.files, 2);
        // Immediate children of notes: 1 file (c.md), 1 dir (sub).
        assert_eq!(notes.child_files, 1);
        assert_eq!(notes.child_dirs, 1);

        // Whole-workspace aggregate: 5 files total.
        assert_eq!(tree.subtree.files, 5);
        // Byte total is the sum of all five file lengths.
        let expected_bytes: u64 = [
            "alpha",
            "bravo body",
            "charlie",
            "delta deep",
            "not really a png",
        ]
        .iter()
        .map(|s| s.len() as u64)
        .sum();
        assert_eq!(tree.subtree.bytes, expected_bytes);
    }

    #[test]
    fn walk_filter_excludes_named_dirs_from_spine() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write(root, "keep.md", "keep");
        write(root, "node_modules/dep/index.js", "junk");
        write(root, "node_modules/dep/readme.md", "junk doc");

        let filter = WalkFilter::new(["node_modules"]);
        let tree = bootstrap_root(root, &filter).unwrap();

        // node_modules is filtered out of the spine entirely.
        let dir_names: Vec<&str> = tree.dirs.iter().map(|d| d.name.as_str()).collect();
        assert!(dir_names.is_empty(), "expected no dirs, got {dir_names:?}");
        assert_eq!(tree.subtree.files, 1, "only keep.md should count");
        assert_eq!(tree.files.len(), 1);
        assert_eq!(tree.files[0].name, "keep.md");
    }

    #[test]
    fn skips_git_and_chan_invariants_without_filter() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write(root, "real.md", "real");
        write(root, ".git/HEAD", "ref: refs/heads/main");
        write(root, ".chan/leftover", "stale");

        let filter = WalkFilter::default();
        let tree = bootstrap_root(root, &filter).unwrap();

        assert!(tree.dirs.is_empty(), "no .git / .chan dirs in spine");
        assert_eq!(tree.subtree.files, 1);
        assert_eq!(tree.files[0].name, "real.md");
    }

    #[test]
    fn empty_workspace_yields_empty_spine() {
        let tmp = TempDir::new().unwrap();
        let filter = WalkFilter::default();
        let tree = bootstrap_root(tmp.path(), &filter).unwrap();
        assert_eq!(tree.path, "");
        assert!(tree.dirs.is_empty());
        assert!(tree.files.is_empty());
        assert_eq!(tree.subtree, SubtreeStats::default());
    }

    /// Wire-shape pin. Mirrors the `progress_event_serializes_for_the_
    /// wire` precedent: a change to any serialized field name or to the
    /// `FileClassWire` tag spelling is an explicit edit here, not a
    /// silent break of every connected client.
    #[test]
    fn bootstrap_tree_serializes_for_the_wire() {
        let tree = BootstrapTree {
            path: "notes".to_string(),
            dirs: vec![BootstrapDir {
                name: "recipes".to_string(),
                subtree: SubtreeStats {
                    files: 3,
                    bytes: 1024,
                },
                child_dirs: 1,
                child_files: 2,
            }],
            files: vec![BootstrapFile {
                name: "index.md".to_string(),
                size: 42,
                mtime: 1716700000,
                class: FileClassWire::EditableText,
            }],
            subtree: SubtreeStats {
                files: 4,
                bytes: 1066,
            },
        };
        let json = serde_json::to_value(&tree).unwrap();
        assert_eq!(json["path"], "notes");
        assert_eq!(json["dirs"][0]["name"], "recipes");
        assert_eq!(json["dirs"][0]["subtree"]["files"], 3);
        assert_eq!(json["dirs"][0]["subtree"]["bytes"], 1024);
        assert_eq!(json["dirs"][0]["child_dirs"], 1);
        assert_eq!(json["dirs"][0]["child_files"], 2);
        assert_eq!(json["files"][0]["name"], "index.md");
        assert_eq!(json["files"][0]["size"], 42);
        assert_eq!(json["files"][0]["mtime"], 1716700000_i64);
        assert_eq!(json["files"][0]["class"], "editable_text");
        assert_eq!(json["subtree"]["files"], 4);
        assert_eq!(json["subtree"]["bytes"], 1066);

        // Round-trips back to an equal value.
        let back: BootstrapTree = serde_json::from_value(json).unwrap();
        assert_eq!(back, tree);
    }

    #[test]
    fn file_class_wire_maps_every_internal_variant() {
        assert_eq!(
            FileClassWire::from(FileClass::EditableText),
            FileClassWire::EditableText
        );
        assert_eq!(FileClassWire::from(FileClass::Text), FileClassWire::Text);
        assert_eq!(FileClassWire::from(FileClass::Image), FileClassWire::Image);
        assert_eq!(FileClassWire::from(FileClass::Pdf), FileClassWire::Pdf);
        assert_eq!(FileClassWire::from(FileClass::Other), FileClassWire::Other);
    }
}
