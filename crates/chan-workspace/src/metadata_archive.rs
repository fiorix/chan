//! Import and export of registered workspace metadata as zstd-compressed tar archives.
//!
//! The first entry is `chan-metadata-v1/manifest.json`; entries under `chan-metadata-v1/payload/` carry the `index`, `graph`, `report`, and `sessions` subtrees. Workspace content and sibling locks, tokens, and trash are excluded. The exporter also skips files and directories named `staging`, `temp`, `tmp`, or `.tmp`, shared-memory files, `.DS_Store`, and the live graph WAL. Only `graph.sqlite` and `index/bm25` are snapshotted; other included metadata is read live during archiving.
//!
//! Import replaces the four metadata subtrees after refusing a live in-process workspace and acquiring its writer lock. Unless `MetadataImportOptions::force_scm` is set, an archive with a Git identity requires a target identity: normalized remote lists must match when either is nonempty; otherwise differing known HEADs are refused. An archive without a Git identity imposes no SCM check.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read};
use std::path::{Component, Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tar::{Archive, Builder, EntryType, Header};
use thiserror::Error;

use crate::error::{ChanError, Result};
use crate::index::config;
use crate::library::Library;
use crate::lock::WorkspaceLock;
use crate::paths::WorkspacePaths;
use crate::registry::KnownWorkspace;

const MANIFEST_PATH: &str = "chan-metadata-v1/manifest.json";
const PAYLOAD_ROOT: &str = "chan-metadata-v1/payload";
const ARCHIVE_FORMAT_VERSION: u32 = 1;
const PATH_KEY_SCHEME: &str = "canonical-absolute-path-slug-sha256-8hex";
const INCLUDED_SUBTREES: &[&str] = &["index", "graph", "report", "sessions"];
const EXCLUDED_SUBTREES: &[&str] = &[
    "locks",
    "tokens",
    "trash",
    "staging",
    "temp",
    "*.shm",
    "graph.sqlite-wal",
];

/// Producer information recorded in a metadata archive.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MetadataExportOptions {
    /// Version of chan producing the archive, supplied by the caller.
    pub chan_version: String,
}

/// The exported archive, its manifest, and uncompressed entry counts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MetadataExportReport {
    /// Output path supplied to the export.
    pub archive_path: PathBuf,
    /// Manifest written as the first archive entry.
    pub manifest: MetadataManifest,
    /// Archive entry count, including directories and the manifest.
    pub files: usize,
    /// Uncompressed regular-file bytes, including the manifest.
    pub bytes: u64,
}

/// Controls for SCM identity checks and post-import reindexing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MetadataImportOptions {
    /// Reopen the workspace and run a synchronous reindex after replacing metadata.
    pub rescan: bool,
    /// Bypass the source-versus-target Git identity guard.
    pub force_scm: bool,
}

/// The imported manifest, replaced metadata subtrees, and extraction counts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MetadataImportReport {
    /// Manifest read from the archive.
    pub manifest: MetadataManifest,
    /// Metadata subtrees replaced: `index`, `graph`, `report`, and `sessions`.
    pub imported_subtrees: Vec<String>,
    /// Extracted payload entry count, including directories but excluding the payload root and manifest.
    pub files: usize,
    /// Uncompressed regular-file bytes extracted from the payload.
    pub bytes: u64,
    /// Whether the requested post-import reindex completed.
    pub rescanned: bool,
}

/// The JSON manifest stored as the first entry of a metadata archive.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MetadataManifest {
    /// Archive layout version; imports accept version 1.
    pub archive_format_version: u32,
    /// Caller-supplied version of the exporting chan process.
    pub chan_version: String,
    /// Export timestamp in RFC 3339 UTC, with whole-second precision.
    pub created_at: String,
    /// Registered source workspace root, rendered as a platform path.
    pub source_root: String,
    /// Source registry key for the workspace metadata directory.
    pub source_metadata_key: String,
    /// Format identifiers recorded by the exporter. Only the graph version is read from source metadata; index and report versions are compiled-in constants.
    pub metadata_schema: MetadataSchema,
    /// Detected Git identity, omitted when neither a remote nor a HEAD is available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scm: Option<ScmIdentity>,
    /// Metadata subtree names declared by the exporter.
    pub included_subtrees: Vec<String>,
    /// Excluded metadata categories and filename patterns declared by the exporter.
    pub excluded_subtrees: Vec<String>,
}

/// Metadata format identifiers recorded by the exporting process.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MetadataSchema {
    /// Identifier of the canonical-path-based metadata key scheme.
    pub path_key_scheme: String,
    /// Search index schema version compiled into the exporter.
    pub index_schema_version: u32,
    /// SQLite `user_version`, omitted if the graph database cannot be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_user_version: Option<u32>,
    /// Optional vector shard format identifier; the exporter leaves it unset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_shard_format_version: Option<u32>,
    /// Code-report schema version compiled into the exporter.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_schema_version: Option<u32>,
}

/// Git repository identity used to guard metadata imports.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScmIdentity {
    /// Sorted, deduplicated Git remotes with common GitHub URL forms unified and trailing slashes and `.git` removed.
    pub remotes: Vec<String>,
    /// Resolved Git HEAD when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
}

/// Tar entry classification for archive path validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveEntryKind {
    /// A regular file, allowed by the path validator.
    Regular,
    /// A directory, allowed by the path validator.
    Directory,
    /// A symbolic link, refused for extraction.
    Symlink,
    /// A hard link, refused for extraction.
    Hardlink,
    /// Any other tar entry type, refused for extraction.
    Special,
}

/// A path or entry kind that cannot be safely extracted.
#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum MetadataArchivePathError {
    /// No normal path component remains after ignoring current-directory components.
    #[error("archive path is empty")]
    Empty,
    /// The path has a root component.
    #[error("archive path must be relative: {0}")]
    Absolute(String),
    /// The path contains a parent-directory component.
    #[error("archive path must not contain parent components: {0}")]
    Parent(String),
    /// The path has a platform prefix or a Windows drive-root or UNC spelling.
    #[error("archive path must not contain a Windows prefix: {0}")]
    Prefix(String),
    /// The entry is neither a regular file nor a directory.
    #[error("archive entry type is not safe to extract: {0:?}")]
    UnsafeKind(ArchiveEntryKind),
}

impl Library {
    /// Export metadata for registered `root`.
    ///
    /// `output` must end in `.tar.zst` and must not already exist. The archive is written to a sibling temporary file and renamed to the requested output on success.
    pub fn export_metadata_archive(
        &self,
        root: &Path,
        output: &Path,
        opts: MetadataExportOptions,
    ) -> Result<MetadataExportReport> {
        export_metadata_archive(self, root, output, opts)
    }

    /// Read only the first manifest entry without extracting or validating the payload.
    ///
    /// The first tar entry must be `chan-metadata-v1/manifest.json`; archive-format compatibility is checked by import, not inspection.
    pub fn inspect_metadata_archive(&self, archive: &Path) -> Result<MetadataManifest> {
        inspect_metadata_archive(archive)
    }

    /// Replace metadata for registered `root` from an archive.
    ///
    /// Refuse unsupported archive formats, SCM identity mismatches unless `force_scm`, live in-process workspaces, and held writer locks. After replacement the writer lock is released; `rescan` reopens the workspace and synchronously reindexes its content.
    pub fn import_metadata_archive(
        &self,
        root: &Path,
        archive: &Path,
        opts: MetadataImportOptions,
    ) -> Result<MetadataImportReport> {
        import_metadata_archive(self, root, archive, opts)
    }
}

