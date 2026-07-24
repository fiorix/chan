//! chan-workspace: filesystem, search, and graph primitives for chan workspaces.
//!
//! Public surface is path-based, all relative paths POSIX-style ("/" separator)
//! and rooted at a Workspace's `root`. Designed to be FFI-safe via uniffi later:
//! no lifetimes on public types, owned strings only, all handle types are
//! `Arc<Self>`-able.
//!
//! Two top-level handles:
//!
//!   Library: owns the per-machine registry (~/.chan/config.toml) of known
//!   workspaces and resolves OS state/cache locations. Process-wide singleton
//!   in practice; cheap to clone (Arc inside).
//!
//!   Workspace: handle to one registered directory. Exposes filesystem
//!   primitives (read/write/stat/list), search, graph, and watch. Holds a
//!   per-workspace cross-process lock for the index writer.
//!
//! What is intentionally NOT here:
//!   - HTTP server, WebSocket transport, frontend bundle. Those live in
//!     `chan` (the CLI + embedded editor).
//!   - LLM/agent code, API key storage. App-level concern.
//!   - Editor preferences (fonts, theme). App-level concern.

mod blob;
pub mod bootstrap;
pub mod contacts;
pub mod daemon_lock;
pub mod dashboard;
pub mod drafts;
pub mod error;
pub(crate) mod fd_budget;
pub mod fs_ops;
pub mod graph;
pub mod graph_normalize;
pub mod index;
pub mod indexer;
pub mod library;
pub mod lock;
pub mod markdown;
pub mod metadata_archive;
pub mod paths;
pub mod progress;
pub mod registry;
mod report;
pub mod teams;
#[cfg(test)]
mod test_gate;
pub mod trash;
pub mod vcs;
pub mod watch;
pub mod workspace;
pub mod workspace_search;

pub use bootstrap::{BootstrapDir, BootstrapFile, BootstrapTree, FileClassWire, SubtreeStats};

pub use chan_report::{
    CocomoModel, CocomoParams, CocomoSummary, FileBucket as ReportFileBucket,
    FileStats as ReportFileStats, LanguageStats as ReportLanguageStats, Report, ReportMeta,
    Scope as ReportScope, Totals as ReportTotals,
};

pub use contacts::{
    Contact, EmailAddress, ImportCounts, ImportOpts, ImportOutcome, ImportSummary, Organization,
    PhoneNumber, ProviderKind,
};
pub use dashboard::{DashboardConfig, ScreensaverTheme};
pub use drafts::{DraftInspection, DraftPromoteMode, DraftPromoteReport, DraftRef};
pub use error::{ChanError, Result};
pub use fs_ops::{
    classify, classify_path, FileClass, PathClass, PathKind, PathPermission, WalkFilter,
};
pub use graph::{
    ContactNode, Edge, EdgeKind, GraphView, HeadingRow, LinkTarget, LinkTargetKind, Mention,
    NodeKind, Tag,
};
pub use graph_normalize::{
    normalize_graph_edges, resolve_link_target, GraphNormalization, MentionContactResolution,
    MentionContactResolver,
};
pub use index::{
    BuildOptions, BuildSummary, Chunking, Hit, IndexConfig, IndexStats, Mode as SearchMode,
    SearchAggression, SearchBudget, SearchResult, DEFAULT_MODEL,
};
pub use indexer::{GraphIndexer, DEFAULT_DEBOUNCE_MS};
pub use library::{Library, ResetMode, ResetReport, SweepReport};
pub use metadata_archive::{
    validate_archive_entry_path, ArchiveEntryKind, MetadataArchivePathError, MetadataExportOptions,
    MetadataExportReport, MetadataImportOptions, MetadataImportReport, MetadataManifest,
    MetadataSchema, ScmIdentity,
};
pub use progress::{
    eta_secs_from, progress_fn, NoProgress, ProgressCallback, ProgressEvent, ProgressStage,
};
pub use registry::{KnownWorkspace, Registry, DEFAULT_INDEX_EXCLUDED_DIRS};
pub use teams::{Member, Position, TeamConfig};
pub use trash::{TrashEntry, TRASH_RETENTION_SECS};
pub use vcs::{detect_parent_vcs, detect_workspace_vcs, is_vcs_control_path, VcsKind, VcsParent};
pub use watch::{WatchCallback, WatchEvent, WatchHandle, WatchHealth, WatchHealthState, WatchKind};
pub use workspace::ReconcileReport;
pub use workspace::{
    semantic_write_budget, AtomicWriteKind, AtomicWriteSink, BoundedFileReader, CopyOutcome,
    DirEntry, FileStat, RenameOutcome, ResolvedLink, SearchOpts, TextReadEvent, TreeEntry,
    Workspace, WorkspacePath, WritableFile, BINARY_STREAM_CHUNK_SIZE, BINARY_STREAM_QUEUE_DEPTH,
    BYTES_WRITE_LIMIT, TEXT_READ_CHUNK_SIZE, TEXT_WRITE_LIMIT,
};
pub use workspace_search::{
    EffectiveSearchMode, EffectiveWorkspaceTraversal, WorkspaceContentHit, WorkspaceEntityMatch,
    WorkspaceEntityMatchClass, WorkspaceGraphFileClass, WorkspaceGraphNode, WorkspaceRelationship,
    WorkspaceRelationshipKind, WorkspaceSearchDomain, WorkspaceSearchError,
    WorkspaceSearchIdentity, WorkspaceSearchRequest, WorkspaceSearchResult, WorkspaceSearchStatus,
    WorkspaceSearchTruncation, WorkspaceSearchWarning, WorkspaceSelector, WorkspaceSelectorKind,
    WorkspaceTraversalDirection, WorkspaceTraversalProfile,
};
