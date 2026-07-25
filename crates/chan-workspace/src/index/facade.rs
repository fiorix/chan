// High-level entry point for both the CLI (`chan workspace index`,
// `chan workspace search`) and the in-process server use cases. Composes BM25,
// embeddings, and the vector store. Hybrid retrieval (RRF fusion)
// is gated by the `embeddings` feature; without it the facade
// answers Hybrid / Semantic queries with `ready: false` and a
// BM25-only fallback so the UI can show a "BM25-only on this
// build" hint instead of erroring out.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(feature = "embeddings")]
use std::sync::Once;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::bm25::{Bm25Error, Bm25Index};
use super::chunking;
use super::config::{self, ConfigError, IndexConfig};
#[cfg(feature = "embeddings")]
use super::embeddings::{self, EmbedError, Embedder};
#[cfg(feature = "embeddings")]
use super::fusion;
#[cfg(feature = "embeddings")]
use super::vectors;
use super::vectors::{VectorError, VectorStore};
use crate::error::ChanError;
use crate::fs_ops::{self, IndexScopePolicy, WalkFilter};
use crate::workspace::WorkspaceGeneration;

/// Emit a one-shot `tracing::warn!` when chan-workspace
/// falls back to BM25-only because the BGE embedding model isn't
/// downloaded. The fallback path runs in `write_file` +
/// `flush_embed_batch`; both share the same warning so the user
/// only sees one log line per process lifetime regardless of how
/// many files trigger the fallback (a bulk reindex would
/// otherwise spam the log with hundreds of identical warnings).
///
/// Aligns with the opt-in model-download design: default
/// builds ship without the model bundled; users get working BM25
/// keyword search out of the box; `chan workspace index download-model`
/// upgrades them to hybrid semantic+BM25 retrieval.
#[cfg(feature = "embeddings")]
fn warn_bm25_only_once() {
    static WARNED: Once = Once::new();
    WARNED.call_once(|| {
        tracing::warn!(
            "Embedding model not downloaded; falling back to BM25-only \
             keyword search. Run `chan workspace index download-model` to enable \
             semantic search (or rebuild with `--features embed-model`)."
        );
    });
}

#[derive(Debug, Error)]
pub enum IndexError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Bm25(#[from] Bm25Error),
    #[cfg(feature = "embeddings")]
    #[error(transparent)]
    Embed(#[from] EmbedError),
    #[error(transparent)]
    Vector(#[from] VectorError),
    #[error(transparent)]
    Chan(#[from] ChanError),
    #[error("operation cancelled")]
    Cancelled,
    #[error("unknown embedding model: {0}")]
    UnknownModel(String),
}

/// Which retrieval mode to run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Bm25,
    Semantic,
    Hybrid,
}

impl Mode {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "bm25" => Some(Mode::Bm25),
            "semantic" => Some(Mode::Semantic),
            "hybrid" => Some(Mode::Hybrid),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Mode::Bm25 => "bm25",
            Mode::Semantic => "semantic",
            Mode::Hybrid => "hybrid",
        }
    }
}

/// Unified search hit. Both BM25 and semantic results are converted
/// to this shape before being returned to the CLI / API.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Hit {
    pub path: String,
    pub chunk_id: String,
    pub heading: String,
    pub start_line: u64,
    pub snippet: String,
    pub score: f32,
}

impl From<super::bm25::Hit> for Hit {
    fn from(h: super::bm25::Hit) -> Self {
        Self {
            path: h.path,
            chunk_id: h.chunk_id,
            heading: h.heading,
            start_line: h.start_line,
            snippet: h.snippet,
            score: h.score,
        }
    }
}

impl From<super::vectors::Hit> for Hit {
    fn from(h: super::vectors::Hit) -> Self {
        Self {
            path: h.path,
            chunk_id: h.chunk_id,
            heading: h.heading,
            start_line: h.start_line,
            snippet: h.snippet,
            score: h.score,
        }
    }
}

/// Search-result envelope used by both the CLI and the API.
#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub ready: bool,
    pub mode: &'static str,
    pub hits: Vec<Hit>,
}

/// The big handle. One per workspace per process.
pub struct Index {
    workspace_root: PathBuf,
    index_dir: PathBuf,
    /// Persisted index config. Behind a Mutex because `build_all`
    /// (which only holds `&self` through Workspace's `Arc<Index>`) needs
    /// to stamp `vectors_model` / `vectors_dim` after a successful
    /// embed pass. Reads in hot paths take a single lock per build,
    /// not per chunk: each pass snapshots the config once at the top.
    config: Mutex<IndexConfig>,
    bm25: Bm25Index,
    vectors: VectorStore,
    /// Lazily loaded: opening the embedder mmaps the safetensors
    /// weights and warms the device, and we don't want
    /// `chan workspace search --mode bm25` to pay that cost. The Mutex
    /// serializes first-init so two threads racing here can't both
    /// download the model from HuggingFace; once the Arc is
    /// populated, every subsequent call clones it cheaply.
    #[cfg(feature = "embeddings")]
    embedder: Mutex<Option<Arc<Embedder>>>,
    /// Directory-name blocklist applied by `build_all`'s tree walk.
    /// Workspace forwards the Library filter here before each reindex
    /// so search and graph rebuilds use the same exclusions.
    scope_policy: Mutex<Arc<IndexScopePolicy>>,
    /// Monotonic vector-store generation, bumped by `clear_vectors` (a model
    /// switch or a semantic opt-out). `build_all` and the per-file `write_file`
    /// snapshot it and treat any vector write / stamp as void if it moved, so a
    /// disable that races an in-flight embed converges to zero vectors instead
    /// of leaving orphan shards and a stale `vectors_model` stamp behind.
    vectors_epoch: AtomicU64,
}

impl std::fmt::Debug for Index {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut d = f.debug_struct("Index");
        let model = self
            .config
            .lock()
            .map(|c| c.model.clone())
            .unwrap_or_default();
        d.field("workspace_root", &self.workspace_root)
            .field("index_dir", &self.index_dir)
            .field("model", &model);
        #[cfg(feature = "embeddings")]
        d.field(
            "embedder_loaded",
            &self.embedder.lock().map(|g| g.is_some()).unwrap_or(false),
        );
        d.finish()
    }
}

impl Index {
    /// Open (or create) the index for `workspace_root`, with storage
    /// rooted at `index_dir`. The two directories are decoupled:
    /// `workspace_root` is where the markdown lives (read-only for
    /// the indexer), `index_dir` is where tantivy + vectors live
    /// (per-workspace, in the global cache; resolved by
    /// `crate::paths::workspace_paths`). Tests pass a tempdir for both.
    pub fn open(workspace_root: &Path, index_dir: &Path) -> Result<Self, IndexError> {
        std::fs::create_dir_all(index_dir)?;
        let mut config = config::load(index_dir)?;
        if !config::config_path(index_dir).exists() {
            config::save(index_dir, &config)?;
        }
        // Schema-version drift forces a clean rebuild. We do this by
        // wiping the on-disk dir before opening tantivy; the config
        // itself is rewritten with the current SCHEMA_VERSION.
        if config.schema_version != config::SCHEMA_VERSION {
            wipe_index_dir(index_dir)?;
            config.schema_version = config::SCHEMA_VERSION;
            config.vectors_model = None;
            config.vectors_dim = None;
            config::save(index_dir, &config)?;
        }
        // Model drift: vectors on disk were produced by a different
        // model than what's now configured. The two are not
        // interchangeable (different semantic space, potentially
        // different dim), and mixing them would silently degrade
        // retrieval. Wipe `embeddings/` (BM25 is model-independent
        // so it stays) and clear the tracking fields; the next
        // reindex will repopulate against the new model.
        if let Some(prior) = config.vectors_model.as_deref() {
            if prior != config.model {
                tracing::warn!(
                    prior = %prior,
                    target = %config.model,
                    "index model changed since last embed; wiping embeddings/",
                );
                wipe_vectors_dir(index_dir)?;
                config.vectors_model = None;
                config.vectors_dim = None;
                config::save(index_dir, &config)?;
            }
        }
        let bm25 = Bm25Index::open(index_dir)?;
        let vectors = VectorStore::open(index_dir)?;
        Ok(Self {
            workspace_root: workspace_root.to_path_buf(),
            index_dir: index_dir.to_path_buf(),
            config: Mutex::new(config),
            bm25,
            vectors,
            #[cfg(feature = "embeddings")]
            embedder: Mutex::new(None),
            scope_policy: Mutex::new(Arc::new(IndexScopePolicy::new(
                workspace_root.to_path_buf(),
                WorkspaceGeneration::INITIAL,
                WalkFilter::default(),
            )?)),
            vectors_epoch: AtomicU64::new(0),
        })
    }

    /// Replace the directory-name blocklist for the next `build_all`.
    /// Subsequent walks consult the new filter; an in-flight build
    /// keeps its snapshot (the filter is sampled once at the top of
    /// `build_all`). Workspace calls this from `reindex_with` before
    /// kicking off the build.
    pub fn set_scope_policy(&self, policy: Arc<IndexScopePolicy>) {
        *self.scope_policy.lock().unwrap() = policy;
    }

    /// Re-open after wiping `index_dir`. Intended for `--rebuild`.
    pub fn rebuild(workspace_root: &Path, index_dir: &Path) -> Result<Self, IndexError> {
        wipe_index_dir(index_dir)?;
        Self::open(workspace_root, index_dir)
    }

    /// Snapshot of the persisted config. Callers get a clone so the
    /// lock isn't held across their use; the config is small.
    pub fn config(&self) -> IndexConfig {
        self.config.lock().unwrap().clone()
    }

    /// Sorted workspace-relative paths currently known to the persisted
    /// full-text index.
    pub fn known_paths(&self) -> Result<Vec<String>, IndexError> {
        Ok(self.bm25.known_paths()?)
    }