/// Check that an entry is a regular file or directory with a nonempty relative path.
///
/// Reject symbolic links, hard links, special entries, absolute paths, platform prefixes, Windows drive-root or UNC spellings, and parent-directory components. Current-directory components are ignored. This is a lexical check; it does not perform I/O or enforce the archive payload prefix.
pub fn validate_archive_entry_path(
    path: &Path,
    kind: ArchiveEntryKind,
) -> std::result::Result<(), MetadataArchivePathError> {
    match kind {
        ArchiveEntryKind::Regular | ArchiveEntryKind::Directory => {}
        ArchiveEntryKind::Symlink | ArchiveEntryKind::Hardlink | ArchiveEntryKind::Special => {
            return Err(MetadataArchivePathError::UnsafeKind(kind));
        }
    }

    let display = path.display().to_string();
    if looks_like_windows_prefix(&display) {
        return Err(MetadataArchivePathError::Prefix(display));
    }

    let mut saw_component = false;
    for component in path.components() {
        match component {
            Component::Prefix(_) => {
                return Err(MetadataArchivePathError::Prefix(path.display().to_string()));
            }
            Component::RootDir => {
                return Err(MetadataArchivePathError::Absolute(
                    path.display().to_string(),
                ));
            }
            Component::ParentDir => {
                return Err(MetadataArchivePathError::Parent(path.display().to_string()));
            }
            Component::CurDir => {}
            Component::Normal(_) => saw_component = true,
        }
    }
    if saw_component {
        Ok(())
    } else {
        Err(MetadataArchivePathError::Empty)
    }
}

fn looks_like_windows_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    if path.starts_with("\\\\") || path.starts_with("//") {
        return true;
    }
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
}

fn export_metadata_archive(
    lib: &Library,
    root: &Path,
    output: &Path,
    opts: MetadataExportOptions,
) -> Result<MetadataExportReport> {
    if !has_tar_zst_extension(output) {
        return Err(ChanError::Io(format!(
            "metadata archive output must end in .tar.zst: {}",
            output.display()
        )));
    }
    if output.exists() {
        return Err(ChanError::Io(format!(
            "metadata archive output already exists: {}",
            output.display()
        )));
    }

    let (entry, workspace_paths) = registered_workspace(lib, root)?;
    let manifest = build_manifest(&entry, &workspace_paths, opts)?;
    let tmp = temp_sibling(output);
    if tmp.exists() {
        return Err(ChanError::Io(format!(
            "metadata archive temp path already exists: {}",
            tmp.display()
        )));
    }

    let result = write_archive(&workspace_paths, &manifest, &tmp).and_then(|(files, bytes)| {
        std::fs::rename(&tmp, output)?;
        Ok(MetadataExportReport {
            archive_path: output.to_path_buf(),
            manifest,
            files,
            bytes,
        })
    });

    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn inspect_metadata_archive(archive: &Path) -> Result<MetadataManifest> {
    let file = File::open(archive)?;
    let decoder = zstd::stream::read::Decoder::new(BufReader::new(file)).map_err(|e| {
        ChanError::io_with_context(e, format!("open zstd archive {}", archive.display()))
    })?;
    let mut archive = Archive::new(decoder);
    let mut entries = archive.entries()?;
    let Some(first) = entries.next() else {
        return Err(ChanError::Io("metadata archive is empty".into()));
    };
    let mut first = first?;
    let path = first.path()?.into_owned();
    if path != Path::new(MANIFEST_PATH) {
        return Err(ChanError::Io(format!(
            "metadata archive manifest must be first at {MANIFEST_PATH}, got {}",
            path.display()
        )));
    }
    let kind = archive_entry_kind(first.header().entry_type());
    validate_archive_entry_path(&path, kind)
        .map_err(|e| ChanError::Io(format!("unsafe metadata archive manifest path: {e}")))?;
    let mut raw = String::new();
    first.read_to_string(&mut raw)?;
    serde_json::from_str(&raw)
        .map_err(|e| ChanError::Io(format!("decode metadata archive manifest: {e}")))
}

fn import_metadata_archive(
    lib: &Library,
    root: &Path,
    archive: &Path,
    opts: MetadataImportOptions,
) -> Result<MetadataImportReport> {
    let manifest = inspect_metadata_archive(archive)?;
    if manifest.archive_format_version != ARCHIVE_FORMAT_VERSION {
        return Err(ChanError::Io(format!(
            "unsupported metadata archive format version: {}",
            manifest.archive_format_version
        )));
    }

    let (entry, workspace_paths) = registered_workspace(lib, root)?;
    if !opts.force_scm {
        guard_scm_identity(&manifest, detect_scm_identity(&entry.root_path).as_ref())?;
    }

    // The import replaces `index/`, `graph/`, `sessions/` and `report/`
    // wholesale, the same directories `Library::reset_workspace_with` wipes,
    // so it takes the same exclusion in the same order: the in-process check
    // first, which names an undropped `Arc<Workspace>` in this process as
    // `WorkspaceAlreadyOpen`, then the writer flock, which refuses a foreign
    // holder as `WorkspaceLocked`. Without it a running devserver keeps
    // reading and writing directories that have been unlinked under it, and
    // the index and graph it leaves behind describe two different
    // generations.
    lib.refuse_if_live(root)?;
    let lock = WorkspaceLock::acquire(&workspace_paths.lock, root)?;

    let staging = workspace_paths
        .root
        .join("staging")
        .join(format!("metadata-import-{}", std::process::id()));
    if staging.exists() {
        return Err(ChanError::Io(format!(
            "metadata import staging path already exists: {}",
            staging.display()
        )));
    }
    let payload = staging.join("payload");
    std::fs::create_dir_all(&payload)?;
    let result = extract_payload(archive, &payload).and_then(|(files, bytes)| {
        for subtree in INCLUDED_SUBTREES {
            replace_subtree(&workspace_paths, &payload, subtree)?;
        }
        Ok((files, bytes))
    });
    let _ = std::fs::remove_dir_all(&staging);
    // Everything destructive is done. The rescan reopens the workspace,
    // which takes this very lock, so release it first.
    drop(lock);
    let (files, bytes) = result?;
    if opts.rescan {
        let workspace = lib.open_workspace(root)?;
        workspace.reindex(None)?;
    }
    Ok(MetadataImportReport {
        manifest,
        imported_subtrees: INCLUDED_SUBTREES.iter().map(|s| (*s).to_string()).collect(),
        files,
        bytes,
        rescanned: opts.rescan,
    })
}

fn registered_workspace(lib: &Library, root: &Path) -> Result<(KnownWorkspace, WorkspacePaths)> {
    let paths = lib
        .workspace_paths_for(root)
        .ok_or_else(|| ChanError::WorkspaceNotRegistered(root.to_path_buf()))?;
    let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let entry = lib
        .list_workspaces()
        .into_iter()
        .find(|d| d.root_path == canonical || d.root_path == root)
        .ok_or_else(|| ChanError::WorkspaceNotRegistered(root.to_path_buf()))?;
    Ok((entry, paths))
}

fn build_manifest(
    entry: &KnownWorkspace,
    workspace_paths: &WorkspacePaths,
    opts: MetadataExportOptions,
) -> Result<MetadataManifest> {
    Ok(MetadataManifest {
        archive_format_version: ARCHIVE_FORMAT_VERSION,
        chan_version: opts.chan_version,
        created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        source_root: entry.root_path.display().to_string(),
        source_metadata_key: entry.metadata_key.clone(),
        metadata_schema: MetadataSchema {
            path_key_scheme: PATH_KEY_SCHEME.to_string(),
            index_schema_version: config::SCHEMA_VERSION,
            graph_user_version: graph_user_version(&workspace_paths.graph_db)?,
            vector_shard_format_version: None,
            report_schema_version: Some(chan_report::SCHEMA_VERSION),
        },
        scm: detect_scm_identity(&entry.root_path),
        included_subtrees: INCLUDED_SUBTREES.iter().map(|s| (*s).to_string()).collect(),
        excluded_subtrees: EXCLUDED_SUBTREES.iter().map(|s| (*s).to_string()).collect(),
    })
}

fn graph_user_version(graph_db: &Path) -> Result<Option<u32>> {
    if !graph_db.exists() {
        return Ok(None);
    }
    let Ok(conn) =
        rusqlite::Connection::open_with_flags(graph_db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return Ok(None);
    };
    Ok(conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .ok())
}

fn write_archive(
    workspace_paths: &WorkspacePaths,
    manifest: &MetadataManifest,
    tmp: &Path,
) -> Result<(usize, u64)> {
    let staging_root = workspace_paths.root.join("staging");
    std::fs::create_dir_all(&staging_root)?;
    let staging = tempfile::Builder::new()
        .prefix("metadata-export-")
        .tempdir_in(staging_root)?;
    let mut snapshots = BTreeMap::new();
    let graph = staging.path().join("graph.sqlite");
    if snapshot_source_exists(&workspace_paths.graph_db, false)? {
        snapshot_graph(&workspace_paths.graph_db, &graph)?;
    }
    // Retain substitutions for absent stores too: a store appearing during
    // the walk must fail the export rather than fall back to a live copy.
    snapshots.insert(workspace_paths.graph_db.clone(), graph);
    let bm25 = workspace_paths.index.join("bm25");
    let index = staging.path().join("bm25");
    if snapshot_source_exists(&bm25, true)? {
        snapshot_bm25(&bm25, &index)?;
    }
    snapshots.insert(bm25, index);
    let graph_wal = workspace_paths.graph_dir.join("graph.sqlite-wal");
    let file = File::create(tmp)?;
    let encoder = zstd::stream::write::Encoder::new(BufWriter::new(file), 0)
        .map_err(|e| ChanError::io_with_context(e, "create zstd encoder"))?;
    let mut builder = Builder::new(encoder);
    let mut stats = ArchiveStats::default();

    let manifest_bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|e| ChanError::Io(format!("encode metadata manifest: {e}")))?;
    append_bytes(
        &mut builder,
        Path::new(MANIFEST_PATH),
        &manifest_bytes,
        0o644,
        &mut stats,
    )?;

    append_dir(&mut builder, Path::new(PAYLOAD_ROOT), &mut stats)?;
    for subtree in INCLUDED_SUBTREES {
        let source = source_subtree(workspace_paths, subtree);
        let archive_dir = PathBuf::from(PAYLOAD_ROOT).join(subtree);
        append_dir(&mut builder, &archive_dir, &mut stats)?;
        if source.exists() {
            append_tree(
                &mut builder,
                &source,
                &archive_dir,
                &mut stats,
                &snapshots,
                &graph_wal,
            )?;
        }
    }

    let encoder = builder.into_inner()?;
    encoder
        .finish()
        .map_err(|e| ChanError::io_with_context(e, "finish zstd archive"))?;
    Ok((stats.files, stats.bytes))
}

