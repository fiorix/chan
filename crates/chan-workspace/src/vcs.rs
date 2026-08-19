// VCS-parent detection: is the workspace path inside a Git / Mercurial /
// Subversion working tree?
//
// Used by `chan serve` to nudge users toward serving the repo root
// instead of an arbitrary subdir. If the workspace's notes live inside
// `~/code/myproject/docs/notes`, the user almost always wants
// `~/code/myproject` as the workspace root so cross-file links, graph,
// and search cover the whole project.
//
// Detection is a pure stat-walk; we never invoke `git`/`hg`/`svn`
// binaries and never read repository contents. Stops at mount
// boundaries, at `$HOME` (which is never inspected), and at the
// filesystem root.

use std::path::{Path, PathBuf};

/// Which VCS produced the match.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VcsKind {
    Git,
    Mercurial,
    Subversion,
}

impl VcsKind {
    /// Stable lowercase identifier for CLI error markers and
    /// structured logs. Wire-format; do not translate or rename.
    pub fn as_str(&self) -> &'static str {
        match self {
            VcsKind::Git => "git",
            VcsKind::Mercurial => "hg",
            VcsKind::Subversion => "svn",
        }
    }
}

/// A VCS working tree that contains the queried path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VcsParent {
    pub kind: VcsKind,
    /// Canonical path to the working-tree root (the directory that
    /// holds `.git` / `.hg` / `.svn`).
    pub repo_root: PathBuf,
}

/// Find the nearest VCS working tree strictly *above* `path`.
///
/// Returns `None` when no VCS marker is found, when the walk crosses
/// a filesystem mount boundary, when it reaches `$HOME`, or when it
/// reaches the filesystem root. The input path itself is NOT checked:
/// if the user picks the repo root as the workspace root, the function
/// returns `None` so the caller can proceed silently.
///
/// Detection looks for, at each strict ancestor:
///
///   - `.git` (file OR directory; the file form covers worktrees and
///     submodules whose `.git` is a pointer to a gitdir elsewhere),
///   - `.hg/` directory (Mercurial),
///   - `.svn/` directory (Subversion 1.7+ keeps it at the repo root).
///
/// `$HOME` is deliberately excluded so a dotfiles-managed-as-git
/// home directory does not block every workspace the user has.
///
/// Pure stat calls; never spawns external processes.
pub fn detect_parent_vcs(path: &Path) -> Option<VcsParent> {
    detect_parent_vcs_with_home(path, dirs::home_dir())
}

/// Detect whether the workspace root itself is a VCS working tree whose
/// control files can signal a bulk checkout/update.
///
/// This is deliberately narrower than [`detect_parent_vcs`]: it only
/// checks the root the user chose, and only the mutable control files
/// the watcher cares about. We do not shell out or parse VCS metadata.
pub fn detect_workspace_vcs(path: &Path) -> Option<VcsKind> {
    if is_regular_file(&path.join(".git").join("HEAD")) {
        return Some(VcsKind::Git);
    }
    if is_regular_file(&path.join(".hg").join("dirstate")) {
        return Some(VcsKind::Mercurial);
    }
    None
}

/// VCS control paths worth surfacing through the watcher even though
/// the rest of `.git/` and `.hg/` stays hidden from normal consumers.
pub fn is_vcs_control_path(rel: &str) -> bool {
    matches!(rel, ".git/HEAD" | ".git/index" | ".hg/dirstate")
}