    /// Replace the per-workspace directory blocklist additions. Idempotent on
    /// no-change. Persists the new set to `config.toml`; the effective walk
    /// filter is re-derived on the next reindex (union with the global
    /// baseline), so callers trigger a rebuild after this to re-walk.
    pub fn set_excluded_dirs(&self, dirs: Vec<String>) -> Result<(), IndexError> {
        let to_save = {
            let mut cfg = self.config.lock().unwrap();
            if cfg.excluded_dirs == dirs {
                return Ok(());
            }
            cfg.excluded_dirs = dirs;
            cfg.clone()
        };
        config::save(&self.index_dir, &to_save)?;
        Ok(())
    }

    /// Persist a (possibly mutated) config. Used by the CLI when
    /// the user passes `--model X`. Switching model invalidates the
    /// existing vectors (different dim / different semantics) so
    /// we wipe the vector dir; BM25 is unaffected.
    pub fn set_model(&self, model: String) -> Result<(), IndexError> {
        let _ = config::embedding_model(&model)
            .ok_or_else(|| IndexError::UnknownModel(model.clone()))?;
        let to_save = {
            let mut cfg = self.config.lock().unwrap();
            if model == cfg.model {
                return Ok(());
            }
            cfg.model = model;
            cfg.clone()
        };
        config::save(&self.index_dir, &to_save)?;
        // The vectors on disk were produced by the previous model, so wipe
        // them. `clear_vectors` also clears the `vectors_*` stamp so the next
        // Index::open's model-mismatch check (and any human reading the TOML)
        // cannot conclude we trust the empty store.
        self.clear_vectors()
    }

    /// Bin every embedding shard, drop the loaded embedder, and clear the
    /// on-disk `vectors_*` stamp, leaving BM25 untouched. Shared by `set_model`
    /// (a model switch invalidates the vectors) and the semantic-search disable
    /// path (opting out bins the vectors so a later re-enable rebuilds from
    /// scratch). Idempotent: wiping an already-empty store is a no-op beyond
    /// rewriting the (already-cleared) stamp.
    pub fn clear_vectors(&self) -> Result<(), IndexError> {
        // Bump the epoch before touching anything so a concurrent `build_all`
        // or per-file `write_file` that started under the old epoch treats every
        // vector write it issues from here on as void. This is what makes a
        // disable that races an in-flight embed converge to zero vectors rather
        // than leaving orphan shards behind.
        self.vectors_epoch.fetch_add(1, Ordering::SeqCst);
        #[cfg(feature = "embeddings")]
        {
            *self.embedder.lock().unwrap() = None;
        }
        for rel in self.vectors.known_paths() {
            self.vectors.delete_file(&rel)?;
        }
        wipe_vectors_dir(&self.index_dir)?;
        std::fs::create_dir_all(self.index_dir.join("embeddings"))?;
        // Clear the on-disk stamp LAST. If a wipe above fails we bail before
        // reaching here, leaving `vectors_model` set rather than a
        // `vectors_model=None` + trusted-orphan-shards state. For the
        // model-switch caller (`set_model`) that leftover self-heals: it already
        // persisted the NEW model, so `Index::open`'s mismatch check re-wipes.
        // For the opt-out caller the model is unchanged, so a failed wipe is
        // surfaced to the caller (logged, best-effort) rather than self-healed,
        // an accepted filesystem-fault residual, not a normal-operation path.
        let to_save = {
            let mut cfg = self.config.lock().unwrap();
            cfg.vectors_model = None;
            cfg.vectors_dim = None;
            cfg.clone()
        };
        config::save(&self.index_dir, &to_save)?;
        Ok(())
    }

    /// Current vector-store generation. `Workspace::reindex_with_aggression`
    /// and `index_file_inner` snapshot this BEFORE reading `semantic_enabled`
    /// and thread it back into `build_all` / `index_one`, so a disable that
    /// flips the flag then bumps this (see `clear_vectors`) is observed even by
    /// a build / save that read a stale `true` flag.
    pub fn vectors_epoch(&self) -> u64 {
        self.vectors_epoch.load(Ordering::SeqCst)
    }

    /// Get-or-init the embedder. Errors propagate (e.g. unknown
    /// model id, model not downloaded, candle device init). The
    /// init step holds the Mutex across `Embedder::open` so
    /// concurrent first-callers serialize and only one load
    /// happens. Once populated, every call returns a cheap Arc
    /// clone and never enters the slow path again.
    ///
    /// Runtime resolver: `resolve_model` is called
    /// before `Embedder::open`. When the model isn't present on
    /// disk (`--features embed-model` off AND no prior download),
    /// the caller receives a structured `ModelNotDownloaded` error
    /// instead of `Embedder::open` triggering an hf-hub network
    /// fetch. When the model IS on disk (either bundled-and-seeded
    /// or pre-downloaded via the CLI / API), `resolve_model`
    /// returns the repo dir and `Embedder::open` finds the same
    /// path through hf-hub's cache lookup with no network.
    #[cfg(feature = "embeddings")]
    fn embedder(&self) -> Result<Arc<Embedder>, IndexError> {
        let mut guard = self.embedder.lock().unwrap();
        if let Some(e) = guard.as_ref() {
            return Ok(Arc::clone(e));
        }
        let model_id = self.config.lock().unwrap().model.clone();
        let _ = embeddings::resolve_model(&model_id)?;
        let cache_dir = embeddings::global_models_dir();
        let e = Arc::new(Embedder::open(&model_id, &cache_dir)?);
        *guard = Some(Arc::clone(&e));
        Ok(e)
    }

    /// Classify an embed-step error as "the model
    /// isn't downloaded, fall back to BM25-only" vs "something
    /// else, propagate". Single-shot `tracing::warn!` so the log
    /// doesn't spam on every per-file embed in a bulk reindex.
    ///
    /// Returns `Ok(())` for the fallback path (caller skips the
    /// vector commit + continues to BM25); returns `Err(e)` for
    /// any other error shape (caller propagates as before).
    #[cfg(feature = "embeddings")]
    fn handle_embed_load_error(e: IndexError) -> Result<(), IndexError> {
        match e {
            IndexError::Embed(EmbedError::ModelNotDownloaded { .. }) => {
                warn_bm25_only_once();
                Ok(())
            }
            other => Err(other),
        }
    }

    /// File-count threshold: a cold full build over this many
    /// indexable files skips the embed pass (BM25-only). Tunable;
    /// 2000 is the headline cap. Typical notes workspaces sit well
    /// under it; large source trees (this repo is ~4k files) sit above
    /// and skip the multi-minute CPU embed.
    #[cfg(feature = "embeddings")]
    const EMBED_FILE_CAP: usize = 2000;

    /// Whether a build over `file_count` indexable files skips
    /// embeddings. Pure + standalone so the cap policy is unit-tested
    /// without a multi-thousand-file fixture. `include_vectors == false`
    /// (the BM25-only build) is never "capped" - it just was not
    /// embedding to begin with.
    #[cfg(feature = "embeddings")]
    fn embeddings_capped_for(include_vectors: bool, file_count: usize) -> bool {
        include_vectors && file_count > Self::EMBED_FILE_CAP
    }