fn snapshot_source_exists(path: &Path, directory: bool) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if (directory && meta.is_dir()) || (!directory && meta.is_file()) => Ok(true),
        Ok(_) => Err(ChanError::Io(format!(
            "metadata archive refuses special file: {}",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn snapshot_graph(source: &Path, destination: &Path) -> Result<()> {
    let conn =
        rusqlite::Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let destination = destination
        .to_str()
        .ok_or_else(|| ChanError::Io("graph snapshot path is not UTF-8".into()))?;
    conn.execute("VACUUM INTO ?1", [destination])?;
    Ok(())
}

fn snapshot_bm25(source: &Path, destination: &Path) -> Result<()> {
    const ATTEMPTS: usize = 3;
    for attempt in 0..ATTEMPTS {
        std::fs::create_dir(destination)?;
        let result = snapshot_bm25_commit(source, destination);
        match result {
            Ok(()) => return Ok(()),
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound && attempt + 1 < ATTEMPTS =>
            {
                std::fs::remove_dir_all(destination)?;
            }
            Err(error) => {
                return Err(ChanError::io_with_context(
                    error,
                    format!(
                        "snapshot search index (attempt {} of {ATTEMPTS})",
                        attempt + 1
                    ),
                ))
            }
        }
    }
    unreachable!("the final snapshot attempt returns its result")
}

fn snapshot_bm25_commit(source: &Path, destination: &Path) -> std::io::Result<()> {
    // Tantivy atomically replaces meta.json. Parse the captured bytes through
    // Tantivy itself in the stage, without reopening the live metadata or
    // acquiring its writer lock. Segment UUIDs and delete opstamps name
    // immutable files; a missing one means GC won and the whole attempt retries.
    let meta = std::fs::read(source.join("meta.json"))?;
    std::fs::write(destination.join("meta.json"), meta)?;
    #[cfg(test)]
    snapshot_probe(&source.join("meta.json"));
    let index = tantivy::Index::open_in_dir(destination).map_err(std::io::Error::other)?;
    let meta = index.load_metas().map_err(std::io::Error::other)?;
    let mut files = BTreeSet::new();
    for segment in meta.segments {
        let unused_delete = (!segment.has_deletes())
            .then(|| segment.relative_path(tantivy::index::SegmentComponent::Delete));
        files.extend(
            segment
                .list_files()
                .into_iter()
                .filter(|path| Some(path) != unused_delete.as_ref()),
        );
    }
    for file in &files {
        let path = source.join(file);
        if !std::fs::symlink_metadata(&path)?.is_file() {
            return Err(std::io::Error::other(format!(
                "search segment is not a regular file: {}",
                path.display()
            )));
        }
        std::fs::copy(&path, destination.join(file))?;
    }
    // The imported writer must own exactly the archived files for its GC.
    files.insert(PathBuf::from("meta.json"));
    std::fs::write(
        destination.join(".managed.json"),
        serde_json::to_vec(&files)?,
    )?;
    Ok(())
}

fn source_subtree(paths: &WorkspacePaths, subtree: &str) -> PathBuf {
    match subtree {
        "index" => paths.index.clone(),
        "graph" => paths.graph_dir.clone(),
        "report" => paths
            .report
            .parent()
            .expect("report path has parent")
            .to_path_buf(),
        "sessions" => paths.sessions.clone(),
        _ => paths.root.join(subtree),
    }
}

fn replace_subtree(paths: &WorkspacePaths, payload: &Path, subtree: &str) -> Result<()> {
    let source = payload.join(subtree);
    let target = source_subtree(paths, subtree);
    if target.exists() {
        std::fs::remove_dir_all(&target)?;
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if source.exists() {
        std::fs::rename(&source, &target)?;
    } else {
        std::fs::create_dir_all(&target)?;
    }
    Ok(())
}

fn extract_payload(archive: &Path, payload: &Path) -> Result<(usize, u64)> {
    let file = File::open(archive)?;
    let decoder = zstd::stream::read::Decoder::new(BufReader::new(file)).map_err(|e| {
        ChanError::io_with_context(e, format!("open zstd archive {}", archive.display()))
    })?;
    let mut archive = Archive::new(decoder);
    let mut stats = ArchiveStats::default();
    for entry in archive.entries()? {
        let mut entry = entry?;
        let entry_path = entry.path()?.into_owned();
        let kind = archive_entry_kind(entry.header().entry_type());
        validate_archive_entry_path(&entry_path, kind)
            .map_err(|e| ChanError::Io(format!("unsafe metadata archive path: {e}")))?;
        if entry_path == Path::new(MANIFEST_PATH) {
            continue;
        }
        let Ok(rel) = entry_path.strip_prefix(PAYLOAD_ROOT) else {
            return Err(ChanError::Io(format!(
                "metadata archive entry outside payload: {}",
                entry_path.display()
            )));
        };
        if rel.as_os_str().is_empty() {
            std::fs::create_dir_all(payload)?;
            continue;
        }
        validate_archive_entry_path(rel, kind)
            .map_err(|e| ChanError::Io(format!("unsafe metadata archive payload path: {e}")))?;
        let dest = payload.join(rel);
        match kind {
            ArchiveEntryKind::Directory => {
                std::fs::create_dir_all(&dest)?;
                stats.files += 1;
            }
            ArchiveEntryKind::Regular => {
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let mut out = File::create(&dest)?;
                let bytes = std::io::copy(&mut entry, &mut out)?;
                stats.files += 1;
                stats.bytes += bytes;
            }
            ArchiveEntryKind::Symlink | ArchiveEntryKind::Hardlink | ArchiveEntryKind::Special => {
                return Err(ChanError::Io(format!(
                    "metadata archive refuses unsafe entry: {}",
                    entry_path.display()
                )));
            }
        }
    }
    Ok((stats.files, stats.bytes))
}

fn append_tree(
    builder: &mut Builder<zstd::stream::write::Encoder<'_, BufWriter<File>>>,
    source: &Path,
    archive_dir: &Path,
    stats: &mut ArchiveStats,
    snapshots: &BTreeMap<PathBuf, PathBuf>,
    graph_wal: &Path,
) -> Result<()> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(source)? {
        entries.push(entry?);
    }
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let name = entry.file_name();
        if path == graph_wal || should_skip_entry_name(&name, &path) {
            continue;
        }
        let path = snapshots.get(&path).unwrap_or(&path);
        let meta = std::fs::symlink_metadata(path)?;
        let dest = archive_dir.join(&name);
        let file_type = meta.file_type();
        if file_type.is_dir() {
            append_dir(builder, &dest, stats)?;
            append_tree(builder, path, &dest, stats, snapshots, graph_wal)?;
        } else if file_type.is_file() {
            append_file(builder, path, &dest, meta.len(), stats)?;
        } else {
            return Err(ChanError::Io(format!(
                "metadata archive refuses special file: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

fn append_dir(
    builder: &mut Builder<zstd::stream::write::Encoder<'_, BufWriter<File>>>,
    path: &Path,
    stats: &mut ArchiveStats,
) -> Result<()> {
    validate_archive_entry_path(path, ArchiveEntryKind::Directory)
        .map_err(|e| ChanError::Io(format!("unsafe metadata archive path: {e}")))?;
    let mut header = Header::new_gnu();
    header.set_entry_type(EntryType::Directory);
    header.set_mode(0o755);
    header.set_size(0);
    header.set_mtime(0);
    header.set_cksum();
    builder.append_data(&mut header, path, std::io::empty())?;
    stats.files += 1;
    Ok(())
}

fn append_file(
    builder: &mut Builder<zstd::stream::write::Encoder<'_, BufWriter<File>>>,
    source: &Path,
    dest: &Path,
    len: u64,
    stats: &mut ArchiveStats,
) -> Result<()> {
    validate_archive_entry_path(dest, ArchiveEntryKind::Regular)
        .map_err(|e| ChanError::Io(format!("unsafe metadata archive path: {e}")))?;
    let mut file = File::open(source)?;
    let mut header = Header::new_gnu();
    header.set_entry_type(EntryType::Regular);
    header.set_mode(0o644);
    header.set_size(len);
    header.set_mtime(0);
    header.set_cksum();
    builder.append_data(&mut header, dest, &mut file)?;
    #[cfg(test)]
    snapshot_probe(source);
    stats.files += 1;
    stats.bytes += len;
    Ok(())
}

#[cfg(test)]
type SnapshotProbe = Box<dyn FnMut(&Path)>;

#[cfg(test)]
thread_local! {
    static SNAPSHOT_PROBE: std::cell::RefCell<Option<SnapshotProbe>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn snapshot_probe(path: &Path) {
    SNAPSHOT_PROBE.with_borrow_mut(|probe| {
        if let Some(probe) = probe {
            probe(path);
        }
    });
}

fn append_bytes(
    builder: &mut Builder<zstd::stream::write::Encoder<'_, BufWriter<File>>>,
    path: &Path,
    bytes: &[u8],
    mode: u32,
    stats: &mut ArchiveStats,
) -> Result<()> {
    validate_archive_entry_path(path, ArchiveEntryKind::Regular)
        .map_err(|e| ChanError::Io(format!("unsafe metadata archive path: {e}")))?;
    let mut header = Header::new_gnu();
    header.set_entry_type(EntryType::Regular);
    header.set_mode(mode);
    header.set_size(bytes.len() as u64);
    header.set_mtime(0);
    header.set_cksum();
    builder.append_data(&mut header, path, bytes)?;
    stats.files += 1;
    stats.bytes += bytes.len() as u64;
    Ok(())
}

#[derive(Debug, Default)]
struct ArchiveStats {
    files: usize,
    bytes: u64,
}

fn should_skip_entry_name(name: &OsStr, path: &Path) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    if matches!(name, "staging" | "temp" | "tmp" | ".tmp") {
        return true;
    }
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".shm") || lower.ends_with("-shm") || path.ends_with(".DS_Store")
}

fn temp_sibling(output: &Path) -> PathBuf {
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let name = output
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("metadata.tar.zst");
    parent.join(format!(".{name}.tmp-{}", std::process::id()))
}

fn has_tar_zst_extension(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".tar.zst"))
}

fn archive_entry_kind(entry_type: EntryType) -> ArchiveEntryKind {
    if entry_type.is_file() {
        ArchiveEntryKind::Regular
    } else if entry_type.is_dir() {
        ArchiveEntryKind::Directory
    } else if entry_type.is_symlink() {
        ArchiveEntryKind::Symlink
    } else if entry_type.is_hard_link() {
        ArchiveEntryKind::Hardlink
    } else {
        ArchiveEntryKind::Special
    }
}

fn guard_scm_identity(manifest: &MetadataManifest, target: Option<&ScmIdentity>) -> Result<()> {
    let Some(source) = manifest.scm.as_ref() else {
        return Ok(());
    };
    let Some(target) = target else {
        return Err(ChanError::Io(
            "metadata archive was exported from an SCM-backed workspace, but target has no SCM identity"
                .into(),
        ));
    };
    if !source.remotes.is_empty() || !target.remotes.is_empty() {
        if source.remotes != target.remotes {
            return Err(ChanError::Io(
                "metadata archive SCM remotes do not match target workspace".into(),
            ));
        }
        return Ok(());
    }
    if source.head.is_some() && target.head.is_some() && source.head != target.head {
        return Err(ChanError::Io(
            "metadata archive SCM head does not match target workspace".into(),
        ));
    }
    Ok(())
}

fn detect_scm_identity(root: &Path) -> Option<ScmIdentity> {
    let git_dir = find_git_dir(root)?;
    let head = read_git_head(&git_dir);
    let mut remotes: Vec<String> = read_git_remote_urls(&git_dir)
        .into_iter()
        .map(|url| url.trim().to_string())
        .filter_map(|url| normalize_git_remote(&url))
        .collect();
    remotes.sort();
    remotes.dedup();
    if remotes.is_empty() && head.is_none() {
        None
    } else {
        Some(ScmIdentity { remotes, head })
    }
}

fn find_git_dir(root: &Path) -> Option<PathBuf> {
    let mut current = root
        .canonicalize()
        .ok()
        .or_else(|| Some(root.to_path_buf()))?;
    loop {
        let dot_git = current.join(".git");
        if dot_git.is_dir() {
            return Some(dot_git);
        }
        if !current.pop() {
            return None;
        }
    }
}

fn read_git_head(git_dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = raw.trim();
    if head.is_empty() {
        None
    } else if let Some(reference) = head.strip_prefix("ref: ") {
        let target = git_dir.join(reference);
        std::fs::read_to_string(target)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    } else {
        Some(head.to_string())
    }
}

fn read_git_remote_urls(git_dir: &Path) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(git_dir.join("config")) else {
        return Vec::new();
    };
    let mut in_remote = false;
    let mut out = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_remote = trimmed.starts_with("[remote ");
            continue;
        }
        if !in_remote {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        if key.trim() == "url" {
            out.push(value.trim().to_string());
        }
    }
    out
}

pub(crate) fn normalize_git_remote(url: &str) -> Option<String> {
    let mut s = url.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(rest) = s.strip_prefix("git@github.com:") {
        s = rest;
        return Some(format!("github.com/{}", trim_git_suffix(s)));
    }
    for prefix in [
        "https://github.com/",
        "http://github.com/",
        "ssh://git@github.com/",
    ] {
        if let Some(rest) = s.strip_prefix(prefix) {
            return Some(format!("github.com/{}", trim_git_suffix(rest)));
        }
    }
    Some(trim_git_suffix(s).to_string())
}

fn trim_git_suffix(s: &str) -> &str {
    s.trim_end_matches('/').trim_end_matches(".git")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    struct ProbeGuard;

    impl Drop for ProbeGuard {
        fn drop(&mut self) {
            SNAPSHOT_PROBE.with_borrow_mut(|probe| *probe = None);
        }
    }

    #[test]
    fn metadata_archive_graph_snapshot_survives_wal_checkpoint() {
        let (lib, _cfg, root) = archive_fixture();
        let paths = lib.workspace_paths_for(root.path()).unwrap();
        let conn = rusqlite::Connection::open(&paths.graph_db).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE snapshot_rows (body TEXT); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO snapshot_rows VALUES ('committed in WAL');").unwrap();
        assert!(
            std::fs::metadata(paths.graph_dir.join("graph.sqlite-wal"))
                .unwrap()
                .len()
                > 0
        );
        let checkpointed = std::rc::Rc::new(std::cell::Cell::new(false));
        let observed = checkpointed.clone();
        let _guard = ProbeGuard;
        SNAPSHOT_PROBE.with_borrow_mut(|probe| {
            *probe = Some(Box::new(move |path| {
                if path.file_name() == Some(OsStr::new("graph.sqlite")) && !observed.replace(true) {
                    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
                        .unwrap();
                }
            }))
        });
        let output = TempDir::new().unwrap();
        let archive = output.path().join("metadata.tar.zst");
        lib.export_metadata_archive(
            root.path(),
            &archive,
            MetadataExportOptions {
                chan_version: "test".into(),
            },
        )
        .unwrap();
        assert!(checkpointed.get());
        let payload = output.path().join("payload");
        extract_payload(&archive, &payload).unwrap();
        let restored = rusqlite::Connection::open(payload.join("graph/graph.sqlite")).unwrap();
        let rows: Vec<String> = restored
            .prepare("SELECT body FROM snapshot_rows")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();
        let wal = payload.join("graph/graph.sqlite-wal").exists();
        eprintln!("archived rows={rows:?}; archived WAL={wal}");
        assert_eq!(rows, ["committed in WAL"]);
        assert!(!read_archive_paths(&archive)
            .iter()
            .any(|path| path.ends_with("graph.sqlite-wal")));
    }

    #[test]
    fn metadata_archive_index_snapshot_survives_commit_and_gc() {
        use tantivy::schema::{Schema, STORED, TEXT};
        let (lib, _cfg, root) = archive_fixture();
        let paths = lib.workspace_paths_for(root.path()).unwrap();
        let source = paths.index.join("bm25");
        std::fs::create_dir(&source).unwrap();
        let mut schema = Schema::builder();
        let body = schema.add_text_field("body", TEXT | STORED);
        let index = tantivy::Index::create_in_dir(&source, schema.build()).unwrap();
        let mut writer: tantivy::IndexWriter =
            index.writer_with_num_threads(1, 20_000_000).unwrap();
        writer.set_merge_policy(Box::new(tantivy::merge_policy::NoMergePolicy));
        writer
            .add_document(tantivy::doc!(body => "before"))
            .unwrap();
        writer.commit().unwrap();
        let committed = std::rc::Rc::new(std::cell::Cell::new(false));
        let observed = committed.clone();
        let meta_reads = std::rc::Rc::new(std::cell::Cell::new(0));
        let observed_reads = meta_reads.clone();
        let source_meta = source.join("meta.json");
        let _guard = ProbeGuard;
        SNAPSHOT_PROBE.with_borrow_mut(|probe| {
            *probe = Some(Box::new(move |path| {
                if path == source_meta {
                    observed_reads.set(observed_reads.get() + 1);
                }
                if (path.extension() == Some(OsStr::new("term"))
                    || path.file_name() == Some(OsStr::new("meta.json")))
                    && !observed.replace(true)
                {
                    writer.delete_all_documents().unwrap();
                    writer
                        .add_document(tantivy::doc!(body => "after one"))
                        .unwrap();
                    writer
                        .add_document(tantivy::doc!(body => "after two"))
                        .unwrap();
                    writer.commit().unwrap();
                    writer.garbage_collect_files().wait().unwrap();
                }
            }))
        });
        let output = TempDir::new().unwrap();
        let archive = output.path().join("metadata.tar.zst");
        let exported = lib.export_metadata_archive(
            root.path(),
            &archive,
            MetadataExportOptions {
                chan_version: "test".into(),
            },
        );
        eprintln!("index export={exported:?}");
        exported.unwrap();
        assert!(committed.get());
        assert_eq!(meta_reads.get(), 2, "GC forces one complete retry");
        let payload = output.path().join("payload");
        extract_payload(&archive, &payload).unwrap();
        let index = tantivy::Index::open_in_dir(payload.join("index/bm25")).unwrap();
        let reader = index
            .reader_builder()
            .reload_policy(tantivy::ReloadPolicy::Manual)
            .try_into();
        eprintln!("archived index reader error={:?}", reader.as_ref().err());
        let reader: tantivy::IndexReader = reader.unwrap();
        let count = reader.searcher().num_docs();
        assert!(matches!(count, 1 | 2), "one complete commit: {count}");
        use tantivy::schema::Value;
        let searcher = reader.searcher();
        let hits = searcher
            .search(
                &tantivy::query::AllQuery,
                &tantivy::collector::TopDocs::with_limit(10),
            )
            .unwrap();
        let mut bodies: Vec<String> = hits
            .into_iter()
            .map(|(_, address)| {
                let doc: tantivy::TantivyDocument = searcher.doc(address).unwrap();
                doc.get_first(body).unwrap().as_str().unwrap().to_string()
            })
            .collect();
        bodies.sort();
        assert_eq!(bodies, ["after one", "after two"]);
        let mut restored_writer: tantivy::IndexWriter =
            index.writer_with_num_threads(1, 20_000_000).unwrap();
        restored_writer
            .add_document(tantivy::doc!(body => "imported write"))
            .unwrap();
        restored_writer.commit().unwrap();
        reader.reload().unwrap();
        assert_eq!(reader.searcher().num_docs(), 3);
    }

    fn read_archive_paths(path: &Path) -> Vec<String> {
        let file = File::open(path).unwrap();
        let decoder = zstd::stream::read::Decoder::new(BufReader::new(file)).unwrap();
        let mut archive = Archive::new(decoder);
        archive
            .entries()
            .unwrap()
            .map(|entry| {
                entry
                    .unwrap()
                    .path()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect()
    }

    #[test]
    fn metadata_archive_index_snapshot_bounds_retries_and_cleans_stage() {
        let (lib, _cfg, root) = archive_fixture();
        let paths = lib.workspace_paths_for(root.path()).unwrap();
        let bm25 = crate::index::bm25::Bm25Index::open(&paths.index).unwrap();
        bm25.index_file("note.md", "body", &config::Chunking::WholeDoc)
            .unwrap();
        bm25.commit().unwrap();
        let source = paths.index.join("bm25");
        let segment = std::fs::read_dir(&source)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.extension() == Some(OsStr::new("term")))
            .unwrap();
        let attempts = std::rc::Rc::new(std::cell::Cell::new(0));
        let observed = attempts.clone();
        let _guard = ProbeGuard;
        SNAPSHOT_PROBE.with_borrow_mut(|probe| {
            *probe = Some(Box::new(move |path| {
                if path == source.join("meta.json") {
                    observed.set(observed.get() + 1);
                    if observed.get() == 1 {
                        std::fs::remove_file(&segment).unwrap();
                    }
                }
            }))
        });
        let output = TempDir::new().unwrap();
        let archive = output.path().join("metadata.tar.zst");
        let error = lib
            .export_metadata_archive(
                root.path(),
                &archive,
                MetadataExportOptions {
                    chan_version: "test".into(),
                },
            )
            .unwrap_err();
        assert_eq!(attempts.get(), 3);
        assert!(error.to_string().contains("attempt 3 of 3"));
        assert!(!archive.exists());
        assert_eq!(std::fs::read_dir(output.path()).unwrap().count(), 0);
        assert_eq!(
            std::fs::read_dir(paths.root.join("staging"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn metadata_archive_index_snapshot_keeps_committed_deletions() {
        let (lib, _cfg, root) = archive_fixture();
        let paths = lib.workspace_paths_for(root.path()).unwrap();
        let source = paths.index.join("bm25");
        std::fs::create_dir(&source).unwrap();
        let mut schema = tantivy::schema::Schema::builder();
        let body = schema.add_text_field("body", tantivy::schema::TEXT);
        let index = tantivy::Index::create_in_dir(&source, schema.build()).unwrap();
        let mut writer: tantivy::IndexWriter =
            index.writer_with_num_threads(1, 20_000_000).unwrap();
        writer.set_merge_policy(Box::new(tantivy::merge_policy::NoMergePolicy));
        for name in ["keep", "remove"] {
            writer.add_document(tantivy::doc!(body => name)).unwrap();
        }
        writer.commit().unwrap();
        writer.delete_term(tantivy::Term::from_field_text(body, "remove"));
        writer.commit().unwrap();
        assert!(std::fs::read_dir(paths.index.join("bm25"))
            .unwrap()
            .any(|e| e.unwrap().path().extension() == Some(OsStr::new("del"))));
        let output = TempDir::new().unwrap();
        let archive = output.path().join("metadata.tar.zst");
        lib.export_metadata_archive(
            root.path(),
            &archive,
            MetadataExportOptions {
                chan_version: "test".into(),
            },
        )
        .unwrap();
        let payload = output.path().join("payload");
        extract_payload(&archive, &payload).unwrap();
        let restored = tantivy::Index::open_in_dir(payload.join("index/bm25")).unwrap();
        let reader: tantivy::IndexReader = restored
            .reader_builder()
            .reload_policy(tantivy::ReloadPolicy::Manual)
            .try_into()
            .unwrap();
        let searcher = reader.searcher();
        assert_eq!(searcher.num_docs(), 1);
        for (term, expected) in [("keep", 1), ("remove", 0)] {
            let query = tantivy::query::TermQuery::new(
                tantivy::Term::from_field_text(body, term),
                tantivy::schema::IndexRecordOption::Basic,
            );
            assert_eq!(
                searcher.search(&query, &tantivy::collector::Count).unwrap(),
                expected
            );
        }
    }

    fn archive_fixture() -> (Library, TempDir, TempDir) {
        let cfg = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        (lib, cfg, root)
    }

    #[test]
    fn metadata_archive_manifest_serde_round_trip() {
        let manifest = MetadataManifest {
            archive_format_version: 1,
            chan_version: "0.13.0-test".into(),
            created_at: "2026-05-24T00:00:00Z".into(),
            source_root: "/tmp/workspace".into(),
            source_metadata_key: "-tmp-workspace-deadbeef".into(),
            metadata_schema: MetadataSchema {
                path_key_scheme: PATH_KEY_SCHEME.into(),
                index_schema_version: 3,
                graph_user_version: Some(6),
                vector_shard_format_version: None,
                report_schema_version: Some(1),
            },
            scm: Some(ScmIdentity {
                remotes: vec!["github.com/fiorix/chan".into()],
                head: Some("abc".into()),
            }),
            included_subtrees: INCLUDED_SUBTREES.iter().map(|s| (*s).into()).collect(),
            excluded_subtrees: EXCLUDED_SUBTREES.iter().map(|s| (*s).into()).collect(),
        };
        let raw = serde_json::to_string(&manifest).unwrap();
        let decoded: MetadataManifest = serde_json::from_str(&raw).unwrap();
        assert_eq!(decoded, manifest);
    }

    #[test]
    fn metadata_archive_export_creates_tar_zst_with_manifest_first_and_payload() {
        let (lib, _cfg, root) = archive_fixture();
        let paths = lib.workspace_paths_for(root.path()).unwrap();
        std::fs::write(paths.index.join("config.toml"), b"index").unwrap();
        let graph = rusqlite::Connection::open(&paths.graph_db).unwrap();
        graph
            .execute_batch(
                "CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('graph');",
            )
            .unwrap();
        std::fs::write(
            paths.report.parent().unwrap().join("report.jsonl"),
            b"report",
        )
        .unwrap();
        std::fs::write(paths.sessions.join("session.json"), b"session").unwrap();

        let out_dir = TempDir::new().unwrap();
        let out = out_dir.path().join("metadata.tar.zst");
        let report = lib
            .export_metadata_archive(
                root.path(),
                &out,
                MetadataExportOptions {
                    chan_version: "test-version".into(),
                },
            )
            .unwrap();
        assert_eq!(report.archive_path, out);
        assert!(report.files > 0);
        assert!(report.bytes > 0);

        let paths = read_archive_paths(&out);
        assert_eq!(paths.first().unwrap(), MANIFEST_PATH);
        assert!(paths.contains(&"chan-metadata-v1/payload/index/config.toml".into()));
        assert!(paths.contains(&"chan-metadata-v1/payload/graph/graph.sqlite".into()));
        assert!(paths.contains(&"chan-metadata-v1/payload/report/report.jsonl".into()));
        assert!(paths.contains(&"chan-metadata-v1/payload/sessions/session.json".into()));
        // Drafts now live in the workspace root (user content), not in
        // the metadata bundle, so they never appear in the archive.
        assert!(!paths.iter().any(|p| p.contains("payload/drafts")));
    }

    #[test]
    fn metadata_archive_export_excludes_private_and_temp_subtrees() {
        let (lib, _cfg, root) = archive_fixture();
        let paths = lib.workspace_paths_for(root.path()).unwrap();
        std::fs::write(paths.tokens.join("token"), b"secret").unwrap();
        std::fs::write(paths.lock.join("writer.lock"), b"lock").unwrap();
        std::fs::write(paths.trash.join("trash-file"), b"trash").unwrap();
        std::fs::write(paths.graph_dir.join("graph.sqlite-shm"), b"shm").unwrap();
        std::fs::write(paths.graph_dir.join("other.shm"), b"shm").unwrap();
        std::fs::create_dir_all(paths.index.join("staging")).unwrap();
        std::fs::write(paths.index.join("staging").join("tmp"), b"tmp").unwrap();
        std::fs::write(paths.index.join("keep"), b"keep").unwrap();

        let out_dir = TempDir::new().unwrap();
        let out = out_dir.path().join("metadata.tar.zst");
        lib.export_metadata_archive(
            root.path(),
            &out,
            MetadataExportOptions {
                chan_version: "test-version".into(),
            },
        )
        .unwrap();
        let joined = read_archive_paths(&out).join("\n");
        assert!(joined.contains("payload/index/keep"));
        assert!(!joined.contains("tokens"));
        assert!(!joined.contains("locks"));
        assert!(!joined.contains("trash"));
        assert!(!joined.contains("graph.sqlite-shm"));
        assert!(!joined.contains("other.shm"));
        assert!(!joined.contains("staging/tmp"));
    }

    #[test]
    fn metadata_archive_export_rejects_non_tar_zst_output() {
        let (lib, _cfg, root) = archive_fixture();
        let out_dir = TempDir::new().unwrap();
        let out = out_dir.path().join("metadata.tar.gz");
        let err = lib
            .export_metadata_archive(
                root.path(),
                &out,
                MetadataExportOptions {
                    chan_version: "test-version".into(),
                },
            )
            .unwrap_err();
        assert!(err.to_string().contains(".tar.zst"), "{err}");
    }

    #[test]
    fn metadata_archive_inspect_returns_manifest_without_payload() {
        let (lib, _cfg, root) = archive_fixture();
        let paths = lib.workspace_paths_for(root.path()).unwrap();
        std::fs::write(paths.index.join("config.toml"), b"not json").unwrap();
        let out_dir = TempDir::new().unwrap();
        let out = out_dir.path().join("metadata.tar.zst");
        let exported = lib
            .export_metadata_archive(
                root.path(),
                &out,
                MetadataExportOptions {
                    chan_version: "inspect-test".into(),
                },
            )
            .unwrap();

        let inspected = lib.inspect_metadata_archive(&out).unwrap();
        assert_eq!(inspected, exported.manifest);
        assert_eq!(inspected.chan_version, "inspect-test");
    }

    #[test]
    fn metadata_archive_import_restores_payload_subtrees() {
        let (lib, _cfg, root) = archive_fixture();
        let paths = lib.workspace_paths_for(root.path()).unwrap();
        std::fs::write(paths.index.join("config.toml"), b"index").unwrap();
        std::fs::write(paths.sessions.join("session.json"), b"session").unwrap();
        let out_dir = TempDir::new().unwrap();
        let out = out_dir.path().join("metadata.tar.zst");
        lib.export_metadata_archive(
            root.path(),
            &out,
            MetadataExportOptions {
                chan_version: "test-version".into(),
            },
        )
        .unwrap();
        std::fs::remove_dir_all(&paths.index).unwrap();
        std::fs::remove_dir_all(&paths.sessions).unwrap();

        let report = lib
            .import_metadata_archive(
                root.path(),
                &out,
                MetadataImportOptions {
                    rescan: false,
                    force_scm: false,
                },
            )
            .unwrap();

        assert!(!report.rescanned);
        assert!(report.imported_subtrees.contains(&"index".to_string()));
        assert!(report.imported_subtrees.contains(&"sessions".to_string()));
        // Drafts are in-root user content now, never in the bundle.
        assert!(!report.imported_subtrees.contains(&"drafts".to_string()));
        assert_eq!(
            std::fs::read_to_string(paths.index.join("config.toml")).unwrap(),
            "index"
        );
        assert_eq!(
            std::fs::read_to_string(paths.sessions.join("session.json")).unwrap(),
            "session"
        );
    }

    #[test]
    fn metadata_archive_import_is_refused_while_a_workspace_handle_is_live() {
        let (lib, _cfg, root) = archive_fixture();
        let opts = crate::workspace::SearchOpts {
            mode: crate::SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        let out_dir = TempDir::new().unwrap();
        let archive = out_dir.path().join("metadata.tar.zst");
        // Archive one indexed note, then add a second one through a handle
        // that stays open, the way a running devserver holds one.
        {
            let ws = lib.open_workspace(root.path()).unwrap();
            ws.write_text("alpha.md", "# alpha\nbody\n").unwrap();
            ws.index_file("alpha.md").unwrap();
        }
        lib.export_metadata_archive(
            root.path(),
            &archive,
            MetadataExportOptions {
                chan_version: "lock-test".into(),
            },
        )
        .unwrap();
        let ws = lib.open_workspace(root.path()).unwrap();
        ws.write_text("beta.md", "# beta\nbody\n").unwrap();
        ws.index_file("beta.md").unwrap();

        // The import would swap index/, graph/, sessions/ and report/ out
        // from under that handle. Refused, and nothing is touched.
        let err = lib
            .import_metadata_archive(
                root.path(),
                &archive,
                MetadataImportOptions {
                    rescan: false,
                    force_scm: false,
                },
            )
            .unwrap_err();
        assert!(matches!(err, ChanError::WorkspaceAlreadyOpen), "{err}");
        assert_eq!(ws.search("beta", &opts).unwrap().hits.len(), 1);
        assert_eq!(
            ws.graph().unwrap().files().unwrap(),
            vec!["alpha.md".to_string(), "beta.md".to_string()]
        );
        drop(ws);

        // The sidecars survive the refusal intact: reopening reads them, it
        // does not find an index half-replaced under a live writer.
        let ws = lib.open_workspace(root.path()).unwrap();
        assert_eq!(ws.search("alpha", &opts).unwrap().hits.len(), 1);
        assert_eq!(ws.search("beta", &opts).unwrap().hits.len(), 1);
        drop(ws);

        // With no handle held, the same import goes through and the
        // workspace is the archive's generation, whole.
        lib.import_metadata_archive(
            root.path(),
            &archive,
            MetadataImportOptions {
                rescan: false,
                force_scm: false,
            },
        )
        .unwrap();
        // And the workspace still opens on a whole index afterwards, which
        // is exactly what the unlocked import destroyed. `alpha.md` is in
        // both generations, so this does not race the open-time reconcile
        // that walks the tree back into the graph.
        let ws = lib.open_workspace(root.path()).unwrap();
        assert_eq!(ws.search("alpha", &opts).unwrap().hits.len(), 1);
    }

    #[test]
    fn metadata_archive_import_is_refused_while_the_writer_lock_is_held() {
        let (lib, _cfg, root) = archive_fixture();
        let paths = lib.workspace_paths_for(root.path()).unwrap();
        std::fs::write(paths.index.join("config.toml"), b"live").unwrap();
        let out_dir = TempDir::new().unwrap();
        let archive = out_dir.path().join("metadata.tar.zst");
        lib.export_metadata_archive(
            root.path(),
            &archive,
            MetadataExportOptions {
                chan_version: "lock-test".into(),
            },
        )
        .unwrap();
        std::fs::write(paths.index.join("config.toml"), b"newer").unwrap();

        // No `Arc<Workspace>` exists, so the in-process check passes and the
        // refusal has to come from the flock itself. A second holder in this
        // process reports `WorkspaceAlreadyOpen` rather than the
        // cross-process `WorkspaceLocked`; a foreign holder is the
        // `WorkspaceLocked` arm, which needs a second process to exercise.
        let held = WorkspaceLock::acquire(&paths.lock, root.path()).unwrap();
        let err = lib
            .import_metadata_archive(
                root.path(),
                &archive,
                MetadataImportOptions {
                    rescan: false,
                    force_scm: false,
                },
            )
            .unwrap_err();
        assert!(matches!(err, ChanError::WorkspaceAlreadyOpen), "{err}");
        assert_eq!(
            std::fs::read(paths.index.join("config.toml")).unwrap(),
            b"newer",
            "a refused import must not have replaced the live index"
        );

        drop(held);
        lib.import_metadata_archive(
            root.path(),
            &archive,
            MetadataImportOptions {
                rescan: false,
                force_scm: false,
            },
        )
        .unwrap();
        assert_eq!(
            std::fs::read(paths.index.join("config.toml")).unwrap(),
            b"live"
        );
    }

    #[test]
    fn metadata_archive_import_rejects_scm_mismatch_without_force() {
        let manifest = MetadataManifest {
            archive_format_version: ARCHIVE_FORMAT_VERSION,
            chan_version: "test".into(),
            created_at: "2026-05-24T00:00:00Z".into(),
            source_root: "/tmp/source".into(),
            source_metadata_key: "source".into(),
            metadata_schema: MetadataSchema {
                path_key_scheme: PATH_KEY_SCHEME.into(),
                index_schema_version: config::SCHEMA_VERSION,
                graph_user_version: None,
                vector_shard_format_version: None,
                report_schema_version: Some(chan_report::SCHEMA_VERSION),
            },
            scm: Some(ScmIdentity {
                remotes: vec!["github.com/example/source".into()],
                head: None,
            }),
            included_subtrees: INCLUDED_SUBTREES.iter().map(|s| (*s).into()).collect(),
            excluded_subtrees: EXCLUDED_SUBTREES.iter().map(|s| (*s).into()).collect(),
        };
        let target = ScmIdentity {
            remotes: vec!["github.com/example/target".into()],
            head: None,
        };

        assert!(guard_scm_identity(&manifest, Some(&target)).is_err());
        assert!(guard_scm_identity(&manifest, manifest.scm.as_ref()).is_ok());
    }

    #[test]
    fn metadata_archive_inspect_rejects_wrong_manifest_shape() {
        let out_dir = TempDir::new().unwrap();
        let out = out_dir.path().join("bad.tar.zst");
        {
            let file = File::create(&out).unwrap();
            let encoder = zstd::stream::write::Encoder::new(BufWriter::new(file), 0).unwrap();
            let mut builder = Builder::new(encoder);
            let mut header = Header::new_gnu();
            header.set_entry_type(EntryType::Regular);
            header.set_mode(0o644);
            header.set_size(2);
            header.set_cksum();
            builder
                .append_data(&mut header, "manifest.json", "{}".as_bytes())
                .unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }
        let cfg = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        let err = lib.inspect_metadata_archive(&out).unwrap_err();
        assert!(err.to_string().contains(MANIFEST_PATH), "{err}");
    }

    #[test]
    fn archive_path_safety_rejects_unsafe_entries() {
        assert!(validate_archive_entry_path(
            Path::new("payload/index/a"),
            ArchiveEntryKind::Regular
        )
        .is_ok());
        assert!(matches!(
            validate_archive_entry_path(Path::new("/abs"), ArchiveEntryKind::Regular),
            Err(MetadataArchivePathError::Absolute(_))
        ));
        assert!(matches!(
            validate_archive_entry_path(Path::new("../parent"), ArchiveEntryKind::Regular),
            Err(MetadataArchivePathError::Parent(_))
        ));
        assert!(matches!(
            validate_archive_entry_path(Path::new("C:/temp"), ArchiveEntryKind::Regular),
            Err(MetadataArchivePathError::Prefix(_))
        ));
        assert!(matches!(
            validate_archive_entry_path(Path::new("a/b"), ArchiveEntryKind::Symlink),
            Err(MetadataArchivePathError::UnsafeKind(
                ArchiveEntryKind::Symlink
            ))
        ));
        assert!(matches!(
            validate_archive_entry_path(Path::new("a/b"), ArchiveEntryKind::Hardlink),
            Err(MetadataArchivePathError::UnsafeKind(
                ArchiveEntryKind::Hardlink
            ))
        ));
        assert!(matches!(
            validate_archive_entry_path(Path::new("a/b"), ArchiveEntryKind::Special),
            Err(MetadataArchivePathError::UnsafeKind(
                ArchiveEntryKind::Special
            ))
        ));
        #[cfg(windows)]
        assert!(matches!(
            validate_archive_entry_path(Path::new("C:\\temp"), ArchiveEntryKind::Regular),
            Err(MetadataArchivePathError::Prefix(_))
        ));
    }

    #[test]
    fn git_remote_normalization_covers_github_forms() {
        assert_eq!(
            normalize_git_remote("https://github.com/fiorix/chan.git").unwrap(),
            "github.com/fiorix/chan",
        );
        assert_eq!(
            normalize_git_remote("git@github.com:fiorix/chan.git").unwrap(),
            "github.com/fiorix/chan",
        );
        assert_eq!(
            normalize_git_remote("ssh://git@github.com/fiorix/chan.git").unwrap(),
            "github.com/fiorix/chan",
        );
        assert_eq!(
            normalize_git_remote("https://example.com/acme/repo.git").unwrap(),
            "https://example.com/acme/repo",
        );
    }

    #[test]
    fn scm_identity_reads_git_metadata_without_shelling_out() {
        let root = TempDir::new().unwrap();
        let git = root.path().join(".git");
        std::fs::create_dir_all(git.join("refs").join("heads")).unwrap();
        std::fs::write(git.join("HEAD"), b"ref: refs/heads/main\n").unwrap();
        std::fs::write(git.join("refs").join("heads").join("main"), b"abc123\n").unwrap();
        std::fs::write(
            git.join("config"),
            br#"
[remote "origin"]
    url = git@github.com:fiorix/chan.git
[remote "mirror"]
    url = https://github.com/fiorix/chan.git
"#,
        )
        .unwrap();

        let scm = detect_scm_identity(root.path()).unwrap();
        assert_eq!(scm.head.as_deref(), Some("abc123"));
        assert_eq!(scm.remotes, vec!["github.com/fiorix/chan"]);
    }

    /// An import without `rescan` leaves the sidecars on the archive's
    /// generation. The next open has to bring graph and search back onto
    /// the tree on disk together, and do it without reading again the files
    /// the archive already describes, or the import is not cheap: a full
    /// rebuild would converge too, but only by reading every file.
    #[test]
    fn metadata_import_without_rescan_converges_graph_and_search_on_the_next_open() {
        use crate::index::vectors::{EmbeddedChunk, VectorStore};
        use crate::index::{chunking, config as index_config};

        let (lib, _cfg, root) = archive_fixture();
        let paths = lib.workspace_paths_for(root.path()).unwrap();
        let opts = crate::workspace::SearchOpts {
            mode: crate::SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        let hits = |ws: &crate::workspace::Workspace, token: &str| -> Vec<String> {
            ws.search(token, &opts)
                .unwrap()
                .hits
                .into_iter()
                .map(|hit| hit.path)
                .collect()
        };
        let out_dir = TempDir::new().unwrap();
        let archive = out_dir.path().join("metadata.tar.zst");
        let keep = "# keep\nkeeptoken\n";
        let workspace_root = {
            let ws = lib.open_workspace(root.path()).unwrap();
            ws.join_open_recovery();
            ws.write_text("keep.md", keep).unwrap();
            ws.write_text("gone.md", "# gone\ngonetoken\n").unwrap();
            ws.reindex(None).unwrap();
            ws.set_semantic_enabled(true).unwrap();
            ws.root().to_path_buf()
        };
        // Stand in for keep.md's embeddings: no model is loaded in tests, and
        // the shard only has to be recognisable byte for byte afterwards.
        let cfg = index_config::load(&paths.index).unwrap();
        let embedded: Vec<EmbeddedChunk> = chunking::chunk(keep, &cfg.chunking)
            .iter()
            .map(|c| EmbeddedChunk {
                chunk_id: c.id.clone(),
                heading: c.heading.clone(),
                body: c.body.clone(),
                start_line: c.start_line as u64,
                end_line: c.end_line as u64,
                depth: c.depth,
                vector: vec![1.0, 0.0, 0.0, 0.0],
            })
            .collect();
        assert!(!embedded.is_empty());
        VectorStore::open(&paths.index)
            .unwrap()
            .replace_file("keep.md", &cfg.model, 4, embedded)
            .unwrap();
        let shards = |dir: &Path| -> Vec<(PathBuf, Vec<u8>)> {
            let mut out: Vec<_> = std::fs::read_dir(dir.join("embeddings"))
                .unwrap()
                .flatten()
                .map(|e| (e.path(), std::fs::read(e.path()).unwrap()))
                .collect();
            out.sort();
            out
        };
        let imported_shards = shards(&paths.index);
        assert_eq!(imported_shards.len(), 1);

        lib.export_metadata_archive(
            root.path(),
            &archive,
            MetadataExportOptions {
                chan_version: "rescan-test".into(),
            },
        )
        .unwrap();
        // The tree moves on after the export: one file the archive has never
        // seen, one it has that is now gone.
        std::fs::write(root.path().join("added.md"), "# added\naddedtoken\n").unwrap();
        std::fs::remove_file(root.path().join("gone.md")).unwrap();

        let report = lib
            .import_metadata_archive(
                root.path(),
                &archive,
                MetadataImportOptions {
                    rescan: false,
                    force_scm: false,
                },
            )
            .unwrap();
        assert!(!report.rescanned);

        crate::workspace::arm_derived_state_read_probe(workspace_root.clone());
        let ws = lib.open_workspace(root.path()).unwrap();
        ws.join_open_recovery();
        let reads = crate::workspace::take_derived_state_reads(&workspace_root);

        // Both backends describe the tree on disk, and agree with each other.
        let graph = ws.graph().unwrap().files().unwrap();
        assert_eq!(graph, vec!["added.md".to_string(), "keep.md".to_string()]);
        assert_eq!(ws.indexed_paths().unwrap(), graph);
        assert_eq!(hits(&ws, "addedtoken"), vec!["added.md".to_string()]);
        assert_eq!(hits(&ws, "keeptoken"), vec!["keep.md".to_string()]);
        assert!(hits(&ws, "gonetoken").is_empty());
        // Only the file the archive did not describe was read. keep.md is
        // unchanged since the export, so it is neither read nor re-embedded,
        // and its imported shard is still the one on disk.
        assert_eq!(reads, vec!["added.md".to_string()]);
        assert_eq!(shards(&paths.index), imported_shards);
        assert!(ws.semantic_enabled().unwrap());
    }
}
