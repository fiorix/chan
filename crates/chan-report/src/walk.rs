// Walker over the configured root.
//
// Wraps the `ignore` crate so consumers get gitignore-aware,
// hidden-file-aware traversal with the chan-report defaults
// applied. Emits workspace-relative POSIX paths the counter can
// consume directly.
//
// `Filter` caches the gitignore + override matchers so
// `Index::update` can reapply them per file without rebuilding
// the matchers on every event.

use ignore::gitignore::Gitignore;
use ignore::overrides::{Override, OverrideBuilder};
use ignore::WalkBuilder;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::error::ChanReportError;
use crate::{ReportOptions, ReportPathPolicy};

/// Cached accept-filter used by both the initial walk and the
/// incremental `Index::update` path. Built once at scan time.
pub(crate) struct Filter {
    include_hidden: bool,
    overrides: Option<Override>,
    gitignore: Option<Gitignore>,
    path_policy: Option<Arc<dyn ReportPathPolicy>>,
}

impl Filter {
    pub(crate) fn build(opts: &ReportOptions) -> Result<Self, ChanReportError> {
        if let Some(path_policy) = &opts.path_policy {
            return Ok(Self {
                include_hidden: true,
                overrides: None,
                gitignore: None,
                path_policy: Some(Arc::clone(path_policy)),
            });
        }
        let overrides = if opts.exclude_globs.is_empty() {
            None
        } else {
            let mut b = OverrideBuilder::new(&opts.root);
            for g in &opts.exclude_globs {
                // ignore::Override patterns are gitignore-style but
                // semantically inverted: unprefixed = whitelist,
                // `!` = ignore. exclude_globs is an exclude list,
                // so prefix every entry with `!`. Strip any caller-
                // provided leading `!` first so double-negation
                // does not flip the meaning.
                let pat = format!("!{}", g.trim_start_matches('!'));
                b.add(&pat)
                    .map_err(|e| ChanReportError::Walk(e.to_string()))?;
            }
            Some(
                b.build()
                    .map_err(|e| ChanReportError::Walk(e.to_string()))?,
            )
        };

        let gitignore = if opts.respect_gitignore {
            let p = opts.root.join(".gitignore");
            if p.exists() {
                let (gi, _maybe_err) = Gitignore::new(&p);
                // `Gitignore::new` may return parse warnings via the
                // second tuple element; we drop them. A malformed
                // .gitignore should not block the scan.
                Some(gi)
            } else {
                None
            }
        } else {
            None
        };

        Ok(Self {
            include_hidden: opts.include_hidden,
            overrides,
            gitignore,
            path_policy: None,
        })
    }

    /// Returns true when `rel` (POSIX, workspace-relative, no leading
    /// slash) should be tracked. Ancestors are checked as
    /// directories so gitignore rules like `target/` reject the
    /// whole subtree the way the walker would during descent.
    pub(crate) fn accepts(&self, rel: &str) -> bool {
        if let Some(path_policy) = &self.path_policy {
            return path_policy.includes(rel, false);
        }
        if !self.include_hidden {
            for part in rel.split('/') {
                if part.starts_with('.') {
                    return false;
                }
            }
        }
        let parts: Vec<&str> = rel.split('/').collect();
        for i in 0..parts.len() {
            let sub = parts[..=i].join("/");
            let is_dir = i + 1 < parts.len();
            if let Some(ov) = &self.overrides {
                if ov.matched(&sub, is_dir).is_ignore() {
                    return false;
                }
            }
            if let Some(gi) = &self.gitignore {
                if gi.matched(&sub, is_dir).is_ignore() {
                    return false;
                }
            }
        }
        true
    }

    pub(crate) fn generation(&self) -> Option<u64> {
        self.path_policy.as_ref().map(|policy| policy.generation())
    }
}

pub(crate) struct WalkResult {
    pub(crate) paths: Vec<String>,
    pub(crate) skipped: usize,
}