    /// Walk the workspace and re-index everything from scratch. If
    /// `cancel` is set to true mid-build, returns `Cancelled` without
    /// calling `commit()` so tantivy discards every pending write
    /// queued in this run; the on-disk index is left as it was at
    /// the start.
    ///
    /// A cold full build SKIPS the embedding
    /// pass when the workspace has more than `EMBED_FILE_CAP` indexable
    /// files. The embed forward-pass is O(chunks) on CPU and dominates
    /// wall-clock; on a multi-thousand-file source tree it runs for many
    /// minutes. BM25 stays authoritative (search works), and per-file
    /// edits through `index_one` still embed, so individual notes keep
    /// semantic vectors. The cap is on FILE COUNT, not chunks: chunk
    /// totals are only known per-file during the drain, so the file
    /// count is the only signal available before the build starts.
    pub fn build_all(
        &self,
        opts: BuildOptions,
        progress: &dyn crate::progress::ProgressCallback,
        cancel: Option<&AtomicBool>,
    ) -> Result<BuildSummary, IndexError> {
        use crate::progress::{ProgressEvent, ProgressStage};
        use std::sync::atomic::AtomicUsize;
        // Snapshot the config once. The build can run for minutes;
        // a concurrent `set_model` would otherwise see-saw what
        // every chunk gets stamped with, and the post-build stamp
        // would race against in-flight reads.
        let cfg_at_start = self.config.lock().unwrap().clone();
        // Gated: in `--no-default-features` builds (no embeddings),
        // `model_at_start` has no consumer and the unconditional
        // declaration trips `unused_variables` under `-D warnings`.
        #[cfg(feature = "embeddings")]
        let model_at_start = cfg_at_start.model.clone();
        let policy = Arc::clone(&self.scope_policy.lock().unwrap());
        let files = list_indexable(&self.workspace_root, &policy)?;
        let total = files.len();
        let mut indexed = 0usize;
        let mut chunks_total = 0usize;
        let mut errors: Vec<(String, IndexError)> = Vec::new();
        // Files whose embed phase was skipped because the on-disk
        // shard's `(model, body_hash)` already matched a fresh
        // re-chunk. Surfaced in `BuildSummary.embeds_reused` so the
        // CLI and tests can observe partial-rebuild resumption.
        #[cfg(feature = "embeddings")]
        let mut embeds_reused = 0usize;

        // Embedding throughput is dominated by per-call dispatch
        // and kernel-launch overhead on the GPU side. Per-file
        // embed calls on a workspace of small markdown files (typical:
        // ~30 chunks per file) leave that overhead unamortized and
        // run an order of magnitude slower than the hardware can
        // do. Accumulate chunks across files and flush in
        // `EMBED_BATCH_CHUNKS`-sized groups so each forward pass
        // gets enough work to fill the device.
        // Skip the embed pass for an oversized cold full build.
        // do_vectors gates every embed branch below, so this single line
        // turns the build BM25-only without touching the drain loop.
        #[cfg(feature = "embeddings")]
        let embeddings_capped =
            !opts.ignore_embed_cap && Self::embeddings_capped_for(opts.include_vectors, total);
        #[cfg(feature = "embeddings")]
        let do_vectors = opts.include_vectors && !embeddings_capped;
        // Guard epoch. A `clear_vectors` (opt-out or model switch) that lands
        // while this build runs bumps it; the flush and stamp steps below check
        // it so a racing disable leaves zero vectors rather than orphan shards +
        // a stale stamp. Prefer the caller's snapshot, taken BEFORE it read
        // `semantic_enabled`, so a disable that finished during the flag read /
        // file walk is still caught; fall back to a fresh load for callers
        // (tests) that pass none.
        #[cfg(feature = "embeddings")]
        let build_epoch = opts
            .guard_epoch
            .unwrap_or_else(|| self.vectors_epoch.load(Ordering::SeqCst));
        #[cfg(feature = "embeddings")]
        if embeddings_capped {
            tracing::info!(
                files = total,
                cap = Self::EMBED_FILE_CAP,
                "skipping embeddings for this cold full build (workspace \
                 exceeds the file cap); BM25 stays authoritative and per-file \
                 edits still embed"
            );
        }
        #[cfg(not(feature = "embeddings"))]
        let _ = opts.include_vectors;
        #[cfg(feature = "embeddings")]
        let mut pending: Vec<(String, Vec<chunking::Chunk>)> = Vec::new();
        #[cfg(feature = "embeddings")]
        let mut pending_chunks: usize = 0;

        // Parallel read + chunk pipeline. Workers pull file indices
        // from `next`, read the file off disk, parse it into chunks,
        // and ship the result over `tx`. The main thread drains `rx`
        // and is the only thing that touches the BM25 writer and the
        // embed batcher, so writer-mutex contention and embed-batch
        // ordering stay simple. Bounded channel (workers * 4) caps
        // resident chunk memory: roughly that many parsed files in
        // flight at once.
        //
        // Worker and batch budget come from `SearchAggression`.
        // Balanced preserves the historical behavior:
        // `available_parallelism - 2`, clamped to [1, 6].
        let budget = opts.aggression.budget();
        let worker_count = budget.worker_count;
        let next = AtomicUsize::new(0);
        let (tx, rx) = std::sync::mpsc::sync_channel::<WorkerOut>(budget.queue_bound);
        let chunking_cfg = cfg_at_start.chunking.clone();
        let workspace_root = &self.workspace_root;
        let files_ref = &files;

        let started = std::time::Instant::now();
        let drain_result: Result<(), IndexError> = std::thread::scope(|s| {
            for _ in 0..worker_count {
                let tx = tx.clone();
                let next = &next;
                let chunking_cfg = chunking_cfg.clone();
                s.spawn(move || loop {
                    // Bug 7: yield the read slot when the descriptor
                    // table is tight so a concurrent autosave or
                    // terminal spawn keeps the headroom it needs. The
                    // open-time worker count was sized when fds were
                    // free; this re-checks the LIVE count between
                    // files, the piece the one-shot budget can't do.
                    // Cancellation aborts the wait promptly.
                    crate::fd_budget::pace_reindex_worker(cancel);
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= files_ref.len() {
                        break;
                    }
                    if let Some(c) = cancel {
                        if c.load(Ordering::Relaxed) {
                            break;
                        }
                    }
                    let rel = files_ref[i].clone();
                    let abs = workspace_root.join(&rel);
                    let item = match std::fs::read_to_string(&abs) {
                        Ok(text) => WorkerOut {
                            rel,
                            result: Ok(chunking::chunk(&text, &chunking_cfg)),
                        },
                        Err(e) => WorkerOut {
                            rel,
                            result: Err(e),
                        },
                    };
                    if tx.send(item).is_err() {
                        break;
                    }
                });
            }
            drop(tx);

            // Drain results. Order is non-deterministic across files;
            // `seen` is a monotonic count of completions so progress
            // ticks march forward even when results land out of order.
            for (seen, msg) in (0_u64..).zip(rx) {
                if let Some(c) = cancel {
                    if c.load(Ordering::Relaxed) {
                        return Err(IndexError::Cancelled);
                    }
                }
                progress.on_progress(ProgressEvent {
                    stage: ProgressStage::IndexFile,
                    current: seen,
                    total: total as u64,
                    label: Some(msg.rel.clone()),
                    eta_secs: crate::progress::eta_secs_from(started, seen, total as u64),
                });
                let chunks = match msg.result {
                    Ok(c) => c,
                    Err(e) => {
                        errors.push((msg.rel, e.into()));
                        continue;
                    }
                };
                if let Err(e) = self.bm25.index_chunks(&msg.rel, &chunks) {
                    errors.push((msg.rel, e.into()));
                    continue;
                }
                indexed += 1;
                chunks_total += chunks.len();

                #[cfg(feature = "embeddings")]
                if do_vectors {
                    if chunks.is_empty() {
                        // Stale-vector cleanup for files that became
                        // empty since the last build. `replace_file`
                        // with an empty vec deletes the on-disk shard.
                        if let Err(e) =
                            self.vectors
                                .replace_file(&msg.rel, &model_at_start, 0, vec![])
                        {
                            errors.push((msg.rel, e.into()));
                        }
                        continue;
                    }
                    // Checkpoint skip: if the on-disk shard already
                    // carries the same (model, body_hash) tuple a
                    // fresh embedding would stamp, the vectors are
                    // still current. Don't queue the file for embed.
                    // Saves the dominant cost (forward pass through
                    // the embedder) on a partial-rebuild resume. The
                    // shard stays put; BM25 below still re-indexes
                    // the file unconditionally because BM25 has no
                    // partial-state preservation across runs.
                    let fresh_hash = vectors::body_hash_of_chunks(&chunks);
                    if let Some((shard_model, shard_hash)) = self.vectors.shard_signature(&msg.rel)
                    {
                        if shard_model == model_at_start && shard_hash == fresh_hash {
                            embeds_reused += 1;
                            continue;
                        }
                    }
                    pending_chunks += chunks.len();
                    let rel_for_label = msg.rel.clone();
                    pending.push((msg.rel, chunks));
                    if pending_chunks >= budget.embed_batch_chunks {
                        // Commit + reload BM25 BEFORE the (slow, CPU-bound)
                        // embed forward pass. The embed flush can run for
                        // minutes on a large workspace; without this commit
                        // BM25 stays invisible to search the whole time and
                        // the server (which reports BM25-ready at the first
                        // EmbedBatch so preflight unlocks) would answer
                        // queries with an empty index. Committing here makes
                        // every file indexed so far searchable, and frees the
                        // BM25 writer so a concurrent draft edit's index_one
                        // is not starved behind the embed pass. Embeddings
                        // remain a background refinement (bm25 -> hybrid once
                        // vectors land). Emit the EmbedBatch progress event
                        // AFTER the commit so the status snapshot reads the
                        // freshly-committed doc count (not a stale zero).
                        self.bm25.commit()?;
                        progress.on_progress(ProgressEvent {
                            stage: ProgressStage::EmbedBatch,
                            current: pending_chunks as u64,
                            total: budget.embed_batch_chunks as u64,
                            label: Some(format!("files={} last={rel_for_label}", pending.len())),
                            // EmbedBatch fires once per buffer flush, not
                            // per chunk, so a rate-based ETA across batches
                            // would track GPU step time and not give the UI
                            // anything actionable. Leave it to the
                            // IndexFile ticks to workspace the bar.
                            eta_secs: None,
                        });
                        match self.flush_embed_batch(
                            &mut pending,
                            cancel,
                            &model_at_start,
                            build_epoch,
                        ) {
                            Ok(errs) => errors.extend(errs),
                            Err(IndexError::Cancelled) => return Err(IndexError::Cancelled),
                            Err(e) => return Err(e),
                        }
                        pending_chunks = 0;
                    }
                }
                #[cfg(not(feature = "embeddings"))]
                {
                    let _ = msg.rel;
                }
            }
            Ok(())
        });
        drain_result?;

        // Tail flush for the leftover < EMBED_BATCH_CHUNKS group.
        #[cfg(feature = "embeddings")]
        if do_vectors && !pending.is_empty() {
            if let Some(c) = cancel {
                if c.load(Ordering::Relaxed) {
                    return Err(IndexError::Cancelled);
                }
            }
            let last = pending.last().map(|(r, _)| r.clone()).unwrap_or_default();
            // By the tail flush the drain loop has BM25-indexed every file;
            // commit so the FULL BM25 index is searchable before the final
            // (slow) embed batch runs (same rationale as the in-loop commit
            // above), and emit the progress event after the commit so the
            // status reads the final committed doc count.
            self.bm25.commit()?;
            progress.on_progress(ProgressEvent {
                stage: ProgressStage::EmbedBatch,
                current: pending_chunks as u64,
                total: budget.embed_batch_chunks as u64,
                label: Some(format!("tail files={} last={last}", pending.len())),
                eta_secs: None,
            });
            match self.flush_embed_batch(&mut pending, cancel, &model_at_start, build_epoch) {
                Ok(errs) => errors.extend(errs),
                Err(IndexError::Cancelled) => return Err(IndexError::Cancelled),
                Err(e) => return Err(e),
            }
        }

        if let Some(c) = cancel {
            if c.load(Ordering::Relaxed) {
                return Err(IndexError::Cancelled);
            }
        }
        // Drop vector shards for paths that survived a previous
        // build but are no longer on disk (file deleted while the
        // process was down, or a forget that crashed between vector
        // delete and BM25 commit). After this pass the two backends
        // converge on `files` as the source of truth. Errors here
        // are non-fatal: an orphan shard wastes disk and may surface
        // in semantic search as a hit pointing at a missing file,
        // but the next reindex will retry the cleanup.
        let visited: std::collections::HashSet<&str> = files.iter().map(String::as_str).collect();
        #[cfg(feature = "embeddings")]
        if do_vectors {
            for rel in self.vectors.known_paths() {
                if !visited.contains(rel.as_str()) {
                    if let Err(e) = self.vectors.delete_file(&rel) {
                        tracing::warn!(rel = %rel, ?e, "vector shard cleanup failed");
                    }
                }
            }
        }
        // BM25 symmetric cleanup: any path the prior commit indexed
        // that's not in the current `files` list (deleted, renamed,
        // moved into a now-filtered subtree) leaks its document
        // forever without this step. We batch the deletes here and
        // let the single `commit()` below pack them with the new
        // writes so the index never goes through an empty state.
        match self.bm25.known_paths() {
            Ok(prior) => {
                for rel in prior {
                    if !visited.contains(rel.as_str()) {
                        if let Err(e) = self.bm25.delete_file(&rel) {
                            tracing::warn!(rel = %rel, ?e, "bm25 stale-doc cleanup failed");
                        }
                    }
                }
            }
            Err(e) => {
                // Enumeration failure is non-fatal: the build still
                // produces correct entries for live files, only the
                // orphan cleanup is skipped this pass.
                tracing::warn!(
                    ?e,
                    "bm25 known_paths enumeration failed; skipping stale cleanup"
                );
            }
        }
        self.bm25.commit()?;
        // Stamp "what's on disk" so the next Index::open's model
        // mismatch check has something to compare against. We only
        // do this when vectors were configured for this build; a
        // BM25-only build (no `embeddings` feature, or zero
        // indexable files) leaves the tracking fields alone so a
        // subsequent vector build sets them honestly.
        //
        // Dim is read from the embedder when at least one chunk was
        // embedded this run; if nothing was embedded (empty workspace,
        // every file produced zero chunks) we leave vectors_dim
        // unchanged and stamp vectors_model anyway, because an
        // empty vector store is trivially consistent with the
        // current model. The dim will be filled in on the next
        // build that actually produces vectors.
        #[cfg(feature = "embeddings")]
        if do_vectors {
            if self.vectors_epoch.load(Ordering::SeqCst) == build_epoch {
                let to_save = {
                    let mut cfg = self.config.lock().unwrap();
                    cfg.vectors_model = Some(model_at_start.clone());
                    if let Some(e) = self.embedder.lock().unwrap().as_ref() {
                        cfg.vectors_dim = Some(e.dim() as u32);
                    }
                    cfg.clone()
                };
                if let Err(e) = config::save(&self.index_dir, &to_save) {
                    // Non-fatal: BM25 + tantivy commits already
                    // succeeded. A missed stamp means the next open
                    // sees vectors_model=None (or the previous value)
                    // and may decide to wipe; the search still works.
                    tracing::warn!(?e, "failed to persist vectors_model stamp after build");
                }
            } else {
                // A clear_vectors (semantic opt-out or model switch) landed
                // while this build was embedding. Any shard we wrote after it is
                // an orphan, so drop every vector we produced and skip the
                // stamp: the disabled state must hold zero vectors, and
                // clear_vectors already cleared `vectors_model` so config stays
                // honest. Best-effort. Recreate the (now-removed) dir so the
                // post-condition matches clear_vectors ("wiped but present").
                for rel in self.vectors.known_paths() {
                    let _ = self.vectors.delete_file(&rel);
                }
                let _ = wipe_vectors_dir(&self.index_dir);
                let _ = std::fs::create_dir_all(self.index_dir.join("embeddings"));
                tracing::info!(
                    "build: vector store cleared mid-build; dropped orphan shards and skipped stamp"
                );
            }
        }
        #[cfg(feature = "embeddings")]
        let embeds_reused_out = embeds_reused;
        #[cfg(not(feature = "embeddings"))]
        let embeds_reused_out = 0usize;
        Ok(BuildSummary {
            files: total,
            indexed,
            chunks: chunks_total,
            embeds_reused: embeds_reused_out,
            errors,
        })
    }

