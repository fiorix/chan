//! chan-report public surface.
//!
//! Walks a directory, counts SLOC per file by language, computes
//! per-language roll-ups and a COCOMO summary, and maintains the
//! state incrementally so a single file change does not require a
//! full rescan. The crate is I/O-free for state: callers
//! (chan-workspace) own persistence and call write_jsonl / load_jsonl
//! when they decide to materialize a snapshot to disk.

#![forbid(unsafe_code)]

mod cocomo;
mod complexity;
mod count;
mod error;
mod jsonl;
mod summary;
mod walk;

pub use cocomo::{CocomoModel, CocomoParams, CocomoSummary};
pub use error::ChanReportError;
pub use jsonl::report_to_jsonl_string;
pub use summary::{
    FileBucket, FileStats, LanguageStats, Report, ReportMeta, Totals, SCHEMA_VERSION,
};

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;

use crate::walk::Filter;

/// Workspace-owned scope adapter used by both full and incremental reports.
pub trait ReportPathPolicy: Send + Sync {
    fn generation(&self) -> u64;
    fn includes(&self, rel: &str, is_dir: bool) -> bool;
}

/// Inputs to the initial walk and to the filter applied by
/// incremental updates.
#[derive(Clone)]
pub struct ReportOptions {
    pub root: PathBuf,
    pub follow_symlinks: bool,
    pub include_hidden: bool,
    pub respect_gitignore: bool,
    pub exclude_globs: Vec<String>,
    pub path_policy: Option<Arc<dyn ReportPathPolicy>>,
    pub cocomo: CocomoParams,
}

impl std::fmt::Debug for ReportOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReportOptions")
            .field("root", &self.root)
            .field("follow_symlinks", &self.follow_symlinks)
            .field("include_hidden", &self.include_hidden)
            .field("respect_gitignore", &self.respect_gitignore)
            .field("exclude_globs", &self.exclude_globs)
            .field(
                "path_policy_generation",
                &self.path_policy.as_ref().map(|policy| policy.generation()),
            )
            .field("cocomo", &self.cocomo)
            .finish()
    }
}

impl ReportOptions {
    /// Construct with defaults: don't follow symlinks, skip
    /// hidden files, respect `.gitignore`, no extra exclude
    /// globs, organic-COCOMO cost model.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            follow_symlinks: false,
            include_hidden: false,
            respect_gitignore: true,
            exclude_globs: Vec::new(),
            path_policy: None,
            cocomo: CocomoParams::default(),
        }
    }
}

/// What subset of the index a snapshot should roll up.
#[derive(Debug, Clone)]
pub enum Scope {
    /// Whole indexed root.
    All,
    /// Workspace-relative POSIX prefix; matches the directory and
    /// everything under it. Empty string is equivalent to `All`.
    Prefix(String),
    /// Exact relative paths. Missing entries are silently ignored.
    Files(Vec<String>),
}

/// Result of an incremental mutation, used by the consumer to
/// decide whether the persisted JSONL needs rewriting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateOutcome {
    Inserted,
    Updated,
    Unchanged,
    Removed,
    Skipped,
}

/// In-memory per-file state plus the cached accept-filter. Single
/// owner per workspace; chan-workspace wraps this in its own lock.
///
/// `dirs` is a maintained per-directory aggregation index: every
/// file's stats contribute to each of its ancestor directories all
/// the way to the workspace root (key `""`). Entries are dropped when
/// the last file under them is removed so the map matches "dirs
/// that currently contain tracked files". Reads are O(1) via
/// `Index::dir_report`; writes pay an O(depth) ancestor walk per
/// `update` / `remove` / `rename`. The on-disk JSONL format never
/// serializes this index; `load_jsonl` rebuilds it from the file
/// rows.
pub struct Index {
    root: PathBuf,
    files: HashMap<String, FileStats>,
    dirs: HashMap<String, DirEntry>,
    filter: Filter,
}

