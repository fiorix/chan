//! Whether the whole-tree listing lists a path as a file, answered path by
//! path from the disk instead of from a walk.

use std::collections::HashMap;
use std::sync::Arc;

use super::{ListedNames, Workspace};
use crate::fs_ops::{self, IndexScopePolicy};

/// Answers, one path at a time, whether
/// [`Workspace::list_tree_filtered_unified`] lists a path as a file, with
/// no walk and no entry cap, for a caller that asks about a few paths.
///
/// A path is listed when it is spelled as the listing spells it (relative,
/// `/`-separated, no `.`, `..` or empty component), names a regular file
/// (not a symlink, a folder or a special file) inside the scope policy,
/// and every directory above it is one the walk enters: a real directory
/// (not a symlink to one) inside the scope policy and, on Unix, on the
/// root's file system. Elsewhere a directory on another volume is reached
/// through a mount point, a reparse point the walk enters no more than a
/// symlink. Each component must also be listed byte for byte by the
/// directory above it, so a spelling that a case-folding volume finds but
/// does not store is not listed, nor is a path under a directory that
/// cannot be read.
///
/// Every read goes through the workspace's capability sandbox and is made
/// once for the life of the value, which holds each answer: one lstat per
/// path asked, then for a regular file one lstat per directory above it
/// and one listing per directory on its path. A path not spelled as the
/// listing spells it reads nothing, and a path that names no regular file
/// reads nothing past its own lstat. A file whose name is not UTF-8 is
/// listed under a lossy spelling that no lookup finds.
pub struct ListedFiles {
    /// The key the test hooks count this workspace's reads under.
    #[cfg(any(test, feature = "test-hooks"))]
    hooks_key: std::path::PathBuf,
    dir: Arc<cap_std::fs::Dir>,
    policy: Arc<IndexScopePolicy>,
    /// The root's device, which every directory the walk enters is on;
    /// `None` when it cannot be read, as then the walk lists nothing.
    #[cfg(unix)]
    root_device: Option<u64>,
    names: ListedNames,
    /// Whether the walk enters each directory asked about.
    entered: HashMap<String, bool>,
    /// Whether the walk lists each path asked about as a file.
    files: HashMap<String, bool>,
}

impl ListedFiles {
    pub(super) fn new(workspace: &Workspace) -> Self {
        let dir = workspace.fs.dir();
        #[cfg(unix)]
        let root_device = {
            use cap_std::fs::MetadataExt;
            dir.dir_metadata().ok().map(|metadata| metadata.dev())
        };
        Self {
            #[cfg(any(test, feature = "test-hooks"))]
            hooks_key: workspace.paths.graph_dir.clone(),
            names: ListedNames::new(Arc::clone(&dir)),
            dir,
            policy: workspace.scope_policy(),
            #[cfg(unix)]
            root_device,
            entered: HashMap::new(),
            files: HashMap::new(),
        }
    }

    /// Whether the whole-tree listing lists `rel` as a file.
    pub fn lists(&mut self, rel: &str) -> bool {
        if let Some(&listed) = self.files.get(rel) {
            return listed;
        }
        let listed = self.read(rel);
        self.files.insert(rel.to_owned(), listed);
        listed
    }

    fn read(&mut self, rel: &str) -> bool {
        let Ok(validated) = fs_ops::validate_rel(rel) else {
            return false;
        };
        if fs_ops::rel_path_text(&validated) != rel {
            return false;
        }
        #[cfg(unix)]
        if self.root_device.is_none() {
            return false;
        }
        #[cfg(any(test, feature = "test-hooks"))]
        super::listing_limit_test_hooks::record_listed_file_read(&self.hooks_key, rel);
        // An lstat, so a symlink is neither a file nor a directory.
        let Ok(metadata) = self.dir.symlink_metadata(&validated) else {
            return false;
        };
        if !metadata.is_file() {
            return false;
        }
        // Each directory from the root down, so none is read below one the
        // walk does not enter.
        for (at, _) in rel.match_indices('/') {
            if !self.entered(&rel[..at]) {
                return false;
            }
        }
        self.policy.includes(rel, false) && self.names.lists(rel) == Some(true)
    }

    /// Whether the walk enters the directory `dir`, a path whose parent it
    /// enters.
    fn entered(&mut self, dir: &str) -> bool {
        if let Some(&entered) = self.entered.get(dir) {
            return entered;
        }
        #[cfg(any(test, feature = "test-hooks"))]
        super::listing_limit_test_hooks::record_listed_file_read(&self.hooks_key, dir);
        let entered = self.dir.symlink_metadata(dir).is_ok_and(|metadata| {
            metadata.is_dir() && self.on_root_device(&metadata) && self.policy.includes(dir, true)
        });
        self.entered.insert(dir.to_owned(), entered);
        entered
    }