/// Test helper: the same algorithm as [`detect_parent_vcs`], but with
/// an explicit `home` override so tests can workspace the `$HOME` stop
/// without touching the developer's real home directory.
pub(crate) fn detect_parent_vcs_with_home(path: &Path, home: Option<PathBuf>) -> Option<VcsParent> {
    let start = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let home_canon = home.and_then(|h| std::fs::canonicalize(&h).ok());
    let start_dev = dev_of(&start);

    // Skip the leaf: only inspect strict ancestors. If the leaf is
    // itself a repo root, we want to return None so `chan serve`
    // proceeds without prompting the user.
    let mut iter = start.ancestors();
    let _leaf = iter.next();

    for dir in iter {
        // Mount-boundary stop. If we have a `start_dev` and the
        // ancestor lives on a different filesystem, don't cross it:
        // a `.git` on the host won't be reachable from a workspace
        // sitting on a separate mount and suggesting it would just
        // confuse the user.
        if let (Some(a), Some(b)) = (start_dev, dev_of(dir)) {
            if a != b {
                return None;
            }
        }
        // `$HOME` stop. Don't inspect home itself; a dotfiles-as-git
        // setup is unrelated to workspace-root selection.
        if let Some(h) = &home_canon {
            if dir == h {
                return None;
            }
        }
        if let Some(kind) = vcs_kind_at(dir) {
            return Some(VcsParent {
                kind,
                repo_root: dir.to_path_buf(),
            });
        }
    }
    None
}

fn vcs_kind_at(dir: &Path) -> Option<VcsKind> {
    if is_git_marker(&dir.join(".git")) {
        return Some(VcsKind::Git);
    }
    if is_real_dir(&dir.join(".hg")) {
        return Some(VcsKind::Mercurial);
    }
    if is_real_dir(&dir.join(".svn")) {
        return Some(VcsKind::Subversion);
    }
    None
}

/// `.git` is a marker only when it is a real directory (regular
/// repo) or a real regular file (worktree / submodule pointer
/// whose contents are `gitdir: ...`). Symlinks, FIFOs, sockets,
/// and devices are rejected: real Git never produces those at
/// this path, and trusting them lets a tampered tree fool the
/// suggestion. Matches the crate-wide "lstat, never stat, on user
/// paths" invariant from .agents/principles.md.
fn is_git_marker(p: &Path) -> bool {
    match std::fs::symlink_metadata(p) {
        Ok(md) => {
            let ft = md.file_type();
            ft.is_dir() || ft.is_file()
        }
        Err(_) => false,
    }
}

/// `.hg` and `.svn` are markers only when they are real
/// directories: anything else (symlink, special file) is treated
/// as absent.
fn is_real_dir(p: &Path) -> bool {
    std::fs::symlink_metadata(p)
        .map(|md| md.file_type().is_dir())
        .unwrap_or(false)
}

fn is_regular_file(p: &Path) -> bool {
    std::fs::symlink_metadata(p)
        .map(|md| md.file_type().is_file())
        .unwrap_or(false)
}

#[cfg(unix)]
fn dev_of(path: &Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    // lstat (`symlink_metadata`), not stat: if `canonicalize`
    // failed at the top of `detect_parent_vcs_with_home`, we're
    // walking the raw input, and an ancestor that is itself a
    // symlink would otherwise return the target's `st_dev`,
    // hiding a real mount-boundary crossing. After canonicalize
    // succeeds the path has no in-path symlinks; lstat == stat
    // for those, so this is also free in the common case.
    std::fs::symlink_metadata(path).ok().map(|m| m.dev())
}