/// Internal per-directory aggregate. Mirrors `Totals` plus a
/// per-language sub-rollup so a directory inspector can render
/// "Rust 60%, Python 30%, TypeScript 10%" alongside totals
/// without scanning the file map.
///
/// The per-language sub-rollup is a `HashMap` keyed by language
/// name (matching `FileStats::language`) for O(1) deltas; the
/// `dir_report` snapshot path converts it into the same sorted
/// `Vec<LanguageStats>` shape the whole-tree roll-up returns.
#[derive(Default)]
struct DirEntry {
    files: u64,
    bytes: u64,
    code: u64,
    comments: u64,
    blanks: u64,
    complexity: u64,
    by_language: HashMap<String, LanguageStats>,
}

impl Index {
    /// Walk `opts.root` and produce an index. Files the walker
    /// or counter rejects (unrecognized extension, binary,
    /// gitignored, hidden, oversize) are silently dropped.
    pub fn scan(opts: &ReportOptions) -> Result<Self, ChanReportError> {
        let rels = walk::walk_root(opts)?;
        let mut files = HashMap::with_capacity(rels.len());
        for rel in rels {
            if let Some(fs) = count::count_file_impl(&opts.root, &rel)? {
                files.insert(rel, fs);
            }
        }
        let mut idx = Self {
            root: opts.root.clone(),
            filter: Filter::build(opts)?,
            files,
            dirs: HashMap::new(),
        };
        idx.rebuild_dirs();
        Ok(idx)
    }

    /// Re-count `rel` from disk and reconcile against the index.
    /// `rel` is workspace-relative POSIX. Returns:
    ///
    ///   - `Inserted` when the file is new and the filter accepts it.
    ///   - `Updated` when stats changed.
    ///   - `Unchanged` when stats are byte-identical.
    ///   - `Removed` when the file vanished or the filter no
    ///     longer accepts it (and we held a row for it).
    ///   - `Skipped` when the filter rejected the path and we did
    ///     not hold a row for it.
    pub fn update(&mut self, rel: &str) -> Result<UpdateOutcome, ChanReportError> {
        if !self.filter.accepts(rel) {
            return Ok(if self.remove_file_row(rel).is_some() {
                UpdateOutcome::Removed
            } else {
                UpdateOutcome::Skipped
            });
        }
        match count::count_file_impl(&self.root, rel)? {
            Some(new_stats) => match self.files.get(rel).cloned() {
                Some(old) if old == new_stats => Ok(UpdateOutcome::Unchanged),
                Some(old) => {
                    self.remove_file_from_dirs(rel, &old);
                    self.apply_file_to_dirs(rel, &new_stats);
                    self.files.insert(rel.to_string(), new_stats);
                    Ok(UpdateOutcome::Updated)
                }
                None => {
                    self.apply_file_to_dirs(rel, &new_stats);
                    self.files.insert(rel.to_string(), new_stats);
                    Ok(UpdateOutcome::Inserted)
                }
            },
            None => Ok(if self.remove_file_row(rel).is_some() {
                UpdateOutcome::Removed
            } else {
                UpdateOutcome::Skipped
            }),
        }
    }

    /// Drop a row unconditionally. `Removed` when a row existed,
    /// `Unchanged` otherwise. Does not touch disk.
    pub fn remove(&mut self, rel: &str) -> UpdateOutcome {
        if self.remove_file_row(rel).is_some() {
            UpdateOutcome::Removed
        } else {
            UpdateOutcome::Unchanged
        }
    }

    /// Treat a filesystem rename as `remove(from)` plus
    /// `update(to)`. Returns the outcome of the update half;
    /// callers infer "something happened" from this being
    /// non-`Unchanged` or from a prior row existing at `from`.
    pub fn rename(&mut self, from: &str, to: &str) -> Result<UpdateOutcome, ChanReportError> {
        let removed = self.remove_file_row(from).is_some();
        let out = self.update(to)?;
        // If we removed something at `from` but the destination
        // ended up `Unchanged` / `Skipped`, force at least
        // `Removed` so the writer flushes.
        if removed && matches!(out, UpdateOutcome::Unchanged | UpdateOutcome::Skipped) {
            return Ok(UpdateOutcome::Removed);
        }
        Ok(out)
    }