    /// Embed every pending chunk in one call, then split the result
    /// back per file and write each file's vectors. Drains `pending`.
    /// On batch failure, falls back to per-file embedding so errors
    /// can be attributed to the offending file rather than poisoning
    /// the whole batch. Returns `Cancelled` (without writing partial
    /// vectors) if `cancel` flips during one of the inner sub-batches.
    #[cfg(feature = "embeddings")]
    fn flush_embed_batch(
        &self,
        pending: &mut Vec<(String, Vec<chunking::Chunk>)>,
        cancel: Option<&AtomicBool>,
        model: &str,
        build_epoch: u64,
    ) -> Result<Vec<(String, IndexError)>, IndexError> {
        let mut errors = Vec::new();
        if pending.is_empty() {
            return Ok(errors);
        }
        // A clear_vectors landed since this build started (opt-out or model
        // switch): stop embedding. These chunks are already BM25-indexed and
        // committed, so dropping the pending batch just avoids burning CPU on
        // vectors the disabled state would throw away.
        if self.vectors_epoch.load(Ordering::SeqCst) != build_epoch {
            pending.drain(..);
            return Ok(errors);
        }
        // Discriminator on the embed-step error.
        // ModelNotDownloaded → log once, drop the pending batch
        // (vectors get skipped) but don't poison every queued
        // file with a per-file error in `errors`. The bulk reindex
        // path already commits BM25 separately + earlier in the
        // loop (line ~468 self.bm25.index_chunks), so dropping
        // the vector commit leaves the BM25 index correct +
        // searchable. summary.errors stays clean, matching the
        // default-build invariant.
        let embedder = match self.embedder() {
            Ok(e) => e,
            Err(IndexError::Embed(EmbedError::ModelNotDownloaded { .. })) => {
                warn_bm25_only_once();
                pending.drain(..);
                return Ok(errors);
            }
            Err(e) => {
                let msg = e.to_string();
                for (rel, _) in pending.drain(..) {
                    errors.push((rel, IndexError::Embed(EmbedError::Candle(msg.clone()))));
                }
                return Ok(errors);
            }
        };
        let dim = embedder.dim();
        let bodies: Vec<&str> = pending
            .iter()
            .flat_map(|(_, chunks)| chunks.iter().map(|c| c.body.as_str()))
            .collect();
        let raw = match embedder.embed_documents_cancelable(&bodies, cancel) {
            Ok(v) => v,
            Err(EmbedError::Cancelled) => return Err(IndexError::Cancelled),
            Err(_) => {
                // Per-file fallback so a single bad file doesn't
                // discard the rest of the batch's vectors.
                for (rel, chunks) in pending.drain(..) {
                    if let Err(e) = self.embed_one_file(&rel, &chunks, dim, model) {
                        errors.push((rel, e));
                    }
                }
                return Ok(errors);
            }
        };
        let mut cursor = 0usize;
        for (rel, chunks) in pending.drain(..) {
            let n = chunks.len();
            let slice = raw[cursor..cursor + n].to_vec();
            cursor += n;
            let embedded = vectors::pair(&chunks, slice);
            if let Err(e) = self.vectors.replace_file(&rel, model, dim, embedded) {
                errors.push((rel, e.into()));
            }
        }
        Ok(errors)
    }

    #[cfg(feature = "embeddings")]
    fn embed_one_file(
        &self,
        rel: &str,
        chunks: &[chunking::Chunk],
        dim: usize,
        model: &str,
    ) -> Result<(), IndexError> {
        let bodies: Vec<&str> = chunks.iter().map(|c| c.body.as_str()).collect();
        let embedder = self.embedder()?;
        let raw = embedder.embed_documents(&bodies)?;
        let embedded = vectors::pair(chunks, raw);
        self.vectors.replace_file(rel, model, dim, embedded)?;
        Ok(())
    }

    /// One-file write path used by both `build_all` and `index_one`.
    /// Chunks once, persists vectors first, then hands the same
    /// chunks to BM25. Caller commits BM25; that commit is the
    /// durable boundary for the pair. A crash between vector
    /// persist and BM25 commit drops the BM25 write entirely
    /// (tantivy never persisted it) and leaves the vector shard on
    /// disk, which the next reindex overwrites. The opposite
    /// ordering would let a committed BM25 row reference a chunk
    /// whose vector never reached disk: silent semantic-search
    /// drift that the user only notices when results disappear.
    fn write_file(
        &self,
        rel_path: &str,
        text: &str,
        include_vectors: bool,
        guard_epoch: u64,
    ) -> Result<usize, IndexError> {
        // Snapshot the parts of config we need so a concurrent
        // `set_model` cannot rewrite the model id mid-call (which
        // would let us write a vector shard stamped with one
        // model id but produced by the embedder of another).
        let (model, chunking_cfg) = {
            let cfg = self.config.lock().unwrap();
            (cfg.model.clone(), cfg.chunking.clone())
        };
        let chunks = chunking::chunk(text, &chunking_cfg);
        // include_vectors is the caller's intent. When the binary
        // is built without `embeddings`, we never produce vectors
        // regardless. BM25-only is a working subset.
        #[cfg(not(feature = "embeddings"))]
        let _ = (include_vectors, guard_epoch);
        #[cfg(feature = "embeddings")]
        {
            if include_vectors {
                if chunks.is_empty() {
                    self.vectors.replace_file(rel_path, &model, 0, vec![])?;
                } else {
                    // Discriminator on the embed-step
                    // error. When the BGE model isn't downloaded
                    // (default-build install + no prior download),
                    // log once + skip the vector commit + fall
                    // through to BM25. Any other error propagates.
                    match self.embedder() {
                        Ok(embedder) => {
                            let dim = embedder.dim();
                            let bodies: Vec<&str> =
                                chunks.iter().map(|c| c.body.as_str()).collect();
                            let vectors_raw = embedder.embed_documents(&bodies)?;
                            let embedded = vectors::pair(&chunks, vectors_raw);
                            self.vectors.replace_file(rel_path, &model, dim, embedded)?;
                        }
                        Err(e) => Self::handle_embed_load_error(e)?,
                    }
                }
                // If a clear_vectors (semantic opt-out) landed since the caller
                // snapshotted `guard_epoch` (before it read the opt-in flag),
                // the shard we just wrote is an orphan. Undo it so the disabled
                // state holds zero vectors. clear_vectors wipes the whole dir, so
                // a missing shard here is fine (delete_file tolerates NotFound).
                if self.vectors_epoch.load(Ordering::SeqCst) != guard_epoch {
                    let _ = self.vectors.delete_file(rel_path);
                }
            }
        }
        #[cfg(not(feature = "embeddings"))]
        let _ = model;
        self.bm25.index_file(rel_path, text, &chunking_cfg)?;
        Ok(chunks.len())
    }