/// Walk the configured root and return accepted relative POSIX paths.
/// Nested ignore files apply during the walk but not in the cached filter.
pub(crate) fn walk_root(opts: &ReportOptions) -> Result<WalkResult, ChanReportError> {
    let mut builder = WalkBuilder::new(&opts.root);
    if let Some(path_policy) = &opts.path_policy {
        let root = opts.root.clone();
        let path_policy = Arc::clone(path_policy);
        builder
            .follow_links(false)
            .same_file_system(true)
            .hidden(false)
            .git_ignore(false)
            .git_global(false)
            .git_exclude(false)
            .ignore(false)
            .parents(false)
            .filter_entry(move |entry| {
                if entry.depth() == 0 {
                    return true;
                }
                let Ok(rel) = entry.path().strip_prefix(&root) else {
                    return false;
                };
                let rel = rel.to_string_lossy().replace('\\', "/");
                let is_dir = entry
                    .file_type()
                    .is_some_and(|file_type| file_type.is_dir());
                path_policy.includes(&rel, is_dir)
            });
    } else {
        builder
            .follow_links(opts.follow_symlinks)
            .hidden(!opts.include_hidden)
            .git_ignore(opts.respect_gitignore)
            .git_global(opts.respect_gitignore)
            .git_exclude(opts.respect_gitignore)
            .ignore(opts.respect_gitignore)
            .parents(opts.respect_gitignore);
    }
    if opts.path_policy.is_none() && opts.respect_gitignore {
        // The ignore crate only honors .gitignore files inside a
        // git repo (i.e. when a `.git/` directory is present).
        // chan-report's workspaces are not always git repos, so treat
        // any .gitignore we find as a regular ignore file too.
        // This is read in addition to (not instead of) git_ignore,
        // so nested .gitignore files inside a real repo continue
        // to work the way users expect.
        builder.add_custom_ignore_filename(".gitignore");
    }

    if opts.path_policy.is_none() && !opts.exclude_globs.is_empty() {
        let mut ob = OverrideBuilder::new(&opts.root);
        for g in &opts.exclude_globs {
            let pat = format!("!{}", g.trim_start_matches('!'));
            ob.add(&pat)
                .map_err(|e| ChanReportError::Walk(e.to_string()))?;
        }
        builder.overrides(
            ob.build()
                .map_err(|e| ChanReportError::Walk(e.to_string()))?,
        );
    }

    collect_entries(
        &opts.root,
        builder.build().map(|entry| {
            entry.map(|entry| {
                (
                    entry.file_type().is_some_and(|t| t.is_file()),
                    entry.into_path(),
                )
            })
        }),
    )
}

fn collect_entries(
    root: &Path,
    entries: impl IntoIterator<Item = Result<(bool, PathBuf), ignore::Error>>,
) -> Result<WalkResult, ChanReportError> {
    let mut out = Vec::new();
    let mut skipped = 0;
    for entry in entries {
        let (is_file, abs) = match entry {
            Ok(entry) => entry,
            Err(error) if is_root_error(&error, root) => {
                return Err(ChanReportError::Walk(error.to_string()));
            }
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        if !is_file {
            continue;
        }
        let Some(rel) = abs.strip_prefix(root).ok().and_then(|rel| rel.to_str()) else {
            skipped += 1;
            continue;
        };
        out.push(rel.replace('\\', "/"));
    }
    Ok(WalkResult {
        paths: out,
        skipped,
    })
}

fn is_root_error(error: &ignore::Error, root: &Path) -> bool {
    fn check(error: &ignore::Error, root: &Path, has_path: bool) -> bool {
        match error {
            ignore::Error::WithPath { path, err } => path == root || check(err, root, true),
            ignore::Error::WithDepth { depth, err } => *depth == 0 || check(err, root, has_path),
            ignore::Error::WithLineNumber { err, .. } => check(err, root, has_path),
            ignore::Error::Partial(errors) => {
                errors.iter().any(|error| check(error, root, has_path))
            }
            // A mid-listing root read error can lose its path in walkdir.
            // Without path context it cannot safely be treated as a child.
            ignore::Error::Io(_) => !has_path,
            _ => false,
        }
    }
    check(error, root, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pathless_io_error_is_fatal() {
        let root = Path::new("workspace");
        let result = collect_entries(
            root,
            [
                Ok((true, root.join("a.rs"))),
                Err(ignore::Error::Io(std::io::Error::other(
                    "root listing failed",
                ))),
            ],
        );
        assert!(
            matches!(result, Err(ChanReportError::Walk(_))),
            "a pathless listing error cannot certify a complete root scan"
        );
    }

    fn denied(path: PathBuf) -> ignore::Error {
        ignore::Error::WithPath {
            path,
            err: Box::new(ignore::Error::Io(
                std::io::ErrorKind::PermissionDenied.into(),
            )),
        }
    }

    #[test]
    fn a_failed_entry_or_non_utf8_name_does_not_abort_the_walk() {
        let root = Path::new("workspace");
        let mut entries = vec![
            Ok((true, root.join("a.rs"))),
            Err(denied(root.join("locked"))),
        ];
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            entries.push(Ok((
                true,
                root.join(std::ffi::OsStr::from_bytes(b"bad\xff.rs")),
            )));
        }
        entries.extend([
            Ok((false, root.join("src"))),
            Ok((true, root.join("src/b.rs"))),
        ]);
        let result =
            collect_entries(root, entries).expect("bad entries must not abort sibling traversal");
        assert_eq!(result.paths, ["a.rs", "src/b.rs"]);
        assert_eq!(result.skipped, if cfg!(unix) { 2 } else { 1 });
    }

    #[test]
    fn an_unreadable_root_still_fails_the_walk() {
        let root = Path::new("workspace");
        assert!(matches!(
            collect_entries(root, [Err(denied(root.to_path_buf()))]),
            Err(ChanReportError::Walk(_))
        ));
    }

    #[test]
    fn an_entry_outside_the_root_is_skipped() {
        let root = Path::new("workspace");
        let result = collect_entries(
            root,
            [
                Ok((true, PathBuf::from("outside.rs"))),
                Ok((true, root.join("a.rs"))),
            ],
        )
        .unwrap();
        assert_eq!(result.paths, ["a.rs"]);
        assert_eq!(result.skipped, 1);
    }
}