    /// Borrow the row for a specific file, if tracked.
    pub fn file(&self, rel: &str) -> Option<&FileStats> {
        self.files.get(rel)
    }

    /// Number of tracked files.
    pub fn len(&self) -> usize {
        self.files.len()
    }

    /// True when no files are tracked.
    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    /// Build a `Report` covering the requested scope. Pure
    /// projection; does not mutate state.
    pub fn snapshot(&self, scope: &Scope, cocomo_params: &CocomoParams) -> Report {
        let files: Vec<FileStats> = match scope {
            Scope::All => self.files.values().cloned().collect(),
            Scope::Prefix(p) if p.is_empty() => self.files.values().cloned().collect(),
            Scope::Prefix(p) => {
                let needle = if p.ends_with('/') {
                    p.clone()
                } else {
                    format!("{}/", p)
                };
                self.files
                    .iter()
                    .filter(|(k, _)| *k == p || k.starts_with(&needle))
                    .map(|(_, v)| v.clone())
                    .collect()
            }
            Scope::Files(list) => list
                .iter()
                .filter_map(|p| self.files.get(p).cloned())
                .collect(),
        };

        let (by_language, totals) = roll_up(&files);
        let cocomo = cocomo::compute(totals.code, cocomo_params);

        let mut files_sorted = files;
        files_sorted.sort_by(|a, b| a.path.cmp(&b.path));

        Report {
            meta: ReportMeta {
                root: self.root.display().to_string(),
                generated_at: Utc::now().to_rfc3339(),
                schema: summary::SCHEMA_VERSION,
            },
            totals,
            by_language,
            files: files_sorted,
            cocomo,
        }
    }

    /// Serialize a scoped snapshot as JSONL to `w`. Consumers
    /// pair this with their own atomic-write helper to persist
    /// to disk.
    pub fn write_jsonl<W: Write>(
        &self,
        w: W,
        scope: &Scope,
        cocomo_params: &CocomoParams,
    ) -> Result<(), ChanReportError> {
        let report = self.snapshot(scope, cocomo_params);
        jsonl::write_report(
            w,
            &report.meta,
            &report.files,
            &report.by_language,
            &report.totals,
            &report.cocomo,
        )
    }

    /// Reconstruct an `Index` from a previously written JSONL
    /// stream. `opts` provides the live filter; the schema field
    /// in the loaded `meta` record must match the current build.
    pub fn load_jsonl<R: BufRead>(r: R, opts: &ReportOptions) -> Result<Self, ChanReportError> {
        let (meta, files) = jsonl::read_file_rows(r)?;
        if meta.schema != summary::SCHEMA_VERSION {
            return Err(ChanReportError::SchemaMismatch {
                expected: summary::SCHEMA_VERSION,
                found: meta.schema,
            });
        }
        let filter = Filter::build(opts)?;
        let mut map = HashMap::with_capacity(files.len());
        for f in files {
            if filter.accepts(&f.path) {
                map.insert(f.path.clone(), f);
            }
        }
        let mut idx = Self {
            root: opts.root.clone(),
            filter,
            files: map,
            dirs: HashMap::new(),
        };
        idx.rebuild_dirs();
        Ok(idx)
    }

    /// Policy generation captured by this report index, when workspace-owned.
    pub fn path_policy_generation(&self) -> Option<u64> {
        self.filter.generation()
    }