    /// Re-index a single file (incremental). Used by the watcher
    /// hook. Caller supplies both `rel_path` and `text` so the read
    /// goes through the Workspace sandbox (path safety, special-file
    /// refusal, editable-text gate). The index never opens user
    /// files directly outside `build_all`'s controlled walk.
    ///
    /// `include_vectors` carries the workspace's `semantic_enabled` opt-in: a
    /// `false` save writes BM25 only and produces no vector shard. `guard_epoch`
    /// is the vector generation the caller sampled BEFORE reading that flag (see
    /// `vectors_epoch`), so a disable racing this save is reconciled away.
    pub fn index_one(
        &self,
        rel_path: &str,
        text: &str,
        include_vectors: bool,
        guard_epoch: u64,
    ) -> Result<usize, IndexError> {
        let n = self.write_file(rel_path, text, include_vectors, guard_epoch)?;
        self.bm25.commit()?;
        Ok(n)
    }

    /// Drop a file from both indexes (e.g. after the file is
    /// removed on disk). Vectors first, then BM25 + commit. A
    /// crash between the two leaves the vector shard removed but
    /// BM25 still claiming the row; the next BM25 search keeps
    /// working and the next reindex repopulates vectors. The
    /// opposite ordering would commit a BM25 deletion while the
    /// vector shard outlived it, so semantic search would surface
    /// a hit pointing at a path BM25 (and the editor) considers
    /// gone.
    pub fn forget(&self, rel_path: &str) -> Result<(), IndexError> {
        self.vectors.delete_file(rel_path)?;
        self.bm25.delete_file(rel_path)?;
        self.bm25.commit()?;
        Ok(())
    }

    /// Batched `forget` for a directory delete: queue vector + BM25
    /// deletes for every path, commit BM25 once at the end. Same
    /// ordering invariants as `forget` (vectors first per path), so
    /// a crash mid-batch leaves orphan vector shards at worst; the
    /// next reindex's orphan-cleanup pass reclaims them. Empty input
    /// is a no-op (no commit, no churn on tantivy's segments).
    pub fn forget_many<I, S>(&self, paths: I) -> Result<(), IndexError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut any = false;
        for p in paths {
            let p = p.as_ref();
            self.vectors.delete_file(p)?;
            self.bm25.delete_file(p)?;
            any = true;
        }
        if any {
            self.bm25.commit()?;
        }
        Ok(())
    }

    /// Run a query.
    pub fn search(
        &self,
        query: &str,
        mode: Mode,
        limit: usize,
    ) -> Result<SearchResult, IndexError> {
        match mode {
            Mode::Bm25 => Ok(SearchResult {
                ready: true,
                mode: mode.label(),
                hits: self
                    .bm25
                    .search(query, limit)?
                    .into_iter()
                    .map(Into::into)
                    .collect(),
            }),
            #[cfg(feature = "embeddings")]
            Mode::Semantic => {
                let qv = self.embedder()?.embed_query(query)?;
                let hits = self
                    .vectors
                    .search(&qv, limit)
                    .into_iter()
                    .map(Into::into)
                    .collect();
                Ok(SearchResult {
                    ready: true,
                    mode: mode.label(),
                    hits,
                })
            }
            #[cfg(feature = "embeddings")]
            Mode::Hybrid => {
                // Over-fetch each side so RRF has material to fuse.
                // 2x the user-requested limit, with a floor of 20.
                let buffer = (limit * 2).max(20);
                let bm25_hits: Vec<Hit> = self
                    .bm25
                    .search(query, buffer)?
                    .into_iter()
                    .map(Into::into)
                    .collect();
                let qv = self.embedder()?.embed_query(query)?;
                let sem_hits: Vec<Hit> = self
                    .vectors
                    .search(&qv, buffer)
                    .into_iter()
                    .map(Into::into)
                    .collect();
                let fused = fusion::rrf(&[bm25_hits, sem_hits], limit);
                Ok(SearchResult {
                    ready: true,
                    mode: mode.label(),
                    hits: fused,
                })
            }
            // Without `embeddings`, semantic and hybrid collapse
            // to BM25 with `ready: false` so the UI can show a
            // "search index is text-only on this build" hint.
            #[cfg(not(feature = "embeddings"))]
            Mode::Semantic | Mode::Hybrid => Ok(SearchResult {
                ready: false,
                mode: mode.label(),
                hits: self
                    .bm25
                    .search(query, limit)?
                    .into_iter()
                    .map(Into::into)
                    .collect(),
            }),
        }
    }

    /// Stats for the API status endpoint.
    pub fn stats(&self) -> IndexStats {
        IndexStats {
            ready: true,
            indexed_docs: self.bm25.doc_count(),
            indexed_vectors: self.vectors.chunk_count() as u64,
            model: self.config.lock().unwrap().model.clone(),
        }
    }
}

// Cross-file embedding flush/commit cadence, in chunks (the default/Balanced
// profile). This is NOT the forward-pass size -- the embedder always runs in
// `INFER_BATCH`-sized passes internally, so this value does not change device
// utilization. What it controls is how often the drain loop FLUSHES: each
// flush commits BM25 and writes the accumulated files' vectors, so a smaller
// value makes `indexed_vectors`, the Dashboard node states, and the bm25->hybrid
// search upgrade all advance INCREMENTALLY instead of landing only at the end.
// A flush runs as one blocking forward pass that pins the drain loop (no chip
// advance during it), so smaller = shorter freeze window + more frequent
// progress. Kept well below a typical repo's chunk count (chunks-per-file is
// usually ~10) so a cold build commits in several visible steps rather than one
// multi-minute tail flush; large enough that tantivy segment churn stays modest.
// Working memory is ~3.5 KB/chunk resident. Only used with the `embeddings`
// feature; harmless otherwise.
const EMBED_BATCH_CHUNKS: usize = 128;

/// One worker -> main message. The worker is responsible only for
/// reading the file and parsing it into chunks; the writer side
/// (BM25 add_document, embed batching, vector writes) is the main
/// thread's job. Carrying the rel-path along lets the main thread
/// attribute IO errors back to a specific file without a side
/// channel.
struct WorkerOut {
    rel: String,
    result: std::io::Result<Vec<chunking::Chunk>>,
}

/// How many read+chunk workers `build_all` runs in parallel.
/// Reserves two cores for the rest of the process (the server's
/// tokio runtime, the UI thread, tantivy's internal indexing pool,
/// the OS) so reindex never starves foreground work. The upper
/// cap of 6 keeps the embedding model and tantivy's writer threads
/// from contending past the point where wall-clock improves.
fn balanced_workers() -> usize {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    crate::fd_budget::cap_index_read_workers(cores.saturating_sub(2).clamp(1, 6))
}

/// Search indexer resource profile. The enum is intentionally small:
/// each level maps onto existing budget knobs rather than exposing a
/// bag of private internals.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchAggression {
    /// Minimize foreground impact: one reader/chunker, small queue,
    /// smaller embedding flushes, longer server debounce.
    Conservative,
    /// Historical behavior and default.
    #[default]
    Balanced,
    /// Favor rebuild wall-clock over foreground headroom.
    Aggressive,
}

impl SearchAggression {
    pub fn as_str(self) -> &'static str {
        match self {
            SearchAggression::Conservative => "conservative",
            SearchAggression::Balanced => "balanced",
            SearchAggression::Aggressive => "aggressive",
        }
    }

    pub fn debounce(self) -> std::time::Duration {
        match self {
            SearchAggression::Conservative => std::time::Duration::from_secs(2),
            SearchAggression::Balanced => std::time::Duration::from_secs(1),
            SearchAggression::Aggressive => std::time::Duration::from_millis(250),
        }
    }

    pub fn budget(self) -> SearchBudget {
        let worker_count = match self {
            SearchAggression::Conservative => 1,
            SearchAggression::Balanced => balanced_workers(),
            SearchAggression::Aggressive => {
                let cores = std::thread::available_parallelism()
                    .map(|n| n.get())
                    .unwrap_or(2);
                crate::fd_budget::cap_index_read_workers(cores.saturating_sub(1).clamp(1, 8))
            }
        };
        let queue_multiplier = match self {
            SearchAggression::Conservative => 2,
            SearchAggression::Balanced => 4,
            SearchAggression::Aggressive => 8,
        };
        // Flush/commit cadence in chunks (see EMBED_BATCH_CHUNKS): every
        // profile commits vectors incrementally during a cold build so the
        // progress chip + Dashboard advance instead of freezing on one tail
        // flush. Conservative flushes finest (lowest resident memory / most
        // responsive); Aggressive coarsest (fewer commits, larger work units).
        let embed_batch_chunks = match self {
            SearchAggression::Conservative => 64,
            SearchAggression::Balanced => EMBED_BATCH_CHUNKS,
            SearchAggression::Aggressive => 256,
        };
        SearchBudget {
            worker_count,
            queue_bound: worker_count * queue_multiplier,
            embed_batch_chunks,
        }
    }
}