#[cfg(not(unix))]
fn dev_of(_path: &Path) -> Option<u64> {
    // No portable `st_dev` equivalent on Windows in stable std.
    // Skip the mount-boundary check there; the home + FS-root
    // stops still apply.
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn mkdir(p: &Path) {
        std::fs::create_dir_all(p).unwrap();
    }

    fn canon(p: &Path) -> PathBuf {
        std::fs::canonicalize(p).unwrap()
    }

    fn temp_parent_home(tmp: &TempDir) -> Option<PathBuf> {
        tmp.path().parent().map(|p| p.to_path_buf())
    }

    #[test]
    fn none_when_no_vcs() {
        let tmp = TempDir::new().unwrap();
        let workspace = tmp.path().join("notes");
        mkdir(&workspace);
        assert!(detect_parent_vcs_with_home(&workspace, temp_parent_home(&tmp)).is_none());
    }

    #[test]
    fn detects_git_dir_at_ancestor() {
        let tmp = TempDir::new().unwrap();
        mkdir(&tmp.path().join(".git"));
        let workspace = tmp.path().join("docs/notes");
        mkdir(&workspace);
        let got = detect_parent_vcs_with_home(&workspace, temp_parent_home(&tmp)).unwrap();
        assert_eq!(got.kind, VcsKind::Git);
        assert_eq!(canon(&got.repo_root), canon(tmp.path()));
    }

    #[test]
    fn detects_git_file_at_ancestor() {
        // Submodule / worktree shape: `.git` is a regular file
        // containing `gitdir: ...`, not a directory.
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join(".git"), b"gitdir: /elsewhere\n").unwrap();
        let workspace = tmp.path().join("docs");
        mkdir(&workspace);
        let got = detect_parent_vcs_with_home(&workspace, temp_parent_home(&tmp)).unwrap();
        assert_eq!(got.kind, VcsKind::Git);
    }

    #[test]
    fn detects_hg() {
        let tmp = TempDir::new().unwrap();
        mkdir(&tmp.path().join(".hg"));
        let workspace = tmp.path().join("docs");
        mkdir(&workspace);
        let got = detect_parent_vcs_with_home(&workspace, temp_parent_home(&tmp)).unwrap();
        assert_eq!(got.kind, VcsKind::Mercurial);
    }

    #[test]
    fn detects_workspace_vcs_from_checkout_control_files() {
        let tmp = TempDir::new().unwrap();
        mkdir(&tmp.path().join(".git"));
        std::fs::write(tmp.path().join(".git/HEAD"), b"ref: refs/heads/main\n").unwrap();
        assert_eq!(detect_workspace_vcs(tmp.path()), Some(VcsKind::Git));

        let hg = TempDir::new().unwrap();
        mkdir(&hg.path().join(".hg"));
        std::fs::write(hg.path().join(".hg/dirstate"), b"state").unwrap();
        assert_eq!(detect_workspace_vcs(hg.path()), Some(VcsKind::Mercurial));
    }

    #[cfg(unix)]
    #[test]
    fn workspace_vcs_detection_rejects_symlinked_control_files() {
        let tmp = TempDir::new().unwrap();
        mkdir(&tmp.path().join(".git"));
        let target = tmp.path().join("head-target");
        std::fs::write(&target, b"ref: refs/heads/main\n").unwrap();
        std::os::unix::fs::symlink(&target, tmp.path().join(".git/HEAD")).unwrap();
        assert_eq!(detect_workspace_vcs(tmp.path()), None);
    }

    #[test]
    fn vcs_control_path_allowlist_is_exact() {
        assert!(is_vcs_control_path(".git/HEAD"));
        assert!(is_vcs_control_path(".git/index"));
        assert!(is_vcs_control_path(".hg/dirstate"));
        assert!(!is_vcs_control_path(".git/objects/pack"));
        assert!(!is_vcs_control_path(".hg/store/data"));
    }

    #[test]
    fn detects_svn() {
        let tmp = TempDir::new().unwrap();
        mkdir(&tmp.path().join(".svn"));
        let workspace = tmp.path().join("docs");
        mkdir(&workspace);
        let got = detect_parent_vcs_with_home(&workspace, temp_parent_home(&tmp)).unwrap();
        assert_eq!(got.kind, VcsKind::Subversion);
    }

    #[test]
    fn skips_leaf_when_path_is_repo_root() {
        // When the workspace root is the repo root itself, the function
        // must return None: the caller is meant to proceed silently
        // because there's no better parent to suggest.
        let tmp = TempDir::new().unwrap();
        mkdir(&tmp.path().join(".git"));
        assert!(detect_parent_vcs_with_home(tmp.path(), temp_parent_home(&tmp)).is_none());
    }

    #[test]
    fn home_stop_filters_dotfiles_as_git() {
        // `.git` at a synthetic "home" must NOT be reported when the
        // workspace is a child of that home: dotfiles-managed-as-git in
        // the user's home directory is common and unrelated to
        // workspace-root selection.
        let tmp = TempDir::new().unwrap();
        let fake_home = tmp.path().join("home");
        mkdir(&fake_home);
        mkdir(&fake_home.join(".git"));
        let workspace = fake_home.join("notes");
        mkdir(&workspace);
        let got = detect_parent_vcs_with_home(&workspace, Some(fake_home));
        assert!(got.is_none(), "expected None, got {got:?}");
    }

    #[test]
    fn finds_repo_below_home() {
        // Standard case: clone under home, workspace is a subdir of the
        // clone. We want the clone reported as the repo root.
        let tmp = TempDir::new().unwrap();
        let fake_home = tmp.path().join("home");
        let clone = fake_home.join("code/myproject");
        mkdir(&clone.join(".git"));
        let workspace = clone.join("docs/notes");
        mkdir(&workspace);
        let got = detect_parent_vcs_with_home(&workspace, Some(fake_home)).unwrap();
        assert_eq!(got.kind, VcsKind::Git);
        assert_eq!(canon(&got.repo_root), canon(&clone));
    }

    #[test]
    fn handles_nonexistent_leaf() {
        // `chan serve` may pass a path that doesn't exist yet
        // (auto-creation happens later in cmd_serve). Detection
        // should still walk the existing ancestors.
        let tmp = TempDir::new().unwrap();
        mkdir(&tmp.path().join(".git"));
        let nonexistent = tmp.path().join("not-yet/sub");
        let got = detect_parent_vcs_with_home(&nonexistent, temp_parent_home(&tmp)).unwrap();
        assert_eq!(got.kind, VcsKind::Git);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_git_as_symlink_to_dir() {
        // A symlinked `.git` is not a marker we trust: real Git
        // never produces this, and following it would let a planted
        // symlink (to a real repo elsewhere) misroute the
        // suggestion. Consistent with fs_ops's symlink policy.
        use std::os::unix::fs::symlink;
        let tmp = TempDir::new().unwrap();
        let real_git = tmp.path().join("real-git");
        mkdir(&real_git);
        let parent = tmp.path().join("parent");
        mkdir(&parent);
        symlink(&real_git, parent.join(".git")).unwrap();
        let workspace = parent.join("docs");
        mkdir(&workspace);
        let got = detect_parent_vcs_with_home(&workspace, temp_parent_home(&tmp));
        assert!(got.is_none(), "expected None, got {got:?}");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_hg_as_symlink_to_dir() {
        use std::os::unix::fs::symlink;
        let tmp = TempDir::new().unwrap();
        let real_hg = tmp.path().join("real-hg");
        mkdir(&real_hg);
        let parent = tmp.path().join("parent");
        mkdir(&parent);
        symlink(&real_hg, parent.join(".hg")).unwrap();
        let workspace = parent.join("docs");
        mkdir(&workspace);
        let got = detect_parent_vcs_with_home(&workspace, temp_parent_home(&tmp));
        assert!(got.is_none(), "expected None, got {got:?}");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_git_as_fifo() {
        // A FIFO at `.git` would make plain `exists()` say "yes" and
        // misroute the suggestion. The lstat + filetype gate keeps
        // detection limited to real dirs / real regular files.
        use std::ffi::CString;
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path().join("parent");
        mkdir(&parent);
        let fifo = parent.join(".git");
        let cpath = CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        // mkfifo(3): create a named pipe at `cpath` mode 0600.
        // SAFETY: cpath is a valid NUL-terminated path; no aliasing.
        let rc = unsafe { libc_mkfifo(cpath.as_ptr(), 0o600) };
        assert_eq!(rc, 0, "mkfifo failed: errno may apply");
        let workspace = parent.join("docs");
        mkdir(&workspace);
        let got = detect_parent_vcs_with_home(&workspace, temp_parent_home(&tmp));
        assert!(got.is_none(), "expected None, got {got:?}");
    }

    #[cfg(unix)]
    extern "C" {
        // Avoid pulling the `libc` crate just for one syscall in
        // tests; declare the prototype locally.
        #[link_name = "mkfifo"]
        fn libc_mkfifo(path: *const std::ffi::c_char, mode: u32) -> i32;
    }

    #[test]
    fn vcs_kind_str_is_stable() {
        // The CLI error marker format pins these strings as wire
        // format; renaming the enum must not change them.
        assert_eq!(VcsKind::Git.as_str(), "git");
        assert_eq!(VcsKind::Mercurial.as_str(), "hg");
        assert_eq!(VcsKind::Subversion.as_str(), "svn");
    }
}