    #[cfg(unix)]
    fn on_root_device(&self, metadata: &cap_std::fs::Metadata) -> bool {
        use cap_std::fs::MetadataExt;
        self.root_device == Some(metadata.dev())
    }

    #[cfg(not(unix))]
    fn on_root_device(&self, _metadata: &cap_std::fs::Metadata) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::Library;
    use crate::workspace::listing_limit_test_hooks::listed_file_reads;
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::Path;
    use tempfile::TempDir;

    fn put(root: &Path, rel: &str, body: &[u8]) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    /// The workspace at `root`, with its startup recovery stopped, and the
    /// directory that holds its configuration.
    fn open(root: &Path) -> (TempDir, Arc<Workspace>) {
        let config = TempDir::new().unwrap();
        let library = Library::open_at(config.path().join("config.toml")).unwrap();
        library.register_workspace(root).unwrap();
        let workspace = library.open_workspace(root).unwrap();
        workspace.stop_open_recovery();
        (config, workspace)
    }

    /// The files and the directories the whole-tree listing lists.
    fn walked(workspace: &Workspace) -> (BTreeSet<String>, BTreeSet<String>) {
        let (dirs, files) = workspace
            .list_tree_filtered_unified()
            .unwrap()
            .into_iter()
            .partition::<Vec<_>, _>(|entry| entry.is_dir);
        let paths = |entries: Vec<crate::TreeEntry>| entries.into_iter().map(|e| e.path).collect();
        (paths(files), paths(dirs))
    }

    /// Puts a directory's mode back when the test ends, pass or fail, so
    /// that a user who is not root can remove the temporary directory.
    #[cfg(unix)]
    struct ModeRestore(std::path::PathBuf, std::fs::Permissions);