impl std::str::FromStr for SearchAggression {
    type Err = String;

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s {
            "conservative" => Ok(SearchAggression::Conservative),
            "balanced" => Ok(SearchAggression::Balanced),
            "aggressive" => Ok(SearchAggression::Aggressive),
            other => Err(format!(
                "expected conservative|balanced|aggressive, got `{other}`"
            )),
        }
    }
}

impl std::fmt::Display for SearchAggression {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchBudget {
    pub worker_count: usize,
    pub queue_bound: usize,
    pub embed_batch_chunks: usize,
}

/// Knobs for `Index::build_all`.
#[derive(Debug, Clone, Copy)]
pub struct BuildOptions {
    /// Whether this build embeds. On the reindex path it is driven by the
    /// per-workspace `semantic_enabled` opt-in; a `false` build writes BM25
    /// only. Default: `true` (BM25-only builds set it explicitly, as do tests).
    pub include_vectors: bool,
    /// Search indexer resource budget. Default: balanced.
    pub aggression: SearchAggression,
    /// Bypass the `EMBED_FILE_CAP` cold-build skip. The reindex path sets this
    /// whenever semantic is enabled, so an opted-in workspace embeds its whole
    /// tree instead of falling back to BM25-only above the cap. Default:
    /// `false` (the cap applies).
    pub ignore_embed_cap: bool,
    /// Vector epoch the caller snapshotted BEFORE it read `semantic_enabled`
    /// (`Workspace::reindex_with_aggression`). `build_all` compares against it
    /// so a disable that flipped the flag then bumped the epoch (see
    /// `clear_vectors`) is observed even when this build read a stale `true`.
    /// `None` = snapshot internally at build start (tests / callers with no
    /// concurrent opt-out).
    pub guard_epoch: Option<u64>,
}

impl Default for BuildOptions {
    fn default() -> Self {
        Self {
            include_vectors: true,
            aggression: SearchAggression::Balanced,
            ignore_embed_cap: false,
            guard_epoch: None,
        }
    }
}

#[derive(Debug)]
pub struct BuildSummary {
    pub files: usize,
    pub indexed: usize,
    pub chunks: usize,
    /// Files that skipped the embed phase because a current shard
    /// (matching model + chunk-body hash) was already on disk from a
    /// prior run. Always `0` when `BuildOptions::include_vectors` is
    /// false. The savings are the dominant cost on a partial-rebuild
    /// resume: BM25 is fast (`chunks` worth of inserts plus a single
    /// commit), embedding scales with chunk count and dominates wall
    /// clock on real workspaces.
    pub embeds_reused: usize,
    pub errors: Vec<(String, IndexError)>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexStats {
    pub ready: bool,
    /// Number of BM25-indexed chunks.
    pub indexed_docs: u64,
    /// Number of chunks with embeddings on disk. May lag
    /// indexed_docs briefly during a partial build, or be 0 if no
    /// embedder has run yet for this workspace.
    pub indexed_vectors: u64,
    pub model: String,
}

fn wipe_index_dir(index_dir: &Path) -> Result<(), IndexError> {
    // Model weights live in the per-machine cache (see
    // `embeddings::global_models_dir`), so a per-workspace wipe never
    // touches them. We only nuke the indexable state: `bm25/`,
    // `embeddings/`, and the config (recreated on next open).
    for sub in ["bm25", "embeddings"] {
        let p = index_dir.join(sub);
        if p.exists() {
            std::fs::remove_dir_all(&p)?;
        }
    }
    let cfg = index_dir.join("config.toml");
    if cfg.exists() {
        std::fs::remove_file(&cfg)?;
    }
    Ok(())
}

/// Wipe only the vector store (`embeddings/`), leaving BM25 and the
/// config alone. Used by `Index::open` on a model-id mismatch: the
/// BM25 segments are model-independent and have to survive so the
/// user keeps lexical search while the embeddings rebuild.
fn wipe_vectors_dir(index_dir: &Path) -> Result<(), IndexError> {
    let p = index_dir.join("embeddings");
    // Tolerate an already-absent dir: NotFound is the desired end state, not an
    // error. Dropping the `exists()` precheck also closes the TOCTOU where a
    // concurrent remover (a second disable click, a racing model switch) deletes
    // the dir between the check and the call.
    match std::fs::remove_dir_all(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Walk the workspace and return every indexable file (`FileClass::EditableText`:
/// `.md` + `.txt` today) relative to root, using forward-slash separators
/// on all platforms (matches the API's shape). Honors the caller-supplied
/// `WalkFilter` so blocked dir names (`node_modules`, ...) are never
/// descended.
///
/// Calls `is_indexable_text`, not `is_editable_text`: the wider
/// editor gate (which also covers `.py`, `.json`, Makefile, ...)
/// must not pull arbitrary source/config text into the index.
fn list_indexable(root: &Path, policy: &IndexScopePolicy) -> Result<Vec<String>, IndexError> {
    let mut out: Vec<String> = fs_ops::walk_workspace_scoped(root, policy)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            e.path()
                .strip_prefix(root)
                .ok()
                .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        })
        .filter(|rel| fs_ops::is_indexable_text(rel))
        .collect();
    // Shallow paths first, so root-level and top-level notes become
    // searchable before deep leaf directories (the file browser shows the
    // same spine first, so search fills matching what the user sees). The
    // build's embed-resume keys off (model, body_hash), not file order, so
    // this ordering does not affect reuse. Lexicographic within a depth keeps
    // the result deterministic.
    out.sort_by(|a, b| {
        let depth = |s: &str| s.bytes().filter(|&c| c == b'/').count();
        depth(a).cmp(&depth(b)).then_with(|| a.cmp(b))
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_workspace() -> TempDir {
        TempDir::new().unwrap()
    }

    fn idx_dir(tmp: &TempDir) -> PathBuf {
        tmp.path().join("idx")
    }

    fn no_vectors() -> BuildOptions {
        BuildOptions {
            include_vectors: false,
            ..BuildOptions::default()
        }
    }

    // Direct unit coverage for the fallback
    // discriminator. The workstation has the BGE model cached so
    // the integration / end-to-end tests can never naturally trip
    // the fallback path; these tests synthesise the
    // `ModelNotDownloaded` error directly + assert on the
    // discriminator's branching.
    #[cfg(feature = "embeddings")]
    #[test]
    fn handle_embed_load_error_falls_back_on_model_not_downloaded() {
        let err = IndexError::Embed(EmbedError::ModelNotDownloaded {
            model_id: "BAAI/bge-small-en-v1.5".to_string(),
            expected_dir: PathBuf::from("/nope"),
        });
        assert!(Index::handle_embed_load_error(err).is_ok());
    }

    #[cfg(feature = "embeddings")]
    #[test]
    fn handle_embed_load_error_propagates_other_errors() {
        let err = IndexError::Embed(EmbedError::Candle("synthetic".into()));
        let out = Index::handle_embed_load_error(err);
        assert!(matches!(out, Err(IndexError::Embed(EmbedError::Candle(_)))));
    }

    #[test]
    fn list_indexable_orders_shallow_paths_first() {
        let tmp = make_workspace();
        let root = tmp.path();
        let write = |rel: &str| {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "# x\n").unwrap();
        };
        write("z.md");
        write("a/b/c/leaf.md");
        write("m.md");
        write("a/deep.md");
        let policy = IndexScopePolicy::new(
            root.to_path_buf(),
            WorkspaceGeneration::INITIAL,
            WalkFilter::default(),
        )
        .unwrap();
        let files = list_indexable(root, &policy).unwrap();
        // Depth (count of '/') ascending, lexicographic within a depth: the
        // root notes index before the deep leaf.
        assert_eq!(files, vec!["m.md", "z.md", "a/deep.md", "a/b/c/leaf.md"]);
    }

    #[test]
    fn search_aggression_budget_profiles_are_bounded() {
        let conservative = SearchAggression::Conservative.budget();
        let balanced = SearchAggression::Balanced.budget();
        let aggressive = SearchAggression::Aggressive.budget();

        assert_eq!(conservative.worker_count, 1);
        assert_eq!(conservative.queue_bound, 2);
        assert_eq!(conservative.embed_batch_chunks, 64);
        assert_eq!(balanced.queue_bound, balanced.worker_count * 4);
        assert_eq!(balanced.embed_batch_chunks, EMBED_BATCH_CHUNKS);
        assert!(aggressive.worker_count <= 8);
        assert_eq!(aggressive.queue_bound, aggressive.worker_count * 8);
        assert_eq!(aggressive.embed_batch_chunks, 256);

        // Incremental-commit invariant: the flush cadence must stay small
        // enough that a cold build of a normal repo (chunks-per-file ~10, so a
        // few hundred chunks for a modest tree) commits vectors in SEVERAL
        // flushes, not one multi-minute tail flush that freezes the progress
        // chip + Dashboard. A representative cold build must cross the Balanced
        // threshold many times over. Guards against a regression back to a
        // batch larger than a typical repo's chunk count.
        assert!(
            balanced.embed_batch_chunks <= 128,
            "default flush cadence must keep cold-build vectors committing \
             incrementally; got {}",
            balanced.embed_batch_chunks
        );
        assert!(conservative.embed_batch_chunks <= balanced.embed_batch_chunks);
        assert!(balanced.embed_batch_chunks <= aggressive.embed_batch_chunks);
    }

    #[test]
    fn search_aggression_parse_and_display_are_stable() {
        assert_eq!(
            "conservative".parse::<SearchAggression>().unwrap(),
            SearchAggression::Conservative
        );
        assert_eq!(SearchAggression::Balanced.to_string(), "balanced");
        assert!("turbo".parse::<SearchAggression>().is_err());
    }

    #[test]
    #[ignore = "manual profile for phase task notes; not a CI benchmark"]
    fn search_aggression_fixture_profile() {
        let tmp = make_workspace();
        for i in 0..240 {
            std::fs::write(
                tmp.path().join(format!("note-{i:03}.md")),
                format!("# note {i}\n\nalpha beta gamma delta epsilon\n\n## section\n\nbody {i}\n"),
            )
            .unwrap();
        }

        for aggression in [
            SearchAggression::Conservative,
            SearchAggression::Balanced,
            SearchAggression::Aggressive,
        ] {
            let dir = tmp.path().join(format!("idx-{}", aggression.as_str()));
            let idx = Index::open(tmp.path(), &dir).unwrap();
            let started = std::time::Instant::now();
            let summary = idx
                .build_all(
                    BuildOptions {
                        include_vectors: false,
                        aggression,
                        ..BuildOptions::default()
                    },
                    &crate::progress::NoProgress,
                    None,
                )
                .unwrap();
            let elapsed = started.elapsed();
            let budget = aggression.budget();
            println!(
                "search_aggression={} elapsed_ms={} files={} indexed={} chunks={} workers={} queue={} debounce_ms={}",
                aggression,
                elapsed.as_millis(),
                summary.files,
                summary.indexed,
                summary.chunks,
                budget.worker_count,
                budget.queue_bound,
                aggression.debounce().as_millis(),
            );
            assert!(summary.errors.is_empty());
            assert_eq!(summary.files, 240);
            assert!(elapsed < std::time::Duration::from_secs(30));
        }
    }

    #[test]
    fn build_then_search_end_to_end() {
        let tmp = make_workspace();
        std::fs::write(tmp.path().join("a.md"), "# alpha\nfoo apples\n").unwrap();
        std::fs::write(tmp.path().join("b.md"), "# beta\nbar bananas\n").unwrap();
        let idx = Index::open(tmp.path(), &idx_dir(&tmp)).unwrap();
        let summary = idx
            .build_all(no_vectors(), &crate::progress::NoProgress, None)
            .unwrap();
        assert_eq!(summary.files, 2);
        assert_eq!(summary.indexed, 2);
        assert!(summary.errors.is_empty());
        let r = idx.search("apples", Mode::Bm25, 10).unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].path, "a.md");
    }

    #[test]
    fn parallel_build_indexes_every_file_and_emits_one_progress_per_file() {
        // build_all distributes work across N reader threads, so we
        // need to confirm two invariants the previous serial loop got
        // for free: every file ends up in the index regardless of
        // dispatch order, and the progress callback fires once per
        // file (`seen` is monotonic even when results land out of
        // order). 200 files is enough to make N>1 workers race.
        use std::sync::Mutex;
        let tmp = make_workspace();
        for i in 0..200 {
            let path = tmp.path().join(format!("note-{i:03}.md"));
            std::fs::write(&path, format!("# note {i}\nbody-token-{i:03}\n")).unwrap();
        }
        let idx = Index::open(tmp.path(), &idx_dir(&tmp)).unwrap();
        let labels = Arc::new(Mutex::new(Vec::<String>::new()));
        let cb = {
            let labels = labels.clone();
            crate::progress::progress_fn(move |e| {
                if matches!(e.stage, crate::progress::ProgressStage::IndexFile) {
                    if let Some(l) = e.label {
                        labels.lock().unwrap().push(l);
                    }
                }
            })
        };
        let summary = idx.build_all(no_vectors(), &*cb, None).unwrap();
        assert_eq!(summary.files, 200);
        assert_eq!(summary.indexed, 200);
        assert!(
            summary.errors.is_empty(),
            "got errors: {:?}",
            summary.errors
        );
        // One progress label per file, no dupes, no drops.
        let seen = labels.lock().unwrap().clone();
        let mut uniq = seen.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(
            uniq.len(),
            200,
            "expected 200 distinct labels, got {seen:?}"
        );
        // Every file is independently searchable.
        for i in 0..200 {
            let q = format!("body-token-{i:03}");
            let hits = idx.search(&q, Mode::Bm25, 5).unwrap().hits;
            assert_eq!(hits.len(), 1, "missing hit for {q}");
            assert_eq!(hits[0].path, format!("note-{i:03}.md"));
        }
    }

    #[test]
    fn forget_drops_chunks() {
        let tmp = make_workspace();
        std::fs::write(tmp.path().join("a.md"), "unique-token here\n").unwrap();
        let idx = Index::open(tmp.path(), &idx_dir(&tmp)).unwrap();
        idx.build_all(no_vectors(), &crate::progress::NoProgress, None)
            .unwrap();
        assert!(!idx
            .search("unique-token", Mode::Bm25, 10)
            .unwrap()
            .hits
            .is_empty());
        idx.forget("a.md").unwrap();
        assert!(idx
            .search("unique-token", Mode::Bm25, 10)
            .unwrap()
            .hits
            .is_empty());
    }

    #[test]
    fn rebuild_clears_old_data() {
        let tmp = make_workspace();
        std::fs::write(tmp.path().join("a.md"), "first content\n").unwrap();
        let dir = idx_dir(&tmp);
        let idx = Index::open(tmp.path(), &dir).unwrap();
        idx.build_all(no_vectors(), &crate::progress::NoProgress, None)
            .unwrap();
        assert!(!idx.search("first", Mode::Bm25, 10).unwrap().hits.is_empty());
        drop(idx);
        let idx = Index::rebuild(tmp.path(), &dir).unwrap();
        assert!(idx.search("first", Mode::Bm25, 10).unwrap().hits.is_empty());
    }

    #[test]
    fn open_wipes_embeddings_when_configured_model_diverges_from_disk_stamp() {
        // Simulate the upgrade-path: a previous build stamped a
        // different model into the config. On open, the divergence
        // must trigger an embeddings-only wipe; BM25 must survive.
        let tmp = make_workspace();
        std::fs::write(tmp.path().join("a.md"), "alpha unique-token\n").unwrap();
        let dir = idx_dir(&tmp);
        let idx = Index::open(tmp.path(), &dir).unwrap();
        idx.build_all(no_vectors(), &crate::progress::NoProgress, None)
            .unwrap();
        let bm25_before = idx.search("unique-token", Mode::Bm25, 10).unwrap();
        assert_eq!(bm25_before.hits.len(), 1);

        // Plant a fake vectors/ subdir to confirm the wipe targets it.
        let vec_dir = dir.join("embeddings");
        std::fs::create_dir_all(&vec_dir).unwrap();
        std::fs::write(vec_dir.join("planted"), b"junk").unwrap();

        // Stamp config as if a previous embed pass had used a
        // different model. Then close + re-open so the open-time
        // check fires.
        let cfg_on_disk = config::IndexConfig {
            schema_version: config::SCHEMA_VERSION,
            model: "BAAI/bge-small-en-v1.5".to_owned(),
            chunking: config::Chunking::default(),
            vectors_model: Some("BAAI/bge-large-en-v1.5".to_owned()),
            vectors_dim: Some(1024),
            excluded_dirs: Vec::new(),
        };
        config::save(&dir, &cfg_on_disk).unwrap();
        drop(idx);

        let idx = Index::open(tmp.path(), &dir).unwrap();
        // BM25 search still works (segments untouched).
        let bm25_after = idx.search("unique-token", Mode::Bm25, 10).unwrap();
        assert_eq!(bm25_after.hits.len(), 1);
        // The planted embeddings dir was reclaimed.
        assert!(
            !vec_dir.join("planted").exists(),
            "embeddings dir must be wiped on model-id mismatch"
        );
        // Config tracking fields cleared and persisted.
        let cfg_after = config::load(&dir).unwrap();
        assert_eq!(cfg_after.vectors_model, None);
        assert_eq!(cfg_after.vectors_dim, None);
        assert_eq!(cfg_after.model, "BAAI/bge-small-en-v1.5");
    }

    #[test]
    fn open_leaves_everything_alone_when_disk_stamp_matches() {
        // Symmetric case: the stamp matches the configured model.
        // No wipe, no churn, no spurious config save.
        let tmp = make_workspace();
        std::fs::write(tmp.path().join("a.md"), "alpha\n").unwrap();
        let dir = idx_dir(&tmp);
        let model = "BAAI/bge-small-en-v1.5".to_owned();
        let cfg_on_disk = config::IndexConfig {
            schema_version: config::SCHEMA_VERSION,
            model: model.clone(),
            chunking: config::Chunking::default(),
            vectors_model: Some(model.clone()),
            vectors_dim: Some(384),
            excluded_dirs: Vec::new(),
        };
        std::fs::create_dir_all(&dir).unwrap();
        config::save(&dir, &cfg_on_disk).unwrap();
        // Plant a sentinel in embeddings/ that must survive the open.
        let vec_dir = dir.join("embeddings");
        std::fs::create_dir_all(&vec_dir).unwrap();
        std::fs::write(vec_dir.join("sentinel"), b"keep").unwrap();

        let _idx = Index::open(tmp.path(), &dir).unwrap();
        assert!(
            vec_dir.join("sentinel").exists(),
            "matching stamp must not trigger a wipe",
        );
        let cfg_after = config::load(&dir).unwrap();
        assert_eq!(cfg_after.vectors_model.as_deref(), Some(model.as_str()));
        assert_eq!(cfg_after.vectors_dim, Some(384));
    }

    #[test]
    fn schema_version_bump_clears_tracking_fields() {
        // A schema bump wipes everything, including the tracking
        // fields. Otherwise the post-wipe open would think the
        // vectors are still valid for the old model.
        let tmp = make_workspace();
        let dir = idx_dir(&tmp);
        std::fs::create_dir_all(&dir).unwrap();
        let cfg_on_disk = config::IndexConfig {
            schema_version: config::SCHEMA_VERSION.saturating_sub(1),
            model: "BAAI/bge-small-en-v1.5".to_owned(),
            chunking: config::Chunking::default(),
            vectors_model: Some("BAAI/bge-small-en-v1.5".to_owned()),
            vectors_dim: Some(384),
            excluded_dirs: Vec::new(),
        };
        config::save(&dir, &cfg_on_disk).unwrap();
        let _idx = Index::open(tmp.path(), &dir).unwrap();
        let cfg_after = config::load(&dir).unwrap();
        assert_eq!(cfg_after.schema_version, config::SCHEMA_VERSION);
        assert_eq!(cfg_after.vectors_model, None);
        assert_eq!(cfg_after.vectors_dim, None);
    }

    #[cfg(feature = "embeddings")]
    #[test]
    fn embeddings_capped_for_respects_file_cap() {
        // At or under the cap, embeddings run; strictly above, they skip.
        assert!(!Index::embeddings_capped_for(true, Index::EMBED_FILE_CAP));
        assert!(!Index::embeddings_capped_for(
            true,
            Index::EMBED_FILE_CAP - 1
        ));
        assert!(Index::embeddings_capped_for(
            true,
            Index::EMBED_FILE_CAP + 1
        ));
        // A BM25-only build (include_vectors == false) is never "capped":
        // it was not embedding to begin with.
        assert!(!Index::embeddings_capped_for(
            false,
            Index::EMBED_FILE_CAP + 1
        ));
    }

    #[test]
    fn clear_vectors_is_idempotent_and_tolerates_missing_dir() {
        // The semantic-disable path calls clear_vectors; it must be safe to run
        // on an empty store and to survive the embeddings dir being removed out
        // from under it (H3: wipe tolerates NotFound). Each call leaves the dir
        // present and the config stamp cleared.
        let tmp = make_workspace();
        std::fs::write(tmp.path().join("a.md"), "alpha\n").unwrap();
        let dir = idx_dir(&tmp);
        let idx = Index::open(tmp.path(), &dir).unwrap();

        idx.clear_vectors().unwrap();
        assert!(dir.join("embeddings").exists());

        // Remove the dir mid-life, then clear again: no error, dir recreated.
        std::fs::remove_dir_all(dir.join("embeddings")).unwrap();
        idx.clear_vectors().unwrap();
        assert!(dir.join("embeddings").exists());

        let cfg = config::load(&dir).unwrap();
        assert!(
            cfg.vectors_model.is_none() && cfg.vectors_dim.is_none(),
            "clear_vectors must leave the vectors_* stamp cleared",
        );
    }

    #[test]
    fn build_all_honors_cancel_and_skips_commit() {
        // Pre-flagged cancel should bail before any file is written
        // and before commit. The on-disk index must still be empty.
        let tmp = make_workspace();
        std::fs::write(tmp.path().join("a.md"), "alpha unique-token\n").unwrap();
        std::fs::write(tmp.path().join("b.md"), "beta\n").unwrap();
        let idx = Index::open(tmp.path(), &idx_dir(&tmp)).unwrap();
        let cancel = AtomicBool::new(true);
        let err = idx
            .build_all(no_vectors(), &crate::progress::NoProgress, Some(&cancel))
            .unwrap_err();
        assert!(matches!(err, IndexError::Cancelled));
        // No commit happened; the index stays empty so an auto-rebuild
        // trigger (`indexed_docs == 0`) would re-fire on next boot.
        assert_eq!(idx.stats().indexed_docs, 0);
    }

    /// Pre-write a v2 vector shard whose `(model, body_hash)`
    /// matches what a fresh re-chunk of `source` would produce, then
    /// call `Index::build_all` with vectors enabled. The build's
    /// checkpoint should skip the embed phase (no model is loaded in
    /// tests; an attempted embed would fail outright) and report the
    /// reuse in the summary.
    ///
    /// This is the partial-rebuild resume case in miniature: a prior
    /// run crashed after writing the shard for `a.md`; on restart,
    /// `build_all` walks the workspace, finds the shard still current,
    /// and avoids paying the embed cost a second time.
    #[cfg(feature = "embeddings")]
    #[test]
    fn build_all_skips_embed_when_shard_signature_matches() {
        use super::super::vectors::{self, EmbeddedChunk, VectorStore};
        let tmp = make_workspace();
        let source = "# alpha\nbody-token-skipme line\n";
        std::fs::write(tmp.path().join("a.md"), source).unwrap();
        let dir = idx_dir(&tmp);
        std::fs::create_dir_all(&dir).unwrap();
        // Stamp config so `Index::open` doesn't trip the model-mismatch
        // wipe path. The default model id is what `build_all` will
        // compare shards against.
        let cfg = config::IndexConfig::default();
        config::save(&dir, &cfg).unwrap();
        let chunks = chunking::chunk(source, &cfg.chunking);
        assert!(
            !chunks.is_empty(),
            "test setup: source must produce at least one chunk",
        );
        let dim = 4usize;
        // Synthetic unit vectors of the chosen dim. The actual values
        // don't matter for the skip check; only `(model, body_hash)`
        // is consulted.
        let embedded: Vec<EmbeddedChunk> = chunks
            .iter()
            .map(|c| EmbeddedChunk {
                chunk_id: c.id.clone(),
                heading: c.heading.clone(),
                body: c.body.clone(),
                start_line: c.start_line as u64,
                end_line: c.end_line as u64,
                depth: c.depth,
                vector: (0..dim).map(|i| if i == 0 { 1.0 } else { 0.0 }).collect(),
            })
            .collect();
        // Write the shard via a standalone VectorStore handle.
        // `Index::open` below will load it through its own handle.
        {
            let store = VectorStore::open(&dir).unwrap();
            store
                .replace_file("a.md", &cfg.model, dim, embedded)
                .unwrap();
        }
        // Sanity: signature is reachable through a fresh load.
        let probe = VectorStore::open(&dir).unwrap();
        let (sig_model, sig_hash) = probe.shard_signature("a.md").unwrap();
        assert_eq!(sig_model, cfg.model);
        assert_eq!(sig_hash, vectors::body_hash_of_chunks(&chunks));
        drop(probe);

        let idx = Index::open(tmp.path(), &dir).unwrap();
        let summary = idx
            .build_all(
                BuildOptions {
                    include_vectors: true,
                    ..BuildOptions::default()
                },
                &crate::progress::NoProgress,
                None,
            )
            .unwrap();
        assert_eq!(
            summary.embeds_reused, 1,
            "skip check must fire when (model, body_hash) match; got {:?}",
            summary,
        );
        assert_eq!(summary.indexed, 1);
        assert!(
            summary.errors.is_empty(),
            "got errors: {:?}",
            summary.errors
        );
    }

    /// Content drift case: shard exists but its `body_hash` no
    /// longer matches a fresh re-chunk (someone edited the file
    /// between runs). The skip MUST NOT fire; the file is treated
    /// as needing a fresh embed.
    ///
    /// The test arranges the file in a state where build_all would
    /// have to embed, but the embedder is not loaded in tests, so
    /// we observe the no-skip path via `embeds_reused == 0` and
    /// expect the embed attempt to surface as an error (model
    /// download / candle init fails fast in a unit-test sandbox).
    /// The contract: a stale shard does not falsely reuse.
    #[cfg(feature = "embeddings")]
    #[test]
    fn build_all_does_not_skip_when_shard_body_hash_is_stale() {
        use super::super::vectors::{EmbeddedChunk, VectorStore};
        let tmp = make_workspace();
        let original = "# alpha\nold body line\n";
        std::fs::write(tmp.path().join("a.md"), original).unwrap();
        let dir = idx_dir(&tmp);
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = config::IndexConfig::default();
        config::save(&dir, &cfg).unwrap();
        // Shard from the original body.
        let chunks_orig = chunking::chunk(original, &cfg.chunking);
        let embedded: Vec<EmbeddedChunk> = chunks_orig
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
        {
            let store = VectorStore::open(&dir).unwrap();
            store.replace_file("a.md", &cfg.model, 4, embedded).unwrap();
        }
        // Drift: rewrite the file so a fresh re-chunk's body_hash
        // diverges from the shard's stamped hash.
        std::fs::write(
            tmp.path().join("a.md"),
            "# alpha\ncompletely different body line that hashes elsewhere\n",
        )
        .unwrap();

        let idx = Index::open(tmp.path(), &dir).unwrap();
        // We don't strictly assert on the embedder behavior here;
        // the load-bearing fact is that the skip did NOT fire.
        // Whether the embed attempt then succeeds or errors depends
        // on whether a model is available, which is irrelevant to
        // the contract under test.
        let summary = idx.build_all(
            BuildOptions {
                include_vectors: true,
                ..BuildOptions::default()
            },
            &crate::progress::NoProgress,
            None,
        );
        // If a model was reachable, the build succeeded with
        // embeds_reused = 0. If not (typical CI sandbox), the embed
        // surfaced as a per-file error in the summary or as a
        // top-level error. Either way, no reuse was recorded.
        match summary {
            Ok(s) => {
                assert_eq!(
                    s.embeds_reused, 0,
                    "stale shard must not be reused; got {s:?}",
                );
            }
            Err(_) => {
                // Top-level embed errors propagate from
                // flush_embed_batch; the skip path would have
                // returned Ok with embeds_reused == 1.
            }
        }
    }
}