    /// Read-side O(1) lookup of the maintained per-directory
    /// aggregation. `dir` is a workspace-relative POSIX directory path
    /// with no leading slash; trailing slashes are stripped. The
    /// empty string maps to the workspace root (every tracked file
    /// contributes to it).
    ///
    /// Returns `None` when no tracked file lives at or under the
    /// requested directory. The returned `Report` carries the
    /// directory's `totals`, `by_language` (sorted descending by
    /// bytes / files / name, identical to the whole-tree
    /// roll-up's order), and a `cocomo` computed from the
    /// directory's `code` total. `files` is left empty: dir
    /// queries do not enumerate per-file rows because directory
    /// inspectors only render the summary.
    pub fn dir_report(&self, dir: &str, params: &CocomoParams) -> Option<Report> {
        let key = normalize_dir(dir);
        let entry = self.dirs.get(&key)?;
        let totals = Totals {
            files: entry.files,
            bytes: entry.bytes,
            code: entry.code,
            comments: entry.comments,
            blanks: entry.blanks,
            complexity: entry.complexity,
        };
        let mut by_language: Vec<LanguageStats> = entry.by_language.values().cloned().collect();
        sort_by_language(&mut by_language);
        let cocomo = cocomo::compute(totals.code, params);
        Some(Report {
            meta: ReportMeta {
                root: self.root.display().to_string(),
                generated_at: Utc::now().to_rfc3339(),
                schema: summary::SCHEMA_VERSION,
            },
            totals,
            by_language,
            files: Vec::new(),
            cocomo,
        })
    }

    // ---- internal helpers for the per-directory aggregation cache ----

    /// Remove a file row AND subtract its stats from every
    /// ancestor directory in the cache. Returns the row that was
    /// removed (if any) so callers can detect the no-op case.
    fn remove_file_row(&mut self, rel: &str) -> Option<FileStats> {
        let stats = self.files.remove(rel)?;
        self.remove_file_from_dirs(rel, &stats);
        Some(stats)
    }

    /// Add `stats` to every ancestor directory of `rel`,
    /// including the workspace root (key `""`). Per-language
    /// sub-rollup is created on first touch.
    fn apply_file_to_dirs(&mut self, rel: &str, stats: &FileStats) {
        for anc in ancestor_dirs(rel) {
            let entry = self.dirs.entry(anc).or_default();
            entry.files += 1;
            entry.bytes += stats.bytes;
            entry.code += stats.code;
            entry.comments += stats.comments;
            entry.blanks += stats.blanks;
            entry.complexity += stats.complexity;
            let lang = entry
                .by_language
                .entry(stats.language.clone())
                .or_insert_with(|| LanguageStats {
                    name: stats.language.clone(),
                    ..Default::default()
                });
            lang.files += 1;
            lang.bytes += stats.bytes;
            lang.code += stats.code;
            lang.comments += stats.comments;
            lang.blanks += stats.blanks;
            lang.complexity += stats.complexity;
        }
    }

    /// Subtract `stats` from every ancestor directory of `rel`.
    /// Empty per-language entries get removed; empty directory
    /// entries (last file gone) get dropped from the map so the
    /// cache matches "dirs with tracked files".
    ///
    /// `saturating_sub` everywhere defends against the impossible
    /// case where we underflow (would indicate a bookkeeping
    /// bug). The cache is internal state; we refuse to panic on
    /// drift, the next full rescan corrects it.
    fn remove_file_from_dirs(&mut self, rel: &str, stats: &FileStats) {
        for anc in ancestor_dirs(rel) {
            let drop_entry = {
                let Some(entry) = self.dirs.get_mut(&anc) else {
                    continue;
                };
                entry.files = entry.files.saturating_sub(1);
                entry.bytes = entry.bytes.saturating_sub(stats.bytes);
                entry.code = entry.code.saturating_sub(stats.code);
                entry.comments = entry.comments.saturating_sub(stats.comments);
                entry.blanks = entry.blanks.saturating_sub(stats.blanks);
                entry.complexity = entry.complexity.saturating_sub(stats.complexity);
                let drop_lang = if let Some(lang) = entry.by_language.get_mut(&stats.language) {
                    lang.files = lang.files.saturating_sub(1);
                    lang.bytes = lang.bytes.saturating_sub(stats.bytes);
                    lang.code = lang.code.saturating_sub(stats.code);
                    lang.comments = lang.comments.saturating_sub(stats.comments);
                    lang.blanks = lang.blanks.saturating_sub(stats.blanks);
                    lang.complexity = lang.complexity.saturating_sub(stats.complexity);
                    lang.files == 0
                } else {
                    false
                };
                if drop_lang {
                    entry.by_language.remove(&stats.language);
                }
                entry.files == 0
            };
            if drop_entry {
                self.dirs.remove(&anc);
            }
        }
    }