    #[cfg(unix)]
    impl Drop for ModeRestore {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, self.1.clone());
        }
    }

    // Every path the listing lists as a file is listed, and nothing else
    // is: not a folder, a file the `.gitignore` names, a file below a
    // folder it names or a folder the configuration excludes, a file
    // through a symlinked folder, a symlink, a socket, a file below a
    // folder that cannot be read, a path out of the root, nor a spelling
    // the listing does not use for a file it lists.
    #[test]
    fn listed_files_answer_as_the_listing_lists() {
        let outer = TempDir::new().unwrap();
        let root = outer.path().join("workspace");
        put(outer.path(), "outside.log", b"outside\n");
        for rel in [
            "top.md",
            "LICENSE",
            "notes/a.md",
            "notes/sub/deep.log",
            "notes/hidden.log",
            "hidden.log",
            "keys/key.secret",
            "build/keep.txt",
            "node_modules/pkg/index.js",
            "locked/in.md",
        ] {
            put(&root, rel, b"x\n");
        }
        put(
            &root,
            ".gitignore",
            b"*.secret\n/hidden.log\nbuild/\n!build/keep.txt\n",
        );
        #[cfg(unix)]
        let _restore = {
            use std::os::unix::fs::{symlink, PermissionsExt};
            symlink("notes", root.join("alias")).unwrap();
            symlink("top.md", root.join("link.md")).unwrap();
            symlink(outer.path(), root.join("out")).unwrap();
            std::os::unix::net::UnixListener::bind(root.join("notes/sock")).unwrap();
            let locked = root.join("locked");
            let restore = ModeRestore(
                locked.clone(),
                std::fs::metadata(&locked).unwrap().permissions(),
            );
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o311)).unwrap();
            restore
        };
        let (_config, workspace) = open(&root);
        let (files, dirs) = walked(&workspace);
        let mut expected: BTreeSet<String> = [
            ".gitignore",
            "LICENSE",
            "notes/a.md",
            "notes/hidden.log",
            "notes/sub/deep.log",
            "top.md",
        ]
        .map(String::from)
        .into();
        // Root reads a folder whatever its mode.
        let locked_lists = std::fs::read_dir(root.join("locked")).is_ok();
        if locked_lists {
            expected.insert("locked/in.md".to_string());
        }
        assert_eq!(files, expected, "fixture: the files the listing lists");
        assert!(
            workspace.scope_policy().includes("build/keep.txt", false),
            "fixture: the scope keeps the file below the folder it leaves out"
        );

        let mut probes: Vec<String> = files.iter().chain(&dirs).cloned().collect();
        probes.extend(
            [
                "hidden.log",
                "keys/key.secret",
                "build/keep.txt",
                "node_modules/pkg/index.js",
                "locked/in.md",
                "alias/a.md",
                "link.md",
                "out/outside.log",
                "notes/sock",
                "../outside.log",
                "./top.md",
                "/top.md",
                "notes//a.md",
                "notes/./a.md",
                "notes/a.md/",
                "notes/sub/../a.md",
                "TOP.md",
                "top.md/x",
                "missing.md",
                "notes/missing/x.md",
                "",
            ]
            .map(String::from),
        );
        let mut listed = workspace.listed_files();
        let differ: Vec<(&str, bool)> = probes
            .iter()
            .map(|probe| (probe.as_str(), listed.lists(probe)))
            .filter(|(probe, lists)| *lists != files.contains(*probe))
            .collect();
        assert_eq!(
            differ,
            vec![],
            "paths answered otherwise than the listing lists them"
        );
    }

    // The listing enters only folders on the root's file system, so a file
    // below a folder on another device is not listed, while one at the root
    // is. With no device for the root the listing lists nothing.
    #[cfg(unix)]
    #[test]
    fn listed_files_leave_out_files_below_a_folder_on_another_device() {
        let root = TempDir::new().unwrap();
        put(root.path(), "top.md", b"x\n");
        put(root.path(), "notes/a.md", b"x\n");
        let (_config, workspace) = open(root.path());
        let mut listed = workspace.listed_files();
        assert!(
            listed.lists("top.md") && listed.lists("notes/a.md"),
            "fixture: both files are listed"
        );

        let mut moved = workspace.listed_files();
        let device = moved.root_device.expect("fixture: the root's device");
        moved.root_device = Some(device ^ 1);
        assert_eq!(
            [moved.lists("top.md"), moved.lists("notes/a.md")],
            [true, false],
            "with `notes` on another device than the root"
        );

        let mut unread = workspace.listed_files();
        unread.root_device = None;
        assert!(!unread.lists("top.md"), "with no device for the root");
    }

    // Each path is read once per value: a path asked again, a folder above
    // two paths and a path that names no file. A path the listing does not
    // spell reads nothing, and a path that names no file reads no folder
    // above it.
    #[test]
    fn listed_files_read_each_path_once() {
        let root = TempDir::new().unwrap();
        put(root.path(), "top.md", b"x\n");
        put(root.path(), "notes/a.md", b"x\n");
        put(root.path(), "notes/sub/deep.log", b"x\n");
        put(root.path(), "docs/leaf.md", b"x\n");
        let (_config, workspace) = open(root.path());
        let before = listed_file_reads(&workspace);
        let mut listed = workspace.listed_files();
        for _ in 0..2 {
            for rel in [
                "notes/sub/deep.log",
                "notes/a.md",
                "notes/missing.md",
                "docs/missing.md",
                "./top.md",
            ] {
                listed.lists(rel);
            }
        }
        let after = listed_file_reads(&workspace);
        let read: BTreeMap<&str, usize> = after
            .iter()
            .map(|(rel, n)| (rel.as_str(), n - before.get(rel).copied().unwrap_or(0)))
            .filter(|(_, n)| *n > 0)
            .collect();
        assert_eq!(
            read,
            [
                ("docs/missing.md", 1),
                ("notes", 1),
                ("notes/a.md", 1),
                ("notes/missing.md", 1),
                ("notes/sub", 1),
                ("notes/sub/deep.log", 1),
            ]
            .into(),
        );
    }

    // On a case-folding volume an lstat finds a file under any spelling of
    // its name or of a folder above it, and the listing lists the stored
    // spelling alone.
    #[test]
    fn listed_files_answer_by_the_stored_spelling() {
        let Some(base) =
            crate::workspace::casefold_test_dir("listed_files_answer_by_the_stored_spelling")
        else {
            return;
        };
        let root = TempDir::new_in(&base).unwrap();
        put(root.path(), "Note.md", b"x\n");
        put(root.path(), "Sub/Deep.md", b"x\n");
        let (_config, workspace) = open(root.path());
        assert_eq!(
            walked(&workspace).0,
            ["Note.md", "Sub/Deep.md"].map(String::from).into(),
            "fixture: the files the listing lists"
        );
        let mut listed = workspace.listed_files();
        assert_eq!(
            [
                "Note.md",
                "Sub/Deep.md",
                "note.md",
                "sub/Deep.md",
                "Sub/deep.md"
            ]
            .map(|rel| listed.lists(rel)),
            [true, true, false, false, false]
        );
    }
}