    /// Rebuild the dirs cache from the file map. Used by `scan`
    /// and `load_jsonl` to seed the cache after the file rows are
    /// in place. Costs one full pass over `files`; that's the
    /// price for not persisting the cache to disk.
    fn rebuild_dirs(&mut self) {
        self.dirs.clear();
        let rows: Vec<(String, FileStats)> = self
            .files
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (rel, stats) in rows {
            self.apply_file_to_dirs(&rel, &stats);
        }
    }
}

/// Yield every ancestor directory of a workspace-relative POSIX path,
/// from the workspace root (`""`) down to the immediate parent. The
/// file's own path is NOT included; aggregation is about what
/// directories *contain* the file.
///
/// Examples:
///   - `"a/b/c.rs"` -> `["", "a", "a/b"]`
///   - `"top.rs"`   -> `[""]`
///   - `""`         -> `[]` (defensive: no file lives at the root key)
fn ancestor_dirs(rel: &str) -> Vec<String> {
    if rel.is_empty() {
        return Vec::new();
    }
    let mut out = vec![String::new()];
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.len() <= 1 {
        return out;
    }
    let mut acc = String::new();
    for part in &parts[..parts.len() - 1] {
        if !acc.is_empty() {
            acc.push('/');
        }
        acc.push_str(part);
        out.push(acc.clone());
    }
    out
}

/// Normalize a caller-supplied directory query string into the
/// cache key. Strips trailing slashes; `""` and `"/"` both mean
/// the workspace root. Leading slashes are stripped too so callers
/// can pass either `"src"` or `"/src"`.
fn normalize_dir(dir: &str) -> String {
    dir.trim_matches('/').to_string()
}

/// Shared ordering for the `by_language` array: desc by bytes,
/// then desc by file count, then asc by name. Identical to the
/// global roll-up so dir + global responses sort consistently.
fn sort_by_language(by_language: &mut [LanguageStats]) {
    by_language.sort_by(|a, b| {
        b.bytes
            .cmp(&a.bytes)
            .then_with(|| b.files.cmp(&a.files))
            .then_with(|| a.name.cmp(&b.name))
    });
}

/// One-shot helper for the common "scan once, get a report" flow.
/// Equivalent to `Index::scan(opts)?.snapshot(&Scope::All, &opts.cocomo)`.
pub fn run(opts: &ReportOptions) -> Result<Report, ChanReportError> {
    let idx = Index::scan(opts)?;
    Ok(idx.snapshot(&Scope::All, &opts.cocomo))
}

/// Stateless per-file count. Shared by `Index::scan` (parallel
/// over walked files) and `Index::update` (single file). Returns
/// `None` for files the counter skips: unrecognized extension,
/// binary, excluded by the walker's filter, or vanished.
pub fn count_file(root: &Path, rel: &str) -> Result<Option<FileStats>, ChanReportError> {
    count::count_file_impl(root, rel)
}

fn roll_up(files: &[FileStats]) -> (Vec<LanguageStats>, Totals) {
    let mut by_lang: HashMap<String, LanguageStats> = HashMap::new();
    let mut totals = Totals::default();
    for f in files {
        let entry = by_lang
            .entry(f.language.clone())
            .or_insert_with(|| LanguageStats {
                name: f.language.clone(),
                ..Default::default()
            });
        entry.files += 1;
        entry.bytes += f.bytes;
        entry.code += f.code;
        entry.comments += f.comments;
        entry.blanks += f.blanks;
        entry.complexity += f.complexity;

        totals.files += 1;
        totals.bytes += f.bytes;
        totals.code += f.code;
        totals.comments += f.comments;
        totals.blanks += f.blanks;
        totals.complexity += f.complexity;
    }
    let mut by_language: Vec<LanguageStats> = by_lang.into_values().collect();
    sort_by_language(&mut by_language);
    (by_language, totals)
}
